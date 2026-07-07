// ─────────────────────────────────────────────────────────────
// src/webhook.js
// Responsabilité : recevoir les messages WhatsApp depuis Meta
//                 Cloud API et les pousser dans BullMQ
//
// Deux routes :
//   GET  /webhook → vérification Meta (handshake initial)
//   POST /webhook → réception des messages entrants
//
// Sécurité :
//   - Vérification signature X-Hub-Signature-256 sur chaque POST
//   - Réponse 200 immédiate à Meta avant tout traitement
//   - Traitement asynchrone via BullMQ
//
// Types de messages gérés :
//   text  → content = texte
//   image → mediaId + mimeType + texte (légende optionnelle)
//   audio → mediaId + mimeType
// ─────────────────────────────────────────────────────────────
import express from 'express'
import crypto from 'crypto'
import { Queue } from 'bullmq'

import 'dotenv/config'

const app  = express()

// ─────────────────────────────────────────────────────────────
// IMPORTANT : express.raw() AVANT express.json()
// La vérification de signature Meta nécessite le body brut
// On le parse manuellement ensuite
// ─────────────────────────────────────────────────────────────
app.use(express.raw({ type: 'application/json' }))

// ─────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────
function log(niveau, contexte, message, data = null) {
  const ts = new Date().toISOString()
  const ligne = `[${ts}] [${niveau}] [${contexte}] ${message}`
  if (data !== null) {
    console.error(ligne, typeof data === 'object' ? JSON.stringify(data) : data)
  } else {
    console.error(ligne)
  }
}

// ─────────────────────────────────────────────────────────────
// File BullMQ
// ─────────────────────────────────────────────────────────────
const connexionRedis = process.env.REDIS_URL
  ? { connection: { url: process.env.REDIS_URL } }
  : {
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379')
      }
    }

const fileMessages = new Queue('messages-whatsapp', connexionRedis)
log('INFO', 'WEBHOOK', 'File BullMQ connectée')

// ─────────────────────────────────────────────────────────────
// verifierSignature — vérifie que le POST vient bien de Meta
// Meta signe chaque requête avec le secret de l'app
// Header : X-Hub-Signature-256: sha256=HASH
// ─────────────────────────────────────────────────────────────
function verifierSignature(rawBody, signature) {
  if (!signature) {
    log('WARN', 'SECURITE', 'Signature absente dans les headers')
    return false
  }

  const hash = 'sha256=' + crypto
    .createHmac('sha256', process.env.WHATSAPP_APP_SECRET)
    .update(rawBody)
    .digest('hex')

  const valide = crypto.timingSafeEqual(
    Buffer.from(hash),
    Buffer.from(signature)
  )

  if (!valide) {
    log('WARN', 'SECURITE', 'Signature invalide', { reçue: signature, attendue: hash })
  }

  return valide
}

// ─────────────────────────────────────────────────────────────
// extraireMessage — extrait les infos utiles du payload Meta
//
// Retourne null si ce n'est pas un message à traiter
// (statuts de livraison, notifications système, etc.)
// ─────────────────────────────────────────────────────────────
function extraireMessage(body) {
  const entry   = body?.entry?.[0]
  const changes = entry?.changes?.[0]
  const value   = changes?.value
//   const defaultName = value.contacts[0]?.profile?.name || "client_"+phone; 

  // On ne traite que les vrais messages entrants
  if (!value?.messages?.[0]) {
    log('INFO', 'WEBHOOK', 'Payload ignoré — pas un message entrant')
    return null
  }

  const message  = value.messages[0]
  const phone    = message.from   // numéro WhatsApp du client
  const type     = message.type   // 'text', 'image', 'audio', etc.

  log('INFO', 'WEBHOOK', `Message entrant — phone: ${phone} type: ${type}`)

  if (type === 'text') {
    const content = message.text?.body
    if (!content) {
      log('WARN', 'WEBHOOK', `Message texte vide pour ${phone}`)
      return null
    }
    log('INFO', 'WEBHOOK', `Texte reçu de ${phone} : ${content.substring(0, 80)}`)
    return { phone, type: 'text', content }
  }

  if (type === 'image') {
    const mediaId  = message.image?.id
    const mimeType = message.image?.mime_type
    const texte    = message.image?.caption || ''
    if (!mediaId) {
      log('WARN', 'WEBHOOK', `Image sans mediaId pour ${phone}`)
      return null
    }
    log('INFO', 'WEBHOOK', `Image reçue de ${phone} — mediaId: ${mediaId} caption: ${texte.substring(0, 40)}`)
    return { phone, type: 'image', mediaId, mimeType, texte }
  }

  if (type === 'audio') {
    const mediaId  = message.audio?.id
    const mimeType = message.audio?.mime_type
    if (!mediaId) {
      log('WARN', 'WEBHOOK', `Audio sans mediaId pour ${phone}`)
      return null
    }
    log('INFO', 'WEBHOOK', `Audio reçu de ${phone} — mediaId: ${mediaId}`)
    return { phone, type: 'audio', mediaId, mimeType }
  }

  // Type non géré (document, sticker, location, etc.)
  log('INFO', 'WEBHOOK', `Type non géré : ${type} pour ${phone}`)
  return null
}

