require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { execFile, spawn } = require('child_process');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const http = require('http');
const https = require('https');
const memory = require('./memory');
const dreaming = require('./dreaming');
const honcho = require('./honcho');

// --- Mission Control ---
const MC_HOST = process.env.MC_HOST || 'mission-control';
const MC_PORT = parseInt(process.env.MC_PORT || '3000');
const MC_API_KEY = process.env.MC_API_KEY || '';
const MC_AGENT_NAME = process.env.AGENT_NAME || 'agent';
const MC_AGENT_ROLE = 'agent';

let mcAgentId = null;
let mcHeartbeatTimer = null;
let mcSseActive = false;

function mcRequest(mcPath, method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: MC_HOST, port: MC_PORT, path: mcPath, method,
      headers: {
        'x-api-key': MC_API_KEY,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function startMCHeartbeat() {
  if (mcHeartbeatTimer) clearInterval(mcHeartbeatTimer);
  mcHeartbeatTimer = setInterval(async () => {
    if (!mcAgentId) return;
    try {
      await mcRequest(`/api/agents/${mcAgentId}/heartbeat`, 'POST', {
        sessionId: `${MC_AGENT_NAME}:telegram`
      });
    } catch (e) {
      console.error('[MC] Heartbeat error:', e.message);
    }
  }, 30000);
}

async function mcUpdateStatus(status, activity) {
  if (!mcAgentId) return;
  try {
    await mcRequest(`/api/agents/${mcAgentId}/heartbeat`, 'POST', {
      sessionId: `${MC_AGENT_NAME}:telegram`,
      status,
      last_activity: activity
    });
  } catch (e) { /* non-critical */ }
}

function startMCSSE() {
  if (mcSseActive || !mcAgentId) return;
  mcSseActive = true;
  const opts = {
    hostname: MC_HOST, port: MC_PORT,
    path: `/api/events?agent_id=${mcAgentId}`,
    method: 'GET',
    headers: { 'x-api-key': MC_API_KEY, 'Accept': 'text/event-stream', 'Cache-Control': 'no-cache' }
  };
  const req = http.request(opts, (res) => {
    console.log('[MC] SSE stream connected');
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const events = buffer.split('\n\n');
      buffer = events.pop();
      for (const ev of events) {
        const dataLine = ev.split('\n').find(l => l.startsWith('data:'));
        if (!dataLine) continue;
        try {
          const data = JSON.parse(dataLine.slice(5).trim());
          console.log('[MC] SSE event:', data.type);
          if (data.type === 'task.completed' && data.task) {
            if (ALLOWED_USER_ID && global.telegramBot) {
              global.telegramBot.sendMessage(ALLOWED_USER_ID,
                `✅ <b>Tarea completada</b>\n<b>${data.task.title}</b>\nAgente: ${data.task.agent_name || 'desconocido'}`,
                { parse_mode: 'HTML' }
              ).catch(() => {});
            }
          }
        } catch (e) {}
      }
    });
    res.on('end', () => { mcSseActive = false; setTimeout(() => startMCSSE(), 5000); });
    res.on('error', () => { mcSseActive = false; setTimeout(() => startMCSSE(), 5000); });
  });
  req.on('error', () => { mcSseActive = false; setTimeout(() => startMCSSE(), 5000); });
  req.end();
}

async function connectToMC() {
  if (!MC_API_KEY) return;
  try {
    const res = await mcRequest('/api/connect', 'POST', {
      tool_name: 'openclaude',
      tool_version: '0.4.0',
      agent_name: MC_AGENT_NAME,
      agent_role: MC_AGENT_ROLE
    });
    if (res.status === 200 && res.body.agent_id) {
      mcAgentId = res.body.agent_id;
      console.log(`[MC] Conectado — agent_id=${mcAgentId}`);
      startMCHeartbeat();
      startMCSSE();
    }
  } catch (e) {
    console.error('[MC] Error conectando:', e.message);
    setTimeout(connectToMC, 15000);
  }
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || process.env.ALLOWED_USER_ID || '')
  .split(',')
  .map(s => parseInt(s.trim(), 10))
  .filter(n => Number.isFinite(n));
const ALLOWED_USER_ID = ALLOWED_USER_IDS[0]; // primary user for typing indicators / notifications
const AGENT_NAME = process.env.AGENT_NAME || 'Agent';
const TMP_DIR = path.join(__dirname, 'tmp');
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';

// ElevenLabs TTS config
const VOICE_ID = 'iwd8AcSi0Je5Quc56ezK';
const TTS_MODEL = 'eleven_v3';
const OUTPUT_FORMAT = 'opus_48000_128';
const VOICE_SETTINGS = {
  stability: 0.42,
  similarity_boost: 0.78,
  style: 0.35,
  use_speaker_boost: true
};

