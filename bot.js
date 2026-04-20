require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { execFile, spawn } = require('child_process');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');
const memory = require('./memory');
const linear = require('./linear');
const dreaming = require('./dreaming');

// ─── Mission Control Integration ──────────────────────────────────────────────
const MC_HOST = process.env.MC_HOST || 'mission-control';
const MC_PORT = parseInt(process.env.MC_PORT || '3000');
const MC_API_KEY = process.env.MC_API_KEY || '';
const MC_AGENT_NAME = 'maximus';
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

// Exponer mcRequest globalmente para comandos Telegram
global.mcRequest = mcRequest;

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
  } catch (e) {
    // silently ignore — non-critical
  }
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
          // Notificar a Jose sobre eventos relevantes
          if (data.type === 'task.completed' && data.task) {
            const jose = parseInt(process.env.ALLOWED_USER_ID);
            if (jose && global.telegramBot) {
              global.telegramBot.sendMessage(jose,
                `✅ <b>Tarea completada</b>\n<b>${data.task.title}</b>\nAgente: ${data.task.agent_name || 'desconocido'}`,
                { parse_mode: 'HTML' }
              ).catch(() => {});
            }
          }
        } catch (e) {}
      }
    });
    res.on('end', () => {
      mcSseActive = false;
      setTimeout(() => startMCSSE(), 5000);
    });
    res.on('error', () => {
      mcSseActive = false;
      setTimeout(() => startMCSSE(), 5000);
    });
  });
  req.on('error', () => {
    mcSseActive = false;
    setTimeout(() => startMCSSE(), 5000);
  });
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
// ──────────────────────────────────────────────────────────────────────────────

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = parseInt(process.env.ALLOWED_USER_ID, 10);
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const TMP_DIR = path.join(__dirname, 'tmp');

// ElevenLabs config
const VOICE_ID = '8mBRP99B2Ng2QwsJMFQl';
const TTS_MODEL = 'eleven_v3';
const OUTPUT_FORMAT = 'opus_48000_128';
const VOICE_SETTINGS = {
  stability: 0.30,
  similarity_boost: 0.75,
  style: 0.70,
  use_speaker_boost: true
};

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
  codex: {
    label: 'OpenAI Codex',
    models: [
      { id: 'gpt-5.4', label: 'GPT-5.4 (default)' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' }
    ],
    env: {}
  },
  ollama: {
    label: 'Ollama Cloud',
    models: [
      // Top tier
      { id: 'deepseek-v3.2:cloud', label: 'DeepSeek V3.2' },
      { id: 'glm-5.1:cloud', label: 'GLM 5.1' },
      { id: 'glm-5:cloud', label: 'GLM 5' },
      { id: 'kimi-k2.5:cloud', label: 'Kimi K2.5' },
      { id: 'kimi-k2:1t-cloud', label: 'Kimi K2 1T' },
      { id: 'kimi-k2-thinking:cloud', label: 'Kimi K2 Thinking' },
      // Qwen family
      { id: 'qwen3.5:cloud', label: 'Qwen 3.5' },
      { id: 'qwen3.5:397b-cloud', label: 'Qwen 3.5 397B' },
      { id: 'qwen3-coder-next:cloud', label: 'Qwen3 Coder Next' },
      { id: 'qwen3-coder:480b-cloud', label: 'Qwen3 Coder 480B' },
      { id: 'qwen3-next:80b-cloud', label: 'Qwen3 Next 80B' },
      { id: 'qwen3-vl:235b-cloud', label: 'Qwen3 VL 235B' },
      { id: 'qwen3-vl:235b-instruct-cloud', label: 'Qwen3 VL 235B Instruct' },
      // Google / Gemini
      { id: 'gemma4:31b-cloud', label: 'Gemma 4 31B' },
      { id: 'gemini-3-flash-preview:cloud', label: 'Gemini 3 Flash' },
      // Mistral / Devstral
      { id: 'mistral-large-3:675b-cloud', label: 'Mistral Large 3 675B' },
      { id: 'devstral-small-2:24b-cloud', label: 'Devstral Small 2 24B' },
      { id: 'ministral-3:14b-cloud', label: 'Ministral 3 14B' },
      { id: 'ministral-3:8b-cloud', label: 'Ministral 3 8B' },
      { id: 'ministral-3:3b-cloud', label: 'Ministral 3 3B' },
      // MiniMax
      { id: 'minimax-m2.7:cloud', label: 'MiniMax M2.7' },
      { id: 'minimax-m2.5:cloud', label: 'MiniMax M2.5' },
      { id: 'minimax-m2.1:cloud', label: 'MiniMax M2.1' },
      { id: 'minimax-m2:cloud', label: 'MiniMax M2' },
      // NVIDIA
      { id: 'nemotron-3-super:cloud', label: 'Nemotron 3 Super 120B' },
      { id: 'nemotron-3-nano:30b-cloud', label: 'Nemotron 3 Nano 30B' },
      // Others
      { id: 'gpt-oss:120b-cloud', label: 'GPT-OSS 120B' },
      { id: 'gpt-oss:20b-cloud', label: 'GPT-OSS 20B' },
      { id: 'deepseek-v3.1:671b-cloud', label: 'DeepSeek V3.1 671B' },
      { id: 'glm-4.7:cloud', label: 'GLM 4.7' },
      { id: 'glm-4.6:cloud', label: 'GLM 4.6' },
      { id: 'cogito-2.1:cloud', label: 'Cogito 2.1' }
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
      // OpenAI
      { id: 'openai/gpt-5.4-pro', label: 'GPT-5.4 Pro' },
      { id: 'openai/gpt-5.4', label: 'GPT-5.4' },
      { id: 'openai/gpt-5.4-mini', label: 'GPT-5.4 Mini' },
      { id: 'openai/gpt-5.2-pro', label: 'GPT-5.2 Pro' },
      { id: 'openai/gpt-5.2', label: 'GPT-5.2' },
      { id: 'openai/gpt-5.1', label: 'GPT-5.1' },
      { id: 'openai/gpt-5', label: 'GPT-5' },
      { id: 'openai/gpt-5-mini', label: 'GPT-5 Mini' },
      { id: 'openai/gpt-5-codex', label: 'GPT-5 Codex' },
      { id: 'openai/gpt-4.1', label: 'GPT-4.1' },
      { id: 'openai/gpt-4.1-mini', label: 'GPT-4.1 Mini' },
      { id: 'openai/o4-mini-high', label: 'o4 Mini High' },
      { id: 'openai/o3', label: 'o3' },
      { id: 'openai/o3-pro', label: 'o3 Pro' },
      // xAI / Grok
      { id: 'x-ai/grok-4.20', label: 'Grok 4.20' },
      { id: 'x-ai/grok-4', label: 'Grok 4' },
      { id: 'x-ai/grok-4-fast', label: 'Grok 4 Fast' },
      { id: 'x-ai/grok-3', label: 'Grok 3' },
      { id: 'x-ai/grok-3-mini', label: 'Grok 3 Mini' },
      { id: 'x-ai/grok-code-fast-1', label: 'Grok Code Fast' },
      // Google Gemini
      { id: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
      { id: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash' },
      { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      // DeepSeek
      { id: 'deepseek/deepseek-v3.2', label: 'DeepSeek V3.2' },
      { id: 'deepseek/deepseek-r1', label: 'DeepSeek R1' },
      { id: 'deepseek/deepseek-v3.1', label: 'DeepSeek V3.1' },
      // Meta Llama
      { id: 'meta-llama/llama-4-maverick', label: 'Llama 4 Maverick' },
      { id: 'meta-llama/llama-4-scout', label: 'Llama 4 Scout' },
      // Mistral
      { id: 'mistralai/mistral-large-2512', label: 'Mistral Large 3' },
      { id: 'mistralai/codestral-2508', label: 'Codestral' },
      { id: 'mistralai/devstral-2512', label: 'Devstral 2' },
      // NVIDIA
      { id: 'nvidia/nemotron-3-super-120b-a12b', label: 'Nemotron 3 Super' },
      // Cohere
      { id: 'cohere/command-a', label: 'Command A' },
      // PinchBench Top Success Rate
      { id: 'arcee-ai/trinity-large-thinking', label: '🏆 Arcee Trinity Think' },
      { id: 'xiaomi/mimo-v2-flash', label: '🏆 MiMo V2 Flash' },
      // PinchBench Top Cost
      { id: 'google/gemini-2.5-flash-lite', label: '💰 Gemini 2.5 Flash Lite' },
      { id: 'inception/mercury-2', label: '💰 Mercury 2' },
      { id: 'openai/gpt-oss-120b', label: '💰 GPT-OSS 120B' },
      { id: 'openai/gpt-oss-20b', label: '💰 GPT-OSS 20B' },
      { id: 'z-ai/glm-4.5-air', label: '💰 GLM 4.5 Air' },
      // PinchBench Top Speed
      { id: 'openai/gpt-4o', label: '⚡ GPT-4o' },
      { id: 'meta-llama/llama-3.1-70b-instruct', label: '⚡ Llama 3.1 70B' },
      // PinchBench Top Value
      { id: 'qwen/qwen3.5-27b', label: '🎯 Qwen 3.5 27B' },
      { id: 'qwen/qwen3.5-397b-a17b', label: '🎯 Qwen 3.5 397B' },
      { id: 'qwen/qwen3.5-9b', label: '🎯 Qwen 3.5 9B' },
      { id: 'qwen/qwen3.5-35b-a3b', label: '🎯 Qwen 3.5 35B' },
      { id: 'qwen/qwen-2.5-7b-instruct', label: '🎯 Qwen 2.5 7B' },
      { id: 'minimax/minimax-m2.7', label: '🎯 MiniMax M2.7' },
      { id: 'minimax/minimax-m2.1', label: '🎯 MiniMax M2.1' },
      { id: 'minimax/minimax-m2.5', label: '🎯 MiniMax M2.5' },
      // Anthropic via OpenRouter
      { id: 'anthropic/claude-opus-4.7', label: 'Claude Opus 4.7' },
      { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
      { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5' }
    ],
    env: {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENAI_API_KEY: process.env.OPENROUTER_API_KEY || ''
    }
  }
};

let currentProvider = process.env.DEFAULT_PROVIDER || 'anthropic';
let currentModel = process.env.DEFAULT_MODEL || process.env.OPENCLAUDE_MODEL || 'sonnet';

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

// --- Proactive session rotation ---
const SESSION_ROTATE_TURNS = 50;
let turnCount = 0;

// --- Host Delegation ---
const DELEGATION_HOST = process.env.DELEGATION_HOST || 'http://host.docker.internal:3847';
const DELEGATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

function delegateToHost(task, context) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ task, context, timeout_ms: DELEGATION_TIMEOUT_MS });
    const url = new URL(`${DELEGATION_HOST}/delegate`);
    const http = require('http');

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
  const resultMsg = `[RESULTADO DEL HOST - OpenClaude ejecutó esta tarea en el servidor principal]\n\n${hostResult}\n\nFormateá este resultado para Jose y respondé normalmente.`;
  const finalResponse = await callMaximus(resultMsg);
  return finalResponse;
}

// --- BTW (side-channel) config ---
const BTW_PROVIDER = process.env.BTW_PROVIDER || 'ollama';
const BTW_MODEL = process.env.BTW_MODEL || 'gemma4:31b-cloud';
const BTW_TIMEOUT_MS = 60 * 1000; // 60 seconds

// --- State tracking ---
const botStartTime = Date.now();
let processingStartTime = null;
let currentProcessingText = null;

// --- Cost tracking ---
let sessionTokensIn = 0;
let sessionTokensOut = 0;
let sessionCostUsd = 0;
let sessionMessages = 0;

// --- Effort & Fast mode ---
let currentEffort = 'auto'; // low, medium, high, max, auto
let fastMode = false;

// --- OpenClaude CLI Subprocess (persistent stream-json mode) ---
let openclaudeProcess = null;
let pendingResolve = null;
let pendingReject = null;
let pendingTimeout = null;
let responseBuffer = '';
let assistantText = '';
let intentionalKill = false;
let activeStatusCard = null; // Shared reference for live action updates in Telegram
const OPENCLAUDE_HARD_TIMEOUT_MS = 30 * 60 * 1000; // 30 min hard safety net
const OPENCLAUDE_NOTIFY_INTERVAL_MS = 3 * 60 * 1000; // 3 min notify interval

// Tool name → human-readable label for StatusCard
const TOOL_LABELS = {
  Read: (input) => `📄 Leyendo ${path.basename(input.file_path || '')}`,
  Edit: (input) => `✏️ Editando ${path.basename(input.file_path || '')}`,
  Write: (input) => `📝 Escribiendo ${path.basename(input.file_path || '')}`,
  Bash: () => `⚙️ Ejecutando comando`,
  Grep: () => `🔍 Buscando en código`,
  Glob: () => `📁 Buscando archivos`,
  WebSearch: () => `🌐 Buscando en internet`,
  WebFetch: () => `🌐 Accediendo a URL`,
  Agent: () => `🤖 Delegando a sub-agente`,
};

// Last image context — persists across messages so follow-up text can reference the image
let lastImageBase64 = null;
let lastImageMimeType = null;
let lastImageTimestamp = 0;
const IMAGE_CONTEXT_TTL_MS = 10 * 60 * 1000; // 10 min — image stays available for follow-up messages

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
    responseBuffer = lines.pop(); // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        handleOpenClaudeMessage(msg);
      } catch (e) {
        // Not JSON — probably a startup banner or debug line
      }
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
    // Respawn (immediate if intentional switch, 3s delay if crash)
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

  // Inject recent conversation history on spawn for session recovery
  try {
    const db = memory.getDb();
    if (db) {
      const recentMessages = db.prepare(
        'SELECT role, content, timestamp FROM messages ORDER BY id DESC LIMIT 10'
      ).all().reverse();

      if (recentMessages.length > 0) {
        const history = recentMessages.map(m => {
          const time = new Date(m.timestamp).toLocaleString('es-CR', {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
          });
          const name = m.role === 'user' ? 'Jose' : 'Maximus';
          const shortContent = m.content.length > 150 ? m.content.substring(0, 150) + '...' : m.content;
          return `[${time}] ${name}: ${shortContent}`;
        }).join('\n');

        // Wait a moment for the process to be ready, then inject context
        setTimeout(() => {
          if (openclaudeProcess === proc) {
            const contextMsg = {
              type: 'user',
              session_id: '',
              message: {
                role: 'user',
                content: `[SISTEMA - RECUPERACION DE SESION] Estos son los últimos ${recentMessages.length} mensajes de la conversación con Jose. Absorbé el contexto silenciosamente y respondé SOLO: "ok"\n\n${history}`
              },
              parent_tool_use_id: null
            };
            proc.stdin.write(JSON.stringify(contextMsg) + '\n');
            console.log(`[OpenClaude] Session recovery: ${recentMessages.length} messages injected`);
          }
        }, 2000);
      }
    }
  } catch (e) {
    console.error('[OpenClaude] Session recovery error:', e.message);
  }

  return proc;
}

