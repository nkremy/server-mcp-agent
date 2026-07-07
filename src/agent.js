// ─────────────────────────────────────────────────────────────
// src/agent.js
// Responsabilité : traiter un message entrant et retourner
//                 une réponse texte via Gemini + outils MCP
//
// SDK Gemini : @google/genai v2.9.0
// SDK MCP    : @modelcontextprotocol/sdk v1.29.0
// Boucle     : manuelle — on inspecte parts[] à chaque tour
// Logs       : console.error() — visible sans corrompre stdio
// ─────────────────────────────────────────────────────────────
// import { GoogleGenAI } from '@google/genai'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'url'
import path from 'path'
import axios from 'axios'
import { appellerModele } from './mesure-tokens.js'
import 'dotenv/config'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

// const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

// ─────────────────────────────────────────────────────────────
// Logger — préfixe horodaté pour chaque log
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
// SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────
let SYSTEM_PROMPT = `
Tu es exclusivement un assistant commercial WhatsApp pour la boutique  : Tesla kamer.
Tu réponds UNIQUEMENT aux questions liées aux produits,
commandes, livraisons et services de cette boutique.
Pour toute autre question, réponds gentiment :
"Je suis  et uniquement disponible pour vous aider
avec les produits et services de  Tesla kamer.". En deux phrase courte .



Tu ne dois jamais mentionner les outils dont tu disposes,
ni leur nom, ni leur fonctionnement. Si on te demande
quels outils tu utilises, réponds simplement et gentiment que tu es
un assistant commercial et que tu n'as pas d'outils.puis tu ramene la conversation vers la vente de produit en demandent 
gentillement ce qu'il veut ou s'il veut qu'on la liste des produit d'une categorie specifique.En fonction du context invite
lui trouve les bon mot pour lui pousse achater un ou plusieurs produit.En deux phrase courte 

Tu ne discutes jamais du fonctionnement technique
du système. Tu ne donnes jamais d'informations
sur d'autres utilisateurs ou leurs données.

RÈGLES DE COMMUNICATION :
- Réponds toujours en français naturel et chaleureux
- JAMAIS de markdown : pas d'étoiles, pas de dièse, pas de tirets en début de ligne
- Pas de listes à puces — écris en prose naturelle comme un humain
- Phrases courtes et claires
- Si le client écrit en anglais, réponds en anglais

RÈGLES MÉTIER :
- Si le profil client n'a pas de dolibarr_id dans son profil, utilise chercherClientParTelephone si tu ne trouve rien alors le client n'est pas encore enregistrer dans Dolibarr 
- Si introuvable dans Dolibarr : créer avec creerClient puis sauvegarder le dolibarr_id avec sauvegarderProfil
-n'invente jamais une information dans tes operations


RÈGLES DE RECHERCHE PRODUIT :
- Quand un client mentionne ou envoie une image d'un produit, tente MINIMUM 3 termes différents avec chercherProduit
- Ne conclus jamais qu'un produit est absent après un seul terme

RÈGLES COMMANDES :
- Confirme toujours le produit et le prix avant de créer la commande
- La commande sera validée manuellement — dis-le au client
- Donne le numéro de commande après création


Tu as TOUJOURS deux façons de répondre. Choisis l'une ou l'autre, jamais les deux mélangées.

CAS 1 — Réponse texte uniquement (pas d'images) :
Commence ta réponse par TEXT: suivi de ton message.
Exemple :
TEXT: Bonjour ! Comment puis-je vous aider aujourd'hui ?

CAS 2 — Réponse avec images :
Commence ta réponse par MEDIA: suivi IMMÉDIATEMENT d'un JSON valide sur une seule ligne.
Aucun texte avant ou après le JSON — tout est dans le JSON.
Exemple :
MEDIA: {"avant_bloc_media":"Voici nos produits disponibles","medias":[{"intro":"Cuisinière 4 feux","images":[{"original_file":"PROD001/cuisiniere.jpg","legende":"Cuisinière ICS4 — 102 000 FCFA"}],"conclusion":""},{"intro":"","images":[{"original_file":"PROD001/plaque.jpg"}],"conclusion":"Stock limité"}],"apres_bloc_media":"N'hésitez pas à commander !"}

RÈGLES STRICTES FORMAT MEDIA :
- Toujours commencer par MEDIA: (avec les deux points)
- Le JSON doit être sur UNE SEULE LIGNE immédiatement après MEDIA:
- Champs obligatoires : medias (tableau), chaque objet a images (tableau), chaque image a original_file
- Champs optionnels : avant_bloc_media, apres_bloc_media, intro, conclusion, legende
- Si un champ optionnel n'a rien à dire : NE PAS L'INCLURE dans le JSON
- original_file vient EXACTEMENT du résultat de getImagesProduit — ne jamais inventer
- Maximum 2 images par produit
- JAMAIS de base64 dans ta réponse
- JAMAIS de markdown dans les textes du JSON (pas d'étoiles, pas de dièse)
- Le JSON doit être valide — pas de virgule en trop, pas de guillemets manquants

RÈGLES STRICTES FORMAT TEXT :
- Toujours commencer par TEXT: (avec les deux points)
- Texte naturel sans markdown après TEXT:
- Jamais de JSON dans une réponse TEXT:
`

