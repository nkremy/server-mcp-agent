// ─────────────────────────────────────────────────────────────
// SERVEUR MCP — agent-whatsapp-dolibarr
// SDK : @modelcontextprotocol/sdk v1.29.0
// Transport : stdio (client spawn le serveur comme subprocess)
// RÈGLE CRITIQUE : jamais console.log() ici → corrompt le protocole
//                  utiliser console.error() uniquement pour les logs
// ─────────────────────────────────────────────────────────────
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import 'dotenv/config'

// Import des outils métier
import {
  getProfilClient,
  sauvegarderProfil,
  getHistorique,
  sauvegarderMessage,
  resumerHistorique,
  getOuCreerSessionActive // ───── AJOUT (étape 3a) ─────
} from './outils-supabase.js'

import {
  listerProduits,
  chercherProduit,
  consulterStock,
  getImagesProduit,
  telechargerImage,
  chercherClientParId,
  chercherClientParTelephone,
  creerClient,
  creerCommande
} from './outils-dolibarr.js'

// ─────────────────────────────────────────────────────────────
// Initialisation du serveur MCP
// name   : identifiant du serveur (visible par le client)
// version: version sémantique
// ─────────────────────────────────────────────────────────────
const server = new McpServer({
  name: 'agent-whatsapp-dolibarr',
  version: '1.0.0'
})

// ══════════════════════════════════════════════════════════════
// BLOC 1 — OUTILS MÉMOIRE (Supabase)
// ══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// Outil : getProfilClient
// Quand l'utiliser : premier appel à chaque message entrant
//                    pour charger le contexte du client
// Paramètres : phone — numéro WhatsApp format international
// Retourne : { found, profil? } avec dolibarr_id, resume, nb_messages
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'getProfilClient',
  {
    title: 'Obtenir le profil client',
    description: `Cherche le profil conversationnel d'un client WhatsApp dans Supabase.
    Utiliser en PREMIER à chaque message entrant pour charger le contexte.
    Paramètres : phone (string) — numéro WhatsApp ex: 243812345678(tu utilise le numero exactement comme tu la recu as de modification).
    Retourne : { found: boolean, profil?: { phone, nom, dolibarr_id, preferences, resume, nb_messages } }`,
    inputSchema: {
      phone: z.string().describe('Numéro WhatsApp format international ex: 243812345678 ')
    }
  },
  async ({ phone }) => {
    const resultat = await getProfilClient({ phone })
    return {
      content: [{ type: 'text', text: JSON.stringify(resultat) }]
    }
  }
)

// ─────────────────────────────────────────────────────────────
// Outil : sauvegarderProfil
// Quand l'utiliser : nouveau client (création) ou quand on apprend
//                    une info sur le client (mise à jour)
//                    ET après creerClient pour stocker le dolibarr_id
// Paramètres : phone (obligatoire), nom, dolibarr_id, preferences, resume (optionnels)
// Retourne : { success, action: 'created' | 'updated' }
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'sauvegarderProfil',
  {
    title: 'Sauvegarder le profil client',
    description: `Crée ou met à jour le profil conversationnel d'un client dans Supabase.
    Utiliser après avoir créé un client dans Dolibarr pour stocker son dolibarr_id.
    Utiliser aussi quand le client donne son nom ou une préférence.
    Paramètres : phone (obligatoire), nom (optionnels), dolibarr_id (optionnels), preferences (optionnels), resume (optionnels).
    Retourne : { success: boolean, action: 'created' | 'updated' }`,
    inputSchema: {
      phone: z.string().describe('Numéro WhatsApp'),
      nom: z.string().optional().describe('Nom du client'),
      dolibarr_id: z.number().optional().describe('ID du client dans Dolibarr'),
      preferences: z.string().optional().describe('Préférences ou notes sur le client'),
      resume: z.string().optional().describe('Résumé de la conversation')
    }
  },
  async ({ phone, nom, dolibarr_id, preferences, resume }) => {
    const resultat = await sauvegarderProfil({ phone, nom, dolibarr_id, preferences, resume })
    return {
      content: [{ type: 'text', text: JSON.stringify(resultat) }]
    }
  }
)

