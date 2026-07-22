# Déploiement Railway — Image tout-en-un

## Architecture finale (2 services au lieu de 5)

```
Service 1 : server-mcp-agent (cette image)
  ├── Redis          (interne, localhost:6379)
  ├── webhook.js     (port 3000 → URL publique Railway)
  ├── worker.js      (processus background)
  └── scanner-resume.js (processus background)

Service 2 : gestionnaire-fichier (repo séparé, inchangé)
```

---

## Fichiers à ajouter à la racine de ton projet GitHub

- `Dockerfile`
- `start.sh`
- (le `Procfile` n'est plus nécessaire avec Docker, mais garde-le au cas où)

---

## Étapes sur Railway

### 1. Upgrade vers Hobby ($5/mois)
Le trial est expiré. Clique "Upgrade to Hobby" sur Railway.

### 2. Supprimer les anciens services inutiles
Supprime ces services devenus inutiles :
- `Redis` (maintenant interne à l'image)
- `worker` (maintenant interne à l'image)
- `server-mcp-agent` (scanner, maintenant interne)

Garde uniquement :
- `web` (renommé ou reconfiguré pour utiliser Docker)
- `gestionnaire-fichier` (inchangé)

### 3. Configurer le service principal pour Docker
Dans le service `web` sur Railway :
- Railway détecte automatiquement le `Dockerfile` à la racine
- Assure-toi que le port exposé est bien **3000**

### 4. Variables d'environnement du service principal
Copie TOUTES ces variables (une seule fois, pour le service tout-en-un) :

```
SUPABASE_URL=
SUPABASE_SECRET_KEY=
DOLIBARR_URL=
DOLIBARR_API_KEY=
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.0-flash
WHATSAPP_TOKEN=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_APP_SECRET=
SESSION_SEUIL_INACTIVITE_MS=60000
SESSION_SCAN_INTERVALLE_MS=10000
GESTIONNAIRE_FICHIER_URL=https://gestionnaire-fichier-production.up.railway.app
```

⚠️ NE PAS mettre REDIS_URL ni REDIS_HOST — le start.sh les force en localhost automatiquement.

---

## Ce qui change dans ton code

**Rien.** Ton code existant fonctionne sans modification.

Le `worker.js` détecte déjà `REDIS_URL` en priorité :
```js
const connexionRedis = process.env.REDIS_URL
  ? { connection: { url: process.env.REDIS_URL } }
  : { connection: { host: process.env.REDIS_HOST || 'localhost', port: 6379 } }
```

Le `start.sh` injecte `REDIS_URL=redis://localhost:6379` avant de démarrer les processus,
donc ton worker trouvera Redis sans aucune modification.

---

## En local (développement)

Rien ne change. Tu continues d'utiliser :
```bash
npm start      # webhook
npm run worker # worker
node src/scanner-resume.js # scanner
```
Avec ton Redis local sur REDIS_HOST + REDIS_PORT comme avant.
