# Comandos de Maximus Telegram Bot

Referencia completa de todos los comandos disponibles en el bot de Telegram.

---

## Control y Estado

### `/btw <pregunta>`
**Pregunta rapida mientras Maximus esta ocupado.**

Spawna un proceso OpenClaude temporal e independiente para responder sin interrumpir la tarea principal. Ideal para preguntas cortas que no pueden esperar.

- **Modelo:** Gemma 4 31B via Ollama Cloud (gratis)
- **Configurable:** Variables `BTW_PROVIDER` y `BTW_MODEL` en `.env`
- **Timeout:** 60 segundos
- **Sin StatusCard:** Solo typing indicator para maxima velocidad
- **Funciona siempre:** Incluso si Maximus esta procesando otra tarea
- El proceso temporal se destruye automaticamente despues de responder
- La respuesta se limita a 2-3 oraciones (instruccion al modelo)

**Ejemplo:**
```
/btw que hora es en Costa Rica?
/btw cuantos containers estan corriendo?
```

---

### `/status`
**Estado actual del bot.**

Muestra informacion en tiempo real sin pasar por OpenClaude:

- Modelo activo (proveedor + nombre)
- Uptime del bot
- Mensajes en cola
- Si esta procesando: tiempo transcurrido + preview del mensaje
- Modelo configurado para `/btw`

**Ejemplo de salida:**
```
Modelo: Anthropic / Sonnet 4.6
Uptime: 2h 15m
Cola: 0 mensajes
Idle - listo para trabajar
BTW: Ollama Cloud / gemma4:31b-cloud
```

---

### `/tasks`
**Tareas activas y cola de mensajes.**

Muestra:
- Tarea en proceso (con tiempo transcurrido y preview)
- Mensajes en cola esperando ser procesados (con tiempo de espera de cada uno)

---

### `/cancel`
**Cancelar la operacion actual.**

- Mata el proceso OpenClaude y lo respawna limpio
- Vacia la cola de mensajes pendientes
- Limpia todas las promesas pendientes
- Maximus queda listo para nuevas instrucciones inmediatamente
- Si no hay nada procesando, informa que esta idle

---

### `/fast`
**Toggle modo rapido.**

Activa/desactiva el modo rapido. Cuando esta ON, se inyecta una instruccion al contexto pidiendo respuestas lo mas breves y directas posible.

- No cambia el modelo, solo el comportamiento
- Persiste hasta que se desactive o se reinicie el bot
- Estado actual: se muestra con emoji (conejo = ON, tortuga = OFF)

---

### `/effort <nivel>`
**Nivel de esfuerzo del modelo.**

Controla la profundidad de las respuestas. Cambia el flag `--effort` de OpenClaude y respawna el proceso.

Niveles disponibles:
| Nivel | Comportamiento |
|-------|---------------|
| `low` | Respuestas minimas, maxima velocidad |
| `medium` | Balance entre velocidad y detalle |
| `high` | Respuestas detalladas y completas |
| `max` | Maximo esfuerzo, analisis profundo |
| `auto` | OpenClaude decide segun la complejidad (default) |

**Ejemplo:**
```
/effort low      -> respuestas rapidas
/effort max      -> analisis profundo
/effort auto     -> volver al default
```

Sin argumento muestra el nivel actual.

---

## Sesion y Contexto

### `/compact [nota]`
**Compactar el contexto de conversacion (nativo).**

Envia el comando `/compact` directamente al proceso OpenClaude via stream-json. OpenClaude comprime internamente el historial de la sesion en un resumen inteligente, liberando tokens sin perder el hilo.

- **Nativo:** Usa la funcion interna de OpenClaude, no mata el proceso
- **Nota opcional:** Se puede agregar instrucciones de que priorizar en el resumen
- Escucha el evento `compact_boundary` para confirmar completado
- Muestra tokens comprimidos al finalizar
- Timeout: 30 segundos

**Ejemplo:**
```
/compact                              -> compacta todo
/compact enfocate en el tema de agentes  -> prioriza ese contexto
```

**Diferencia con /clear:** `/compact` preserva un resumen del contexto. `/clear` borra todo.

---

### `/clear`
**Reinicio total de sesion.**

Reset completo:
- Mata el proceso OpenClaude y lo respawna
- Vacia la cola de mensajes
- Limpia el batch buffer
- Resetea contadores de costo (tokens, USD, mensajes)
- Resetea estado de procesamiento

Los datos en SQLite y archivos de memoria **NO se borran** (persisten en disco).

---

### `/mensajes [N]`
**Cargar los ultimos N mensajes como contexto.**

Lee los ultimos N mensajes del historial guardado en SQLite y los inyecta como contexto al proceso actual de OpenClaude. Maximus los lee y confirma que entiende el contexto.