// ───────────── AJOUT (étape suivante du plan) ─────────────
// aplatirReponse — interprète la réponse Gemini (TEXT: ou MEDIA:)
// et la transforme en tableau plat ordonné, un élément par message
// WhatsApp distinct à envoyer. Reprend la logique qui était dans
// parserReponse/envoyerReponse (worker.js), déplacée ici.
function aplatirReponse(reponseTexte) {
  const reponse = reponseTexte.trim()
  const elements = []

  if (reponse.startsWith('TEXT:')) {
    const texte = reponse.slice(5).trim()
    if (texte) elements.push({ type: 'text', content: texte })
    return elements
  }

  if (reponse.startsWith('MEDIA:')) {
    const jsonBrut = reponse.slice(6).trim()
    let data
    try {
      data = JSON.parse(jsonBrut)
    } catch (err) {
      elements.push({ type: 'text', content: jsonBrut })
      return elements
    }

    if (data.avant_bloc_media?.trim()) {
      elements.push({ type: 'text', content: data.avant_bloc_media.trim() })
    }

    for (const bloc of (data.medias || [])) {
      if (bloc.intro?.trim()) {
        elements.push({ type: 'text', content: bloc.intro.trim() })
      }
      for (const imageInfo of (bloc.images || [])) {
        elements.push({
          type: 'image',
          original_file: imageInfo.original_file,
          legende: imageInfo.legende || ''
        })
      }
      if (bloc.conclusion?.trim()) {
        elements.push({ type: 'text', content: bloc.conclusion.trim() })
      }
    }

    if (data.apres_bloc_media?.trim()) {
      elements.push({ type: 'text', content: data.apres_bloc_media.trim() })
    }

    return elements
  }

  elements.push({ type: 'text', content: reponse })
  return elements
}
// ───────────── FIN AJOUT ─────────────


// ───────────── AJOUT (Flux C, point 6) ─────────────
// recupererBlocsSessionsInconnues — à CHAQUE tour, rebalaye TOUS les
// replies déjà faits dans la session actuelle (pas seulement le
// dernier message), et retourne un bloc par session inconnue trouvée,
// dédupliqué. Rien n'est stocké de façon permanente : c'est reconstruit
// intégralement à chaque appel, tant que la session actuelle est en cours.
// async function recupererBlocsSessionsInconnues(session_id_courante, sessionsConnues, mcpClient, phone) {
//   const { cibles } = await appelOutil(mcpClient, 'getCiblesRepliesSession', { session_id: session_id_courante }, phone)
//   if (!cibles || cibles.length === 0) return []

//   const sessionsInconnuesVues = new Set()
//   const blocs = []

//   for (const idWhatsappCible of cibles) {
//     const resolution = await appelOutil(mcpClient, 'resoudreMessageReplique', { id_whatsapp: idWhatsappCible }, phone)
//     if (!resolution.found) continue

//     const classification = classifierSessionCible(resolution.message.session_id, session_id_courante, sessionsConnues)
//     if (classification.statut !== 'inconnue') continue

//     if (sessionsInconnuesVues.has(resolution.message.session_id)) continue
//     sessionsInconnuesVues.add(resolution.message.session_id)

//     const bloc = await construireBlocSessionInconnue(resolution.message.session_id, mcpClient, phone)
//     if (bloc) blocs.push(bloc)
//   }

//   return blocs
// }
// ───────────── FIN AJOUT ─────────────

// ─────────────────────────────────────────────────────────────
// creerClientMCP — ouvre une connexion stdio vers le serveur MCP
// ─────────────────────────────────────────────────────────────
async function creerClientMCP(phone) {
  const cheminServeur = path.resolve(__dirname, 'serveur-mcp.js')
  log('INFO', 'MCP', `Connexion au serveur MCP pour ${phone}`)

  const transport = new StdioClientTransport({
    command: 'node',
    args: [cheminServeur],
    env: { ...process.env }
  })

  const mcpClient = new Client({ name: 'agent-whatsapp-client', version: '1.0.0' })

  try {
    await mcpClient.connect(transport)
    log('INFO', 'MCP', `Connexion établie pour ${phone}`)
    return mcpClient
  } catch (err) {
    log('ERROR', 'MCP', `Échec connexion pour ${phone}`, err.message)
    throw err
  }
}

