#!/bin/sh
mkdir -p /app/tmp /app/data /app/.openclaude /app/.codex

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
