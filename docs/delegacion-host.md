# Sistema de Delegacion al Host

## Problema que resuelve

Los bots (Maximus, Optimus, Valentina, etc.) corren dentro de containers Docker con OpenClaude CLI. Cuando una tarea es muy compleja, requiere acceso a archivos del host, o el contexto del bot esta llegando al limite, el bot no puede resolverlo por si solo. Antes, Jose tenia que ir al host manualmente a ejecutar la tarea con OpenClaude CLI directo.

Con el sistema de delegacion, los bots pueden escalar tareas pesadas automaticamente a OpenClaude en el host, sin que el usuario necesite intervenir.

---

## Arquitectura General

```
Jose (Telegram)
    |
    v
Bot (Docker Container)
    |
    v
OpenClaude CLI (in-container, proceso persistente)
    |
    | Responde con [DELEGATE]tarea[/DELEGATE]
    v
bot.js → handleDelegation()
    |
    | HTTP POST
    v
Delegation Service (host, puerto 3847)
    |
    v
OpenClaude CLI (host, acceso completo al VPS)
    |
    | resultado
    v
bot.js ← recibe resultado
    |
    | Inyecta resultado como mensaje de usuario
    v
OpenClaude CLI (in-container)
    |
    | Formatea para el usuario
    v
Jose recibe respuesta en Telegram
```

---

## Componentes

### 1. Delegation Service (Host)

**Ubicacion:** `/root/agents/delegation-service/server.js`

Servidor HTTP Node.js que corre en el host (fuera de Docker) como servicio systemd.

**Endpoints:**

| Metodo | Ruta | Descripcion |
|--------|------|-------------|
| `POST` | `/delegate` | Recibe una tarea, la ejecuta con OpenClaude CLI y retorna el resultado |
| `GET` | `/health` | Health check - retorna estado y jobs activos |

**Request body (POST /delegate):**

```json
{
  "task": "descripcion de la tarea a ejecutar",
  "context": "contexto opcional de la conversacion",
  "cwd": "/ruta/de/trabajo (opcional, default: /root)",
  "timeout_ms": 300000
}
```

**Response:**

```json
{
  "success": true,
  "result": "texto del resultado de OpenClaude",
  "error": null
}
```

**Como ejecuta la tarea:**

1. Recibe el POST con la tarea
2. Construye un prompt completo (task + context si existe)
3. Spawns `openclaude -p "tarea" --output-format text --permission-mode dontAsk --model sonnet --verbose`
4. Espera a que OpenClaude termine (timeout default: 5 min, max: 15 min)
5. Retorna el stdout como resultado

**Configuracion:**

| Variable | Default | Descripcion |
|----------|---------|-------------|
| `PORT` | `3847` | Puerto del servidor |
| Default timeout | 5 min | Timeout por defecto por tarea |
| Max timeout | 15 min | Timeout maximo permitido |

**Nota importante:** Usa `--permission-mode dontAsk` en vez de `--dangerously-skip-permissions` porque este ultimo no funciona con root.

---

### 2. Systemd Service

**Ubicacion:** `/etc/systemd/system/delegation-service.service`

```ini
[Unit]
Description=Agent Delegation Service - Host task execution for containerized agents
After=network.target docker.service

[Service]
Type=simple
ExecStart=/usr/bin/node /root/agents/delegation-service/server.js
Restart=always
RestartSec=3
Environment=PORT=3847
WorkingDirectory=/root/agents/delegation-service

[Install]
WantedBy=multi-user.target
```

**Comandos utiles:**

```bash
# Ver estado
systemctl status delegation-service

# Ver logs
journalctl -u delegation-service -f

# Reiniciar
systemctl restart delegation-service

# Test rapido
curl -s http://localhost:3847/health
```

---

### 3. Docker Networking

Todos los containers necesitan resolver `host.docker.internal` para poder hacer HTTP al host.

**Configuracion en docker-compose.yml:**

```yaml
services:
  nombre-agente:
    # ... resto de config ...
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

**Archivos modificados:**

| Archivo | Container |
|---------|-----------|
| `/root/maximus-telegram/docker-compose.yml` | maximus-telegram |
| `/root/agents/optimus/docker-compose.yml` | optimus |
| `/root/agents/template/docker-compose.yml` | template (nuevos agentes) |
| `/root/agents/hijos/template/docker-compose.yml` | template hijos |
| `/root/agents/hijos/valentina/docker-compose.yml` | valentina |

**Verificacion desde dentro del container:**

```bash
docker exec maximus-telegram curl -s http://host.docker.internal:3847/health
# Debe retornar: {"status":"ok","active_jobs":0}
```

---

### 4. Integracion en bot.js

Cada bot.js tiene 3 componentes de delegacion:

#### a) Funcion `delegateToHost(task, context)`

Hace HTTP POST al delegation service y retorna el resultado como texto.

```javascript
const DELEGATION_HOST = process.env.DELEGATION_HOST || 'http://host.docker.internal:3847';
const DELEGATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

