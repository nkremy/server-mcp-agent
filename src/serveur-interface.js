// ─────────────────────────────────────────────────────────────
// src/serveur-interface.js
// Responsabilité : serveur HTTP indépendant pour l'interface web
//                 de gestion des conversations (v1 — texte uniquement)
//
// Ne touche JAMAIS au flux entrant (webhook → BullMQ → worker → agent).
// Réutilise les fonctions déjà exportées d'outils-supabase.js.
// envoyerTexte est dupliquée depuis worker.js (pas exportée là-bas).
// ─────────────────────────────────────────────────────────────
import express from 'express'
import axios from 'axios'
import 'dotenv/config'

import {
  getOuCreerSessionActive,
  sauvegarderMessage,
  mettreAJourIdWhatsapp
} from './outils-supabase.js'

const app = express()
app.use(express.json())

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
// envoyerTexte — envoie un message texte brut via l'API WhatsApp
// (copie adaptée depuis worker.js)
//
// Paramètres :
//   phone (string, obligatoire) — numéro WhatsApp destinataire
//   texte (string, obligatoire) — contenu du message
// Retourne :
//   id_whatsapp (string) si succès, null si texte vide
// ─────────────────────────────────────────────────────────────
async function envoyerTexte(phone, texte) {
  if (!texte || !texte.trim()) return null
  log('INFO', 'WHATSAPP', `Envoi texte manuel à ${phone} — ${texte.length} caractères`)
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
    log('INFO', 'WHATSAPP', `Texte manuel envoyé à ${phone} — id: ${idWhatsapp}`)
    return idWhatsapp
  } catch (err) {
    log('ERROR', 'WHATSAPP', `Échec envoi texte manuel`, err.message)
    if (err.response?.data) log('ERROR', 'WHATSAPP', `Détail Meta`, err.response.data)
    throw err
  }
}

// ─────────────────────────────────────────────────────────────
// POST /api/conversations/:phone/envoyer-texte
//
// Body attendu : { "texte": "..." }
// Réplique la chaîne sauvegarde → envoi → mise à jour id_whatsapp,
// exactement comme le fait worker.js pour les messages de l'agent,
// mais avec role: 'assistant' (humain, pas IA).
// ─────────────────────────────────────────────────────────────
app.post('/api/conversations/:phone/envoyer-texte', async (req, res) => {
  const { phone } = req.params
  const { texte } = req.body

  log('INFO', 'INTERFACE', `Demande d'envoi manuel pour ${phone}`)

  if (!texte || !texte.trim()) {
    return res.status(400).json({ success: false, erreur: 'texte manquant ou vide' })
  }

  try {
    // 1. Session active (créée si besoin — même logique que l'agent)
    const sessionData = await getOuCreerSessionActive({ phone })
    if (!sessionData.success) {
      throw new Error(`Échec récupération session : ${sessionData.erreur}`)
    }
    const session_id = sessionData.session_id

    // 2. Sauvegarde AVANT envoi (id_whatsapp encore inconnu)
    const saveResult = await sauvegarderMessage({
      phone,
      session_id,
      role: 'assistant',
      content: texte,
      type: 'text'
    })
    if (!saveResult.success) {
      throw new Error(`Échec sauvegarde : ${saveResult.erreur}`)
    }

    // 3. Envoi réel à WhatsApp
    const idWhatsapp = await envoyerTexte(phone, texte)

    // 4. Mise à jour de la ligne sauvegardée avec l'id_whatsapp réel
    if (idWhatsapp) {
      await mettreAJourIdWhatsapp({ id: saveResult.id, id_whatsapp: idWhatsapp })
    }

    log('INFO', 'INTERFACE', `Message manuel traité avec succès pour ${phone}`)
    return res.json({ success: true, id_message: saveResult.id, id_whatsapp: idWhatsapp })

  } catch (err) {
    log('ERROR', 'INTERFACE', `Échec traitement envoi manuel pour ${phone}`, err.message)
    return res.status(500).json({ success: false, erreur: err.message })
  }
})

// ─────────────────────────────────────────────────────────────
// AJOUT — import du client Supabase pour les lectures directes
// ─────────────────────────────────────────────────────────────
import supabase from './supabase-client.js'

