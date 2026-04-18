# Implementaciones de Maximus

Registro de todas las features y cambios implementados en el bot de Maximus Telegram.

---

## 2026-04-18

### Status Cards (Mensajes de progreso en tiempo real)
- **Archivo:** `bot.js` (clase `StatusCard`)
- **Descripcion:** Mensajes HTML interactivos en Telegram que muestran el progreso de cada paso mientras Maximus procesa un mensaje. Se eliminan automaticamente al completar la tarea.
- **Flujos cubiertos:**
  - Texto: Recibido -> Pensando -> Preparando respuesta
  - Audio: Descargando audio -> Transcribiendo -> Pensando -> Generando respuesta
  - Imagen: Descargando imagen -> Analizando imagen -> Pensando -> Preparando respuesta
- **Comportamiento:** Cada paso muestra un emoji y estado (pending/active/done/fail). Al completar, el mensaje se borra para no ensuciar el chat.

### Fix: Credenciales OAuth auto-refresh
- **Archivos:** `docker-compose.yml`, `entrypoint.sh`
- **Descripcion:** Las credenciales de Anthropic se montaban como copia estatica (read-only) al inicio del container. Cuando el token OAuth expiraba (~8 horas), el bot se quedaba muerto sin poder refrescar.
- **Fix:** Montar el archivo de credenciales directamente en read-write para que OpenClaude pueda refrescar el token automaticamente.

### Sistema de Memoria Persistente (Fase 1)
- **Archivos:** `memory.js`, `system-prompt.txt`
- **Descripcion:** SQLite + Markdown para memoria episodica, journal diario, canon, preferencias, decisiones e inbox.
- **Capas:** Identidad fija, historial reciente, memoria episodica, journal diario, canon, preferencias, decisiones, inbox.

### Soporte de Imagenes
- **Archivo:** `bot.js`
- **Descripcion:** Handler para recibir fotos y documentos de imagen por Telegram. Descarga la imagen y la pasa a OpenClaude para analisis visual.

### ElevenLabs TTS/STT
- **Archivo:** `bot.js`
- **Descripcion:** Text-to-Speech y Speech-to-Text usando ElevenLabs API. Voice ID personalizado, chunking para textos largos, volume boost con FFmpeg.

### Sistema de Auto-Memoria ([REMEMBER] blocks)
- **Archivos:** `memory.js`, `system-prompt.txt`
- **Descripcion:** Maximus puede guardar memorias automaticamente usando bloques [REMEMBER] en sus respuestas, que se procesan y guardan en inbox sin mostrarse al usuario.

### Integracion Linear
- **Archivo:** `linear.js`
- **Descripcion:** Polling cada 2min a Linear API. Filtra issues con label "maximus", ejecuta via OpenClaude, comenta resultado, mueve a Done, notifica a Jose.
- **Estado:** Modulo creado, requiere LINEAR_API_KEY en .env.

### Cola de Mensajes
- **Archivo:** `bot.js`
- **Descripcion:** Sistema de cola para procesar mensajes uno a la vez, evitando race conditions.

### Daily Summary Cron
- **Archivo:** `bot.js`, `memory.js`
- **Descripcion:** Resumen diario automatico a las 11:59 PM. Genera journal ejecutivo del dia usando OpenClaude.
