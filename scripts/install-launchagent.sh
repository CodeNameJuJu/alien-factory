#!/usr/bin/env bash
# Write (and optionally load) the Alien Factory worker LaunchAgent.
# Default: just writes the plist and prints how to load it.
#   ./scripts/install-launchagent.sh --load   → write + launchctl bootstrap
set -euo pipefail

LABEL="com.codenamejuju.alien-factory"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(which node)"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOGDIR="$HOME/.alien-factory/logs"
UID_NUM="$(id -u)"

mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-is</string>
    <string>${NODE}</string>
    <string>${REPO}/scripts/run-worker.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${LOGDIR}/worker.out.log</string>
  <key>StandardErrorPath</key><string>${LOGDIR}/worker.err.log</string>
</dict>
</plist>
PLIST

echo "wrote $PLIST"

if [[ "${1:-}" == "--load" ]]; then
  launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
  launchctl bootstrap "gui/${UID_NUM}" "$PLIST"
  echo "loaded — the worker is running (logs: ${LOGDIR}/worker.{out,err}.log)"
else
  echo "to load it now:  launchctl bootstrap gui/${UID_NUM} \"$PLIST\""
  echo "or re-run:       $0 --load"
fi
