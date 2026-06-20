// ─────────────────────────────────────────────────────────────
// TEST SERVEUR MCP — test progressif outil par outil
// Version 2 — prend en compte :
//   - chercherClientParId (source primaire)
//   - chercherClientParTelephone (source secondaire)
//   - suppression de chercherClientDolibarr
//
// Ordre des tests :
//   1.  getProfilClient        — profil inexistant
//   2.  sauvegarderProfil      — création profil
//   3.  getProfilClient        — profil trouvé
//   4.  sauvegarderMessage     — message user
//   5.  sauvegarderMessage     — message model
//   6.  getHistorique          — lecture historique
//   7.  listerProduits         — liste Dolibarr
//   8.  chercherProduit        — recherche multi-termes
//   9.  consulterStock         — stock produit
//   10. getImagesProduit       — images produit
//   11. telechargerImage       — base64 image
//   12. chercherClientParTelephone — client inexistant
//   13. creerClient            — création client Dolibarr
//   14. chercherClientParId    — vérification par ID
//   15. sauvegarderProfil      — mise à jour dolibarr_id
//   16. creerCommande          — commande complète
//   17. resumerHistorique      — résumé forcé
// ─────────────────────────────────────────────────────────────
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'url'
import path from 'path'
import 'dotenv/config'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

// Numéro de test — différent du précédent pour repartir propre
const PHONE_TEST = '+243800000002'
const NOM_TEST   = 'Client Test MCP v2'

// ─────────────────────────────────────────────────────────────
// Utilitaires d'affichage
// ─────────────────────────────────────────────────────────────
const OK  = '✅'
const KO  = '❌'
const SEP = '─'.repeat(55)

function titre(num, nom) {
  console.log(`\n${SEP}`)
  console.log(`TEST ${num} — ${nom}`)
  console.log(SEP)
}

function afficher(label, data) {
  console.log(`${label} :`, JSON.stringify(data, null, 2))
}

// ─────────────────────────────────────────────────────────────
// appelOutil — appelle un outil MCP et parse la réponse JSON
// ─────────────────────────────────────────────────────────────
async function appelOutil(client, nom, args = {}) {
  const resultat = await client.callTool({ name: nom, arguments: args })
  return JSON.parse(resultat.content[0].text)
}

