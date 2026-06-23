import axios from 'axios'
import 'dotenv/config'

// Client axios configuré une seule fois
// Chaque appel envoie automatiquement la clé API Dolibarr dans le header
const dolibarr = axios.create({
  baseURL: `${process.env.DOLIBARR_URL}/api/index.php`,
  headers: {
    'DOLAPIKEY': process.env.DOLIBARR_API_KEY,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }
})

// ─────────────────────────────────────────────
// OUTIL 1 : listerProduits
// Rôle : récupère la liste des produits en vente
// Paramètres :
//   - limit (number, optionnel) : nombre max de produits à retourner, défaut 50
// Retourne : tableau de produits nettoyés { id, ref, label, description, price_ttc, tva_tx, status }
// ─────────────────────────────────────────────
export async function listerProduits({ limit = 50 } = {}) {
  try {
    const { data } = await dolibarr.get('/products', {
      params: {
        limit,
        sortfield: 't.label',
        sortorder: 'ASC',
        mode: 1 // 1 = produits uniquement, pas les services
      }
    })

    const produits = data.map(p => ({
      id: p.id,
      ref: p.ref,
      label: p.label,
      description: p.description || '',
      price_ttc: parseFloat(p.price_ttc),
      tva_tx: p.tva_tx,
      status: p.status
    }))

    return { success: true, produits, total: produits.length }
  } catch (err) {
    return { success: false, erreur: err.response?.data?.error?.message || err.message }
  }
}

// ─────────────────────────────────────────────
// OUTIL 2 : chercherProduit
// Rôle : cherche un produit par nom ou référence
//        Tente plusieurs termes pour éviter les faux négatifs
// Paramètres :
//   - termes (string[], obligatoire) : liste de termes à tester dans l'ordre
//            ex: ["cuisinière", "4 feux", "cuisiniere ICS"]
// Retourne : { found: true, produits: [...] } ou { found: false }
// ─────────────────────────────────────────────
export async function chercherProduit({ termes }) {
  try {
    const resultats = []

    for (const terme of termes) {
      // Dolibarr sqlfilters : syntaxe (champ:operateur:valeur)
      // like = contient (insensible à la casse côté Dolibarr)
      const filtrLabel = `(t.label:like:'%${terme}%')`
      const filtrRef   = `(t.ref:like:'%${terme}%')`

      // On cherche d'abord par label
      const { data: parLabel } = await dolibarr.get('/products', {
        params: { sqlfilters: filtrLabel, limit: 10, mode: 1 }
      })

      if (parLabel.length > 0) {
        for (const p of parLabel) {
          // Éviter les doublons si le même produit revient
          if (!resultats.find(r => r.id === p.id)) {
            resultats.push({
              id: p.id,
              ref: p.ref,
              label: p.label,
              description: p.description || '',
              price_ttc: parseFloat(p.price_ttc),
              tva_tx: p.tva_tx
            })
          }
        }
      }

      // Cherche aussi par référence
      const { data: parRef } = await dolibarr.get('/products', {
        params: { sqlfilters: filtrRef, limit: 10, mode: 1 }
      })

      if (parRef.length > 0) {
        for (const p of parRef) {
          if (!resultats.find(r => r.id === p.id)) {
            resultats.push({
              id: p.id,
              ref: p.ref,
              label: p.label,
              description: p.description || '',
              price_ttc: parseFloat(p.price_ttc),
              tva_tx: p.tva_tx
            })
          }
        }
      }
    }

    if (resultats.length === 0) return { found: false }
    return { found: true, produits: resultats }
  } catch (err) {
    return { success: false, erreur: err.response?.data?.error?.message || err.message }
  }
}