const DB_PATH = path.join(__dirname, 'data', `${AGENT_NAME.toLowerCase()}.db`);

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
      { id: 'gemma4:31b-cloud', label: 'Gemma 4 31B' },
      { id: 'kimi-k2-thinking:cloud', label: 'Kimi K2 Thinking' },
      { id: 'glm-5.1:cloud', label: 'GLM 5.1' }
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
      { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
      { id: 'arcee-ai/trinity-large-thinking', label: 'Trinity Large Thinking' }
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

// Model Presets + Fallback
const modelPresets = require('./model-presets');
const webSearch = require('./web-search');
// Initialize currentProvider/currentModel from presets if DEFAULT not explicitly set
if (!process.env.DEFAULT_PROVIDER && !process.env.DEFAULT_MODEL) {
  const primary = modelPresets.getCurrentPreset();
  currentProvider = primary.provider;
  currentModel = primary.model;
  console.log(`[Presets] Starting with primary: ${primary.provider}/${primary.model}`);
}

// --- Image Generation Models (OpenRouter) ---
const IMAGE_PROVIDERS = {
  google: {
    label: 'Google Gemini',
    models: [
      { id: 'google/gemini-2.5-flash-image', label: 'Nano Banana', price: '$2.5/M' },
      { id: 'google/gemini-2.5-flash-image-preview', label: 'Nano Banana Preview', price: '$0.3/M' },
      { id: 'google/gemini-3.1-flash-image-preview', label: 'Nano Banana 2', price: '$3/M' },
      { id: 'google/gemini-3-pro-image-preview', label: 'Nano Banana Pro', price: '$12/M' },
    ]
  },
  openai: {
    label: 'OpenAI',
    models: [
      { id: 'openai/gpt-5-image-mini', label: 'GPT-5 Image Mini', price: '$2/M' },
      { id: 'openai/gpt-5-image', label: 'GPT-5 Image', price: '$10/M' },
    ]
  },
  flux: {
    label: 'FLUX (Free)',
    models: [
      { id: 'black-forest-labs/flux.2-max', label: 'FLUX.2 Max', price: 'Free' },
      { id: 'black-forest-labs/flux.2-pro', label: 'FLUX.2 Pro', price: 'Free' },
      { id: 'black-forest-labs/flux.2-flex', label: 'FLUX.2 Flex', price: 'Free' },
      { id: 'black-forest-labs/flux.2-klein-4b', label: 'FLUX.2 Klein 4B', price: 'Free' },
    ]
  },
  sourceful: {
    label: 'Sourceful (Free)',
    models: [
      { id: 'sourceful/riverflow-v2-pro', label: 'Riverflow V2 Pro', price: 'Free' },
      { id: 'sourceful/riverflow-v2-fast', label: 'Riverflow V2 Fast', price: 'Free' },
      { id: 'sourceful/riverflow-v2-max-preview', label: 'Riverflow V2 Max', price: 'Free' },
      { id: 'sourceful/riverflow-v2-standard-preview', label: 'Riverflow V2 Std', price: 'Free' },
      { id: 'sourceful/riverflow-v2-fast-preview', label: 'Riverflow V2 Fast Preview', price: 'Free' },
    ]
  },
  other: {
    label: 'Otros (Free)',
    models: [
      { id: 'bytedance-seed/seedream-4.5', label: 'Seedream 4.5', price: 'Free' },
    ]
  }
};

// --- Video Generation Models (OpenRouter) ---
const VIDEO_PROVIDERS = {
  google: {
    label: 'Google Veo',
    models: [
      { id: 'google/veo-3.1', label: 'Veo 3.1 (text only)', price: '$0.20-0.40/s' },
    ]
  },
  openai: {
    label: 'OpenAI Sora',
    models: [
      { id: 'openai/sora-2-pro', label: 'Sora 2 Pro (text only)', price: '$0.30-0.50/s' },
    ]
  },
  alibaba: {
    label: 'Alibaba Wan (img2vid)',
    models: [
      { id: 'alibaba/wan-2.7', label: 'Wan 2.7', price: '$0.10/s' },
      { id: 'alibaba/wan-2.6', label: 'Wan 2.6', price: '$0.10-0.15/s' },
    ]
  },
  bytedance: {
    label: 'ByteDance (img2vid)',
    models: [
      { id: 'bytedance/seedance-2.0', label: 'Seedance 2.0', price: '~$0.007/1K tokens' },
      { id: 'bytedance/seedance-2.0-fast', label: 'Seedance 2.0 Fast', price: '~$0.006/1K tokens' },
      { id: 'bytedance/seedance-1-5-pro', label: 'Seedance 1.5 Pro', price: '~$0.002/1K tokens' },
    ]
  }
};

let currentImageProvider = 'google';
let currentImageModel = 'google/gemini-3.1-flash-image-preview';
let currentVideoProvider = 'alibaba';
let currentVideoModel = 'alibaba/wan-2.7';

// --- State ---
const botStartTime = Date.now();
let processingStartTime = null;

// --- Cost tracking ---
let sessionTokensIn = 0;
let sessionTokensOut = 0;
let sessionCostUsd = 0;
let sessionMessages = 0;

// --- Effort ---
let currentEffort = process.env.DEFAULT_EFFORT || 'auto'; // low, medium, high, max, auto

// --- BTW (side-channel quick question) ---
const BTW_PROVIDER = process.env.BTW_PROVIDER || 'ollama';
const BTW_MODEL = process.env.BTW_MODEL || 'gemma4:31b-cloud';
const BTW_TIMEOUT_MS = 60 * 1000; // 60 seconds

// --- OpenClaude CLI Subprocess (persistent stream-json mode) ---
let openclaudeProcess = null;
let pendingResolve = null;
let pendingReject = null;
let pendingTimeout = null;
let responseBuffer = '';
let assistantText = '';
let intentionalKill = false;
let activeStatusCard = null; // Shared reference for StatusCard cleanup on process death

// Tool name → human-readable label for StatusCard
const TOOL_LABELS = {
  Read: (input) => `📄 Leyendo ${path.basename(input.file_path || '')}`,
  Edit: (input) => `✏️  Editando ${path.basename(input.file_path || '')}`,
  Write: (input) => `📝 Escribiendo ${path.basename(input.file_path || '')}`,
  Bash: () => `⚙️  Ejecutando comando`,
  Grep: () => `🔍 Buscando en código`,
  Glob: () => `📁 Buscando archivos`,
  WebSearch: () => `🌐 Buscando en internet`,
  WebFetch: () => `🌐 Accediendo a URL`,
  Agent: () => `🤖 Delegando a sub-agente`,
};

// NO global timeout that kills — only periodic notifications + hard safety net
const HARD_TIMEOUT_MS = 30 * 60 * 1000; // 30 min hard safety net
const NOTIFY_INTERVAL_MS = 3 * 60 * 1000; // 3 min notify interval

// Delegation to Zeus (host CLI)
const DELEGATION_HOST = process.env.DELEGATION_HOST || 'http://host.docker.internal:3847';
const DELEGATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

// Session message counter (for nudges and session summaries)
let sessionMessageCount = 0;
const NUDGE_INTERVAL = 8; // Nudge every N exchanges
const SESSION_SUMMARY_INTERVAL = 15; // Generate session summary every N exchanges

// Post-exchange hook: auto-extract facts + session summary trigger
function postExchangeHook(userMsg, responseText) {
  sessionMessageCount++;
  try { memory.autoExtractFacts(userMsg, responseText); } catch (e) {}
  if (sessionMessageCount % SESSION_SUMMARY_INTERVAL === 0) {
    try { memory.generateSessionSummary(); } catch (e) {}
  }
}

// Per-chat image context (prevents cross-user image leaking)
const imageContextByChat = new Map(); // chatId → { base64, mimeType, timestamp }
const IMAGE_CONTEXT_TTL_MS = 10 * 60 * 1000; // 10 min — image stays available for follow-up messages
function getImageContext(chatId) {
  const ctx = imageContextByChat.get(chatId);
  if (ctx && (Date.now() - ctx.timestamp) < IMAGE_CONTEXT_TTL_MS) return ctx;
  imageContextByChat.delete(chatId);
  return null;
}
function setImageContext(chatId, base64, mimeType) {
  imageContextByChat.set(chatId, { base64, mimeType, timestamp: Date.now() });
}

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
  if (currentEffort !== 'auto') spawnArgs.push('--effort', currentEffort);

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
    // Clean up stuck StatusCard (typing indicator + timers)
    if (activeStatusCard) {
      activeStatusCard.fail('Proceso reiniciado').catch(() => {});
      activeStatusCard = null;
    }
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
    const db = memory.getDb();
    if (db) {
      const recentMsgs = db.prepare(
        'SELECT role, content FROM messages ORDER BY id DESC LIMIT 5'
      ).all().reverse();

      if (recentMsgs.length > 0) {
        const history = recentMsgs.map(m => {
          const name = m.role === 'user' ? (process.env.USER_NAME || 'User') : AGENT_NAME;
          const short = m.content.length > 150 ? m.content.substring(0, 150) + '...' : m.content;
          return `${name}: ${short}`;
        }).join('\n');

        setTimeout(() => {
          if (openclaudeProcess === proc && !pendingResolve) {
            const contextMsg = {
              type: 'user',
              session_id: '',
              message: { role: 'user', content: `[SISTEMA] Contexto reciente:\n${history}${honcho.getHonchoContextBlock() ? '\n\n' + honcho.getHonchoContextBlock() : ''}\n\nResponde SOLO: "ok"` },
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

    // StatusCard live action updates
    if (activeStatusCard) {
      const toolUses = msg.message.content.filter(c => c.type === 'tool_use');
      if (toolUses.length > 0) {
        const tool = toolUses[toolUses.length - 1];
        const labelFn = TOOL_LABELS[tool.name];
        const actionText = labelFn ? labelFn(tool.input || {}) : `🔧 ${tool.name}`;
        activeStatusCard.updateAction(actionText);
      } else if (textParts.length > 0) {
        const thought = textParts[0].substring(0, 60).replace(/\n/g, ' ');
        if (thought) activeStatusCard.updateAction(`💭 ${thought}...`);
      }
    }
  } else if (msg.type === 'result') {
    // Track usage/cost if available
    if (msg.usage) {
      sessionTokensIn += msg.usage.input_tokens || 0;
      sessionTokensOut += msg.usage.output_tokens || 0;
    }
    if (msg.cost_usd) sessionCostUsd += msg.cost_usd;
    if (msg.total_cost_usd) sessionCostUsd = msg.total_cost_usd;
    sessionMessages++;

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
          mcUpdateStatus('idle', 'Error de autenticación — reiniciando');
          intentionalKill = true;
          if (openclaudeProcess) openclaudeProcess.kill('SIGTERM');
          resolve(`[ERROR:AUTH] ${AGENT_NAME} se esta reiniciando, intenta de nuevo.`);
          return;
        }
        if (text.includes('context limit') || text.includes('compaction has failed') || text.includes('automatic compaction')) {
          console.error('[OpenClaude] Context limit reached — killing process for fresh session');
          mcUpdateStatus('idle', 'Contexto lleno — reiniciando sesión');
          intentionalKill = true;
          if (openclaudeProcess) openclaudeProcess.kill('SIGTERM');
          resolve('Se llenó el contexto, me estoy reiniciando con sesión nueva. Repetí tu mensaje en unos segundos.');
          return;
        }
      }
      console.log(`[OpenClaude] Response received (${text.length} chars)`);
      mcUpdateStatus('idle', 'Respuesta enviada');
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
function cleanTextForTTS(text) {
  let clean = text;
  // Remove [REMEMBER] blocks (safety net)
  clean = clean.replace(/\[REMEMBER\][\s\S]*?\[\/REMEMBER\]/g, "");
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

  // Inyectar historial de conversación reciente para que Codex tenga contexto
  let conversationHistory = '';
  try {
    const ctx = memory.buildContext();
    if (ctx) conversationHistory = ctx.substring(0, 16000);
  } catch (e) { /* sin historial, continuar */ }

  // Búsqueda semántica: traer memorias relevantes al mensaje actual
  let semanticContext = '';
  try {
    const results = await memory.searchSemantic(userMessage, 5);
    if (results && results.length > 0) {
      semanticContext = results.map(r => {
        const content = r.content.length > 400 ? r.content.substring(0, 400) + '...' : r.content;
        return `- ${content}`;
      }).join('\n');
    }
  } catch (e) { /* sin búsqueda semántica, continuar */ }

  // Honcho user profile (Koba-style per-turn injection)
  let honchoProfile = '';
  try {
    honchoProfile = honcho.getHonchoContextBlock();
  } catch (e) { /* sin perfil, continuar */ }

  // Session summary (Magnum-style mini-compaction)
  let sessionSummaryBlock = '';
  try {
    const ss = memory.getSessionSummary();
    if (ss && ss.topics && ss.topics.length > 0) {
      sessionSummaryBlock = `Temas activos de esta sesión: ${ss.topics.join(', ')}. Último contexto: ${ss.lastContext}`;
    }
  } catch (e) { /* sin resumen, continuar */ }


  // Smart web search (conditional — only when message needs factual info)
  let webSearchContext = '';
  try {
    webSearchContext = await webSearch.smartSearch(userMessage);
  } catch (e) { /* sin búsqueda web, continuar */ }
  let fullPrompt = '';
  if (systemContext) {
    fullPrompt = `[INSTRUCCIONES DEL SISTEMA - seguí estas reglas para tu respuesta]:\n${systemContext}\n\n`;
  }
  if (honchoProfile) {
    fullPrompt += `[PERFIL DEL USUARIO - preferencias y patrones detectados]:\n${honchoProfile}\n\n`;
  }
  if (sessionSummaryBlock) {
    fullPrompt += `[RESUMEN DE SESIÓN ACTUAL]:\n${sessionSummaryBlock}\n\n`;
  }
  if (conversationHistory) {
    fullPrompt += `[CONTEXTO DE CONVERSACIÓN RECIENTE - usá esto para entender referencias como "esto", "lo anterior", etc.]:\n${conversationHistory}\n\n`;
  }
  if (semanticContext) {
    fullPrompt += `[MEMORIAS RELEVANTES - información de conversaciones anteriores relacionada con este mensaje]:\n${semanticContext}\n\n`;
  }
  fullPrompt += `[MENSAJE ACTUAL DEL USUARIO]:\n${userMessage}`;

  // Nudge (Koba-style periodic reminder to save important info)
  if (sessionMessageCount > 0 && sessionMessageCount % NUDGE_INTERVAL === 0) {
    fullPrompt += '\n\n[RECORDATORIO: Si en esta conversación se mencionaron datos importantes (nombres, preferencias, decisiones, proyectos, hechos nuevos del usuario), guardálos con [REMEMBER]tipo:preferencia|decision|proyecto|contacto|general\nconfianza:alta|media\ncontenido aquí[/REMEMBER]. Solo guardá lo genuinamente útil a futuro.]';
    console.log(`[Nudge] Memory save reminder injected (turn ${sessionMessageCount})`);
  }

  // Wrap with fallback retry logic
  const maxFallbackAttempts = 3;
  for (let attempt = 0; attempt <= maxFallbackAttempts; attempt++) {
    try {
      const presetTimeout = modelPresets.getTimeout();
      const result = await _callCodexOnce(fullPrompt, presetTimeout);
      modelPresets.onModelSuccess();
      return result;
    } catch (err) {
      const isTimeout = err.message.includes('timeout') || err.message.includes('Timeout');
      const isEmpty = err.message.includes('sin respuesta');
      if ((isTimeout || isEmpty) && attempt < maxFallbackAttempts) {
        const next = modelPresets.onModelFailure(isTimeout ? 'timeout' : 'empty response');
        if (next) {
          currentProvider = next.provider;
          currentModel = next.model;
          console.log(`[Fallback] Switching to ${next.provider}/${next.model} (attempt ${attempt + 1})`);
          continue;
        }
      }
      throw err;
    }
  }
}

// Internal: single codex call with configurable timeout
function _callCodexOnce(fullPrompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (e) {}
      reject(new Error(`Codex timeout (${Math.round(timeoutMs / 1000)}s) — ${currentProvider}/${currentModel}`));
    }, timeoutMs);
    let output = '';
    const modelArgs = (currentModel && currentModel !== 'gpt-5.4') ? ['--model', currentModel] : [];
    const providerConfig = PROVIDERS[currentProvider];
    const providerEnv = providerConfig ? providerConfig.env : {};
    const proc = spawn('codex', ['exec', '--skip-git-repo-check', '--sandbox', 'danger-full-access', ...modelArgs, fullPrompt], {
      cwd: '/app',
      env: { ...process.env, ...providerEnv, HOME: '/app' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', d => {
      const text = d.toString();
      output += text;
      if (activeStatusCard) {
        const lines = text.split('\n');
        for (const line of lines) {
          const l = line.trim().toLowerCase();
          if (!l) continue;
          if (l.includes('reading') || l.includes('read ')) activeStatusCard.updateAction('📄 Leyendo archivo');
          else if (l.includes('editing') || l.includes('edit ')) activeStatusCard.updateAction('✏️  Editando archivo');
          else if (l.includes('searching') || l.includes('search ') || l.includes('grep')) activeStatusCard.updateAction('🔍 Buscando en código');
          else if (l.includes('running') || l.includes('exec') || l.includes('bash')) activeStatusCard.updateAction('⚙️  Ejecutando comando');
          else if (l.includes('web') || l.includes('fetch') || l.includes('http')) activeStatusCard.updateAction('🌐 Accediendo a URL');
        }
      }
    });
    proc.on('close', code => {
      clearTimeout(timeout);
      const lines = output.split('\n');
      // Find the last 'codex' marker line (where the response starts)
      let codexIdx = -1;
      let tokensIdx = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim() === 'tokens used') { tokensIdx = i; }
        if (lines[i].trim() === 'codex' && tokensIdx > i) { codexIdx = i; break; }
      }
      let result = '';
      if (codexIdx >= 0 && tokensIdx > codexIdx) {
        result = lines.slice(codexIdx + 1, tokensIdx).join('\n').trim();
      } else {
        // Fallback: find response between 'user' block and 'tokens used'
        const headerPatterns = /^(codex|tokens used|user|EXIT:\d+|\d[\d,]*|---+|WARNING|ERROR|OpenAI|workdir:|model:|session|sandbox|approval|reasoning|provider)$/;
        const filtered = lines.filter(l => {
          const t = l.trim();
          return t && !headerPatterns.test(t);
        });
        result = filtered.join('\n').trim();
        // If result still contains the original prompt, try to extract only the response after it
        if (result.includes('[MENSAJE DEL USUARIO]')) {
          const parts = result.split(/codex\n/i);
          if (parts.length > 1) result = parts[parts.length - 1].trim();
        }
      }
      // Clean up: remove trailing token count lines
      result = result.replace(/\n?\d[\d,]*\s*$/m, '').trim();
      if (result) resolve(result);
      else reject(new Error(`Codex sin respuesta: ${output.slice(0, 300)}`));
    });
    proc.on('error', e => { clearTimeout(timeout); reject(e); });
  });
}

