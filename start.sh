#!/bin/sh
# ============================================================
# start.sh — Démarre tous les processus dans une seule image
# Ordre : Redis d'abord, puis les 3 processus Node.js
# ============================================================

echo "[START] Démarrage de Redis..."
redis-server --daemonize yes --loglevel notice

# Attendre que Redis soit prêt
echo "[START] Attente Redis..."
until redis-cli ping | grep -q PONG; do
  sleep 0.5
done
echo "[START] Redis prêt ✓"

# Forcer Redis en localhost (interne à l'image)
export REDIS_URL="redis://localhost:6379"

echo "[START] Démarrage webhook (port 3000)..."
node src/webhook.js &
PID_WEBHOOK=$!

echo "[START] Démarrage worker..."
node src/worker.js &
PID_WORKER=$!

echo "[START] Démarrage scanner-resume..."
node src/scanner-resume.js &
PID_SCANNER=$!

echo "[START] Tous les processus démarrés ✓"
echo "[START] webhook PID=$PID_WEBHOOK | worker PID=$PID_WORKER | scanner PID=$PID_SCANNER"

# Si un processus meurt, tuer les autres et quitter
# Railway redémarrera le conteneur automatiquement
wait -n
echo "[START] Un processus s'est arrêté — arrêt du conteneur"
kill $PID_WEBHOOK $PID_WORKER $PID_SCANNER 2>/dev/null
exit 1
