#!/bin/bash
# Avvia server HTTP + tunnel cloudflare, e stampa l'URL da incollare nel connettore ChatGPT.
set -e
DIR="$HOME/jarvis/mcp-devbridge"
NODE=/opt/homebrew/bin/node
CF=/opt/homebrew/bin/cloudflared
LOG="$DIR/logs"
mkdir -p "$LOG"

pkill -f "mcp-devbridge/http.mjs" 2>/dev/null || true
pkill -f "cloudflared tunnel --url http://127.0.0.1:8787" 2>/dev/null || true
sleep 1

nohup "$NODE" "$DIR/http.mjs" --port 8787 > "$LOG/http.log" 2>&1 &
sleep 2
nohup "$CF" tunnel --url http://127.0.0.1:8787 > "$LOG/tunnel.log" 2>&1 &

for i in $(seq 1 30); do
  URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG/tunnel.log" | head -1)
  [ -n "$URL" ] && break
  sleep 1
done
TOK=$(cat "$HOME/.config/devbridge/token")
FULL="$URL/mcp/$TOK"
echo "$FULL" > "$DIR/logs/current-url.txt"
echo "$FULL"