// --- Image Generation via OpenRouter ---
async function generateImage(prompt, inputImageBase64 = null, inputImageMimeType = null) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY no configurado');

  // Build message content — text-only or image editing
  let messageContent;
  if (inputImageBase64) {
    // Image editing: send input image + prompt
    messageContent = [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:${inputImageMimeType || 'image/jpeg'};base64,${inputImageBase64}` } }
    ];
    console.log(`[ImageGen] Image editing mode — input image: ${inputImageBase64.length} chars`);
  } else {
    messageContent = prompt;
  }

  // FLUX/diffusion models only output image, multimodal models output image+text
  const isImageOnly = currentImageModel.includes('flux') || currentImageModel.includes('riverflow') || currentImageModel.includes('seedream') || currentImageModel.includes('klein');
  const requestBody = {
    model: currentImageModel,
    messages: [{ role: 'user', content: messageContent }],
    modalities: isImageOnly ? ['image'] : ['image', 'text'],
  };
  // Gemini/GPT models support image_config
  if (currentImageModel.startsWith('google/') || currentImageModel.startsWith('openai/')) {
    requestBody.image_config = { aspect_ratio: '1:1', image_size: '1K' };
  }

  console.log(`[ImageGen] Request — model: ${currentImageModel}, modalities: ${JSON.stringify(requestBody.modalities)}, hasInputImage: ${!!inputImageBase64}`);

  const response = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    requestBody,
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': `https://${AGENT_NAME.toLowerCase()}.bot`,
        'X-Title': `${AGENT_NAME} Telegram Bot`
      },
      timeout: 120000
    }
  );

  const choice = response.data.choices?.[0];
  const images = choice?.message?.images || [];
  const textContent = choice?.message?.content || '';

  // Some models embed base64 in content parts instead of images array
  if (images.length === 0 && Array.isArray(choice?.message?.content)) {
    for (const part of choice.message.content) {
      if (part.type === 'image_url' || part.type === 'image') {
        const url = part.image_url?.url || part.url || '';
        if (url.startsWith('data:image')) images.push({ image_url: { url } });
      }
    }
  }

  return { images, text: typeof textContent === 'string' ? textContent : '' };
}

// --- Video Generation via OpenRouter (async polling) ---
async function generateVideo(prompt, chatId, inputImageBase64 = null, inputImageMimeType = null) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY no configurado');

  const requestBody = {
    model: currentVideoModel,
    prompt: prompt,
    duration: 8,
    resolution: '1080p',
    aspect_ratio: '16:9',
    generate_audio: true
  };

  // Image-to-video: only some models support frame_images
  const I2V_MODELS = ['alibaba/wan-2.7', 'alibaba/wan-2.6', 'bytedance/seedance-2.0', 'bytedance/seedance-2.0-fast', 'bytedance/seedance-1-5-pro'];
  if (inputImageBase64) {
    if (!I2V_MODELS.includes(requestBody.model)) {
      const fallback = 'alibaba/wan-2.7';
      console.log(`[VideoGen] ${requestBody.model} does NOT support image-to-video — switching to ${fallback}`);
      requestBody.model = fallback;
    }
    requestBody.frame_images = [
      {
        type: 'image_url',
        image_url: { url: `data:${inputImageMimeType || 'image/jpeg'};base64,${inputImageBase64}` },
        frame_type: 'first_frame'
      }
    ];
    console.log(`[VideoGen] Image-to-video mode — input image as first frame via ${requestBody.model}`);
  }

  console.log(`[VideoGen] Submitting — model: ${currentVideoModel}, hasInputImage: ${!!inputImageBase64}`);

  const submitResponse = await axios.post(
    'https://openrouter.ai/api/v1/videos',
    requestBody,
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }
  );

  const jobId = submitResponse.data.id || submitResponse.data.job_id;
  const pollingUrl = submitResponse.data.polling_url || `https://openrouter.ai/api/v1/videos/${jobId}`;
  if (!jobId) throw new Error('No job ID returned from video API');
  console.log(`[VideoGen] Job submitted: ${jobId}, polling: ${pollingUrl}`);

  // Poll for completion (max 10 min, every 30s)
  const MAX_POLLS = 20;
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, 30000));
    if (chatId) safeSendChatAction(chatId, 'upload_video');

    const pollResponse = await axios.get(
      pollingUrl,
      { headers: { 'Authorization': `Bearer ${apiKey}` }, timeout: 15000 }
    );

    const status = pollResponse.data.status;
    console.log(`[VideoGen] Poll ${i + 1}/${MAX_POLLS}: status=${status}`);
    if (status === 'completed' || status === 'succeeded') {
      return pollResponse.data;
    }
    if (status === 'failed' || status === 'error') {
      throw new Error(`Video generation failed: ${pollResponse.data.error || JSON.stringify(pollResponse.data)}`);
    }
  }
  throw new Error('Video generation timed out (10 min)');
}

