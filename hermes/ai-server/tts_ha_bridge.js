#!/usr/bin/env node
/**
 * TTS Bridge — StackChan → Deepgram Aura 2 Álvaro (Home Assistant)
 * POST texto plano → WAV 16kHz mono.
 * Usa curl (probado) para tts_get_url + descarga, ffmpeg para convertir.
 */
const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const PORT = Number(process.env.PORT || 18002);
const HA_URL = process.env.HA_URL || 'http://homeassistant.local:8123';
const HA_TOKEN = process.env.HA_TOKEN || '';
const VOICE = process.env.VOICE || 'aura-2-alvaro-es';
const ENGINE = process.env.ENGINE || 'tts.deepgram_tts';

function log(...args) { console.log(`[tts-bridge ${new Date().toISOString()}]`, ...args); }

function curlJson(url, bodyObj, timeoutMs = 20000) {
  return execFileP('/usr/bin/curl', ['-s', '-m', String(timeoutMs / 1000), '-X', 'POST',
    '-H', `Authorization: Bearer ${HA_TOKEN}`, '-H', 'Content-Type: application/json',
    '-d', JSON.stringify(bodyObj), url], { maxBuffer: 2 * 1024 * 1024 })
    .then(({ stdout }) => JSON.parse(stdout));
}

function curlDownload(url, timeoutMs = 20000) {
  return execFileP('/usr/bin/curl', ['-s', '-m', String(timeoutMs / 1000),
    '-H', `Authorization: Bearer ${HA_TOKEN}`, url], { maxBuffer: 30 * 1024 * 1024 })
    .then(({ stdout }) => Buffer.from(stdout, 'binary'));
}

async function synth(text) {
  // 1. URL del mp3
  const { url } = await curlJson(`${HA_URL}/api/tts_get_url`, {
    engine_id: ENGINE, message: text, options: { voice: VOICE },
  });
  if (!url) throw new Error('tts_get_url sin url');
  // 2. Descargar mp3 (puede ser relativa)
  const mp3 = await curlDownload(url.startsWith('http') ? url : `${HA_URL}${url}`);
  // 3. A WAV 16k mono
  const { stdout } = await execFileP('/opt/homebrew/bin/ffmpeg', [
    '-y', '-loglevel', 'error', '-i', 'pipe:0',
    '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', '-f', 'wav', 'pipe:1',
  ], { input: mp3, maxBuffer: 30 * 1024 * 1024 });
  return stdout;
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
  let body = '';
  for await (const chunk of req) body += chunk;
  const text = body.trim();
  if (!text) { res.writeHead(400); return res.end('empty'); }
  try {
    const wav = await synth(text);
    log(`OK "${text.slice(0, 50)}" -> ${wav.length}B`);
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length });
    res.end(wav);
  } catch (e) {
    log('ERROR:', e.message);
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`TTS error: ${e.message}`);
  }
});

server.listen(PORT, '0.0.0.0', () => log(`Puente TTS (${VOICE}) en http://0.0.0.0:${PORT}`));
