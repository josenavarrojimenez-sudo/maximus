#!/bin/sh
# Configure git credentials if GITHUB_TOKEN is set
if [ -n "$GITHUB_TOKEN" ]; then
  git config --global user.name "Maximus"
  git config --global user.email "maximus@bot.local"
  git config --global credential.helper 'store'
  echo "https://${GITHUB_USER:-josenavarrojimenez-sudo}:${GITHUB_TOKEN}@github.com" > "$HOME/.git-credentials"
  echo "[Git] Credentials configured for ${GITHUB_USER:-josenavarrojimenez-sudo}"
fi

# Verify OpenClaude credentials are mounted
if [ -f /app/.openclaude/.credentials.json ]; then
  echo "[OpenClaude] Credentials mounted (live, auto-refresh enabled)"
else
  echo "[OpenClaude] WARNING: Credentials not found at /app/.openclaude/.credentials.json"
fi

exec node bot.js
