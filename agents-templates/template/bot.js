require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const https = require('https');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = parseInt(process.env.ALLOWED_USER_ID, 10);
const AGENT_NAME = process.env.AGENT_NAME || 'Agent';
const TMP_DIR = path.join(__dirname, 'tmp');
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';

// ElevenLabs TTS config
const VOICE_ID = '8mBRP99B2Ng2QwsJMFQl';
const TTS_MODEL = 'eleven_v3';
const OUTPUT_FORMAT = 'opus_48000_128';
const VOICE_SETTINGS = {
  stability: 0.30,
  similarity_boost: 0.75,
  style: 0.70,
  use_speaker_boost: true
};

const DB_PATH = path.join(__dirname, 'data', `${AGENT_NAME.toLowerCase()}.db`);

// --- Database for message persistence ---
let db;
function initDb() {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT DEFAULT (datetime('now'))
  )`);
  console.log(`[DB] Initialized: ${DB_PATH}`);
}

function saveExchange(userMsg, assistantMsg) {
  const insert = db.prepare('INSERT INTO messages (role, content) VALUES (?, ?)');
  insert.run('user', userMsg);
  insert.run('assistant', assistantMsg);
}

// --- Provider/Model Configuration ---
const PROVIDERS = {
  anthropic: {
    label: 'Anthropic',
    models: [
      { id: 'claude-opus-4-7', label: 'Opus 4.7' },
      { id: 'sonnet', label: 'Sonnet 4.6' },
      { id: 'opus', label: 'Opus 4.6' },
      { id: 'haiku', label: 'Haiku 4.5' }
    ],
    env: {}
  },
  ollama: {
    label: 'Ollama Cloud',
    models: [
      { id: 'deepseek-v3.2:cloud', label: 'DeepSeek V3.2' },
      { id: 'kimi-k2.5:cloud', label: 'Kimi K2.5' },
      { id: 'qwen3.5:cloud', label: 'Qwen 3.5' },
      { id: 'gemma4:31b-cloud', label: 'Gemma 4 31B' }
    ],
    env: {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'https://ollama.com/v1',
      OPENAI_API_KEY: process.env.OLLAMA_API_KEY || ''
    }
  },
  openrouter: {
    label: 'OpenRouter',
    models: [
      { id: 'openai/gpt-5.4-mini', label: 'GPT-5.4 Mini' },
      { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { id: 'deepseek/deepseek-v3.2', label: 'DeepSeek V3.2' },
      { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6' }
    ],
    env: {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENAI_API_KEY: process.env.OPENROUTER_API_KEY || ''
    }
  },
  codex: {
    label: 'OpenAI Codex',
    models: [
      { id: 'gpt-5.4', label: 'GPT-5.4 (default)' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' }
    ],
    env: {}
  }
};

let currentProvider = process.env.DEFAULT_PROVIDER || 'anthropic';
let currentModel = process.env.DEFAULT_MODEL || 'sonnet';

// --- Host Delegation ---
const DELEGATION_HOST = process.env.DELEGATION_HOST || 'http://host.docker.internal:3847';
const DELEGATION_TIMEOUT_MS = 5 * 60 * 1000;

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
    req.on('error', (err) => resolve(`[ERROR] Delegación falló: ${err.message}`));
    req.on('timeout', () => { req.destroy(); resolve('[ERROR] Delegación timeout'); });
    req.write(payload);
    req.end();
  });
}

const DELEGATE_REGEX = /\[DELEGATE\]([\s\S]*?)\[\/DELEGATE\]/;

async function handleDelegation(rawResponse) {
  const match = rawResponse.match(DELEGATE_REGEX);
  if (!match) return rawResponse;
  const delegationTask = match[1].trim();
  console.log(`[Delegation] Detected delegation request: ${delegationTask.substring(0, 100)}...`);
  const hostResult = await delegateToHost(delegationTask, '');
  console.log(`[Delegation] Host result: ${hostResult.length} chars`);
  const resultMsg = `[RESULTADO DEL HOST - OpenClaude ejecutó esta tarea en el servidor principal]\n\n${hostResult}\n\nFormateá este resultado para el usuario y respondé normalmente.`;
  const finalResponse = await callAgent(resultMsg);
  return finalResponse;
}

// --- State ---
const botStartTime = Date.now();
let processingStartTime = null;

// --- OpenClaude CLI Subprocess (persistent stream-json mode) ---
let openclaudeProcess = null;
let pendingResolve = null;
let pendingReject = null;
let pendingTimeout = null;
let responseBuffer = '';
let assistantText = '';
let intentionalKill = false;
// --- Proactive session rotation ---
const SESSION_ROTATE_TURNS = 50;
let turnCount = 0;
// NO global timeout that kills — only periodic notifications + hard safety net
const HARD_TIMEOUT_MS = 30 * 60 * 1000; // 30 min hard safety net
const NOTIFY_INTERVAL_MS = 3 * 60 * 1000; // 3 min notify interval

function spawnOpenClaude() {
  if (currentProvider === 'codex') return; // codex usa spawn por llamada, no proceso persistente
  const provider = PROVIDERS[currentProvider];
  console.log(`[OpenClaude] Spawning: ${provider.label} / ${currentModel}`);

  const spawnEnv = { ...process.env, HOME: '/app', ...provider.env };
  const spawnArgs = [
    '-p',
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--model', currentModel
  ];

  const proc = spawn('openclaude', spawnArgs, {
    cwd: '/app',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: spawnEnv
  });

  proc.stdout.on('data', (chunk) => {
    responseBuffer += chunk.toString();
    const lines = responseBuffer.split('\n');
    responseBuffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { handleOpenClaudeMessage(JSON.parse(line)); } catch (e) { /* not JSON */ }
    }
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.error(`[OpenClaude stderr] ${text}`);
  });

  proc.on('exit', (code, signal) => {
    console.log(`[OpenClaude] Process exited (code=${code}, signal=${signal})`);
    openclaudeProcess = null;
    if (pendingReject) {
      pendingReject(new Error(`OpenClaude process died (code=${code})`));
      pendingResolve = null;
      pendingReject = null;
      if (pendingTimeout) { clearInterval(pendingTimeout); pendingTimeout = null; }
    }
    const delay = intentionalKill ? 500 : 3000;
    intentionalKill = false;
    setTimeout(() => {
      console.log('[OpenClaude] Respawning...');
      spawnOpenClaude();
    }, delay);
  });

  proc.on('error', (err) => {
    console.error('[OpenClaude] Spawn error:', err.message);
  });

  openclaudeProcess = proc;
  console.log(`[OpenClaude] Process spawned (pid: ${proc.pid})`);

  // --- Session recovery: lightweight context injection on spawn ---
  // Only inject last 5 messages, short content, no auto-resume
  try {
    if (db) {
      const recentMsgs = db.prepare(
        'SELECT role, content FROM messages ORDER BY id DESC LIMIT 5'
      ).all().reverse();

      if (recentMsgs.length > 0) {
        const history = recentMsgs.map(m => {
          const name = m.role === 'user' ? 'Jose' : AGENT_NAME;
          const short = m.content.length > 150 ? m.content.substring(0, 150) + '...' : m.content;
          return `${name}: ${short}`;
        }).join('\n');

        setTimeout(() => {
          if (openclaudeProcess === proc && !pendingResolve) {
            const contextMsg = {
              type: 'user',
              session_id: '',
              message: { role: 'user', content: `[SISTEMA] Contexto reciente:\n${history}\n\nResponde SOLO: "ok"` },
              parent_tool_use_id: null
            };

            assistantText = '';
            pendingResolve = (text) => {
              pendingResolve = null;
              pendingReject = null;
              console.log('[OpenClaude] Session recovery complete');
            };
            pendingReject = (err) => {
              pendingResolve = null;
              pendingReject = null;
            };
            // Release lock after 30s max
            setTimeout(() => {
              if (pendingResolve) {
                console.log('[OpenClaude] Recovery timeout — releasing');
                pendingResolve = null;
                pendingReject = null;
              }
            }, 30000);

            proc.stdin.write(JSON.stringify(contextMsg) + '\n');
            console.log(`[OpenClaude] Session recovery: ${recentMsgs.length} messages`);
          }
        }, 2000);
      }
    }
  } catch (e) {
    console.error('[OpenClaude] Recovery error:', e.message);
  }

  return proc;
}

function handleOpenClaudeMessage(msg) {
  if (msg.type === 'assistant' && msg.message && msg.message.content) {
    const textParts = msg.message.content
      .filter(c => c.type === 'text')
      .map(c => c.text);
    if (textParts.length > 0) assistantText = textParts.join('');
  } else if (msg.type === 'result') {
    if (pendingResolve) {
      const text = assistantText || (msg.result || '');
      assistantText = '';
      if (pendingTimeout) { clearInterval(pendingTimeout); pendingTimeout = null; }
      const resolve = pendingResolve;
      pendingResolve = null;
      pendingReject = null;
      if (msg.is_error) {
        console.error(`[OpenClaude] Turn error: ${text.substring(0, 200)}`);
        if (text.includes('Not logged in') || text.includes('Please run /login') || text.includes('authentication_error') || text.includes('Invalid authentication credentials')) {
          console.error('[OpenClaude] Auth error — killing for respawn');
          intentionalKill = true;
          if (openclaudeProcess) openclaudeProcess.kill('SIGTERM');
          resolve(`[ERROR:AUTH] ${AGENT_NAME} se esta reiniciando, intenta de nuevo.`);
          return;
        }
        if (text.includes('context limit') || text.includes('compaction has failed') || text.includes('automatic compaction')) {
          console.error('[OpenClaude] Context limit reached — killing process for fresh session');
          intentionalKill = true;
          if (openclaudeProcess) openclaudeProcess.kill('SIGTERM');
          resolve('Se llenó el contexto, me estoy reiniciando con sesión nueva. Repetí tu mensaje en unos segundos.');
          return;
        }
      }
      console.log(`[OpenClaude] Response received (${text.length} chars)`);
      turnCount++;
      // Proactive session rotation to prevent context overflow
      if (turnCount >= SESSION_ROTATE_TURNS) {
        console.log(`[OpenClaude] Proactive session rotation after ${turnCount} turns`);
        turnCount = 0;
        intentionalKill = true;
        resolve(text);
        setTimeout(() => {
          if (openclaudeProcess) openclaudeProcess.kill('SIGTERM');
        }, 500);
        return;
      }
      resolve(text);
    }
  }
}

// --- Download Telegram file ---
async function downloadTelegramFile(fileId, destPath) {
  const file = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
  return new Promise((resolve, reject) => {
    https.get(fileUrl, { timeout: 30000 }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        fs.writeFileSync(destPath, Buffer.concat(chunks));
        console.log(`[Download] Archivo descargado: ${destPath}`);
        resolve(destPath);
      });
    }).on('error', reject);
  });
}

// --- ElevenLabs STT (Speech-to-Text) ---
async function transcribeAudio(filePath) {
  const boundary = '----FormBoundary' + Date.now();
  const fileData = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  const parts = [];
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  parts.push(fileData);
  parts.push(Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model_id"\r\n\r\nscribe_v2\r\n`));
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: '/v1/speech-to-text',
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      },
      timeout: 60000
    }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString());
          console.log(`[STT] Transcripción: "${json.text}"`);
          resolve(json.text || '');
        } catch (e) { reject(new Error('STT parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('STT timeout')); });
    req.write(body);
    req.end();
  });
}