function delegateToHost(task, context) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ task, context, timeout_ms: DELEGATION_TIMEOUT_MS });
    const url = new URL(`${DELEGATION_HOST}/delegate`);
    const http = require('http');
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: DELEGATION_TIMEOUT_MS + 10000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { const p = JSON.parse(data); resolve(p.success ? p.result : `[ERROR] ${p.error}`); }
        catch (e) { resolve(data); }
      });
    });
    req.on('error', (err) => resolve(`[ERROR] Delegacion fallo: ${err.message}`));
    req.on('timeout', () => { req.destroy(); resolve('[ERROR] Delegacion timeout'); });
    req.write(payload);
    req.end();
  });
}
```

#### b) Regex de deteccion

```javascript
const DELEGATE_REGEX = /\[DELEGATE\]([\s\S]*?)\[\/DELEGATE\]/;
```

Detecta el patron `[DELEGATE]tarea aqui[/DELEGATE]` en la respuesta de OpenClaude.

#### c) Funcion `handleDelegation(rawResponse)`

Intercepta la respuesta de OpenClaude, detecta si tiene el marcador de delegacion, ejecuta la delegacion y re-inyecta el resultado.

```javascript
async function handleDelegation(rawResponse) {
  const match = rawResponse.match(DELEGATE_REGEX);
  if (!match) return rawResponse;  // No hay delegacion, pasar tal cual

  const delegationTask = match[1].trim();
  console.log(`[Delegation] Detected: ${delegationTask.substring(0, 100)}...`);

  // Obtener contexto reciente de la conversacion (Maximus tiene SQLite)
  let context = '';
  try {
    const db = memory.getDb();
    if (db) {
      const recent = db.prepare('SELECT role, content FROM messages ORDER BY id DESC LIMIT 5').all().reverse();
      context = recent.map(m => `${m.role}: ${m.content.substring(0, 200)}`).join('\n');
    }
  } catch (e) { /* sin contexto */ }

  // Ejecutar en el host
  const hostResult = await delegateToHost(delegationTask, context);

  // Inyectar resultado de vuelta en OpenClaude del container
  const resultMsg = `[RESULTADO DEL HOST - OpenClaude ejecuto esta tarea en el servidor principal]\n\n${hostResult}\n\nFormatea este resultado para Jose y responde normalmente.`;
  const finalResponse = await callMaximus(resultMsg);  // o callOptimus, callAgent segun el bot
  return finalResponse;
}
```

#### d) Puntos de integracion

`handleDelegation()` se llama despues de cada llamada al modelo, en todos los flujos de mensaje:

```javascript
// En el handler de texto
let rawResponse = await callMaximus(text);
rawResponse = await handleDelegation(rawResponse);  // <-- aqui

// En el handler de audio
let rawResponse = await callMaximus(`[Audio] ${transcription}`);
rawResponse = await handleDelegation(rawResponse);  // <-- aqui