// --- Process [GENIMG] and [GENVID] tags from LLM response ---
async function processMediaTags(responseText, chatId) {
  let cleanText = responseText;

  // Use stored image context for editing if available
  const imgCtx = getImageContext(chatId);
  const hasStoredImage = !!imgCtx;

  // Image generation — process ALL [GENIMG] tags
  const imgMatches = [...cleanText.matchAll(/\[GENIMG\]([\s\S]*?)\[\/GENIMG\]/g)];
  if (imgMatches.length > 0) {
    // Remove all tags from clean text first
    cleanText = cleanText.replace(/\[GENIMG\][\s\S]*?\[\/GENIMG\]/g, '').trim();
    console.log(`[ImageGen] Found ${imgMatches.length} image(s) to generate`);

    for (let i = 0; i < imgMatches.length; i++) {
      const imgPrompt = imgMatches[i][1].trim();
      try {
        safeSendChatAction(chatId, 'upload_photo');
        console.log(`[ImageGen] (${i+1}/${imgMatches.length}) "${imgPrompt.substring(0, 100)}"`);
        const result = await generateImage(
          imgPrompt,
          hasStoredImage ? imgCtx.base64 : null,
          hasStoredImage ? imgCtx.mimeType : null
        );
        if (result.images.length > 0) {
          for (const img of result.images) {
            const dataUrl = img.image_url?.url || img.url || '';
            const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
            if (base64Data) {
              const buffer = Buffer.from(base64Data, 'base64');
              await bot.sendPhoto(chatId, buffer, { caption: imgPrompt.substring(0, 200) });
            }
          }
        } else {
          await bot.sendMessage(chatId, `⚠️ Imagen ${i+1}: el modelo no devolvió resultado.`);
        }
      } catch (imgErr) {
        console.error(`[ImageGen Error ${i+1}]`, imgErr.message);
        await bot.sendMessage(chatId, `❌ Error imagen ${i+1}: ${imgErr.message.substring(0, 200)}`);
      }
    }
    console.log(`[ImageGen] Done: ${imgMatches.length} image(s) processed`);
  }

  // Video generation
  const vidMatch = cleanText.match(/\[GENVID\]([\s\S]*?)\[\/GENVID\]/);
  if (vidMatch) {
    const vidPrompt = vidMatch[1].trim();
    cleanText = cleanText.replace(/\[GENVID\][\s\S]*?\[\/GENVID\]/, '').trim();
    let statusMsg;
    try {
      statusMsg = await bot.sendMessage(chatId, '🎬 Generando video... esto puede tomar unos minutos.');
      if (hasStoredImage) {
        console.log(`[VideoGen] Image-to-video: "${vidPrompt.substring(0, 100)}"`);
      } else {
        console.log(`[VideoGen] Text-to-video: "${vidPrompt.substring(0, 100)}"`);
      }
      const result = await generateVideo(
        vidPrompt,
        chatId,
        hasStoredImage ? imgCtx.base64 : null,
        hasStoredImage ? imgCtx.mimeType : null
      );
      let videoUrl = result.url || result.video_url || result.output?.url
        || (result.unsigned_urls && result.unsigned_urls[0]);
      // If unsigned_url is a relative path, build full URL
      if (videoUrl && videoUrl.startsWith('/')) {
        videoUrl = `https://openrouter.ai${videoUrl}`;
      }
      if (videoUrl) {
        console.log(`[VideoGen] Downloading video from: ${videoUrl.substring(0, 100)}`);
        // Download video to buffer first (some URLs require auth headers)
        try {
          const videoResponse = await axios.get(videoUrl, {
            headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` },
            responseType: 'arraybuffer',
            timeout: 60000
          });
          const videoBuffer = Buffer.from(videoResponse.data);
          await bot.sendVideo(chatId, videoBuffer, { caption: vidPrompt.substring(0, 200) }, { filename: 'video.mp4', contentType: 'video/mp4' });
        } catch (dlErr) {
          console.log(`[VideoGen] Direct download failed, trying URL directly: ${dlErr.message}`);
          await bot.sendVideo(chatId, videoUrl, { caption: vidPrompt.substring(0, 200) });
        }
        console.log(`[VideoGen] Video sent`);
      } else {
        await bot.sendMessage(chatId, '⚠️ Video generado pero no se pudo obtener la URL.');
        console.log(`[VideoGen] No URL in response: ${JSON.stringify(result).substring(0, 300)}`);
      }
      if (statusMsg) await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    } catch (vidErr) {
      console.error('[VideoGen Error]', vidErr.message);
      await bot.sendMessage(chatId, `❌ Error generando video: ${vidErr.message.substring(0, 200)}`);
      if (statusMsg) await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    }
  }

  return cleanText;
}

// One-shot OpenClaude call for image processing when persistent process isn't available (e.g. Codex provider)
async function callOpenClaudeOneShot(userMessage, imageBase64, imageMimeType) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('OpenClaude one-shot timeout (5 min)'));
    }, 5 * 60 * 1000);

    const proc = spawn('openclaude', [
      '--model', 'sonnet',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--verbose'
    ], { cwd: '/app', env: { ...process.env, HOME: '/app' }, stdio: ['pipe', 'pipe', 'pipe'] });

    // Send the image via stdin as stream-json
    const inputMsg = {
      type: 'user',
      session_id: '',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: imageMimeType, data: imageBase64 } },
          { type: 'text', text: userMessage }
        ]
      },
      parent_tool_use_id: null
    };
    proc.stdin.write(JSON.stringify(inputMsg) + '\n');
    proc.stdin.end();

    let assistantResult = '';
    let buffer = '';
    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'assistant' && msg.message?.content) {
            const text = msg.message.content.filter(c => c.type === 'text').map(c => c.text).join('');
            if (text) assistantResult = text;

            // StatusCard live action updates for one-shot
            if (activeStatusCard) {
              const toolUses = msg.message.content.filter(c => c.type === 'tool_use');
              if (toolUses.length > 0) {
                const tool = toolUses[toolUses.length - 1];
                const labelFn = TOOL_LABELS[tool.name];
                const actionText = labelFn ? labelFn(tool.input || {}) : `🔧 ${tool.name}`;
                activeStatusCard.updateAction(actionText);
              } else if (text) {
                const thought = text.substring(0, 60).replace(/\n/g, ' ');
                if (thought) activeStatusCard.updateAction(`💭 ${thought}...`);
              }
            }
          } else if (msg.type === 'result') {
            assistantResult = assistantResult || msg.result || '';
          }
        } catch (e) { /* not json */ }
      }
    });
    proc.stderr.on('data', (d) => {
      const t = d.toString().trim();
      if (t) console.error(`[OpenClaude OneShot stderr] ${t}`);
    });
    proc.on('close', () => {
      clearTimeout(timeout);
      if (assistantResult) resolve(assistantResult);
      else reject(new Error('OpenClaude one-shot: no response'));
    });

    console.log(`[OpenClaude OneShot] Spawned for image processing (pid: ${proc.pid})`);
  });
}

// --- Delegation to Zeus (host CLI) ---
function delegateToHost(task, context) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ task, context, timeout_ms: DELEGATION_TIMEOUT_MS });
    const url = new URL(`${DELEGATION_HOST}/delegate`);

    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: DELEGATION_TIMEOUT_MS + 10000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.success ? parsed.result : `[ERROR] ${parsed.error}`);
        } catch (e) { resolve(data); }
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

  // Get last few messages for context
  let context = '';
  try {
    const db = memory.getDb();
    if (db) {
      const recent = db.prepare('SELECT role, content FROM messages ORDER BY id DESC LIMIT 5').all().reverse();
      context = recent.map(m => `${m.role}: ${m.content.substring(0, 200)}`).join('\n');
    }
  } catch (e) { /* no context */ }

  const hostResult = await delegateToHost(delegationTask, context);
  console.log(`[Delegation] Host result: ${hostResult.length} chars`);

  // Inject result back into OpenClaude
  const resultMsg = `[RESULTADO DEL HOST - Zeus ejecutó esta tarea en el servidor principal]\n\n${hostResult}\n\nFormateá este resultado para el usuario y respondé normalmente.`;
  const finalResponse = await callAgent(resultMsg);
  return finalResponse;
}

// Send message to OpenClaude — NO context injection, OpenClaude manages its own context
async function callAgent(userMessage, imageBase64 = null, imageMimeType = null) {
  // For images: only Anthropic (via persistent OpenClaude) supports vision natively
  // All other providers (Codex, Ollama, OpenRouter) fall back to OpenClaude one-shot for image analysis
  if (imageBase64 && currentProvider !== 'anthropic') {
    console.log(`[callAgent] Image received but provider "${currentProvider}" may not support vision — using OpenClaude one-shot`);
    return callOpenClaudeOneShot(userMessage, imageBase64, imageMimeType);
  }
  if (currentProvider === 'codex') return callCodex(userMessage);
  if (!openclaudeProcess) {
    console.log('[callAgent] OpenClaude process not running — auto-spawning...');
    spawnOpenClaude();
    // Wait briefly for process to start before throwing
    await new Promise(r => setTimeout(r, 2000));
    if (!openclaudeProcess) throw new Error('OpenClaude process not running — spawn failed');
  }
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
memory.init();

console.log(`[${AGENT_NAME} Bot] Iniciado. Allowlist: ${ALLOWED_USER_IDS.join(',')}`);

function isAllowed(msg) {
  return msg.from && ALLOWED_USER_IDS.includes(msg.from.id);
}

// Identify who is sending this message
const JOSE_USER_ID = parseInt(process.env.JOSE_USER_ID || '7666543493', 10);
function formatUserPrefix(msg) {
  const from = msg.from || {};
  const id = from.id;
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Unknown';
  if (id === JOSE_USER_ID) return `[De Jose Navarro (creador, jefe, user ID ${id})]`;
  return `[De ${name} (user ID ${id})]`;
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
  batchLastMsg = msg;
  if (batchTimer) clearTimeout(batchTimer);
  batchTimer = setTimeout(() => {
    const combinedText = batchBuffer.join('\n');
    const senderMsg = batchLastMsg;
    if (batchBuffer.length > 1) console.log(`[Batch] Combined ${batchBuffer.length} messages`);
    batchBuffer = [];
    batchLastMsg = null;
    batchTimer = null;
    enqueueMessage(() => handleTextMessage(chatId, combinedText, senderMsg));
  }, BATCH_WINDOW_MS);
}
let batchLastMsg = null;

// --- Safe Telegram API ---
async function safeSendChatAction(chatId, action) {
  try { await bot.sendChatAction(chatId, action); } catch (err) {
    if (err.response?.statusCode === 429) {
      const wait = (err.response.body?.parameters?.retry_after || 5) * 1000;
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// --- Status Card (progress indicator) ---
class StatusCard {
  constructor(bot, chatId) {
    this.bot = bot;
    this.chatId = chatId;
    this.messageId = null;
    this.steps = [];
    this.currentStep = -1;
    this.startTime = Date.now();
    this.stepStartTime = Date.now();
    this.typingInterval = null;
    this.pulseInterval = null;
  }

  async init(steps) {
    this.steps = steps.map(s => ({ emoji: s[0], label: s[1], status: 'pending' }));
    this.currentStep = 0;
    this.steps[0].status = 'active';
    this.stepStartTime = Date.now();
    const msg = await this.bot.sendMessage(this.chatId, this._render(), { parse_mode: 'HTML' });
    this.messageId = msg.message_id;
    this._startTyping();
    this.pulseInterval = setInterval(() => this._update(), 5000);
  }

  async advance() {
    if (this.currentStep >= 0 && this.currentStep < this.steps.length) {
      this.steps[this.currentStep].status = 'done';
    }
    this.currentStep++;
    if (this.currentStep < this.steps.length) {
      this.steps[this.currentStep].status = 'active';
      this.stepStartTime = Date.now();
      await this._update();
    }
  }

  updateAction(actionText) {
    if (this.currentStep >= 0 && this.currentStep < this.steps.length) {
      const step = this.steps[this.currentStep];
      if (!step.originalLabel) step.originalLabel = step.label;
      step.label = actionText ? `${step.originalLabel} — ${actionText}` : step.originalLabel;
      this._update();
    }
  }

  async complete() {
    this._stopTimers();
    if (activeStatusCard === this) activeStatusCard = null;
    for (const s of this.steps) { if (s.status !== 'done') s.status = 'done'; }
    try {
      if (this.messageId) {
        const mid = this.messageId;
        this.messageId = null;
        // Edit to minimal text first to force Telegram client re-render
        await this.bot.editMessageText('.', { chat_id: this.chatId, message_id: mid }).catch(() => {});
        await new Promise(r => setTimeout(r, 500));
        await this.bot.deleteMessage(this.chatId, mid);
      }
    } catch (e) { /* already deleted */ }
  }

  async fail(errorMsg) {
    this._stopTimers();
    if (activeStatusCard === this) activeStatusCard = null;
    if (this.currentStep >= 0 && this.currentStep < this.steps.length) {
      this.steps[this.currentStep].status = 'fail';
    }
    try {
      if (this.messageId) {
        await this._update();
        setTimeout(async () => {
          try { await this.bot.deleteMessage(this.chatId, this.messageId); } catch (e) {}
        }, 5000);
      }
    } catch (e) {}
  }

  _startTyping() {
    const action = this.steps.some(s => s.emoji === '🎙️') ? 'record_voice' : 'typing';
    safeSendChatAction(this.chatId, action);
    this.typingInterval = setInterval(() => {
      safeSendChatAction(this.chatId, action);
    }, 4000);
  }

  _stopTimers() {
    if (this.typingInterval) { clearInterval(this.typingInterval); this.typingInterval = null; }
    if (this.pulseInterval) { clearInterval(this.pulseInterval); this.pulseInterval = null; }
  }

  _formatElapsed(ms) {
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  }

  _render() {
    const icons = { pending: '⏳', active: '⚡', done: '✅', fail: '❌' };
    const now = Date.now();
    const lines = this.steps.map(s => {
      const icon = icons[s.status];
      const style = s.status === 'active' ? `<b>${s.label}</b>` : s.label;
      const elapsed = s.status === 'active' ? ` (${this._formatElapsed(now - this.stepStartTime)})` : '';
      return `${icon} ${s.emoji} ${style}${elapsed}`;
    });
    const total = this._formatElapsed(now - this.startTime);
    lines.push(`\n⏱ ${total}`);
    return lines.join('\n');
  }

  async _update() {
    try {
      if (this.messageId) {
        await this.bot.editMessageText(this._render(), {
          chat_id: this.chatId,
          message_id: this.messageId,
          parse_mode: 'HTML'
        });
      }
    } catch (e) {}
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

// --- /models command (inline keyboard selector) ---
const MODELS_PER_PAGE = 8;

async function showModelPage(chatId, messageId, providerId, page) {
  const provider = PROVIDERS[providerId];
  if (!provider) return;
  const models = provider.models;
  const totalPages = Math.ceil(models.length / MODELS_PER_PAGE);
  const start = page * MODELS_PER_PAGE;
  const pageModels = models.slice(start, start + MODELS_PER_PAGE);

  const buttons = [];
  for (let i = 0; i < pageModels.length; i += 2) {
    const row = [];
    row.push({
      text: `${pageModels[i].id === currentModel && providerId === currentProvider ? '✅ ' : ''}${pageModels[i].label}`,
      callback_data: `mdl:${providerId}:${pageModels[i].id}`
    });
    if (pageModels[i + 1]) {
      row.push({
        text: `${pageModels[i + 1].id === currentModel && providerId === currentProvider ? '✅ ' : ''}${pageModels[i + 1].label}`,
        callback_data: `mdl:${providerId}:${pageModels[i + 1].id}`
      });
    }
    buttons.push(row);
  }

  const navRow = [];
  if (page > 0) navRow.push({ text: '⬅️ Anterior', callback_data: `page:${providerId}:${page - 1}` });
  navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: 'noop' });
  if (page < totalPages - 1) navRow.push({ text: 'Siguiente ➡️', callback_data: `page:${providerId}:${page + 1}` });
  buttons.push(navRow);
  buttons.push([{ text: '⬅️ Volver a proveedores', callback_data: 'back' }]);

  const text = `📦 *${provider.label}* — Página ${page + 1}/${totalPages}\n\nEscogé un modelo:`;
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } };

  if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts });
  else await bot.sendMessage(chatId, text, opts);
}

bot.onText(/\/models/, async (msg) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;
  const provider = PROVIDERS[currentProvider];
  const modelInfo = provider.models.find(m => m.id === currentModel);
  const modelLabel = modelInfo ? modelInfo.label : currentModel;
  const buttons = Object.entries(PROVIDERS).map(([id, p]) => ({
    text: `${id === currentProvider ? '✅ ' : ''}${p.label}`,
    callback_data: `prov:${id}`
  }));
  await bot.sendMessage(chatId,
    `🤖 *Modelo actual:* ${provider.label} / ${modelLabel}\n\nEscogé un proveedor:`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [buttons] }
  });
});

bot.on('callback_query', async (query) => {
  if (!isAllowed({ from: query.from })) {
    await bot.answerCallbackQuery(query.id, { text: 'No autorizado' });
    return;
  }
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;
  await bot.answerCallbackQuery(query.id);
  if (data === 'noop') return;

  if (data.startsWith('prov:')) {
    const providerId = data.split(':')[1];
    await showModelPage(chatId, messageId, providerId, 0);
    return;
  }
  if (data.startsWith('page:')) {
    const [, providerId, pageStr] = data.split(':');
    await showModelPage(chatId, messageId, providerId, parseInt(pageStr));
    return;
  }
  if (data.startsWith('mdl:')) {
    const parts = data.split(':');
    const providerId = parts[1];
    const modelId = parts.slice(2).join(':');
    const provider = PROVIDERS[providerId];
    if (!provider) return;
    const modelInfo = provider.models.find(m => m.id === modelId);
    if (providerId === currentProvider && modelId === currentModel) {
      await bot.editMessageText(
        `✅ Ya estás en *${provider.label}* / *${modelInfo?.label || modelId}*`, {
        chat_id: chatId, message_id: messageId, parse_mode: 'Markdown'
      });
      return;
    }
    switchModel(providerId, modelId);
    await bot.editMessageText(
      `🔄 Cambiando a *${provider.label}* / *${modelInfo?.label || modelId}*...`, {
      chat_id: chatId, message_id: messageId, parse_mode: 'Markdown'
    });
    setTimeout(async () => {
      try {
        await bot.editMessageText(
          `✅ Listo — ahora usando *${provider.label}* / *${modelInfo?.label || modelId}*`, {
          chat_id: chatId, message_id: messageId, parse_mode: 'Markdown'
        });
      } catch (e) { /* message already deleted */ }
    }, 3000);
    return;
  }
  // --- Image provider/model callbacks ---
  if (data.startsWith('imgprov:')) {
    const providerId = data.split(':')[1];
    await showImageModelPage(chatId, messageId, providerId, 0);
    return;
  }
  if (data.startsWith('imgpage:')) {
    const [, providerId, pageStr] = data.split(':');
    await showImageModelPage(chatId, messageId, providerId, parseInt(pageStr));
    return;
  }
  if (data.startsWith('imgmdl:')) {
    const parts = data.split(':');
    const providerId = parts[1];
    const modelId = parts.slice(2).join(':');
    const provider = IMAGE_PROVIDERS[providerId];
    if (!provider) return;
    const modelInfo = provider.models.find(m => m.id === modelId);
    if (modelId === currentImageModel) {
      await bot.editMessageText(`✅ Ya estás usando *${modelInfo?.label || modelId}* para imágenes`, {
        chat_id: chatId, message_id: messageId, parse_mode: 'Markdown'
      });
      return;
    }
    currentImageProvider = providerId;
    currentImageModel = modelId;
    await bot.editMessageText(`✅ Modelo de imagen: *${provider.label}* / *${modelInfo?.label || modelId}*`, {
      chat_id: chatId, message_id: messageId, parse_mode: 'Markdown'
    });
    return;
  }
  if (data === 'imgback') {
    const provider = IMAGE_PROVIDERS[currentImageProvider];
    const modelInfo = provider?.models.find(m => m.id === currentImageModel);
    const allButtons = Object.entries(IMAGE_PROVIDERS).map(([id, p]) => ({
      text: `${id === currentImageProvider ? '✅ ' : ''}${p.label}`,
      callback_data: `imgprov:${id}`
    }));
    const keyboard = [];
    for (let i = 0; i < allButtons.length; i += 2) keyboard.push(allButtons.slice(i, i + 2));
    await bot.editMessageText(
      `🎨 *Modelo de imagen activo:* ${provider.label} / ${modelInfo?.label || currentImageModel}\n\nEscogé un proveedor:`, {
      chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
    return;
  }

  // --- Video provider/model callbacks ---
  if (data.startsWith('vidprov:')) {
    const providerId = data.split(':')[1];
    await showVideoModelPage(chatId, messageId, providerId, 0);
    return;
  }
  if (data.startsWith('vidpage:')) {
    const [, providerId, pageStr] = data.split(':');
    await showVideoModelPage(chatId, messageId, providerId, parseInt(pageStr));
    return;
  }
  if (data.startsWith('vidmdl:')) {
    const parts = data.split(':');
    const providerId = parts[1];
    const modelId = parts.slice(2).join(':');
    const provider = VIDEO_PROVIDERS[providerId];
    if (!provider) return;
    const modelInfo = provider.models.find(m => m.id === modelId);
    if (modelId === currentVideoModel) {
      await bot.editMessageText(`✅ Ya estás usando *${modelInfo?.label || modelId}* para video`, {
        chat_id: chatId, message_id: messageId, parse_mode: 'Markdown'
      });
      return;
    }
    currentVideoProvider = providerId;
    currentVideoModel = modelId;
    await bot.editMessageText(`✅ Modelo de video: *${provider.label}* / *${modelInfo?.label || modelId}*`, {
      chat_id: chatId, message_id: messageId, parse_mode: 'Markdown'
    });
    return;
  }
  if (data === 'vidback') {
    const provider = VIDEO_PROVIDERS[currentVideoProvider];
    const modelInfo = provider?.models.find(m => m.id === currentVideoModel);
    const allButtons = Object.entries(VIDEO_PROVIDERS).map(([id, p]) => ({
      text: `${id === currentVideoProvider ? '✅ ' : ''}${p.label}`,
      callback_data: `vidprov:${id}`
    }));
    const keyboard = [];
    for (let i = 0; i < allButtons.length; i += 2) keyboard.push(allButtons.slice(i, i + 2));
    await bot.editMessageText(
      `🎬 *Modelo de video activo:* ${provider.label} / ${modelInfo?.label || currentVideoModel}\n\nEscogé un proveedor:`, {
      chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
    return;
  }

  if (data === 'back') {
    const provider = PROVIDERS[currentProvider];
    const modelInfo = provider.models.find(m => m.id === currentModel);
    const modelLabel = modelInfo ? modelInfo.label : currentModel;
    const buttons = Object.entries(PROVIDERS).map(([id, p]) => ({
      text: `${id === currentProvider ? '✅ ' : ''}${p.label}`,
      callback_data: `prov:${id}`
    }));
    await bot.editMessageText(
      `🤖 *Modelo actual:* ${provider.label} / ${modelLabel}\n\nEscogé un proveedor:`, {
      chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [buttons] }
    });
    return;
  }
});

bot.onText(/\/status$/, async (msg) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;
  const uptime = formatUptime(Date.now() - botStartTime);
  const provider = PROVIDERS[currentProvider];
  const modelInfo = provider.models.find(m => m.id === currentModel);
  let text = `📊 <b>Estado de ${AGENT_NAME}</b>\n\n`;
  text += `🤖 <b>Modelo:</b> ${provider.label} / ${modelInfo?.label || currentModel}\n`;
  text += `⚡ <b>Effort:</b> ${currentEffort}\n`;
  text += `⏱ <b>Uptime:</b> ${uptime}\n`;
  text += `📬 <b>Cola:</b> ${messageQueue.length} mensajes\n`;
  text += processingStartTime ? `\n⚡ <b>Procesando...</b>` : `\n😎 <b>Idle</b>`;
  text += `\n💡 BTW: ${PROVIDERS[BTW_PROVIDER]?.label || BTW_PROVIDER} / ${BTW_MODEL}`;
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
});

function formatUptime(ms) {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h ${mins % 60}m`;
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  return `${mins}m ${secs % 60}s`;
}

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
  // Reset cost tracking
  sessionTokensIn = 0;
  sessionTokensOut = 0;
  sessionCostUsd = 0;
  sessionMessages = 0;
  await bot.sendMessage(msg.chat.id, '🔄 Sesion reiniciada.');
});

// --- /btw command (side-channel quick question) ---
bot.onText(/\/btw (.+)/s, async (msg, match) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;
  const question = match[1].trim();
  if (!question) {
    await bot.sendMessage(chatId, '💡 Uso: /btw <tu pregunta rápida>');
    return;
  }

  console.log(`[BTW] Pregunta rápida: "${question.substring(0, 80)}"`);
  safeSendChatAction(chatId, 'typing');

  const btwProvider = PROVIDERS[BTW_PROVIDER];
  if (!btwProvider) {
    await bot.sendMessage(chatId, `❌ Provider BTW no configurado: ${BTW_PROVIDER}`);
    return;
  }

  const spawnEnv = { ...process.env, HOME: '/app', ...btwProvider.env };
  const btwProc = spawn('openclaude', [
    '-p',
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--model', BTW_MODEL
  ], {
    cwd: '/app',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: spawnEnv
  });

  let btwBuffer = '';
  let btwText = '';
  let resolved = false;

  const timeout = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      btwProc.kill('SIGTERM');
      bot.sendMessage(chatId, '⏱ BTW timeout — la pregunta tardó demasiado.');
    }
  }, BTW_TIMEOUT_MS);

  btwProc.stdout.on('data', (chunk) => {
    btwBuffer += chunk.toString();
    const lines = btwBuffer.split('\n');
    btwBuffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'assistant' && parsed.message?.content) {
          const parts = parsed.message.content.filter(c => c.type === 'text').map(c => c.text);
          if (parts.length > 0) btwText = parts.join('');
        } else if (parsed.type === 'result' && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          const response = btwText || parsed.result || '(sin respuesta)';
          const clean = response.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();
          console.log(`[BTW] Respuesta: ${clean.length} chars`);
          sendTextResponse(chatId, `💡 *BTW:*\n${clean}`).catch(() => {
            bot.sendMessage(chatId, `💡 BTW:\n${clean}`);
          });
          btwProc.kill('SIGTERM');
        }
      } catch (e) { /* not JSON */ }
    }
  });

  btwProc.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.error(`[BTW stderr] ${text}`);
  });

  btwProc.on('exit', () => {
    clearTimeout(timeout);
    if (!resolved) {
      resolved = true;
      bot.sendMessage(chatId, '❌ BTW process terminó sin respuesta.');
    }
  });

  const inputMsg = {
    type: 'user',
    session_id: '',
    message: { role: 'user', content: `Respondé de forma MUY breve y directa (máximo 2-3 oraciones). Pregunta: ${question}` },
    parent_tool_use_id: null
  };
  btwProc.stdin.write(JSON.stringify(inputMsg) + '\n');
});