// ─────────────────────────────────────────────────────────────
// appelOutil — appelle un outil MCP et parse la réponse
// ─────────────────────────────────────────────────────────────
async function appelOutil(mcpClient, nom, args, phone) {
  log('INFO', 'OUTIL', `Appel outil [${nom}]`, args)
  try {
    const resultat = await mcpClient.callTool({ name: nom, arguments: args })
    const data = JSON.parse(resultat.content[0].text)
    log('INFO', 'OUTIL', `Résultat [${nom}]`, data)
    return data
  } catch (err) {
    log('ERROR', 'OUTIL', `Échec outil [${nom}] pour ${phone}`, err.message)
    throw err
  }
}

// ─────────────────────────────────────────────────────────────
// construireContenu — construit le message actuel selon le type
// ─────────────────────────────────────────────────────────────
function construireContenu(message) {
  if (typeof message === 'string') {
    return {
      role: 'user',
      parts: [{ text: message }]
    }
  }

  const parts = []

  // Image ou audio → inlineData
  if (message.type === 'image' || message.type === 'audio') {
    parts.push({
      inlineData: {
        mimeType: message.mimeType,
        data: message.base64
      }
    })
  }

  // Texte accompagnant (légende image ou texte seul)
  if (message.texte) {
    parts.push({ text: message.texte })
  }

  return { role: 'user', parts }
}

// ─────────────────────────────────────────────────────────────
// construireResume — version légère pour sauvegarde Supabase
// ─────────────────────────────────────────────────────────────
function construireResume(message) {
  if (typeof message === 'string') return { content: message, type: 'text' }

  // const prefixes = {
  //   image: '[image]',
  //   audio: '[audio]'
  // }
  // const prefix = prefixes[message.type] || ''
  const texte  = message.texte ? ` ${message.texte}` : ''

  // Priorité type : image > audio > text
  return {
    content: message.type === "image" ? `legende : ${texte}`.trim() : '',
    type: message.type || 'text'
  }
}

// ───────────── AJOUT (Flux A) ─────────────
// transcrireAudio — obtient une VRAIE transcription texte de l'audio,
// via un appel Gemini dédié (séparé de la conversation principale).
// En cas d'échec, on retombe sur le placeholder existant plutôt que
// de bloquer tout le traitement du message.
async function transcrireAudio(base64, mimeType, contexte) {
  try {
    const reponse = await appellerModele({
      model: process.env.GEMINI_MODEL,
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: base64 } },
          { text: 'Transcris cet audio en texte, mot pour mot, sans commentaire ni ajout uniquement la transcription.' }
        ]
      }]
    }, { ...contexte, type_appel: 'transcription_audio' })

    return reponse.text?.trim() || '[audio non transcriptible]'
  } catch (err) {
    log('ERROR', 'AGENT', `Échec transcription audio — fallback placeholder`, err.message)
    return '[audio]'
  }
}
// ───────────── FIN AJOUT ─────────────

// ─────────────────────────────────────────────────────────────
// convertirOutilsMCPversGemini — prend les outils au serveur mcp et les met au format gemini
// ─────────────────────────────────────────────────────────────

function convertirOutilsMCPversGemini(tools) {
  return tools.map(outil => ({
    name: outil.name,
    description: outil.description,
    parameters: {
      type: outil.inputSchema.type,
      properties: outil.inputSchema.properties,
      required: outil.inputSchema.required ?? []
    }
  }))
}


// ───────────── AJOUT (Flux C, point 3) ─────────────
// classifierSessionCible — compare la session ciblée par un reply
// aux sessions déjà connues à ce tour (session actuelle + N dernières
// injectées). Fonction pure, aucun accès base de données : tout est
// déjà disponible en mémoire à ce stade du traitement.
// function classifierSessionCible(session_id_cible, session_id_courante, sessionsConnues) {
//   if (session_id_cible === session_id_courante) {
//     return { statut: 'actuelle' }
//   }
//   const trouvee = sessionsConnues.find(s => s.session_id === session_id_cible)
//   if (trouvee) {
//     return { statut: 'connue', session: trouvee }
//   }
//   return { statut: 'inconnue' }
// }
// ───────────── FIN AJOUT ─────────────



// ───────────── AJOUT (Flux C, point 4) ─────────────
const EXTENSIONS_VERS_MIME = {
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  ogg: 'audio/ogg', mp3: 'audio/mpeg', amr: 'audio/amr', mp4: 'video/mp4'
}

function deviverMimeType(reference) {
  const extension = reference.split('.').pop()
  return EXTENSIONS_VERS_MIME[extension] || 'application/octet-stream'
}