function handleOpenClaudeMessage(msg) {
  if (msg.type === 'assistant' && msg.message && msg.message.content) {
    // Complete assistant message — extract text from content blocks
    const textParts = msg.message.content
      .filter(c => c.type === 'text')
      .map(c => c.text);
    if (textParts.length > 0) {
      assistantText = textParts.join('');
    }
    // Track tool_use calls in Mission Control + StatusCard live updates
    const toolCalls = msg.message.content.filter(c => c.type === 'tool_use');
    if (toolCalls.length > 0) {
      const toolName = toolCalls[0].name || 'tool';
      if (pendingResolve) mcUpdateStatus('working', `Ejecutando: ${toolName}`);
      // Update StatusCard with tool action
      if (activeStatusCard) {
        const labelFn = TOOL_LABELS[toolName];
        const actionText = labelFn ? labelFn(toolCalls[0].input || {}) : toolName;
        activeStatusCard.updateAction(actionText);
      }
    }
    // Show assistant "thinking" text on StatusCard
    const textBlocks = msg.message.content.filter(c => c.type === 'text');
    if (textBlocks.length > 0 && activeStatusCard && toolCalls.length === 0) {
      const thought = textBlocks[0].text.trim().substring(0, 60);
      if (thought) activeStatusCard.updateAction(thought);
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

    // Turn complete — resolve the pending promise
    if (pendingResolve) {
      const text = assistantText || (msg.result || '');
      assistantText = '';
      if (pendingTimeout) { clearInterval(pendingTimeout); pendingTimeout = null; }
      const resolve = pendingResolve;
      pendingResolve = null;
      pendingReject = null;
      if (msg.is_error) {
        console.error(`[OpenClaude] Turn error: ${text.substring(0, 200)}`);
        // Auth error → kill and respawn, reject so caller can retry
        if (text.includes('Not logged in') || text.includes('Please run /login') || text.includes('authentication_error') || text.includes('Invalid authentication credentials')) {
          console.error('[OpenClaude] Auth error detected — killing process for respawn');
          mcUpdateStatus('idle', 'Error de autenticación — reiniciando');
          intentionalKill = true;
          if (openclaudeProcess) openclaudeProcess.kill('SIGTERM');
          resolve('[ERROR:AUTH] Maximus se está reiniciando, intentá de nuevo en unos segundos.');
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
      mcUpdateStatus('idle', 'Respuesta enviada a Jose');
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
    proc.stderr.on('data', d => {
      const text = d.toString();
      output += text;
      // Parse Codex stderr for live action updates
      if (activeStatusCard) {
        const lines = text.split('\n').filter(l => l.trim());
        for (const line of lines) {
          const clean = line.replace(/[\u2800-\u28FF⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '').trim();
          if (!clean || clean.length < 3) continue;
          // Map Codex actions to friendly labels
          if (/read|reading/i.test(clean)) {
            activeStatusCard.updateAction('📄 Leyendo archivo');
          } else if (/exec|running|command/i.test(clean)) {
            activeStatusCard.updateAction('⚙️ Ejecutando comando');
          } else if (/search|grep/i.test(clean)) {
            activeStatusCard.updateAction('🔍 Buscando en código');
          } else if (/writ|edit|patch/i.test(clean)) {
            activeStatusCard.updateAction('✏️ Editando archivo');
          } else if (/fetch|http|curl|web/i.test(clean)) {
            activeStatusCard.updateAction('🌐 Accediendo a URL');
          } else if (clean.length > 5 && clean.length < 60) {
            activeStatusCard.updateAction(clean.substring(0, 50));
          }
        }
      }
    });
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
        'HTTP-Referer': 'https://maximus.bot',
        'X-Title': 'Maximus Telegram Bot'
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
  const hasStoredImage = lastImageBase64 && (Date.now() - lastImageTimestamp) < IMAGE_CONTEXT_TTL_MS;

  // Image generation
  const imgMatch = cleanText.match(/\[GENIMG\]([\s\S]*?)\[\/GENIMG\]/);
  if (imgMatch) {
    const imgPrompt = imgMatch[1].trim();
    cleanText = cleanText.replace(/\[GENIMG\][\s\S]*?\[\/GENIMG\]/, '').trim();
    try {
      safeSendChatAction(chatId, 'upload_photo');
      if (hasStoredImage) {
        console.log(`[ImageGen] Editing with stored image: "${imgPrompt.substring(0, 100)}"`);
      } else {
        console.log(`[ImageGen] Generating from text: "${imgPrompt.substring(0, 100)}"`);
      }
      const result = await generateImage(
        imgPrompt,
        hasStoredImage ? lastImageBase64 : null,
        hasStoredImage ? lastImageMimeType : null
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
        console.log(`[ImageGen] Sent ${result.images.length} image(s)`);
      } else {
        console.log('[ImageGen] No images returned');
        await bot.sendMessage(chatId, '⚠️ El modelo no devolvió imágenes. Probá con otro modelo (/imagen).');
      }
    } catch (imgErr) {
      console.error('[ImageGen Error]', imgErr.message);
      await bot.sendMessage(chatId, `❌ Error generando imagen: ${imgErr.message.substring(0, 200)}`);
    }
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
        hasStoredImage ? lastImageBase64 : null,
        hasStoredImage ? lastImageMimeType : null
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
            // Update StatusCard with tool actions from OneShot
            if (activeStatusCard) {
              const toolCalls = msg.message.content.filter(c => c.type === 'tool_use');
              if (toolCalls.length > 0) {
                const tool = toolCalls[0];
                const labelFn = TOOL_LABELS[tool.name];
                const actionText = labelFn ? labelFn(tool.input || {}) : tool.name;
                activeStatusCard.updateAction(actionText);
              } else if (text && toolCalls.length === 0) {
                const thought = text.trim().substring(0, 60);
                if (thought) activeStatusCard.updateAction(thought);
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

async function callMaximus(userMessage, imageBase64 = null, imageMimeType = null) {
  console.log(`[callMaximus] ENTRY — imageBase64: ${imageBase64 ? imageBase64.length + ' chars' : 'NULL'}, provider: ${currentProvider}`);
  // For images: only Anthropic (via persistent OpenClaude) supports vision natively
  // All other providers (Codex, Ollama, OpenRouter) fall back to OpenClaude one-shot for image analysis
  if (imageBase64 && currentProvider !== 'anthropic') {
    console.log(`[callMaximus] Image received but provider "${currentProvider}" may not support vision — using OpenClaude one-shot`);
    return callOpenClaudeOneShot(userMessage, imageBase64, imageMimeType);
  }
  if (currentProvider === 'codex') {
    return callCodex(userMessage);
  }
  if (!openclaudeProcess) {
    throw new Error('OpenClaude process not running');
  }
  if (pendingResolve) {
    throw new Error('OpenClaude is already processing a message');
  }

  // Build content — NO context prefix, OpenClaude manages its own context natively
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

  // Notify Mission Control: agent is now working
  const activityPreview = typeof content === 'string' ? content.substring(0, 80) : 'Procesando mensaje con imagen';
  mcUpdateStatus('working', activityPreview);

  return new Promise((resolve, reject) => {
    assistantText = '';
    pendingResolve = resolve;
    pendingReject = reject;

    // Periodic "still working" notification instead of killing the process
    const notifyStart = Date.now();
    pendingTimeout = setInterval(() => {
      const elapsed = Math.floor((Date.now() - notifyStart) / 1000);
      const mins = Math.floor(elapsed / 60);
      // Hard safety net: kill after 30 min (something is really stuck)
      if (elapsed > OPENCLAUDE_HARD_TIMEOUT_MS / 1000) {
        clearInterval(pendingTimeout);
        pendingTimeout = null;
        if (pendingReject) {
          const rej = pendingReject;
          pendingResolve = null;
          pendingReject = null;
          rej(new Error(`OpenClaude hard timeout (${mins} min)`));
        }
        return;
      }
      // Send typing action so Jose sees it's alive
      safeSendChatAction(ALLOWED_USER_ID, 'typing');
      console.log(`[OpenClaude] Still working... (${mins}m ${elapsed % 60}s)`);
    }, OPENCLAUDE_NOTIFY_INTERVAL_MS);

    const jsonPayload = JSON.stringify(inputMsg);
    if (imageBase64) {
      const payloadSizeMB = (Buffer.byteLength(jsonPayload) / 1024 / 1024).toFixed(2);
      console.log(`[OpenClaude] Sending image message. base64 length: ${imageBase64.length} chars, payload: ${payloadSizeMB} MB, mime: ${imageMimeType}`);
      console.log(`[OpenClaude] Image content structure: ${JSON.stringify(content.map(c => c.type === 'image' ? {type: c.type, source_type: c.source.type, media_type: c.source.media_type, data_len: c.source.data.length} : c))}`);
    }
    const written = openclaudeProcess.stdin.write(jsonPayload + '\n');
    if (!written) {
      console.warn('[OpenClaude] stdin backpressure — large payload may be buffering');
    }
  });
}

// --- Status Cards (live progress messages) ---
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
    // Start typing indicator
    this._startTyping();
    // Pulse: update elapsed time every 5s so Jose sees it's alive
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
    } catch (e) { /* message not modified or deleted */ }
  }
}

const bot = new TelegramBot(TOKEN, { polling: true });
global.telegramBot = bot;

// Initialize persistent memory system
memory.init();

console.log(`[Maximus Bot] Iniciado. Allowlist: ${ALLOWED_USER_ID}`);
console.log(`[Maximus Bot] Audio: ElevenLabs TTS/STT habilitado`);
console.log(`[Maximus Bot] Memoria persistente: habilitada`);

function isAllowed(msg) {
  return msg.from && msg.from.id === ALLOWED_USER_ID;
}

// --- Message Queue (max 5, drop stale >5min) ---
const MAX_QUEUE_SIZE = 5;
const MAX_QUEUE_AGE_MS = 5 * 60 * 1000; // 5 minutes
const messageQueue = [];
let processing = false;

async function enqueueMessage(handler) {
  handler._enqueuedAt = Date.now();

  // Drop oldest if queue is full
  if (messageQueue.length >= MAX_QUEUE_SIZE) {
    const dropped = messageQueue.shift();
    console.log(`[Queue] Dropped oldest message (queue full, max ${MAX_QUEUE_SIZE})`);
  }

  messageQueue.push(handler);
  if (!processing) {
    processQueue();
  }
}

async function processQueue() {
  if (processing || messageQueue.length === 0) return;
  processing = true;
  while (messageQueue.length > 0) {
    const handler = messageQueue.shift();

    // Drop stale messages (>5 min waiting)
    const age = Date.now() - (handler._enqueuedAt || 0);
    if (age > MAX_QUEUE_AGE_MS) {
      console.log(`[Queue] Dropped stale message (waited ${Math.round(age / 1000)}s)`);
      continue;
    }

    try {
      await handler();
    } catch (err) {
      console.error('[Queue Error]', err.message);
    }
  }
  processing = false;
}

// --- Text Batching (2s window to group rapid messages) ---
const BATCH_WINDOW_MS = 2000;
let batchBuffer = [];
let batchTimer = null;

function enqueueBatchedText(msg, chatId) {
  batchBuffer.push(msg.text);

  if (batchTimer) clearTimeout(batchTimer);

  batchTimer = setTimeout(() => {
    const count = batchBuffer.length;
    const combinedText = batchBuffer.join('\n');
    batchBuffer = [];
    batchTimer = null;

    if (count > 1) {
      console.log(`[Batch] Combined ${count} messages into one`);
    }

    enqueueMessage(async () => {
      await handleTextMessage(chatId, combinedText, Date.now());
    });
  }, BATCH_WINDOW_MS);
}

// --- Safe Telegram API call (handles 429 rate limits) ---
async function safeSendChatAction(chatId, action) {
  try {
    await bot.sendChatAction(chatId, action);
  } catch (err) {
    if (err.response && err.response.statusCode === 429) {
      const retryAfter = (err.response.body?.parameters?.retry_after || 5) * 1000;
      console.log(`[Rate Limit] sendChatAction throttled, waiting ${retryAfter}ms`);
      await new Promise(r => setTimeout(r, retryAfter));
    }
  }
}

// Alias for backward compat (Linear, daily summary)
async function callOpenClaude(userMessage) {
  return callMaximus(userMessage);
}

// Switch model: kill current process, respawn with new provider/model
function switchModel(providerId, modelId) {
  currentProvider = providerId;
  currentModel = modelId;
  intentionalKill = true;
  if (openclaudeProcess) {
    openclaudeProcess.kill('SIGTERM');
  } else {
    spawnOpenClaude();
  }
}

// Spawn OpenClaude on startup
spawnOpenClaude();

// Connect to Mission Control
setTimeout(connectToMC, 3000);

// --- Model page builder (4 rows of 2, with next/prev) ---
const MODELS_PER_PAGE = 8; // 4 rows × 2 columns

async function showModelPage(chatId, messageId, providerId, page) {
  const provider = PROVIDERS[providerId];
  if (!provider) return;

  const models = provider.models;
  const totalPages = Math.ceil(models.length / MODELS_PER_PAGE);
  const start = page * MODELS_PER_PAGE;
  const pageModels = models.slice(start, start + MODELS_PER_PAGE);

  // Build rows of 2
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

  // Navigation row
  const navRow = [];
  if (page > 0) navRow.push({ text: '⬅️ Anterior', callback_data: `page:${providerId}:${page - 1}` });
  navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: 'noop' });
  if (page < totalPages - 1) navRow.push({ text: 'Siguiente ➡️', callback_data: `page:${providerId}:${page + 1}` });
  buttons.push(navRow);

  // Back button
  buttons.push([{ text: '⬅️ Volver a proveedores', callback_data: 'back' }]);

  const text = `📦 *${provider.label}* — Página ${page + 1}/${totalPages}\n\nEscogé un modelo:`;
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } };

  if (messageId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts });
  } else {
    await bot.sendMessage(chatId, text, opts);
  }
}

// --- /model command (show current model) ---
bot.onText(/\/model$/, async (msg) => {
  if (!isAllowed(msg)) return;
  const provider = PROVIDERS[currentProvider];
  const modelInfo = provider.models.find(m => m.id === currentModel);
  const modelLabel = modelInfo ? modelInfo.label : currentModel;
  await bot.sendMessage(msg.chat.id,
    `🤖 *Modelo activo:* ${provider.label} / ${modelLabel}\n\`${currentModel}\``, {
    parse_mode: 'Markdown'
  });
});

// --- /models command (inline keyboard) ---
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

// --- Handle inline keyboard button presses ---
bot.on('callback_query', async (query) => {
  if (!isAllowed({ from: query.from })) {
    await bot.answerCallbackQuery(query.id, { text: 'No autorizado' });
    return;
  }

  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  await bot.answerCallbackQuery(query.id);

  // No-op (page counter button)
  if (data === 'noop') return;

  // Provider selected → show its models (paginated)
  if (data.startsWith('prov:')) {
    const providerId = data.split(':')[1];
    const page = 0;
    await showModelPage(chatId, messageId, providerId, page);
    return;
  }

  // Pagination: next/prev page
  if (data.startsWith('page:')) {
    const [, providerId, pageStr] = data.split(':');
    await showModelPage(chatId, messageId, providerId, parseInt(pageStr));
    return;
  }

  // Model selected → switch
  if (data.startsWith('mdl:')) {
    const parts = data.split(':');
    const providerId = parts[1];
    const modelId = parts.slice(2).join(':'); // model IDs can have colons (e.g. qwen3.5)
    const provider = PROVIDERS[providerId];
    if (!provider) return;

    const modelInfo = provider.models.find(m => m.id === modelId);

    // Already on this model? Just confirm
    if (providerId === currentProvider && modelId === currentModel) {
      await bot.editMessageText(
        `✅ Ya estás en *${provider.label}* / *${modelInfo?.label || modelId}*`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
      });
      return;
    }

    switchModel(providerId, modelId);

    await bot.editMessageText(
      `🔄 Cambiando a *${provider.label}* / *${modelInfo?.label || modelId}*...`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown'
    });

    // Wait for respawn and confirm
    setTimeout(async () => {
      try {
        await bot.editMessageText(
          `✅ Listo — ahora usando *${provider.label}* / *${modelInfo?.label || modelId}*`, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown'
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

  // Back to provider list
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
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [buttons] }
    });
    return;
  }
});

