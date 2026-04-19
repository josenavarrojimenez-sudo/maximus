# Implementaciones - Maximus Telegram Bot

Registro de features implementadas, cambios arquitecturales y fixes.

---

## 2026-04-18 - Migración a OpenClaude CLI persistente (stream-json)

### Problema
Después de migrar al SDK de Anthropic directo, el bot daba error 429 en cada request. El OAuth token de la suscripción Max no está diseñado para llamar a `api.anthropic.com` directamente — funciona solo a través de OpenClaude CLI que usa un endpoint intermedio.

El approach anterior de subprocess (`openclaude -p` por mensaje) también fallaba: stdin cerrado, permisos de tools sin confirmar, timeouts constantes.

### Solución
Un solo proceso `openclaude` persistente que se comunica con el bot via **stream-json** (NDJSON por stdin/stdout):

- **Spawn único al arranque** — No se crea/destruye proceso por mensaje
- **Protocolo NDJSON** — Mensajes JSON por stdin, respuestas JSON por stdout
- **Auth nativa** — Misma OAuth de suscripción Max, sin API key separada
- **CLAUDE.md nativo** — OpenClaude lo lee automáticamente como system prompt
- **Auto-respawn** — Si el proceso muere, se relanza en 3 segundos
- **Timeout 5 min** — Safety net por si OpenClaude se queda pensando
- **Contexto de memoria** — `memory.buildContext()` inyectado como prefijo de cada mensaje
- **Imágenes** — Base64 en content array via stream-json (visión nativa)

Flags del proceso:
```
openclaude -p --verbose --input-format stream-json --output-format stream-json --dangerously-skip-permissions --model sonnet
```

### Archivos modificados
- `bot.js` — `callMaximus()` reescrito: envía NDJSON a stdin, lee respuesta de stdout. Eliminado `@anthropic-ai/sdk`, `getClient()`, `conversationHistory`
- `Dockerfile` — Reinstalado `@gitlawb/openclaude`. Eliminado `@anthropic-ai/sdk`
- `package.json` — Eliminado `@anthropic-ai/sdk` de dependencies

### Resultado
Respuestas significativamente más rápidas. Sin 429, sin timeouts, sin subprocess por mensaje.

---

## 2026-04-18 - Migración a Anthropic SDK directo (REVERTIDA)

### Problema
El bot usaba OpenClaude CLI como subprocess (`openclaude -p`) que se pegaba constantemente.

### Solución intentada
Reemplazar subprocess con `@anthropic-ai/sdk` usando el OAuth token directamente. El token sí autenticaba (no daba 401) pero daba **429 rate limit** en cada request porque el endpoint `api.anthropic.com` no acepta tokens OAuth de suscripción Max.

### Estado: REVERTIDA — reemplazada por stream-json persistente (ver arriba)

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
| 7 | Webhook CI/CD | NO APLICA — deploys se hacen directo desde OpenClaude en el VPS |
| 8 | Items inbox sin consolidar | PENDIENTE — Maximus va a procesar |

---

## 2026-04-18 - Sistema multi-proveedor /models + /model

### Problema
El bot solo podía usar Anthropic (Sonnet) via OAuth. Jose quiere poder cambiar entre múltiples proveedores y modelos desde Telegram.

### Solución
Sistema de switching dinámico de proveedor/modelo con menú interactivo en Telegram:

**Proveedores configurados:**
1. **Anthropic** (OAuth nativo) — Sonnet 4.6, Opus 4.6, Haiku 4.5
2. **Ollama Cloud** (API key, OpenAI-compatible) — 33 modelos cloud (DeepSeek, Qwen, Gemma, Kimi, MiniMax, Nemotron, etc.)
3. **OpenRouter** (API key, OpenAI-compatible) — 54 modelos curados (GPT-5.x, Grok 4.x, Gemini 3.x, DeepSeek, Llama 4, Mistral, + PinchBench top models)

**Funcionalidad:**
- `/model` — Muestra el modelo activo (proveedor + nombre + ID técnico)
- `/models` — Menú interactivo con inline keyboard:
  - Selección de proveedor (Anthropic / Ollama Cloud / OpenRouter)
  - Lista paginada de modelos (4 filas × 2 columnas por página, con Next/Previous)
  - Al seleccionar: kill proceso actual → respawn con nuevo provider/model (500ms)
  - Indicador ✅ en modelo activo
  - Iconos PinchBench: 🏆 top success, 💰 top cost, ⚡ top speed, 🎯 top value
- Inyección de `[Modelo actual: Provider / Model]` en cada mensaje para que el modelo sepa qué es
- Detección de error "Not logged in" → auto kill + respawn + mensaje amigable

