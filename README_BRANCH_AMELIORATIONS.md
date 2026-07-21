# Server MCP Agent — Branche d'Améliorations 🚀

## 🎯 Branche: `agent-whatsapp-dolibarr-memoire-mesure-ameliorer`

Cette branche introduit **3 améliorations majeures** par rapport à la branche `main` :

1. **Gestion des réponses à des messages (Reply Threading)** 📌
2. **Restructuration de la mémoire par sessions** 🧠
3. **Mesure et suivi des tokens Gemini** 📊

---

## 📌 AMÉLIORATION #1 : Gestion des Réponses à des Messages (Reply Threading)

### Le Problème Résolu ❌ → ✅

**Avant** (main) : 
- L'agent recevait des messages isolés
- Quand un client répondait à un message précédent sur WhatsApp, le LLM **ne voyait pas** le lien
- Impossible de comprendre le contexte : "À quoi le client répond-il ?"
- Les conversations manquaient de cohérence

**Après** (cette branche) :
- Capture de `repond_a_id_whatsapp` au niveau webhook
- Transmission jusqu'à l'agent avec recherche du message ciblé en BDD
- **Injection du contexte de la réplique** directement dans le contexte Gemini
- Le LLM comprend exactement ce que le client reprend

### Flux Technique Détaillé

#### **Étape 1 : Capture au Webhook** (`webhook.js`)
```javascript
// Extraction du message de réponse WhatsApp (si présent)
jobData.repond_a_id_whatsapp = body.entry[0].changes[0].value.messages[0].reply_to?.id || null;
```
- Si `messages[0].reply_to` existe, on mémorise l'ID cible
- Sinon, `repond_a_id_whatsapp = null`

#### **Étape 2 : Transmission au Job** (`worker.js`)
```javascript
const { repond_a_id_whatsapp } = job.data;
const { elements } = await traiterMessage({ 
  phone, message, defaultName, id_message, repond_a_id_whatsapp 
});
```
- L'ID est transmis jusqu'à `agent.js`

#### **Étape 3 : Sauvegarde Précoce** (`agent.js`)
```javascript
const saveUser = await appelOutil(mcpClient, 'sauvegarderMessage', {
  phone, session_id, role: 'user',
  content: contenuSave, type: typeSave,
  id_whatsapp: id_message,
  repond_a_id_whatsapp,  // ← Le lien est mémorisé
  reference_fichier: referenceFichierClient
});
```
- Le message client est sauvegardé **AVANT** traitement Gemini (important pour les futures réponses)

#### **Étape 4 : Résolution Dynamique** (`agent.js`)
```javascript
// Dans la boucle d'historique
if (msg?.repond_a_id_whatsapp && msg?.repond_a_id_whatsapp?.trim()?.length !== 0) {
  // Chercher le message CIBLÉ via son id_whatsapp
  resolution = await appelOutil(mcpClient, 'resoudreMessageReplique', { 
    id_whatsapp: msg.repond_a_id_whatsapp 
  }, phone);

  if (resolution.found) {
    // Construire le contexte de la réplique
    let contenuReplique = await construireContenuReplique(
      resolution.message, mcpClient, phone, sessionsContexteLLM
    );
    // Injecter AU DÉBUT de l'historique du LLM
    parts.unshift(...contenuReplique.parts);
  }
}

contents.push({ role: msg.role === 'user' ? 'user' : 'model', parts });
```

### Fonction Clé : `construireContenuReplique()` 

Gère les **5 cas réels** d'une réplique :

| **Cas** | **Qui** | **Type** | **Contexte Injecté** |
|---------|--------|---------|---------------------|
| 1 | Client | Texte | `[Le client répond à son propre message : "..."]` |
| 2 | Client | Image | Réinjecte l'image + légende (via service de stockage) |
| 3 | Client | Audio | Transcription du message audio ciblé |
| 4 | Agent | Texte | `[Le client répond à votre message : "..."]` |
| 5 | Agent | Image | Contexte du produit (ref + prix + description) |

#### Exemple : Un client répond à une image de produit

```
HISTORIQUE AVANT :
Client : "Et le prix ?"

HISTORIQUE AVEC RESOLVE_MESSAGE_REPLIQUE :
[SESSION CONCERNE : 2026-07-21 10:00:00][Le client répond à l'image du produit CUISINIERE - Cuisinière ICS4, prix: 102000, description...]
Client : "Et le prix ?"

→ Le LLM VOIT le contexte et comprend la question
```

### Outils MCP Ajoutés

