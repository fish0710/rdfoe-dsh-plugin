#!/usr/bin/env bash
# Stop the dev DSH (default port 3181) and the fake LLM (18317) started for this repo.
for port in "${PORT:-3181}" "${FAKE_LLM_PORT:-18317}"; do
  pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  [ -n "$pids" ] && kill $pids && echo "stopped :$port ($pids)"
done
exit 0