// --- /cost command ---
bot.onText(/\/cost$/, async (msg) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;
  const uptime = formatUptime(Date.now() - botStartTime);

  let costText = `💰 <b>Costos de sesión</b>\n\n`;
  costText += `📊 <b>Mensajes:</b> ${sessionMessages}\n`;
  if (sessionTokensIn > 0 || sessionTokensOut > 0) {
    costText += `📥 <b>Tokens in:</b> ${sessionTokensIn.toLocaleString()}\n`;
    costText += `📤 <b>Tokens out:</b> ${sessionTokensOut.toLocaleString()}\n`;
    costText += `📦 <b>Total:</b> ${(sessionTokensIn + sessionTokensOut).toLocaleString()}\n`;
  }
  if (sessionCostUsd > 0) {
    costText += `💵 <b>Costo:</b> $${sessionCostUsd.toFixed(4)} USD\n`;
  }
  costText += `\n⏱ <b>Uptime:</b> ${uptime}`;
  costText += `\n🤖 <b>Modelo:</b> ${PROVIDERS[currentProvider]?.label} / ${currentModel}`;

  await bot.sendMessage(chatId, costText, { parse_mode: 'HTML' });
});

// --- /effort command ---
bot.onText(/\/effort(?:\s+(\w+))?$/, async (msg, match) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;
  const level = match?.[1]?.toLowerCase();
  const valid = ['low', 'medium', 'high', 'max', 'auto'];

  if (!level) {
    await bot.sendMessage(chatId,
      `⚡ <b>Effort actual:</b> ${currentEffort}\n\nNiveles: <code>${valid.join(', ')}</code>\nUso: <code>/effort medium</code>`,
      { parse_mode: 'HTML' });
    return;
  }

  if (!valid.includes(level)) {
    await bot.sendMessage(chatId, `❌ Nivel inválido. Opciones: ${valid.join(', ')}`);
    return;
  }

  currentEffort = level;
  await bot.sendMessage(chatId, `⚡ Effort cambiado a <b>${level}</b>. Reiniciando proceso...`, { parse_mode: 'HTML' });
  intentionalKill = true;
  if (openclaudeProcess) openclaudeProcess.kill('SIGTERM');
});

