#!/usr/bin/env bash
# Spins up a full Diplomacy game with all 7 powers as remote LLM agents.
# Usage: yarn play:llm
# Env vars (set in .env or export before running):
#   LLM_PROVIDER, LLM_BASE_URL, LLM_API_KEY, LLM_MODEL  (default for all agents)
#   AGENT_CONFIG — path to a config JSON with per-power overrides (optional)
#   AGENT_TYPE — force all agents to this type: random|llm (optional, overrides config)
#   MAX_YEARS (default 5), PHASE_DELAY (default 5000), REMOTE_TIMEOUT (default 120000)
set -euo pipefail

POWERS=(England France Germany Italy Austria Russia Turkey)
AGENT_TYPE="${AGENT_TYPE:-llm}"
AGENT_CONFIG="${AGENT_CONFIG:-diplomaicy.config.json}"
SERVER_URL="http://localhost:${PORT:-3000}/trpc"
MAX_YEARS="${MAX_YEARS:-5}"
PHASE_DELAY="${PHASE_DELAY:-5000}"
REMOTE_TIMEOUT="${REMOTE_TIMEOUT:-120000}"
PIDS=()

# Validate numeric env vars early
for v in MAX_YEARS PHASE_DELAY REMOTE_TIMEOUT; do
  if ! [[ "${!v}" =~ ^[0-9]+$ ]]; then
    echo "$v must be a non-negative integer (got '${!v}')" >&2
    exit 1
  fi
done

cleanup() {
  echo ""
  echo "Shutting down..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

# Start server with remote config (server always uses remote since agents are separate processes)
MAX_YEARS="$MAX_YEARS" \
PHASE_DELAY="$PHASE_DELAY" \
REMOTE_TIMEOUT="$REMOTE_TIMEOUT" \
DIPLOMAICY_CONFIG=diplomaicy.config.remote.json \
  npx tsx src/ui/server.ts &
PIDS+=($!)

# Wait for server to be ready
echo "Waiting for server..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${PORT:-3000}/api/health" > /dev/null 2>&1; then
    echo "Server ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "Server failed to start" >&2
    exit 1
  fi
  sleep 0.5
done

# Create a lobby via tRPC
LOBBY_RESPONSE=$(curl -sf "${SERVER_URL}/lobby.create" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"CLI Game\",\"maxYears\":${MAX_YEARS},\"phaseDelayMs\":${PHASE_DELAY},\"remoteTimeoutMs\":${REMOTE_TIMEOUT},\"autostart\":true,\"agentConfig\":{\"defaultAgent\":{\"type\":\"remote\"}}}")

if [ -z "$LOBBY_RESPONSE" ]; then
  echo "Failed to create lobby" >&2
  exit 1
fi

LOBBY_ID=$(jq -er '.result.data.lobbyId // .lobbyId // empty' <<<"$LOBBY_RESPONSE") || {
  echo "Failed to parse lobby.create response: $LOBBY_RESPONSE" >&2
  exit 1
}

echo "Created lobby: $LOBBY_ID"

# Launch agents — each reads per-power config from AGENT_CONFIG
for power in "${POWERS[@]}"; do
  TYPE_FLAG=""
  if [ -n "$AGENT_TYPE" ]; then
    TYPE_FLAG="--type $AGENT_TYPE"
  fi
  DIPLOMAICY_CONFIG="$AGENT_CONFIG" \
    npx tsx src/agent/remote/run.ts --power "$power" --lobby "$LOBBY_ID" --server "$SERVER_URL" $TYPE_FLAG &
  PIDS+=($!)
  sleep 3
done

echo "All agents launched. Game in progress..."
echo "UI: http://localhost:${PORT:-3000}"

# Wait for server (exits when game loop ends or on signal)
wait "${PIDS[0]}"
