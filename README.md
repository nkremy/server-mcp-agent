# Server MCP Agent — WhatsApp + Dolibarr

## 📝 Description générale

**Server MCP Agent** est un agent IA commercial intelligent pour WhatsApp, conçu pour automatiser la gestion des ventes et du service client pour **Tesla Kamer**. 

L'agent reçoit les messages WhatsApp des clients, utilise le modèle Gemini (IA de Google) pour comprendre leurs demandes et interagit avec **Dolibarr** (votre ERP) pour :
- Consulter le catalogue produits
- Vérifier les stocks
- Créer des clients
- Créer des commandes

Le tout en conversant naturellement en français avec les clients.

---

## 🎯 Objectif principal

Fournir une assistance commerciale 24/7 sur WhatsApp en automatisant :
- La recherche de produits
- La consultation des stocks
- La gestion des profils clients
- La création de commandes
- L'historique des conversations

L'agent reste un **vendeur intelligent** : il suggère des produits, maintient le contexte de la conversation et guide le client vers l'achat.

---

## 🛠️ Technologies utilisées

| Technologie | Version | Rôle |
|---|---|---|
| **Node.js** | ES Modules | Runtime JavaScript moderne |
| **Express** | 5.2.1 | Serveur webhook pour recevoir les messages WhatsApp |
| **Google Gemini** | @google/genai 2.9.0 | IA conversationnelle pour traiter les messages |
| **Model Context Protocol (MCP)** | @modelcontextprotocol/sdk 1.29.0 | Interface standardisée pour les outils IA |
| **Supabase** | @supabase/supabase-js 2.108.2 | Base de données pour profils et historique |
| **BullMQ** | 5.79.0 | Queue Redis pour traiter les messages en asynchrone |
| **Axios** | 1.18.0 | Requêtes HTTP vers l'API Dolibarr |
| **dotenv** | 17.4.2 | Gestion des variables d'environnement |

---

## 🚀 Fonctionnalités principales

### 1. **Réception des messages WhatsApp**
- Webhook sécurisé intégré à Meta Cloud API
- Support du texte, images et audio
- Vérification de signature pour la sécurité

### 2. **Traitement intelligent des messages**
- Boucle d'agent Gemini + MCP
- Appel d'outils (fonctions) pour interagir avec Dolibarr et Supabase
- Gestion du contexte avec résumés glissants

### 3. **Gestion des profils clients**
- Création automatique de profils Supabase
- Liaison avec Dolibarr (dolibarr_id)
- Historique des 15 derniers messages par client
- Résumé glissant après 32 messages

### 4. **Catalogue produits**
- Listing des produits Dolibarr
- Recherche multi-termes (minimum 3 termes)
- Consultation du stock réel
- Affichage des images produits

### 5. **Gestion des commandes**
- Création de clients dans Dolibarr (si absent)
- Création de commandes en état Brouillon
- Confirmation client avant finalisation
- Validation manuelle dans Dolibarr

### 6. **Communication naturelle**
- Réponses TEXT (texte pur) ou MEDIA (texte + images)
- Format JSON structuré pour les réponses avec images
- Pas de markdown — texte naturel comme un humain

---

## 📦 Dépendances

```json
{
  "@google/genai": "^2.9.0",
  "@modelcontextprotocol/sdk": "^1.29.0",
  "@supabase/supabase-js": "^2.108.2",
  "axios": "^1.18.0",
  "bullmq": "^5.79.0",
  "dotenv": "^17.4.2",
  "express": "^5.2.1"
}
