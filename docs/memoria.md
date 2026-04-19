# Sistema de Memoria de Maximus

Documentacion completa de como Maximus almacena, organiza y recupera informacion entre sesiones.

---

## Arquitectura General

La memoria de Maximus tiene **dos capas**:

```
┌─────────────────────────────────────────┐
│         CAPA 1: SQLite (mensajes)       │
│   Todos los intercambios Jose ↔ Maximus │
│   + FTS5 full-text search index         │
│   Archivo: /app/data/maximus.db         │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│      CAPA 2: Archivos Markdown          │
│   Memoria estructurada por tipo         │
│   Directorio: /app/data/memory/         │
│   canon/ journal/ user/ project/        │
│   decisions/ inbox/                     │
└─────────────────────────────────────────┘
```

### Rutas en disco (VPS)

| Ruta en VPS (host) | Ruta en container | Descripcion |
|---------------------|-------------------|-------------|
| `/root/maximus-data/maximus.db` | `/app/data/maximus.db` | Base de datos SQLite |
| `/root/maximus-data/memory/` | `/app/data/memory/` | Archivos de memoria |
| `/root/maximus-sessions/` | `/app/.claude/` | Sesiones OpenClaude |

El volume Docker (`/root/maximus-data` → `/app/data`) asegura que los datos sobreviven rebuilds y restarts del container.

---

## Capa 1: SQLite

### Archivo: `maximus.db`

#### Tabla: `conversations`
```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,          -- UUID
  started_at TEXT NOT NULL,     -- ISO timestamp
  summary TEXT                  -- Resumen (usado por daily summary)
);
```

Una nueva conversacion se crea cuando pasan **30 minutos** (`CONVERSATION_GAP_MS`) sin mensajes.

#### Tabla: `messages`
```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,    -- FK a conversations
  role TEXT NOT NULL,               -- 'user' o 'assistant'
  content TEXT NOT NULL,            -- Mensaje completo
  timestamp TEXT NOT NULL,          -- ISO timestamp
  summarized INTEGER DEFAULT 0     -- 1 = ya incluido en daily summary
);
```

#### Tabla virtual: `memory_search` (FTS5)
```sql
CREATE VIRTUAL TABLE memory_search USING fts5(
  source,       -- 'messages'
  path,         -- 'conversation:UUID'
  content,      -- 'Jose: ... \n Maximus: ...'
  tags,
  tokenize='unicode61'
);
```

Indice de busqueda full-text para encontrar conversaciones pasadas por palabras clave.

### Cuando se guarda en SQLite

`memory.saveExchange(userMessage, response)` se llama **despues** de que Maximus responde exitosamente. Hay 3 puntos de guardado en `bot.js`:

| Tipo de mensaje | Que se guarda | Linea en bot.js |
|-----------------|---------------|-----------------|
| Audio | Transcripcion + respuesta | Despues de enviar voice/texto |
| Imagen | Caption (o "[Imagen sin caption]") + respuesta | Despues de enviar respuesta |
| Texto | Mensaje original + respuesta | Despues de enviar respuesta |

**Importante:** Si el bot se cae DURANTE el procesamiento (antes de enviar respuesta), ese intercambio NO se guarda. Solo el mensaje que estaba en proceso se pierde.

### Flujo de guardado

```
Jose envia mensaje
      │
      ▼
Cola de mensajes (max 5, drop >5min)
      │
      ▼
Batching window (2s para texto)
      │
      ▼
callMaximus() → OpenClaude procesa
      │
      ▼
Respuesta recibida
      │
      ├──► Se envia a Jose en Telegram
      │
      └──► memory.saveExchange()
              ├── INSERT en messages (user + assistant)
              ├── INSERT en memory_search (FTS5)
              └── APPEND en journal del dia
```

### Lectura de contexto (buildContext)

Cada vez que Jose envia un mensaje, `memory.buildContext()` construye el contexto que se inyecta como prefijo:

```
=== HISTORIAL RECIENTE ===
(ultimos 10 mensajes de SQLite)

=== MEMORIA CORE ===
(archivos de canon/)

=== PREFERENCIAS DE JOSE ===
(archivos de user/)

=== PROYECTOS ACTIVOS ===
(archivos de project/)

=== DECISIONES CLAVE ===
(archivos de decisions/)
```