// --- Clean text for TTS: remove markdown, emojis, tags that cause artifacts ---
// NOTE: Only needed when voice ID is NOT fine-tuned for eleven_v3.
// If using eleven_v3 with a compatible voice, emotion tags [laughs] etc. work fine.
function cleanTextForTTS(text) {
  let clean = text;
  // Remove emotion tags like [laughs], [excited], [whispers], etc.
  clean = clean.replace(/\[(?:laughs?|sighs?|excited|whispers?|cries?|sad|happy|angry)\]/gi, '');
  // Remove markdown headers
  clean = clean.replace(/^#{1,6}\s+/gm, '');
  // Remove bold/italic markers
  clean = clean.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1');
  clean = clean.replace(/_{1,3}([^_]+)_{1,3}/g, '$1');
  // Remove strikethrough
  clean = clean.replace(/~~([^~]+)~~/g, '$1');
  // Remove inline code
  clean = clean.replace(/`([^`]+)`/g, '$1');
  // Remove code blocks
  clean = clean.replace(/```[\s\S]*?```/g, '');
  // Remove URLs
  clean = clean.replace(/https?:\/\/\S+/g, '');
  // Remove markdown links, keep text
  clean = clean.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Remove bullet points
  clean = clean.replace(/^[\s]*[-*•]\s+/gm, '');
  // Remove numbered lists markers
  clean = clean.replace(/^[\s]*\d+\.\s+/gm, '');
  // Remove emojis
  clean = clean.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F000}-\u{1FFFF}\u{2702}-\u{27B0}\u{200D}\u{20E3}\u{FE0F}\u{E0020}-\u{E007F}]/gu, '');
  // Remove HTML tags
  clean = clean.replace(/<[^>]+>/g, '');
  // Clean up multiple spaces and newlines
  clean = clean.replace(/\n{3,}/g, '\n\n');
  clean = clean.replace(/  +/g, ' ');
  clean = clean.trim();
  return clean;
}

// --- Split text into chunks for TTS (max ~800 chars, split at sentence boundaries) ---
function splitTextForTTS(text, maxLen = 800) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('. ', maxLen);
    if (splitAt === -1 || splitAt < maxLen * 0.3) splitAt = remaining.lastIndexOf('? ', maxLen);
    if (splitAt === -1 || splitAt < maxLen * 0.3) splitAt = remaining.lastIndexOf('! ', maxLen);
    if (splitAt === -1 || splitAt < maxLen * 0.3) splitAt = remaining.lastIndexOf(', ', maxLen);
    if (splitAt === -1 || splitAt < maxLen * 0.3) splitAt = remaining.lastIndexOf(' ', maxLen);
    if (splitAt === -1) splitAt = maxLen;
    else splitAt += 1;
    chunks.push(remaining.substring(0, splitAt).trim());
    remaining = remaining.substring(splitAt).trim();
  }
  return chunks;
}

// --- ElevenLabs TTS (single chunk) ---
function ttsChunk(text, outputPath) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      text: text,
      model_id: TTS_MODEL,
      voice_settings: VOICE_SETTINGS
    });
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${VOICE_ID}?output_format=${OUTPUT_FORMAT}`,
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/ogg',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 120000
    }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        fs.writeFileSync(outputPath, Buffer.concat(chunks));
        resolve(outputPath);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TTS timeout')); });
    req.write(postData);
    req.end();
  });
}