// En el handler de imagen
let rawResponse = await callMaximus(imgMessage, imageBase64, mimeType);
rawResponse = await handleDelegation(rawResponse);  // <-- aqui
```

**Archivos modificados:**

| Archivo | Funcion de llamada |
|---------|-------------------|
| `/root/maximus-telegram/bot.js` | `callMaximus()` |
| `/root/agents/optimus/bot.js` | `callOptimus()` via `callWithFallback()` |
| `/root/agents/template/bot.js` | `callAgent()` |
| `/root/agents/hijos/template/bot.js` | `callAgent()` |

---

### 5. Instrucciones en CLAUDE.md

Cada bot tiene en su CLAUDE.md instrucciones para saber cuando y como usar la delegacion:

```
## Delegacion al host
Cuando una tarea requiera operaciones complejas multi-archivo, git operations pesadas,
edicion de codigo extenso, o sientas que tu contexto esta llegando al limite, podes
delegar la tarea al servidor principal (OpenClaude en el host con acceso completo).
Para delegar, inclui en tu respuesta:
[DELEGATE]descripcion detallada y completa de la tarea a ejecutar[/DELEGATE]
El sistema ejecutara la tarea en el host y te devolvera el resultado para que lo
formatees y se lo presentes al usuario. Usa delegacion cuando:
- La tarea involucra editar multiples archivos de codigo
- Necesitas hacer git operations (commit, push, branch)
- Tu contexto esta muy cargado y la tarea es pesada
- Necesitas acceso a archivos del host que no tenes montados
```

**Archivos modificados:**

| Archivo |
|---------|
| `/root/maximus-telegram/CLAUDE.md` |
| `/root/agents/optimus/CLAUDE.md` |
| `/root/agents/template/CLAUDE.md.example` |
| `/root/agents/hijos/template/CLAUDE.md.example` |
| `/root/agents/hijos/valentina/CLAUDE.md` |

---

## Flujo Completo Paso a Paso

1. **Jose manda mensaje** por Telegram (texto, audio o imagen)
2. **bot.js** recibe el mensaje, lo pone en cola, lo procesa
3. **bot.js** envia el mensaje a **OpenClaude CLI** (in-container) via stdin (stream-json NDJSON)
4. **OpenClaude** analiza la tarea. Si es compleja, responde con:
   ```
   [DELEGATE]Editar el archivo /root/maximus-telegram/bot.js para agregar la funcion X que hace Y[/DELEGATE]
   ```
5. **bot.js** recibe la respuesta en `handleOpenClaudeMessage()` y la pasa a `handleDelegation()`
6. **`handleDelegation()`** detecta el regex `[DELEGATE]...[/DELEGATE]`
7. **`delegateToHost()`** hace HTTP POST a `http://host.docker.internal:3847/delegate`
8. **Delegation Service** en el host recibe la tarea
9. Spawns `openclaude -p "tarea" --permission-mode dontAsk --model sonnet`
10. **OpenClaude en el host** ejecuta la tarea con acceso completo al VPS (filesystem, git, docker, etc.)
11. El resultado (stdout) se retorna como JSON al bot
12. **bot.js** inyecta el resultado como un nuevo mensaje de usuario a OpenClaude in-container:
    ```
    [RESULTADO DEL HOST - OpenClaude ejecuto esta tarea en el servidor principal]
    
    <resultado aqui>
    
    Formatea este resultado para Jose y responde normalmente.
    ```
13. **OpenClaude** (in-container) formatea el resultado con su personalidad y estilo
14. **bot.js** envia la respuesta final a Jose por Telegram
15. **Jose ve la respuesta** como si el bot lo hubiera hecho todo el mismo

---

## Configuracion de Variables de Entorno

| Variable | Donde | Default | Descripcion |
|----------|-------|---------|-------------|
| `DELEGATION_HOST` | Container (.env) | `http://host.docker.internal:3847` | URL del delegation service |
| `PORT` | Host (systemd) | `3847` | Puerto del delegation service |

---

## Troubleshooting

### El container no puede alcanzar el host

```bash
# Verificar que extra_hosts esta configurado
docker exec <container> cat /etc/hosts | grep host.docker
# Debe mostrar: 172.16.0.1  host.docker.internal

# Si no aparece, verificar docker-compose.yml tiene extra_hosts
```

### El delegation service no responde

```bash
# Verificar estado
systemctl status delegation-service

# Ver logs
journalctl -u delegation-service -f

# Reiniciar
systemctl restart delegation-service

# Test manual
curl -s http://localhost:3847/health
```

### OpenClaude falla con "dangerously-skip-permissions"

El servicio usa `--permission-mode dontAsk` porque `--dangerously-skip-permissions` no funciona con root. Si se cambia el usuario del servicio, se puede volver a usar `--dangerously-skip-permissions`.

### La delegacion no se activa

Verificar que:
1. El CLAUDE.md del bot tiene las instrucciones de delegacion
2. El bot.js tiene `handleDelegation()` integrado
3. OpenClaude recibio las instrucciones (puede requerir reinicio del proceso)

### Timeout en la delegacion

Default: 5 minutos. Para tareas mas largas, el bot puede especificar `timeout_ms` en el request. Maximo absoluto: 15 minutos.

---

## Seguridad

- El delegation service solo escucha en `0.0.0.0:3847` en el host
- Solo es accesible desde containers en la red `agents-net` via `host.docker.internal`
- No tiene autenticacion (los containers ya son de confianza)
- OpenClaude en el host tiene acceso completo al VPS — es equivalente a ejecutar OpenClaude CLI directamente
- El firewall del VPS debe bloquear el puerto 3847 desde internet (solo acceso local/docker)