Configuracion:
- `MAX_RECENT_MESSAGES = 10` — Solo los ultimos 10 mensajes para velocidad
- Mensajes se truncan a 500 chars en el contexto
- Sin limite de tamano total (el LLM maneja su propio context window)

---

## Capa 2: Archivos Markdown

### Directorio: `memory/canon/`
**Verdades consolidadas y permanentes.**

Informacion fundamental que no cambia frecuentemente. Se inyecta en CADA mensaje como contexto.

Archivos actuales:
- `quien-es-maximus.md` — Identidad, personalidad, relacion con Jose
- `sistema-memoria.md` — Como funciona el sistema de memoria (meta-referencia)

### Directorio: `memory/journal/`
**Diarios de actividad por fecha.**

Un archivo por dia con formato `YYYY-MM-DD.md`. Contiene:
- Snippets de cada intercambio durante el dia (timestamps + preview)
- Se reemplaza por un resumen ejecutivo al final del dia (cron)

Formato del snippet (durante el dia):
```markdown
## HH:MM
- **Jose**: (primeros 150 chars del mensaje)
- **Maximus**: (primeros 150 chars de la respuesta)
```

Formato del resumen (despues del cron):
```markdown
# Journal - YYYY-MM-DD
## Temas tratados
## Decisiones tomadas
## Tareas pendientes
## Datos clave
## Sentimiento general
```

### Directorio: `memory/user/`
**Preferencias y perfil de Jose.**

Informacion sobre como Jose prefiere trabajar, su estilo de comunicacion, sus prioridades.

Archivo actual:
- `jose-preferences.md`

### Directorio: `memory/project/`
**Proyectos activos y su estado.**

Contexto sobre proyectos en los que se esta trabajando.

Archivo actual:
- `maximus-telegram.md`

### Directorio: `memory/decisions/`
**Decisiones clave tomadas.**

Registro de decisiones importantes para no repetir discusiones.

### Directorio: `memory/inbox/`
**Memorias pendientes de consolidar.**

Aqui llegan las memorias auto-generadas por Maximus usando bloques `[REMEMBER]`. Cada una es un archivo temporal con timestamp.

Formato del nombre: `{timestamp}-{tipo}.md`

Tipos posibles:
- `preferencia` — Preferencias de Jose
- `decision` — Decisiones tomadas
- `proyecto` — Info de proyectos
- `tecnico` — Datos tecnicos
- `contacto` — Contactos mencionados
- `general` — Otros

Formato interno:
```markdown
---
tipo: preferencia
confianza: alta
fecha: 2026-04-18T19:06:00.000Z
fuente: conversacion
---

Jose prefiere respuestas en texto para temas tecnicos.
```

**Nota:** Los items del inbox actualmente no se consolidan automaticamente a canon/. Es un proceso pendiente de implementar.

Subdirectorio `inbox/archived/` — para items ya procesados.

---

## Auto-Memoria: Bloques [REMEMBER]

Maximus puede auto-guardar informacion usando bloques especiales en sus respuestas:

```
[REMEMBER]
tipo: preferencia
confianza: alta
Jose prefiere que los reportes sean en formato bullet points.
[/REMEMBER]
```

### Flujo:

```
Maximus genera respuesta con [REMEMBER] block
      │
      ▼
memory.extractAndSaveMemories(response)
      │
      ├── Parsea tipo y confianza
      ├── Guarda en inbox/{timestamp}-{tipo}.md
      └── Elimina el bloque de la respuesta visible para Jose
```

Jose nunca ve los bloques `[REMEMBER]` — se procesan y eliminan antes de enviar.

Reglas (definidas en CLAUDE.md):
- Maximo 1-2 bloques por respuesta
- Solo guardar lo genuinamente util a futuro
- No abusar del sistema

---

## Busqueda Semantica

### FTS5 (Full-Text Search)

La funcion `searchRelevantHistory(query, limit)` busca en el historial:

1. **Intento 1:** FTS5 con operador OR entre palabras clave (rapido y preciso)
2. **Fallback:** LIKE search en la tabla messages (si FTS5 falla)