// --- Concatenate audio files with ffmpeg ---
function concatAudioFiles(files, outputPath) {
  return new Promise((resolve, reject) => {
    const listPath = outputPath + '.txt';
    const listContent = files.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(listPath, listContent);
    execFile('ffmpeg', [
      '-f', 'concat', '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      outputPath,
      '-y', '-loglevel', 'quiet'
    ], (error) => {
      try { fs.unlinkSync(listPath); } catch (e) { /* ignore */ }
      if (error) { reject(error); return; }
      resolve(outputPath);
    });
  });
}

// --- ElevenLabs TTS with chunking for long texts ---
async function textToSpeech(text, outputPath) {
  const chunks = splitTextForTTS(text);
  if (chunks.length === 1) {
    await ttsChunk(text, outputPath);
    console.log(`[TTS] Audio generado: ${outputPath}`);
    return outputPath;
  }
  console.log(`[TTS] Texto largo (${text.length} chars), dividido en ${chunks.length} chunks`);
  const chunkFiles = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      const chunkPath = outputPath.replace('.ogg', `_chunk${i}.ogg`);
      await ttsChunk(chunks[i], chunkPath);
      chunkFiles.push(chunkPath);
      console.log(`[TTS] Chunk ${i + 1}/${chunks.length} generado`);
    }
    await concatAudioFiles(chunkFiles, outputPath);
    console.log(`[TTS] Audio concatenado: ${outputPath}`);
  } finally {
    for (const f of chunkFiles) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { /* ignore */ }
    }
  }
  return outputPath;
}

