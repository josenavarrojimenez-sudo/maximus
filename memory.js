const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = '/app/data';
const DB_PATH = path.join(DATA_DIR, 'maximus.db');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');

const DIRS = ['canon', 'journal', 'user', 'decisions', 'project', 'inbox', 'inbox/archived'];
const CONVERSATION_GAP_MS = 30 * 60 * 1000; // 30 minutes
const MAX_RECENT_MESSAGES = 50; // Sin límite artificial duro — el LLM maneja su context window

let db = null;
let currentConversationId = null;

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

  // Restore current conversation from last message
  const lastMsg = db.prepare('SELECT conversation_id, timestamp FROM messages ORDER BY id DESC LIMIT 1').get();
  if (lastMsg) {
    const gap = Date.now() - new Date(lastMsg.timestamp).getTime();
    if (gap < CONVERSATION_GAP_MS) {
      currentConversationId = lastMsg.conversation_id;
    }
  }

  console.log('[Memory] Initialized. DB:', DB_PATH);
}

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

// --- FTS5 search for relevant past conversations ---
function searchRelevantHistory(query, limit = 5) {
  try {
    // Simple keyword extraction
    const words = query
      .replace(/[^\w\sáéíóúñ]/gi, '')
      .split(/\s+/)
      .filter(w => w.length > 3)
      .slice(0, 5);

    if (!words.length) return [];

    // 1. Try FTS5 first (fast, accurate)
    try {
      const ftsQuery = words.join(' OR ');
      const ftsResults = db.prepare(`
        SELECT source, path, content, tags FROM memory_search
        WHERE memory_search MATCH ?
        ORDER BY rank LIMIT ?
      `).all(ftsQuery, limit);

      if (ftsResults.length > 0) return ftsResults;
    } catch (ftsErr) {
      // FTS5 not available or error — fall through to LIKE
    }

    // 2. Fallback: LIKE search in messages
    const keyword = words[0];
    const results = db.prepare(`
      SELECT role, content, timestamp FROM messages
      WHERE content LIKE ?
      ORDER BY timestamp DESC LIMIT ?
    `).all(`%${keyword}%`, limit);

    return results;
  } catch (e) {
    return [];
  }
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
      const content = m.content.length > 1000 ? m.content.substring(0, 1000) + '...' : m.content;
      return `[${time}] ${name}: ${content}`;
    }).join('\n');
    parts.push(`=== HISTORIAL RECIENTE ===\n${history}`);
  }

  // 2. Canon (consolidated truth)
  const canon = readMarkdownDir('canon');
  if (canon) {
    parts.push(`=== MEMORIA CORE ===\n${canon}`);
  }

  // 3. Today's journal
  const today = new Date().toISOString().split('T')[0];
  const journalPath = path.join(MEMORY_DIR, 'journal', `${today}.md`);
  try {
    const journal = fs.readFileSync(journalPath, 'utf-8').trim();
    if (journal) {
      const journalContent = journal.length > 1500 ? '...\n' + journal.substring(journal.length - 1500) : journal;
      parts.push(`=== JOURNAL DE HOY ===\n${journalContent}`);
    }
  } catch (e) { /* no journal yet */ }

  // 4. User preferences
  const user = readMarkdownDir('user');
  if (user) {
    parts.push(`=== PREFERENCIAS DE JOSE ===\n${user}`);
  }

  // 5. Project context
  const project = readMarkdownDir('project');
  if (project) {
    parts.push(`=== PROYECTOS ACTIVOS ===\n${project}`);
  }

  // 6. Decisions
  const decisions = readMarkdownDir('decisions');
  if (decisions) {
    parts.push(`=== DECISIONES CLAVE ===\n${decisions}`);
  }

  // 7. Pending inbox items (unprocessed self-memories)
  const inbox = readMarkdownDir('inbox');
  if (inbox) {
    parts.push(`=== RECUERDOS PENDIENTES (inbox) ===\n${inbox}`);
  }

  // Sin truncado: el LLM (Sonnet/Opus) maneja su propio context window
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

    // Parse tipo and confianza if present
    const tipoMatch = memoryContent.match(/^tipo:\s*(\w+)/im);
    const confianzaMatch = memoryContent.match(/^confianza:\s*(\w+)/im);
    const tipo = tipoMatch ? tipoMatch[1] : 'general';
    const confianza = confianzaMatch ? confianzaMatch[1] : 'alta';

    // Clean content (remove metadata lines)
    const cleanContent = memoryContent
      .replace(/^tipo:\s*\w+\s*$/gim, '')
      .replace(/^confianza:\s*\w+\s*$/gim, '')
      .trim();

    const inboxPath = path.join(MEMORY_DIR, 'inbox', `${timestamp}-${tipo}.md`);
    const fileContent = `---\ntipo: ${tipo}\nconfianza: ${confianza}\nfecha: ${now.toISOString()}\nfuente: conversacion\n---\n\n${cleanContent}\n`;

    fs.writeFileSync(inboxPath, fileContent);
    console.log(`[Memory] Self-write: ${tipo} (${confianza}) -> ${inboxPath}`);
  }

  // Strip [REMEMBER] blocks from the response shown to user
  return response.replace(memoryPattern, '').trim();
}

