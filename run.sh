#!/bin/bash
# Foreground: launchd deve poter supervisionare il processo. Avvia http.mjs e il tunnel,
# scrive l'URL corrente in logs/current-url.txt e resta vivo finche' uno dei due muore.
DIR="$HOME/jarvis/mcp-devbridge"
NODE=/opt/homebrew/bin/node
CF=/opt/homebrew/bin/cloudflared
LOG="$DIR/logs"; mkdir -p "$LOG"
: > "$LOG/tunnel.log"

# un residuo sulla 8787 fa morire http.mjs con EADDRINUSE e manda launchd in restart loop
# libera la porta per PID: pkill -f non prende i processi lanciati con path relativo
for pid in $(lsof -nP -iTCP:8787 -sTCP:LISTEN -t 2>/dev/null); do kill -9 "$pid" 2>/dev/null; done
pkill -f "mcp-devbridge/http.mjs" 2>/dev/null
pkill -f "cloudflared tunnel --url http://127.0.0.1:8787" 2>/dev/null
sleep 2

"$NODE" "$DIR/http.mjs" --port 8787 > "$LOG/http.log" 2>&1 &
HTTP_PID=$!
sleep 2
"$CF" tunnel --url http://127.0.0.1:8787 > "$LOG/tunnel.log" 2>&1 &
CF_PID=$!

cleanup() { kill "$HTTP_PID" "$CF_PID" 2>/dev/null; exit 0; }
trap cleanup TERM INT

URL=""
for i in $(seq 1 40); do
  URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG/tunnel.log" | head -1)
  [ -n "$URL" ] && break
  sleep 1
done
[ -z "$URL" ] && { echo "tunnel non avviato" >&2; cleanup; }

TOK=$(cat "$HOME/.config/devbridge/token")
FULL="$URL/mcp/$TOK"
echo "$FULL" > "$LOG/current-url.txt"
echo "$(date '+%F %T') UP $FULL"

# l'URL trycloudflare cambia a ogni avvio: riallinea l'app in ChatGPT
"$NODE" "$DIR/sync-connector.mjs" "$FULL" 2>&1 | sed 's/^/  sync: /' || echo "  sync fallito (Chrome CDP spento?)"

# bash 3.2 (macOS) non ha `wait -n`: polling dei due figli
while kill -0 "$HTTP_PID" 2>/dev/null && kill -0 "$CF_PID" 2>/dev/null; do sleep 10; done
echo "$(date '+%F %T') DOWN (un processo e' uscito), riavvio via launchd"
cleanup
