const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

// --- Load config ---
const CONFIG_PATH = path.join(__dirname, 'memory-config.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch (e) {
  console.error('[Memory] Failed to load memory-config.json, using defaults');
  config = {
    embedding: { provider: 'voyage', model: 'voyage-3-lite', dimensions: 512, batchSize: 20, cacheEnabled: true },
    search: { defaultLimit: 10, weights: { vector: 0.55, keyword: 0.30, recency: 0.15 }, temporalDecayHalfLifeDays: 14, mmrLambda: 0.7, minRelevanceScore: 0.25 },
    storage: { dataDir: '/app/data', memoryDir: '/app/data/memory', dbPath: '/app/data/maximus.db', conversationGapMs: 1800000, maxRecentMessages: 10 }
  };
}

const DATA_DIR = config.storage.dataDir;
const DB_PATH = config.storage.dbPath;
const MEMORY_DIR = config.storage.memoryDir;
const CONVERSATION_GAP_MS = config.storage.conversationGapMs;
const MAX_RECENT_MESSAGES = config.storage.maxRecentMessages;

const DIRS = ['canon', 'journal', 'user', 'decisions', 'project', 'inbox', 'inbox/archived', 'wiki', 'wiki/assertions'];
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY || '';

let db = null;
let currentConversationId = null;

// --- Embedding cache (in-memory) ---
const embeddingCache = new Map();

function init() {
  // Ensure directories exist
  for (const dir of DIRS) {
    fs.mkdirSync(path.join(MEMORY_DIR, dir), { recursive: true });
  }

  // Open/create SQLite database
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      summary TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      summarized INTEGER DEFAULT 0,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
  `);

  // FTS5 full-text search index
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(
        source,
        path,
        content,
        tags,
        tokenize='unicode61'
      );
    `);
  } catch (e) {
    console.error('[Memory] FTS5 not available:', e.message);
  }

  // --- Embeddings table for vector search ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      content_preview TEXT,
      embedding BLOB NOT NULL,
      dimensions INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_embeddings_hash ON embeddings(content_hash);
  `);

  // --- Wiki assertions table ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_assertions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      assertion TEXT NOT NULL,
      evidence TEXT,
      confidence REAL DEFAULT 0.8,
      source TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      superseded_by INTEGER,
      FOREIGN KEY (superseded_by) REFERENCES wiki_assertions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_topic ON wiki_assertions(topic);
  `);

  // Restore current conversation from last message
  const lastMsg = db.prepare('SELECT conversation_id, timestamp FROM messages ORDER BY id DESC LIMIT 1').get();
  if (lastMsg) {
    const gap = Date.now() - new Date(lastMsg.timestamp).getTime();
    if (gap < CONVERSATION_GAP_MS) {
      currentConversationId = lastMsg.conversation_id;
    }
  }

  console.log('[Memory] Initialized. DB:', DB_PATH, '| Embeddings:', VOYAGE_API_KEY ? 'Voyage AI ready' : 'NO API KEY');
}

// ═══════════════════════════════════════════════════════════════
// VOYAGE AI EMBEDDINGS
// ═══════════════════════════════════════════════════════════════