```javascript
// Récupère une ligne historique_messages par son id_whatsapp
resoudreMessageReplique({ id_whatsapp })
  → { found, message: {session_id, role, type, content, reference_fichier, reference_produit} }

// Récupère une session complète par son ID
getSessionParId({ session_id })
  → { found, debut_session, fin_session, resume, statut }

// Liste toutes les cibles de reply d'une session
getCiblesRepliesSession({ session_id })
  → { cibles: [...] }
```

---

## 🧠 AMÉLIORATION #2 : Restructuration de la Mémoire par Sessions

### Le Problème Résolu ❌ → ✅

**Avant** (main) :
- Historique linéaire par client : `phone → historique_messages`
- Aucune séparation par conversation
- Impossible de dire "c'était hier" vs "c'était la semaine dernière"
- Après 100 messages, tout se confond

**Après** (cette branche) :
- Historique **structuré par sessions**
- Chaque session = une "conversation" avec dates début/fin
- Résumés glissants de sessions terminées
- Contexte injecté : derniers résumés **+ détails de session actuelle**

### Architecture de la Base de Données

#### **Table `sessions`**
```
id (UUID)                 — Identifiant unique
phone (string)           — Numéro client
statut (string)          — 'active', 'terminee', 'en_cours_de_resume'
debut_session (timestamp) — Quand la conversation a commencé
fin_session (timestamp)  — Quand elle s'est terminée (NULL si active)
resume (text)            — Résumé généré par Gemini (NULL si en cours)
nb_messages (number)     — Compteur de messages
dernier_message_le       — Dernière activité
```

#### **Table `historique_messages`**
```
id (UUID)                    — Identifiant unique
session_id (UUID/FK)         — Lien vers la session
phone (string)               — Numéro client
role ('user' ou 'model')     — Qui a envoyé
type ('text'|'image'|'audio')
content (text)               — Contenu/légende
id_whatsapp (string)         — ID Meta du message
repond_a_id_whatsapp (string)— ID du message ciblé (si reply)
reference_fichier (string)   — Chemin de stockage (image/audio client)
reference_produit (string)   — Ref Dolibarr (image produit agent)
timestamp (timestamp)        — Quand ce message a été enregistré
```

### Flux Simplifié

```
Nouveau message WhatsApp
  ↓
1. Créer/trouver SESSION ACTIVE du client
  ↓
2. Sauvegarder le message → historique_messages avec session_id
  ↓
3. Charger CETTE SESSION (15 derniers messages)
  ↓
4. Charger N DERNIERS RÉSUMÉS de sessions précédentes
  ↓
5. Injecter au LLM : résumés précédents + messages de cette session
  ↓
6. LLM génère réponse (peut utiliser info des 2 sources)
  ↓
7. Sauvegarder réponse → historique_messages avec session_id
  ↓
8. Retourner éléments à envoyer
```

### Outils MCP Clés

```javascript
// Crée ou retrouve la session active du client
getOuCreerSessionActive({ phone })
  → { session_id, debut_session, creee }

// Charge N derniers résumés terminés d'un client
getDerniersResumesSessions({ phone, session_id_courante, nombre = 3 })
  → { sessions: [{session_id, debut_session, fin_session, resume}] }

// Change le statut d'une session ET génère son résumé
resumerHistorique({ session_id })
  → Passe session en 'terminee' + sauvegarde le résumé
```

### Bénéfices Visibles

✅ **Contexte plus riche** : Le LLM voit résumés récents + conversation actuelle  
✅ **Mémoire découplée** : Chaque conversation est indépendante  
✅ **Passage d'info** : Résumés glissants permettent au LLM de savoir "Vous aviez parlé de X en décembre"  
✅ **Scalabilité** : Un client avec 1000 messages sur 50 sessions vs un gros fichier unique  

---

## 📊 AMÉLIORATION #3 : Mesure et Suivi des Tokens Gemini

### Le Problème Résolu ❌ → ✅

**Avant** (main) :
- Aucune visibilité sur la consommation d'API
- Impossible de déboguer les coûts
- Pas de détail sur ce qui consomme le plus

**Après** (cette branche) :
- **Mesure complète des tokens** : input + output + cache
- **Par type d'appel** : conversation, transcription audio, résumé
- **Logs détaillés** : chaque appel Gemini est enregistré
- **Permet l'optimisation** : identifier ce qui coûte cher

### Fichier Nouveau : `src/mesure-tokens.js`

```javascript
import { GoogleGenAI } from '@google/genai'

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

export async function appellerModele(requestData, contexte = {}) {
  const { type_appel = 'conversation', phone = null, session_id = null } = contexte

  const debut = Date.now()
  
  try {
    // Appel Gemini standard
    const reponse = await ai.models.generateContent(requestData)
    const duree = Date.now() - debut

    // Récupération des tokens
    const input_tokens = reponse.usageMetadata?.promptTokenCount || 0
    const output_tokens = reponse.usageMetadata?.candidatesTokenCount || 0
    const cache_creation = reponse.usageMetadata?.cacheCreationInputTokenCount || 0
    const cache_read = reponse.usageMetadata?.cacheReadInputTokenCount || 0
    const total = input_tokens + output_tokens

    // Log détaillé
    console.error(`
