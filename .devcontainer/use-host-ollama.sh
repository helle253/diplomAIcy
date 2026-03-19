#!/bin/bash
# Use the host machine's native Ollama instead of the Docker container.
# On Apple Silicon (M1/M2/M3), native Ollama uses Metal GPU acceleration,
# which is ~5-10x faster than CPU-only inference inside Docker.
#
# Prerequisites:
#   1. Install Ollama on macOS: https://ollama.com/download (or `brew install ollama`)
#   2. Start it: `ollama serve` (or it runs as a menu bar app)
#   3. Pull your model: `ollama pull qwen2.5:3b`
#   4. Run this script from inside the devcontainer
#
# Usage:
#   .devcontainer/use-host-ollama.sh [model]
#   .devcontainer/use-host-ollama.sh qwen2.5:7b

set -eo pipefail

HOST_URL="http://host.docker.internal:11434"
MODEL="${1:-qwen2.5:3b}"

echo "Checking host Ollama at $HOST_URL ..."
if ! curl -sf "$HOST_URL/api/tags" >/dev/null 2>&1; then
  echo "ERROR: Ollama not reachable at $HOST_URL"
  echo ""
  echo "Make sure Ollama is running on your host machine:"
  echo "  1. Install: https://ollama.com/download"
  echo "  2. Start:   ollama serve   (or use the menu bar app)"
  echo "  3. Re-run this script"
  exit 1
fi

# Check if model is available
if ! curl -sf "$HOST_URL/api/tags" | python3 -c "
import json, sys
models = [m['name'] for m in json.load(sys.stdin).get('models', [])]
if '$MODEL' not in models:
    print('Available models: ' + ', '.join(models) if models else 'No models pulled')
    sys.exit(1)
" 2>/dev/null; then
  echo "Model '$MODEL' not found on host. Pulling..."
  if ! curl -sf "$HOST_URL/api/pull" -d "{\"name\":\"$MODEL\"}" | while read -r line; do
    status=$(echo "$line" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
    [ -n "$status" ] && echo "  $status"
  done; then
    echo "ERROR: Failed to pull model $MODEL"
    exit 1
  fi
fi

# Write the host-ollama config
CONFIG_FILE="$(dirname "$0")/../diplomaicy.config.ollama-host.json"
cat > "$CONFIG_FILE" << EOF
{
  "defaultAgent": {
    "type": "llm",
    "provider": "openai",
    "baseUrl": "$HOST_URL/v1",
    "apiKey": "ollama",
    "model": "$MODEL",
    "temperature": 0.7,
    "maxTokens": 16384,
    "numCtx": 40960
  }
}
EOF

echo ""
echo "Host Ollama ready with model $MODEL"
echo "Config written to: diplomaicy.config.ollama-host.json"
echo ""
echo "Usage:"
echo "  DIPLOMAICY_CONFIG=diplomaicy.config.ollama-host.json yarn play:llm"
echo ""
echo "Or for integration tests, set:"
echo "  DIPLOMAICY_CONFIG=diplomaicy.config.ollama-host.json"
