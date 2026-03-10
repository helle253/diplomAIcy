# Ensure Claude config directory has correct permissions (volume may be owned by root)
sudo chown -R node:node /home/node/.claude 2>/dev/null || true

# Fix ownership of globally-installed Claude Code package so auto-update works
# (the devcontainer feature installs it as root, but the node user needs write access to update it)
sudo chown -R node:npm /usr/local/share/npm-global/lib/node_modules/@anthropic-ai/ 2>/dev/null || true

curl -fsSL https://raw.githubusercontent.com/PeonPing/peon-ping/main/install.sh | bash -s -- --packs=ra_soviet

$HOME/.claude/hooks/peon-ping/peon.sh packs use ra_soviet