// --- ElevenLabs STT (Speech-to-Text) ---
async function transcribeAudio(filePath) {
  const FormData = (await import('form-data')).default;
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  form.append('model_id', 'scribe_v2');

  const response = await axios.post(
    'https://api.elevenlabs.io/v1/speech-to-text',
    form,
    {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        ...form.getHeaders()
      },
      timeout: 60000
    }
  );

  console.log(`[STT] Transcripción: "${response.data.text}"`);
  return response.data.text;
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
    else splitAt += 1; // include the punctuation
    chunks.push(remaining.substring(0, splitAt).trim());
    remaining = remaining.substring(splitAt).trim();
  }
  return chunks;
}

// --- ElevenLabs TTS (single chunk) ---
async function ttsChunk(text, outputPath) {
  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    {
      text: text,
      model_id: TTS_MODEL,
      voice_settings: VOICE_SETTINGS
    },
    {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/ogg'
      },
      params: { output_format: OUTPUT_FORMAT },
      responseType: 'arraybuffer',
      timeout: 120000
    }
  );

  fs.writeFileSync(outputPath, Buffer.from(response.data));
  return outputPath;
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
      if (error) {
        reject(error);
        return;
      }
      resolve(outputPath);
    });
  });
}

// --- ElevenLabs TTS (Text-to-Speech) with chunking for long texts ---
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