- **Default:** 50 mensajes
- **Maximo:** 500 mensajes
- **Fuente:** SQLite (`messages` table) - persiste siempre
- Los mensajes incluyen: timestamp, quien hablo (Jose/Maximus), contenido completo

**Casos de uso:**
- Despues de una caida forzada del bot
- Despues de `/clear` para recuperar contexto
- Al iniciar sesion nueva sin perder continuidad
- Cuando Maximus "olvido" algo reciente

**Ejemplo:**
```
/mensajes          -> ultimos 50 mensajes
/mensajes 100      -> ultimos 100 mensajes
/mensajes 200      -> ultimos 200 mensajes
```

---

### `/rewind`
**Deshacer el ultimo intercambio.**

Envia una instruccion a OpenClaude para que ignore el ultimo par pregunta/respuesta y actue como si no hubiera ocurrido. Util cuando Maximus fue por un camino equivocado.

- No funciona mientras hay una tarea procesando (usar `/cancel` primero)
- Es una instruccion semantica, no borra datos de SQLite

---

### `/summary`
**Resumen ejecutivo de lo trabajado.**

Spawna un proceso OpenClaude temporal (igual que `/btw`) que genera un resumen basado en la memoria disponible. Maximo 5-8 bullet points.

- Usa el mismo modelo que `/btw` (Gemma 4 / Ollama Cloud)
- Incluye contexto de memoria (canon, user, project, recent messages)
- Timeout: 60 segundos

---

### `/cost`
**Tokens y costos de la sesion.**

Muestra metricas acumuladas desde el ultimo reinicio del bot:
- Total de mensajes procesados
- Tokens de entrada/salida (si el modelo los reporta)
- Costo en USD (si disponible)
- Uptime
- Modelo activo

Los contadores se resetean con `/clear` o cuando el bot se reinicia.

---

## Modelo y Proveedor

### `/model`
**Ver modelo activo.**

Muestra el proveedor y modelo actualmente configurado.

---

### `/models`
**Menu interactivo de modelos.**

Abre un menu con botones inline en Telegram:
1. Seleccionar proveedor (Anthropic, Ollama Cloud, OpenRouter)
2. Navegar modelos paginados (4x2 + next/prev)
3. Seleccionar modelo → respawn automatico

Proveedores disponibles:
- **Anthropic** — Sonnet 4.6, Opus 4.6, Haiku 4.5 (OAuth nativo)
- **Ollama Cloud** — 33 modelos (DeepSeek, Qwen, Gemma, Mistral, etc.)
- **OpenRouter** — 54+ modelos (GPT-5.x, Grok 4.x, Gemini 3.x, etc.)

---

## Git

### `/diff [path]`
**Ver cambios no commiteados.**

Ejecuta `git diff --stat` + diff completo en el directorio especificado.

- **Default:** `/app` (directorio del bot dentro del container)
- Muestra estadisticas + diff con colores
- Trunca output a 3000 chars para no saturar Telegram
- Timeout: 10 segundos

**Ejemplo:**
```
/diff              -> diff en /app
/diff /host-agents -> diff en directorio de agentes
```

---

### `/commit <mensaje>`
**Commit rapido.**

Ejecuta `git add -A` + `git commit -m "mensaje"` en `/app`.

- Requiere mensaje obligatorio
- Verifica que hay cambios antes de commitear
- Muestra cantidad de archivos modificados al confirmar

**Ejemplo:**
```
/commit fix: corregir bug en audio processing
```

---

## Mensajes Directos

Ademas de los comandos, Maximus responde a:

| Tipo | Comportamiento |
|------|---------------|
| **Texto** | Procesado con batching (2s ventana), respuesta en HTML formateado |
| **Audio** | STT (ElevenLabs Scribe) → procesado → respuesta en audio o texto |
| **Imagen** | Analisis visual via base64 → respuesta en texto o audio |

---

## Resumen de Comandos

| Comando | Descripcion | Requiere OpenClaude |
|---------|-------------|:-------------------:|
| `/btw <pregunta>` | Pregunta rapida (proceso independiente) | No (usa temp) |
| `/status` | Estado del bot | No |
| `/tasks` | Tareas y cola | No |
| `/cancel` | Cancelar operacion | No |
| `/fast` | Toggle modo rapido | No |
| `/effort <nivel>` | Nivel de esfuerzo | No (respawn) |
| `/compact [nota]` | Compactar contexto | Si (nativo) |
| `/clear` | Reinicio total | No (respawn) |
| `/mensajes [N]` | Cargar historial | Si |
| `/rewind` | Deshacer ultimo | Si |
| `/summary` | Resumen ejecutivo | No (usa temp) |
| `/cost` | Costos de sesion | No |
| `/model` | Ver modelo | No |
| `/models` | Cambiar modelo | No |
| `/diff [path]` | Ver cambios git | No |
| `/commit <msg>` | Commit rapido | No |
| `/help` | Lista de comandos | No |
