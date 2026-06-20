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


export async function getHistorique({ phone, limit = 15 }) {
  const { data, error } = await supabase
    .from('historique_messages')
    .select('role, content, type, timestamp')
    .eq('phone', phone)
    .order('timestamp', { ascending: false })
    .limit(limit)

  if (error) return { messages: [], total: 0 }

  const messages = (data || []).reverse()
  return { messages, total: messages.length }
}

export async function sauvegarderMessage({ phone, role, content, type = 'text' }) {
  const { error } = await supabase
    .from('historique_messages')
    .insert({ phone, role, content, type })

  if (error) return { success: false, erreur: error.message }

  const { data: profil } = await supabase
    .from('profils_whatsapp')
    .select('nb_messages')
    .eq('phone', phone)
    .single()

  const nouveauTotal = (profil?.nb_messages || 0) + 1

  await supabase
    .from('profils_whatsapp')
    .update({ nb_messages: nouveauTotal, mis_a_jour_le: new Date().toISOString() })
    .eq('phone', phone)

  return { success: true, nb_messages: nouveauTotal }
}

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