[TOKENS] ${type_appel.toUpperCase()}
├─ Type: ${type_appel}
├─ Phone: ${phone || 'N/A'}
├─ Session: ${session_id || 'N/A'}
├─ Durée: ${duree}ms
├─ Input: ${input_tokens} (cache: ${cache_read}/${cache_creation})
├─ Output: ${output_tokens}
├─ Total: ${total}
└─ Coût estimé: $${(total * 0.000075).toFixed(4)} (tarif 1.5M tokens = $0.075)
    `)

    return reponse
  } catch (err) {
    console.error(`[TOKENS] ERREUR ${type_appel} après ${Date.now() - debut}ms`, err.message)
    throw err
  }
}
```

### Intégration dans `agent.js`

```javascript
// Avant : reponse = await ai.models.generateContent({...})
// Après :
reponse = await appellerModele({
  model: process.env.GEMINI_MODEL,
  contents,
  config: { systemInstruction: SYSTEM_PROMPT, tools: outils }
}, { phone, session_id, type_appel: 'conversation' })

// Et pour la transcription audio :
reponse = await appellerModele({
  model: process.env.GEMINI_MODEL,
  contents: [{...}]
}, { phone, session_id, type_appel: 'transcription_audio' })

// Et pour les résumés de session :
reponse = await appellerModele({
  model: process.env.GEMINI_MODEL,
  contents: [...]
}, { phone: null, session_id, type_appel: 'resume_session' })
```

### Output des Logs

```
[TOKENS] CONVERSATION
├─ Type: conversation
├─ Phone: 243812345678
├─ Session: d8f3e2c1-a0a1-4b5c-9e7f-1a2b3c4d5e6f
├─ Durée: 1243ms
├─ Input: 2456 (cache: 0/0)
├─ Output: 187
├─ Total: 2643
└─ Coût estimé: $0.1985

[TOKENS] TRANSCRIPTION_AUDIO
├─ Type: transcription_audio
├─ Phone: 243812345678
├─ Session: N/A
├─ Durée: 432ms
├─ Input: 654
├─ Output: 89
├─ Total: 743
└─ Coût estimé: $0.0557

[TOKENS] RESUME_SESSION
├─ Type: resume_session
├─ Phone: null
├─ Session: d8f3e2c1-a0a1-4b5c-9e7f-1a2b3c4d5e6f
├─ Durée: 3891ms
├─ Input: 12456 (cache: 2000/500)
├─ Output: 342
├─ Total: 12798
└─ Coût estimé: $0.9599
```

### Métriques Extraites

| Métrique | Valeur | Usage |
|----------|--------|-------|
| `promptTokenCount` | N | Tokens envoyés au LLM |
| `candidatesTokenCount` | N | Tokens générés par LLM |
| `cacheCreationInputTokenCount` | N | Cache écrit (premium) |
| `cacheReadInputTokenCount` | N | Cache lu (premium) |
| **Coût Estimé** | $0.000075 / 1000 tokens | Base tarif Gemini |

---

## 🔄 Comparaison : Main vs Amélioration

### Tableau Récapitulatif

| **Aspect** | **Main** | **Cette Branche** |
|-----------|---------|------------------|
| **Reply Threading** | ❌ Non géré | ✅ Complètement intégré |
| **Compréhension Contexte** | Basique (client isolé) | Riche (reply + sessions) |
| **Historique** | Linéaire (phone) | Structuré (sessions) |
| **Mémoire Limitée** | 15 derniers messages | 15 messages + 3 résumés précédents |
| **Résumés** | Après 32 messages | À la fin de chaque session |
| **Mesure Tokens** | ❌ Aucune | ✅ Complète + Détaillée |
| **Type d'Appels Mesurés** | - | Conversation, audio, résumé |
| **Sauvegarde Messages** | Après traitement | **Avant** traitement (important!) |
| **Format Réponse** | `{ texte }` | `{ elements: [{...}] }` |

---

## 📦 Dépendances Ajoutées

```json
{
  "ws": "^8.21.0"  // WebSocket (potentiellement utilisé pour streaming)
}
```

---

## 🚀 Comment Utiliser Cette Branche

### Installation
```bash
git checkout agent-whatsapp-dolibarr-memoire-mesure-ameliorer
npm install
```

### Configuration `.env` (inchangée)
```bash
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.0-flash
SUPABASE_URL=...
SUPABASE_KEY=...
# ... reste comme main
```

