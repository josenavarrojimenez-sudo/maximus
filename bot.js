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
const skillLoader = require('./skill-loader.js');
// ─── HEARTBEAT (app-level watchdog for agent-healer) ──
let __heartbeat = null;
try { __heartbeat = require('/opt/zeus-shared/heartbeat.js'); }
catch (e) { console.warn('[Heartbeat] not available:', e.message); }
const __HEARTBEAT_AGENT = 'maximus-telegram';
let __lastMessageAt = null;
let __lastResponseAt = null;
let __subprocStartedAt = null;
let __lastSubprocOutputAt = null;
// ─── DOC-LOGGER (fixes + implementaciones) ──
let __docLogger = null;
try { __docLogger = require('/opt/zeus-shared/doc-logger.js'); }
catch (e) { console.warn('[DocLogger] not available:', e.message); }
// [MCTASK auto-create] — agent emits [MCTASK:title|desc] → task created silently
let __mcTaskAuto = null;
try { __mcTaskAuto = require('/opt/zeus-shared/mc-task-auto.js'); }
catch (e) { console.warn('[MCTask] not available:', e.message); }
const __AGENT_SOURCE = 'maximus';

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

async function mcCreateTask(title, description, assignedTo) {
  if (!mcAgentId) return null;
  try {
    const res = await mcRequest('/api/tasks', 'POST', {
      title: title.substring(0, 100),
      description: description ? description.substring(0, 500) : '',
      status: 'in_progress',
      priority: 'medium',
      assigned_to: (assignedTo || MC_AGENT_NAME).toLowerCase(),
      created_by: MC_AGENT_NAME
    });
    if ((res.status === 200 || res.status === 201) && res.body.task) {
      console.log(`[MC] Task created: ${res.body.task.ticket_ref}`);
      return res.body.task.id;
    }
  } catch (e) { /* non-critical */ }
  return null;
}

async function mcCompleteTask(taskId, resolution, outcome) {
  if (!mcAgentId || !taskId) return;
  try {
    await mcRequest(`/api/tasks/${taskId}`, 'PUT', {
      status: 'quality_review',
      resolution: resolution ? resolution.substring(0, 300) : 'Completado',
      outcome: outcome || 'success'
    });
    console.log(`[MC] Task ${taskId} → quality_review`);
  } catch (e) { /* non-critical */ }
}

