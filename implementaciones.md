# Implementaciones - Maximus Telegram Bot

Registro de features implementadas, cambios arquitecturales y fixes.

---

## 2026-04-18 - Migración a OpenClaude Nativo (Sesiones Persistentes)

### Problema
El bot spawneaba un proceso nuevo de `openclaude -p --no-session-persistence` para CADA mensaje, inyectando manualmente ~15,000 chars de contexto (historial, journal, canon, preferencias). Esto causaba:
- Respuestas lentas (30-60 segundos por mensaje)
- Timeouts constantes (300s) cuando Jose pedía acciones técnicas
- Maximus intentaba usar tools que no tiene en modo `-p`, entraba en loop y moría

### Causa raíz
1. **System prompt mentía**: decía que Maximus podía hacer SSH, instalar paquetes, etc. pero `-p` mode no permite tools
2. **Context injection manual**: 50 mensajes × 2000 chars = hasta 100K chars inyectados cada vez
3. **Sin sesiones**: cada mensaje era stateless, sin memoria de la conversación anterior

### Solución implementada
1. **`CLAUDE.md` creado** — OpenClaude lee la identidad de Maximus nativamente (personalidad, reglas, formato [AUDIO]/[TEXTO])
2. **`bot.js` reescrito** — Usa `openclaude -p --continue` para retomar sesiones. OpenClaude maneja su propio contexto, compresión y memoria
3. **Context injection eliminado** — Ya no se llama `memory.buildContext()` en el flujo de mensajes. OpenClaude maneja todo
4. **System prompt corregido** — Maximus sabe que está en modo conversación, no intenta usar tools
5. **Sesiones persistentes** — Volume mount `/root/maximus-sessions:/app/.claude` para que sesiones sobrevivan rebuilds
6. **Gap de 30 minutos** — Después de 30 min sin mensajes, inicia sesión nueva automáticamente
7. **Timeout reducido** — De 300s a 180s
8. **Contexto reducido** — 10 mensajes × 500 chars (backup para daily summary)

### Archivos modificados
- `bot.js` — callOpenClaude() con --continue, sin context injection
- `memory.js` — Reducido MAX_RECENT_MESSAGES=10, truncation=500, sin journal/inbox en contexto
- `system-prompt.txt` — Reglas operativas corregidas (modo conversación)
- `CLAUDE.md` — NUEVO, identidad nativa de Maximus
- `docker-compose.yml` — Volume mount para sesiones persistentes

### Resultado esperado
- Respuestas en <15 segundos (vs 30-60s antes)
- Sin timeouts por loops de tools
- Contexto manejado por OpenClaude nativamente
- Continuidad de conversación entre mensajes

---

## Features existentes (pre-migración)

- **Status Cards** — Mensajes HTML de progreso en Telegram que se auto-eliminan al completar
- **OAuth auto-refresh** — Credenciales montadas read-write para que OpenClaude refresque tokens
- **Soporte de imagenes** — Handler para fotos y documentos de imagen
- **Audio bidireccional** — ElevenLabs TTS/STT con chunking y volume boost (Voice ID: 7MbkkemMzdIlG5LyIhul, modelo eleven_v3)
- **Memoria persistente** — SQLite + Markdown (episodica, journal, canon, preferencias)
- **Auto-memoria** — Bloques [REMEMBER] procesados automaticamente
- **Cola de mensajes** — Procesamiento secuencial anti-race-condition
- **Daily Summary** — Cron 11:59 PM con journal ejecutivo
- **Linear integration** — Modulo listo, falta API key