// ─────────────────────────────────────────────────────────────
// Outil : getHistorique
// Quand l'utiliser : avant d'appeler Gemini pour injecter
//                    les derniers messages dans le contexte
// Paramètres : phone (obligatoire), limit (optionnel, défaut 15)
// Retourne : { messages: [{role, content, type, timestamp}], total }
//            role = 'user' ou 'model'
// ─────────────────────────────────────────────────────────────
// server.registerTool(
//   'getHistorique',
//   {
//     title: 'Obtenir l\'historique des messages',
//     description: `Récupère les N derniers messages d'un client, triés du plus ancien au plus récent.
//     Utiliser pour construire le contexte à injecter dans Gemini.
//     Paramètres : phone (obligatoire), limit (optionnel, défaut 15).
//     Retourne : { messages: [{role, content, type, timestamp}], total: number }
//     Les rôles sont 'user' et 'model'.`,
//     inputSchema: {
//       phone: z.string().describe('Numéro WhatsApp'),
//       limit: z.number().optional().describe('Nombre de messages à récupérer, défaut 15')
//     }
//   },
//   async ({ phone, limit }) => {
//     const resultat = await getHistorique({ phone, limit })
//     return {
//       content: [{ type: 'text', text: JSON.stringify(resultat) }]
//     }
//   }
// )

server.registerTool(
  'getHistorique',
  {
    title: 'Obtenir l\'historique des messages',
    description: `Récupère les N derniers messages d'une session, triés du plus ancien au plus récent.
    Utiliser pour construire le contexte à injecter dans Gemini.
    Paramètres : session_id (obligatoire), limit (optionnel, défaut 15).
    Retourne : { messages: [{role, content, type, timestamp}], total: number }
    Les rôles sont 'user' et 'model'.`,
    inputSchema: {
      session_id: z.string().describe('Identifiant de la session'),
      limit: z.number().optional().describe('Nombre de messages à récupérer, défaut 15')
    }
  },
  async ({ session_id, limit }) => {
    const resultat = await getHistorique({ session_id, limit })
    return {
      content: [{ type: 'text', text: JSON.stringify(resultat) }]
    }
  }
)

// ─────────────────────────────────────────────────────────────
// Outil : sauvegarderMessage
// Quand l'utiliser : après chaque échange — sauvegarder le message
//                    du client ET la réponse de l'agent
// Paramètres : phone, role ('user' ou 'model'), content, type (optionnel)
// Retourne : { success, nb_messages }
//            Si nb_messages >= 32 → appeler resumerHistorique immédiatement
// ─────────────────────────────────────────────────────────────
// server.registerTool(
//   'sauvegarderMessage',
//   {
//     title: 'Sauvegarder un message',
//     description: `Sauvegarde un message dans l'historique Supabase et incrémente le compteur.
//     Appeler DEUX FOIS par échange : une fois pour le message client (role='user'),
//     une fois pour la réponse agent (role='model').
//     Si nb_messages retourné >= 32, appeler resumerHistorique immédiatement.
//     Paramètres : phone, role ('user' ou 'model'), content (texte), type ('text'|'audio'|'image').
//     Retourne : { success: boolean, nb_messages: number }`,
//     inputSchema: {
//       phone: z.string().describe('Numéro WhatsApp'),
//       role: z.enum(['user', 'model', 'assistant']).describe('Expéditeur : user ou model'),
//       content: z.string().describe('Contenu du message'),
//       type: z.enum(['text', 'audio', 'image']).optional().describe('Type de message, défaut text')
//     }
//   },
//   async ({ phone, role, content, type }) => {
//     const resultat = await sauvegarderMessage({ phone, role, content, type })
//     return {
//       content: [{ type: 'text', text: JSON.stringify(resultat) }]
//     }
//   }
// )

