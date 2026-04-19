const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const OPENCLAUDE_BIN = '/usr/local/bin/openclaude';
const DERIVER_TIMEOUT_MS = 120000; // 2 min max for deriver tasks

let isRunning = false;
let pendingQueue = [];

// --- Call OpenClaude CLI for deriver tasks (lightweight, no tools needed) ---
function callLLM(prompt) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--permission-mode', 'bypassPermissions',
      '--model', process.env.OPENCLAUDE_MODEL || 'sonnet',
      '--effort', 'low',
      '--output-format', 'stream-json',
      '--no-session-persistence',
      prompt
    ];

    const child = spawn(OPENCLAUDE_BIN, args, {
      env: { ...process.env, CLAUDECODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    child.stdin.end();

    let buffer = '';
    let result = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
    }, DERIVER_TIMEOUT_MS);

    child.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'result') result = event.result || '';
        } catch (e) { /* skip */ }
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) { reject(new Error('Deriver LLM timed out')); return; }
      resolve(result.trim());
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// --- Run deriver on a completed conversation ---
async function run(conversationId) {
  if (isRunning) {
    pendingQueue.push(conversationId);
    console.log(`[Deriver] Queued conversation ${conversationId} (deriver busy)`);
    return;
  }

  isRunning = true;
  console.log(`[Deriver] Analyzing conversation ${conversationId}...`);

  try {
    const memory = require('./memory');
    const db = memory.getDb();

    // Get messages for this conversation
    const messages = db.prepare(
      'SELECT role, content, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC'
    ).all(conversationId);

    if (messages.length < 4) { // Less than 2 exchanges, skip
      console.log(`[Deriver] Conversation too short (${messages.length} msgs), skipping`);
      return;
    }

    const transcript = messages.map(m => {
      const name = m.role === 'user' ? 'Jose' : 'Maximus';
      return `${name}: ${m.content}`;
    }).join('\n\n');

    // Ask LLM to extract insights
    const prompt = `Analizá esta conversación entre Jose y Maximus. Extraé información útil.

RESPONDE SOLO EN JSON VÁLIDO, sin markdown ni backticks. El formato exacto:
{
  "profile_updates": {
    "comunicacion": "observaciones sobre cómo se comunica Jose (o null si no hay cambio)",
    "intereses": "temas que le interesan (o null)",
    "estado_animo": "cómo se siente (o null)",
    "trabajo": "patrones de trabajo (o null)"
  },
  "decisions": ["decisión tomada 1", "decisión 2"],
  "key_facts": ["dato importante 1", "dato 2"]
}

Si no hay nada relevante en una categoría, usá null o array vacío.

Conversación:
${transcript.substring(0, 6000)}`;

    const response = await callLLM(prompt);

    // Parse JSON response - strip any format prefix
    const cleanResponse = response.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();
    let insights;
    try {
      // Try to extract JSON from response
      const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.log('[Deriver] No JSON found in response');
        return;
      }
      insights = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error('[Deriver] Failed to parse insights:', parseErr.message);
      return;
    }

    // Update profile
    if (insights.profile_updates) {
      await updateProfile(insights.profile_updates);
    }

    // Save decisions
    if (insights.decisions && insights.decisions.length > 0) {
      saveDecisions(insights.decisions);
    }

    // Consolidate inbox
    consolidateInbox();

    console.log(`[Deriver] Conversation ${conversationId} analyzed successfully`);
  } catch (err) {
    console.error(`[Deriver Error]`, err.message);
  } finally {
    isRunning = false;
    // Process pending queue
    if (pendingQueue.length > 0) {
      const next = pendingQueue.shift();
      run(next).catch(err => console.error('[Deriver Queue Error]', err.message));
    }
  }
}

// --- Run daily deriver after summary ---
async function runDaily(dateStr) {
  console.log(`[Deriver] Running daily analysis for ${dateStr}...`);
  try {
    const memory = require('./memory');
    const messages = memory.getMessagesForDate(dateStr);

    if (messages.length < 4) {
      console.log('[Deriver] Not enough messages for daily analysis');
      return;
    }

    // Group by conversations and run deriver on each
    const db = memory.getDb();
    const conversations = db.prepare(
      'SELECT DISTINCT conversation_id FROM messages WHERE timestamp >= ? AND timestamp <= ?'
    ).all(`${dateStr}T00:00:00`, `${dateStr}T23:59:59`);

    for (const conv of conversations) {
      await run(conv.conversation_id);
    }

    console.log(`[Deriver] Daily analysis complete for ${dateStr}`);
  } catch (err) {
    console.error('[Deriver Daily Error]', err.message);
  }
}

