#!/usr/bin/env bash
# Boot DSH 0.1.7-alpha.2 with this plugin against an isolated DSH_HOME.
#   FAKE=1 (default) points the DeepSeek provider at test/fake-llm (keyless).
#   DEV_ROUTES=1 (default) adds scripts/dev.patch.yml (test-only /dev routes).
#   PORT (default 3181) — never 3080, which the user's own dsh web may hold.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DSH_HOME="${DSH_HOME:-$ROOT/.dsh-dev}"
PORT="${PORT:-3181}"
if [ "${FAKE:-1}" = "1" ]; then
  export DEEPSEEK_BASE_URL="${DEEPSEEK_BASE_URL:-http://127.0.0.1:${FAKE_LLM_PORT:-18317}}"
  export DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-fake-key}"
fi
PATCH=()
[ "${DEV_ROUTES:-1}" = "1" ] && PATCH=(--patch "$ROOT/scripts/dev.patch.yml")
exec "$ROOT/node_modules/.bin/dsh" --profile rdfoe-dev "${PATCH[@]}" --no-open --port "$PORT" "$@"