// ─────────────────────────────────────────────────────────────
// GET /api/conversations
//
// Rôle : liste tous les clients connus, triés par activité récente,
//        pour alimenter la liste des conversations de l'interface.
// Retourne : [{ phone, nom, dernier_message_le }]
// ─────────────────────────────────────────────────────────────
app.get('/api/conversations', async (req, res) => {
  log('INFO', 'INTERFACE', `Demande liste des conversations`)

  try {
    // 1. Tous les profils
    const { data: profils, error: erreurProfils } = await supabase
      .from('profils_whatsapp')
      .select('phone, nom')

    if (erreurProfils) throw new Error(erreurProfils.message)

    // 2. Pour chaque profil, la session la plus récente (peu importe le statut)
    //    → donne la date du dernier message pour trier
    const conversations = await Promise.all(
      profils.map(async (profil) => {
        const { data: derniereSession } = await supabase
          .from('sessions')
          .select('dernier_message_le')
          .eq('phone', profil.phone)
          .order('dernier_message_le', { ascending: false })
          .limit(1)
          .maybeSingle()

        return {
          phone: profil.phone,
          nom: profil.nom,
          dernier_message_le: derniereSession?.dernier_message_le || null
        }
      })
    )

    // Tri : conversation la plus récente en premier
    conversations.sort((a, b) => {
      if (!a.dernier_message_le) return 1
      if (!b.dernier_message_le) return -1
      return new Date(b.dernier_message_le) - new Date(a.dernier_message_le)
    })

    log('INFO', 'INTERFACE', `${conversations.length} conversation(s) trouvée(s)`)
    return res.json({ success: true, conversations })

  } catch (err) {
    log('ERROR', 'INTERFACE', `Échec lecture conversations`, err.message)
    return res.status(500).json({ success: false, erreur: err.message })
  }
})

// ─────────────────────────────────────────────────────────────
// GET /api/conversations/:phone/messages
//
// Rôle : historique complet d'un client, ordre chronologique.
// Retourne : [{ id, role, content, type, timestamp, reference_fichier }]
// ─────────────────────────────────────────────────────────────
app.get('/api/conversations/:phone/messages', async (req, res) => {
  const { phone } = req.params
  log('INFO', 'INTERFACE', `Demande historique pour ${phone}`)

  try {
    const { data, error } = await supabase
      .from('historique_messages')
      .select('id, role, content, type, timestamp, reference_fichier')
      .eq('phone', phone)
      .order('timestamp', { ascending: true })

    if (error) throw new Error(error.message)

    log('INFO', 'INTERFACE', `${data.length} message(s) trouvé(s) pour ${phone}`)
    return res.json({ success: true, messages: data })

  } catch (err) {
    log('ERROR', 'INTERFACE', `Échec lecture historique pour ${phone}`, err.message)
    return res.status(500).json({ success: false, erreur: err.message })
  }
})

// ─────────────────────────────────────────────────────────────
// PATCH /api/conversations/:phone/ia
//
// Rôle : active ou désactive l'IA pour un client précis.
// Body attendu : { "active": true } ou { "active": false }
// Retourne : { success: true, phone, ia_active }
// ─────────────────────────────────────────────────────────────
app.patch('/api/conversations/:phone/ia', async (req, res) => {
  const { phone } = req.params
  const { active } = req.body

  log('INFO', 'INTERFACE', `Bascule IA pour ${phone} → ${active}`)

  if (typeof active !== 'boolean') {
    return res.status(400).json({ success: false, erreur: 'le champ "active" doit être true ou false' })
  }

  try {
    const { error } = await supabase
      .from('profils_whatsapp')
      .update({ ia_active: active, mis_a_jour_le: new Date().toISOString() })
      .eq('phone', phone)

    if (error) throw new Error(error.message)

    log('INFO', 'INTERFACE', `IA ${active ? 'activée' : 'désactivée'} pour ${phone}`)
    return res.json({ success: true, phone, ia_active: active })

  } catch (err) {
    log('ERROR', 'INTERFACE', `Échec bascule IA pour ${phone}`, err.message)
    return res.status(500).json({ success: false, erreur: err.message })
  }
})

// ─────────────────────────────────────────────────────────────
// Démarrage
// ─────────────────────────────────────────────────────────────
const PORT = process.env.INTERFACE_PORT || 3010

app.listen(PORT, () => {
  log('INFO', 'INTERFACE', `=== Serveur interface démarré sur le port ${PORT} ===`)
  log('INFO', 'INTERFACE', `POST /api/conversations/:phone/envoyer-texte`)
})