// --- Update Jose's evolving profile ---
async function updateProfile(updates) {
  const memory = require('./memory');
  const profilePath = path.join(memory.MEMORY_DIR, 'user', 'jose-profile.md');

  let currentProfile = '';
  try {
    currentProfile = fs.readFileSync(profilePath, 'utf-8');
  } catch (e) {
    currentProfile = `# Perfil Evolutivo de Jose Navarro
Ultima actualizacion: ${new Date().toISOString().split('T')[0]}

## Patrones de comunicacion
(sin datos aún)

## Intereses y temas frecuentes
(sin datos aún)

## Estado de animo reciente
(sin datos aún)

## Patrones de trabajo
(sin datos aún)
`;
  }

  // Merge updates into profile
  const now = new Date().toISOString().split('T')[0];
  let updated = currentProfile.replace(/Ultima actualizacion: .+/, `Ultima actualizacion: ${now}`);

  if (updates.comunicacion) {
    updated = mergeSection(updated, 'Patrones de comunicacion', updates.comunicacion);
  }
  if (updates.intereses) {
    updated = mergeSection(updated, 'Intereses y temas frecuentes', updates.intereses);
  }
  if (updates.estado_animo) {
    updated = mergeSection(updated, 'Estado de animo reciente', updates.estado_animo);
  }
  if (updates.trabajo) {
    updated = mergeSection(updated, 'Patrones de trabajo', updates.trabajo);
  }

  fs.writeFileSync(profilePath, updated);
  console.log('[Deriver] Profile updated:', profilePath);
}

function mergeSection(markdown, sectionName, newContent) {
  const regex = new RegExp(`(## ${sectionName}\n)([\\s\\S]*?)(?=\n## |$)`);
  const match = markdown.match(regex);

  if (match) {
    const existing = match[2].trim();
    if (existing === '(sin datos aún)') {
      return markdown.replace(regex, `$1- ${newContent}\n\n`);
    }
    // Append if not duplicate
    if (!existing.includes(newContent.substring(0, 30))) {
      return markdown.replace(regex, `$1${existing}\n- ${newContent}\n\n`);
    }
  }
  return markdown;
}

// --- Save decisions ---
function saveDecisions(decisions) {
  if (decisions.length === 0) return;
  const memory = require('./memory');
  const decisionsDir = path.join(memory.MEMORY_DIR, 'decisions');
  const dateStr = new Date().toISOString().split('T')[0];
  const filePath = path.join(decisionsDir, `${dateStr}.md`);

  const content = decisions.map(d => `- ${d}`).join('\n');

  if (fs.existsSync(filePath)) {
    fs.appendFileSync(filePath, '\n' + content);
  } else {
    fs.writeFileSync(filePath, `# Decisiones - ${dateStr}\n\n${content}\n`);
  }
  console.log(`[Deriver] ${decisions.length} decision(s) saved`);
}

// --- Consolidate inbox items ---
function consolidateInbox() {
  const memory = require('./memory');
  const inboxDir = path.join(memory.MEMORY_DIR, 'inbox');
  const archivedDir = path.join(memory.MEMORY_DIR, 'inbox', 'archived');

  try {
    const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md'));
    if (files.length === 0) return;

    const typeToDir = {
      preferencia: 'user',
      decision: 'decisions',
      proyecto: 'project',
      tecnico: 'canon',
      contacto: 'user',
      general: 'canon'
    };

    for (const file of files) {
      const filePath = path.join(inboxDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');

      // Extract tipo from frontmatter
      const tipoMatch = content.match(/^tipo:\s*(\w+)/im);
      const tipo = tipoMatch ? tipoMatch[1] : 'general';
      const targetDir = typeToDir[tipo] || 'canon';

      // Extract clean content (after frontmatter)
      const bodyMatch = content.match(/---[\s\S]*?---\n+([\s\S]*)/);
      const body = bodyMatch ? bodyMatch[1].trim() : content;

      if (body.length < 10) {
        // Too short, just archive
        fs.renameSync(filePath, path.join(archivedDir, file));
        continue;
      }

      // Append to consolidated file in target dir
      const targetPath = path.join(memory.MEMORY_DIR, targetDir, `consolidated-${tipo}.md`);
      const entry = `\n### ${new Date().toISOString().split('T')[0]}\n${body}\n`;

      if (fs.existsSync(targetPath)) {
        fs.appendFileSync(targetPath, entry);
      } else {
        fs.writeFileSync(targetPath, `# ${tipo.charAt(0).toUpperCase() + tipo.slice(1)} consolidado\n${entry}`);
      }

      // Move to archived
      fs.renameSync(filePath, path.join(archivedDir, file));
      console.log(`[Deriver] Inbox item ${file} -> ${targetDir}/`);
    }
  } catch (err) {
    console.error('[Deriver] Consolidate error:', err.message);
  }
}

module.exports = { run, runDaily };