Extrae hasta 5 palabras clave del query (>3 caracteres) y busca matches.

Actualmente esta funcion esta disponible pero no se usa activamente en el flujo principal de mensajes. Esta lista para integraciones futuras (ej: buscar contexto relevante para preguntas especificas).

---

## Cron: Daily Summary

### Configuracion
- **Hora:** 11:59 PM (hora del servidor)
- **Frecuencia:** Diario
- **Implementacion:** `setTimeout` recursivo (no crontab del sistema)

### Flujo

```
11:59 PM
   │
   ▼
¿Hay mensajes sin resumir hoy? (summarized = 0)
   │
   ├── No → Skip
   │
   └── Si → buildSummaryPrompt(dateStr)
              │
              ▼
         Envia a OpenClaude con formato obligatorio:
         - Temas tratados
         - Decisiones tomadas
         - Tareas pendientes
         - Datos clave
         - Sentimiento general
              │
              ▼
         saveDailySummary()
              ├── Reemplaza journal del dia con resumen
              └── Marca mensajes como summarized = 1
```

### Prompt de resumen

El prompt incluye todos los mensajes del dia (hasta 800 chars cada uno) y pide un formato especifico de journal ejecutivo.

---

## Memoria Compartida (Host → Container)

Ademas de su propia memoria, Maximus tiene acceso read-only a la memoria de OpenClaude del host:

| Host | Container | Modo |
|------|-----------|------|
| `/root/.openclaude/projects/-root/memory/` | `/app/.openclaude/projects/-app/memory/` | read-only |

Esto permite que Maximus lea memorias creadas por OpenClaude CLI directamente (sesion activa, feedback, proyectos, etc).

---

## Diagrama Completo

```
Jose (Telegram)
    │
    ▼
┌──────────────────────────────────────────────┐
│              bot.js                          │
│                                              │
│  mensaje → cola → batch → callMaximus()      │
│                              │               │
│                              ▼               │
│                    OpenClaude CLI             │
│                    (stream-json)              │
│                              │               │
│                              ▼               │
│                    respuesta                 │
│                              │               │
│          ┌───────────────────┼────────┐      │
│          ▼                   ▼        ▼      │
│    Telegram msg      saveExchange()   TTS    │
│    (a Jose)          (SQLite+FTS5     (audio)│
│                       +journal)              │
│                                              │
│   buildContext() ◄── memory/*.md             │
│       (cada msg)     maximus.db              │
│                                              │
│   extractAndSaveMemories()                   │
│       ([REMEMBER] → inbox/)                  │
│                                              │
│   Daily Cron 23:59                           │
│       (summary → journal/)                   │
└──────────────────────────────────────────────┘
         │
    ┌────┴────────────────┐
    ▼                     ▼
/app/data/            /app/data/memory/
maximus.db            ├── canon/
maximus.db-wal        ├── journal/
maximus.db-shm        ├── user/
                      ├── project/
                      ├── decisions/
                      └── inbox/
         │
    (Docker volume)
         │
         ▼
/root/maximus-data/   ← VPS persistent storage
```

---

## Configuracion

| Variable | Valor | Descripcion |
|----------|-------|-------------|
| `CONVERSATION_GAP_MS` | 30 min | Tiempo sin mensajes para crear nueva conversacion |
| `MAX_RECENT_MESSAGES` | 10 | Mensajes recientes en contexto |
| `DATA_DIR` | `/app/data` | Directorio raiz de datos |
| `DB_PATH` | `/app/data/maximus.db` | Ruta de SQLite |
| `MEMORY_DIR` | `/app/data/memory` | Directorio de archivos md |

---

## Pendientes

1. **Consolidacion de inbox:** Los items en `inbox/` no se mueven automaticamente a `canon/`, `user/`, o `project/`. Actualmente se acumulan.
2. **Guardado anticipado:** Guardar el mensaje de Jose apenas llega (antes de procesar) para no perderlo en caso de crash.
3. **Limpieza de FTS5:** El indice crece indefinidamente. No hay proceso de limpieza.
4. **Busqueda semantica activa:** `searchRelevantHistory()` existe pero no se usa en el flujo principal.