server.registerTool(
  'sauvegarderMessage',
  {
    title: 'Sauvegarder un message',
    description: `Sauvegarde un message dans l'historique Supabase (rattaché à une session) et incrémente le compteur de la session.
    Appeler DEUX FOIS par échange : une fois pour le message client (role='user'),
    une fois pour la réponse agent (role='model').
    Paramètres : phone, session_id, role ('user' ou 'model'), content (texte), type ('text'|'audio'|'image'),
    id_whatsapp (optionnel), repond_a_id_whatsapp (optionnel), reference_fichier (optionnel, null tant qu'aucun stockage n'est branché).
    Retourne : { success: boolean, nb_messages: number }`,
    inputSchema: {
      phone: z.string().describe('Numéro WhatsApp'),
      session_id: z.string().describe('Identifiant de la session'),
      role: z.enum(['user', 'model', 'assistant']).describe('Expéditeur : user ou model'),
      content: z.string().describe('Contenu du message'),
      type: z.enum(['text', 'audio', 'image']).optional().describe('Type de message, défaut text'),
      id_whatsapp: z.string().optional().describe('Id du message WhatsApp'),
      repond_a_id_whatsapp: z.string().optional().describe('Id du message WhatsApp auquel celui-ci répond'),
      reference_fichier: z.string().optional().describe('Référence vers le fichier stocké, null si aucun stockage encore branché')
    }
  },
  async ({ phone, session_id, role, content, type, id_whatsapp, repond_a_id_whatsapp, reference_fichier }) => {
    const resultat = await sauvegarderMessage({ phone, session_id, role, content, type, id_whatsapp, repond_a_id_whatsapp, reference_fichier })
    return {
      content: [{ type: 'text', text: JSON.stringify(resultat) }]
    }
  }
)

// ─────────────────────────────────────────────────────────────
// Outil : resumerHistorique
// Quand l'utiliser : quand sauvegarderMessage retourne nb_messages >= 32
//                    Résume les 15 plus anciens messages via Gemini,
//                    les supprime et sauvegarde le résumé dans le profil
// Paramètres : phone (obligatoire)
// Retourne : { success, resume }
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'resumerHistorique',
  {
    title: 'Résumer l\'historique',
    description: `Résume les 15 messages les plus anciens via Gemini et les supprime.
    Appeler UNIQUEMENT quand sauvegarderMessage retourne nb_messages >= 32.
    Le résumé est sauvegardé dans le profil client (champ resume).
    Paramètres : phone (obligatoire).
    Retourne : { success: boolean, resume: string }`,
    inputSchema: {
      phone: z.string().describe('Numéro WhatsApp')
    }
  },
  async ({ phone }) => {
    const resultat = await resumerHistorique({ phone })
    return {
      content: [{ type: 'text', text: JSON.stringify(resultat) }]
    }
  }
)

// ══════════════════════════════════════════════════════════════
// BLOC 2 — OUTILS DOLIBARR
// ══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// Outil : listerProduits
// Quand l'utiliser : client demande la liste des produits disponibles
// Paramètres : limit (optionnel, défaut 50)
// Retourne : { success, produits: [{id, ref, label, price_ttc, tva_tx}], total }
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'listerProduits',
  {
    title: 'Lister les produits',
    description: `Récupère la liste des produits disponibles dans Dolibarr.
    Utiliser quand le client demande ce qui est disponible ou veut voir le catalogue.
    Paramètres : limit (optionnel, défaut 50).
    Retourne : { success boolean (true si trouver et false sinon), produits: [{id, ref, label, description, price_ttc, tva_tx}], total }`,
    inputSchema: {
      limit: z.number().optional().describe('Nombre max de produits à retourner, défaut 50')
    }
  },
  async ({ limit }) => {
    const resultat = await listerProduits({ limit })
    return {
      content: [{ type: 'text', text: JSON.stringify(resultat) }]
    }
  }
)

