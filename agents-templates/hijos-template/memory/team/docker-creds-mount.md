---
name: Docker credential mount pattern
description: NUNCA montar archivos de credenciales individuales en Docker — usar directorios + symlinks para que token refresh no rompa auth
type: feedback
---

# Docker credential mount — directory, NOT file

**Regla:** NUNCA montar un archivo individual de credenciales como bind mount en Docker. Montar un DIRECTORIO que contenga el archivo.

**Why:** Docker bind mounts de archivos individuales pinean al **inode** del archivo. Cuando el CLI refresca OAuth tokens, escribe un archivo NUEVO (nuevo inode). El container sigue viendo el inode viejo con el token expirado → 401 authentication_error. Esto causó que Maximus y Optimus se quedaran muertos el 2026-04-19.

**How to apply:**
1. Credenciales en directorios dedicados: `/root/.openclaude-creds/` y `/root/.codex-creds/`
2. Systemd watcher (`openclaude-credentials.service`) sincroniza de la fuente original a estos dirs
3. Docker-compose monta el DIRECTORIO: `/root/.openclaude-creds:/app/.openclaude-creds:ro`
4. Entrypoint crea symlink: `ln -sf /app/.openclaude-creds/.credentials.json /app/.openclaude/.credentials.json`
5. Bot.js detecta 401 con: `authentication_error`, `Invalid authentication credentials`, `Not logged in`, `Please run /login`

**Archivos clave:**
- Watcher: `/root/.openclaude/fix-credentials-permissions.sh`
- Service: `/etc/systemd/system/openclaude-credentials.service`
- Template entrypoint: `/root/agents/template/entrypoint.sh`