### Exécution
```bash
# Webhook (reçoit messages WhatsApp)
npm start

# Worker (traite les messages)
npm run worker

# Serveur MCP (fournit outils)
npm run serveur
```

---

## 📈 Flux Complet avec Améliorations

```
Message WhatsApp arrive (+ reply_to si applicable)
  ↓
[AMÉLIORATION 1] Capture repond_a_id_whatsapp au webhook
  ↓
BullMQ → Worker récupère job
  ↓
[AMÉLIORATION 1] Transmission repond_a_id_whatsapp à agent
  ↓
Agent exécute :
  ├─ [AMÉLIORATION 2] Crée/récupère session active
  ├─ [AMÉLIORATION 3] Appel getOuCreerSessionActive (token measuré)
  ├─ Sauvegarde message client + repond_a_id_whatsapp
  ├─ [AMÉLIORATION 2] Charge 15 derniers messages DE CETTE SESSION
  ├─ [AMÉLIORATION 2] Charge 3 derniers résumés de sessions précédentes
  ├─ [AMÉLIORATION 1] Pour chaque message avec reply → résout cible + injecte contexte
  ├─ [AMÉLIORATION 3] Appel Gemini (tokens mesurés + détail session)
  ├─ Traite fonction calls
  ├─ Génère réponse (texte/images)
  ├─ Découpe réponse en éléments
  ├─ Sauvegarde chaque élément avec reference_produit si image
  ├─ Retourne { elements: [...] }
  └─ [AMÉLIORATION 3] Log de consommation tokens
  ↓
Worker envoie éléments à WhatsApp
  ├─ Récupère id_whatsapp pour chaque envoi
  └─ Met à jour id_whatsapp en BDD
  ↓
✅ Réponse complète et contextualisée envoyée au client
```

---

## 🎯 Points d'Optimisation Futurs

1. **Caching Tokens** : Gemini supporte le caching au niveau système prompt
2. **Batch Processing** : Grouper plusieurs clients pour réduire coûts
3. **Resume Avancé** : Clôturer sessions manuellement via endpoint API
4. **Streaming Response** : Envoyer la réponse au fur et à mesure (WebSocket prêt)
5. **Dashboard Tokens** : UI pour visualiser consommation par client/jour

---

## 🧪 Fichiers Modifiés vs Main

```
src/
├── agent.js                    [MAJEUR] + 800 lignes (reply + session)
├── outils-supabase.js          [MAJEUR] + 150 lignes (sessions + resolve)
├── serveur-mcp.js              [MAJEUR] + 100 lignes (outils sessions)
├── worker.js                   [MOYEN] + 50 lignes (transport ID)
├── mesure-tokens.js            [NOUVEAU] 80 lignes
├── system_promt.js             [MOYEN] Séparé pour clarté
└── utils/utils.js              [MOYEN] Utilitaire markRead

package.json                    [MINEUR] + ws
```

---

## ✅ Checkpoints de Développement

Cette branche implémente un plan multi-étapes :

- [x] **Étape 1** : Capture du reply_to au webhook
- [x] **Étape 2** : Transport repond_a_id_whatsapp
- [x] **Étape 3a** : Créer `getOuCreerSessionActive`
- [x] **Étape 3b** : Brancher session dans agent.js
- [x] **Étape 3c** : Injection résumés glissants (`getDerniersResumesSessions`)
- [x] **Étape 3d** : Nettoyage contexte LLM
- [x] **Flux A** : Gestion transcription audio + rangement fichiers
- [x] **Flux B** : Extraction reference_produit d'images
- [x] **Flux C** : Résolution replies + injection contexte multi-session
- [ ] **Étape 4** : Branchement des jobs de résumé asynchrone (scanner)
- [ ] **Étape 5** : Dashboard monitoring tokens

---

## 📚 Documentation Supplémentaire

- **Gestion des Sessions** : Voir `outils-supabase.js` (fonctions débutant par `get*` ou `resume*`)
- **Construction du Contexte** : Voir `agent.js` lignes 500-620 (injection historique + résumés)
- **Résolution Reply** : Voir `agent.js` lignes 562-586 (résolution message ciblé)
- **Mesure Tokens** : Voir `mesure-tokens.js` (wrapper complet)

---

## 🎉 Conclusion

Cette branche apporte une **infrastructure conversationnelle robuste** :

✨ Les clients peuvent répondre à des messages spécifiques et le LLM comprend  
✨ Les conversations sont organisées en sessions cohérentes  
✨ La consommation d'API est entièrement traçable et optimisable  
✨ La mémoire est scalable et séparable par contexte  

**Prochaine étape** : Déployer en production avec monitoring actif des tokens ! 🚀
