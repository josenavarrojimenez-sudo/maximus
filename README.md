# Maximus - CEO Virtual Bot de Telegram

Bot de Telegram con IA (OpenClaude) que actua como CEO Virtual con personalidad costarricense. Soporta texto y audio (ElevenLabs TTS/STT) con sistema de memoria persistente por capas.

## Arquitectura

```
Telegram <-> bot.js <-> OpenClaude CLI (subprocess)
                |
                +-> memory.js <-> SQLite + Markdown files
                |
                +-> linear.js <-> Linear API (polling cada 2 min)
                |
                +-> ElevenLabs API (TTS/STT)
                |
                +-> FFmpeg (audio processing)
```

## Features

### Core
- Respuestas por texto y audio (voice notes)
- Transcripcion de audio con ElevenLabs STT
- Text-to-Speech con ElevenLabs TTS + chunking para textos largos
- Volume boost con FFmpeg
- Cola de mensajes secuencial (1 a la vez)
- Timeout real de 5 min para OpenClaude
- Rate limit handling para Telegram API

### Linear Integration
- **Polling cada 2 minutos** — busca issues con label `maximus` que no estén completados
- **Ejecución autónoma** — Maximus procesa el issue con OpenClaude y lo ejecuta
- **Comentario automático** — el resultado se publica como comentario en el issue
- **Notificación a Jose** — avisa por Telegram al iniciar y al completar
- **Issue → Done** — mueve el issue a estado completado automáticamente
- **Tracking en SQLite** — no procesa el mismo issue dos veces

### Sistema de Memoria Persistente
- **SQLite** para episodios/conversaciones crudas (cada mensaje guardado inmediatamente)
- **Markdown** para memoria estructurada:
  - `canon/` - Verdad consolidada por tema
  - `journal/` - Diarios auto-generados
  - `user/` - Preferencias del usuario
  - `decisions/` - Decisiones clave
  - `project/` - Contexto de proyectos
  - `inbox/` - Auto-memorias de Maximus
- **Contexto inyectado** antes de cada respuesta (historial + canon + journal + prefs)
- **Self-write** con bloques `[REMEMBER]` - Maximus guarda memorias automaticamente
- **Cron diario** (11:59 PM) - Resumen ejecutivo del dia con OpenClaude
- **FTS5** full-text search en SQLite

### Flujo de memoria
```
Antes de responder:
1. Leer ultimos 20 mensajes de SQLite
2. Leer archivos canon/
3. Leer journal del dia
4. Leer preferencias user/
5. Leer proyectos project/
6. Inyectar todo como contexto al mensaje

Despues de responder:
1. Guardar intercambio en SQLite
2. Append al journal diario
3. Extraer bloques [REMEMBER] y guardar en inbox/
```

## Setup

### Requisitos
- Docker + Docker Compose
- OpenClaude credentials (`~/.openclaude/.credentials.json`)
- Telegram Bot Token (via @BotFather)
- ElevenLabs API Key
- Linear API Key (opcional, para integración con Linear)

### Instalacion

1. Clonar el repo:
```bash
git clone https://github.com/josenavarrojimenez-sudo/maximus.git
cd maximus
```

2. Configurar environment:
```bash
cp .env.example .env
# Editar .env con tus credenciales
```

3. Crear directorio de datos persistentes:
```bash
mkdir -p ~/maximus-data/memory/{canon,journal,user,decisions,project,inbox}
```

4. Copiar archivos seed de memoria (opcional):
```bash
cp -r memory-seed/* ~/maximus-data/memory/
```

5. Levantar:
```bash
docker compose up -d --build
```

### Logs
```bash
docker logs maximus-telegram --tail 50 -f
```

## Estructura de archivos

```
maximus/
  bot.js              # Bot principal (Telegram + OpenClaude + audio + Linear)
  memory.js           # Sistema de memoria (SQLite + Markdown)
  linear.js           # Integración con Linear (polling + ejecución autónoma)
  system-prompt.txt   # Personalidad de Maximus
  Dockerfile          # Imagen Docker
  docker-compose.yml  # Orquestacion
  package.json        # Dependencias Node.js
  .env.example        # Template de variables
  memory-seed/        # Archivos iniciales de memoria

~/maximus-data/       # Volumen persistente (fuera del contenedor)
  maximus.db          # Base de datos SQLite
  memory/
    canon/            # Verdad consolidada
    journal/          # Diarios por dia
    user/             # Preferencias
    decisions/        # Decisiones
    project/          # Proyectos
    inbox/            # Auto-memorias
```

## Inspirado en
- [gbrain](https://github.com/garrytan/gbrain) - Verdad consolidada por tema
- [lossless-claw](https://github.com/martian-engineering/lossless-claw) - No perder contexto
- [qmd](https://github.com/tobi/qmd) - Busqueda eficiente
- [MemPalace](https://github.com/MemPalace/mempalace) - Recuerdos crudos con estructura
