#!/usr/bin/env bash
set -euo pipefail
node --import tsx src/server.ts > /tmp/campus-wall-ci.log 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
for attempt in {1..30}; do
    if curl --fail --silent http://127.0.0.1:3001/api/health > /dev/null; then
        curl --fail --silent http://127.0.0.1:3001/api/schools |
            node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => { const r=JSON.parse(s); if (r.ok !== true || !Array.isArray(r.data)) process.exit(1); });'
        exit 0
    fi
    sleep 1
done
cat /tmp/campus-wall-ci.log
exit 1