// retrouverFichierClient — appelle le service gestionnaire-fichier pour
// récupérer un média du client, UNIQUEMENT nécessaire pour les images
// (l'audio utilise déjà sa transcription sauvegardée, pas d'appel réseau).
async function retrouverFichierClient({ reference }) {
  try {
    const reponse = await axios.post(
      `${process.env.GESTIONNAIRE_FICHIER_URL}/retrouver-fichier`,
      { reference }
    )
    return reponse.data
  } catch (err) {
    log('ERROR', 'STOCKAGE', `Échec récupération fichier pour reply — non bloquant`, err.message)
    return { success: false }
  }
}

// construireContenuReplique — construit le contenu à injecter pour
// "ce à quoi le client répond", selon les 5 cas réels (qui a envoyé
// x quel type). Ne s'occupe PAS de savoir si la session est connue —
// ça, c'est le point 5.
async function construireContenuReplique(messageResolu, mcpClient, phone,sessionsContexteLLM) {
  const { role, type, content, reference_fichier, reference_produit , session_id } = messageResolu
  let sessionConcerne = sessionsContexteLLM.find(item => item.session_id === session_id);

  if(!sessionConcerne){
    //LA SESSION N'EST PAS ENCORE CONNU DU LLM IL FAUT L'AJOUTER
    const sessionData = await appelOutil(mcpClient, 'getSessionParId', { session_id }, phone)
    sessionData.session_id = session_id;
    sessionsContexteLLM.push({
      session_id ,
      debut_session:sessionData.debut_session,
      fin_session:sessionData.fin_session,
      resume:sessionData.resume,
    })

    sessionConcerne = sessionData;
  }

  if (role === 'user' && type === 'text') {
    return { parts: [{ text: `[SESSION CONCERNE : date debut : ${sessionConcerne.debut_session}][Le client répond à son propre message : "${content}"]` }] }
  }

  if (role === 'user' && type === 'image') {
    const parts = [{ text: `[SESSION CONCERNE : date debut : ${sessionConcerne.debut_session}][Le client répond à une image qu'il avait envoyée${content ? ' (légende : ' + content + ')' : ''}]` }]
    if (reference_fichier) {
      const fichier = await retrouverFichierClient({ reference: reference_fichier })
      if (fichier.success) {
        parts.push({ inlineData: { mimeType: deviverMimeType(reference_fichier), data: fichier.base64 } })
      }
    }
    return { parts }
  }

  if (role === 'user' && type === 'audio') {
    return { parts: [{ text: `[SESSION CONCERNE : date debut : ${sessionConcerne.debut_session}][Le client répond à un audio qu'il avait envoyé, transcription : "${content}"]` }] }
  }

  if (role === 'model' && type === 'text') {
    return { parts: [{ text: `[SESSION CONCERNE : date debut : ${sessionConcerne.debut_session}][Le client répond à votre message : "${content}"]` }] }
  }

  if (role === 'model' && type === 'image' && reference_produit) {
    const produitData = await appelOutil(mcpClient, 'chercherProduit', { termes: [reference_produit] }, phone)
    if (produitData.found && produitData.produits?.length) {
      const p = produitData.produits[0]
      return { parts: [{ text: `[SESSION CONCERNE : date debut : ${sessionConcerne.debut_session}][Le client répond à l'image du produit ${p.ref} - ${p.label}, prix: ${p.price_ttc}, description: ${p.description}]` }] }
    }
    return { parts: [{ text: `[Le client répond à une image de produit envoyée précédemment (référence ${reference_produit}, détails indisponibles)]` }] }
  }

  return { parts: [{ text: `[Le client répond à un message précédent : "${content || ''}"]` }] }
}
// ───────────── FIN AJOUT ─────────────


// ───────────── AJOUT (Flux C, point 5) ─────────────
// construireBlocSessionInconnue — quand un reply cible une session
// qui n'est ni la session actuelle, ni parmi les N dernières injectées,
// on va chercher cette session précise pour l'ajouter EN PLUS, juste
// pour ce tour (jamais enregistré, reconstruit à chaque fois).
async function construireBlocSessionInconnue(session_id, mcpClient, phone) {
  const sessionData = await appelOutil(mcpClient, 'getSessionParId', { session_id }, phone)

  if (!sessionData.found) {
    return null // rien à affirmer sur une session introuvable
  }

  if (!sessionData.resume) {
    // Session existante mais sans résumé disponible (résumé en échec ou en cours)
    return `[Session du ${formatDateFr(sessionData.debut_session)} — résumé pas encore disponible pour cette session]`
  }

  return `[Session du ${formatDateFr(sessionData.debut_session)} au ${formatDateFr(sessionData.fin_session)} : ${sessionData.resume}]`
}
// ───────────── FIN AJOUT ─────────────