// ─────────────────────────────────────────────
// OUTIL 3 : consulterStock
// Rôle : récupère le stock réel d'un produit par son id Dolibarr
// Paramètres :
//   - id (number | string, obligatoire) : id Dolibarr du produit
// Retourne : { success: true, stock_reel: number, stock_theorique: number }
// ─────────────────────────────────────────────
export async function consulterStock({ id }) {
  try {
    const { data } = await dolibarr.get(`/products/${id}/stock`)

    return {
      success: true,
      id_produit:id,//ajouter de l'identifiand du produit que l'on recherche le stock ajouter pour eviter les confisions.Indispensable quand le LLM demande les stocks d'aumois 2 produits simultament 
      stock_reel: data.stock_reel ?? 0,
      stock_theorique: data.stock_theorique ?? 0
    }
  } catch (err) {
    return { success: false, erreur: err.response?.data?.error?.message || err.message }
  }
}

// ─────────────────────────────────────────────
// OUTIL 4 : getImagesProduit
// Rôle : récupère la liste des images d'un produit
//        Les images sont stockées comme fichiers joints dans Dolibarr
// Paramètres :
//   - ref (string, obligatoire) : référence du produit ex: "PROD001"
// Retourne : { success: true, images: [{ filename, original_file, content_type }] }
//            original_file = chemin à passer à telechargerImage
// ─────────────────────────────────────────────
export async function getImagesProduit({ ref }) {
  try {
    const { data } = await dolibarr.get('/documents', {
      params: {
        modulepart: 'product',
        ref,
        limit: 10
      }
    })

    // On filtre uniquement les fichiers image
    const images = data
      .filter(f => f['content-type']?.startsWith('image/'))
      .map(f => ({
        filename: f.filename,
        // original_file = ref/filename, format attendu par /documents/download
        original_file: `${ref}/${f.filename}`,
        content_type: f['content-type']
      }))

    return { success: true, images }
  } catch (err) {
    return { success: false, erreur: err.response?.data?.error?.message || err.message }
  }
}

// ─────────────────────────────────────────────
// OUTIL 5 : telechargerImage
// Rôle : télécharge une image depuis Dolibarr en base64
//        À utiliser après getImagesProduit pour obtenir le contenu réel
// Paramètres :
//   - original_file (string, obligatoire) : ex: "PROD001/cuisiniere.jpg"
// Retourne : { success: true, filename, content_type, content (base64), filesize }
// ─────────────────────────────────────────────
export async function telechargerImage({ original_file }) {
  try {
    const { data } = await dolibarr.get('/documents/download', {
      params: {
        modulepart: 'product',
        original_file
      }
    })

    return {
      success: true,
      filename: data.filename,
      content_type: data['content-type'],
      content: data.content,   // base64
      filesize: data.filesize,
      encoding: data.encoding  // "base64"
    }
  } catch (err) {
    return { success: false, erreur: err.response?.data?.error?.message || err.message }
  }
}

// // ─────────────────────────────────────────────
// // OUTIL 6 : chercherClientDolibarr
// // Rôle : cherche si un client existe déjà dans Dolibarr par son numéro de téléphone
// //        Utilisé pour récupérer le dolibarr_id avant de créer une commande
// // Paramètres :
// //   - phone (string, obligatoire) : numéro WhatsApp ex: "+243812345678"
// // Retourne : { found: true, client: { id, name, code_client } } ou { found: false }
// // ─────────────────────────────────────────────
// export async function chercherClientDolibarr({ phone }) {
//   try {
//     const { data } = await dolibarr.get('/thirdparties', {
//       params: {
//         sqlfilters: `(t.phone:like:'${phone}')`,
//         limit: 1,
//         mode: 1 // clients uniquement
//       }
//     })

//     if (!data || data.length === 0) return { found: false }

//     const c = data[0]
//     return {
//       found: true,
//       client: {
//         id: c.id,
//         name: c.name,
//         code_client: c.code_client
//       }
//     }
//   } catch (err) {
//     return { success: false, erreur: err.response?.data?.error?.message || err.message }
//   }
// }

