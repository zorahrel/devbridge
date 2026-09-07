#!/bin/bash
# Installa il LaunchAgent: server + tunnel partono al login e l'app ChatGPT resta allineata.
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
