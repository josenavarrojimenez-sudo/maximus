#!/bin/sh
# Configure git credentials if GITHUB_TOKEN is set
if [ -n "$GITHUB_TOKEN" ]; then
  git config --global user.name "Maximus"
  git config --global user.email "maximus@bot.local"
  git config --global credential.helper 'store'
  echo "https://${GITHUB_USER:-josenavarrojimenez-sudo}:${GITHUB_TOKEN}@github.com" > "$HOME/.git-credentials"
  echo "[Git] Credentials configured for ${GITHUB_USER:-josenavarrojimenez-sudo}"
fi

# Symlink credentials from mounted DIRECTORIES (not individual files)
# Directory bind mounts track file changes; file bind mounts pin to an inode
# and go stale when the CLI refreshes OAuth tokens (writes new file = new inode)
if [ -f /app/.openclaude-creds/.credentials.json ]; then
  ln -sf /app/.openclaude-creds/.credentials.json /app/.openclaude/.credentials.json
  echo "[OpenClaude] Credentials linked from mount directory (auto-refresh safe)"
else
  echo "[OpenClaude] WARNING: Credentials not found at /app/.openclaude-creds/.credentials.json"
fi

if [ -f /app/.codex-creds/auth.json ]; then
  ln -sf /app/.codex-creds/auth.json /app/.codex/auth.json
  echo "[Codex] Credentials linked from mount directory (auto-refresh safe)"
fi

exec node bot.js
