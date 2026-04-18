# Bot Maximus Telegram

## Infraestructura
- Corre en VPS Hostinger (8GB RAM, 2 CPU)
- Docker container con restart: always
- OpenClaude CLI como motor de IA (usuario no-root `maximus` uid 999)
- ElevenLabs para TTS/STT
- FFmpeg para procesamiento de audio
- Repo: https://github.com/josenavarrojimenez-sudo/maximus

## Configuración LLM (dinámica via .env)
- `OPENCLAUDE_MODEL` — modelo a usar (default: `sonnet`). Cambiar a `opus`, `haiku`, o modelo completo como `claude-sonnet-4-6`
- `OPENCLAUDE_EFFORT` — nivel de razonamiento (default: `max`). Opciones: `low`, `medium`, `high`, `max`
- Para cambiar modelo o proveedor: solo editar `.env` y `docker compose up -d`. Cero código que tocar.

## Principio: Sin límites artificiales
- NO hay truncado de contexto ni de mensajes. El proveedor del LLM define sus propios límites.
- Mensajes recientes en contexto: sin cap (Infinity)
- Tamaño de contexto inyectado: sin cap (Infinity)
- Contenido por mensaje: completo, sin cortar
- Si se cambia de proveedor, estos valores no necesitan ajuste — cada LLM maneja su propio context window.

## Configuración técnica
- `--permission-mode bypassPermissions` para autonomía total
- `HOME=/app` dentro del contenedor
- Credenciales OAuth montadas en `/app/.openclaude/.credentials.json:ro`
- Datos persistentes en volume `/root/maximus-data` → `/app/data`
- Timeout: 10 minutos (para tareas complejas con herramientas)

## Estado actual
- Bot funcional con texto y audio
- Sistema de memoria persistente implementado (Fase 1)
- Cola de mensajes con límite (max 5), drop de mensajes >5min
- Batching de textos consecutivos (ventana 2s)
- Graceful shutdown (SIGTERM/SIGINT)
- Cron de resumen diario a las 11:59 PM

## Fase 2 pendiente
- Resúmenes automáticos de conversaciones viejas
- Consolidación de journal a canon
- Búsqueda semántica