// ─────────────────────────────────────────────────────────────
// OUTIL : chercherClientParId
// Rôle : récupère un client Dolibarr directement par son ID
//        Source primaire — fiable et immuable
// Paramètres :
//   - dolibarr_id (number, obligatoire) : ID Dolibarr du client
// Retourne : { found: true, client: { id, name, code_client } }
//            ou { found: false } si le client n'existe pas
// ─────────────────────────────────────────────────────────────
export async function chercherClientParId({ dolibarr_id }) {
  try {
    const { data } = await dolibarr.get(`/thirdparties/${dolibarr_id}`)
    return {
      found: true,
      client: {
        id: data.id,
        name: data.name,
        code_client: data.code_client
      }
    }
  } catch (err) {
    const status = err.response?.status
    if (status === 404) return { found: false }
    return { found: false, erreur: err.response?.data?.error?.message || err.message }
  }
}

// ─────────────────────────────────────────────────────────────
// OUTIL : chercherClientParTelephone
// Rôle : cherche un client Dolibarr par numéro de téléphone
//        Source secondaire — utilisé UNIQUEMENT si dolibarr_id
//        est absent du profil Supabase
//        Fragile : si le client change de numéro, ne trouve plus
// Paramètres :
//   - phone (string, obligatoire) : numéro WhatsApp ex: "+243812345678"
// Retourne : { found: true, client: { id, name, code_client } }
//            ou { found: false }
// ─────────────────────────────────────────────────────────────
export async function chercherClientParTelephone({ phone }) {
  try {
    const { data } = await dolibarr.get('/thirdparties', {
      params: {
        sqlfilters: `(t.phone:like:'${phone}')`,
        limit: 1,
        mode: 1
      }
    })

    if (!data || data.length === 0) return { found: false }

    const c = data[0]
    return {
      found: true,
      client: {
        id: c.id,
        name: c.name,
        code_client: c.code_client
      }
    }
  } catch (err) {
    const status = err.response?.status
    if (status === 404) return { found: false }
    return { found: false, erreur: err.response?.data?.error?.message || err.message }
  }
}

// ─────────────────────────────────────────────
// OUTIL 7 : creerClient
// Rôle : crée un nouveau client dans Dolibarr
//        Appelé quand chercherClientDolibarr retourne { found: false }
// Paramètres :
//   - name (string, obligatoire) : nom du client
//   - phone (string, obligatoire) : numéro WhatsApp — sert de clé de liaison
//   - email (string, optionnel)
// Retourne : { success: true, dolibarr_id: number } — l'id à stocker dans Supabase
// ─────────────────────────────────────────────
export async function creerClient({ name, phone, email }) {
  try {
    const body = {
      name,
      phone,
      client: 1,   // 1 = c'est un client
      status: 1    // 1 = actif
    }

    if (email) body.email = email

    // POST /thirdparties retourne directement l'id (un entier)
    const { data: dolibarr_id } = await dolibarr.post('/thirdparties', body)

    return { success: true, dolibarr_id: parseInt(dolibarr_id) }
  } catch (err) {
    return { success: false, erreur: err.response?.data?.error?.message || err.message }
  }
}

// ─────────────────────────────────────────────
// OUTIL 8 : creerCommande
// Rôle : crée une commande dans Dolibarr pour un client existant
//        Le client DOIT exister dans Dolibarr (avoir un dolibarr_id)
//        La commande est créée en état "Brouillon"
// Paramètres :
//   - dolibarr_id (number, obligatoire) : id du client dans Dolibarr
//   - lignes (array, obligatoire) : liste des produits commandés
//     chaque ligne : { fk_product: number, qty: number, subprice: number }
//       - fk_product : id Dolibarr du produit
//       - qty        : quantité
//       - subprice   : prix unitaire HT
// Retourne : { success: true, commande_id: number }
// ─────────────────────────────────────────────
export async function creerCommande({ dolibarr_id, lignes }) {
  try {
    const body = {
      socid: dolibarr_id,
      // Date actuelle en timestamp Unix (secondes)
      date: Math.floor(Date.now() / 1000),
      lines: lignes.map(l => ({
        fk_product: l.fk_product,
        qty: l.qty,
        subprice: l.subprice
      }))
    }

    // POST /orders retourne directement l'id de la commande (entier)
    const { data: commande_id } = await dolibarr.post('/orders', body)

    return { success: true, commande_id: parseInt(commande_id) }
  } catch (err) {
    return { success: false, erreur: err.response?.data?.error?.message || err.message }
  }
}