// --- FFmpeg Volume Boost ---
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
      if (error) {
        console.error(`[FFmpeg Error]`, error.message);
        reject(error);
        return;
      }
      console.log(`[FFmpeg] Volume boost aplicado: ${outputPath}`);
      resolve(outputPath);
    });
  });
}

// --- Download Telegram file ---
async function downloadTelegramFile(fileId, destPath) {
  const file = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;

  const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 30000 });
  fs.writeFileSync(destPath, Buffer.from(response.data));
  console.log(`[Download] Archivo descargado: ${destPath}`);
  return destPath;
}

// --- Cleanup temp files ---
function cleanup(...files) {
  for (const f of files) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { /* ignore */ }
  }
}

// --- Convert markdown to Telegram HTML ---
function mdToHtml(text) {
  let html = text;

  // Headers → bold with emoji
  html = html.replace(/^### (.+)$/gm, '\n🔹 <b>$1</b>');
  html = html.replace(/^## (.+)$/gm, '\n📌 <b>$1</b>');
  html = html.replace(/^# (.+)$/gm, '\n📋 <b>$1</b>');

  // Bold & italic (process before single)
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  html = html.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '<i>$1</i>');
  html = html.replace(/__(.+?)__/g, '<b>$1</b>');
  html = html.replace(/(?<!\w)_(.+?)_(?!\w)/g, '<i>$1</i>');

  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Inline code (but not triple backticks)
  html = html.replace(/(?<!`)`([^`\n]+?)`(?!`)/g, '<code>$1</code>');

  // Bullet points with emoji
  html = html.replace(/^[\s]*[-*] /gm, '  • ');

  // Numbered lists with emoji
  html = html.replace(/^(\d+)\. /gm, '  $1️⃣ ');

  // Blockquotes
  html = html.replace(/^> (.+)$/gm, '┃ <i>$1</i>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Clean up excessive newlines
  html = html.replace(/\n{3,}/g, '\n\n');

  return html.trim();
}

// --- Extract code blocks from text ---
function extractCodeBlocks(text) {
  const codeBlocks = [];
  let index = 0;
  const cleaned = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, code) => {
    codeBlocks.push({ lang: lang || 'code', code: code.trim() });
    index++;
    return `\n💻 <i>Ver código ${lang || ''} abajo ⬇️</i>\n`;
  });
  return { text: cleaned, codeBlocks };
}

// --- Send text response (HTML formatted with separate code blocks) ---
async function sendTextResponse(chatId, responseText) {
  // Extract code blocks first
  const { text: mainText, codeBlocks } = extractCodeBlocks(responseText);

  // Convert markdown to HTML
  const htmlText = mdToHtml(mainText);

  // Send main message
  const sendHtml = async (chatId, content) => {
    if (content.length > 4096) {
      // Split on double newlines to keep structure
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
        await bot.sendMessage(chatId, part, { parse_mode: 'HTML' }).catch(() => {
          bot.sendMessage(chatId, part);
        });
      }
    } else {
      await bot.sendMessage(chatId, content, { parse_mode: 'HTML' }).catch(() => {
        bot.sendMessage(chatId, content);
      });
    }
  };

  await sendHtml(chatId, htmlText);

  // Send each code block as a separate copyable message
  for (const block of codeBlocks) {
    const codeMsg = `📋 <b>${block.lang.toUpperCase()}</b>\n\n<pre><code class="language-${block.lang}">${escapeHtml(block.code)}</code></pre>`;
    await bot.sendMessage(chatId, codeMsg, { parse_mode: 'HTML' }).catch(() => {
      bot.sendMessage(chatId, `${block.lang}:\n${block.code}`);
    });
  }
}

// --- Escape HTML special chars for code blocks ---
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
        const msg = JSON.parse(line);
        if (msg.type === 'assistant' && msg.message?.content) {
          const parts = msg.message.content.filter(c => c.type === 'text').map(c => c.text);
          if (parts.length > 0) btwText = parts.join('');
        } else if (msg.type === 'result' && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          const response = btwText || msg.result || '(sin respuesta)';
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

  // Send the question
  const inputMsg = {
    type: 'user',
    session_id: '',
    message: { role: 'user', content: `Respondé de forma MUY breve y directa (máximo 2-3 oraciones). Pregunta: ${question}` },
    parent_tool_use_id: null
  };
  btwProc.stdin.write(JSON.stringify(inputMsg) + '\n');
});

// --- /status command ---
bot.onText(/\/status$/, async (msg) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;

  const uptime = Date.now() - botStartTime;
  const uptimeStr = formatUptime(uptime);
  const provider = PROVIDERS[currentProvider];
  const modelInfo = provider.models.find(m => m.id === currentModel);
  const modelLabel = modelInfo ? modelInfo.label : currentModel;
  const queueSize = messageQueue.length;
  const isProcessing = !!processingStartTime;

  let statusText = `📊 <b>Estado de Maximus</b>\n\n`;
  statusText += `🤖 <b>Modelo:</b> ${provider.label} / ${modelLabel}\n`;
  statusText += `⏱ <b>Uptime:</b> ${uptimeStr}\n`;
  statusText += `📬 <b>Cola:</b> ${queueSize} mensaje${queueSize !== 1 ? 's' : ''}\n`;

  if (isProcessing) {
    const elapsed = Math.floor((Date.now() - processingStartTime) / 1000);
    statusText += `\n⚡ <b>Procesando</b> (${elapsed}s)\n`;
    if (currentProcessingText) {
      statusText += `📝 <i>"${escapeHtml(currentProcessingText)}${currentProcessingText.length >= 100 ? '...' : ''}"</i>\n`;
    }
  } else {
    statusText += `\n😎 <b>Idle</b> — listo para trabajar\n`;
  }

  statusText += `\n💡 BTW: ${PROVIDERS[BTW_PROVIDER]?.label || BTW_PROVIDER} / ${BTW_MODEL}`;

  await bot.sendMessage(chatId, statusText, { parse_mode: 'HTML' });
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

// --- /cancel command ---
bot.onText(/\/cancel$/, async (msg) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;

  if (!processingStartTime && messageQueue.length === 0) {
    await bot.sendMessage(chatId, '😎 No hay nada que cancelar — estoy idle.');
    return;
  }

  const queueCleared = messageQueue.length;
  messageQueue.length = 0; // vaciar cola

  if (pendingResolve) {
    // Reject pending promise so handleTextMessage's catch fires
    const rej = pendingReject;
    pendingResolve = null;
    pendingReject = null;
    if (pendingTimeout) { clearInterval(pendingTimeout); pendingTimeout = null; }
    if (rej) rej(new Error('Cancelled by user'));
  }

  // Kill and respawn
  intentionalKill = true;
  if (openclaudeProcess) {
    openclaudeProcess.kill('SIGTERM');
  }

  processingStartTime = null;
  currentProcessingText = null;

  let cancelMsg = '🛑 Operación cancelada.';
  if (queueCleared > 0) cancelMsg += ` ${queueCleared} mensaje${queueCleared > 1 ? 's' : ''} en cola eliminado${queueCleared > 1 ? 's' : ''}.`;
  cancelMsg += ' Listo para nuevas instrucciones.';

  await bot.sendMessage(chatId, cancelMsg);
  console.log(`[Cancel] Operación cancelada por Jose. Cola limpiada: ${queueCleared}`);
});

// --- /compact command (native OpenClaude compact) ---
bot.onText(/\/compact(?:\s+(.+))?$/s, async (msg, match) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;
  const instructions = match?.[1]?.trim();

  if (!openclaudeProcess) {
    await bot.sendMessage(chatId, '❌ Proceso OpenClaude no está corriendo.');
    return;
  }

  if (processingStartTime) {
    await bot.sendMessage(chatId, '⏳ Esperá a que termine la tarea actual o usá /cancel primero.');
    return;
  }

  await bot.sendMessage(chatId, '🧹 Compactando contexto...');

  // Send /compact as a user message — OpenClaude handles it natively
  const compactCmd = instructions ? `/compact ${instructions}` : '/compact';
  const inputMsg = {
    type: 'user',
    session_id: '',
    message: { role: 'user', content: compactCmd },
    parent_tool_use_id: null
  };

  // Listen for compact_boundary event
  const compactListener = (chunk) => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'system' && parsed.subtype === 'compact_boundary') {
          const preTokens = parsed.compact_metadata?.pre_tokens || '?';
          bot.sendMessage(chatId, `✅ Contexto compactado (${preTokens} tokens comprimidos). Memoria y resumen preservados.`);
          openclaudeProcess.stdout.removeListener('data', compactListener);
          console.log(`[Compact] Nativo completado. Pre-tokens: ${preTokens}`);
        }
      } catch (e) { /* not JSON */ }
    }
  };

  openclaudeProcess.stdout.on('data', compactListener);

  // Timeout: remove listener after 30s if no compact_boundary received
  setTimeout(() => {
    openclaudeProcess?.stdout.removeListener('data', compactListener);
  }, 30000);

  openclaudeProcess.stdin.write(JSON.stringify(inputMsg) + '\n');
  console.log(`[Compact] Enviando compact nativo${instructions ? `: ${instructions}` : ''}`);
});

// --- /clear command (full reset) ---
bot.onText(/\/clear$/, async (msg) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;

  // Clear queue
  messageQueue.length = 0;
  batchBuffer = [];
  if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }

  // Reset cost tracking
  sessionTokensIn = 0;
  sessionTokensOut = 0;
  sessionCostUsd = 0;
  sessionMessages = 0;

  // Kill and respawn
  intentionalKill = true;
  if (pendingReject) {
    const rej = pendingReject;
    pendingResolve = null;
    pendingReject = null;
    if (pendingTimeout) { clearInterval(pendingTimeout); pendingTimeout = null; }
    rej(new Error('Session cleared'));
  }
  processingStartTime = null;
  currentProcessingText = null;
  if (openclaudeProcess) openclaudeProcess.kill('SIGTERM');

  await bot.sendMessage(chatId, '🔄 Sesión reiniciada completamente. Historial, cola y contadores en cero.');
  console.log('[Clear] Sesión reiniciada por Jose');
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
  console.log(`[Effort] Cambiado a ${level}`);
});

// --- /fast command (toggle) ---
bot.onText(/\/fast$/, async (msg) => {
  if (!isAllowed(msg)) return;
  fastMode = !fastMode;
  const emoji = fastMode ? '🐇' : '🐢';
  await bot.sendMessage(msg.chat.id, `${emoji} Modo rápido: <b>${fastMode ? 'ON' : 'OFF'}</b>`, { parse_mode: 'HTML' });
  console.log(`[Fast] Modo rápido: ${fastMode}`);
});

// --- /diff command ---
bot.onText(/\/diff(?:\s+(.+))?$/, async (msg, match) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;
  const targetPath = match?.[1]?.trim() || '/app';

  try {
    const { execSync } = require('child_process');
    const diffOutput = execSync(`git -C "${targetPath}" diff --stat 2>&1 && echo "---FULL---" && git -C "${targetPath}" diff --no-color 2>&1`, {
      timeout: 10000,
      maxBuffer: 50 * 1024
    }).toString();

    if (!diffOutput.trim() || diffOutput.includes('not a git repository')) {
      await bot.sendMessage(chatId, `📝 No hay cambios en <code>${escapeHtml(targetPath)}</code>`, { parse_mode: 'HTML' });
      return;
    }

    const [stats, full] = diffOutput.split('---FULL---');
    let response = `📝 <b>Diff</b> (<code>${escapeHtml(targetPath)}</code>)\n\n<pre>${escapeHtml(stats.trim())}</pre>`;

    if (full?.trim()) {
      const truncated = full.trim().substring(0, 3000);
      response += `\n\n<pre><code>${escapeHtml(truncated)}${full.trim().length > 3000 ? '\n... (truncado)' : ''}</code></pre>`;
    }

    await bot.sendMessage(chatId, response, { parse_mode: 'HTML' }).catch(() => {
      bot.sendMessage(chatId, `Diff en ${targetPath}:\n${stats}`);
    });
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Error: ${err.message.substring(0, 200)}`);
  }
});

// --- /commit command ---
bot.onText(/\/commit(?:\s+(.+))?$/s, async (msg, match) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;
  const commitMsg = match?.[1]?.trim();

  if (!commitMsg) {
    await bot.sendMessage(chatId, '💡 Uso: <code>/commit mensaje del commit</code>', { parse_mode: 'HTML' });
    return;
  }

  try {
    const { execSync } = require('child_process');
    // Check if there are changes
    const status = execSync('git -C /app status --porcelain 2>&1', { timeout: 5000 }).toString().trim();
    if (!status) {
      await bot.sendMessage(chatId, '📝 No hay cambios para commitear.');
      return;
    }

    execSync(`git -C /app add -A 2>&1`, { timeout: 5000 });
    const result = execSync(`git -C /app commit -m "${commitMsg.replace(/"/g, '\\"')}" 2>&1`, { timeout: 10000 }).toString();

    const filesChanged = (result.match(/(\d+) files? changed/) || ['', '?'])[1];
    await bot.sendMessage(chatId,
      `✅ Commit creado\n\n📝 <code>${escapeHtml(commitMsg)}</code>\n📁 ${filesChanged} archivo(s)`,
      { parse_mode: 'HTML' });
    console.log(`[Commit] ${commitMsg}`);
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Error en commit: ${err.message.substring(0, 300)}`);
  }
});

// --- /summary command ---
bot.onText(/\/summary$/, async (msg) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;

  safeSendChatAction(chatId, 'typing');

  // Use btw-style temporary process for summary
  const btwProvider = PROVIDERS[BTW_PROVIDER];
  const spawnEnv = { ...process.env, HOME: '/app', ...btwProvider.env };
  const summaryProc = spawn('openclaude', [
    '-p',
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--model', BTW_MODEL
  ], { cwd: '/app', stdio: ['pipe', 'pipe', 'pipe'], env: spawnEnv });

  let sBuffer = '';
  let sText = '';
  let resolved = false;

  const timeout = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      summaryProc.kill('SIGTERM');
      bot.sendMessage(chatId, '⏱ Summary timeout.');
    }
  }, BTW_TIMEOUT_MS);

  summaryProc.stdout.on('data', (chunk) => {
    sBuffer += chunk.toString();
    const lines = sBuffer.split('\n');
    sBuffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m.type === 'assistant' && m.message?.content) {
          const parts = m.message.content.filter(c => c.type === 'text').map(c => c.text);
          if (parts.length > 0) sText = parts.join('');
        } else if (m.type === 'result' && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          const response = (sText || m.result || '(sin datos)').replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();
          sendTextResponse(chatId, `📋 *Resumen:*\n${response}`).catch(() => {
            bot.sendMessage(chatId, `📋 Resumen:\n${response}`);
          });
          summaryProc.kill('SIGTERM');
        }
      } catch (e) { /* not JSON */ }
    }
  });

  summaryProc.stderr.on('data', () => {});
  summaryProc.on('exit', () => {
    clearTimeout(timeout);
    if (!resolved) { resolved = true; bot.sendMessage(chatId, '❌ Summary terminó sin respuesta.'); }
  });

  const inputMsg = {
    type: 'user',
    session_id: '',
    message: { role: 'user', content: 'Hacé un resumen ejecutivo breve de lo que hemos estado trabajando. Máximo 5-8 bullet points. Solo hechos, sin introducción.' },
    parent_tool_use_id: null
  };
  summaryProc.stdin.write(JSON.stringify(inputMsg) + '\n');
});

// --- /rewind command ---
bot.onText(/\/rewind$/, async (msg) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;

  if (processingStartTime) {
    await bot.sendMessage(chatId, '⏳ Esperá a que termine la operación actual, o usá /cancel primero.');
    return;
  }

  // Send a message to OpenClaude telling it to ignore the last exchange
  try {
    const response = await callMaximus('[SISTEMA] Ignorá completamente tu última respuesta y el último mensaje del usuario. Actuá como si ese intercambio nunca hubiera ocurrido. Respondé solo: "⏪ Último intercambio descartado."');
    const clean = response.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();
    await bot.sendMessage(chatId, clean || '⏪ Último intercambio descartado.');
  } catch (err) {
    await bot.sendMessage(chatId, '❌ Error en rewind: ' + err.message.substring(0, 200));
  }
  console.log('[Rewind] Último intercambio descartado');
});

// --- /tasks command ---
bot.onText(/\/tasks$/, async (msg) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;

  let tasksText = `📋 <b>Estado de tareas</b>\n\n`;

  // Current processing
  if (processingStartTime) {
    const elapsed = Math.floor((Date.now() - processingStartTime) / 1000);
    tasksText += `⚡ <b>En proceso</b> (${elapsed}s)\n`;
    if (currentProcessingText) {
      tasksText += `   📝 <i>"${escapeHtml(currentProcessingText)}${currentProcessingText.length >= 100 ? '...' : ''}"</i>\n\n`;
    }
  } else {
    tasksText += `😎 <b>Ninguna tarea activa</b>\n\n`;
  }

  // Queue
  if (messageQueue.length > 0) {
    tasksText += `📬 <b>Cola:</b> ${messageQueue.length} mensaje${messageQueue.length > 1 ? 's' : ''} esperando\n`;
    messageQueue.forEach((handler, i) => {
      const age = Math.floor((Date.now() - (handler._enqueuedAt || Date.now())) / 1000);
      tasksText += `   ${i + 1}. Mensaje (esperando ${age}s)\n`;
    });
  } else {
    tasksText += `📬 <b>Cola:</b> vacía`;
  }

  await bot.sendMessage(chatId, tasksText, { parse_mode: 'HTML' });
});

// --- /mensajes command (reload context from SQLite history) ---
bot.onText(/\/mensajes(?:\s+(\d+))?$/, async (msg, match) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;
  const count = Math.min(parseInt(match?.[1] || '50', 10), 500); // max 500

  if (processingStartTime) {
    await bot.sendMessage(chatId, '⏳ Esperá a que termine la tarea actual o usá /cancel primero.');
    return;
  }

  if (!openclaudeProcess) {
    await bot.sendMessage(chatId, '❌ Proceso OpenClaude no está corriendo.');
    return;
  }

  try {
    const db = memory.getDb();
    const messages = db.prepare(
      'SELECT role, content, timestamp FROM messages ORDER BY id DESC LIMIT ?'
    ).all(count).reverse();

    if (messages.length === 0) {
      await bot.sendMessage(chatId, '📭 No hay mensajes guardados en el historial.');
      return;
    }

    await bot.sendMessage(chatId, `📖 Cargando últimos ${messages.length} mensajes como contexto...`);
    safeSendChatAction(chatId, 'typing');

    // Format messages as conversation history
    const history = messages.map(m => {
      const time = new Date(m.timestamp).toLocaleString('es-CR', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
      const name = m.role === 'user' ? 'Jose' : 'Maximus';
      return `[${time}] ${name}: ${m.content}`;
    }).join('\n\n');

    // Send as context to OpenClaude
    const contextMsg = `[SISTEMA - RECARGA DE CONTEXTO]
Jose te pide que leas y absorbas los últimos ${messages.length} mensajes de la conversación.
Usá esta información para entender qué veníamos haciendo, decisiones tomadas, y estado actual del trabajo.
NO respondas con un resumen largo — solo confirmá brevemente que entendés el contexto y qué estábamos haciendo.

=== HISTORIAL (${messages.length} mensajes) ===
${history}
=== FIN DEL HISTORIAL ===`;

    const response = await callMaximus(contextMsg);
    const clean = response.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();
    await sendTextResponse(chatId, clean);
    console.log(`[Mensajes] ${messages.length} mensajes cargados como contexto`);
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Error cargando mensajes: ${err.message.substring(0, 200)}`);
    console.error('[Mensajes] Error:', err.message);
  }
});

// --- /equipo command — ver estado del equipo en Mission Control ---
bot.onText(/\/equipo$/, async (msg) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;
  if (!MC_API_KEY) { await bot.sendMessage(chatId, '❌ Mission Control no configurado.'); return; }
  try {
    const [agentsRes, tasksRes] = await Promise.all([
      mcRequest('/api/agents', 'GET'),
      mcRequest('/api/tasks', 'GET')
    ]);
    const agents = agentsRes.body.agents || [];
    const tasks = tasksRes.body.tasks || [];
    const pending = tasks.filter(t => t.status === 'in_progress').length;
    const done = tasks.filter(t => t.status === 'done').length;
    const inbox = tasks.filter(t => t.status === 'inbox').length;

    let text = `🏢 <b>Estado del Equipo</b>\n\n`;
    for (const a of agents) {
      const icon = a.status === 'online' ? '🟢' : '🔴';
      text += `${icon} <b>${a.name}</b> — ${a.role}\n`;
    }
    text += `\n📊 <b>Tareas</b>\n`;
    text += `  • 📥 Inbox: ${inbox}\n`;
    text += `  • ⚡ En progreso: ${pending}\n`;
    text += `  • ✅ Completadas: ${done}\n`;
    text += `\n🌐 <a href="http://76.13.119.13:3000">Ver dashboard</a>`;
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Error: ${e.message}`);
  }
});

// --- /tarea command — crear tarea en Mission Control ---
bot.onText(/\/tarea (.+)/, async (msg, match) => {
  if (!isAllowed(msg)) return;
  const chatId = msg.chat.id;
  const input = match[1].trim();
  if (!MC_API_KEY) { await bot.sendMessage(chatId, '❌ Mission Control no configurado.'); return; }

  // Formato: /tarea [agente] título de la tarea
  // Ejemplo: /tarea optimus Crear landing page
  const parts = input.split(' ');
  let assignTo = null;
  let title = input;

  // Verificar si el primer word es un agente conocido
  const knownAgents = ['optimus', 'maximus'];
  if (knownAgents.includes(parts[0].toLowerCase())) {
    assignTo = parts[0].toLowerCase();
    title = parts.slice(1).join(' ');
  }

  try {
    let agentId = null;
    if (assignTo) {
      const agentsRes = await mcRequest('/api/agents', 'GET');
      const agent = (agentsRes.body.agents || []).find(a => a.name === assignTo);
      if (agent) agentId = agent.id;
    }

    const taskBody = { title, priority: 'high', status: agentId ? 'assigned' : 'inbox' };
    if (agentId) taskBody.agent_id = agentId;

    const res = await mcRequest('/api/tasks', 'POST', taskBody);
    if (res.status === 201 && res.body.task) {
      const t = res.body.task;
      await bot.sendMessage(chatId,
        `✅ <b>Tarea creada</b> (ID: ${t.id})\n📋 ${t.title}\n${agentId ? `👤 Asignada a: <b>${assignTo}</b>` : '📥 En inbox (sin asignar)'}`,
        { parse_mode: 'HTML' }
      );
    } else {
      await bot.sendMessage(chatId, `❌ Error creando tarea: ${JSON.stringify(res.body)}`);
    }
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Error: ${e.message}`);
  }
});

