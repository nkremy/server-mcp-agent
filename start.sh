#!/bin/sh
# ============================================================
# start.sh
# Lance les 3 processus Node.js en parallèle dans le conteneur
# Redis est fourni par Railway via REDIS_URL (variable d'env)
# ============================================================

echo "[START] Démarrage webhook..."
node src/webhook.js &
PID_WEBHOOK=$!

echo "[START] Démarrage worker..."
node src/worker.js &
PID_WORKER=$!

echo "[START] Démarrage scanner-resume..."
node src/scanner-resume.js &
PID_SCANNER=$!

echo "[START] Tous les processus démarrés"
echo "  webhook  PID=$PID_WEBHOOK"
echo "  worker   PID=$PID_WORKER"
echo "  scanner  PID=$PID_SCANNER"

# Si un processus meurt, on arrête tout
# Railway redémarre le conteneur automatiquement
wait -n
echo "[START] Un processus s'est arrêté — arrêt du conteneur"
kill $PID_WEBHOOK $PID_WORKER $PID_SCANNER 2>/dev/null
exit 1
