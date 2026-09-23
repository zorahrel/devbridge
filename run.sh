#!/bin/bash
# Foreground: launchd supervises this process. Starts http.mjs (two listeners) and the
# NAMED Cloudflare tunnel, and stays alive until one of them dies.
#
#   local  127.0.0.1:8787  this Mac + tailnet (`tailscale serve --set-path /devbridge`)
#   remote 127.0.0.1:8788  only the named tunnel (config `issuer`) -> OAuth + sandbox
#
# Since 23/09 there is no quick tunnel and no token in any URL: the public address is
# fixed (<issuer>/mcp), so ChatGPT's connector never has to be
# re-pointed, and the tunnel credential lives in the Keychain (devbridge /
# cloudflared-tunnel-token), not on disk.
DIR="$HOME/jarvis/mcp-devbridge"
NODE=/opt/homebrew/bin/node
CF=/opt/homebrew/bin/cloudflared
LOG="$DIR/logs"; mkdir -p "$LOG"
CONFIG="$HOME/.config/devbridge/config.json"
ISSUER="${DEVBRIDGE_ISSUER:-$("$NODE" -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).issuer||"")}catch{}' "$CONFIG")}"
[ -z "$ISSUER" ] && { echo "$(date '+%F %T') manca \"issuer\" in $CONFIG (https://<host pubblico del tunnel>)" >&2; exit 1; }

# a leftover on either port makes http.mjs die with EADDRINUSE and launchd loop
for port in 8787 8788; do
  for pid in $(lsof -nP -iTCP:$port -sTCP:LISTEN -t 2>/dev/null); do kill -9 "$pid" 2>/dev/null; done
done
pkill -f "mcp-devbridge/http.mjs" 2>/dev/null
pkill -f "cloudflared tunnel" 2>/dev/null
sleep 2

TUNNEL_TOKEN=$(security find-generic-password -s devbridge -a cloudflared-tunnel-token -w 2>/dev/null)
[ -z "$TUNNEL_TOKEN" ] && { echo "$(date '+%F %T') token del tunnel assente nel Keychain (devbridge/cloudflared-tunnel-token)" >&2; exit 1; }

"$NODE" "$DIR/http.mjs" --port 8787 --remote-port 8788 --issuer "$ISSUER" > "$LOG/http.log" 2>&1 &
HTTP_PID=$!
sleep 2
# --no-autoupdate: launchd owns the lifecycle. The token goes through the environment,
# not argv, so `ps` does not show it. --loglevel warn: cloudflared at info logs the
# path of every request, which is how the old token ended up 34 times in tunnel.log.
TUNNEL_TOKEN="$TUNNEL_TOKEN" "$CF" tunnel --no-autoupdate --loglevel warn run > "$LOG/tunnel.log" 2>&1 &
CF_PID=$!
unset TUNNEL_TOKEN

cleanup() { kill "$HTTP_PID" "$CF_PID" 2>/dev/null; exit 0; }
trap cleanup TERM INT

echo "$ISSUER/mcp" > "$LOG/current-url.txt"
echo "$(date '+%F %T') UP local 127.0.0.1:8787, remote $ISSUER/mcp (OAuth)"

# bash 3.2 (macOS) has no `wait -n`: poll both children
while kill -0 "$HTTP_PID" 2>/dev/null && kill -0 "$CF_PID" 2>/dev/null; do sleep 10; done
echo "$(date '+%F %T') DOWN (un processo e' uscito), riavvio via launchd"
cleanup
