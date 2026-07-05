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
import {mettreAJourIdWhatsapp} from "./outils-supabase.js"
// import { mettreAJourIdWhatsapp } from './outils-supabase.js'
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
// Priorité : REDIS_URL (Railway) → REDIS_HOST/PORT (local)
// ─────────────────────────────────────────────────────────────
const connexionRedis = process.env.REDIS_URL
  ? { connection: { url: process.env.REDIS_URL } }
  : {
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
// rangerFichierClient — appelle le service gestionnaire-fichier
// pour ranger SYSTÉMATIQUEMENT tout média entrant (image ou audio).
// Jamais conditionnel — un échec ici ne bloque JAMAIS le traitement
// du message (le client aura quand même sa réponse), juste loggé.
//
// Retourne : reference (string) ou null si l'appel a échoué
// ─────────────────────────────────────────────────────────────
async function rangerFichierClient({ phone, base64, mimeType }) {
  try {
    const reponse = await axios.post(
      `${process.env.GESTIONNAIRE_FICHIER_URL}/ranger-fichier`,
      { phone, base64, mimeType }
    )
    if (reponse.data.success) {
      log('INFO', 'STOCKAGE', `Média rangé — reference: ${reponse.data.reference}`)
      return reponse.data.reference
    }
    log('WARN', 'STOCKAGE', `Rangement échoué côté service`, reponse.data.erreur)
    return null
  } catch (err) {
    log('ERROR', 'STOCKAGE', `Échec appel gestionnaire-fichier — non bloquant`, err.message)
    return null
  }
}

async function envoyerTexte(phone, texte) {
  if (!texte || !texte.trim()) return null
  log('INFO', 'WHATSAPP', `Envoi texte à ${phone} — ${texte.length} caractères`)
  try {
    const reponseMeta = await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: texte.trim() }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    )
    const idWhatsapp = reponseMeta.data?.messages?.[0]?.id || null
    log('INFO', 'WHATSAPP', `Texte envoyé à ${phone} — id: ${idWhatsapp}`)
    return idWhatsapp
  } catch (err) {
    log('ERROR', 'WHATSAPP', `Échec envoi texte`, err.message)
    if (err.response?.data) log('ERROR', 'WHATSAPP', `Détail Meta`, err.response.data)
    throw err
  }
}

