#!/usr/bin/env bash
# Spins up a full Diplomacy game with all 7 powers as remote LLM agents.
# Usage: yarn play:llm
# Env vars (set in .env or export before running):
#   LLM_PROVIDER, LLM_BASE_URL, LLM_API_KEY, LLM_MODEL
#   MAX_YEARS (default 5), PHASE_DELAY (default 5000), REMOTE_TIMEOUT (default 120000)
set -euo pipefail

POWERS=(England France Germany Italy Austria Russia Turkey)
AGENT_TYPE="${AGENT_TYPE:-llm}"
SERVER_URL="http://localhost:${PORT:-3000}/trpc"
PIDS=()

cleanup() {
  echo ""
  echo "Shutting down..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

# Start server with remote config
MAX_YEARS="${MAX_YEARS:-5}" \
PHASE_DELAY="${PHASE_DELAY:-5000}" \
REMOTE_TIMEOUT="${REMOTE_TIMEOUT:-120000}" \
DIPLOMAICY_CONFIG=diplomaicy.config.remote.json \
  node dist/ui/server.js &
PIDS+=($!)

# Wait for server to be ready
echo "Waiting for server..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${PORT:-3000}/api/state" > /dev/null 2>&1; then
    echo "Server ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "Server failed to start" >&2
    exit 1
  fi
  sleep 0.5
done

# Launch agents with a small stagger to avoid connection storms
for power in "${POWERS[@]}"; do
  node dist/agent/remote/run.js --power "$power" --server "$SERVER_URL" --type "$AGENT_TYPE" &
  PIDS+=($!)
  sleep 0.3
done

echo "All agents launched. Game in progress..."
echo "UI: http://localhost:${PORT:-3000}"

# Wait for server (exits when game loop ends or on signal)
wait "${PIDS[0]}"
