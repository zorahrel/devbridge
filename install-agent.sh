#!/bin/bash
# Installa il LaunchAgent: i due listener e il tunnel nominato partono al login.
# Prerequisito del regime remoto: un tunnel Cloudflare nominato con ingress su
# http://127.0.0.1:8788 e il suo token nel Keychain:
#   security add-generic-password -s devbridge -a cloudflared-tunnel-token -w '<token>' -U
# e "issuer": "https://<host pubblico del tunnel>" in ~/.config/devbridge/config.json.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
UID_N=$(id -u)
PLIST="$HOME/Library/LaunchAgents/com.devbridge.plist"
mkdir -p "$HOME/.config/devbridge" "$DIR/logs"
[ -f "$HOME/.config/devbridge/config.json" ] || { cp "$DIR/config.example.json" "$HOME/.config/devbridge/config.json"; echo "config creata: ~/.config/devbridge/config.json (controlla i roots)"; }

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.devbridge</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$DIR/run.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DIR/logs/agent.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/agent.err</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$UID_N/com.devbridge" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$UID_N" "$PLIST"
echo "agent installato. Segui l'avvio con: tail -f $DIR/logs/agent.log"
