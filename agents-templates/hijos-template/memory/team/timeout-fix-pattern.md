---
name: Patrón correcto de timeout para agentes
description: NUNCA matar proceso por timeout. Usar notify cada 3min + safety net 30min. Aplica a todos los agentes.
type: feedback
---

# Patrón correcto de timeout para agentes (OpenClaude CLI persistente)

**Regla:** NUNCA usar un timeout que mate el proceso de OpenClaude. Las tareas largas son legítimas.

## Lo correcto (implementado en Maximus y Optimus)
- `setInterval` cada 3 minutos que manda `typing` action al chat (el usuario ve que está vivo)
- Safety net de 30 minutos — solo si lleva 30min sin responder, ahí sí mata (algo está realmente trabado)
- Constantes: `OPENCLAUDE_HARD_TIMEOUT_MS = 30 * 60 * 1000` y `OPENCLAUDE_NOTIFY_INTERVAL_MS = 3 * 60 * 1000`
- Usar `clearInterval(pendingTimeout)` (no clearTimeout) porque es un interval

## Lo que NO se debe hacer
- Timeout de 2 o 5 minutos que mate el proceso — destruye trabajo legítimo
- `setTimeout` que haga reject+kill — esto corta tareas complejas a la mitad
- Reducir el timeout pensando que es "más rápido" — solo causa más crashes y respawns

## Lógica en callMaximus() / callOptimus()
```javascript
const notifyStart = Date.now();
pendingTimeout = setInterval(() => {
  const elapsed = Math.floor((Date.now() - notifyStart) / 1000);
  const mins = Math.floor(elapsed / 60);
  if (elapsed > OPENCLAUDE_HARD_TIMEOUT_MS / 1000) {
    clearInterval(pendingTimeout);
    // solo aquí mata — después de 30 min
    rej(new Error(`OpenClaude hard timeout (${mins} min)`));
    return;
  }
  safeSendChatAction(chatId, 'typing');
  console.log(`[OpenClaude] Still working... (${mins}m ${elapsed % 60}s)`);
}, OPENCLAUDE_NOTIFY_INTERVAL_MS);
```

**Why:** El timeout de 5min que mataba el proceso causaba que los agentes parecieran "pegados" o "muertos" cuando en realidad estaban trabajando en tareas legítimas. Jose se frustraba porque parecían fantasmas.

**How to apply:** Cuando crees o modifiques agentes, SIEMPRE usa este patrón. Cuando te pidan sugerencias de fix para timeout, recomienda este approach — no reducir el timeout.