bot.onText(/\/help$/, async (msg) => {
  if (!isAllowed(msg)) return;
  const help = `📋 <b>Comandos de ${AGENT_NAME}</b>\n
💬 Texto directo — respuesta normal
🔧 <code>/status</code> — estado actual
🤖 <code>/model</code> — modelo activo
💡 <code>/btw pregunta</code> — pregunta rápida (funciona mientras estoy ocupado)
💰 <code>/cost</code> — tokens y costos de sesión
⚡ <code>/effort nivel</code> — nivel de esfuerzo (low/medium/high/max/auto)
🎨 <code>/imagen</code> — modelo de generación de imagen
🎬 <code>/video</code> — modelo de generación de video
🛑 <code>/cancel</code> — cancelar tarea actual
🔄 <code>/clear</code> — reinicio de sesion
❓ <code>/help</code> — esta lista`;
  await bot.sendMessage(msg.chat.id, help, { parse_mode: 'HTML' });
});

// --- Image model page builder ---
async function showImageModelPage(chatId, messageId, providerId, page) {
  const provider = IMAGE_PROVIDERS[providerId];
  if (!provider) return;
  const models = provider.models;
  const totalPages = Math.ceil(models.length / MODELS_PER_PAGE);
  const start = page * MODELS_PER_PAGE;
  const pageModels = models.slice(start, start + MODELS_PER_PAGE);
  const buttons = [];
  for (let i = 0; i < pageModels.length; i += 2) {
    const row = [];
    const m1 = pageModels[i];
    row.push({
      text: `${m1.id === currentImageModel ? '✅ ' : ''}${m1.label} (${m1.price})`,
      callback_data: `imgmdl:${providerId}:${m1.id}`
    });
    if (pageModels[i + 1]) {
      const m2 = pageModels[i + 1];
      row.push({
        text: `${m2.id === currentImageModel ? '✅ ' : ''}${m2.label} (${m2.price})`,
        callback_data: `imgmdl:${providerId}:${m2.id}`
      });
    }
    buttons.push(row);
  }
  const navRow = [];
  if (page > 0) navRow.push({ text: '⬅️ Anterior', callback_data: `imgpage:${providerId}:${page - 1}` });
  navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: 'noop' });
  if (page < totalPages - 1) navRow.push({ text: 'Siguiente ➡️', callback_data: `imgpage:${providerId}:${page + 1}` });
  buttons.push(navRow);
  buttons.push([{ text: '⬅️ Volver a proveedores', callback_data: 'imgback' }]);
  const text = `🎨 *${provider.label}* — Página ${page + 1}/${totalPages}\n\nEscogé un modelo de imagen:`;
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } };
  if (messageId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts });
  } else {
    await bot.sendMessage(chatId, text, opts);
  }
}

// --- Video model page builder ---
async function showVideoModelPage(chatId, messageId, providerId, page) {
  const provider = VIDEO_PROVIDERS[providerId];
  if (!provider) return;
  const models = provider.models;
  const totalPages = Math.ceil(models.length / MODELS_PER_PAGE);
  const start = page * MODELS_PER_PAGE;
  const pageModels = models.slice(start, start + MODELS_PER_PAGE);
  const buttons = [];
  for (let i = 0; i < pageModels.length; i += 2) {
    const row = [];
    const m1 = pageModels[i];
    row.push({
      text: `${m1.id === currentVideoModel ? '✅ ' : ''}${m1.label} (${m1.price})`,
      callback_data: `vidmdl:${providerId}:${m1.id}`
    });
    if (pageModels[i + 1]) {
      const m2 = pageModels[i + 1];
      row.push({
        text: `${m2.id === currentVideoModel ? '✅ ' : ''}${m2.label} (${m2.price})`,
        callback_data: `vidmdl:${providerId}:${m2.id}`
      });
    }
    buttons.push(row);
  }
  const navRow = [];
  if (page > 0) navRow.push({ text: '⬅️ Anterior', callback_data: `vidpage:${providerId}:${page - 1}` });
  navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: 'noop' });
  if (page < totalPages - 1) navRow.push({ text: 'Siguiente ➡️', callback_data: `vidpage:${providerId}:${page + 1}` });
  buttons.push(navRow);
  buttons.push([{ text: '⬅️ Volver a proveedores', callback_data: 'vidback' }]);
  const text = `🎬 *${provider.label}* — Página ${page + 1}/${totalPages}\n\nEscogé un modelo de video:`;
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } };
  if (messageId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts });
  } else {
    await bot.sendMessage(chatId, text, opts);
  }
}