// --- /help command ---
bot.onText(/\/help$/, async (msg) => {
  if (!isAllowed(msg)) return;
  const helpText = `📋 <b>Comandos de Maximus</b>\n
💬 <b>Mensajes</b>
  • Texto directo — respuesta normal
  • Audio — transcripción + respuesta
  • Imagen — análisis visual

🔧 <b>Control</b>
  • <code>/btw pregunta</code> — pregunta rápida (funciona mientras estoy ocupado)
  • <code>/status</code> — estado actual (modelo, cola, uptime)
  • <code>/tasks</code> — tareas activas y cola
  • <code>/cancel</code> — cancelar operación actual
  • <code>/fast</code> — toggle modo rápido (respuestas breves)
  • <code>/effort nivel</code> — nivel de esfuerzo (low/medium/high/max/auto)

📝 <b>Sesión</b>
  • <code>/compact [nota]</code> — compactar contexto (nativo)
  • <code>/clear</code> — reinicio total de sesión
  • <code>/mensajes [N]</code> — cargar últimos N mensajes como contexto (default: 50)
  • <code>/rewind</code> — deshacer último intercambio
  • <code>/summary</code> — resumen de lo trabajado
  • <code>/cost</code> — tokens y costos de sesión

🤖 <b>Modelo</b>
  • <code>/model</code> — ver modelo activo
  • <code>/models</code> — cambiar modelo/proveedor

💻 <b>Git</b>
  • <code>/diff [path]</code> — ver cambios (default: /app)
  • <code>/commit mensaje</code> — commit rápido

  • <code>/help</code> — esta lista`;

  await bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'HTML' });
});

