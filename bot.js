require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { spawn, execFile } = require('child_process');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const https = require('https');
const memory = require('./memory');
const linear = require('./linear');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = parseInt(process.env.ALLOWED_USER_ID, 10);
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const SYSTEM_PROMPT_FILE = path.join(__dirname, 'system-prompt.txt');
const OPENCLAUDE_BIN = '/usr/local/bin/openclaude';
const TMP_DIR = path.join(__dirname, 'tmp');

// ElevenLabs config
const VOICE_ID = '7MbkkemMzdIlG5LyIhul';
const TTS_MODEL = 'eleven_v3';
const OUTPUT_FORMAT = 'opus_48000_128';
const VOICE_SETTINGS = {
  stability: 0.4,
  similarity_boost: 0.75,
  style: 0.5,
  use_speaker_boost: true
};

// OpenClaude timeout (5 minutes - long messages need more time)
const OPENCLAUDE_TIMEOUT_MS = 300000;

const bot = new TelegramBot(TOKEN, { polling: true });

// Initialize persistent memory system
memory.init();

console.log(`[Maximus Bot] Iniciado. Allowlist: ${ALLOWED_USER_ID}`);
console.log(`[Maximus Bot] Audio: ElevenLabs TTS/STT habilitado`);
console.log(`[Maximus Bot] Memoria persistente: habilitada`);

function isAllowed(msg) {
  return msg.from && msg.from.id === ALLOWED_USER_ID;
}

// --- Message Queue (process one message at a time) ---
const messageQueue = [];
let processing = false;

async function enqueueMessage(handler) {
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
    try {
      await handler();
    } catch (err) {
      console.error('[Queue Error]', err.message);
    }
  }
  processing = false;
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

// --- OpenClaude CLI (with real timeout) ---
function callOpenClaudeWithImage(userMessage, extraDirs = []) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--system-prompt-file', SYSTEM_PROMPT_FILE, '--no-session-persistence'];
    for (const dir of extraDirs) {
      args.push('--add-dir', dir);
    }
    args.push(userMessage);

    const child = spawn(OPENCLAUDE_BIN, args, {
      env: { ...process.env, CLAUDECODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    child.stdin.end();

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (e) { /* already dead */ }
      }, 5000);
    }, OPENCLAUDE_TIMEOUT_MS);

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error(`OpenClaude timed out after ${OPENCLAUDE_TIMEOUT_MS / 1000}s`));
        return;
      }
      if (stdout.trim()) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`OpenClaude exited ${code}: ${stderr.substring(0, 200)}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function callOpenClaude(userMessage) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--system-prompt-file', SYSTEM_PROMPT_FILE,
      '--no-session-persistence',
      userMessage
    ];

    const child = spawn(OPENCLAUDE_BIN, args, {
      env: { ...process.env, CLAUDECODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    child.stdin.end();

    let stdout = '';
    let stderr = '';
    let killed = false;

    // Real timeout: kill the process if it takes too long
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      // Force kill after 5 seconds if still alive
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (e) { /* already dead */ }
      }, 5000);
    }, OPENCLAUDE_TIMEOUT_MS);

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error(`OpenClaude timed out after ${OPENCLAUDE_TIMEOUT_MS / 1000}s`));
        return;
      }
      if (code !== 0) {
        console.error(`[OpenClaude Error] Exit code: ${code}`);
        reject(new Error(`OpenClaude exited with code ${code}: ${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      console.error(`[OpenClaude Spawn Error]`, err.message);
      reject(err);
    });
  });
}

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

