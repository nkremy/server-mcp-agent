# ============================================================
# IMAGE TOUT-EN-UN
# Contient : webhook.js + worker.js + scanner-resume.js + Redis
# ============================================================
FROM node:20-alpine

# Installer Redis
RUN apk add --no-cache redis

WORKDIR /app

# Dépendances d'abord (cache Docker optimisé)
COPY package*.json ./
RUN npm ci --only=production

# Code source
COPY . .

# Script de démarrage
COPY start.sh /start.sh
RUN chmod +x /start.sh

# Seul le webhook a besoin d'un port public
EXPOSE 3000

CMD ["/start.sh"]