function saveExchange(userMessage, response) {
  const now = new Date();
  const timestamp = now.toISOString();

  // Determine conversation
  const lastMsg = db.prepare('SELECT timestamp FROM messages ORDER BY id DESC LIMIT 1').get();
  if (!currentConversationId || !lastMsg || (now.getTime() - new Date(lastMsg.timestamp).getTime()) > CONVERSATION_GAP_MS) {
    currentConversationId = crypto.randomUUID();
    db.prepare('INSERT INTO conversations (id, started_at) VALUES (?, ?)').run(currentConversationId, timestamp);
    console.log(`[Memory] New conversation: ${currentConversationId}`);
  }

  // Insert messages
  const insert = db.prepare('INSERT INTO messages (conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?)');
  insert.run(currentConversationId, 'user', userMessage, timestamp);
  insert.run(currentConversationId, 'assistant', response, timestamp);

  // Index in FTS5 for semantic search
  try {
    const ftsInsert = db.prepare('INSERT INTO memory_search (source, path, content, tags) VALUES (?, ?, ?, ?)');
    ftsInsert.run('messages', `conversation:${currentConversationId}`, `Jose: ${userMessage}\nMaximus: ${response}`, '');
  } catch (e) { /* FTS5 unavailable, skip */ }

  // Append to daily journal
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toLocaleTimeString('es-CR', { hour: '2-digit', minute: '2-digit' });
  const journalPath = path.join(MEMORY_DIR, 'journal', `${dateStr}.md`);

  const userSnippet = userMessage.length > 150 ? userMessage.substring(0, 150) + '...' : userMessage;
  const responseSnippet = response.length > 150 ? response.substring(0, 150) + '...' : response;

  const journalEntry = `\n## ${timeStr}\n- **Jose**: ${userSnippet}\n- **Maximus**: ${responseSnippet}\n`;

  // Create with header if new file
  if (!fs.existsSync(journalPath)) {
    fs.writeFileSync(journalPath, `# Journal - ${dateStr}\n${journalEntry}`);
  } else {
    fs.appendFileSync(journalPath, journalEntry);
  }

  console.log(`[Memory] Exchange saved. Conversation: ${currentConversationId}`);
}

// --- Get all messages for a specific date (for daily summary) ---
function getMessagesForDate(dateStr) {
  const startOfDay = `${dateStr}T00:00:00`;
  const endOfDay = `${dateStr}T23:59:59`;

  return db.prepare(`
    SELECT role, content, timestamp FROM messages
    WHERE timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC
  `).all(startOfDay, endOfDay);
}

// --- Build prompt for daily summary ---
function buildSummaryPrompt(dateStr) {
  const messages = getMessagesForDate(dateStr);
  if (messages.length === 0) return null;

  const conversation = messages.map(m => {
    const time = new Date(m.timestamp).toLocaleTimeString('es-CR', { hour: '2-digit', minute: '2-digit' });
    const name = m.role === 'user' ? 'Jose' : 'Maximus';
    // Include more content for summary (up to 800 chars per message)
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

// --- Save daily summary journal (replaces the snippet-based one) ---
function saveDailySummary(dateStr, summary) {
  const journalPath = path.join(MEMORY_DIR, 'journal', `${dateStr}.md`);
  fs.writeFileSync(journalPath, summary);

  // Mark messages as summarized
  db.prepare(`
    UPDATE messages SET summarized = 1
    WHERE timestamp >= ? AND timestamp <= ? AND summarized = 0
  `).run(`${dateStr}T00:00:00`, `${dateStr}T23:59:59`);

  console.log(`[Memory] Daily summary saved: ${journalPath}`);
}

// --- Check if a date needs summarization ---
function needsSummary(dateStr) {
  const count = db.prepare(`
    SELECT COUNT(*) as cnt FROM messages
    WHERE timestamp >= ? AND timestamp <= ? AND summarized = 0
  `).get(`${dateStr}T00:00:00`, `${dateStr}T23:59:59`);

  return count && count.cnt > 0;
}

module.exports = {
  init, buildContext, saveExchange, extractAndSaveMemories,
  searchRelevantHistory, buildSummaryPrompt, saveDailySummary, needsSummary
};