function voyageEmbed(texts) {
  if (!VOYAGE_API_KEY) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      input: texts,
      model: config.embedding.model,
      input_type: 'document'
    });

    const req = https.request({
      hostname: 'api.voyageai.com',
      path: '/v1/embeddings',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${VOYAGE_API_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.data && parsed.data.length > 0) {
            resolve(parsed.data.map(d => d.embedding));
          } else {
            console.error('[Embeddings] Voyage API error:', data.substring(0, 200));
            resolve(null);
          }
        } catch (e) {
          console.error('[Embeddings] Parse error:', e.message);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      console.error('[Embeddings] Request error:', e.message);
      resolve(null);
    });

    req.setTimeout(15000, () => {
      req.destroy();
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}

async function getEmbedding(text) {
  const hash = crypto.createHash('md5').update(text).digest('hex');

  // Check cache
  if (config.embedding.cacheEnabled && embeddingCache.has(hash)) {
    return embeddingCache.get(hash);
  }

  // Check DB
  const cached = db.prepare('SELECT embedding, dimensions FROM embeddings WHERE content_hash = ? LIMIT 1').get(hash);
  if (cached) {
    const vec = bufferToFloat32Array(cached.embedding);
    if (config.embedding.cacheEnabled) embeddingCache.set(hash, vec);
    return vec;
  }

  // Generate new embedding
  const embeddings = await voyageEmbed([text]);
  if (!embeddings || !embeddings[0]) return null;

  const vec = new Float32Array(embeddings[0]);

  // Store in DB
  const blob = float32ArrayToBuffer(vec);
  db.prepare(`
    INSERT INTO embeddings (source_type, source_id, content_hash, content_preview, embedding, dimensions, created_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('text', hash, hash, text.substring(0, 200), blob, vec.length, new Date().toISOString(), null);

  if (config.embedding.cacheEnabled) embeddingCache.set(hash, vec);
  return vec;
}

function float32ArrayToBuffer(arr) {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function bufferToFloat32Array(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ═══════════════════════════════════════════════════════════════
// HYBRID SEARCH (FTS5 + Vector + Temporal Decay)
// ═══════════════════════════════════════════════════════════════

async function searchSemantic(query, limit = null) {
  limit = limit || config.search.defaultLimit;
  const weights = config.search.weights;
  const results = [];

  // 1. FTS5 keyword search
  const keywordResults = searchFTS5(query, limit * 2);

  // 2. Vector search
  const vectorResults = await searchVectors(query, limit * 2);

  // 3. Merge results with scoring
  const allResults = new Map();

  for (const r of keywordResults) {
    const key = r.source + ':' + r.path;
    allResults.set(key, {
      ...r,
      keywordScore: r.score || 0.5,
      vectorScore: 0,
      recencyScore: 0
    });
  }

  for (const r of vectorResults) {
    const key = r.sourceType + ':' + r.sourceId;
    if (allResults.has(key)) {
      allResults.get(key).vectorScore = r.similarity;
    } else {
      allResults.set(key, {
        content: r.contentPreview,
        source: r.sourceType,
        path: r.sourceId,
        keywordScore: 0,
        vectorScore: r.similarity,
        recencyScore: 0
      });
    }
  }

  // 4. Add temporal decay
  const now = Date.now();
  const halfLife = config.search.temporalDecayHalfLifeDays * 86400000;

  for (const [key, r] of allResults) {
    // Try to extract timestamp from path/source
    const dateMatch = (r.path || '').match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      const age = now - new Date(dateMatch[1]).getTime();
      r.recencyScore = Math.pow(0.5, age / halfLife);
    } else {
      r.recencyScore = 0.5; // neutral if no date
    }

    // Final weighted score
    r.finalScore = (r.vectorScore * weights.vector) + (r.keywordScore * weights.keyword) + (r.recencyScore * weights.recency);
  }

  // 5. Sort by final score and apply MMR for diversity
  const sorted = [...allResults.values()]
    .filter(r => r.finalScore >= config.search.minRelevanceScore)
    .sort((a, b) => b.finalScore - a.finalScore);

  // Simple MMR: skip results too similar to already-selected ones
  const selected = [];
  for (const r of sorted) {
    if (selected.length >= limit) break;
    const isDuplicate = selected.some(s =>
      s.content && r.content && s.content.substring(0, 100) === r.content.substring(0, 100)
    );
    if (!isDuplicate) {
      selected.push(r);
    }
  }

  return selected;
}

function searchFTS5(query, limit) {
  try {
    const words = query.replace(/[^\w\sáéíóúñ]/gi, '').split(/\s+/).filter(w => w.length > 3).slice(0, 5);
    if (!words.length) return [];

    const ftsQuery = words.join(' OR ');
    const results = db.prepare(`
      SELECT source, path, content, tags, rank FROM memory_search
      WHERE memory_search MATCH ?
      ORDER BY rank LIMIT ?
    `).all(ftsQuery, limit);

    return results.map(r => ({ ...r, score: Math.min(1, Math.abs(r.rank || 0) / 10) }));
  } catch (e) {
    return [];
  }
}

async function searchVectors(query, limit) {
  if (!VOYAGE_API_KEY) return [];

  try {
    const queryVec = await getEmbedding(query);
    if (!queryVec) return [];

    // Get all embeddings (for small datasets this is fine, for large we'd need ANN)
    const allEmbeddings = db.prepare(`
      SELECT id, source_type, source_id, content_preview, embedding, dimensions, created_at
      FROM embeddings ORDER BY created_at DESC LIMIT 1000
    `).all();

    const scored = [];
    for (const row of allEmbeddings) {
      const vec = bufferToFloat32Array(row.embedding);
      const sim = cosineSimilarity(queryVec, vec);
      if (sim > 0.2) {
        scored.push({
          id: row.id,
          sourceType: row.source_type,
          sourceId: row.source_id,
          contentPreview: row.content_preview,
          similarity: sim,
          createdAt: row.created_at
        });
      }
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit);
  } catch (e) {
    console.error('[Embeddings] Vector search error:', e.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// WIKI SYSTEM — Assertions with evidence
// ═══════════════════════════════════════════════════════════════

function wikiAdd(topic, assertion, evidence = null, confidence = 0.8, source = 'conversation') {
  const now = new Date().toISOString();

  // Check for contradictions
  const existing = db.prepare(`
    SELECT id, assertion, confidence FROM wiki_assertions
    WHERE topic = ? AND superseded_by IS NULL
  `).all(topic);

  let contradicted = null;
  // Simple contradiction check: same topic, different assertion
  for (const ex of existing) {
    if (ex.assertion.toLowerCase().trim() === assertion.toLowerCase().trim()) {
      // Duplicate, update confidence
      db.prepare('UPDATE wiki_assertions SET confidence = ?, updated_at = ?, evidence = COALESCE(?, evidence) WHERE id = ?')
        .run(Math.min(1, confidence + 0.1), now, evidence, ex.id);
      console.log(`[Wiki] Updated existing assertion #${ex.id} for topic "${topic}"`);
      return { action: 'updated', id: ex.id };
    }
  }

  // Insert new assertion
  const result = db.prepare(`
    INSERT INTO wiki_assertions (topic, assertion, evidence, confidence, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(topic, assertion, evidence, confidence, source, now, now);

  // Write to wiki markdown
  writeWikiMarkdown(topic);

  console.log(`[Wiki] New assertion #${result.lastInsertRowid} for topic "${topic}"`);
  return { action: 'created', id: result.lastInsertRowid };
}

function wikiSearch(query, limit = 10) {
  return db.prepare(`
    SELECT id, topic, assertion, evidence, confidence, source, created_at
    FROM wiki_assertions
    WHERE superseded_by IS NULL
    AND (topic LIKE ? OR assertion LIKE ?)
    ORDER BY confidence DESC, updated_at DESC
    LIMIT ?
  `).all(`%${query}%`, `%${query}%`, limit);
}

function wikiGet(topic) {
  return db.prepare(`
    SELECT id, topic, assertion, evidence, confidence, source, created_at, updated_at
    FROM wiki_assertions
    WHERE topic = ? AND superseded_by IS NULL
    ORDER BY confidence DESC
  `).all(topic);
}

function wikiSupersede(oldId, newAssertion, evidence, confidence) {
  const now = new Date().toISOString();
  const old = db.prepare('SELECT topic FROM wiki_assertions WHERE id = ?').get(oldId);
  if (!old) return null;

  const result = db.prepare(`
    INSERT INTO wiki_assertions (topic, assertion, evidence, confidence, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'supersede', ?, ?)
  `).run(old.topic, newAssertion, evidence, confidence, now, now);

  db.prepare('UPDATE wiki_assertions SET superseded_by = ? WHERE id = ?')
    .run(result.lastInsertRowid, oldId);

  writeWikiMarkdown(old.topic);
  return { action: 'superseded', oldId, newId: result.lastInsertRowid };
}

function wikiListTopics() {
  return db.prepare(`
    SELECT topic, COUNT(*) as assertion_count, MAX(updated_at) as last_updated
    FROM wiki_assertions
    WHERE superseded_by IS NULL
    GROUP BY topic
    ORDER BY last_updated DESC
  `).all();
}

function writeWikiMarkdown(topic) {
  const assertions = wikiGet(topic);
  if (!assertions.length) return;

  const safeTopic = topic.replace(/[^a-zA-Z0-9áéíóúñ\s-]/g, '').replace(/\s+/g, '-').toLowerCase();
  const wikiPath = path.join(MEMORY_DIR, 'wiki', `${safeTopic}.md`);

  let md = `# ${topic}\n\n`;
  md += `_Última actualización: ${assertions[0].updated_at}_\n\n`;

  for (const a of assertions) {
    const confidence = Math.round(a.confidence * 100);
    md += `## ${a.assertion}\n`;
    md += `- **Confianza:** ${confidence}%\n`;
    if (a.evidence) md += `- **Evidencia:** ${a.evidence}\n`;
    md += `- **Fuente:** ${a.source} (${a.created_at.split('T')[0]})\n\n`;
  }

  fs.writeFileSync(wikiPath, md);
}

// ═══════════════════════════════════════════════════════════════
// LEGACY COMPATIBLE FUNCTIONS (updated)
// ═══════════════════════════════════════════════════════════════

function readMarkdownDir(dirName) {
  const dirPath = path.join(MEMORY_DIR, dirName);
  try {
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md')).sort();
    const sections = [];
    for (const file of files) {
      const content = fs.readFileSync(path.join(dirPath, file), 'utf-8').trim();
      if (content) {
        sections.push(`### ${file.replace('.md', '')}\n${content}`);
      }
    }
    return sections.join('\n\n');
  } catch (e) {
    return '';
  }
}

// Legacy search — now calls hybrid search internally
function searchRelevantHistory(query, limit = 5) {
  // Synchronous fallback for legacy callers
  return searchFTS5(query, limit);
}

// Async version with full semantic search
async function searchRelevantHistoryAsync(query, limit = 5) {
  return searchSemantic(query, limit);
}

function buildContext() {
  const parts = [];

  // 1. Recent conversation history
  const recentMessages = db.prepare(
    'SELECT role, content, timestamp FROM messages ORDER BY id DESC LIMIT ?'
  ).all(MAX_RECENT_MESSAGES).reverse();

  if (recentMessages.length > 0) {
    const history = recentMessages.map(m => {
      const time = new Date(m.timestamp).toLocaleTimeString('es-CR', { hour: '2-digit', minute: '2-digit' });
      const name = m.role === 'user' ? 'Jose' : 'Maximus';
      const content = m.content.length > 500 ? m.content.substring(0, 500) + '...' : m.content;
      return `[${time}] ${name}: ${content}`;
    }).join('\n');
    parts.push(`=== HISTORIAL RECIENTE ===\n${history}`);
  }

  // 2. Canon (consolidated truth)
  const canon = readMarkdownDir('canon');
  if (canon) {
    parts.push(`=== MEMORIA CORE ===\n${canon}`);
  }

  // 3. User preferences
  const user = readMarkdownDir('user');
  if (user) {
    parts.push(`=== PREFERENCIAS DE JOSE ===\n${user}`);
  }

  // 4. Project context
  const project = readMarkdownDir('project');
  if (project) {
    parts.push(`=== PROYECTOS ACTIVOS ===\n${project}`);
  }

  // 5. Decisions
  const decisions = readMarkdownDir('decisions');
  if (decisions) {
    parts.push(`=== DECISIONES CLAVE ===\n${decisions}`);
  }

  // 6. Wiki summaries (top assertions)
  const wikiTopics = wikiListTopics();
  if (wikiTopics.length > 0) {
    const wikiSummary = wikiTopics.slice(0, 10).map(t => {
      const assertions = wikiGet(t.topic).slice(0, 3);
      const lines = assertions.map(a => `  - ${a.assertion} (${Math.round(a.confidence * 100)}%)`);
      return `**${t.topic}:**\n${lines.join('\n')}`;
    }).join('\n');
    parts.push(`=== WIKI (Conocimiento Compilado) ===\n${wikiSummary}`);
  }

  return parts.join('\n\n');
}

// --- Self-write: parse [REMEMBER] blocks from Maximus responses ---
function extractAndSaveMemories(response) {
  const memoryPattern = /\[REMEMBER\]([\s\S]*?)\[\/REMEMBER\]/gi;
  const matches = [...response.matchAll(memoryPattern)];

  if (matches.length === 0) return response;

  const now = new Date();
  const timestamp = now.getTime();

  for (const match of matches) {
    const memoryContent = match[1].trim();
    if (!memoryContent) continue;

    const tipoMatch = memoryContent.match(/^tipo:\s*(\w+)/im);
    const confianzaMatch = memoryContent.match(/^confianza:\s*(\w+)/im);
    const tipo = tipoMatch ? tipoMatch[1] : 'general';
    const confianza = confianzaMatch ? confianzaMatch[1] : 'alta';

    const cleanContent = memoryContent
      .replace(/^tipo:\s*\w+\s*$/gim, '')
      .replace(/^confianza:\s*\w+\s*$/gim, '')
      .trim();

    const inboxPath = path.join(MEMORY_DIR, 'inbox', `${timestamp}-${tipo}.md`);
    const fileContent = `---\ntipo: ${tipo}\nconfianza: ${confianza}\nfecha: ${now.toISOString()}\nfuente: conversacion\n---\n\n${cleanContent}\n`;

    fs.writeFileSync(inboxPath, fileContent);
    console.log(`[Memory] Self-write: ${tipo} (${confianza}) -> ${inboxPath}`);

    // Also embed the memory for semantic search
    embedMemory('inbox', `${timestamp}-${tipo}`, cleanContent).catch(() => {});
  }

  return response.replace(memoryPattern, '').trim();
}

// --- Embed a piece of memory content ---
async function embedMemory(sourceType, sourceId, content) {
  if (!VOYAGE_API_KEY || !content || content.length < 20) return;

  try {
    await getEmbedding(content);
    // Re-store with proper source info
    const hash = crypto.createHash('md5').update(content).digest('hex');
    db.prepare('UPDATE embeddings SET source_type = ?, source_id = ? WHERE content_hash = ?')
      .run(sourceType, sourceId, hash);
  } catch (e) {
    console.error('[Embeddings] embedMemory error:', e.message);
  }
}

function saveExchange(userMessage, response) {
  const now = new Date();
  const timestamp = now.toISOString();

  const lastMsg = db.prepare('SELECT timestamp FROM messages ORDER BY id DESC LIMIT 1').get();
  if (!currentConversationId || !lastMsg || (now.getTime() - new Date(lastMsg.timestamp).getTime()) > CONVERSATION_GAP_MS) {
    currentConversationId = crypto.randomUUID();
    db.prepare('INSERT INTO conversations (id, started_at) VALUES (?, ?)').run(currentConversationId, timestamp);
    console.log(`[Memory] New conversation: ${currentConversationId}`);
  }

  const insert = db.prepare('INSERT INTO messages (conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?)');
  insert.run(currentConversationId, 'user', userMessage, timestamp);
  insert.run(currentConversationId, 'assistant', response, timestamp);

  // Index in FTS5
  try {
    const ftsInsert = db.prepare('INSERT INTO memory_search (source, path, content, tags) VALUES (?, ?, ?, ?)');
    ftsInsert.run('messages', `conversation:${currentConversationId}`, `Jose: ${userMessage}\nMaximus: ${response}`, '');
  } catch (e) { /* FTS5 unavailable */ }

  // Generate embeddings in background (non-blocking)
  const combinedText = `Jose: ${userMessage}\nMaximus: ${response}`;
  embedMemory('conversation', currentConversationId, combinedText).catch(() => {});

  // Append to daily journal
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toLocaleTimeString('es-CR', { hour: '2-digit', minute: '2-digit' });
  const journalPath = path.join(MEMORY_DIR, 'journal', `${dateStr}.md`);

  const userSnippet = userMessage.length > 150 ? userMessage.substring(0, 150) + '...' : userMessage;
  const responseSnippet = response.length > 150 ? response.substring(0, 150) + '...' : response;
  const journalEntry = `\n## ${timeStr}\n- **Jose**: ${userSnippet}\n- **Maximus**: ${responseSnippet}\n`;

  if (!fs.existsSync(journalPath)) {
    fs.writeFileSync(journalPath, `# Journal - ${dateStr}\n${journalEntry}`);
  } else {
    fs.appendFileSync(journalPath, journalEntry);
  }

  console.log(`[Memory] Exchange saved. Conversation: ${currentConversationId}`);
}

// --- Compaction flush: save critical context before compaction ---
function flushBeforeCompaction() {
  if (!config.compaction.flushBeforeCompaction) return;

  try {
    const recentMessages = db.prepare(
      'SELECT role, content, timestamp FROM messages ORDER BY id DESC LIMIT ?'
    ).all(config.compaction.preserveRecentMessages).reverse();

    if (recentMessages.length === 0) return;

    const now = new Date();
    const flushPath = path.join(MEMORY_DIR, 'inbox', `${now.getTime()}-compaction-flush.md`);

    let content = `---\ntipo: tecnico\nconfianza: alta\nfecha: ${now.toISOString()}\nfuente: compaction-flush\n---\n\n`;
    content += `# Contexto pre-compactación (${now.toISOString()})\n\n`;

    for (const m of recentMessages) {
      const name = m.role === 'user' ? 'Jose' : 'Maximus';
      const snippet = m.content.length > 300 ? m.content.substring(0, 300) + '...' : m.content;
      content += `- **${name}** (${m.timestamp}): ${snippet}\n`;
    }

    fs.writeFileSync(flushPath, content);
    console.log(`[Memory] Compaction flush saved: ${flushPath}`);
  } catch (e) {
    console.error('[Memory] Compaction flush error:', e.message);
  }
}

// --- Get messages for a specific date (for daily summary) ---
function getMessagesForDate(dateStr) {
  const startOfDay = `${dateStr}T00:00:00`;
  const endOfDay = `${dateStr}T23:59:59`;

  return db.prepare(`
    SELECT role, content, timestamp FROM messages
    WHERE timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC
  `).all(startOfDay, endOfDay);
}

function buildSummaryPrompt(dateStr) {
  const messages = getMessagesForDate(dateStr);
  if (messages.length === 0) return null;

  const conversation = messages.map(m => {
    const time = new Date(m.timestamp).toLocaleTimeString('es-CR', { hour: '2-digit', minute: '2-digit' });
    const name = m.role === 'user' ? 'Jose' : 'Maximus';
    const content = m.content.length > 800 ? m.content.substring(0, 800) + '...' : m.content;
    return `[${time}] ${name}: ${content}`;
  }).join('\n');

  return `Sos Maximus. Resumí las conversaciones del dia ${dateStr} en un journal ejecutivo en español.

Formato obligatorio:
# Journal - ${dateStr}

## Temas tratados
- (lista de temas)

## Decisiones tomadas
- (lista, o "Ninguna" si no hubo)

## Tareas pendientes
- (lista, o "Ninguna")

## Datos clave
- (preferencias, info tecnica, contactos mencionados)

## Sentimiento general
(una linea: productivo, relajado, urgente, etc)

---

Conversaciones del dia:
${conversation}`;
}

function saveDailySummary(dateStr, summary) {
  const journalPath = path.join(MEMORY_DIR, 'journal', `${dateStr}.md`);
  fs.writeFileSync(journalPath, summary);

  db.prepare(`
    UPDATE messages SET summarized = 1
    WHERE timestamp >= ? AND timestamp <= ? AND summarized = 0
  `).run(`${dateStr}T00:00:00`, `${dateStr}T23:59:59`);

  console.log(`[Memory] Daily summary saved: ${journalPath}`);
}

function needsSummary(dateStr) {
  const count = db.prepare(`
    SELECT COUNT(*) as cnt FROM messages
    WHERE timestamp >= ? AND timestamp <= ? AND summarized = 0
  `).get(`${dateStr}T00:00:00`, `${dateStr}T23:59:59`);

  return count && count.cnt > 0;
}

function getDb() {
  return db;
}

function getConfig() {
  return config;
}

module.exports = {
  init, buildContext, saveExchange, extractAndSaveMemories,
  searchRelevantHistory, searchRelevantHistoryAsync, searchSemantic,
  buildSummaryPrompt, saveDailySummary, needsSummary,
  getDb, getConfig,
  // Embeddings
  getEmbedding, embedMemory, voyageEmbed,
  // Wiki
  wikiAdd, wikiSearch, wikiGet, wikiSupersede, wikiListTopics,
  // Compaction
  flushBeforeCompaction,
  // Constants
  MEMORY_DIR, DATA_DIR
};