// --- Detección inteligente de tareas reales ---
function isRealTask(text) {
  if (!text) return false;
  const t = text.trim();

  if (t.length < 35) return false;

  if (/^(si|sí|no|ok|ya|listo|dale|bien|gracias|perfecto|exacto|correcto|claro|bueno|okey|yeah|oki|oka|true|false|genial|chiva|pura vida|de una|va|vamos|listo mae|listo vos|eso|cierto|eso mismo|entendido|recibido|copy|roger)[\s!.,]*$/i.test(t)) return false;

  if (/^[A-Za-z0-9+/=_\-#]{25,}$/.test(t)) return false;

  const actionVerbs = /\b(hac[eé][r]?|generá|genera[r]?|crea[r]?|creá|env[ií]a[r]?|enviá|arregl[aá][r]?|busca[r]?|buscá|revis[aá][r]?|actualiz[aá][r]?|implement[aá][r]?|agrega[r]?|modificá|instalá|configurá|ejecuta[r]?|mandá|construí|construye[r]?|desarrolla[r]?|reconstruye[r]?|rebuild[s]?|deploy[s]?|push|pull|clona[r]?|reinicia[r]?|restart[s]?|para[r]?|detené|arranca[r]?|analiz[aá][r]?|migra[r]?|optimiz[aá][r]?|diseña[r]?|mánda[me]?|haceme|generame|dame|pasame|mostrame|explicame|decime|ayudame|corregí|corrige[r]?|elimina[r]?|borra[r]?|agregá|añade[r]?|sube[r]?|descarga[r]?|instala[r]?)\b/i;
  if (actionVerbs.test(t)) return true;

  if (/\b(podés|podes|puedes|podrías|podrias|podemos|puede[s]?)\b.*\?/i.test(t)) return true;

  if (t.length > 120) return true;

  return false;
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
// Owner guard — gate destructive commands to Jose only (portable helper).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isOwner, requireOwner } = require('/opt/zeus-shared/owner-guard.js');
// Generic approval buttons — agents can emit [APPROVAL:action_id:description].
// eslint-disable-next-line @typescript-eslint/no-var-requires
const approvals = require('/opt/zeus-shared/approval-buttons.js');


const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || process.env.ALLOWED_USER_ID || '')
  .split(',')
  .map(s => parseInt(s.trim(), 10))
  .filter(n => Number.isFinite(n));
const ALLOWED_USER_ID = ALLOWED_USER_IDS[0]; // primary user for typing indicators / notifications
const AGENT_NAME = process.env.AGENT_NAME || 'Agent';
const TMP_DIR = path.join(__dirname, 'tmp');
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';

// ElevenLabs TTS config — voice config driven by .env to survive bot.js overwrites
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'iwd8AcSi0Je5Quc56ezK';
const TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || 'eleven_v3';
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
      { id: 'kimi-k2.6:cloud', label: 'Kimi K2.6' },
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
      { id: 'arcee-ai/trinity-large-thinking', label: 'Trinity Large Thinking' },
      { id: 'xiaomi/mimo-v2.5-pro', label: 'MiMo-V2.5-Pro' },
      { id: 'xiaomi/mimo-v2.5', label: 'MiMo-V2.5' },
      { id: 'inclusionai/ling-2.6-flash:free', label: 'Ling 2.6 Flash (Free)' },
      { id: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6' },
      { id: 'tencent/hy3-preview:free', label: 'Tencent HY3 Preview (Free)' }
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
      { id: 'openai/gpt-5.4-image-2', label: 'GPT-5.4 Image 2', price: '$8/$15M' },
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

// --- TTS Providers (ElevenLabs default, OpenAI via OpenRouter alt) ---
const TTS_PROVIDERS = {
  elevenlabs: {
    label: 'ElevenLabs',
    voices: [
      { id: 'default', label: 'Voz por defecto (.env)' }
    ]
  },
  openai: {
    label: 'OpenAI TTS (OpenRouter)',
    model: 'openai/gpt-audio-mini',
    voices: [
      { id: 'nova', label: 'Nova' },
      { id: 'alloy', label: 'Alloy' },
      { id: 'coral', label: 'Coral' },
      { id: 'echo', label: 'Echo' },
      { id: 'sage', label: 'Sage' },
      { id: 'shimmer', label: 'Shimmer' }
    ]
  }
};
let currentTTSProvider = 'elevenlabs';
let currentTTSVoice = 'default';

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
// --- Auto-failover across providers when process dies mid-message ---
let _lastUserInputMsg = null;       // last JSON input sent to subprocess (for re-send after failover)
let _autoFailoverAttempts = 0;      // how many providers already tried for current message
const MAX_AUTO_FAILOVER = 3;        // max providers to try before giving up
let activeChatId = null; // Track who triggered the current callAgent() for per-user isolation

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
const IMAGE_CONTEXT_TTL_MS = 30 * 60 * 1000; // 30 min — image stays available for multi-turn editing sessions
function getImageContext(chatId) {
  const ctx = imageContextByChat.get(chatId);
  if (!ctx) return null;
  if ((Date.now() - ctx.timestamp) >= IMAGE_CONTEXT_TTL_MS) {
    imageContextByChat.delete(chatId);
    return null;
  }
  return ctx; // Don't delete on read — keep available for multiple follow-up generations
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

    const unexpectedDeath = !intentionalKill && code !== 0;
    const hadPending = !!pendingResolve;

    // AUTO-FAILOVER: process crashed while handling a user message → try next provider
    if (unexpectedDeath && hadPending && _lastUserInputMsg && _autoFailoverAttempts < MAX_AUTO_FAILOVER && typeof modelPresets !== 'undefined') {
      _autoFailoverAttempts++;
      const failed = `${currentProvider}/${currentModel}`;
      const next = modelPresets.onModelFailure('process died');
      if (next) {
        currentProvider = next.provider;
        currentModel = next.model;
        console.log(`[Auto-Failover ${_autoFailoverAttempts}/${MAX_AUTO_FAILOVER}] ${failed} crashed → switching to ${next.provider}/${next.model}`);
        if (activeStatusCard) {
          activeStatusCard.update(`🔄 Cambiando a ${next.label || next.model}…`).catch(() => {});
        }
        const savedInput = _lastUserInputMsg;
        intentionalKill = false;
        setTimeout(() => {
          console.log('[OpenClaude] Respawning with failover provider...');
          spawnOpenClaude();
          setTimeout(() => {
            if (openclaudeProcess && pendingResolve && savedInput) {
              try {
                openclaudeProcess.stdin.write(JSON.stringify(savedInput) + '\n');
                console.log('[Auto-Failover] Re-sent pending message to new provider');
              } catch (e) {
                console.error('[Auto-Failover] Re-send failed:', e.message);
                if (pendingReject) {
                  const rej = pendingReject;
                  pendingResolve = null; pendingReject = null;
                  if (pendingTimeout) { clearInterval(pendingTimeout); pendingTimeout = null; }
                  rej(new Error('Failover failed on resend: ' + e.message));
                }
              }
            }
          }, 3000);
        }, 500);
        return;
      }
    }

    // Normal path: clean up pending + respawn with same config
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
    _autoFailoverAttempts = 0;
    _lastUserInputMsg = null;
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

  // [Subprocess output tracker] — any stdout/stderr = subprocess is alive & working
  try {
    if (proc && proc.stdout) proc.stdout.on('data', () => { __lastSubprocOutputAt = Date.now(); });
    if (proc && proc.stderr) proc.stderr.on('data', () => { __lastSubprocOutputAt = Date.now(); });
  } catch (_) {}
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
          // [401-FAILOVER-V2] Auto-rotate provider on 401/auth error instead of dying with same provider.
          console.error('[OpenClaude] Auth error mid-stream — attempting provider rotation');
          if (typeof modelPresets !== 'undefined' && _lastUserInputMsg && _autoFailoverAttempts < MAX_AUTO_FAILOVER) {
            _autoFailoverAttempts++;
            const failed = (typeof currentProvider !== 'undefined' ? currentProvider : '?') + '/' + (typeof currentModel !== 'undefined' ? currentModel : '?');
            const next = modelPresets.onModelFailure('401-auth');
            if (next) {
              if (typeof currentProvider !== 'undefined') currentProvider = next.provider;
              if (typeof currentModel !== 'undefined') currentModel = next.model;
              console.log('[401-Failover ' + _autoFailoverAttempts + '/' + MAX_AUTO_FAILOVER + '] ' + failed + ' auth_error → switching to ' + next.provider + '/' + next.model);
              if (activeStatusCard) {
                activeStatusCard.update('🔄 Auth error, cambiando a ' + (next.label || next.model) + '…').catch(() => {});
              }
              const savedInput = _lastUserInputMsg;
              // Restore pendingResolve so the new subprocess can fulfill it
              const _origResolve = resolve;
              pendingResolve = (newText) => {
                pendingResolve = null; pendingReject = null;
                if (pendingTimeout) { clearInterval(pendingTimeout); pendingTimeout = null; }
                _autoFailoverAttempts = 0; _lastUserInputMsg = null;
                try { if (typeof modelPresets !== 'undefined') modelPresets.onModelSuccess(); } catch (e) {}
                _origResolve(newText);
              };
              intentionalKill = true;
              if (openclaudeProcess) openclaudeProcess.kill('SIGTERM');
              setTimeout(() => {
                spawnOpenClaude();
                setTimeout(() => {
                  if (openclaudeProcess && pendingResolve && savedInput) {
                    try {
                      openclaudeProcess.stdin.write(JSON.stringify(savedInput) + '\n');
                      console.log('[401-Failover] Re-sent message to ' + next.provider);
                    } catch (e) {
                      console.error('[401-Failover] Re-send failed:', e.message);
                      const r = pendingResolve; pendingResolve = null; pendingReject = null;
                      if (r) r('[ERROR:AUTH-FAILOVER] No pude rotar a otro provider, intenta de nuevo.');
                    }
                  }
                }, 3000);
              }, 500);
              return;
            }
          }
          // Fallback al comportamiento original si no hay providers o se agotaron
          console.error('[OpenClaude] Auth error — killing for respawn (no failover available)');
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

// --- OpenRouter TTS (OpenAI gpt-audio-mini via /chat/completions + audio modality) ---
//
// OpenRouter does NOT expose /v1/audio/speech. The correct path for TTS is
// /chat/completions with `modalities: ["text", "audio"]`, `stream: true`, and
// `audio.format: "pcm16"` (the only format OpenAI accepts when streaming).
//
// The stream delivers SSE chunks with `choices[0].delta.audio.data` containing
// base64-encoded PCM16 samples. We concatenate and pipe through ffmpeg to
// produce an MP3 (which downstream code re-encodes to OGG/Opus for Telegram).
//
// PCM16 spec: 24 kHz, mono, signed 16-bit little-endian (OpenAI's default for
// gpt-audio family). Required by ffmpeg `-ar 24000 -ac 1 -f s16le`.
function ttsChunkOpenRouter(text, outputPath, voice) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.OPENROUTER_API_KEY || '';
    if (!apiKey) { reject(new Error('OPENROUTER_API_KEY no configurada')); return; }
    const rawModel = (TTS_PROVIDERS.openai && TTS_PROVIDERS.openai.model) || 'openai/gpt-audio-mini';
    const postData = JSON.stringify({
      model: rawModel,
      modalities: ['text', 'audio'],
      audio: { voice: voice || 'nova', format: 'pcm16' },
      stream: true,
      messages: [{ role: 'user', content: `Say exactly (no additional words): ${text}` }]
    });
    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 180000
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const errBufs = [];
        res.on('data', d => errBufs.push(d));
        res.on('end', () => reject(new Error(`OpenRouter TTS HTTP ${res.statusCode}: ${Buffer.concat(errBufs).toString('utf8').substring(0, 300)}`)));
        return;
      }
      const pcmParts = [];
      let sseBuffer = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        sseBuffer += chunk;
        let idx;
        while ((idx = sseBuffer.indexOf('\n')) !== -1) {
          const line = sseBuffer.slice(0, idx);
          sseBuffer = sseBuffer.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const obj = JSON.parse(payload);
            const audio = obj.choices?.[0]?.delta?.audio;
            if (audio && typeof audio.data === 'string' && audio.data.length > 0) {
              pcmParts.push(Buffer.from(audio.data, 'base64'));
            }
          } catch { /* skip malformed chunk */ }
        }
      });
      res.on('end', () => {
        if (pcmParts.length === 0) {
          reject(new Error('OpenRouter TTS: no audio data received'));
          return;
        }
        const pcm = Buffer.concat(pcmParts);
        const pcmPath = outputPath + '.pcm';
        fs.writeFileSync(pcmPath, pcm);
        execFile('ffmpeg', [
          '-y',
          '-f', 's16le', '-ar', '24000', '-ac', '1',
          '-i', pcmPath,
          '-c:a', 'libmp3lame', '-b:a', '128k',
          outputPath
        ], (err) => {
          try { fs.unlinkSync(pcmPath); } catch {}
          if (err) reject(new Error(`ffmpeg pcm->mp3 failed: ${err.message}`));
          else resolve(outputPath);
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OpenRouter TTS timeout')); });
    req.write(postData);
    req.end();
  });
}

// --- Concatenate audio files with ffmpeg (cross-format safe: re-encodes to opus) ---
function concatAudioFiles(files, outputPath) {
  return new Promise((resolve, reject) => {
    const listPath = outputPath + '.txt';
    const listContent = files.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(listPath, listContent);
    execFile('ffmpeg', [
      '-f', 'concat', '-safe', '0',
      '-i', listPath,
      '-c:a', 'libopus', '-b:a', '128k',
      outputPath,
      '-y', '-loglevel', 'quiet'
    ], (error) => {
      try { fs.unlinkSync(listPath); } catch (e) { /* ignore */ }
      if (error) { reject(error); return; }
      resolve(outputPath);
    });
  });
}

// --- Multi-provider TTS with chunking for long texts ---
async function textToSpeech(text, outputPath) {
  const chunks = splitTextForTTS(text);
  const provider = currentTTSProvider;
  const voice = currentTTSVoice;
  const ext = provider === 'openai' ? '.mp3' : '.ogg';
  const chunkFn = async (chunkText, chunkPath) => {
    if (provider === 'openai') return ttsChunkOpenRouter(chunkText, chunkPath, voice);
    return ttsChunk(chunkText, chunkPath);
  };
  if (chunks.length === 1) {
    if (provider === 'openai') {
      // write directly to outputPath but as mp3; send path kept for compatibility
      const mp3Path = outputPath.replace(/\.ogg$/, '.mp3');
      await ttsChunkOpenRouter(text, mp3Path, voice);
      // re-encode to opus/ogg to match downstream expectations
      await new Promise((resolve, reject) => {
        execFile('ffmpeg', ['-i', mp3Path, '-c:a', 'libopus', '-b:a', '128k', outputPath, '-y', '-loglevel', 'quiet'], (err) => {
          try { fs.unlinkSync(mp3Path); } catch (e) {}
          err ? reject(err) : resolve();
        });
      });
    } else {
      await ttsChunk(text, outputPath);
    }
    console.log(`[TTS] Audio generado (${provider}/${voice}): ${outputPath}`);
    return outputPath;
  }
  console.log(`[TTS] Texto largo (${text.length} chars), dividido en ${chunks.length} chunks — provider=${provider}`);
  const chunkFiles = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      const chunkPath = outputPath.replace(/\.ogg$/, `_chunk${i}${ext}`);
      await chunkFn(chunks[i], chunkPath);
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
      const isPolluted = err.message.includes('polluted');
      if ((isTimeout || isEmpty || isPolluted) && attempt < maxFallbackAttempts) {
        const reason = isTimeout ? 'timeout' : (isPolluted ? 'polluted (auth/echo)' : 'empty response');
        const next = modelPresets.onModelFailure(reason);
        if (next) {
          currentProvider = next.provider;
          currentModel = next.model;
          console.log(`[Fallback] Switching to ${next.provider}/${next.model} (attempt ${attempt + 1}, reason=${reason})`);
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
    // Write prompt to temp file if too large for CLI arg (Linux MAX_ARG_STRLEN ~128KB)
    let promptArg = fullPrompt;
    let tmpPromptFile = null;
    const promptBytes = Buffer.byteLength(fullPrompt, 'utf8');
    if (promptBytes > 100 * 1024) {
      tmpPromptFile = `/tmp/codex_task_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`;
      try {
        fs.writeFileSync(tmpPromptFile, fullPrompt);
        promptArg = `Leé el archivo ${tmpPromptFile} y seguí exactamente las instrucciones del sistema y el mensaje del usuario que contiene. Responde según el formato y reglas definidas en ese archivo.`;
        console.log(`[Codex] Large prompt (${promptBytes} bytes) → written to ${tmpPromptFile}`);
      } catch (e) {
        console.warn(`[Codex] Failed to write temp prompt file: ${e.message} — using inline prompt`);
        tmpPromptFile = null;
        promptArg = fullPrompt;
      }
    }
    const cleanupTmp = () => { if (tmpPromptFile) try { fs.unlinkSync(tmpPromptFile); } catch (e) {} };
    let proc;
    const timeout = setTimeout(() => {
      try { if (proc) proc.kill('SIGTERM'); } catch (e) {}
      cleanupTmp();
      reject(new Error(`Codex timeout (${Math.round(timeoutMs / 1000)}s) — ${currentProvider}/${currentModel}`));
    }, timeoutMs);
    let stdoutOutput = ''; // Only stdout — where the real response lives
    let stderrOutput = ''; // stderr — startup banner, tool progress (for status card only)
    const modelArgs = (currentModel && currentModel !== 'gpt-5.4') ? ['--model', currentModel] : [];
    const providerConfig = PROVIDERS[currentProvider];
    const providerEnv = providerConfig ? providerConfig.env : {};
    proc = spawn('codex', ['exec', '--skip-git-repo-check', '--sandbox', 'danger-full-access', ...modelArgs, promptArg], {
      cwd: '/app',
      env: { ...process.env, ...providerEnv, HOME: '/app' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    proc.stdout.on('data', d => { stdoutOutput += d.toString(); });
    proc.stderr.on('data', d => {
      const text = d.toString();
      stderrOutput += text;
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
      cleanupTmp();
      const lines = stdoutOutput.split('\n'); // Parse stdout only — not stderr
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
        // Fallback: filter out known startup banner / header lines
        const isHeaderLine = (l) => {
          const t = l.trim();
          if (!t) return true;
          if (/^(codex|tokens used|user|EXIT:\d+|\d[\d,]*|---+|WARNING|ERROR)$/.test(t)) return true;
          if (/^(OpenAI Codex |workdir: |model: |provider: |approval: |sandbox: |reasoning |session id: |Reading additional)/.test(t)) return true;
          return false;
        };
        const filtered = lines.filter(l => !isHeaderLine(l)).join('\n').trim();
        // Anchor on [TEXTO]/[AUDIO] tag — that's where the real response starts
        const responseMatch = filtered.match(/\[(AUDIO|TEXTO)\]/i);
        if (responseMatch) {
          result = filtered.substring(filtered.indexOf(responseMatch[0])).trim();
        } else if (filtered.includes('[INSTRUCCIONES DEL SISTEMA') || filtered.includes('[MENSAJE ACTUAL DEL USUARIO]')) {
          result = ''; // System prompt echoed — trigger fallback chain
        } else {
          result = filtered;
        }
      }
      // Clean up: remove trailing token count lines
      result = result.replace(/\n?\d[\d,]*\s*$/m, '').trim();
      const allOutput = stdoutOutput + stderrOutput;

      // POLLUTION GUARD: when codex auth fails (e.g., expired token) it can
      // dump the user prompt back as part of its banner/echo. The parser
      // then captures that echo as `result`. If we let it through, the
      // downstream tag parser fires real side effects ([MCTASK], [GENIMG],
      // [CREATESKILL], [RESTART_ZEUS], [SENDFILE]…) on the literal example
      // strings inside the system prompt — exactly what blew up on
      // 2026-04-25 when the chat got flooded with phantom tasks and
      // placeholder image-gen calls.
      const POLLUTION_MARKERS = [
        'Reading additional input from stdin',
        '[INSTRUCCIONES DEL SISTEMA',
        '=== HISTORIAL RECIENTE ===',
        '=== WIKI (Conocimiento Compilado) ===',
        '=== MEMORIAS RELEVANTES',
        '[MENSAJE ACTUAL DEL USUARIO]',
        'unexpected status 401',
        'Reconnecting... 5/5',
        'failed to connect to websocket',
        'Missing bearer or basic authentication',
        'OpenAI Codex v',
      ];
      const polluted = POLLUTION_MARKERS.find((m) => result.includes(m));
      if (polluted) {
        return reject(new Error(`Codex respuesta polluted (marker="${polluted}") — falling back. Preview: ${result.slice(0, 200).replace(/\s+/g, ' ')}`));
      }
      if (result) resolve(result);
      else reject(new Error(`Codex sin respuesta: ${allOutput.slice(0, 300)}`));
    });
    proc.on('error', e => { clearTimeout(timeout); cleanupTmp(); reject(e); });
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

// ─── VAULT AUTO-WRITING ───────────────────────────────────────────────────────
const VAULT_PATH = '/app/vault';
function writeVaultEntry(content) {
  try {
    const date = new Date();
    const dateStr = date.toISOString().slice(0, 10);
    const timeStr = date.toTimeString().slice(0, 5);
    const dirPath = `${VAULT_PATH}/raw/conversations`;
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    const filename = `${dirPath}/${dateStr}.md`;
    const needsHeader = !fs.existsSync(filename);
    const header = needsHeader ? `# ${AGENT_NAME} — Conversaciones ${dateStr}\n\n` : '';
    const entry = `${header}---\n### ${timeStr}\n\n${content}\n\n`;
    fs.appendFileSync(filename, entry);
    console.log(`[Vault] Written to ${filename}`);
  } catch (e) {
    console.error(`[Vault] Error writing:`, e.message);
  }
}

// Auto-persist EVERY user↔agent exchange to the agent's Obsidian vault.
// Jose's rule: "absolutamente todo queda en Obsidian". The [VAULT] tag
// remains as an explicit highlight (separate handler), but by default this
// function runs after every saveExchange so the vault has a complete
// conversational record per day, with sender attribution.
function writeExchangeToVault(senderPrefix, userMsg, agentResponse) {
  try {
    const date = new Date();
    const dateStr = date.toISOString().slice(0, 10);
    const timeStr = date.toTimeString().slice(0, 8);
    const dirPath = `${VAULT_PATH}/raw/conversations`;
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    const filename = `${dirPath}/${dateStr}.md`;
    const needsHeader = !fs.existsSync(filename);
    const header = needsHeader ? `# ${AGENT_NAME} — Conversaciones ${dateStr}\n\n` : '';
    const prefixLine = senderPrefix ? `${senderPrefix} ` : '';
    const u = String(userMsg || '(sin texto)').replace(/\n{3,}/g, '\n\n');
    const a = String(agentResponse || '(sin respuesta)').replace(/\n{3,}/g, '\n\n');
    const entry = `${header}---\n## ${timeStr} UTC\n\n**👤 User** ${prefixLine}\n\n${u}\n\n**🤖 ${AGENT_NAME}**\n\n${a}\n\n`;
    fs.appendFileSync(filename, entry);
  } catch (e) {
    console.error(`[Vault] Auto-exchange error:`, e.message);
  }
}

// ─── SKILL SELF-CREATION ──────────────────────────────────────────────────────
// Parses [CREATESKILL:name]...[/CREATESKILL] blocks from the LLM response,
// writes a SKILL.md to the shared skills directory, hot-reloads the index,
// and returns a list of confirmation messages (to be sent as separate msgs).
const SKILL_NAME_BLOCKLIST = new Set(['', '.', '..', 'system', 'admin', 'host', 'root', 'app', 'bin', 'etc']);
const SKILL_VALID_CATEGORIES = /^[a-z0-9-]{2,30}$/;
const SKILL_VALID_NAME = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

function safeSkillDir() {
  // Use the same dir that skill-loader uses — guaranteed consistent.
  try { return skillLoader.SKILLS_DIR || '/app/skills'; } catch (_) { return '/app/skills'; }
}

function processSkillCreationTags(responseText) {
  const results = []; // [{ok, name, category, message}]
  const re = /\[CREATESKILL:([^\]]+)\]([\s\S]*?)\[\/CREATESKILL\]/g;
  let cleanText = responseText;
  const matches = [...responseText.matchAll(re)];
  if (matches.length === 0) return { cleanText, results };

  // Strip all CREATESKILL blocks from visible text
  cleanText = cleanText.replace(/\[CREATESKILL:[^\]]+\][\s\S]*?\[\/CREATESKILL\]/g, '').trim();

  const baseDir = safeSkillDir();

  for (const m of matches) {
    const rawName = String(m[1] || '').trim().toLowerCase();
    const body = String(m[2] || '').trim();
    try {
      // Validate name
      if (!rawName || rawName.length < 3 || rawName.length > 40) {
        results.push({ ok: false, name: rawName, message: `Skill rechazado: nombre inválido (len ${rawName.length})` });
        continue;
      }
      if (rawName.includes('/') || rawName.includes('\\') || rawName.includes('..')) {
        results.push({ ok: false, name: rawName, message: `Skill rechazado: nombre contiene caracteres inválidos` });
        continue;
      }
      if (!SKILL_VALID_NAME.test(rawName)) {
        results.push({ ok: false, name: rawName, message: `Skill rechazado: nombre debe ser kebab-case [a-z0-9-]` });
        continue;
      }
      if (SKILL_NAME_BLOCKLIST.has(rawName)) {
        results.push({ ok: false, name: rawName, message: `Skill rechazado: nombre reservado` });
        continue;
      }

      // Parse inline header lines (optional): "categoría: X", "descripción: Y" before the "---" fence
      let category = 'general';
      let description = '';
      let skillBody = body;
      const fenceIdx = body.indexOf('\n---');
      if (fenceIdx > 0) {
        const header = body.slice(0, fenceIdx);
        skillBody = body.slice(fenceIdx + 4).replace(/^\s*\n/, '');
        for (const line of header.split('\n')) {
          const kv = line.match(/^\s*(categor[ií]a|category|descripci[óo]n|description)\s*:\s*(.+?)\s*$/i);
          if (!kv) continue;
          const key = kv[1].toLowerCase();
          const val = kv[2].trim();
          if (key.startsWith('categor')) category = val.toLowerCase();
          else if (key.startsWith('descripc') || key === 'description') description = val;
        }
      }

      // Validate category
      if (!SKILL_VALID_CATEGORIES.test(category)) category = 'general';

      // Build final path — safety: confine within baseDir
      const resolvedDir = path.resolve(baseDir, category, rawName);
      const resolvedBase = path.resolve(baseDir);
      if (!resolvedDir.startsWith(resolvedBase + path.sep)) {
        results.push({ ok: false, name: rawName, message: `Skill rechazado: path fuera del skills dir` });
        continue;
      }

      // Check for existing skill (either categorised path OR legacy flat path)
      const flatDir = path.resolve(baseDir, rawName);
      let targetDir = resolvedDir;
      let versioned = false;
      if (fs.existsSync(path.join(resolvedDir, 'SKILL.md')) || fs.existsSync(path.join(flatDir, 'SKILL.md'))) {
        // Create v2 variant rather than overwrite
        targetDir = path.resolve(baseDir, category, `${rawName}-v2`);
        versioned = true;
        if (fs.existsSync(path.join(targetDir, 'SKILL.md'))) {
          results.push({ ok: false, name: rawName, message: `Skill ya existe (y v2 también). Cambiá el nombre.` });
          continue;
        }
      }

      // Ensure frontmatter YAML exists; if not, synthesize
      const hasFm = /^---\s*\n[\s\S]*?\n---\s*\n/.test(skillBody);
      let finalContent = skillBody;
      if (!hasFm) {
        const created = new Date().toISOString();
        const fm = [
          '---',
          `name: ${rawName}`,
          `description: ${description || 'Auto-created skill'}`,
          `category: ${category}`,
          `created_by: ${AGENT_NAME}`,
          `created_at: ${created}`,
          '---',
          ''
        ].join('\n');
        finalContent = fm + skillBody;
      }

      // Write to disk
      fs.mkdirSync(targetDir, { recursive: true });
      const skillFile = path.join(targetDir, 'SKILL.md');
      fs.writeFileSync(skillFile, finalContent, { encoding: 'utf8', mode: 0o644 });
      console.log(`[CreateSkill] wrote ${skillFile} (${finalContent.length} bytes)`);

      // Hot-reload the index so next match includes the new skill
      try { skillLoader.indexSkills(); } catch (e) { console.warn('[CreateSkill] re-index failed:', e.message); }

      const finalName = versioned ? `${rawName}-v2` : rawName;
      results.push({
        ok: true,
        name: finalName,
        category,
        versioned,
        message: `💾 Memory updated · Skill '${finalName}' creado (categoría: ${category}) por ${AGENT_NAME}.`
      });
    } catch (e) {
      console.error('[CreateSkill] error:', e.message);
      results.push({ ok: false, name: rawName, message: `❌ Error creando skill '${rawName}': ${e.message.slice(0, 200)}` });
    }
  }

  return { cleanText, results };
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
    // Auto-log to vault
    const imgSummary = imgMatches.map((m, i) => `- Imagen ${i+1}: ${m[1].trim().substring(0, 150)}`).join('\n');
    writeVaultEntry(`**Imágenes generadas** (${imgMatches.length})\n\n${imgSummary}`);
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

  // File sending — process ALL [SENDFILE] tags
  const fileMatches = [...cleanText.matchAll(/\[SENDFILE\]([\s\S]*?)\[\/SENDFILE\]/g)];
  if (fileMatches.length > 0) {
    cleanText = cleanText.replace(/\[SENDFILE\][\s\S]*?\[\/SENDFILE\]/g, '').trim();
    for (const match of fileMatches) {
      let filePath = match[1].trim();
      if (!filePath.startsWith('/')) filePath = `/app/${filePath}`;
      try {
        if (!fs.existsSync(filePath)) {
          await bot.sendMessage(chatId, `⚠️ Archivo no encontrado: ${filePath}`);
          console.warn(`[SendFile] File not found: ${filePath}`);
          continue;
        }
        const fileName = filePath.split('/').pop();
        safeSendChatAction(chatId, 'upload_document');
        console.log(`[SendFile] Sending: ${filePath}`);
        await bot.sendDocument(chatId, filePath, {}, { filename: fileName });
        console.log(`[SendFile] Sent: ${fileName}`);
        writeVaultEntry(`**Archivo enviado al chat:** ${fileName}\n\nRuta: ${filePath}`);
      } catch (fileErr) {
        console.error(`[SendFile Error]`, fileErr.message);
        await bot.sendMessage(chatId, `❌ Error enviando archivo: ${fileErr.message.substring(0, 200)}`);
      }
    }
  }

  // Vault writing — process ALL [VAULT] tags
  const vaultMatches = [...cleanText.matchAll(/\[VAULT\]([\s\S]*?)\[\/VAULT\]/g)];
  if (vaultMatches.length > 0) {
    cleanText = cleanText.replace(/\[VAULT\][\s\S]*?\[\/VAULT\]/g, '').trim();
    for (const match of vaultMatches) {
      const vaultContent = match[1].trim();
      if (vaultContent) writeVaultEntry(vaultContent);
    }
  }

  // Skill self-creation — process ALL [CREATESKILL:name]...[/CREATESKILL] tags
  try {
    const skillRes = processSkillCreationTags(cleanText);
    cleanText = skillRes.cleanText;
    for (const r of (skillRes.results || [])) {
      try { await bot.sendMessage(chatId, r.message); }
      catch (e) { console.warn('[CreateSkill] send confirm failed:', e.message); }
      if (r.ok) {
        try { writeVaultEntry(`**Skill creado:** ${r.name} (categoría: ${r.category})`); } catch (_) {}
      }
    }
  } catch (e) { console.warn('[CreateSkill] tag processing error:', e.message); }
  try { __lastResponseAt = Date.now(); } catch(_) {}

  // [FIX]/[IMPLEMENT] ecosystem doc-logger — parse and strip tags, write to shared vault
  try {
    if (__docLogger && typeof __docLogger.parseAndStripTags === 'function') {
      const docRes = __docLogger.parseAndStripTags(cleanText, { source: __AGENT_SOURCE });
      cleanText = docRes.cleanText;
      for (const e of (docRes.entries || [])) {
        if (e.ok) {
          const kindLabel = e.kind === 'fix' ? '🔧 Fix' : '✨ Implementación';
          try { await bot.sendMessage(chatId, `${kindLabel} documentado: *${e.title}*`, { parse_mode: 'Markdown' }); }
          catch (_) {}
        }
      }
    }
  } catch (e) { console.warn('[DocLogger] tag processing error:', e.message); }

    // [APPROVAL:mc-task:title|desc] — user-consent gated MC task creation
    try {
      cleanText = approvals.processApprovalTags(bot, chatId, cleanText, { agentResponse: cleanText });
    } catch (e) { console.warn('[Approvals] tag processing error:', e.message); }

    // [MCTASK parse-and-create] — auto-register + complete inline (agent response = resolution)
    try {
      if (__mcTaskAuto && typeof __mcTaskAuto.parseTags === 'function') {
        const __mcRes = __mcTaskAuto.parseTags(cleanText);
        cleanText = __mcRes.cleanText;
        for (const __t of (__mcRes.tags || [])) {
          try {
            const __newId = await mcCreateTask(__t.title, __t.desc, typeof MC_AGENT_NAME !== 'undefined' ? MC_AGENT_NAME : 'unknown');
            if (__newId) {
              // Discreet notification — Zeus CEO will validate every 15min autonomously
              try { await bot.sendMessage(chatId, `📋 Task #${__newId} registrada en Mission Control: *${__t.title}*`, { parse_mode: 'Markdown' }); } catch(_){}
              // Move to quality_review — Zeus CEO cada 15 min promueve a done
              try { await mcCompleteTask(__newId, (cleanText || '').substring(0, 300), 'success'); } catch(_){}
            }
          } catch (_) {}
        }
      }
    } catch (e) { console.warn('[MCTask] parse error:', e.message); }



  return cleanText;
}

// One-shot OpenClaude call for image processing when persistent process isn't available (e.g. Codex provider)
async function callOpenClaudeOneShot(userMessage, imageBase64, imageMimeType) {
  // Build conversation history context from DB
  let historyContext = '';
  try {
    const db = memory.getDb();
    if (db) {
      const recentMsgs = db.prepare(
        'SELECT role, content FROM messages ORDER BY id DESC LIMIT 8'
      ).all().reverse();
      if (recentMsgs.length > 0) {
        const lines = recentMsgs.map(m => {
          const name = m.role === 'user' ? (process.env.USER_NAME || 'User') : AGENT_NAME;
          const short = m.content.length > 300 ? m.content.substring(0, 300) + '...' : m.content;
          return `${name}: ${short}`;
        }).join('\n');
        historyContext = `[CONTEXTO DE CONVERSACIÓN RECIENTE]\n${lines}\n\n`;
      }
    }
  } catch (e) { /* sin historial, continuar */ }

  return new Promise((resolve, reject) => {
    let proc;
    const timeout = setTimeout(() => {
      if (proc) proc.kill('SIGTERM');
      reject(new Error('OpenClaude one-shot timeout (5 min)'));
    }, 5 * 60 * 1000);

    proc = spawn('openclaude', [
      '--model', 'sonnet',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--verbose'
    ], { cwd: '/app', env: { ...process.env, HOME: '/app' }, stdio: ['pipe', 'pipe', 'pipe'] });

    // Send the image via stdin as stream-json, with conversation history as context
    const messageContent = [];
    if (imageBase64) {
      messageContent.push({ type: 'image', source: { type: 'base64', media_type: imageMimeType, data: imageBase64 } });
    }
    messageContent.push({ type: 'text', text: historyContext + userMessage });

    const inputMsg = {
      type: 'user',
      session_id: String(activeChatId || ''),
      message: { role: 'user', content: messageContent },
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
  // Auto-skill-loading: detect relevant skills from user prompt and prepend their
  // contents into the message so OpenClaude can use them directly.
  try {
    if (typeof userMessage === 'string' && userMessage.length > 0) {
      const _skillMatches = skillLoader.matchSkills(userMessage);
      if (_skillMatches && _skillMatches.length) {
        const _skillCtx = skillLoader.buildSkillContext(_skillMatches);
        console.log(`[skill-loader] auto-loaded ${_skillMatches.length} skill(s): ${_skillMatches.map(m => `${m.dirName}(${m.score})`).join(', ')}`);
        userMessage = `${_skillCtx}\n\n${userMessage}`;
      }
    }
  } catch (e) { console.warn('[skill-loader] match error:', e.message); }

  // For images: only Anthropic (via persistent OpenClaude) supports vision natively
  // All other providers (Codex, Ollama, OpenRouter) fall back to OpenClaude one-shot for image analysis
  if (imageBase64 && currentProvider !== 'anthropic') {
    console.log(`[callAgent] Image received but provider "${currentProvider}" may not support vision — using OpenClaude one-shot`);
    return callOpenClaudeOneShot(userMessage, imageBase64, imageMimeType);
  }
  if (currentProvider === 'codex') {
    try {
      return await callCodex(userMessage);
    } catch (err) {
      console.log(`[callAgent] Codex chain exhausted (${err.message.substring(0, 120)}). Falling back to Anthropic.`);
      currentProvider = 'anthropic';
      currentModel = 'sonnet';
      // fall through to persistent OpenClaude path below
    }
  }
  if (!openclaudeProcess) {
    console.log('[callAgent] OpenClaude process not running — auto-spawning...');
    spawnOpenClaude();
    // Wait briefly for process to start before throwing
    await new Promise(r => setTimeout(r, 2000));
    if (!openclaudeProcess) throw new Error('OpenClaude process not running — spawn failed');
  }
  if (pendingResolve) {
    // Wait for in-flight message or session recovery to complete (max 8s)
    const cleared = await new Promise(res => {
      const deadline = Date.now() + 8000;
      const check = setInterval(() => {
        if (!pendingResolve || Date.now() > deadline) { clearInterval(check); res(!pendingResolve); }
      }, 200);
    });
    if (pendingResolve) {
      // Still stuck — force clear stale state
      console.warn('[callAgent] pendingResolve stuck after 8s — force clearing');
      if (pendingTimeout) { clearInterval(pendingTimeout); pendingTimeout = null; }
      pendingResolve = null;
      pendingReject = null;
    }
  }

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
    session_id: String(activeChatId || ''),
    message: { role: 'user', content },
    parent_tool_use_id: null
  };

  // Save for auto-failover: if the subprocess crashes mid-response,
  // we can re-send this exact message to the next provider.
  _lastUserInputMsg = inputMsg;
  _autoFailoverAttempts = 0;

  return new Promise((resolve, reject) => {
    assistantText = '';
    pendingResolve = (text) => {
      _lastUserInputMsg = null;
      _autoFailoverAttempts = 0;
      try { if (typeof modelPresets !== 'undefined') modelPresets.onModelSuccess(); } catch (e) {}
      resolve(text);
    };
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

    if (!openclaudeProcess) {
      clearInterval(pendingTimeout);
      pendingTimeout = null;
      pendingResolve = null;
      pendingReject = null;
      throw new Error('OpenClaude process died while waiting — retry');
    }
    openclaudeProcess.stdin.write(JSON.stringify(inputMsg) + '\n');
  });
}

// --- Telegram Bot ---
const bot = new TelegramBot(TOKEN, { polling: true });
memory.init();
try { skillLoader.indexSkills(); } catch (e) { console.warn('[skill-loader] index failed:', e.message); }

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
  try { __lastMessageAt = Date.now(); } catch(_) {}
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
  if (!responseText || !responseText.trim()) return; // Skip empty responses (e.g. after processMediaTags strips all tags)
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
  // Generic approval buttons first (consumes and returns true if matched).
  try { if (await approvals.handleCallback(bot, query)) return; } catch (e) { console.error('[Approvals]', e.message); }
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

  // --- TTS provider/voice callbacks ---
  if (data.startsWith('ttsprov:')) {
    const providerId = data.split(':')[1];
    const provider = TTS_PROVIDERS[providerId];
    if (!provider) return;
    const voiceButtons = provider.voices.map(v => ({
      text: `${providerId === currentTTSProvider && v.id === currentTTSVoice ? '✅ ' : ''}${v.label}`,
      callback_data: `ttsvoice:${providerId}:${v.id}`
    }));
    const keyboard = [];
    for (let i = 0; i < voiceButtons.length; i += 2) keyboard.push(voiceButtons.slice(i, i + 2));
    keyboard.push([{ text: '⬅️ Volver a proveedores', callback_data: 'ttsback' }]);
    await bot.editMessageText(
      `🔊 *${provider.label}* — Escogé una voz:`, {
      chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
    return;
  }
  if (data.startsWith('ttsvoice:')) {
    const parts = data.split(':');
    const providerId = parts[1];
    const voiceId = parts.slice(2).join(':');
    const provider = TTS_PROVIDERS[providerId];
    if (!provider) return;
    const voiceInfo = provider.voices.find(v => v.id === voiceId);
    if (providerId === currentTTSProvider && voiceId === currentTTSVoice) {
      await bot.editMessageText(`✅ Ya estás usando *${provider.label}* / *${voiceInfo?.label || voiceId}*`, {
        chat_id: chatId, message_id: messageId, parse_mode: 'Markdown'
      });
      return;
    }
    currentTTSProvider = providerId;
    currentTTSVoice = voiceId;
    await bot.editMessageText(`✅ TTS: *${provider.label}* / *${voiceInfo?.label || voiceId}*`, {
      chat_id: chatId, message_id: messageId, parse_mode: 'Markdown'
    });
    return;
  }
  if (data === 'ttsback') {
    const provider = TTS_PROVIDERS[currentTTSProvider];
    const voiceInfo = provider?.voices.find(v => v.id === currentTTSVoice);
    const allButtons = Object.entries(TTS_PROVIDERS).map(([id, p]) => ({
      text: `${id === currentTTSProvider ? '✅ ' : ''}${p.label}`,
      callback_data: `ttsprov:${id}`
    }));
    const keyboard = [];
    for (let i = 0; i < allButtons.length; i += 2) keyboard.push(allButtons.slice(i, i + 2));
    await bot.editMessageText(
      `🔊 *TTS activo:* ${provider.label} / ${voiceInfo?.label || currentTTSVoice}\n\nEscogé un proveedor:`, {
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
  if (!requireOwner(bot, msg, '/clear (reset session)')) return;
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

// --- /tts command ---
bot.onText(/\/tts(?:@\w+)?$/i, async (msg) => {
  console.log('[Command] /tts received');
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;
  const provider = TTS_PROVIDERS[currentTTSProvider];
  const voiceInfo = provider?.voices.find(v => v.id === currentTTSVoice);
  const voiceLabel = voiceInfo ? voiceInfo.label : currentTTSVoice;
  const allButtons = Object.entries(TTS_PROVIDERS).map(([id, p]) => ({
    text: `${id === currentTTSProvider ? '✅ ' : ''}${p.label}`,
    callback_data: `ttsprov:${id}`
  }));
  const keyboard = [];
  for (let i = 0; i < allButtons.length; i += 2) {
    keyboard.push(allButtons.slice(i, i + 2));
  }
  await bot.sendMessage(chatId,
    `🔊 *TTS activo:* ${provider.label} / ${voiceLabel}\n\nEscogé un proveedor:`, {
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
        activeChatId = chatId;
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
        try { memory.saveExchange(caption ? `[Imagen: "${caption}"]` : '[Imagen sin caption]', responseText); try { writeExchangeToVault(typeof senderPrefix !== 'undefined' ? senderPrefix : '', caption ? `[Imagen: "${caption}"]` : '[Imagen sin caption]', responseText); } catch {} honcho.updateUserModel({ user: caption || '[imagen]', assistant: responseText }).catch(() => {}); } catch (e) { console.error('[DB Error]', e.message); }
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
        // Safe pandoc wrapper: 30s timeout + 2GB memory cap (prevents OOM from pandoc runaway on unsupported files)
        const safePandoc = (p) => execSync(
          `timeout 30 bash -c 'ulimit -v 2097152; pandoc "${p}" -t plain 2>/dev/null'`,
          { maxBuffer: 5 * 1024 * 1024 }
        ).toString();
        // Binary/archive formats pandoc can't handle — reject early to avoid memory blowup
        const BINARY_EXT = ['.zip','.tar','.gz','.tgz','.bz2','.xz','.7z','.rar','.iso','.dmg','.exe','.dll','.so','.bin','.dat','.db','.sqlite','.mp3','.mp4','.wav','.ogg','.mov','.avi','.mkv','.webm','.jpg','.jpeg','.png','.gif','.bmp','.webp','.heic'];
        try {
          if (BINARY_EXT.includes(ext)) {
            extractedText = `[Archivo binario/comprimido: ${fileName} (${mimeType}). Pandoc no puede procesarlo. Si es un comprimido, descomprimilo y enviame los archivos. Si es multimedia, enviame la transcripción o descripción.]`;
          } else if (ext === '.pdf') {
            extractedText = execSync(`timeout 30 bash -c 'ulimit -v 2097152; pdftotext "${docPath}" - 2>/dev/null'`, { maxBuffer: 5 * 1024 * 1024 }).toString();
          } else if (ext === '.docx' || ext === '.doc' || ext === '.odt' || ext === '.rtf') {
            extractedText = safePandoc(docPath);
          } else if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
            if (ext === '.csv') {
              extractedText = fs.readFileSync(docPath, 'utf8');
            } else {
              try {
                extractedText = safePandoc(docPath);
              } catch (e) {
                extractedText = `[Archivo Excel: ${fileName}. No se pudo extraer contenido como texto. Sugiere al usuario exportar a CSV o PDF.]`;
              }
            }
          } else if (ext === '.txt' || ext === '.md' || ext === '.json' || ext === '.js' || ext === '.py' || ext === '.html' || ext === '.xml' || ext === '.yaml' || ext === '.yml' || ext === '.toml' || ext === '.ini' || ext === '.cfg' || ext === '.log' || ext === '.sh') {
            extractedText = fs.readFileSync(docPath, 'utf8');
          } else if (ext === '.pptx' || ext === '.ppt') {
            try {
              extractedText = safePandoc(docPath);
            } catch (e) {
              extractedText = `[Archivo PowerPoint: ${fileName}. No se pudo extraer texto automáticamente.]`;
            }
          } else {
            // Unknown extension — try reading as UTF-8 text first (safer than pandoc fallback)
            try {
              const buf = fs.readFileSync(docPath);
              // Detect binary by looking for null bytes in first 1KB
              const sample = buf.slice(0, 1024);
              const isBinary = sample.includes(0);
              if (isBinary) {
                extractedText = `[Archivo binario desconocido: ${fileName} (${mimeType}). No se puede extraer texto de forma segura.]`;
              } else {
                extractedText = buf.toString('utf8').substring(0, 15000);
              }
            } catch (e2) {
              extractedText = `[Archivo no procesable: ${fileName} (${mimeType}).]`;
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

        activeChatId = chatId;
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
        try { memory.saveExchange(`[Documento: "${fileName}"] ${caption || ''}`, responseText); try { writeExchangeToVault(typeof senderPrefix !== 'undefined' ? senderPrefix : '', `[Documento: "${fileName}"] ${caption || ''}`, responseText); } catch {} honcho.updateUserModel({ user: `[Documento: ${fileName}] ${caption}`, assistant: responseText }).catch(() => {}); } catch (e) { console.error('[DB Error]', e.message); }
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
        activeChatId = chatId;
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
        try { memory.saveExchange(`[Audio: "${transcription.substring(0, 150)}"]`, responseText); try { writeExchangeToVault(typeof senderPrefix !== 'undefined' ? senderPrefix : '', `[Audio: "${transcription.substring(0, 150)}"]`, responseText); } catch {} honcho.updateUserModel({ user: transcription, assistant: responseText }).catch(() => {}); } catch (e) { console.error('[DB Error]', e.message); }
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
  // Delegation callback — pick up any Zeus-resolved delegations before
  // the agent processes the user's message. The result (including any
  // [CREATESKILL] tags Zeus proposed) is fed through the skill parser so
  // new shared skills appear automatically. Records are also pushed into
  // the conversation context so the agent can answer "ya Zeus terminó?".
  try {
    const dw = require('./delegation-watcher.js');
    const out = dw.processPending(processSkillCreationTags);
    if (out.processed > 0) {
      for (const rec of out.records) {
        const contextMsg = `[Zeus completó una delegación] Tarea original: ${String(rec.original_task || '').substring(0, 400)}\n\nResultado de Zeus:\n${String(rec.cleanResult || '').substring(0, 1500)}`;
        try { saveExchange(contextMsg, '', { silent: true }); } catch {}
        if (rec.has_skill_proposal) {
          try {
            await bot.sendMessage(chatId,
              `🧠 <b>Zeus propuso un skill reutilizable</b>\nLa próxima vez puedo resolverlo sola sin delegar.`,
              { parse_mode: 'HTML' });
          } catch {}
        }
      }
    }
  } catch (e) { console.error('[delegation-watcher]', e.message); }

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
    let mcTaskId = null; // MC tasks now created only via [APPROVAL:mc-task:...] user consent
    const enrichedText = await extractUrlContent(text);
    if (enrichedText !== text) console.log(`[Jina] Mensaje enriquecido con contenido de URLs`);
    const __mcReminder = '\n\n---\n[SYSTEM-REMINDER] Si esta petición requiere >3 min de trabajo real (research extenso, análisis multi-paso, implementación, deploy, generación de HTML/PDF/reportes, comparativas), SIEMPRE termina tu respuesta con [MCTASK:Título semántico 5-10 palabras|Descripción breve]. El bot la crea en Mission Control automáticamente. NO emitas el tag para: saludos, chat casual, confirmaciones, preguntas rápidas (<30s).\n---';
    const payload = (senderPrefix ? `${senderPrefix} ${enrichedText}` : enrichedText) + __mcReminder;

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
    activeChatId = chatId;
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
    try { memory.saveExchange(text, responseText); try { writeExchangeToVault(typeof senderPrefix !== 'undefined' ? senderPrefix : '', text, responseText); } catch {} honcho.updateUserModel({ user: text, assistant: responseText }).catch(() => {}); } catch (e) { console.error('[DB Error]', e.message); }
    postExchangeHook(text, responseText);
    postExchangeHook(text, responseText);
    await mcCompleteTask(mcTaskId, responseText.substring(0, 300), 'success');
  } catch (err) {
    await status.fail(err.message);
    console.error('[Error]', err.message);
    bot.sendMessage(chatId, `❌ Error: ${err.message.substring(0, 200)}`);
    await mcCompleteTask(mcTaskId, err.message, 'failed');
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


// [Startup notification] — avisa al usuario principal que el bot volvió a estar listo
setTimeout(() => {
  try {
    if (ALLOWED_USER_ID && global.telegramBot) {
      global.telegramBot.sendMessage(
        ALLOWED_USER_ID,
        '⚡️ Ya estoy de vuelta y listo, andaba haciendo de 2 un momento 🙈🧻!'
      ).catch(() => {});
    }
  } catch (_) {}
}, 3000);

// [MC-TASK approval handler] — user approves → task enters MC in quality_review
try {
  const __approvals = require('/opt/zeus-shared/approval-buttons.js');
  __approvals.registerActionHandler('mc-task', async ({ description, data }) => {
    const parts = (description || '').split('|').map(s => s.trim());
    const title = parts[0] || '(sin título)';
    const desc = parts[1] || title;
    if (typeof mcCreateTask !== 'function') return { message: 'MC integration not available' };
    const taskId = await mcCreateTask(title, desc, typeof MC_AGENT_NAME !== 'undefined' ? MC_AGENT_NAME : 'unknown');
    if (!taskId) return { message: 'Error creando task en MC' };
    const resolution = (data && data.agentResponse) ? String(data.agentResponse).substring(0, 300) : title;
    if (typeof mcCompleteTask === 'function') {
      await mcCompleteTask(taskId, resolution, 'success');
    }
    return { message: `✨ Task #${taskId} creada en MC → quality_review. Zeus la validará en ≤30min.` };
  });
} catch (e) { console.warn('[MC-Task approval]', e.message); }

// [Heartbeat tick] — write /tmp/<agent>-heartbeat.json every 30s
setInterval(() => {
  try {
    if (!__heartbeat) return;
    const alive = (typeof openclaudeProcess !== 'undefined' && openclaudeProcess && !openclaudeProcess.killed);
    __heartbeat.write({
      agent: __HEARTBEAT_AGENT,
      queueLength: (typeof messageQueue !== 'undefined' && Array.isArray(messageQueue)) ? messageQueue.length : 0,
      lastMessageAt: __lastMessageAt,
      lastResponseAt: __lastResponseAt,
      subprocessAlive: alive,
      subprocessStartedAt: alive ? __subprocStartedAt : null,
      lastSubprocessOutputAt: __lastSubprocOutputAt,
    });
  } catch (e) { /* best-effort */ }
}, 30000);
