/**
 * linear.js — Integración de Linear con Maximus
 *
 * Flujo:
 *  1. Cada 2 min polling a Linear buscando issues con label "maximus" (o asignados a LINEAR_ASSIGNEE)
 *  2. Por cada issue nuevo (no procesado aún):
 *     a. Marcar como procesándose en SQLite
 *     b. Enviar a OpenClaude para ejecutar la tarea
 *     c. Comentar el resultado en el issue de Linear
 *     d. Mover el issue a "Done"
 *     e. Notificar a Jose por Telegram
 */

const axios = require('axios');

const LINEAR_API = 'https://api.linear.app/graphql';
const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutos

// ─────────────────────────────────────────────
// GraphQL helper
// ─────────────────────────────────────────────
async function gql(apiKey, query, variables = {}) {
  const res = await axios.post(
    LINEAR_API,
    { query, variables },
    {
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  if (res.data.errors) {
    throw new Error(`Linear API errors: ${JSON.stringify(res.data.errors)}`);
  }
  return res.data.data;
}

// ─────────────────────────────────────────────
// Queries & Mutations
// ─────────────────────────────────────────────

/** Obtiene issues con label "maximus" que no estén completed/cancelled */
async function fetchPendingIssues(apiKey) {
  const data = await gql(apiKey, `
    query GetMaximusIssues {
      issues(
        filter: {
          labels: { name: { eqIgnoreCase: "maximus" } }
          state: { type: { notIn: ["completed", "cancelled"] } }
        }
        first: 10
        orderBy: updatedAt
      ) {
        nodes {
          id
          identifier
          title
          description
          priority
          state { id name type }
          team  { id name }
          assignee { name email }
        }
      }
    }
  `);
  return data?.issues?.nodes ?? [];
}

/** Agrega un comentario a un issue */
async function addComment(apiKey, issueId, body) {
  const data = await gql(apiKey, `
    mutation CreateComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
        comment { id }
      }
    }
  `, { issueId, body });

  return data?.commentCreate?.success;
}

/** Busca el estado "Done/Completed" del equipo */
async function getCompletedState(apiKey, teamId) {
  const data = await gql(apiKey, `
    query GetCompletedState($teamId: String!) {
      workflowStates(
        filter: {
          team: { id: { eq: $teamId } }
          type: { eq: "completed" }
        }
        first: 1
      ) {
        nodes { id name }
      }
    }
  `, { teamId });

  return data?.workflowStates?.nodes?.[0] ?? null;
}

/** Mueve un issue a un estado específico */
async function updateIssueState(apiKey, issueId, stateId) {
  const data = await gql(apiKey, `
    mutation UpdateState($issueId: String!, $stateId: String!) {
      issueUpdate(id: $issueId, input: { stateId: $stateId }) {
        success
        issue { id state { name } }
      }
    }
  `, { issueId, stateId });

  return data?.issueUpdate?.success;
}

// ─────────────────────────────────────────────
// Issue → Prompt para OpenClaude
// ─────────────────────────────────────────────

function buildIssuePrompt(issue) {
  const priorityLabel = { 0: 'Sin prioridad', 1: 'Urgente', 2: 'Alta', 3: 'Media', 4: 'Baja' };
  const priority = priorityLabel[issue.priority] ?? 'Sin prioridad';

  const description = issue.description
    ? `\n\nDescripción:\n${issue.description}`
    : '';

  return `[Este mensaje viene de texto de Jose] [TAREA DE LINEAR]

Identificador: ${issue.identifier}
Equipo: ${issue.team?.name ?? 'Sin equipo'}
Prioridad: ${priority}
Estado actual: ${issue.state?.name ?? 'Desconocido'}

Título: ${issue.title}${description}

---
Ejecutá esta tarea como CEO Virtual. Sé concreto y accionable.
Si la tarea requiere código o comandos, incluyelos.
Tu respuesta será publicada como comentario en este issue de Linear.`;
}

// ─────────────────────────────────────────────
// Módulo principal
// ─────────────────────────────────────────────

/**
 * Inicia el poller de Linear.
 *
 * @param {object} opts
 * @param {string}   opts.apiKey         - Linear API key (lin_api_...)
 * @param {Database} opts.db             - Instancia de better-sqlite3
 * @param {Function} opts.callOpenClaude - (prompt: string) => Promise<string>
 * @param {Function} opts.notifyJose     - (text: string) => Promise<void>  (envía mensaje por Telegram)
 */
function start({ apiKey, db, callOpenClaude, notifyJose }) {
  if (!apiKey) {
    console.log('[Linear] LINEAR_API_KEY no configurado — integración deshabilitada.');
    return;
  }

  // Crear tabla de tracking si no existe
  db.exec(`
    CREATE TABLE IF NOT EXISTS linear_issues (
      id          TEXT PRIMARY KEY,
      identifier  TEXT,
      title       TEXT,
      processed_at INTEGER,
      status      TEXT DEFAULT 'pending',
      result      TEXT
    );
  `);

  console.log('[Linear] Integración iniciada. Polling cada 2 min.');

  // Función que ejecuta el ciclo completo
  async function poll() {
    try {
      const issues = await fetchPendingIssues(apiKey);

      if (issues.length === 0) {
        console.log('[Linear] Sin issues pendientes.');
        return;
      }

      console.log(`[Linear] ${issues.length} issue(s) encontrados.`);

      for (const issue of issues) {
        // ¿Ya lo procesamos?
        const existing = db.prepare('SELECT id, status FROM linear_issues WHERE id = ?').get(issue.id);
        if (existing && existing.status !== 'error') {
          continue; // ya procesado (o en proceso)
        }

        console.log(`[Linear] Procesando ${issue.identifier}: "${issue.title}"`);

        // Marcar como "in_progress" para no procesarlo dos veces
        db.prepare(`
          INSERT OR REPLACE INTO linear_issues (id, identifier, title, processed_at, status)
          VALUES (?, ?, ?, ?, 'in_progress')
        `).run(issue.id, issue.identifier, issue.title, Date.now());

        try {
          // Notificar a Jose que arrancamos
          await notifyJose(
            `🔄 *Linear ${issue.identifier}*\n` +
            `Ejecutando: _${issue.title}_`
          );

          // Enviar a OpenClaude
          const prompt = buildIssuePrompt(issue);
          const rawResponse = await callOpenClaude(prompt);

          // Limpiar prefijos [AUDIO]/[TEXTO] y bloques [REMEMBER]
          let result = rawResponse
            .replace(/^\[(AUDIO|TEXTO)\]\s*/i, '')
            .replace(/\[REMEMBER\][\s\S]*?\[\/REMEMBER\]/gi, '')
            .trim();

          // Comentar en Linear
          const comment = `**Maximus ejecutó esta tarea ✅**\n\n${result}\n\n---\n*Ejecutado automáticamente por Maximus el ${new Date().toLocaleString('es-CR', { timeZone: 'America/Costa_Rica' })}*`;
          await addComment(apiKey, issue.id, comment);

          // Mover a Done
          const doneState = await getCompletedState(apiKey, issue.team.id);
          if (doneState) {
            await updateIssueState(apiKey, issue.id, doneState.id);
          }

          // Guardar en SQLite
          db.prepare(`
            UPDATE linear_issues SET status = 'done', result = ?, processed_at = ?
            WHERE id = ?
          `).run(result.substring(0, 1000), Date.now(), issue.id);

          // Notificar a Jose con el resultado
          const preview = result.length > 800 ? result.substring(0, 800) + '...' : result;
          await notifyJose(
            `✅ *Linear ${issue.identifier} completado*\n` +
            `_${issue.title}_\n\n${preview}`
          );

          console.log(`[Linear] ${issue.identifier} completado.`);

        } catch (taskErr) {
          console.error(`[Linear] Error procesando ${issue.identifier}:`, taskErr.message);
          db.prepare(`UPDATE linear_issues SET status = 'error', result = ? WHERE id = ?`)
            .run(taskErr.message, issue.id);

          try {
            await addComment(apiKey, issue.id,
              `⚠️ **Maximus tuvo un error ejecutando esta tarea**\n\n\`${taskErr.message}\`\n\nRevisalo con Jose.`
            );
          } catch (commentErr) {
            console.error('[Linear] No se pudo comentar el error:', commentErr.message);
          }

          await notifyJose(
            `⚠️ *Linear ${issue.identifier} — error*\n` +
            `_${issue.title}_\n\n\`${taskErr.message}\``
          );
        }
      }

    } catch (pollErr) {
      console.error('[Linear] Error en polling:', pollErr.message);
    }
  }

  // Primer poll al arrancar
  poll();

  // Polling periódico
  setInterval(poll, POLL_INTERVAL_MS);
}

module.exports = { start };
