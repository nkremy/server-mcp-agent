// ─────────────────────────────────────────────────────────────
// src/scanner-resume.js
// Responsabilité : détecter les sessions inactives et déclencher
//                 leur résumé — SANS file BullMQ, appel direct
//                 à resumerHistorique.
//
// Deux variables d'environnement (en millisecondes) :
//   SESSION_SEUIL_INACTIVITE_MS → durée d'inactivité avant de considérer
//                                  une session terminée
//   SESSION_SCAN_INTERVALLE_MS  → fréquence à laquelle ce scan tourne
// ─────────────────────────────────────────────────────────────
import supabase from './supabase-client.js'
import { resumerHistorique } from './outils-supabase.js'
import 'dotenv/config'

function log(niveau, message, data = null) {
  const ts = new Date().toISOString()
  const ligne = `[${ts}] [${niveau}] [SCANNER-RESUME] ${message}`
  if (data !== null) {
    console.error(ligne, typeof data === 'object' ? JSON.stringify(data) : data)
  } else {
    console.error(ligne)
  }
}

const SEUIL_MS = parseInt(process.env.SESSION_SEUIL_INACTIVITE_MS || '1800000')       // défaut 30 min
const INTERVALLE_MS = parseInt(process.env.SESSION_SCAN_INTERVALLE_MS || '600000')     // défaut 10 min

async function scannerSessionsInactives() {
  log('INFO', `Scan des sessions inactives (seuil: ${SEUIL_MS}ms)`)

  const limiteTemps = new Date(Date.now() - SEUIL_MS).toISOString()

  const { data: sessionsInactives, error } = await supabase
    .from('sessions')
    .select('id, phone, dernier_message_le')
    .eq('statut', 'active')
    .lt('dernier_message_le', limiteTemps)

  if (error) {
    log('ERROR', 'Échec lecture sessions inactives', error.message)
    return
  }

  if (!sessionsInactives || sessionsInactives.length === 0) {
    log('INFO', 'Aucune session inactive détectée')
    return
  }

  log('INFO', `${sessionsInactives.length} session(s) inactive(s) détectée(s)`)

  for (const session of sessionsInactives) {
    log('INFO', `Résumé déclenché pour session ${session.id} (phone: ${session.phone})`)
    try {
      const resultat = await resumerHistorique({ session_id: session.id })
      if (resultat.success) {
        log('INFO', `Session ${session.id} résumée avec succès`)
      } else {
        log('ERROR', `Échec résumé session ${session.id}`, resultat.erreur)
      }
    } catch (err) {
      log('ERROR', `Erreur inattendue résumé session ${session.id}`, err.message)
    }
  }
}

log('INFO', `=== Démarrage scanner-resume ===`)
log('INFO', `Seuil inactivité : ${SEUIL_MS}ms — Intervalle scan : ${INTERVALLE_MS}ms`)

// Premier scan immédiat au démarrage, puis répétition selon l'intervalle
scannerSessionsInactives()
setInterval(scannerSessionsInactives, INTERVALLE_MS)