// ─────────────────────────────────────────────────────────────
// GET /webhook — vérification Meta (handshake initial)
//
// Meta envoie ce GET quand on configure le webhook dans le
// portail développeur. On doit répondre avec hub.challenge
// ─────────────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode']
  const token     = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  log('INFO', 'WEBHOOK', `Vérification Meta reçue — mode: ${mode}`)

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    log('INFO', 'WEBHOOK', 'Vérification Meta réussie — webhook validé')
    return res.status(200).send(challenge)
  }

  log('WARN', 'WEBHOOK', `Vérification échouée — token: ${token}`)
  return res.sendStatus(403)
})

// ─────────────────────────────────────────────────────────────
// POST /webhook — réception des messages entrants
//
// RÈGLE CRITIQUE Meta : répondre 200 en moins de 5 secondes
// Sinon Meta considère le webhook comme défaillant et retente
// → On répond 200 IMMÉDIATEMENT puis on traite en asynchrone
// ─────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {

  
  const rawBody  = req.body
  const signature = req.headers['x-hub-signature-256']

  log('INFO', 'WEBHOOK', 'POST reçu de Meta')

  // ── Réponse immédiate à Meta ──────────────────────────────
  // DOIT être fait avant tout traitement lourd
  res.sendStatus(200)
  log('INFO', 'WEBHOOK', '200 envoyé à Meta')

  try {
    // ── Vérification signature ────────────────────────────────
    // if (!verifierSignature(rawBody, signature)) {
    //   log('WARN', 'SECURITE', 'Requête rejetée — signature invalide')
    //   return
    // }

    // ── Parse du body ─────────────────────────────────────────
    let body
    try {
      body = JSON.parse(rawBody.toString())
    } catch (err) {
      log('ERROR', 'WEBHOOK', 'Impossible de parser le body JSON', err.message)
      return
    }

   
    
    // ── Vérification objet WhatsApp ───────────────────────────
    if (body.object !== 'whatsapp_business_account') {
      log('INFO', 'WEBHOOK', `Objet ignoré : ${body.object}`)
      return
    }

    // ── Extraction du message ─────────────────────────────────
    const jobData = extraireMessage(body)
    if (!jobData) return
    //--- ajouter du nom fourni pas whatsapp et du messageid dans le payload du job
    jobData.id_message = body.entry[0].changes[0].value.messages[0].id;
    jobData.defaultName = body.entry[0].changes[0].value.contacts[0].profile.name || `client_${jobData.phone}`;
    //--- ajouter l'id du message auquel le client répond, si présent (sinon null)
    jobData.repond_a_id_whatsapp = body.entry[0].changes[0].value.messages[0].context?.id || null;
    if (jobData.repond_a_id_whatsapp) {
      log('INFO', 'WEBHOOK', `Message en réponse à ${jobData.repond_a_id_whatsapp}`)
    }
    // ── Ajout dans BullMQ ─────────────────────────────────────
    const job = await fileMessages.add(
      `msg-${jobData.phone}-${Date.now()}`,
      jobData,
      {
        attempts: 3,          // 3 tentatives en cas d'échec
        backoff: {
          type: 'exponential',
          delay: 2000         // 2s, 4s, 8s
        },
        removeOnComplete: 100, // garder les 100 derniers jobs réussis
        removeOnFail: 50       // garder les 50 derniers jobs échoués
      }
    )

    log('INFO', 'WEBHOOK', `Job créé [${job.id}] pour ${jobData.phone} type: ${jobData.type}`)

  } catch (err) {
    log('ERROR', 'WEBHOOK', 'Erreur traitement webhook', err.message)
    log('ERROR', 'WEBHOOK', 'Stack trace', err.stack)
  }
})

// ─────────────────────────────────────────────────────────────
// Route de santé — pour Railway et les health checks
// ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  log('INFO', 'WEBHOOK', 'Health check OK')
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'agent-whatsapp-dolibarr'
  })
})

// ─────────────────────────────────────────────────────────────
// Démarrage du serveur
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  log('INFO', 'WEBHOOK', `=== Serveur webhook démarré sur le port ${PORT} ===`)
  log('INFO', 'WEBHOOK', `GET  /webhook → vérification Meta`)
  log('INFO', 'WEBHOOK', `POST /webhook → réception messages`)
  log('INFO', 'WEBHOOK', `GET  /health  → santé du serveur`)
})
