# Implementaciones - Maximus Telegram Bot

Registro de features implementadas, cambios arquitecturales y fixes.

---

## 2026-04-18 - Audio inteligente (analiza contenido antes de responder)

### Problema
Cuando Jose mandaba un audio, Maximus siempre respondía con audio automáticamente, sin analizar el contenido. Si Jose decía "respondeme con texto" o pedía algo técnico (reportes, listas, código), igual le mandaba un voice note.

### Solución
- CLAUDE.md y system-prompt.txt actualizados: Maximus ahora **lee y analiza el contenido del audio PRIMERO** antes de decidir el formato de respuesta
- Solo usa [AUDIO] para conversación casual
- Usa [TEXTO] cuando Jose pide texto, datos técnicos, reportes, listas, o dice "respondeme con texto", "modo trabajo", etc.
- En caso de duda, defaultea a [TEXTO] (más seguro que mandar audio cuando Jose quería leer)

### Archivos modificados
- `CLAUDE.md` — Regla de formato reescrita
- `system-prompt.txt` — Misma regla actualizada

---

## 2026-04-18 - Cola inteligente + Batching de mensajes

### Cambios
1. **Cola limitada a 5** — Si la cola se llena, descarta el mensaje más viejo
2. **Drop de mensajes stale** — Mensajes que esperan >5 minutos se descartan automáticamente
3. **Batching de texto (ventana 2s)** — Mensajes de texto consecutivos se agrupan en uno solo antes de llamar a OpenClaude (ahorra tokens y da mejor respuesta)
4. **Modelo y effort via .env** — Verificado que `OPENCLAUDE_MODEL` y `OPENCLAUDE_EFFORT` se pasan correctamente al proceso via `process.env`

### Archivos modificados
- `bot.js` — Queue con MAX_QUEUE_SIZE=5, MAX_QUEUE_AGE_MS=5min, enqueueBatchedText() con ventana 2s, handleTextMessage() extraído como función

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

### Archivos modificados
- `bot.js` — callOpenClaude() con --continue, sin context injection
- `memory.js` — Reducido para daily summary cron solamente
- `system-prompt.txt` — Reglas operativas corregidas (modo conversación)
- `CLAUDE.md` — NUEVO, identidad nativa de Maximus
- `docker-compose.yml` — Volume mount para sesiones persistentes

---

## Hallazgos de auditoría (2026-04-18)

Maximus revisó el repo y encontró items no implementados. Estado:

| # | Item | Estado |
|---|------|--------|
| 1 | Cola con límite 5 y drop >5min | IMPLEMENTADO |
| 2 | Batching de textos (ventana 2s) | IMPLEMENTADO |
| 3 | Modelo y effort via .env | VERIFICADO (ya funcionaba) |
| 4 | Contexto completo sin truncado | NO APLICA — migrado a OpenClaude nativo |
| 5 | Journal del día en contexto | NO APLICA — OpenClaude maneja su propio contexto |
| 6 | Inbox pendiente en contexto | NO APLICA — OpenClaude maneja su propio contexto |
| 7 | Webhook CI/CD | PENDIENTE — Maximus va a implementar |
| 8 | Items inbox sin consolidar | PENDIENTE — Maximus va a procesar |

---

## Features existentes (pre-migración)

- **Status Cards** — Mensajes HTML de progreso en Telegram que se auto-eliminan al completar
- **OAuth auto-refresh** — Credenciales montadas read-write para que OpenClaude refresque tokens
- **Soporte de imagenes** — Handler para fotos y documentos de imagen
- **Audio bidireccional** — ElevenLabs TTS/STT con chunking y volume boost (Voice ID: 7MbkkemMzdIlG5LyIhul, modelo eleven_v3)
- **Memoria persistente** — SQLite + Markdown (episodica, journal, canon, preferencias)
- **Auto-memoria** — Bloques [REMEMBER] procesados automaticamente
- **Cola de mensajes** — Procesamiento secuencial con límite 5, drop stale, batching 2s
- **Daily Summary** — Cron 11:59 PM con journal ejecutivo
- **Linear integration** — Modulo listo, falta API key