// --- /imagen command ---
bot.onText(/\/image[n]?(?:@\w+)?$/i, async (msg) => {
  console.log('[Command] /imagen received');
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;
  const provider = IMAGE_PROVIDERS[currentImageProvider];
  const modelInfo = provider?.models.find(m => m.id === currentImageModel);
  const modelLabel = modelInfo ? modelInfo.label : currentImageModel;
  const allButtons = Object.entries(IMAGE_PROVIDERS).map(([id, p]) => ({
    text: `${id === currentImageProvider ? '✅ ' : ''}${p.label}`,
    callback_data: `imgprov:${id}`
  }));
  const keyboard = [];
  for (let i = 0; i < allButtons.length; i += 2) {
    keyboard.push(allButtons.slice(i, i + 2));
  }
  await bot.sendMessage(chatId,
    `🎨 *Modelo de imagen activo:* ${provider.label} / ${modelLabel}\n\nEscogé un proveedor:`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
});

// --- /video command ---
bot.onText(/\/video[s]?(?:@\w+)?$/i, async (msg) => {
  console.log('[Command] /video received');
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;
  const provider = VIDEO_PROVIDERS[currentVideoProvider];
  const modelInfo = provider?.models.find(m => m.id === currentVideoModel);
  const modelLabel = modelInfo ? modelInfo.label : currentVideoModel;
  const allButtons = Object.entries(VIDEO_PROVIDERS).map(([id, p]) => ({
    text: `${id === currentVideoProvider ? '✅ ' : ''}${p.label}`,
    callback_data: `vidprov:${id}`
  }));
  const keyboard = [];
  for (let i = 0; i < allButtons.length; i += 2) {
    keyboard.push(allButtons.slice(i, i + 2));
  }
  await bot.sendMessage(chatId,
    `🎬 *Modelo de video activo:* ${provider.label} / ${modelLabel}\n\nEscogé un proveedor:`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
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
      const status = new StatusCard(bot, chatId);
      const imgPath = path.join(TMP_DIR, `telegram_img_${timestamp}.jpg`);

      try {
        await status.init([
          ['📥', 'Descargando imagen'],
          ['👁️', 'Analizando imagen'],
          ['🧠', 'Pensando'],
          ['📝', 'Preparando respuesta']
        ]);
        activeStatusCard = status;

        const fileId = msg.photo
          ? msg.photo[msg.photo.length - 1].file_id
          : msg.document.file_id;

        await downloadTelegramFile(fileId, imgPath);
        const imageBuffer = fs.readFileSync(imgPath);
        const imageBase64 = imageBuffer.toString('base64');
        const mimeType = msg.document?.mime_type || 'image/jpeg';

        // Store image for follow-up text messages (per-chat)
        setImageContext(chatId, imageBase64, mimeType);
        console.log(`[Image Context] Stored image (${imageBase64.length} chars) — available for ${IMAGE_CONTEXT_TTL_MS / 60000} min`);

        await status.advance(); // → Analizando imagen
        const senderPrefix = formatUserPrefix(msg);
        const imgMessage = caption
          ? `${senderPrefix} [IMAGEN] Caption: "${caption}". Respondé en base a lo que ves.`
          : `${senderPrefix} [IMAGEN sin caption] Respondé en base a lo que ves en la imagen.`;

        await status.advance(); // → Pensando
        let rawResponse = await callAgent(imgMessage, imageBase64, mimeType);
        rawResponse = await handleDelegation(rawResponse);
        let responseText = rawResponse.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();

        // Force TEXTO when generating images/videos
        const hasMediaImg = /\[GENIMG\]|\[GENVID\]/i.test(responseText);
        if (hasMediaImg) {
          console.log('[Format] Forcing TEXTO — response contains image/video generation tags');
        }

        // Process image/video generation tags
        responseText = await processMediaTags(responseText, chatId);

        await status.advance(); // → Preparando respuesta
        await sendTextResponse(chatId, responseText);
        await status.complete();
        console.log(`[${AGENT_NAME}] Respuesta enviada (imagen ${responseText.length} chars)`);
        try { responseText = memory.extractAndSaveMemories(responseText); } catch (memErr) { console.error('[Memory Extract Error]', memErr.message); }
        try { memory.saveExchange(caption ? `[Imagen: "${caption}"]` : '[Imagen sin caption]', responseText); honcho.updateUserModel({ user: caption || '[imagen]', assistant: responseText }).catch(() => {}); } catch (e) { console.error('[DB Error]', e.message); }
        postExchangeHook(caption || '[imagen]', responseText);
        postExchangeHook(caption || '[imagen]', responseText);
      } catch (err) {
        await status.fail(err.message);
        console.error(`[Image Error]`, err.message);
        bot.sendMessage(chatId, `❌ Error procesando imagen: ${err.message.substring(0, 200)}`);
      } finally {
        cleanup(imgPath);
      }
    });
    return;
  }

  // --- DOCUMENT MESSAGE FLOW (non-image files: PDF, Word, Excel, etc.) ---
  const isNonImageDoc = !!(msg.document && msg.document.mime_type && !msg.document.mime_type.startsWith('image/'));
  if (isNonImageDoc) {
    const caption = msg.caption || '';
    const fileName = msg.document.file_name || 'unknown';
    const mimeType = msg.document.mime_type || '';
    console.log(`[User] Documento recibido: ${fileName} (${mimeType}). Caption: "${caption}"`);

    enqueueMessage(async () => {
      const status = new StatusCard(bot, chatId);
      const ext = path.extname(fileName).toLowerCase();
      const docPath = path.join(TMP_DIR, `telegram_doc_${timestamp}${ext}`);
      const txtPath = path.join(TMP_DIR, `telegram_doc_${timestamp}.txt`);

      try {
        await status.init([
          ['📥', 'Descargando archivo'],
          ['📄', 'Extrayendo contenido'],
          ['🧠', 'Analizando'],
          ['📝', 'Preparando respuesta']
        ]);
        activeStatusCard = status;

        // Download file
        await downloadTelegramFile(msg.document.file_id, docPath);
        await status.advance(); // → Extrayendo contenido

        // Extract text based on file type
        let extractedText = '';
        const { execSync } = require('child_process');
        try {
          if (ext === '.pdf') {
            extractedText = execSync(`pdftotext "${docPath}" - 2>/dev/null`, { maxBuffer: 5 * 1024 * 1024 }).toString();
          } else if (ext === '.docx' || ext === '.doc' || ext === '.odt' || ext === '.rtf') {
            extractedText = execSync(`pandoc "${docPath}" -t plain 2>/dev/null`, { maxBuffer: 5 * 1024 * 1024 }).toString();
          } else if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
            if (ext === '.csv') {
              extractedText = fs.readFileSync(docPath, 'utf8');
            } else {
              // Try pandoc for xlsx, fallback to raw
              try {
                extractedText = execSync(`pandoc "${docPath}" -t plain 2>/dev/null`, { maxBuffer: 5 * 1024 * 1024 }).toString();
              } catch (e) {
                extractedText = `[Archivo Excel: ${fileName}. No se pudo extraer contenido como texto. Sugiere al usuario exportar a CSV o PDF.]`;
              }
            }
          } else if (ext === '.txt' || ext === '.md' || ext === '.json' || ext === '.js' || ext === '.py' || ext === '.html' || ext === '.xml' || ext === '.yaml' || ext === '.yml' || ext === '.toml' || ext === '.ini' || ext === '.cfg' || ext === '.log' || ext === '.sh') {
            extractedText = fs.readFileSync(docPath, 'utf8');
          } else if (ext === '.pptx' || ext === '.ppt') {
            try {
              extractedText = execSync(`pandoc "${docPath}" -t plain 2>/dev/null`, { maxBuffer: 5 * 1024 * 1024 }).toString();
            } catch (e) {
              extractedText = `[Archivo PowerPoint: ${fileName}. No se pudo extraer texto automáticamente.]`;
            }
          } else {
            // Try pandoc as generic fallback
            try {
              extractedText = execSync(`pandoc "${docPath}" -t plain 2>/dev/null`, { maxBuffer: 5 * 1024 * 1024 }).toString();
            } catch (e) {
              // Last resort: try reading as plain text
              try {
                extractedText = fs.readFileSync(docPath, 'utf8').substring(0, 10000);
              } catch (e2) {
                extractedText = `[Archivo binario: ${fileName} (${mimeType}). No se pudo extraer texto.]`;
              }
            }
          }
        } catch (parseErr) {
          console.error(`[Doc Parse Error] ${parseErr.message}`);
          extractedText = `[Error extrayendo contenido de ${fileName}: ${parseErr.message}]`;
        }

        // Truncate if too long
        if (extractedText.length > 15000) {
          extractedText = extractedText.substring(0, 15000) + '\n\n[... contenido truncado por longitud ...]';
        }

        await status.advance(); // → Analizando
        const senderPrefix = formatUserPrefix(msg);
        const docMessage = `${senderPrefix} [DOCUMENTO: "${fileName}" (${mimeType})]${caption ? `\nCaption: "${caption}"` : ''}\n\n--- CONTENIDO DEL ARCHIVO ---\n${extractedText}\n--- FIN DEL ARCHIVO ---\n\nAnaliza este documento y respondé en base a su contenido.`;

        let rawResponse = await callAgent(docMessage);
        rawResponse = await handleDelegation(rawResponse);
        let responseText = rawResponse.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();

        // Process image/video generation tags
        responseText = await processMediaTags(responseText, chatId);

        await status.advance(); // → Preparando respuesta
        await sendTextResponse(chatId, responseText);
        await status.complete();
        console.log(`[${AGENT_NAME}] Respuesta enviada (documento ${responseText.length} chars)`);
        try { responseText = memory.extractAndSaveMemories(responseText); } catch (memErr) { console.error('[Memory Extract Error]', memErr.message); }
        try { memory.saveExchange(`[Documento: "${fileName}"] ${caption || ''}`, responseText); honcho.updateUserModel({ user: `[Documento: ${fileName}] ${caption}`, assistant: responseText }).catch(() => {}); } catch (e) { console.error('[DB Error]', e.message); }
        postExchangeHook(`[Documento: ${fileName}] ${caption || ''}`, responseText);
        postExchangeHook(`[Documento: ${fileName}] ${caption || ''}`, responseText);
      } catch (err) {
        await status.fail(err.message);
        console.error(`[Document Error]`, err.message);
        bot.sendMessage(chatId, `❌ Error procesando documento: ${err.message.substring(0, 200)}`);
      } finally {
        cleanup(docPath, txtPath);
      }
    });
    return;
  }

  // --- AUDIO MESSAGE FLOW ---
  if (msg.voice || msg.audio) {
    console.log(`[User] Audio recibido`);

    enqueueMessage(async () => {
      const status = new StatusCard(bot, chatId);
      const audioPath = path.join(TMP_DIR, `telegram_audio_${timestamp}.ogg`);
      const ttsRaw = path.join(TMP_DIR, `tts_raw_${timestamp}.ogg`);
      const ttsBoosted = path.join(TMP_DIR, `tts_boost_${timestamp}.ogg`);

      try {
        await status.init([
          ['📥', 'Descargando audio'],
          ['🎙️', 'Transcribiendo'],
          ['🧠', 'Pensando'],
          ['🔊', 'Generando audio']
        ]);
        activeStatusCard = status;

        const fileId = (msg.voice || msg.audio).file_id;
        await downloadTelegramFile(fileId, audioPath);
        const audioSize = fs.statSync(audioPath).size;
        console.log(`[Audio] Archivo descargado: ${audioPath} (${audioSize} bytes)`);

        await status.advance(); // → Transcribiendo
        const transcription = await transcribeAudio(audioPath);
        console.log(`[Audio] Transcripción resultado: "${transcription}" (length: ${transcription?.length || 0})`);
        if (!transcription || !transcription.trim()) {
          await status.fail();
          bot.sendMessage(chatId, '❌ No logré transcribir el audio. Intentá de nuevo.');
          return;
        }

        await status.advance(); // → Pensando
        const senderPrefix = formatUserPrefix(msg);
        const audioPrompt = `${senderPrefix} [Este mensaje viene de un audio] ${transcription}`;
        console.log(`[Audio] Enviando a OpenClaude: "${audioPrompt.substring(0, 200)}"`);
        // Attach recent image if available (per-chat)
        const audioImgCtx = getImageContext(chatId);
        let audioImgB64 = null;
        let audioImgMime = null;
        if (audioImgCtx) {
          audioImgB64 = audioImgCtx.base64;
          audioImgMime = audioImgCtx.mimeType;
          console.log(`[Image Context] Attaching stored image to audio message`);
        }
        let rawResponse = await callAgent(audioPrompt, audioImgB64, audioImgMime);
        rawResponse = await handleDelegation(rawResponse);
        // Check if agent explicitly requested audio BEFORE stripping the tag
        const wantsAudio = /^\[AUDIO\]/i.test(rawResponse);
        let responseText = rawResponse.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();

        // Force TEXTO when generating images/videos
        const hasMediaAudio = /\[GENIMG\]|\[GENVID\]/i.test(responseText);
        if (hasMediaAudio) {
          console.log('[Format] Forcing TEXTO — response contains image/video generation tags');
        }

        // Process image/video generation tags
        responseText = await processMediaTags(responseText, chatId);

        try { responseText = memory.extractAndSaveMemories(responseText); } catch (memErr) { console.error('[Memory Extract Error]', memErr.message); }

        if (wantsAudio && !hasMediaAudio) {
          // Agent explicitly requested audio response
          await status.advance(); // → Generando audio
          const ttsText = cleanTextForTTS(responseText);
          await textToSpeech(ttsText, ttsRaw);
          await boostVolume(ttsRaw, ttsBoosted);
          await bot.sendVoice(chatId, ttsBoosted);
          await status.complete();
          console.log(`[${AGENT_NAME}] Voice note enviada`);
        } else {
          // Default: send as text (agent said [TEXTO] or no explicit [AUDIO])
          console.log(`[${AGENT_NAME}] Audio input but agent responded with TEXTO — sending text`);
          await sendTextResponse(chatId, responseText);
          await status.complete();
        }
        try { memory.saveExchange(`[Audio: "${transcription.substring(0, 150)}"]`, responseText); honcho.updateUserModel({ user: transcription, assistant: responseText }).catch(() => {}); } catch (e) { console.error('[DB Error]', e.message); }
        postExchangeHook(transcription, responseText);
        postExchangeHook(transcription, responseText);
      } catch (err) {
        await status.fail(err.message);
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

// --- Auto-fetch URLs with Jina.ai Reader ---
async function extractUrlContent(text) {
  const urlRegex = /https?:\/\/[^\s<>'")\]]+/gi;
  const urls = text.match(urlRegex);
  if (!urls || urls.length === 0) return text;
  let enrichedText = text;
  for (const url of urls.slice(0, 3)) {
    try {
      console.log(`[Jina] Fetching: ${url}`);
      const response = await axios.get(`https://r.jina.ai/${url}`, {
        headers: { 'Accept': 'text/plain', 'X-No-Cache': 'true' },
        timeout: 20000, maxContentLength: 50000
      });
      const content = response.data?.substring(0, 4000) || '';
      if (content.length > 100 && !content.includes('Enable JavaScript and cookies')) {
        console.log(`[Jina] Contenido extraído: ${content.length} chars`);
        enrichedText += `\n\n[CONTENIDO EXTRAÍDO DE ${url}]:\n${content}\n[FIN DEL CONTENIDO]`;
      } else {
        console.log(`[Jina] Contenido insuficiente para: ${url}`);
      }
    } catch (err) { console.log(`[Jina] Error: ${err.message}`); }
  }
  return enrichedText;
}

async function handleTextMessage(chatId, text, senderMsg) {
  const status = new StatusCard(bot, chatId);
  try {
    await status.init([
      ['💬', 'Recibido'],
      ['🧠', 'Pensando'],
      ['📝', 'Preparando respuesta']
    ]);
    activeStatusCard = status;
    processingStartTime = Date.now();
    const senderPrefix = senderMsg ? formatUserPrefix(senderMsg) : '';
    const enrichedText = await extractUrlContent(text);
    if (enrichedText !== text) console.log(`[Jina] Mensaje enriquecido con contenido de URLs`);
    const payload = senderPrefix ? `${senderPrefix} ${enrichedText}` : enrichedText;

    await status.advance(); // → Pensando

    // Check if there's a recent image in context to attach (per-chat)
    const textImgCtx = getImageContext(chatId);
    let imgB64 = null;
    let imgMime = null;
    if (textImgCtx) {
      imgB64 = textImgCtx.base64;
      imgMime = textImgCtx.mimeType;
      console.log(`[Image Context] Attaching stored image to text message (age: ${Math.round((Date.now() - textImgCtx.timestamp) / 1000)}s)`);
    }
    let rawResponse = await callAgent(payload, imgB64, imgMime);
    rawResponse = await handleDelegation(rawResponse);
    let responseText = rawResponse.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();

    // Force TEXTO when generating images/videos
    const hasMedia = /\[GENIMG\]|\[GENVID\]/i.test(responseText);
    if (hasMedia) {
      console.log('[Format] Forcing TEXTO — response contains image/video generation tags');
    }

    // Process image/video generation tags
    responseText = await processMediaTags(responseText, chatId);

    await status.advance(); // → Preparando respuesta
    try { responseText = memory.extractAndSaveMemories(responseText); } catch (memErr) { console.error('[Memory Extract Error]', memErr.message); }
    await sendTextResponse(chatId, responseText);
    if (responseText.includes('[ERROR:AUTH]')) {
      await status.complete();
    } else {
      await status.complete();
    }
    console.log(`[${AGENT_NAME}] Respuesta enviada (${responseText.length} chars)`);
    try { memory.saveExchange(text, responseText); honcho.updateUserModel({ user: text, assistant: responseText }).catch(() => {}); } catch (e) { console.error('[DB Error]', e.message); }
    postExchangeHook(text, responseText);
    postExchangeHook(text, responseText);
  } catch (err) {
    await status.fail(err.message);
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
  modelPresets.setManualModel(providerId, modelId);
  intentionalKill = true;
  if (openclaudeProcess) openclaudeProcess.kill('SIGTERM');
  else spawnOpenClaude();
}

// --- Start ---
spawnOpenClaude();
setTimeout(connectToMC, 3000);

// --- Daily Summary Cron (11:59 PM Costa Rica time) ---
function scheduleDailySummary() {
  const now = new Date();
  const cr = new Date(now.toLocaleString('en-US', { timeZone: 'America/Costa_Rica' }));
  const target = new Date(cr);
  target.setHours(23, 59, 0, 0);
  if (cr >= target) target.setDate(target.getDate() + 1);
  const msUntil = target.getTime() - cr.getTime();
  console.log(`[Cron] Daily summary scheduled in ${Math.round(msUntil / 60000)} minutes`);

  setTimeout(async () => {
    const today = new Date().toISOString().split('T')[0];
    console.log(`[Cron] Running daily summary for ${today}...`);
    try {
      if (!memory.needsSummary(today)) {
        console.log('[Cron] No unsummarized messages, skipping');
        scheduleDailySummary();
        return;
      }
      const prompt = memory.buildSummaryPrompt(today);
      if (!prompt) { scheduleDailySummary(); return; }

      const summary = await callAgent(prompt);
      if (summary && summary.trim().length > 50) {
        memory.saveDailySummary(today, summary);
        console.log(`[Cron] Daily summary saved for ${today}`);
      }
    } catch (e) {
      console.error('[Cron] Daily summary error:', e.message);
    }
    scheduleDailySummary();
  }, msUntil);
}
scheduleDailySummary();

// --- Dreaming Cron (3:00 AM Costa Rica time) ---
function scheduleDreaming() {
  const now = new Date();
  const cr = new Date(now.toLocaleString('en-US', { timeZone: 'America/Costa_Rica' }));
  const target = new Date(cr);
  target.setHours(3, 0, 0, 0);
  if (cr >= target) target.setDate(target.getDate() + 1);
  const msUntil = target.getTime() - cr.getTime();
  console.log(`[Cron] Dreaming scheduled in ${Math.round(msUntil / 60000)} minutes`);

  setTimeout(async () => {
    console.log('[Cron] Running dreaming cycle...');
    try {
      await dreaming.dream();
      console.log('[Cron] Dreaming cycle complete');
    } catch (e) {
      console.error('[Cron] Dreaming error:', e.message);
    }
    scheduleDreaming();
  }, msUntil);
}
scheduleDreaming();

// --- Run dreaming on startup if last run was >24h ago ---
(async () => {
  try {
    const dreamsPath = '/app/data/memory/DREAMS.md';
    const dreamsContent = fs.existsSync(dreamsPath) ? fs.readFileSync(dreamsPath, 'utf-8') : '';
    const lastRunMatch = dreamsContent.match(/## (\d{4}-\d{2}-\d{2}) — Consolidación/g);
    const lastRunDate = lastRunMatch ? lastRunMatch[lastRunMatch.length - 1].match(/\d{4}-\d{2}-\d{2}/)[0] : null;
    const today = new Date().toISOString().split('T')[0];
    const journalDir = '/app/data/memory/journal';
    const hasJournals = fs.existsSync(journalDir) && fs.readdirSync(journalDir).filter(f => f.endsWith('.md')).length > 0;

    if (hasJournals && lastRunDate !== today) {
      console.log(`[Dreaming] Startup: last run=${lastRunDate || 'never'}, running catch-up cycle...`);
      // Delay 30s to let bot fully initialize
      setTimeout(async () => {
        try {
          await dreaming.dream();
          console.log('[Dreaming] Startup catch-up complete');
        } catch (e) {
          console.error('[Dreaming] Startup catch-up error:', e.message);
        }
      }, 30000);
    } else {
      console.log(`[Dreaming] Startup: already ran today or no journals, skipping`);
    }
  } catch (e) {
    console.error('[Dreaming] Startup check error:', e.message);
  }
})();

bot.on('polling_error', (err) => console.error('[Polling Error]', err.message));
process.on('uncaughtException', (err) => console.error('[Uncaught]', err));
process.on('unhandledRejection', (err) => console.error('[Unhandled]', err));
