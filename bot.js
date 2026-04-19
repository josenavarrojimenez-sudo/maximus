require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { execFile, spawn } = require('child_process');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const memory = require('./memory');
const linear = require('./linear');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = parseInt(process.env.ALLOWED_USER_ID, 10);
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const TMP_DIR = path.join(__dirname, 'tmp');

// ElevenLabs config
const VOICE_ID = 'WEXRePkZGpmcFLvCOaB1';
const TTS_MODEL = 'eleven_v3';
const OUTPUT_FORMAT = 'opus_48000_128';
const VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.5,
  use_speaker_boost: true
};

// --- Provider/Model Configuration ---
const PROVIDERS = {
  anthropic: {
    label: 'Anthropic',
    models: [
      { id: 'sonnet', label: 'Sonnet 4.6' },
      { id: 'opus', label: 'Opus 4.6' },
      { id: 'haiku', label: 'Haiku 4.5' }
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

let currentProvider = 'anthropic';
let currentModel = process.env.OPENCLAUDE_MODEL || 'sonnet';

// --- OpenClaude CLI Subprocess (persistent stream-json mode) ---
let openclaudeProcess = null;
let pendingResolve = null;
let pendingReject = null;
let pendingTimeout = null;
let responseBuffer = '';
let assistantText = '';
let intentionalKill = false;
const OPENCLAUDE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per request

function spawnOpenClaude() {
  const provider = PROVIDERS[currentProvider];
  console.log(`[OpenClaude] Spawning: ${provider.label} / ${currentModel}`);

  const spawnEnv = { ...process.env, HOME: '/app', ...provider.env };

  const proc = spawn('openclaude', [
    '-p',
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--model', currentModel
  ], {
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
    if (pendingReject) {
      pendingReject(new Error(`OpenClaude process died (code=${code})`));
      pendingResolve = null;
      pendingReject = null;
      if (pendingTimeout) { clearTimeout(pendingTimeout); pendingTimeout = null; }
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
  } else if (msg.type === 'result') {
    // Turn complete — resolve the pending promise
    if (pendingResolve) {
      const text = assistantText || (msg.result || '');
      assistantText = '';
      if (pendingTimeout) { clearTimeout(pendingTimeout); pendingTimeout = null; }
      const resolve = pendingResolve;
      pendingResolve = null;
      pendingReject = null;
      if (msg.is_error) {
        console.error(`[OpenClaude] Turn error: ${text.substring(0, 200)}`);
        // Auth error → kill and respawn, reject so caller can retry
        if (text.includes('Not logged in') || text.includes('Please run /login')) {
          console.error('[OpenClaude] Auth error detected — killing process for respawn');
          intentionalKill = true;
          if (openclaudeProcess) openclaudeProcess.kill('SIGTERM');
          resolve('[ERROR:AUTH] Maximus se está reiniciando, intentá de nuevo en unos segundos.');
          return;
        }
      }
      console.log(`[OpenClaude] Response received (${text.length} chars)`);
      resolve(text);
    }
  }
}

async function callMaximus(userMessage, imageBase64 = null, imageMimeType = null) {
  if (!openclaudeProcess) {
    throw new Error('OpenClaude process not running');
  }
  if (pendingResolve) {
    throw new Error('OpenClaude is already processing a message');
  }

  // Inject memory context + current model info as prefix
  let contextPrefix = '';
  try {
    const ctx = memory.buildContext();
    if (ctx) contextPrefix = ctx + '\n\n---\n\n';
  } catch (e) {
    console.error('[Memory] buildContext error:', e.message);
  }
  const provLabel = PROVIDERS[currentProvider]?.label || currentProvider;
  const mdlInfo = PROVIDERS[currentProvider]?.models.find(m => m.id === currentModel);
  const mdlLabel = mdlInfo ? mdlInfo.label : currentModel;
  contextPrefix += `[Modelo actual: ${provLabel} / ${mdlLabel} (${currentModel})]\n\n`;

  // Build content
  let content;
  if (imageBase64) {
    content = [
      { type: 'image', source: { type: 'base64', media_type: imageMimeType, data: imageBase64 } },
      { type: 'text', text: contextPrefix + userMessage }
    ];
  } else {
    content = contextPrefix + userMessage;
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

    // Timeout safety
    pendingTimeout = setTimeout(() => {
      if (pendingReject) {
        const rej = pendingReject;
        pendingResolve = null;
        pendingReject = null;
        pendingTimeout = null;
        rej(new Error('OpenClaude response timeout (5 min)'));
      }
    }, OPENCLAUDE_TIMEOUT_MS);

    openclaudeProcess.stdin.write(JSON.stringify(inputMsg) + '\n');
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

  async complete() {
    this._stopTimers();
    for (const s of this.steps) { if (s.status !== 'done') s.status = 'done'; }
    try {
      if (this.messageId) {
        await this.bot.deleteMessage(this.chatId, this.messageId);
      }
    } catch (e) { /* message already deleted or too old */ }
  }

  async fail(errorMsg) {
    this._stopTimers();
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

// --- Message Handler ---
bot.on('message', async (msg) => {
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

      const inputAudio = path.join(TMP_DIR, `input_${timestamp}.oga`);
      const ttsRaw = path.join(TMP_DIR, `tts_raw_${timestamp}.ogg`);
      const ttsBoosted = path.join(TMP_DIR, `tts_boost_${timestamp}.ogg`);

      try {
        await downloadTelegramFile(fileId, inputAudio);

        await status.advance(); // → Transcribiendo
        const transcription = await transcribeAudio(inputAudio);
        if (!transcription || transcription.trim().length === 0) {
          await status.fail();
          bot.sendMessage(chatId, 'Mae, no logré entender el audio. ¿Podés repetirlo?');
          cleanup(inputAudio);
          return;
        }

        await status.advance(); // → Pensando
        const rawResponse = await callMaximus(`[Este mensaje viene de un audio de Jose] ${transcription}`);

        const formatMatch = rawResponse.match(/^\[(AUDIO|TEXTO)\]\s*/i);
        const outputFormat = formatMatch ? formatMatch[1].toUpperCase() : 'AUDIO';
        let responseText = rawResponse.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();

        try { responseText = memory.extractAndSaveMemories(responseText); } catch (memErr) { console.error('[Memory Extract Error]', memErr.message); }

        await status.advance(); // → Generando respuesta

        if (outputFormat === 'TEXTO') {
          await status.complete();
          await sendTextResponse(chatId, responseText);
          console.log(`[Maximus] Respuesta de audio transcrita -> texto enviado (${responseText.length} chars)`);
        } else {
          await textToSpeech(responseText, ttsRaw);
          await boostVolume(ttsRaw, ttsBoosted);
          await status.complete();
          await bot.sendVoice(chatId, ttsBoosted);
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

        const imgMessage = caption
          ? `[IMAGEN enviada por Jose] Caption: "${caption}". Respondé en base a lo que ves.`
          : '[IMAGEN enviada por Jose] Sin caption. Respondé en base a lo que ves en la imagen.';

        await status.advance(); // → Pensando
        const rawResponse = await callMaximus(imgMessage, imageBase64, mimeType);

        const formatMatch = rawResponse.match(/^\[(AUDIO|TEXTO)\]\s*/i);
        const outputFormat = formatMatch ? formatMatch[1].toUpperCase() : 'TEXTO';
        let responseText = rawResponse.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();

        try { responseText = memory.extractAndSaveMemories(responseText); } catch (memErr) { console.error('[Memory Extract Error]', memErr.message); }

        await status.advance(); // → Preparando respuesta

        if (outputFormat === 'AUDIO') {
          await textToSpeech(responseText, ttsRaw);
          await boostVolume(ttsRaw, ttsBoosted);
          await status.complete();
          await bot.sendVoice(chatId, ttsBoosted);
          console.log(`[Maximus] Voice note enviada (imagen)`);
        } else {
          await status.complete();
          await sendTextResponse(chatId, responseText);
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

// --- Handle text message (called after batching window) ---
async function handleTextMessage(chatId, text, timestamp) {
  const status = new StatusCard(bot, chatId);
  await status.init([
    ['📨', 'Recibido'],
    ['🧠', 'Pensando'],
    ['💬', 'Preparando respuesta'],
  ]);

  const ttsRaw = path.join(TMP_DIR, `tts_raw_${timestamp}.ogg`);
  const ttsBoosted = path.join(TMP_DIR, `tts_boost_${timestamp}.ogg`);

  try {
    await status.advance(); // → Pensando
    const rawResponse = await callMaximus(text);

    const formatMatch = rawResponse.match(/^\[(AUDIO|TEXTO)\]\s*/i);
    const outputFormat = formatMatch ? formatMatch[1].toUpperCase() : 'TEXTO';
    let responseText = rawResponse.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();

    try { responseText = memory.extractAndSaveMemories(responseText); } catch (memErr) { console.error('[Memory Extract Error]', memErr.message); }

    await status.advance(); // → Preparando respuesta

    if (outputFormat === 'AUDIO') {
      await textToSpeech(responseText, ttsRaw);
      await boostVolume(ttsRaw, ttsBoosted);
      await status.complete();
      await bot.sendVoice(chatId, ttsBoosted);
      console.log(`[Maximus] Voice note enviada (desde texto)`);
    } else {
      await status.complete();
      await sendTextResponse(chatId, responseText);
      console.log(`[Maximus] Respuesta enviada (${responseText.length} chars)`);
    }

    try { memory.saveExchange(text, responseText); } catch (memErr) { console.error('[Memory Error]', memErr.message); }
  } catch (err) {
    await status.fail(err.message);
    console.error(`[Error]`, err.message);
    bot.sendMessage(chatId, 'Mae, tuve un problema procesando tu mensaje. Intentá de nuevo en un momento.');
  } finally {
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