// ─────────────────────────────────────────────────────────────
// traiterMessage — fonction principale exportée
//
// Paramètres :
//   phone   (string) — numéro WhatsApp ex: +243812345678
//   message (string | object) :
//     string                            → texte pur
//     { type:'image', base64, mimeType, texte? } → image (+ légende)
//     { type:'audio', base64, mimeType }         → audio
//
// Retourne : { texte: string }
// ─────────────────────────────────────────────────────────────
export async function traiterMessage({ phone, message , defaultName , id_message, repond_a_id_whatsapp}) {
  log('INFO', 'AGENT', `=== Début traitement message pour ${phone} ===`)

  let mcpClient = null

  try {
    // ── 1. Connexion MCP ──────────────────────────────────────
    mcpClient = await creerClientMCP(phone)

    //--- CHARGEMET DES OUTILS -----------------------------------
    let {tools}  = await mcpClient.listTools();
    let utils = tools.filter(item=> !['getHistorique','sauvegarderMessage','resumerHistorique','telechargerImage','getOuCreerSessionActive','getDernierResumeSession'].includes(item.name));
    // let utils = tools.filter(item=> !['getHistorique','sauvegarderMessage','resumerHistorique','telechargerImage','getOuCreerSessionActive'].includes(item.name));
    // let utils = tools.filter(item=> !['getHistorique','sauvegarderMessage','resumerHistorique','telechargerImage'].includes(item.name));
    let outils = [{functionDeclarations : convertirOutilsMCPversGemini(utils)}]


    // ── 2. Chargement profil ──────────────────────────────────
    log('INFO', 'AGENT', `Chargement profil pour ${phone}`)
    const profilData = await appelOutil(mcpClient, 'getProfilClient', { phone }, phone)

    if (!profilData.found) {
      log('INFO', 'AGENT', `Premier contact — création profil pour ${phone}`)
      await appelOutil(mcpClient, 'sauvegarderProfil', { phone }, phone)
      log('INFO', 'AGENT', `Profil créé pour ${phone}`)
    } else {
      log('INFO', 'AGENT', `Profil trouvé pour ${phone}`, {
        nom: profilData.profil.nom,
        dolibarr_id: profilData.profil.dolibarr_id,
        nb_messages: profilData.profil.nb_messages
      })
    }

    //--- CE TABLEAU REPRESENTE TOUTES LES SESSIONS QUI DOIVENT ETRE CONNUS DU LLM
    // Ce tableau accumulera toutes les sessions (initiales + découvertes via les replies)
    let sessionsContexteLLM = [];

    // ───────────── AJOUT (étape 3b du plan) ─────────────
    const sessionData = await appelOutil(mcpClient, 'getOuCreerSessionActive', { phone }, phone)
    const session_id = sessionData.session_id
    log('INFO', 'AGENT', `Session active : ${session_id} (créée: ${sessionData.creee})`)
    // ───────────── FIN AJOUT ─────────────

    //--- AJOUTER DE LA SESSION ACTUEL DANS LA LISTE DES SESSION DEVANT ETRE CONNUS PAR LE LLM
    // POUR LE MOMENT ON SUPOSE QUE DURANT getOuCreerSessionActive IL Y A JAMAIS D'ERREUR
    sessionsContexteLLM.push({session_id ,debut_session:sessionData.debut_session,status : `c'est la session actuel`})


    // ####
    //-- Ajouter des informations indispensable dans le systeme prompt (telephone,nom)
    SYSTEM_PROMPT +=`
        information important sur la conversation actuel : 
            telephone (phone) du client : ${phone}
            nom par defaut : ${defaultName} a utiliser quand une action necessite le nom du client mais que le nom n'est pas dans le profilclient (name=""ou null), 
                si lorsque tu utilise l'outil getProfilClient et tu recoi un name=""ou null met le profil ajouter avec le nom par defaut

    `


  //CHARGEMENT IMPORTANT : MAINTENANT , ON SAUVEGARDE LE MESSAGE AVANT DE CHARGE L'HISTRIQUE
  // ── 3. Sauvegarde message client ──────────────────────────
    let { content: contenuSave, type: typeSave } = construireResume(message)
    // log('INFO', 'AGENT', `Sauvegarde message client [${typeSave}] : ${contenuSave.substring(0, 60)}`)
    // ───────────── MODIFIÉ (Flux A) ─────────────
    // let { content: contenuSave, type: typeSave } = construireResume(message)

    // Transcription réelle si audio (remplace le placeholder "[audio]")
    if (typeSave === 'audio' && message?.base64) {
      contenuSave = await transcrireAudio(message.base64, message.mimeType, { phone, session_id })
    }

    // reference_fichier vient du rangement fait dans worker.js (Flux A) —
    // présent uniquement pour image/audio, null pour un texte simple
    const referenceFichierClient = (message?.type === 'image' || message?.type === 'audio')
      ? (message.reference || null)
      : null

    log('INFO', 'AGENT', `Sauvegarde message client [${typeSave}] : ${contenuSave.substring(0, 60)}`)
    const saveUser = await appelOutil(mcpClient, 'sauvegarderMessage', {
      phone,
      session_id,
      role: 'user',
      content: contenuSave,
      type: typeSave,
      id_whatsapp: id_message,
      repond_a_id_whatsapp,
      reference_fichier: referenceFichierClient,
      reference_produit: null
    }, phone)
    log('INFO', 'AGENT', `Message client sauvegardé — nb_messages: ${saveUser.nb_messages}`)
    // ───────────── FIN MODIFIÉ ─────────────




    // ── 4. Chargement historique ──────────────────────────────
    log('INFO', 'AGENT', `Chargement historique pour ${phone}`)
    // const historiqueData = await appelOutil(
    //   mcpClient, 'getHistorique', { phone, limit: 15 }, phone
    // )
    const historiqueData = await appelOutil(
      mcpClient, 'getHistorique', { session_id, limit: 15 }, phone
    )
    log('INFO', 'AGENT', `${historiqueData.total} messages dans l'historique`)

    // ── 5. Construction du contexte ───────────────────────────
    log('INFO', 'AGENT', `Construction du contexte pour ${phone}`)
    const contents = []

    // ───────────── MODIFIÉ (étape 3c, généralisé) ─────────────
    // Injection des N derniers résumés de sessions précédentes.
    // NB_RESUMES_A_INJECTER : ajuste cette valeur ici selon tes besoins
    // (2, 3, 5...) — c'est le seul endroit à modifier.
   // ───────────── MODIFIÉ (Flux C, point 1) ─────────────
    // Injection des N derniers résumés de sessions précédentes,
    // avec dates de début/fin (nécessaire pour le point 6 du plan :
    // comparer une session cible à l'ensemble des sessions "connues").
    const NB_RESUMES_A_INJECTER = 3
    const derniersResumes = await appelOutil(
      mcpClient, 'getDerniersResumesSessions',
      { phone, session_id_courante: session_id, nombre: NB_RESUMES_A_INJECTER },
      phone
    )

    
    //------ AJOUTER LES SESSION QUI PRECENDENT DIRECTEMENT LA SESSION COURANTE DANS LE TABLEAU DES SESSION DEVANT ETRE CONNU PAR LE LLM
    if (derniersResumes.found && derniersResumes.sessions?.length) {
      // const sessionsOrdreChronologique = [...derniersResumes.sessions].reverse()
      // On remplit notre accumulateur avec les 3 sessions initiales
      sessionsContexteLLM.push(...derniersResumes.sessions);
      log('INFO', 'AGENT', `${sessionsContexteLLM.length} session(s) précédente(s) injectée(s)`)
    }

    // ───────────── FIN MODIFIÉ ─────────────
    // ───────────── FIN MODIFIÉ ─────────────



    // ───────────── AJOUT (Flux C, point 1) ─────────────
    // function formatDateFr(iso) {
    //   return new Date(iso).toLocaleString('fr-FR', {
    //     day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    //   })
    // }
    // ───────────── FIN AJOUT ─────────────

    //XXXXXXXXXXX  WARNING ZONE A DEMOLIRE
    // ───────────── AJOUT (Flux C, point 8) ─────────────
    // const sessionsConnues = (derniersResumes.found && derniersResumes.sessions) ? derniersResumes.sessions : []
    // const blocsInconnuesDejaInjectes = new Set()

    // // 8a. Le message entrant est lui-même un reply
    // if (repond_a_id_whatsapp) {
    //   const resolution = await appelOutil(mcpClient, 'resoudreMessageReplique', { id_whatsapp: repond_a_id_whatsapp }, phone)

    //   if (resolution.found) {
    //     const classification = classifierSessionCible(resolution.message.session_id, session_id, sessionsConnues)

    //     const contenuReplique = await construireContenuReplique(resolution.message, mcpClient, phone,sessionsContexteLLM)
    //     contents.push({ role: 'user', parts: contenuReplique.parts })
    //     contents.push({ role: 'model', parts: [{ text: 'Compris, je prends en compte ce contexte.' }] })

    //     if (classification.statut === 'inconnue') {
    //       const bloc = await construireBlocSessionInconnue(resolution.message.session_id, mcpClient, phone)
    //       if (bloc) {
    //         contents.push({ role: 'user', parts: [{ text: bloc }] })
    //         contents.push({ role: 'model', parts: [{ text: 'Compris, je prends en compte ce contexte.' }] })
    //         blocsInconnuesDejaInjectes.add(bloc)
    //       }
    //     }
    //   } else {
    //     log('WARN', 'AGENT', `Reply du message entrant introuvable (id_whatsapp: ${repond_a_id_whatsapp})`)
    //   }
    // }

    // 8b. Systématiquement, à chaque tour : rebalayage de TOUS les replies
    // déjà faits dans la session actuelle, même si le message actuel n'est pas un reply
    // const blocsSessionsInconnues = await recupererBlocsSessionsInconnues(session_id, sessionsConnues, mcpClient, phone)
    // for (const bloc of blocsSessionsInconnues) {
    //   if (blocsInconnuesDejaInjectes.has(bloc)) continue
    //   contents.push({ role: 'user', parts: [{ text: bloc }] })
    //   contents.push({ role: 'model', parts: [{ text: 'Compris, je prends en compte ce contexte.' }] })
    // }
    // ───────────── FIN AJOUT ─────────────
// END WARNING . FIN DE LA ZONE A DEMOLIRE


    // Historique des 15 derniers messages ce la session active uniquement
    for (const msg of historiqueData.messages) {
      // Reconstruction selon le type sauvegardé
      let parts 
      if (msg.type === 'image') {
        // parts = [{ text: `[Le client a envoyé une image : ${msg.content}]` }]
        //ICI C'EST UNE IMAGES
        if(msg.role==="user"){
          parts = []
          //C'EST UNE IMAGES QUI A ETE ENVOYE PAR LE CLIENT . IL FAUT REDONNE L'IMAGE AU LLM 
          //telechargement de l'image depuis le gestionnaire de fichier
          const fichier = await retrouverFichierClient({ reference: reference_fichier })
          parts.push({ inlineData: { mimeType: fichier.mimeType, data: fichier.base64 } })
          if(msg?.content && msg?.content?.length !== 0){
            //alors il y a une legende sur cette image on l'ajoute au par
            parts.push({ text: `legence de l'image : ${msg?.content}` })
          }
        }else{
          //C'EST UNE IMAGES QUI A ETE ENVOYER PAR LE LLM PAS DESOIN DE REDONNER L'IMAGES AU LLM.IL AUT JUSQU'E QU'IL SACHE QU'IL A ENVOYER UNE IMAGES ET A QUOI FAISAIT REFERENCE CETTE IMAGES
          parts = [{ text: `[image] le LLM a envoyer une images qui fait reference au produit ayant la 
            la reference : ${msg?.reference_produit}
            ${(msg?.content?.length !== 0 && msg?.content) ? 'legence de l\'image : ' + msg?.content : '' }` }]
        }
      } else if (msg.type === 'audio') {
        parts = [{ text: `[Le client a envoyé un audio : ${msg.content}]` }]
      } else {
        parts = [{ text: msg.content }]
      }

      //determiner si le message sible un autre message et ajouter les informations du message sible au context pour que le llm comprend
      if(msg?.repond_a_id_whatsapp && msg?.repond_a_id_whatsapp?.trim()?.length !== 0 ){
        //le messable actuel sible un autre message 
        let result =  await construireContenuReplique(msg,mcpClient,phone,sessionsContexteLLM);
        parts.unshift(...result.parts);
      }

      contents.push({
        role: msg.role === 'user' ? 'user' : 'model',
        parts 
      })
    }

    // Message actuel du client
    // const contenuActuel = construireContenu(message)
    // contents.push(contenuActuel)
    // log('INFO', 'AGENT', `Contexte construit — ${contents.length} éléments au total`)

    
    //ajout des sessions dans le system prompt
    SYSTEM_PROMPT +=`
                voici la liste des session important pour bien comprendre
                ${JSON.stringify(sessionsContexteLLM)}
    `

    // ── 6. Boucle agent Gemini ────────────────────────────────
    log('INFO', 'GEMINI', `Premier appel Gemini pour ${phone}`)
    let reponseTexte = null
    let tourBoucle   = 0
    const MAX_TOURS  = 10 // sécurité anti-boucle infinie

    while (tourBoucle < MAX_TOURS) {
      tourBoucle++
      log('INFO', 'GEMINI', `Tour de boucle ${tourBoucle} — ${contents.length} éléments dans contents[]`)

      // Appel Gemini
      let reponse
      try {
        reponse = await appellerModele({
          model: process.env.GEMINI_MODEL,
          contents,
          config: { 
            systemInstruction: SYSTEM_PROMPT ,
            tools : outils
          }
        }, { phone, session_id, type_appel: 'conversation' })
        // reponse = await ai.models.generateContent({
        //   model: process.env.GEMINI_MODEL,
        //   contents,
        //   config: { 
        //     systemInstruction: SYSTEM_PROMPT ,
        //     tools : outils
        //   }
        // })
      } catch (err) {
        log('ERROR', 'GEMINI', `Erreur appel Gemini tour ${tourBoucle}`, err.message)

        // Retry sur erreur 429 ou 503
        if (err.status === 429 || err.status === 503) {
          log('WARN', 'GEMINI', `Erreur temporaire ${err.status} — retry dans 2s`)
          await new Promise(r => setTimeout(r, 2000))
          continue
        }
        throw err
      }

      const parts = reponse.candidates?.[0]?.content?.parts || []
      log('INFO', 'GEMINI', `Réponse reçue — ${parts.length} part(s)`)

      // Chercher un functionCall dans les parts
      const functionCalls = parts.filter(p => p.functionCall)

      if (functionCalls.length === 0) {
        // Pas de functionCall → réponse finale
        reponseTexte = reponse.text
        log('INFO', 'GEMINI', `Réponse finale obtenue — ${reponseTexte?.length} caractères`)
        break
      }

      // Il y a des functionCalls → on les exécute tous
      log('INFO', 'GEMINI', `${functionCalls.length} outil(s) demandé(s)`)

      // Sauvegarder le contenu complet du model (avec les functionCalls)
      contents.push({
        role: 'model',
        parts: reponse.candidates[0].content.parts
      })

      // Exécuter chaque outil et collecter les réponses
      const functionResponses = []

      for (const part of functionCalls) {
        const { name, args } = part.functionCall
        log('INFO', 'OUTIL', `Gemini demande outil [${name}]`, args)

        try {
          const resultat = await appelOutil(mcpClient, name, args, phone)
          functionResponses.push({
            functionResponse: {
              name,
              response: { result: JSON.stringify(resultat) }
            }
          })
          log('INFO', 'OUTIL', `Outil [${name}] exécuté avec succès`)
        } catch (err) {
          log('ERROR', 'OUTIL', `Échec outil [${name}]`, err.message)
          functionResponses.push({
            functionResponse: {
              name,
              response: { result: JSON.stringify({ error: err.message }) }
            }
          })
        }
      }

      // Ajouter toutes les réponses en un seul message user
      contents.push({
        role: 'user',
        parts: functionResponses
      })

      log('INFO', 'GEMINI', `Réponses outils ajoutées — retour à Gemini`)
    }

    if (!reponseTexte) {
      log('ERROR', 'AGENT', `Boucle terminée sans réponse après ${MAX_TOURS} tours`)
      reponseTexte = 'Désolé, je n\'ai pas pu traiter votre demande. Veuillez réessayer.'
    }

    // ── 7. Découpage + sauvegarde réponse agent (par élément) ──
    // ───────────── MODIFIÉ (étape suivante du plan) ─────────────
    // Chaque morceau (texte ou image) de la réponse devient sa
    // propre ligne historique_messages, sauvegardée AVANT l'envoi
    // (id_whatsapp encore inconnu), avec son id interne récupéré
    // pour permettre à worker.js de mettre à jour l'id_whatsapp
    // une fois l'envoi effectué.
    log('INFO', 'AGENT', `Découpage réponse agent pour ${phone}`)
    const elementsReponse = aplatirReponse(reponseTexte)
    const elementsASauvegarder = []

    for (const element of elementsReponse) {
      const contenuSauvegarde = element.type === 'text'
        ? element.content
        : `[image] ${element.legende || ''}`.trim()

      // ───────────── AJOUT (Flux B) ─────────────
      // La référence produit est déjà contenue dans original_file,
      // format "REF/nom_fichier.jpg" — on l'extrait ici, rien de plus.
      const referenceProduit = element.type === 'image' && element.original_file
        ? element.original_file.split('/')[0]
        : null
      // ───────────── FIN AJOUT ─────────────

      const saveModel = await appelOutil(mcpClient, 'sauvegarderMessage', {
        phone,
        session_id,
        role: 'model',
        content: contenuSauvegarde,
        type: element.type,
        reference_fichier: element.type === 'image' ? element.original_file : null,
        reference_produit: referenceProduit
      }, phone)

      elementsASauvegarder.push({ ...element, id_interne: saveModel.id })
    }

    log('INFO', 'AGENT', `${elementsASauvegarder.length} élément(s) sauvegardé(s) pour ${phone}`)

    // ── 8. Vérification seuil résumé ──────────────────────────
    // (toujours commenté — inchangé, sera rebranché à l'étape jobs_resume)

    return { elements: elementsASauvegarder }
    // ───────────── FIN MODIFIÉ ─────────────



  } catch (err) {
    log('ERROR', 'AGENT', `=== Erreur fatale pour ${phone} ===`, err.message)
    log('ERROR', 'AGENT', `Stack trace`, err.stack)
    // return {
    //   texte: 'Désolé, une erreur est survenue. Veuillez réessayer dans quelques instants.'
    // }
    return {
      elements: [{ type: 'text', content: 'Désolé, une erreur est survenue. Veuillez réessayer dans quelques instants.', id_interne: null }]
    }
  } finally {
    // ── 9. Fermeture MCP ──────────────────────────────────────
    if (mcpClient) {
      try {
        await mcpClient.close()
        log('INFO', 'MCP', `Connexion MCP fermée pour ${phone}`)
      } catch (err) {
        log('WARN', 'MCP', `Fermeture MCP échouée — ignoré`, err.message)
      }
    }
  }
}
