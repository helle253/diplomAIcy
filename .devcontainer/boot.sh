# Ensure Claude config directory has correct permissions (volume may be owned by root)
sudo chown -R node:node /home/node/.claude 2>/dev/null || true

# Fix ownership of globally-installed Claude Code package so auto-update works
# (the devcontainer feature installs it as root, but the node user needs write access to update it)
sudo chown -R node:npm /usr/local/share/npm-global/lib/node_modules/@anthropic-ai/ 2>/dev/null || true

# Enable corepack so the packageManager field in package.json activates Yarn 4
sudo corepack enable

curl -fsSL https://raw.githubusercontent.com/PeonPing/peon-ping/main/install.sh | bash -s -- --packs=ra_soviet

$HOME/.claude/hooks/peon-ping/peon.sh packs use ra_soviet

# Only pull Ollama model if the service is running (opt-in via docker compose --profile integration)
if curl -sf http://ollama:11434/api/tags >/dev/null 2>&1; then
  echo "Ollama detected, pulling model for integration tests..."
  curl -sf http://ollama:11434/api/pull -d '{"name":"qwen2.5:7b"}' | tail -1 || echo "Warning: Model pull may have failed"
else
  echo "Ollama not running — skipping model pull (start with: .devcontainer/start-ollama.sh)"
fi