// ─────────────────────────────────────────────────────────────
// Outil : chercherProduit
// Quand l'utiliser : client mentionne un produit précis ou envoie une image
//                    Tenter MINIMUM 3 termes différents avant de conclure absent
// Paramètres : termes — tableau de termes à tester
// Retourne : { found, produits? }
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'chercherProduit',
  {
    title: 'Chercher un produit',
    description: `Cherche un produit dans Dolibarr par nom ou référence.
    Utiliser quand le client demande un produit spécifique ou envoie une image d'un produit.
    IMPORTANT : toujours essayer au moins 3 termes différents (catégorie générique, marque, description).
    Ne jamais conclure qu'un produit est absent après un seul terme.
    Paramètres : termes (string[]) — ex: ['cuisinière', '4 feux', 'ICS4'].
    Retourne : { found: boolean (true si trouver et false sinon), produits?: [{id, ref, label, price_ttc}] }`,
    inputSchema: {
      termes: z.array(z.string()).describe('Liste de termes à rechercher, minimum 3')
    }
  },
  async ({ termes }) => {
    const resultat = await chercherProduit({ termes })
    return {
      content: [{ type: 'text', text: JSON.stringify(resultat) }]
    }
  }
)

// ─────────────────────────────────────────────────────────────
// Outil : consulterStock
// Quand l'utiliser : client demande si un produit est disponible
//                    ou en quelle quantité
// Paramètres : id — id Dolibarr du produit (obtenu via chercherProduit)
// Retourne : { success, stock_reel, stock_theorique }
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'consulterStock',
  {
    title: 'Consulter le stock',
    description: `Vérifie le stock réel d'un produit dans Dolibarr.
    Utiliser après chercherProduit pour vérifier la disponibilité.
    Paramètres : id (number) — id Dolibarr du produit.
    Retourne : { success boolean (true si trouver et false sinon), stock_reel: number, stock_theorique: number }`,
    inputSchema: {
      id: z.number().describe('ID Dolibarr du produit')
    }
  },
  async ({ id }) => {
    const resultat = await consulterStock({ id })
    return {
      content: [{ type: 'text', text: JSON.stringify(resultat) }]
    }
  }
)

// ─────────────────────────────────────────────────────────────
// Outil : getImagesProduit
// Quand l'utiliser : client demande à voir les photos d'un produit
// Paramètres : ref — référence Dolibarr du produit ex: "PROD001"
// Retourne : { success boolean (true si trouver et false sinon), images: [{filename, original_file, content_type}] }
//            original_file est le chemin à passer à telechargerImage
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'getImagesProduit',
  {
    title: 'Obtenir les images d\'un produit',
    description: `Récupère la liste des images disponibles pour un produit dans Dolibarr.
    Utiliser quand le client demande à voir le produit.
    Après cet outil, utiliser telechargerImage pour obtenir le base64 de chaque image.
    Paramètres : ref (string) — référence du produit ex: 'PROD001'.
    Retourne : { success, images: [{filename, original_file, content_type}] }`,
    inputSchema: {
      ref: z.string().describe('Référence Dolibarr du produit ex: PROD001')
    }
  },
  async ({ ref }) => {
    const resultat = await getImagesProduit({ ref })
    return {
      content: [{ type: 'text', text: JSON.stringify(resultat) }]
    }
  }
)

// ─────────────────────────────────────────────────────────────
// Outil : telechargerImage
// Quand l'utiliser : après getImagesProduit pour récupérer le contenu
//                    base64 d'une image avant de l'envoyer sur WhatsApp
// Paramètres : original_file — ex: "PROD001/cuisiniere.jpg"
// Retourne : { success, filename, content_type, content (base64), filesize }
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'telechargerImage',
  {
    title: 'Télécharger une image produit',
    description: `Télécharge le contenu base64 d'une image depuis Dolibarr.
    Utiliser après getImagesProduit pour récupérer l'image à envoyer sur WhatsApp.
    Paramètres : original_file (string) — ex: 'PROD001/cuisiniere.jpg' : ref/nom_image.extension.
    Retourne : { success, filename, content_type, content (base64), filesize }`,
    inputSchema: {
      original_file: z.string().describe('Chemin relatif de l\'image ex: PROD001/image.jpg')
    }
  },
  async ({ original_file }) => {
    const resultat = await telechargerImage({ original_file })
    return {
      content: [{ type: 'text', text: JSON.stringify(resultat) }]
    }
  }
)