// --- FFmpeg volume boost ---
function boostVolume(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-i', inputPath,
      '-filter:a', 'volume=2.0',
      '-c:a', 'libopus',
      '-b:a', '128k',
      outputPath,
      '-y',
      '-loglevel', 'quiet'
    ], (error) => {
      if (error) { console.error(`[FFmpeg Error]`, error.message); reject(error); return; }
      console.log(`[FFmpeg] Volume boost aplicado: ${outputPath}`);
      resolve(outputPath);
    });
  });
}

// --- Cleanup temp files ---
function cleanup(...files) {
  for (const f of files) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { /* ignore */ }
  }
}

async function callCodex(userMessage) {
  // Leer CLAUDE.md para inyectar personalidad/formato al prompt
  let systemContext = '';
  try {
    systemContext = fs.readFileSync('/app/CLAUDE.md', 'utf8').trim();
  } catch (e) { /* no CLAUDE.md, continuar sin contexto */ }

  const fullPrompt = systemContext
    ? `[INSTRUCCIONES DEL SISTEMA - seguí estas reglas para tu respuesta]:\n${systemContext}\n\n[MENSAJE DEL USUARIO]:\n${userMessage}`
    : userMessage;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Codex timeout (5 min)')), 5 * 60 * 1000);
    let output = '';
    const modelArgs = (currentModel && currentModel !== 'gpt-5.4') ? ['--model', currentModel] : [];
    const proc = spawn('codex', ['exec', '--skip-git-repo-check', ...modelArgs, fullPrompt], {
      cwd: '/app',
      env: { ...process.env, HOME: '/app' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', d => { output += d.toString(); });
    proc.on('close', code => {
      clearTimeout(timeout);
      const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
      const codexIdx = lines.lastIndexOf('codex');
      const tokensIdx = lines.indexOf('tokens used', codexIdx);
      let result = '';
      if (codexIdx >= 0 && tokensIdx > codexIdx) {
        result = lines.slice(codexIdx + 1, tokensIdx).join('\n');
      } else {
        const skip = new Set(['codex', 'tokens used', 'user', 'EXIT:0']);
        result = lines.filter(l => !skip.has(l) && !/^\d[,\d]*$/.test(l) && !l.startsWith('---') && !l.startsWith('WARNING') && !l.startsWith('ERROR') && !l.startsWith('OpenAI') && !l.startsWith('workdir') && !l.startsWith('model:') && !l.startsWith('session') && !l.startsWith('sandbox') && !l.startsWith('approval') && !l.startsWith('reasoning') && !l.startsWith('provider')).pop() || '';
      }
      if (result) resolve(result);
      else reject(new Error(`Codex sin respuesta: ${output.slice(0, 300)}`));
    });
    proc.on('error', e => { clearTimeout(timeout); reject(e); });
  });
}

// Send message to OpenClaude — NO context injection, OpenClaude manages its own context
async function callAgent(userMessage, imageBase64 = null, imageMimeType = null) {
  if (currentProvider === 'codex') return callCodex(userMessage);
  if (!openclaudeProcess) throw new Error('OpenClaude process not running');
  if (pendingResolve) throw new Error('Already processing a message');

  let content;
  if (imageBase64) {
    content = [
      { type: 'image', source: { type: 'base64', media_type: imageMimeType, data: imageBase64 } },
      { type: 'text', text: userMessage }
    ];
  } else {
    content = userMessage;
  }

  const inputMsg = {
    type: 'user',
    session_id: '',
    message: { role: 'user', content },
    parent_tool_use_id: null
  };

  return new Promise((resolve, reject) => {
    assistantText = '';
    pendingResolve = resolve;
    pendingReject = reject;

    // Periodic "still working" notification — NOT a killing timeout
    const notifyStart = Date.now();
    pendingTimeout = setInterval(() => {
      const elapsed = Math.floor((Date.now() - notifyStart) / 1000);
      const mins = Math.floor(elapsed / 60);
      if (elapsed > HARD_TIMEOUT_MS / 1000) {
        clearInterval(pendingTimeout);
        pendingTimeout = null;
        if (pendingReject) {
          const rej = pendingReject;
          pendingResolve = null;
          pendingReject = null;
          rej(new Error(`Hard timeout (${mins} min)`));
        }
        return;
      }
      safeSendChatAction(ALLOWED_USER_ID, 'typing');
      console.log(`[OpenClaude] Still working... (${mins}m ${elapsed % 60}s)`);
    }, NOTIFY_INTERVAL_MS);

    openclaudeProcess.stdin.write(JSON.stringify(inputMsg) + '\n');
  });
}

// --- Telegram Bot ---
const bot = new TelegramBot(TOKEN, { polling: true });
initDb();

console.log(`[${AGENT_NAME} Bot] Iniciado. Allowlist: ${ALLOWED_USER_ID}`);

function isAllowed(msg) {
  return msg.from && msg.from.id === ALLOWED_USER_ID;
}

// --- Message Queue ---
const MAX_QUEUE_SIZE = 5;
const MAX_QUEUE_AGE_MS = 5 * 60 * 1000;
const messageQueue = [];
let processing = false;

async function enqueueMessage(handler) {
  handler._enqueuedAt = Date.now();
  if (messageQueue.length >= MAX_QUEUE_SIZE) messageQueue.shift();
  messageQueue.push(handler);
  if (!processing) processQueue();
}

async function processQueue() {
  if (processing || messageQueue.length === 0) return;
  processing = true;
  while (messageQueue.length > 0) {
    const handler = messageQueue.shift();
    const age = Date.now() - (handler._enqueuedAt || 0);
    if (age > MAX_QUEUE_AGE_MS) { console.log('[Queue] Dropped stale message'); continue; }
    try { await handler(); } catch (err) { console.error('[Queue Error]', err.message); }
  }
  processing = false;
}

// --- Text Batching (2s window) ---
const BATCH_WINDOW_MS = 2000;
let batchBuffer = [];
let batchTimer = null;

function enqueueBatchedText(msg, chatId) {
  batchBuffer.push(msg.text);
  if (batchTimer) clearTimeout(batchTimer);
  batchTimer = setTimeout(() => {
    const combinedText = batchBuffer.join('\n');
    if (batchBuffer.length > 1) console.log(`[Batch] Combined ${batchBuffer.length} messages`);
    batchBuffer = [];
    batchTimer = null;
    enqueueMessage(() => handleTextMessage(chatId, combinedText));
  }, BATCH_WINDOW_MS);
}

// --- Safe Telegram API ---
async function safeSendChatAction(chatId, action) {
  try { await bot.sendChatAction(chatId, action); } catch (err) {
    if (err.response?.statusCode === 429) {
      const wait = (err.response.body?.parameters?.retry_after || 5) * 1000;
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// --- Markdown to Telegram HTML ---
function mdToHtml(text) {
  let html = text;
  html = html.replace(/^### (.+)$/gm, '\n🔹 <b>$1</b>');
  html = html.replace(/^## (.+)$/gm, '\n📌 <b>$1</b>');
  html = html.replace(/^# (.+)$/gm, '\n📋 <b>$1</b>');
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  html = html.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '<i>$1</i>');
  html = html.replace(/__(.+?)__/g, '<b>$1</b>');
  html = html.replace(/(?<!\w)_(.+?)_(?!\w)/g, '<i>$1</i>');
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');
  html = html.replace(/(?<!`)`([^`\n]+?)`(?!`)/g, '<code>$1</code>');
  html = html.replace(/^[\s]*[-*] /gm, '  • ');
  html = html.replace(/^(\d+)\. /gm, '  $1️⃣ ');
  html = html.replace(/^> (.+)$/gm, '┃ <i>$1</i>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/\n{3,}/g, '\n\n');
  return html.trim();
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function extractCodeBlocks(text) {
  const codeBlocks = [];
  const cleaned = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, code) => {
    codeBlocks.push({ lang: lang || 'code', code: code.trim() });
    return `\n💻 <i>Ver codigo ${lang || ''} abajo ⬇️</i>\n`;
  });
  return { text: cleaned, codeBlocks };
}

async function sendTextResponse(chatId, responseText) {
  const { text: mainText, codeBlocks } = extractCodeBlocks(responseText);
  const htmlText = mdToHtml(mainText);

  const sendHtml = async (chatId, content) => {
    if (content.length > 4096) {
      const parts = [];
      let current = '';
      for (const line of content.split('\n')) {
        if ((current + '\n' + line).length > 4000 && current) {
          parts.push(current);
          current = line;
        } else {
          current = current ? current + '\n' + line : line;
        }
      }
      if (current) parts.push(current);
      for (const part of parts) {
        await bot.sendMessage(chatId, part, { parse_mode: 'HTML' }).catch(() => bot.sendMessage(chatId, part));
      }
    } else {
      await bot.sendMessage(chatId, content, { parse_mode: 'HTML' }).catch(() => bot.sendMessage(chatId, content));
    }
  };

  await sendHtml(chatId, htmlText);
  for (const block of codeBlocks) {
    const codeMsg = `📋 <b>${block.lang.toUpperCase()}</b>\n\n<pre><code class="language-${block.lang}">${escapeHtml(block.code)}</code></pre>`;
    await bot.sendMessage(chatId, codeMsg, { parse_mode: 'HTML' }).catch(() => bot.sendMessage(chatId, `${block.lang}:\n${block.code}`));
  }
}

// --- Commands ---

bot.onText(/\/model$/, async (msg) => {
  if (!isAllowed(msg)) return;
  const provider = PROVIDERS[currentProvider];
  const modelInfo = provider.models.find(m => m.id === currentModel);
  await bot.sendMessage(msg.chat.id,
    `🤖 <b>Modelo activo:</b> ${provider.label} / ${modelInfo?.label || currentModel}\n<code>${currentModel}</code>`,
    { parse_mode: 'HTML' });
});

bot.onText(/\/status$/, async (msg) => {
  if (!isAllowed(msg)) return;
  const uptime = Date.now() - botStartTime;
  const mins = Math.floor(uptime / 60000);
  const hours = Math.floor(mins / 60);
  const provider = PROVIDERS[currentProvider];
  const modelInfo = provider.models.find(m => m.id === currentModel);
  let text = `📊 <b>Estado de ${AGENT_NAME}</b>\n\n`;
  text += `🤖 <b>Modelo:</b> ${provider.label} / ${modelInfo?.label || currentModel}\n`;
  text += `⏱ <b>Uptime:</b> ${hours}h ${mins % 60}m\n`;
  text += `📬 <b>Cola:</b> ${messageQueue.length} mensajes\n`;
  text += processingStartTime ? `\n⚡ <b>Procesando...</b>` : `\n😎 <b>Idle</b>`;
  await bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

bot.onText(/\/cancel$/, async (msg) => {
  if (!isAllowed(msg)) return;
  messageQueue.length = 0;
  if (pendingReject) {
    const rej = pendingReject;
    pendingResolve = null;
    pendingReject = null;
    if (pendingTimeout) { clearInterval(pendingTimeout); pendingTimeout = null; }
    rej(new Error('Cancelled'));
  }
  intentionalKill = true;
  if (openclaudeProcess) openclaudeProcess.kill('SIGTERM');
  processingStartTime = null;
  await bot.sendMessage(msg.chat.id, '🛑 Cancelado. Listo para nuevas instrucciones.');
});

bot.onText(/\/clear$/, async (msg) => {
  if (!isAllowed(msg)) return;
  messageQueue.length = 0;
  batchBuffer = [];
  if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
  intentionalKill = true;
  if (pendingReject) {
    pendingResolve = null;
    pendingReject = null;
    if (pendingTimeout) { clearInterval(pendingTimeout); pendingTimeout = null; }
  }
  if (openclaudeProcess) openclaudeProcess.kill('SIGTERM');
  processingStartTime = null;
  await bot.sendMessage(msg.chat.id, '🔄 Sesion reiniciada.');
});

bot.onText(/\/help$/, async (msg) => {
  if (!isAllowed(msg)) return;
  const help = `📋 <b>Comandos de ${AGENT_NAME}</b>\n
💬 Texto directo — respuesta normal
🔧 <code>/status</code> — estado actual
🤖 <code>/model</code> — modelo activo
🛑 <code>/cancel</code> — cancelar tarea actual
🔄 <code>/clear</code> — reinicio de sesion
❓ <code>/help</code> — esta lista`;
  await bot.sendMessage(msg.chat.id, help, { parse_mode: 'HTML' });
});

// --- Message Handler ---
bot.on('message', async (msg) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;
  const timestamp = Date.now();

  // --- IMAGE MESSAGE FLOW ---
  const isImage = !!(msg.photo || (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('image/')));
  if (isImage) {
    const caption = msg.caption || '';
    console.log(`[User] Imagen recibida. Caption: "${caption}"`);

    enqueueMessage(async () => {
      safeSendChatAction(chatId, 'typing');
      const imgPath = path.join(TMP_DIR, `telegram_img_${timestamp}.jpg`);

      try {
        const fileId = msg.photo
          ? msg.photo[msg.photo.length - 1].file_id
          : msg.document.file_id;

        await downloadTelegramFile(fileId, imgPath);
        const imageBuffer = fs.readFileSync(imgPath);
        const imageBase64 = imageBuffer.toString('base64');
        const mimeType = msg.document?.mime_type || 'image/jpeg';

        const imgMessage = caption
          ? `[IMAGEN enviada por el usuario] Caption: "${caption}". Respondé en base a lo que ves.`
          : '[IMAGEN enviada por el usuario] Sin caption. Respondé en base a lo que ves en la imagen.';

        let rawResponse = await callAgent(imgMessage, imageBase64, mimeType);
        rawResponse = await handleDelegation(rawResponse);
        const responseText = rawResponse.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();

        await sendTextResponse(chatId, responseText);
        console.log(`[${AGENT_NAME}] Respuesta enviada (imagen ${responseText.length} chars)`);
        try { saveExchange(caption ? `[Imagen: "${caption}"]` : '[Imagen sin caption]', responseText); } catch (e) { console.error('[DB Error]', e.message); }
      } catch (err) {
        console.error(`[Image Error]`, err.message);
        bot.sendMessage(chatId, `❌ Error procesando imagen: ${err.message.substring(0, 200)}`);
      } finally {
        cleanup(imgPath);
      }
    });
    return;
  }

  // --- AUDIO MESSAGE FLOW ---
  if (msg.voice || msg.audio) {
    console.log(`[User] Audio recibido`);

    enqueueMessage(async () => {
      safeSendChatAction(chatId, 'typing');
      const audioPath = path.join(TMP_DIR, `telegram_audio_${timestamp}.ogg`);
      const ttsRaw = path.join(TMP_DIR, `tts_raw_${timestamp}.ogg`);
      const ttsBoosted = path.join(TMP_DIR, `tts_boost_${timestamp}.ogg`);

      try {
        const fileId = (msg.voice || msg.audio).file_id;
        await downloadTelegramFile(fileId, audioPath);

        const transcription = await transcribeAudio(audioPath);
        if (!transcription || !transcription.trim()) {
          bot.sendMessage(chatId, '❌ No logré transcribir el audio. Intentá de nuevo.');
          return;
        }

        console.log(`[STT] "${transcription.substring(0, 100)}"`);

        let rawResponse = await callAgent(`[Este mensaje viene de un audio de Jose] ${transcription}`);
        rawResponse = await handleDelegation(rawResponse);
        const responseText = rawResponse.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();

        // Responder con audio cuando el usuario manda audio
        // NOTE: cleanTextForTTS removes markdown/emojis/emotion tags. If your voice is fine-tuned
        // for eleven_v3 and you want [laughs] etc, use responseText directly instead.
        const ttsText = cleanTextForTTS(responseText);
        await textToSpeech(ttsText, ttsRaw);
        await boostVolume(ttsRaw, ttsBoosted);
        await bot.sendVoice(chatId, ttsBoosted);
        console.log(`[${AGENT_NAME}] Voice note enviada`);
        try { saveExchange(`[Audio: "${transcription.substring(0, 150)}"]`, responseText); } catch (e) { console.error('[DB Error]', e.message); }
      } catch (err) {
        console.error(`[Audio Error]`, err.message);
        bot.sendMessage(chatId, `❌ Error procesando audio: ${err.message.substring(0, 200)}`);
      } finally {
        cleanup(audioPath, ttsRaw, ttsBoosted);
      }
    });
    return;
  }

  const text = msg.text;
  if (!text || text.startsWith('/')) return;
  console.log(`[Jose] ${text}`);
  enqueueBatchedText(msg, chatId);
});

async function handleTextMessage(chatId, text) {
  safeSendChatAction(chatId, 'typing');
  try {
    processingStartTime = Date.now();
    let rawResponse = await callAgent(text);
    rawResponse = await handleDelegation(rawResponse);
    const responseText = rawResponse.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();
    await sendTextResponse(chatId, responseText);
    console.log(`[${AGENT_NAME}] Respuesta enviada (${responseText.length} chars)`);
    try { saveExchange(text, responseText); } catch (e) { console.error('[DB Error]', e.message); }
  } catch (err) {
    console.error('[Error]', err.message);
    bot.sendMessage(chatId, `❌ Error: ${err.message.substring(0, 200)}`);
  } finally {
    processingStartTime = null;
  }
}

// --- Switch model ---
function switchModel(providerId, modelId) {
  currentProvider = providerId;
  currentModel = modelId;
  intentionalKill = true;
  if (openclaudeProcess) openclaudeProcess.kill('SIGTERM');
  else spawnOpenClaude();
}

// --- Start ---
spawnOpenClaude();

bot.on('polling_error', (err) => console.error('[Polling Error]', err.message));
process.on('uncaughtException', (err) => console.error('[Uncaught]', err));
process.on('unhandledRejection', (err) => console.error('[Unhandled]', err));
