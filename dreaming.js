/**
 * Dreaming Module — 3-phase memory consolidation
 *
 * Phase 1 (Light): Categorize and tag recent memories
 * Phase 2 (REM): Connect related memories, find patterns
 * Phase 3 (Deep): Promote to long-term canon, prune duplicates
 *
 * Runs via cron at 3 AM (configured in memory-config.json)
 * Writes results to DREAMS.md
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const OPENCLAUDE_BIN = '/usr/local/bin/openclaude';
const DREAMING_TIMEOUT_MS = 300000; // 5 min max

let isDreaming = false;

function getMemory() {
  return require('./memory');
}

function getConfig() {
  return getMemory().getConfig();
}

// --- Scoring weights (OpenClaw spec) ---
function scoreMemory(memory, allMemories) {
  const config = getConfig();
  const weights = config.dreaming.scoring;
  const now = Date.now();

  // Frequency: how often this topic appears
  const contentLower = (memory.content || '').toLowerCase();
  const words = contentLower.split(/\s+/).filter(w => w.length > 4).slice(0, 10);
  let frequencyHits = 0;
  for (const other of allMemories) {
    if (other === memory) continue;
    const otherLower = (other.content || '').toLowerCase();
    for (const word of words) {
      if (otherLower.includes(word)) { frequencyHits++; break; }
    }
  }
  const frequency = Math.min(1, frequencyHits / Math.max(1, allMemories.length) * 3);

  // Relevance: content length and substance (proxy)
  const relevance = Math.min(1, (memory.content || '').length / 500);

  // Recency: time decay
  let recency = 0.5;
  if (memory.timestamp) {
    const age = now - new Date(memory.timestamp).getTime();
    const dayAge = age / 86400000;
    recency = Math.max(0, 1 - (dayAge / 30)); // decay over 30 days
  }

  // Importance: keywords that signal importance
  const importanceKeywords = ['decision', 'decidió', 'importante', 'crítico', 'urgente', 'siempre', 'nunca', 'regla', 'cambio', 'nuevo', 'fix', 'error', 'bug', 'deploy'];
  let importance = 0;
  for (const kw of importanceKeywords) {
    if (contentLower.includes(kw)) importance += 0.15;
  }
  importance = Math.min(1, importance);

  // Emotional: emotional markers
  const emotionalKeywords = ['!', '❤', 'gracias', 'perfecto', 'excelente', 'frustrado', 'enojado', 'feliz', 'triste', 'preocupado', 'contento'];
  let emotional = 0;
  for (const kw of emotionalKeywords) {
    if (contentLower.includes(kw)) emotional += 0.2;
  }
  emotional = Math.min(1, emotional);

  // Uniqueness: inverse of frequency
  const uniqueness = 1 - frequency;

  // Weighted final score
  const score = (frequency * weights.frequency) +
                (relevance * weights.relevance) +
                (recency * weights.recency) +
                (importance * weights.importance) +
                (emotional * weights.emotional) +
                (uniqueness * weights.uniqueness);

  return { score, frequency, relevance, recency, importance, emotional, uniqueness };
}

// --- Phase 1: Light — Categorize recent memories ---
async function phaseLight() {
  console.log('[Dreaming] Phase 1 (Light): Categorizing recent memories...');
  const memory = getMemory();
  const db = memory.getDb();

  // Get unsummarized messages from last 24h
  const yesterday = new Date(Date.now() - 86400000).toISOString();
  const recentMessages = db.prepare(`
    SELECT id, role, content, timestamp, conversation_id
    FROM messages WHERE timestamp >= ? AND summarized = 0
    ORDER BY timestamp ASC
  `).all(yesterday);

  if (recentMessages.length < (getConfig().dreaming.phases.light.minMessages || 4)) {
    console.log(`[Dreaming] Light: Only ${recentMessages.length} messages, skipping`);
    return { messagesProcessed: 0, categories: [] };
  }

  // Score each exchange
  const exchanges = [];
  for (let i = 0; i < recentMessages.length - 1; i += 2) {
    if (recentMessages[i].role === 'user' && recentMessages[i + 1]?.role === 'assistant') {
      const combined = `${recentMessages[i].content}\n${recentMessages[i + 1].content}`;
      exchanges.push({
        content: combined,
        timestamp: recentMessages[i].timestamp,
        userMsg: recentMessages[i].content,
        assistantMsg: recentMessages[i + 1].content,
        ids: [recentMessages[i].id, recentMessages[i + 1].id]
      });
    }
  }

  // Score all exchanges
  const scored = exchanges.map(e => ({
    ...e,
    scoring: scoreMemory(e, exchanges)
  }));

  // Generate embeddings for unembedded messages
  for (const ex of scored) {
    if (ex.scoring.score > 0.3) {
      await memory.embedMemory('exchange', ex.timestamp, ex.content).catch(() => {});
    }
  }

  console.log(`[Dreaming] Light: Processed ${exchanges.length} exchanges, embedded ${scored.filter(s => s.scoring.score > 0.3).length}`);
  return { messagesProcessed: exchanges.length, scored };
}

// --- Phase 2: REM — Connect related memories, find patterns ---
async function phaseREM(lightResults) {
  console.log('[Dreaming] Phase 2 (REM): Finding patterns and connections...');
  const memory = getMemory();

  if (!lightResults.scored || lightResults.scored.length === 0) {
    console.log('[Dreaming] REM: No scored exchanges from Light phase');
    return { patterns: [], connections: 0 };
  }

  // Find top exchanges worth connecting
  const topExchanges = lightResults.scored
    .filter(s => s.scoring.score > 0.3)
    .sort((a, b) => b.scoring.score - a.scoring.score)
    .slice(0, 10);

  if (topExchanges.length < (getConfig().dreaming.phases.rem.minConnections || 2)) {
    console.log('[Dreaming] REM: Not enough high-score exchanges for pattern detection');
    return { patterns: [], connections: 0 };
  }

  // Use semantic search to find connections between top exchanges
  const connections = [];
  for (const ex of topExchanges.slice(0, 5)) {
    const query = ex.userMsg.substring(0, 200);
    const related = await memory.searchSemantic(query, 3);
    if (related.length > 0) {
      connections.push({
        source: ex.userMsg.substring(0, 100),
        related: related.map(r => (r.content || '').substring(0, 100)),
        score: ex.scoring.score
      });
    }
  }

  // Use LLM to extract patterns (if enough connections)
  let patterns = [];
  if (connections.length >= 2) {
    try {
      const connectionsText = connections.map((c, i) =>
        `${i + 1}. "${c.source}" → relacionado con: ${c.related.join(', ')}`
      ).join('\n');

      const prompt = `Analizá estas conexiones entre memorias de conversaciones entre Jose y Maximus.
Extraé PATRONES y TEMAS RECURRENTES en JSON:
{"patterns": ["patron 1", "patron 2"], "recurring_topics": ["tema 1", "tema 2"]}

Conexiones:
${connectionsText}

Respondé SOLO el JSON, sin markdown.`;

      const response = await callDreamerLLM(prompt);
      if (response) {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          patterns = parsed.patterns || [];
        }
      }
    } catch (e) {
      console.error('[Dreaming] REM LLM error:', e.message);
    }
  }

  console.log(`[Dreaming] REM: Found ${connections.length} connections, ${patterns.length} patterns`);
  return { patterns, connections: connections.length };
}

// --- Phase 3: Deep — Promote to long-term canon ---
async function phaseDeep(lightResults, remResults) {
  console.log('[Dreaming] Phase 3 (Deep): Promoting to long-term memory...');
  const memory = getMemory();
  const config = getConfig();
  const threshold = config.dreaming.phases.deep.promotionThreshold;

  if (!lightResults.scored) {
    console.log('[Dreaming] Deep: No scored data');
    return { promoted: 0, pruned: 0 };
  }

  // Promote high-scoring exchanges to canon
  const toPromote = lightResults.scored
    .filter(s => s.scoring.score >= threshold)
    .sort((a, b) => b.scoring.score - a.scoring.score)
    .slice(0, 5);

  let promoted = 0;
  for (const ex of toPromote) {
    // Add to wiki as assertion
    const topic = extractTopic(ex.userMsg);
    if (topic) {
      memory.wikiAdd(
        topic,
        ex.assistantMsg.substring(0, 500),
        `Conversación del ${ex.timestamp.split('T')[0]}`,
        ex.scoring.score,
        'dreaming-deep'
      );
      promoted++;
    }
  }

  // Prune duplicates in wiki
  const db = memory.getDb();
  const allTopics = memory.wikiListTopics();
  let pruned = 0;

  for (const topic of allTopics) {
    const assertions = memory.wikiGet(topic.topic);
    if (assertions.length > 5) {
      // Keep top 5 by confidence, supersede the rest
      const toKeep = assertions.slice(0, 5);
      const toRemove = assertions.slice(5);
      for (const old of toRemove) {
        db.prepare('UPDATE wiki_assertions SET superseded_by = ? WHERE id = ?')
          .run(toKeep[0].id, old.id);
        pruned++;
      }
    }
  }

  // Add patterns to canon if any
  if (remResults.patterns && remResults.patterns.length > 0) {
    const patternsPath = path.join(memory.MEMORY_DIR, 'canon', 'patterns.md');
    const dateStr = new Date().toISOString().split('T')[0];
    let content = '';

    if (fs.existsSync(patternsPath)) {
      content = fs.readFileSync(patternsPath, 'utf-8');
    } else {
      content = '# Patrones detectados por Dreaming\n';
    }

    content += `\n## ${dateStr}\n`;
    for (const p of remResults.patterns) {
      if (!content.includes(p)) {
        content += `- ${p}\n`;
      }
    }
    fs.writeFileSync(patternsPath, content);
  }

  console.log(`[Dreaming] Deep: Promoted ${promoted} to wiki, pruned ${pruned} duplicates`);
  return { promoted, pruned };
}

// --- Extract topic from user message ---
function extractTopic(message) {
  if (!message || message.length < 10) return null;

  // Simple topic extraction: first significant noun phrase
  const cleaned = message.replace(/[¿?¡!]/g, '').trim();
  const words = cleaned.split(/\s+/).filter(w => w.length > 3);

  if (words.length === 0) return null;
  if (words.length <= 3) return words.join(' ');

  // Take first 3-4 significant words
  return words.slice(0, 4).join(' ');
}

// --- Call LLM for dreaming analysis ---
function callDreamerLLM(prompt) {
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
    }, DREAMING_TIMEOUT_MS);

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

    child.on('close', () => {
      clearTimeout(timer);
      if (killed) { resolve(null); return; }
      // Strip [AUDIO]/[TEXTO] prefix
      const clean = result.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();
      resolve(clean);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

// --- Main dreaming cycle ---
async function dream() {
  if (isDreaming) {
    console.log('[Dreaming] Already dreaming, skipping');
    return;
  }

  isDreaming = true;
  const startTime = Date.now();
  console.log('[Dreaming] === DREAM CYCLE STARTED ===');

  try {
    // Phase 1: Light
    const lightResults = await phaseLight();

    // Phase 2: REM
    const remResults = await phaseREM(lightResults);

    // Phase 3: Deep
    const deepResults = await phaseDeep(lightResults, remResults);

    // Write DREAMS.md log
    writeDreamsLog(lightResults, remResults, deepResults, startTime);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Dreaming] === DREAM CYCLE COMPLETE (${elapsed}s) ===`);

  } catch (err) {
    console.error('[Dreaming] Dream cycle error:', err.message);
  } finally {
    isDreaming = false;
  }
}

// --- Write DREAMS.md ---
function writeDreamsLog(light, rem, deep, startTime) {
  const memory = getMemory();
  const dreamsPath = path.join(memory.MEMORY_DIR, 'DREAMS.md');
  const dateStr = new Date().toISOString().split('T')[0];
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  let entry = `\n## ${dateStr} — Dream Cycle\n`;
  entry += `- **Duración:** ${elapsed}s\n`;
  entry += `- **Light:** ${light.messagesProcessed} mensajes procesados\n`;
  entry += `- **REM:** ${rem.connections} conexiones, ${(rem.patterns || []).length} patrones\n`;
  entry += `- **Deep:** ${deep.promoted} promovidos a wiki, ${deep.pruned} podados\n`;

  if (rem.patterns && rem.patterns.length > 0) {
    entry += `- **Patrones detectados:**\n`;
    for (const p of rem.patterns) {
      entry += `  - ${p}\n`;
    }
  }
  entry += '\n';

  let existing = '';
  try {
    existing = fs.readFileSync(dreamsPath, 'utf-8');
  } catch (e) {
    existing = '# DREAMS.md — Log de ciclos de sueño\n\nRegistro automático de consolidación de memoria.\n';
  }

  fs.writeFileSync(dreamsPath, existing + entry);
  console.log(`[Dreaming] DREAMS.md updated`);
}

module.exports = { dream, scoreMemory, phaseLight, phaseREM, phaseDeep };
