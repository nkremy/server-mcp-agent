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
import { GoogleGenAI } from '@google/genai'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'url'
import path from 'path'
import 'dotenv/config'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

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
let SYSTEM_PROMPT = `Tu es un assistant commercial WhatsApp pour une boutique.
Tu aides les clients à découvrir les produits, vérifier les stocks et passer des commandes.

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

  const prefixes = {
    image: '[image]',
    audio: '[audio]'
  }
  const prefix = prefixes[message.type] || ''
  const texte  = message.texte ? ` ${message.texte}` : ''

  // Priorité type : image > audio > text
  return {
    content: `${prefix}${texte}`.trim(),
    type: message.type || 'text'
  }
}

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
export async function traiterMessage({ phone, message , defaultName}) {
  log('INFO', 'AGENT', `=== Début traitement message pour ${phone} ===`)

  let mcpClient = null

  try {
    // ── 1. Connexion MCP ──────────────────────────────────────
    mcpClient = await creerClientMCP(phone)

    //--- CHARGEMET DES OUTILS -----------------------------------
    let {tools}  = await mcpClient.listTools();
    let utils = tools.filter(item=> !['getHistorique','sauvegarderMessage','resumerHistorique'].includes(item.name));
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

    // ####
    //-- Ajouter des informations indispensable dans le systeme prompt (telephone,nom)
    SYSTEM_PROMPT +=`
        information important sur la conversation actuel : 
            telephone (phone) du client : ${phone}
            nom par defaut : ${defaultName} a utiliser quand une action necessite le nom du client mais que le nom n'est pas dans le profilclient (name=""ou null), 
                si lorsque tu utilise l'outil getProfilClient et tu recoi un name=""ou null met le profil ajouter avec le nom par defaut

    `

    // ── 3. Chargement historique ──────────────────────────────
    log('INFO', 'AGENT', `Chargement historique pour ${phone}`)
    const historiqueData = await appelOutil(
      mcpClient, 'getHistorique', { phone, limit: 15 }, phone
    )
    log('INFO', 'AGENT', `${historiqueData.total} messages dans l'historique`)

    // ── 4. Construction du contexte ───────────────────────────
    log('INFO', 'AGENT', `Construction du contexte pour ${phone}`)
    const contents = []

    // Résumé glissant si disponible
    if (profilData.found && profilData.profil?.resume) {
      log('INFO', 'AGENT', `Injection résumé glissant`)
      contents.push({
        role: 'user',
        parts: [{ text: `[Résumé des échanges précédents : ${profilData.profil.resume}]` }]
      })
      contents.push({
        role: 'model',
        parts: [{ text: 'Compris, je prends en compte ce contexte.' }]
      })
    }

    // Historique des 15 derniers messages
    for (const msg of historiqueData.messages) {
      // Reconstruction selon le type sauvegardé
      let parts
      if (msg.type === 'image') {
        parts = [{ text: `[Le client a envoyé une image : ${msg.content}]` }]
      } else if (msg.type === 'audio') {
        parts = [{ text: `[Le client a envoyé un audio : ${msg.content}]` }]
      } else {
        parts = [{ text: msg.content }]
      }
      contents.push({
        role: msg.role === 'user' ? 'user' : 'model',
        parts
      })
    }

    // Message actuel du client
    const contenuActuel = construireContenu(message)
    contents.push(contenuActuel)
    log('INFO', 'AGENT', `Contexte construit — ${contents.length} éléments au total`)

    // ── 5. Sauvegarde message client ──────────────────────────
    const { content: contenuSave, type: typeSave } = construireResume(message)
    log('INFO', 'AGENT', `Sauvegarde message client [${typeSave}] : ${contenuSave.substring(0, 60)}`)
    const saveUser = await appelOutil(mcpClient, 'sauvegarderMessage', {
      phone,
      role: 'user',
      content: contenuSave,
      type: typeSave
    }, phone)
    log('INFO', 'AGENT', `Message client sauvegardé — nb_messages: ${saveUser.nb_messages}`)

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
        reponse = await ai.models.generateContent({
          model: process.env.GEMINI_MODEL,
          contents,
          config: { 
            systemInstruction: SYSTEM_PROMPT ,
            tools : outils
          }
        })
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

    // ── 7. Sauvegarde réponse agent ───────────────────────────
    log('INFO', 'AGENT', `Sauvegarde réponse agent pour ${phone}`)
    const saveModel = await appelOutil(mcpClient, 'sauvegarderMessage', {
      phone,
      role: 'model',
      content: reponseTexte,
      type: 'text'
    }, phone)
    log('INFO', 'AGENT', `Réponse agent sauvegardée — nb_messages: ${saveModel.nb_messages}`)

    // ── 8. Vérification seuil résumé ──────────────────────────
    if (saveModel.nb_messages >= 32) {
      log('INFO', 'AGENT', `Seuil résumé atteint (${saveModel.nb_messages}) — déclenchement résumé`)
      try {
        const resume = await appelOutil(mcpClient, 'resumerHistorique', { phone }, phone)
        log('INFO', 'AGENT', `Résumé généré avec succès`, { apercu: resume.resume?.substring(0, 80) })
      } catch (err) {
        log('ERROR', 'AGENT', `Échec résumé — non bloquant`, err.message)
      }
    }

    log('INFO', 'AGENT', `=== Fin traitement pour ${phone} — succès ===`)
    return { texte: reponseTexte }

  } catch (err) {
    log('ERROR', 'AGENT', `=== Erreur fatale pour ${phone} ===`, err.message)
    log('ERROR', 'AGENT', `Stack trace`, err.stack)
    return {
      texte: 'Désolé, une erreur est survenue. Veuillez réessayer dans quelques instants.'
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