// --- Message Handler ---
bot.on('message', async (msg) => {
  if (msg.text) console.log(`[MSG RAW] "${msg.text}"`);
  if (!isAllowed(msg)) {
    console.log(`[Blocked] User ${msg.from?.id} (${msg.from?.username}) intentó enviar mensaje`);
    return;
  }

  const chatId = msg.chat.id;
  const isVoice = !!(msg.voice || msg.audio);
  const timestamp = Date.now();

  // Enqueue to process one at a time
  enqueueMessage(async () => {
    // --- VOICE MESSAGE FLOW ---
    if (isVoice) {
      const fileId = (msg.voice || msg.audio).file_id;
      console.log(`[Jose] Audio recibido`);

      const status = new StatusCard(bot, chatId);
      await status.init([
        ['🎙️', 'Descargando audio'],
        ['📝', 'Transcribiendo'],
        ['🧠', 'Pensando'],
        ['🔊', 'Generando respuesta'],
      ]);
      activeStatusCard = status;

      const inputAudio = path.join(TMP_DIR, `input_${timestamp}.oga`);
      const ttsRaw = path.join(TMP_DIR, `tts_raw_${timestamp}.ogg`);
      const ttsBoosted = path.join(TMP_DIR, `tts_boost_${timestamp}.ogg`);

      try {
        await downloadTelegramFile(fileId, inputAudio);
        const audioSize = fs.statSync(inputAudio).size;
        console.log(`[Audio] Archivo descargado: ${inputAudio} (${audioSize} bytes)`);

        await status.advance(); // → Transcribiendo
        const transcription = await transcribeAudio(inputAudio);
        console.log(`[Audio] Transcripción resultado: "${transcription}" (length: ${transcription?.length || 0})`);
        if (!transcription || transcription.trim().length === 0) {
          await status.fail();
          bot.sendMessage(chatId, 'Mae, no logré entender el audio. ¿Podés repetirlo?');
          cleanup(inputAudio);
          return;
        }

        await status.advance(); // → Pensando
        const audioPrompt = `[Este mensaje viene de un audio de Jose] ${transcription}`;
        console.log(`[Audio] Enviando a OpenClaude: "${audioPrompt.substring(0, 200)}"`);
        // Attach recent image if available
        let audioImgB64 = null;
        let audioImgMime = null;
        if (lastImageBase64 && (Date.now() - lastImageTimestamp) < IMAGE_CONTEXT_TTL_MS) {
          audioImgB64 = lastImageBase64;
          audioImgMime = lastImageMimeType;
          console.log(`[Image Context] Attaching stored image to audio message`);
        }
        let rawResponse = await callMaximus(audioPrompt, audioImgB64, audioImgMime);
        rawResponse = await handleDelegation(rawResponse);

        const formatMatch = rawResponse.match(/^\[(AUDIO|TEXTO)\]\s*/i);
        let outputFormat = formatMatch ? formatMatch[1].toUpperCase() : 'AUDIO';
        let responseText = rawResponse.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();

        try { responseText = memory.extractAndSaveMemories(responseText); } catch (memErr) { console.error('[Memory Extract Error]', memErr.message); }

        // Force TEXTO when generating images/videos
        const hasMediaAudio = /\[GENIMG\]|\[GENVID\]/i.test(responseText);
        if (hasMediaAudio && outputFormat === 'AUDIO') {
          console.log('[Format] Forcing TEXTO — response contains image/video generation tags');
          outputFormat = 'TEXTO';
        }

        // Process image/video generation tags
        responseText = await processMediaTags(responseText, chatId);

        await status.advance(); // → Generando respuesta

        if (outputFormat === 'TEXTO') {
          if (responseText) await sendTextResponse(chatId, responseText);
          await status.complete();
          console.log(`[Maximus] Respuesta de audio transcrita -> texto enviado (${responseText.length} chars)`);
        } else {
          await textToSpeech(responseText, ttsRaw);
          await boostVolume(ttsRaw, ttsBoosted);
          await bot.sendVoice(chatId, ttsBoosted);
          await status.complete();
          console.log(`[Maximus] Voice note enviada`);
        }

        try { memory.saveExchange(transcription, responseText); } catch (memErr) { console.error('[Memory Error]', memErr.message); }

      } catch (err) {
        await status.fail(err.message);
        console.error(`[Audio Error]`, err.message);
        bot.sendMessage(chatId, 'Mae, tuve un problema con el audio. Intentá de nuevo.');
      } finally {
        cleanup(inputAudio, ttsRaw, ttsBoosted);
      }
      return;
    }

    // --- IMAGE MESSAGE FLOW ---
    const isImage = !!(msg.photo || (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('image/')));
    if (isImage) {
      const caption = msg.caption || '';
      console.log(`[Jose] Imagen recibida. Caption: "${caption}"`);

      const status = new StatusCard(bot, chatId);
      await status.init([
        ['📸', 'Descargando imagen'],
        ['👁️', 'Analizando imagen'],
        ['🧠', 'Pensando'],
        ['💬', 'Preparando respuesta'],
      ]);
      activeStatusCard = status;

      const imgPath = path.join(TMP_DIR, `telegram_img_${timestamp}.jpg`);
      const ttsRaw = path.join(TMP_DIR, `tts_raw_${timestamp}.ogg`);
      const ttsBoosted = path.join(TMP_DIR, `tts_boost_${timestamp}.ogg`);

      try {
        const fileId = msg.photo
          ? msg.photo[msg.photo.length - 1].file_id
          : msg.document.file_id;

        await downloadTelegramFile(fileId, imgPath);

        await status.advance(); // → Analizando imagen
        const imageBuffer = fs.readFileSync(imgPath);
        const imageBase64 = imageBuffer.toString('base64');
        const mimeType = msg.document?.mime_type || 'image/jpeg';

        // Store image for follow-up text messages
        lastImageBase64 = imageBase64;
        lastImageMimeType = mimeType;
        lastImageTimestamp = Date.now();
        console.log(`[Image Context] Stored image (${imageBase64.length} chars) — available for ${IMAGE_CONTEXT_TTL_MS / 60000} min`);

        const imgMessage = caption
          ? `[IMAGEN enviada por Jose] Caption: "${caption}". Respondé en base a lo que ves. IMPORTANTE: Jose te envió esta imagen, recordala para mensajes siguientes.`
          : '[IMAGEN enviada por Jose] Sin caption. Respondé en base a lo que ves en la imagen. IMPORTANTE: Jose te envió esta imagen, recordala para mensajes siguientes.';

        await status.advance(); // → Pensando
        console.log(`[Image Debug] About to call callMaximus. base64 length: ${imageBase64?.length || 'NULL'}, mime: ${mimeType}, msg: "${imgMessage.substring(0, 80)}"`);
        let rawResponse = await callMaximus(imgMessage, imageBase64, mimeType);
        rawResponse = await handleDelegation(rawResponse);

        const formatMatch = rawResponse.match(/^\[(AUDIO|TEXTO)\]\s*/i);
        let outputFormat = formatMatch ? formatMatch[1].toUpperCase() : 'TEXTO';
        let responseText = rawResponse.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();

        try { responseText = memory.extractAndSaveMemories(responseText); } catch (memErr) { console.error('[Memory Extract Error]', memErr.message); }

        // Force TEXTO when generating images/videos
        const hasMediaImg = /\[GENIMG\]|\[GENVID\]/i.test(responseText);
        if (hasMediaImg && outputFormat === 'AUDIO') {
          console.log('[Format] Forcing TEXTO — response contains image/video generation tags');
          outputFormat = 'TEXTO';
        }

        // Process image/video generation tags
        responseText = await processMediaTags(responseText, chatId);

        await status.advance(); // → Preparando respuesta

        if (outputFormat === 'AUDIO') {
          await textToSpeech(responseText, ttsRaw);
          await boostVolume(ttsRaw, ttsBoosted);
          await bot.sendVoice(chatId, ttsBoosted);
          await status.complete();
          console.log(`[Maximus] Voice note enviada (imagen)`);
        } else {
          if (responseText) await sendTextResponse(chatId, responseText);
          await status.complete();
          console.log(`[Maximus] Texto enviado (imagen ${responseText.length} chars)`);
        }

        const saveText = caption ? `[Imagen con caption: "${caption}"]` : '[Imagen sin caption]';
        try { memory.saveExchange(saveText, responseText); } catch (memErr) { console.error('[Memory Error]', memErr.message); }

      } catch (err) {
        await status.fail(err.message);
        console.error(`[Image Error]`, err.message);
        bot.sendMessage(chatId, 'Mae, tuve un problema procesando la imagen. Intentá de nuevo.');
      } finally {
        cleanup(imgPath, ttsRaw, ttsBoosted);
      }
      return;
    }

    // --- TEXT MESSAGE FLOW (uses batching) ---
    const text = msg.text;
    if (!text) return;

    // Skip commands — handled by onText handlers
    if (text.startsWith('/')) return;

    console.log(`[Jose] ${text}`);
    enqueueBatchedText(msg, chatId);
  });
});

