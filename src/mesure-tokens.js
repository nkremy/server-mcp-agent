// ─────────────────────────────────────────────────────────────
// src/mesure-tokens.js
// Responsabilité : enveloppe UNIQUE autour de ai.models.generateContent.
//
// Contrat strict : mêmes paramètres en entrée, EXACTEMENT le même
// objet en sortie que Gemini renvoie — rien n'est transformé.
// En plus, mesure la latence et les tokens consommés, et les
// enregistre dans mesure_tokens. Un échec de mesure ne doit JAMAIS
// faire échouer l'appel principal.
// ─────────────────────────────────────────────────────────────
import { GoogleGenAI } from '@google/genai'
import supabase from './supabase-client.js'
import 'dotenv/config'

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

// paramsGenerateContent : exactement ce que ai.models.generateContent attend
// contexte : { phone?, session_id?, type_appel } — sert UNIQUEMENT à la mesure,
//            jamais transmis à Gemini
export async function appellerModele(paramsGenerateContent, contexte = {}) {
  const debut = Date.now()
  const reponse = await ai.models.generateContent(paramsGenerateContent)
  const latence_ms = Date.now() - debut

  try {
    const usage = reponse.usageMetadata || {}
    await supabase.from('mesure_tokens').insert({
      phone: contexte.phone || null,
      session_id: contexte.session_id || null,
      modele: paramsGenerateContent.model,
      tokens_entree: usage.promptTokenCount || 0,
      tokens_sortie: usage.candidatesTokenCount || 0,
      tokens_total: usage.totalTokenCount || 0,
      type_appel: contexte.type_appel || 'inconnu',
      latence_ms
    })
  } catch (err) {
    console.error('[MESURE_TOKENS] Échec enregistrement — non bloquant', err.message)
  }

  return reponse
}