// --- Send text response (handles chunking and markdown fallback) ---
async function sendTextResponse(chatId, responseText) {
  if (responseText.length > 4096) {
    const chunks = responseText.match(/[\s\S]{1,4096}/g);
    for (const chunk of chunks) {
      await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' }).catch(() => {
        bot.sendMessage(chatId, chunk);
      });
    }
  } else {
    await bot.sendMessage(chatId, responseText, { parse_mode: 'Markdown' }).catch(() => {
      bot.sendMessage(chatId, responseText);
    });
  }
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

      safeSendChatAction(chatId, 'record_voice');
      const typingInterval = setInterval(() => {
        safeSendChatAction(chatId, 'record_voice');
      }, 5000);

      const inputAudio = path.join(TMP_DIR, `input_${timestamp}.oga`);
      const ttsRaw = path.join(TMP_DIR, `tts_raw_${timestamp}.ogg`);
      const ttsBoosted = path.join(TMP_DIR, `tts_boost_${timestamp}.ogg`);

      try {
        await downloadTelegramFile(fileId, inputAudio);

        const transcription = await transcribeAudio(inputAudio);
        if (!transcription || transcription.trim().length === 0) {
          clearInterval(typingInterval);
          bot.sendMessage(chatId, 'Mae, no logré entender el audio. ¿Podés repetirlo?');
          cleanup(inputAudio);
          return;
        }

        const context = memory.buildContext();
        const enrichedMessage = context ? `${context}\n\n[Este mensaje viene de un audio de Jose] ${transcription}` : `[Este mensaje viene de un audio de Jose] ${transcription}`;
        const rawResponse = await callOpenClaude(enrichedMessage);

        const formatMatch = rawResponse.match(/^\[(AUDIO|TEXTO)\]\s*/i);
        const outputFormat = formatMatch ? formatMatch[1].toUpperCase() : 'AUDIO';
        let responseText = rawResponse.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();

        // Extract self-memories before sending to user
        try { responseText = memory.extractAndSaveMemories(responseText); } catch (memErr) { console.error('[Memory Extract Error]', memErr.message); }

        clearInterval(typingInterval);

        if (outputFormat === 'TEXTO') {
          await sendTextResponse(chatId, responseText);
          console.log(`[Maximus] Respuesta de audio transcrita -> texto enviado (${responseText.length} chars)`);
        } else {
          await textToSpeech(responseText, ttsRaw);
          await boostVolume(ttsRaw, ttsBoosted);
          await bot.sendVoice(chatId, ttsBoosted);
          console.log(`[Maximus] Voice note enviada`);
        }

        try { memory.saveExchange(transcription, responseText); } catch (memErr) { console.error('[Memory Error]', memErr.message); }

      } catch (err) {
        clearInterval(typingInterval);
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

      safeSendChatAction(chatId, 'typing');
      const typingInterval = setInterval(() => {
        safeSendChatAction(chatId, 'typing');
      }, 5000);

      const imgPath = path.join(TMP_DIR, `telegram_img_${timestamp}.jpg`);
      const ttsRaw = path.join(TMP_DIR, `tts_raw_${timestamp}.ogg`);
      const ttsBoosted = path.join(TMP_DIR, `tts_boost_${timestamp}.ogg`);

      try {
        // Get highest resolution photo
        const fileId = msg.photo
          ? msg.photo[msg.photo.length - 1].file_id
          : msg.document.file_id;

        await downloadTelegramFile(fileId, imgPath);

        const context = memory.buildContext();
        const imgMessage = [
          context || '',
          `[IMAGEN enviada por Jose]\n`,
          `La imagen está guardada en: ${imgPath}`,
          `Usá el Read tool para verla y analizarla.`,
          caption ? `\nCaption de Jose: "${caption}"` : '\nJose no escribió caption.',
          `\nRespondé en base a lo que ves en la imagen.`
        ].filter(Boolean).join('\n');

        const rawResponse = await callOpenClaudeWithImage(imgMessage, [TMP_DIR]);

        clearInterval(typingInterval);

        const formatMatch = rawResponse.match(/^\[(AUDIO|TEXTO)\]\s*/i);
        const outputFormat = formatMatch ? formatMatch[1].toUpperCase() : 'TEXTO';
        let responseText = rawResponse.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();

        try { responseText = memory.extractAndSaveMemories(responseText); } catch (memErr) { console.error('[Memory Extract Error]', memErr.message); }

        if (outputFormat === 'AUDIO') {
          await textToSpeech(responseText, ttsRaw);
          await boostVolume(ttsRaw, ttsBoosted);
          await bot.sendVoice(chatId, ttsBoosted);
          console.log(`[Maximus] Voice note enviada (imagen)`);
        } else {
          await sendTextResponse(chatId, responseText);
          console.log(`[Maximus] Texto enviado (imagen ${responseText.length} chars)`);
        }

        const saveText = caption ? `[Imagen con caption: "${caption}"]` : '[Imagen sin caption]';
        try { memory.saveExchange(saveText, responseText); } catch (memErr) { console.error('[Memory Error]', memErr.message); }

      } catch (err) {
        clearInterval(typingInterval);
        console.error(`[Image Error]`, err.message);
        bot.sendMessage(chatId, 'Mae, tuve un problema procesando la imagen. Intentá de nuevo.');
      } finally {
        cleanup(imgPath, ttsRaw, ttsBoosted);
      }
      return;
    }

    // --- TEXT MESSAGE FLOW ---
    const text = msg.text;
    if (!text) return;

    console.log(`[Jose] ${text}`);

    safeSendChatAction(chatId, 'typing');
    const typingInterval = setInterval(() => {
      safeSendChatAction(chatId, 'typing');
    }, 5000);

    const ttsRaw = path.join(TMP_DIR, `tts_raw_${timestamp}.ogg`);
    const ttsBoosted = path.join(TMP_DIR, `tts_boost_${timestamp}.ogg`);

    try {
      const context = memory.buildContext();
      const enrichedMessage = context ? `${context}\n\n[Este mensaje viene de texto de Jose] ${text}` : `[Este mensaje viene de texto de Jose] ${text}`;
      const rawResponse = await callOpenClaude(enrichedMessage);
      clearInterval(typingInterval);

      const formatMatch = rawResponse.match(/^\[(AUDIO|TEXTO)\]\s*/i);
      const outputFormat = formatMatch ? formatMatch[1].toUpperCase() : 'TEXTO';
      let responseText = rawResponse.replace(/^\[(AUDIO|TEXTO)\]\s*/i, '').trim();

      // Extract self-memories before sending to user
      try { responseText = memory.extractAndSaveMemories(responseText); } catch (memErr) { console.error('[Memory Extract Error]', memErr.message); }

      if (outputFormat === 'AUDIO') {
        await textToSpeech(responseText, ttsRaw);
        await boostVolume(ttsRaw, ttsBoosted);
        await bot.sendVoice(chatId, ttsBoosted);
        console.log(`[Maximus] Voice note enviada (desde texto)`);
      } else {
        await sendTextResponse(chatId, responseText);
        console.log(`[Maximus] Respuesta enviada (${responseText.length} chars)`);
      }

      try { memory.saveExchange(text, responseText); } catch (memErr) { console.error('[Memory Error]', memErr.message); }
    } catch (err) {
      clearInterval(typingInterval);
      console.error(`[Error]`, err.message);
      bot.sendMessage(chatId, 'Mae, tuve un problema procesando tu mensaje. Intentá de nuevo en un momento.');
    } finally {
      cleanup(ttsRaw, ttsBoosted);
    }
  });
});

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