// --- Auto-fetch URLs with Jina.ai Reader ---
async function extractUrlContent(text) {
  const urlRegex = /https?:\/\/[^\s<>'")\]]+/gi;
  const urls = text.match(urlRegex);
  if (!urls || urls.length === 0) return text;

  let enrichedText = text;
  for (const url of urls.slice(0, 3)) { // max 3 URLs per message
    try {
      console.log(`[Jina] Fetching: ${url}`);
      const jinaUrl = `https://r.jina.ai/${url}`;
      const response = await axios.get(jinaUrl, {
        headers: { 'Accept': 'text/plain', 'X-No-Cache': 'true' },
        timeout: 20000,
        maxContentLength: 50000
      });
      const content = response.data?.substring(0, 4000) || '';
      if (content.length > 100 && !content.includes('Enable JavaScript and cookies')) {
        console.log(`[Jina] Contenido extraído: ${content.length} chars`);
        enrichedText += `\n\n[CONTENIDO EXTRAÍDO DE ${url}]:\n${content}\n[FIN DEL CONTENIDO]`;
      } else {
        console.log(`[Jina] Contenido insuficiente o bloqueado para: ${url}`);
      }
    } catch (err) {
      console.log(`[Jina] Error fetching ${url}: ${err.message}`);
    }
  }
  return enrichedText;
}

// --- Handle text message (called after batching window) ---
async function handleTextMessage(chatId, text, timestamp) {
  const status = new StatusCard(bot, chatId);
  await status.init([
    ['📨', 'Recibido'],
    ['🧠', 'Pensando'],
    ['💬', 'Preparando respuesta'],
  ]);
  activeStatusCard = status;

  const ttsRaw = path.join(TMP_DIR, `tts_raw_${timestamp}.ogg`);
  const ttsBoosted = path.join(TMP_DIR, `tts_boost_${timestamp}.ogg`);

  try {
    processingStartTime = Date.now();
    currentProcessingText = text.substring(0, 100);
    // Auto-fetch URL content with Jina.ai before sending to OpenClaude
    const enrichedText = await extractUrlContent(text);
    if (enrichedText !== text) {
      console.log(`[Jina] Mensaje enriquecido con contenido de URLs`);
    }
    await status.advance(); // → Pensando

    // Check if there's a recent image in context to attach
    let imgB64 = null;
    let imgMime = null;
    if (lastImageBase64 && (Date.now() - lastImageTimestamp) < IMAGE_CONTEXT_TTL_MS) {
      imgB64 = lastImageBase64;
      imgMime = lastImageMimeType;
      console.log(`[Image Context] Attaching stored image to text message (age: ${Math.round((Date.now() - lastImageTimestamp) / 1000)}s)`);
    }
    let rawResponse = await callMaximus(enrichedText, imgB64, imgMime);
    rawResponse = await handleDelegation(rawResponse);

    const formatMatch = rawResponse.match(/^\[(AUDIO|TEXTO)\]\s*/i);
    let outputFormat = formatMatch ? formatMatch[1].toUpperCase() : 'TEXTO';
    let responseText = rawResponse.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();

    try { responseText = memory.extractAndSaveMemories(responseText); } catch (memErr) { console.error('[Memory Extract Error]', memErr.message); }

    // Force TEXTO when generating images/videos — audio response makes no sense with media
    const hasMedia = /\[GENIMG\]|\[GENVID\]/i.test(responseText);
    if (hasMedia && outputFormat === 'AUDIO') {
      console.log('[Format] Forcing TEXTO — response contains image/video generation tags');
      outputFormat = 'TEXTO';
    }

    // Process image/video generation tags
    responseText = await processMediaTags(responseText, chatId);

    await status.advance(); // → Preparando respuesta

    if (outputFormat === 'AUDIO') {
      await textToSpeech(responseText, ttsRaw);
      await boostVolume(ttsRaw, ttsBoosted);
      await bot.sendVoice(chatId, ttsBoosted);
      await status.complete();
      console.log(`[Maximus] Voice note enviada (desde texto)`);
    } else {
      if (responseText) await sendTextResponse(chatId, responseText);
      await status.complete();
      console.log(`[Maximus] Respuesta enviada (${responseText.length} chars)`);
    }

    try { memory.saveExchange(text, responseText); } catch (memErr) { console.error('[Memory Error]', memErr.message); }
  } catch (err) {
    await status.fail(err.message);
    console.error(`[Error]`, err.message);
    bot.sendMessage(chatId, 'Mae, tuve un problema procesando tu mensaje. Intentá de nuevo en un momento.');
  } finally {
    processingStartTime = null;
    currentProcessingText = null;
    cleanup(ttsRaw, ttsBoosted);
  }
}

// --- Daily Summary Cron (11:59 PM) ---
function scheduleDailySummary() {
  const now = new Date();
  const target = new Date();
  target.setHours(23, 59, 0, 0);

  // If already past 11:59 PM today, schedule for tomorrow
  if (now >= target) {
    target.setDate(target.getDate() + 1);
  }

  const msUntil = target.getTime() - now.getTime();
  console.log(`[Cron] Daily summary scheduled in ${Math.round(msUntil / 60000)} minutes`);

  setTimeout(async () => {
    await runDailySummary();
    // Schedule next one (recurse)
    scheduleDailySummary();
  }, msUntil);
}

async function runDailySummary() {
  const today = new Date().toISOString().split('T')[0];
  console.log(`[Cron] Running daily summary for ${today}...`);

  try {
    if (!memory.needsSummary(today)) {
      console.log(`[Cron] No unsummarized messages for ${today}, skipping`);
      return;
    }

    const prompt = memory.buildSummaryPrompt(today);
    if (!prompt) {
      console.log(`[Cron] No messages for ${today}, skipping`);
      return;
    }

    const summary = await callOpenClaude(prompt);
    if (summary && summary.trim().length > 50) {
      // Strip any format prefix that OpenClaude might add
      const cleanSummary = summary.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();
      memory.saveDailySummary(today, cleanSummary);
      console.log(`[Cron] Daily summary completed for ${today} (${cleanSummary.length} chars)`);
    } else {
      console.error(`[Cron] Summary too short or empty, skipping save`);
    }
  } catch (err) {
    console.error(`[Cron Error] Daily summary failed:`, err.message);
  }
}

// Start the daily summary cron
scheduleDailySummary();

// --- Dreaming Cron (3 AM) ---
function scheduleDreaming() {
  const now = new Date();
  const target = new Date();
  target.setHours(3, 0, 0, 0);

  // If already past 3 AM today, schedule for tomorrow
  if (now >= target) {
    target.setDate(target.getDate() + 1);
  }

  const msUntil = target.getTime() - now.getTime();
  console.log(`[Cron] Dreaming scheduled in ${Math.round(msUntil / 60000)} minutes`);

  setTimeout(async () => {
    try {
      console.log('[Cron] Starting dream cycle...');
      await dreaming.dream();
      console.log('[Cron] Dream cycle completed');
    } catch (err) {
      console.error('[Cron Error] Dreaming failed:', err.message);
    }
    scheduleDreaming();
  }, msUntil);
}

scheduleDreaming();

// ─── Linear Integration ───────────────────────────────────────
linear.start({
  apiKey: process.env.LINEAR_API_KEY,
  db: memory.getDb(),
  callOpenClaude,
  notifyJose: async (text) => {
    // En chats privados de Telegram, chatId === userId
    const chatId = process.env.JOSE_CHAT_ID || ALLOWED_USER_ID;
    if (!chatId) return;
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(() => {
      bot.sendMessage(chatId, text); // fallback sin markdown
    });
  }
});

bot.on('polling_error', (error) => {
  console.error(`[Polling Error]`, error.message);
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err);
});

process.on('unhandledRejection', (err) => {
  console.error('[Unhandled Rejection]', err);
});
