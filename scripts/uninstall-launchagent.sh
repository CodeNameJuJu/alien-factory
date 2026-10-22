#!/usr/bin/env bash
# Stop and remove the Alien Factory worker LaunchAgent.
set -euo pipefail

LABEL="com.codenamejuju.alien-factory"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
UID_NUM="$(id -u)"

launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
rm -f "$PLIST"
echo "uninstalled ${LABEL}"