// // ─────────────────────────────────────────────────────────────
// // Outil : chercherClientDolibarr
// // Quand l'utiliser : avant de créer une commande, pour vérifier si le client
// //                    existe déjà dans Dolibarr et récupérer son dolibarr_id
// // Paramètres : phone — numéro WhatsApp du client
// // Retourne : { found, client?: { id, name, code_client } }
// // ─────────────────────────────────────────────────────────────
// // par necessaire
// server.registerTool(
//   'chercherClientDolibarr',
//   {
//     title: 'Chercher un client dans Dolibarr',
//     description: `Vérifie si un client existe dans Dolibarr par son numéro de téléphone.
//     Utiliser AVANT creerCommande pour récupérer le dolibarr_id(identifiant du client dans Dolibarr).
//     Si le profil Supabase contient déjà un dolibarr_id, cet outil n'est pas nécessaire.
//     Paramètres : phone (string) — numéro WhatsApp.
//     Retourne : { found: boolean, client?: { id, name, code_client } }`,
//     inputSchema: {
//       phone: z.string().describe('Numéro WhatsApp du client')
//     }
//   },
//   async ({ phone }) => {
//     const resultat = await chercherClientDolibarr({ phone })
//     return {
//       content: [{ type: 'text', text: JSON.stringify(resultat) }]
//     }
//   }
// )

server.registerTool(
  'chercherClientParId',
  {
    title: 'Chercher un client Dolibarr par ID',
    description: `Vérifie si un client existe dans Dolibarr via son ID.
    Source PRIMAIRE — utiliser en priorité si le profil Supabase contient un dolibarr_id.
    Paramètres : dolibarr_id (number) — ID Dolibarr du client.
    Retourne : { found: boolean, client?: { id, name, code_client } }`,
    inputSchema: {
      dolibarr_id: z.number().describe('ID Dolibarr du client')
    }
  },
  async ({ dolibarr_id }) => {
    const resultat = await chercherClientParId({ dolibarr_id })
    return {
      content: [{ type: 'text', text: JSON.stringify(resultat) }]
    }
  }
)

server.registerTool(
  'chercherClientParTelephone',
  {
    title: 'Chercher un client Dolibarr par téléphone',
    description: `Cherche un client dans Dolibarr par son numéro de téléphone.
    Source SECONDAIRE — utiliser UNIQUEMENT si le profil Supabase n'a pas encore de dolibarr_id.
    Si trouvé, sauvegarder immédiatement le dolibarr_id dans Supabase avec sauvegarderProfil.
    Paramètres : phone (string) — numéro WhatsApp ex: +243812345678.
    Retourne : { found: boolean, client?: { id, name, code_client } }`,
    inputSchema: {
      phone: z.string().describe('Numéro WhatsApp du client')
    }
  },
  async ({ phone }) => {
    const resultat = await chercherClientParTelephone({ phone })
    return {
      content: [{ type: 'text', text: JSON.stringify(resultat) }]
    }
  }
)

