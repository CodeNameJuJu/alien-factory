#!/usr/bin/env bash
# Is the Alien Factory worker running? LaunchAgent state + recent logs.
set -euo pipefail

LABEL="com.codenamejuju.alien-factory"
LOGDIR="$HOME/.alien-factory/logs"
UID_NUM="$(id -u)"

launchctl print "gui/${UID_NUM}/${LABEL}" 2>/dev/null | grep -E 'state|pid|last exit' || echo "not loaded"
echo "--- last log lines ---"
tail -n 8 "$LOGDIR/worker.out.log" 2>/dev/null || echo "(no stdout log)"
tail -n 8 "$LOGDIR/worker.err.log" 2>/dev/null || true