// ─────────────────────────────────────────────────────────────
// PROGRAMME PRINCIPAL
// ─────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🚀 Démarrage des tests du serveur MCP — v2')
  console.log(`📱 Numéro de test : ${PHONE_TEST}`)

  const cheminServeur = path.resolve(__dirname, 'serveur-mcp.js')
  const transport = new StdioClientTransport({
    command: 'node',
    args: [cheminServeur],
    env: { ...process.env }
  })

  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(transport)
  console.log(`\n${OK} Connexion au serveur MCP établie`)

  // Variables partagées entre les tests
  let dolibarr_id = null
  let produit_id  = null
  let produit_ref = null

  try {

    // // ═══════════════════════════════════════════════════════
    // // TEST 1 — getProfilClient (profil inexistant)
    // // Attendu : { found: false }
    // // ═══════════════════════════════════════════════════════
    // titre(1, 'getProfilClient — profil inexistant')
    // const t1 = await appelOutil(client, 'getProfilClient', { phone: PHONE_TEST })
    // afficher('Résultat', t1)
    // if (t1.found === false) {
    //   console.log(`${OK} Correct — profil inexistant confirmé`)
    // } else {
    //   console.log(`⚠️  Profil déjà existant — change PHONE_TEST dans le script`)
    // }

    // // ═══════════════════════════════════════════════════════
    // // TEST 2 — sauvegarderProfil (création)
    // // Attendu : { success: true, action: 'created' }
    // // ═══════════════════════════════════════════════════════
    // titre(2, 'sauvegarderProfil — création')
    // const t2 = await appelOutil(client, 'sauvegarderProfil', {
    //   phone: PHONE_TEST,
    //   nom: NOM_TEST,
    //   preferences: 'Client de test automatique v2'
    // })
    // afficher('Résultat', t2)
    // if (t2.success && t2.action === 'created') {
    //   console.log(`${OK} Profil créé avec succès`)
    // } else {
    //   throw new Error(`Échec création profil : ${JSON.stringify(t2)}`)
    // }

    // // ═══════════════════════════════════════════════════════
    // // TEST 3 — getProfilClient (profil trouvé)
    // // Attendu : { found: true, profil: { phone, nom, dolibarr_id: null, ... } }
    // // ═══════════════════════════════════════════════════════
    // titre(3, 'getProfilClient — profil trouvé')
    // const t3 = await appelOutil(client, 'getProfilClient', { phone: PHONE_TEST })
    // afficher('Résultat', t3)
    // if (t3.found && t3.profil?.nom === NOM_TEST) {
    //   console.log(`${OK} Profil récupéré — nom : ${t3.profil.nom}`)
    //   console.log(`    dolibarr_id : ${t3.profil.dolibarr_id} (null attendu à ce stade)`)
    // } else {
    //   throw new Error(`Profil non trouvé après création`)
    // }

    // // ═══════════════════════════════════════════════════════
    // // TEST 4 — sauvegarderMessage (message user)
    // // Attendu : { success: true, nb_messages: 1 }
    // // ═══════════════════════════════════════════════════════
    // titre(4, 'sauvegarderMessage — message user')
    // const t4 = await appelOutil(client, 'sauvegarderMessage', {
    //   phone: PHONE_TEST,
    //   role: 'user',
    //   content: 'Bonjour, vous avez des cuisinières ?',
    //   type: 'text'
    // })
    // afficher('Résultat', t4)
    // if (t4.success && t4.nb_messages === 1) {
    //   console.log(`${OK} Message user sauvegardé — total : ${t4.nb_messages}`)
    // } else {
    //   throw new Error(`Échec sauvegarde message user`)
    // }

    // // ═══════════════════════════════════════════════════════
    // // TEST 5 — sauvegarderMessage (message model)
    // // Attendu : { success: true, nb_messages: 2 }
    // // ═══════════════════════════════════════════════════════
    // titre(5, 'sauvegarderMessage — message model')
    // const t5 = await appelOutil(client, 'sauvegarderMessage', {
    //   phone: PHONE_TEST,
    //   role: 'model',
    //   content: 'Oui, nous avons la Cuisinière 4 feux ICS4 à 102 000 FCFA.',
    //   type: 'text'
    // })
    // afficher('Résultat', t5)
    // // if (t5.success && t5.nb_messages === 2) {
    // if (t5.success ) {
    //   console.log(`${OK} Message model sauvegardé — total : ${t5.nb_messages}`)
    // } else {
    //   throw new Error(`Échec sauvegarde message model`)
    // }

    // ═══════════════════════════════════════════════════════
    // TEST 6 — getHistorique
    // Attendu : { messages: [2 items], total: 2 }
    // Vérifier : ordre chronologique, rôles corrects
    // ═══════════════════════════════════════════════════════
    titre(6, 'getHistorique — lecture des messages')
    const t6 = await appelOutil(client, 'getHistorique', {
      phone: PHONE_TEST,
      limit: 15
    })
    afficher('Résultat', t6)
    if (t6.messages?.length === 2 &&
        t6.messages[0].role === 'user' &&
        t6.messages[1].role === 'model') {
      console.log(`${OK} Historique correct — ${t6.total} messages, ordre chronologique`)
    } else {
      throw new Error(`Historique incorrect`)
    }

    // // ═══════════════════════════════════════════════════════
    // // TEST 7 — listerProduits
    // // Attendu : { success: true, produits: [...], total: > 0 }
    // // On garde le premier produit pour les tests suivants
    // // ═══════════════════════════════════════════════════════
    // titre(7, 'listerProduits — catalogue Dolibarr')
    // const t7 = await appelOutil(client, 'listerProduits', { limit: 10 })
    // afficher('Résultat', t7)
    // if (t7.success && t7.produits?.length > 0) {
    //   produit_id  = parseInt(t7.produits[0].id)
    //   produit_ref = t7.produits[0].ref
    //   console.log(`${OK} ${t7.total} produits récupérés`)
    //   console.log(`    Produit retenu : ${t7.produits[0].label} (id=${produit_id}, ref=${produit_ref})`)
    // } else {
    //   throw new Error(`Aucun produit trouvé dans Dolibarr`)
    // }

    // // ═══════════════════════════════════════════════════════
    // // TEST 8 — chercherProduit (multi-termes)
    // // Attendu : { found: true, produits: [...] }
    // // ═══════════════════════════════════════════════════════
    // titre(8, 'chercherProduit — recherche multi-termes')
    // const t8 = await appelOutil(client, 'chercherProduit', {
    //   termes: ['cuisinière', 'cuisiniere', 'ICS4']
    // })
    // afficher('Résultat', t8)
    // if (t8.found && t8.produits?.length > 0) {
    //   console.log(`${OK} ${t8.produits.length} produit(s) trouvé(s)`)
    //   t8.produits.forEach(p => console.log(`    - ${p.label} (${p.ref})`))
    // } else {
    //   console.log(`⚠️  Aucun résultat — non bloquant, produits peut-être nommés différemment`)
    // }

    // // ═══════════════════════════════════════════════════════
    // // TEST 9 — consulterStock
    // // Attendu : { success: true, stock_reel: number }
    // // ═══════════════════════════════════════════════════════
    // titre(9, `consulterStock — produit id=${produit_id}`)
    // const t9 = await appelOutil(client, 'consulterStock', { id: produit_id })
    // afficher('Résultat', t9)
    // if (t9.success) {
    //   console.log(`${OK} Stock réel : ${t9.stock_reel} | Stock théorique : ${t9.stock_theorique}`)
    // } else {
    //   throw new Error(`Échec consultation stock`)
    // }

    // // ═══════════════════════════════════════════════════════
    // // TEST 10 — getImagesProduit
    // // Attendu : { success: true, images: [...] }
    // // ═══════════════════════════════════════════════════════
    // titre(10, `getImagesProduit — ref=${produit_ref}`)
    // const t10 = await appelOutil(client, 'getImagesProduit', { ref: produit_ref })
    // afficher('Résultat', t10)
    // if (t10.success) {
    //   console.log(`${OK} ${t10.images?.length || 0} image(s) trouvée(s)`)
    //   t10.images?.forEach(img => console.log(`    - ${img.filename}`))
    // } else {
    //   throw new Error(`Échec récupération images`)
    // }

    // // ═══════════════════════════════════════════════════════
    // // TEST 11 — telechargerImage
    // // Attendu : { success: true, content: base64, encoding: 'base64' }
    // // ═══════════════════════════════════════════════════════
    // titre(11, 'telechargerImage — première image')
    // if (t10.images?.length > 0) {
    //   const t11 = await appelOutil(client, 'telechargerImage', {
    //     original_file: t10.images[0].original_file
    //   })
    //   const apercu = {
    //     success: t11.success,
    //     filename: t11.filename,
    //     content_type: t11.content_type,
    //     filesize: t11.filesize,
    //     encoding: t11.encoding,
    //     content_apercu: t11.content?.substring(0, 30) + '...'
    //   }
    //   afficher('Résultat', apercu)
    //   if (t11.success && t11.content) {
    //     console.log(`${OK} Image téléchargée — ${t11.filesize} octets en base64`)
    //   } else {
    //     throw new Error(`Échec téléchargement image`)
    //   }
    // } else {
    //   console.log(`⚠️  Pas d'image disponible — test ignoré`)
    // }

    // // ═══════════════════════════════════════════════════════
    // // TEST 12 — chercherClientParTelephone (inexistant)
    // // Source secondaire — client pas encore dans Dolibarr
    // // Attendu : { found: false }
    // // ═══════════════════════════════════════════════════════
    // titre(12, 'chercherClientParTelephone — client inexistant')
    // const t12 = await appelOutil(client, 'chercherClientParTelephone', {
    //   phone: PHONE_TEST
    // })
    // afficher('Résultat', t12)
    // if (t12.found === false) {
    //   console.log(`${OK} Client inexistant dans Dolibarr — on va le créer`)
    // } else {
    //   // Client déjà existant — on récupère son ID et on skip la création
    //   dolibarr_id = parseInt(t12.client.id)
    //   console.log(`⚠️  Client déjà existant (id=${dolibarr_id}) — création ignorée`)
    // }

    // // ═══════════════════════════════════════════════════════
    // // TEST 13 — creerClient (si pas encore existant)
    // // Attendu : { success: true, dolibarr_id: number }
    // // ═══════════════════════════════════════════════════════
    // titre(13, 'creerClient — création dans Dolibarr')
    // if (!dolibarr_id) {
    //   const t13 = await appelOutil(client, 'creerClient', {
    //     name: NOM_TEST,
    //     phone: PHONE_TEST
    //   })
    //   afficher('Résultat', t13)
    //   if (t13.success && t13.dolibarr_id) {
    //     dolibarr_id = t13.dolibarr_id
    //     console.log(`${OK} Client créé — dolibarr_id : ${dolibarr_id}`)
    //   } else {
    //     throw new Error(`Échec création client : ${JSON.stringify(t13)}`)
    //   }
    // } else {
    //   console.log(`⚠️  Test ignoré — client déjà existant (id=${dolibarr_id})`)
    // }

    // // ═══════════════════════════════════════════════════════
    // // TEST 14 — chercherClientParId (source primaire)
    // // Vérification que le client créé est bien accessible par ID
    // // Attendu : { found: true, client: { id, name } }
    // // ═══════════════════════════════════════════════════════
    // titre(14, `chercherClientParId — id=${dolibarr_id}`)
    // const t14 = await appelOutil(client, 'chercherClientParId', {
    //   dolibarr_id
    // })
    // afficher('Résultat', t14)
    // if (t14.found && parseInt(t14.client.id) === dolibarr_id) {
    //   console.log(`${OK} Client trouvé par ID — nom : ${t14.client.name}`)
    // } else {
    //   throw new Error(`Client non trouvé par ID après création`)
    // }

    // // ═══════════════════════════════════════════════════════
    // // TEST 15 — sauvegarderProfil (mise à jour dolibarr_id)
    // // On lie maintenant le profil Supabase au client Dolibarr
    // // Attendu : { success: true, action: 'updated' }
    // // ═══════════════════════════════════════════════════════
    // titre(15, 'sauvegarderProfil — mise à jour dolibarr_id')
    // const t15 = await appelOutil(client, 'sauvegarderProfil', {
    //   phone: PHONE_TEST,
    //   dolibarr_id
    // })
    // afficher('Résultat', t15)
    // if (t15.success && t15.action === 'updated') {
    //   console.log(`${OK} Profil Supabase lié à Dolibarr — dolibarr_id=${dolibarr_id}`)
    // } else {
    //   throw new Error(`Échec mise à jour profil`)
    // }

    // // Vérification finale du profil — dolibarr_id doit être présent
    // const profilFinal = await appelOutil(client, 'getProfilClient', { phone: PHONE_TEST })
    // console.log(`    Vérification profil — dolibarr_id : ${profilFinal.profil?.dolibarr_id}`)
    // if (profilFinal.profil?.dolibarr_id === dolibarr_id) {
    //   console.log(`${OK} Lien Supabase ↔ Dolibarr confirmé`)
    // } else {
    //   throw new Error(`dolibarr_id non persisté dans Supabase`)
    // }

    // // ═══════════════════════════════════════════════════════
    // // TEST 16 — creerCommande
    // // Attendu : { success: true, commande_id: number }
    // // ═══════════════════════════════════════════════════════
    // titre(16, 'creerCommande — commande test')
    // const t16 = await appelOutil(client, 'creerCommande', {
    //   dolibarr_id,
    //   lignes: [
    //     {
    //       fk_product: produit_id,
    //       qty: 1,
    //       subprice: 85000
    //     }
    //   ]
    // })
    // afficher('Résultat', t16)
    // if (t16.success && t16.commande_id) {
    //   console.log(`${OK} Commande créée — commande_id : ${t16.commande_id}`)
    // } else {
    //   throw new Error(`Échec création commande : ${JSON.stringify(t16)}`)
    // }

    // // ═══════════════════════════════════════════════════════
    // // TEST 17 — resumerHistorique (test forcé)
    // // On ajoute des messages pour avoir un historique à résumer
    // // Attendu : { success: true, resume: string }
    // // ═══════════════════════════════════════════════════════
    // titre(17, 'resumerHistorique — test forcé')
    // console.log('    Ajout de messages de remplissage...')
    // for (let i = 3; i <= 7; i++) {
    //   await appelOutil(client, 'sauvegarderMessage', {
    //     phone: PHONE_TEST,
    //     role: i % 2 === 0 ? 'user' : 'model',
    //     content: `Message de remplissage numéro ${i} pour tester le résumé Gemini`,
    //     type: 'text'
    //   })
    // }
    // console.log(`    7 messages au total — appel resumerHistorique...`)

    // const t17 = await appelOutil(client, 'resumerHistorique', { phone: PHONE_TEST })
    // afficher('Résultat', {
    //   success: t17.success,
    //   resume_apercu: t17.resume?.substring(0, 120) + '...'
    // })
    // if (t17.success && t17.resume) {
    //   console.log(`${OK} Résumé généré par Gemini`)
    // } else {
    //   throw new Error(`Échec résumé : ${JSON.stringify(t17)}`)
    // }

  } catch (err) {
    console.error(`\n${KO} TEST ÉCHOUÉ :`, err.message)
  } finally {
    await client.close().catch(() => {})
    console.log(`\n${SEP}`)
    console.log('🏁 Tests terminés')
    console.log(SEP)
    process.exit(0)
  }
}

main()