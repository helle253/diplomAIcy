#!/bin/bash
# Start the Ollama service and pull the default model for integration tests.
# Run this from within the devcontainer when you want to run integration tests.

set -eo pipefail

COMPOSE_FILE="$(dirname "$0")/docker-compose.yml"
MODEL="${1:-qwen2.5:7b}"

echo "Starting Ollama service..."
docker compose -f "$COMPOSE_FILE" --profile integration up ollama -d

echo "Waiting for Ollama to be ready..."
for i in $(seq 1 30); do
  if curl -sf http://ollama:11434/api/tags >/dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: Ollama did not become ready in time"
    exit 1
  fi
  sleep 2
done

echo "Pulling model: $MODEL"
if ! curl -sf http://ollama:11434/api/pull -d "{\"name\":\"$MODEL\"}" | tail -1; then
  echo "ERROR: Failed to pull model $MODEL"
  exit 1
fi

echo "Ollama ready with model $MODEL"
