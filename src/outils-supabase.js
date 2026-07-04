import supabase from './supabase-client.js'
import 'dotenv/config'
import { GoogleGenAI } from '@google/genai'

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

export async function getProfilClient({ phone }) {
  const { data, error } = await supabase
    .from('profils_whatsapp')
    .select('*')
    .eq('phone', phone)
    .single()

  if (error || !data) return { found: false }
  return { found: true, profil: data }
}

export async function sauvegarderProfil({ phone, nom, dolibarr_id, preferences, resume }) {
  const { data: existant } = await supabase
    .from('profils_whatsapp')
    .select('phone')
    .eq('phone', phone)
    .single()

  const payload = {
    phone,
    mis_a_jour_le: new Date().toISOString(),
    ...(nom !== undefined && { nom }),
    ...(dolibarr_id !== undefined && { dolibarr_id }),
    ...(preferences !== undefined && { preferences }),
    ...(resume !== undefined && { resume }),
  }

  const { error } = await supabase
    .from('profils_whatsapp')
    .upsert(payload, { onConflict: 'phone' })

  if (error) return { success: false, erreur: error.message }
  return { success: true, action: existant ? 'updated' : 'created' }
}


// export async function getHistorique({ phone, limit = 15 }) {
//   const { data, error } = await supabase
//     .from('historique_messages')
//     .select('role, content, type, timestamp')
//     .eq('phone', phone)
//     .order('timestamp', { ascending: false })
//     .limit(limit)

//   if (error) return { messages: [], total: 0 }

//   const messages = (data || []).reverse()
//   return { messages, total: messages.length }
// }

export async function getHistorique({ phone, session_id, limit = 15 }) {
  const { data, error } = await supabase
    .from('historique_messages')
    .select('role, content, type, timestamp')
    .eq('session_id', session_id)
    .order('timestamp', { ascending: false })
    .limit(limit)

  if (error) return { messages: [], total: 0 }

  const messages = (data || []).reverse()
  return { messages, total: messages.length }
}

// export async function sauvegarderMessage({ phone, role, content, type = 'text' }) {
//   const { error } = await supabase
//     .from('historique_messages')
//     .insert({ phone, role, content, type })

//   if (error) return { success: false, erreur: error.message }

//   const { data: profil } = await supabase
//     .from('profils_whatsapp')
//     .select('nb_messages')
//     .eq('phone', phone)
//     .single()

//   const nouveauTotal = (profil?.nb_messages || 0) + 1

//   await supabase
//     .from('profils_whatsapp')
//     .update({ nb_messages: nouveauTotal, mis_a_jour_le: new Date().toISOString() })
//     .eq('phone', phone)

//   return { success: true, nb_messages: nouveauTotal }
// }

export async function sauvegarderMessage({
  phone, session_id, role, content, type = 'text',
  id_whatsapp = null, repond_a_id_whatsapp = null, reference_fichier = null
}) {
  const { data: inserted, error } = await supabase
    .from('historique_messages')
    .insert({
      phone, session_id, role, content, type,
      id_whatsapp, repond_a_id_whatsapp, reference_fichier,
      statut: 'normal'
    })
    .select('id')
    .single()

  if (error) return { success: false, erreur: error.message }

  const { data: session } = await supabase
    .from('sessions')
    .select('nb_messages')
    .eq('id', session_id)
    .single()

  const nouveauTotal = (session?.nb_messages || 0) + 1

  await supabase
    .from('sessions')
    .update({ nb_messages: nouveauTotal, dernier_message_le: new Date().toISOString() })
    .eq('id', session_id)

  return { success: true, id: inserted.id, nb_messages: nouveauTotal }
}

// ───────────── AJOUT (étape suivante du plan) ─────────────
// mettreAJourIdWhatsapp — met à jour l'id_whatsapp réel d'une ligne
// déjà sauvegardée, une fois l'envoi effectif fait par worker.js.
// Appelée DIRECTEMENT (pas via MCP) car c'est un simple update
// technique, pas une décision que Gemini doit prendre.
export async function mettreAJourIdWhatsapp({ id, id_whatsapp }) {
  const { error } = await supabase
    .from('historique_messages')
    .update({ id_whatsapp })
    .eq('id', id)

  if (error) return { success: false, erreur: error.message }
  return { success: true }
}
// ───────────── FIN AJOUT ─────────────

// // ───────────── AJOUT (étape suivante du plan) ─────────────
// // mettreAJourIdWhatsapp — met à jour l'id_whatsapp réel d'une ligne
// // déjà sauvegardée, une fois l'envoi effectif fait par worker.js.
// // Appelée DIRECTEMENT (pas via MCP) car c'est un simple update
// // technique, pas une décision que Gemini doit prendre.
// export async function mettreAJourIdWhatsapp({ id, id_whatsapp }) {
//   const { error } = await supabase
//     .from('historique_messages')
//     .update({ id_whatsapp })
//     .eq('id', id)

//   if (error) return { success: false, erreur: error.message }
//   return { success: true }
// }
// ───────────── FIN AJOUT ─────────────

export async function resumerHistorique({ phone }) {
  const { data: anciens, error } = await supabase
    .from('historique_messages')
    .select('id, role, content, timestamp')
    .eq('phone', phone)
    .order('timestamp', { ascending: true })
    .limit(15)

  if (error || !anciens || anciens.length === 0) {
    return { success: false, erreur: 'Aucun message à résumer' }
  }

  const contenu = anciens.map(m => ({
    role: 'user',
    parts: [{
      text: `${m.role === 'user' ? 'Client' : 'Agent'}: ${m.content}`
    }]
  }))

  contenu.push({
    role: 'user',
    parts: [{
      text: `Résume cette conversation en 3-5 points max. Garde uniquement les informations importantes sur le client, ses préférences, ses commandes passées et ses produits d'intérêt.`
    }]
  })

  const reponse = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL,
    contents: contenu
  })

  const resume = reponse.text

  const ids = anciens.map(m => m.id)
  await supabase.from('historique_messages').delete().in('id', ids)

  await supabase
    .from('profils_whatsapp')
    .update({
      resume,
      nb_messages: 15,
      mis_a_jour_le: new Date().toISOString()
    })
    .eq('phone', phone)

  return { success: true, resume }
}

// ───────────── AJOUT (étape 3a du plan) ─────────────
// getOuCreerSessionActive — trouve la session 'active' du client,
// ou en crée une nouvelle s'il n'en existe aucune.
// N'est PAS encore appelée depuis agent.js — préparation seulement.
// Paramètres : phone
// Retourne : { session_id, creee: boolean }
export async function getOuCreerSessionActive({ phone }) {
  const { data: sessionExistante, error: erreurLecture } = await supabase
    .from('sessions')
    .select('id')
    .eq('phone', phone)
    .eq('statut', 'active')
    .order('debut_session', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (erreurLecture) {
    return { success: false, erreur: erreurLecture.message }
  }

  if (sessionExistante) {
    return { success: true, session_id: sessionExistante.id, creee: false }
  }

  const { data: nouvelleSession, error: erreurCreation } = await supabase
    .from('sessions')
    .insert({ phone, statut: 'active' })
    .select('id')
    .single()

  if (erreurCreation) {
    return { success: false, erreur: erreurCreation.message }
  }

  return { success: true, session_id: nouvelleSession.id, creee: true }
}
// ───────────── FIN AJOUT ─────────────