**Mecanismo técnico:**
- Providers no-Anthropic usan env vars: `CLAUDE_CODE_USE_OPENAI=1`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`
- `switchModel()` setea `intentionalKill=true`, mata el proceso, el handler de exit respawnea con los nuevos valores
- Callback data usa prefijos cortos (`prov:`, `mdl:`, `page:`) para respetar límite de 64 bytes de Telegram

### Archivos modificados
- `bot.js` — PROVIDERS config, spawnOpenClaude() dinámico, switchModel(), /models con paginación, /model, callback_query handler
- `.env` — Agregado OLLAMA_API_KEY y OPENROUTER_API_KEY

---

## 2026-04-18 - Memoria compartida OpenClaude → Maximus

### Problema
Maximus no tenía acceso a los archivos de memoria de OpenClaude (soul.md, agents.md, user-jose.md, feedback-jose.md, etc.). Cuando le preguntabas "quién sos" no tenía contexto de su identidad completa.

### Solución
Montar el directorio de memoria del host dentro del container como read-only:
```
/root/.openclaude/projects/-root/memory → /app/.openclaude/projects/-app/memory:ro
```
OpenClaude CLI dentro del container lee estos archivos automáticamente como su MEMORY.md nativa.

### Archivos modificados
- `docker-compose.yml` — Agregado volume mount de memoria

---

## 2026-04-18 - Mensajes HTML interactivos + código separado

### Problema
Los mensajes de Maximus eran texto plano sin formato, difíciles de leer en Telegram.

### Solución
- `mdToHtml()` — Convierte Markdown a HTML de Telegram: headers con emojis (📋📌🔹), bold/italic/strikethrough, bullets con •, listas numeradas, blockquotes, links
- `extractCodeBlocks()` — Extrae bloques de código y los envía como mensajes separados con `<pre><code>` (Telegram muestra botón de copiar automáticamente)
- Fallback a texto plano si el HTML falla

### Archivos modificados
- `bot.js` — `sendTextResponse()` reescrito con mdToHtml(), extractCodeBlocks(), escapeHtml()

---

## 2026-04-18 - Servicio de permisos de credenciales OAuth

### Problema
Al hacer `/login`, el archivo de credenciales se regenera con permisos `600` (solo root). Los containers Docker (user 999) quedan sin acceso → error "Not logged in" en todos los agentes.

### Solución
Servicio systemd `openclaude-credentials` que vigila el archivo con inotify y automáticamente lo pone en `644` cuando cambia:
- `/root/.openclaude/fix-credentials-permissions.sh` — Script watcher
- `/etc/systemd/system/openclaude-credentials.service` — Servicio systemd (enabled, auto-start)
- Aplica para Maximus y todos los agentes futuros que compartan las credenciales

### Archivos creados
- `/root/.openclaude/fix-credentials-permissions.sh`
- `/etc/systemd/system/openclaude-credentials.service`

---

## 2026-04-18 - Maximus con poderes completos (Docker + Host)

### Problema
Maximus tenía restricciones artificiales — no podía manejar Docker, crear agentes, ni acceder al filesystem del host. Jose quiere que Maximus tenga exactamente las mismas capacidades que OpenClaude CLI.

### Solución
- **Docker CLI** instalado dentro del container (binario copiado del host)
- **Docker socket** montado (`/var/run/docker.sock`) con grupo `989` (docker)
- **Directorio de agentes** montado (`/root/agents → /host-agents`) donde Maximus puede crear nuevos agentes
- **CLAUDE.md actualizado** — permisos totales, única restricción: no matarse a sí mismo
- Maximus puede: crear/manejar/eliminar containers, acceder filesystem, instalar paquetes, manejar infraestructura
- Siempre consulta a Jose antes de acciones importantes

### Archivos modificados
- `Dockerfile` — Docker CLI instalado, curl agregado
- `docker-compose.yml` — Docker socket mount, agents dir mount, group_add 989
- `CLAUDE.md` — Permisos totales documentados
- `.dockerignore` — docker-cli no excluido

---

## 2026-04-18 - Ajuste de voz

### Cambios
- `VOICE_SETTINGS.stability` cambiado de 0.4 a 0.5
- Voice ID cambiado a `WEXRePkZGpmcFLvCOaB1`

---

## Features existentes (pre-migración)

- **Status Cards** — Mensajes HTML de progreso en Telegram que se auto-eliminan al completar
- **OAuth auto-refresh** — Credenciales montadas read-write para que OpenClaude refresque tokens
- **Soporte de imagenes** — Handler para fotos y documentos de imagen
- **Audio bidireccional** — ElevenLabs TTS/STT con chunking y volume boost (Voice ID: WEXRePkZGpmcFLvCOaB1, modelo eleven_v3)
- **Memoria persistente** — SQLite + Markdown (episodica, journal, canon, preferencias)
- **Auto-memoria** — Bloques [REMEMBER] procesados automaticamente
- **Cola de mensajes** — Procesamiento secuencial con límite 5, drop stale, batching 2s
- **Daily Summary** — Cron 11:59 PM con journal ejecutivo
- **Linear integration** — Modulo listo, falta API key
