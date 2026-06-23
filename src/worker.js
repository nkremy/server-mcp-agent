// ─────────────────────────────────────────────────────────────
// src/worker.js
// Responsabilité : dépiler les jobs BullMQ, télécharger les
//                 médias Meta, appeler l'agent, envoyer la
//                 réponse WhatsApp
//
// File BullMQ : une file unique 'messages-whatsapp'
// Worker      : traitement séquentiel — un job à la fois
// ─────────────────────────────────────────────────────────────
import { Worker } from 'bullmq'
import axios from 'axios'
import { traiterMessage } from './agent.js'
import 'dotenv/config'
import { markRead } from './utils/utils.js'

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
// Configuration Redis pour BullMQ
// ─────────────────────────────────────────────────────────────
const connexionRedis = {
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379')
  }
}

// ─────────────────────────────────────────────────────────────
// telechargerMedia — télécharge un média depuis Meta API
//
// Paramètres :
//   mediaId (string) — identifiant du média WhatsApp
// Retourne :
//   { base64: string, mimeType: string }
// ─────────────────────────────────────────────────────────────
async function telechargerMedia(mediaId) {
  log('INFO', 'MEDIA', `Téléchargement média ${mediaId}`)

  try {
    // Étape 1 : récupérer l'URL du média
    const metaReponse = await axios.get(
      `https://graph.facebook.com/v19.0/${mediaId}`,
      {
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
      }
    )
    const mediaUrl = metaReponse.data.url
    const mimeType = metaReponse.data.mime_type
    log('INFO', 'MEDIA', `URL média obtenue — mimeType: ${mimeType}`)

    // Étape 2 : télécharger le contenu en binaire
    const contenuReponse = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
    })

    // Étape 3 : convertir en base64
    const base64 = Buffer.from(contenuReponse.data).toString('base64')
    log('INFO', 'MEDIA', `Média téléchargé — taille: ${contenuReponse.data.byteLength} octets`)

    return { base64, mimeType }
  } catch (err) {
    log('ERROR', 'MEDIA', `Échec téléchargement média ${mediaId}`, err.message)
    throw err
  }
}

// ─────────────────────────────────────────────────────────────
// envoyerReponse — envoie un message texte via Meta Cloud API
//
// Paramètres :
//   phone  (string) — numéro destinataire ex: +243812345678
//   texte  (string) — réponse à envoyer
// ─────────────────────────────────────────────────────────────
async function envoyerReponse(phone, texte) {
  log('INFO', 'WHATSAPP', `Envoi réponse à ${phone} — ${texte.length} caractères`)

  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: texte }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    )
    log('INFO', 'WHATSAPP', `Réponse envoyée à ${phone}`)
  } catch (err) {
    log('ERROR', 'WHATSAPP', `Échec envoi réponse à ${phone}`, err.message)
    if (err.response?.data) {
      log('ERROR', 'WHATSAPP', `Détail erreur Meta`, err.response.data)
    }
    throw err
  }
}

// ─────────────────────────────────────────────────────────────
// traiterJob — traite un job BullMQ
//
// Structure d'un job :
//   { phone, type, content?, mediaId?, mimeType?, texte? }
//
//   type='text'  → content = texte du client
//   type='image' → mediaId = id Meta, mimeType, texte? = légende
//   type='audio' → mediaId = id Meta, mimeType
// ─────────────────────────────────────────────────────────────
async function traiterJob(job) {
    const { phone, type, content, mediaId, mimeType, texte,defaultName,message_id } = job.data
    log('INFO', 'WORKER', `=== Job reçu [${job.id}] — phone: ${phone} type: ${type} ===`)
    
    await markRead({message_id});
  let message

  try {
    if (type === 'text') {
      // Message texte simple
      log('INFO', 'WORKER', `Message texte : ${content?.substring(0, 80)}`)
      message = content

    } else if (type === 'image') {
      // Image — téléchargement requis
      log('INFO', 'WORKER', `Message image — téléchargement depuis Meta`)
      const media = await telechargerMedia(mediaId)
      message = {
        type: 'image',
        base64: media.base64,
        mimeType: media.mimeType,
        texte: texte || ''
      }
      log('INFO', 'WORKER', `Image prête — mimeType: ${media.mimeType}`)

    } else if (type === 'audio') {
      // Audio — téléchargement requis
      log('INFO', 'WORKER', `Message audio — téléchargement depuis Meta`)
      const media = await telechargerMedia(mediaId)
      message = {
        type: 'audio',
        base64: media.base64,
        mimeType: media.mimeType
      }
      log('INFO', 'WORKER', `Audio prêt — mimeType: ${media.mimeType}`)

    } else {
      log('WARN', 'WORKER', `Type de message inconnu : ${type} — traité comme texte`)
      message = content || ''
    }

    // ── Appel agent ───────────────────────────────────────────
    log('INFO', 'WORKER', `Appel agent pour ${phone}`)
    const { texte: reponse } = await traiterMessage({ phone, message , defaultName })
    log('INFO', 'WORKER', `Réponse agent obtenue — ${reponse?.length} caractères`)

    // ── Envoi WhatsApp ────────────────────────────────────────
    await envoyerReponse(phone, reponse)

    log('INFO', 'WORKER', `=== Job [${job.id}] terminé avec succès ===`)

  } catch (err) {
    log('ERROR', 'WORKER', `=== Job [${job.id}] échoué pour ${phone} ===`, err.message)
    log('ERROR', 'WORKER', `Stack trace`, err.stack)

    // Tentative d'envoi d'un message d'erreur au client
    try {
      await envoyerReponse(
        phone,
        'Désolé, une erreur est survenue. Veuillez réessayer dans quelques instants.'
      )
    } catch (errEnvoi) {
      log('ERROR', 'WORKER', `Impossible d'envoyer message d'erreur`, errEnvoi.message)
    }

    // Relancer l'erreur pour que BullMQ marque le job comme échoué
    throw err
  }
}

// ─────────────────────────────────────────────────────────────
// Démarrage du worker
// concurrency: 1 → un seul job traité à la fois globalement
// Chaque phone a sa propre file → pas de blocage entre clients
// ─────────────────────────────────────────────────────────────
log('INFO', 'WORKER', '=== Démarrage du worker WhatsApp ===')
log('INFO', 'WORKER', `Redis: ${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`)

const worker = new Worker(
  'messages-whatsapp',
  traiterJob,
  {
    ...connexionRedis,
    concurrency: 5  // 5 clients traités en parallèle maximum
  }
)

worker.on('completed', (job) => {
  log('INFO', 'WORKER', `Job [${job.id}] complété`)
})

worker.on('failed', (job, err) => {
  log('ERROR', 'WORKER', `Job [${job.id}] échoué définitivement`, err.message)
})

worker.on('error', (err) => {
  log('ERROR', 'WORKER', `Erreur worker globale`, err.message)
})

log('INFO', 'WORKER', `Worker en écoute sur la file 'messages-whatsapp'`)