// ─────────────────────────────────────────────────────────────
// Outil : creerClient
// Quand l'utiliser : quand chercherClientDolibarr retourne found=false
//                    Créer le client dans Dolibarr puis sauvegarder
//                    le dolibarr_id retourné dans le profil Supabase
// Paramètres : name, phone (obligatoires), email (optionnel)
// Retourne : { success, dolibarr_id }
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'creerClient',
  {
    title: 'Créer un client dans Dolibarr',
    description: `Crée un nouveau client dans Dolibarr.
    Utiliser quand chercherClientDolibarr retourne { found: false }.
    IMPORTANT : après cet outil, appeler sauvegarderProfil avec le dolibarr_id retourné.
    Paramètres : name (obligatoire), phone (obligatoire), email (optionnel).
    Retourne : { success: boolean, dolibarr_id: number }`,
    inputSchema: {
      name: z.string().describe('Nom complet du client'),
      phone: z.string().describe('Numéro WhatsApp — sert de clé de liaison'),
      email: z.string().optional().describe('Email du client')
    }
  },
  async ({ name, phone, email }) => {
    const resultat = await creerClient({ name, phone, email })
    return {
      content: [{ type: 'text', text: JSON.stringify(resultat) }]
    }
  }
)

// ─────────────────────────────────────────────────────────────
// Outil : creerCommande
// Quand l'utiliser : client confirme une commande
//                    Le client DOIT avoir un dolibarr_id avant
//                    La commande est créée en état Brouillon
// Paramètres : dolibarr_id, lignes (tableau de produits)
// Retourne : { success, commande_id }
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'creerCommande',
  {
    title: 'Créer une commande dans Dolibarr',
    description: `Crée une commande pour un client existant dans Dolibarr.
    Le client DOIT avoir un dolibarr_id (obtenu via creerClient ou chercherClientDolibarr).
    La commande est créée en état Brouillon — validation manuelle dans Dolibarr.
    Paramètres : dolibarr_id (number), lignes (array) avec pour chaque ligne :
      { fk_product: number, qty: number, subprice: number }.
    Retourne : { success: boolean, commande_id: number }`,
    inputSchema: {
      dolibarr_id: z.number().describe('ID du client dans Dolibarr'),
      lignes: z.array(z.object({
        fk_product: z.number().describe('ID Dolibarr du produit'),
        qty: z.number().describe('Quantité commandée'),
        subprice: z.number().describe('Prix unitaire HT')
      })).describe('Lignes de la commande')
    }
  },
  async ({ dolibarr_id, lignes }) => {
    const resultat = await creerCommande({ dolibarr_id, lignes })
    return {
      content: [{ type: 'text', text: JSON.stringify(resultat) }]
    }
  }
)

// ───────────── AJOUT (étape 3a du plan) ─────────────
// Outil : getOuCreerSessionActive
// Quand l'utiliser : PAS ENCORE utilisé par l'agent — préparation
//                    pour l'étape 3b (branchement dans agent.js).
//                    Ne sera pas exposé à Gemini (usage interne uniquement,
//                    comme getHistorique/sauvegarderMessage/resumerHistorique).
// Paramètres : phone
// Retourne : { success, session_id?, creee?, erreur? }
// ─────────────────────────────────────────────────────────────
server.registerTool(
  'getOuCreerSessionActive',
  {
    title: 'Obtenir ou créer la session active',
    description: `Cherche la session 'active' du client dans Supabase, ou en crée une si aucune n'existe.
    Usage interne — appelé par le code, pas par le modèle.
    Paramètres : phone (string).
    Retourne : { success: boolean, session_id?: string, creee?: boolean, erreur?: string }`,
    inputSchema: {
      phone: z.string().describe('Numéro WhatsApp format international')
    }
  },
  async ({ phone }) => {
    const resultat = await getOuCreerSessionActive({ phone })
    return {
      content: [{ type: 'text', text: JSON.stringify(resultat) }]
    }
  }
)
// ───────────── FIN AJOUT ─────────────

// ══════════════════════════════════════════════════════════════
// DÉMARRAGE DU SERVEUR
// StdioServerTransport = communication via stdin/stdout
// Le client MCP spawne ce fichier comme subprocess
// ══════════════════════════════════════════════════════════════
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // console.error = seul moyen de logger sans corrompre le protocole stdio
  console.error('[MCP] Serveur agent-whatsapp-dolibarr démarré sur stdio')
}

main().catch(err => {
  console.error('[MCP] Erreur fatale au démarrage :', err)
  process.exit(1)
})