// ─────────────────────────────────────────────────────────────
// uploaderImageMeta — upload base64 vers Meta Media API
// Retourne : media_id (string)
// ─────────────────────────────────────────────────────────────
async function uploaderImageMeta(base64, mimeType) {
  log('INFO', 'MEDIA', `Upload image vers Meta — mimeType: ${mimeType}`)
  const buffer = Buffer.from(base64, 'base64')
  const { default: FormData } = await import('form-data')
  const form = new FormData()
  form.append('file', buffer, { filename: 'image.jpg', contentType: mimeType })
  form.append('type', mimeType)
  form.append('messaging_product', 'whatsapp')

  try {
    const reponse = await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/media`,
      form,
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          ...form.getHeaders()
        }
      }
    )
    const mediaId = reponse.data.id
    log('INFO', 'MEDIA', `Image uploadée — media_id: ${mediaId}`)
    return mediaId
  } catch (err) {
    log('ERROR', 'MEDIA', `Échec upload image Meta`, err.message)
    if (err.response?.data) log('ERROR', 'MEDIA', `Détail Meta`, err.response.data)
    throw err
  }
}

// ─────────────────────────────────────────────────────────────
// envoyerImage — télécharge depuis Dolibarr, upload Meta,
//               envoie à WhatsApp
// ─────────────────────────────────────────────────────────────
async function envoyerImage(phone, imageInfo) {
  log('INFO', 'WHATSAPP', `Traitement image : ${imageInfo.original_file}`)
  try {
    // Télécharger depuis Dolibarr
    const dolibarrReponse = await axios.get(
      `${process.env.DOLIBARR_URL}/api/index.php/documents/download`,
      {
        params: {
          modulepart: 'product',
          original_file: imageInfo.original_file
        },
        headers: { DOLAPIKEY: process.env.DOLIBARR_API_KEY }
      }
    )

    const base64  = dolibarrReponse.data.content
    const mimeType = dolibarrReponse.data['content-type'] || 'image/jpeg'
    log('INFO', 'MEDIA', `Image Dolibarr OK — ${dolibarrReponse.data.filesize} octets`)

    // Upload vers Meta
    const mediaId = await uploaderImageMeta(base64, mimeType)

    // Construire le payload image
    const imagePayload = { id: mediaId }
    if (imageInfo.legende && imageInfo.legende.trim()) {
      imagePayload.caption = imageInfo.legende.trim()
    }

    // Envoyer via WhatsApp
    const reponseMeta = await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'image',
        image: imagePayload
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    )
    const idWhatsapp = reponseMeta.data?.messages?.[0]?.id || null
    log('INFO', 'WHATSAPP', `Image envoyée — ${imageInfo.original_file} — id: ${idWhatsapp}`)
    return idWhatsapp

  } catch (err) {
    log('ERROR', 'WHATSAPP', `Échec image ${imageInfo.original_file}`, err.message)
    // Non bloquant — on continue avec l'image suivante
    return null
  }
}

async function traiterJob(job) {
  const { phone, type, content, mediaId, mimeType, texte,defaultName,id_message  } = job.data
  
  // ───────────── AJOUT (étape 2 du plan) ─────────────
  // Transport du reply capturé au webhook (étape 1). Pas encore utilisé
  // ici, juste transmis plus loin jusqu'à l'agent.
  const { repond_a_id_whatsapp } = job.data
  // ───────────── FIN AJOUT ─────────────
  
  log('INFO', 'WORKER', `=== Job reçu [${job.id}] — phone: ${phone} type: ${type} ===`)

  await markRead({id_message});

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

      // ───────────── AJOUT (Flux A) ─────────────
      // Rangement SYSTÉMATIQUE, avant tout appel à l'agent
      const reference = await rangerFichierClient({ phone, base64: media.base64, mimeType: media.mimeType })
      // ───────────── FIN AJOUT ─────────────

      message = {
        type: 'image',
        base64: media.base64,
        mimeType: media.mimeType,
        texte: texte || '',
        reference
      }
      log('INFO', 'WORKER', `Image prête — mimeType: ${media.mimeType}`)

    } else if (type === 'audio') {
      // Audio — téléchargement requis
      log('INFO', 'WORKER', `Message audio — téléchargement depuis Meta`)
      const media = await telechargerMedia(mediaId)

      // ───────────── AJOUT (Flux A) ─────────────
      const reference = await rangerFichierClient({ phone, base64: media.base64, mimeType: media.mimeType })
      // ───────────── FIN AJOUT ─────────────

      message = {
        type: 'audio',
        base64: media.base64,
        mimeType: media.mimeType,
        reference
      }
      log('INFO', 'WORKER', `Audio prêt — mimeType: ${media.mimeType}`)
    } else {
      log('WARN', 'WORKER', `Type de message inconnu : ${type} — traité comme texte`)
      message = content || ''
    }

    // ── Appel agent ───────────────────────────────────────────
    log('INFO', 'WORKER', `Appel agent pour ${phone}`)
    // ───────────── AJOUT (étape 2 du plan) ─────────────
    // On fait suivre id_message et repond_a_id_whatsapp jusqu'à l'agent.
    // agent.js ne les utilise pas encore — ils attendent l'étape 3 (sessions).
    const { elements } = await traiterMessage({ phone, message,defaultName, id_message, repond_a_id_whatsapp })
    log('INFO', 'WORKER', `${elements.length} élément(s) à envoyer pour ${phone}`)

    // ── Envoi WhatsApp, élément par élément, dans l'ordre ─────
    // ───────────── AJOUT (étape suivante du plan) ─────────────
    for (const element of elements) {
      let idWhatsapp = null

      if (element.type === 'text') {
        idWhatsapp = await envoyerTexte(phone, element.content)
      } else if (element.type === 'image') {
        idWhatsapp = await envoyerImage(phone, element)
      }

      if (idWhatsapp && element.id_interne) {
        await mettreAJourIdWhatsapp({ id: element.id_interne, id_whatsapp: idWhatsapp })
      }
    }
    // ───────────── FIN AJOUT ─────────────

    log('INFO', 'WORKER', `=== Job [${job.id}] terminé avec succès ===`)

  } catch (err) {
    log('ERROR', 'WORKER', `=== Job [${job.id}] échoué pour ${phone} ===`, err.message)
    log('ERROR', 'WORKER', `Stack trace`, err.stack)

    // Tentative d'envoi d'un message d'erreur au client
    try {
      await envoyerTexte(
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
// concurrency: 5 → 5 clients traités en parallèle maximum
// ─────────────────────────────────────────────────────────────
log('INFO', 'WORKER', '=== Démarrage du worker WhatsApp ===')
log('INFO', 'WORKER', `Redis: ${process.env.REDIS_URL ? 'REDIS_URL Railway détectée' : (process.env.REDIS_HOST || 'localhost') + ':' + (process.env.REDIS_PORT || 6379)}`)

const worker = new Worker(
  'messages-whatsapp',
  traiterJob,
  {
    ...connexionRedis,
    concurrency: 5
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


