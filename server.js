// server.js — Twilio <-> ElevenLabs with fast VAD + proper codecs + jitter buffer
import 'dotenv/config';
import express from 'express';
import twilio from 'twilio';
import WebSocket, { WebSocketServer } from 'ws';

/* ------------------ ENV ------------------ */
const {
  PORT = 3000,
  BASE_URL,                         // https public URL of THIS service (Railway)
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_CALLER_ID,                 // your Twilio number (+E.164)
  ELEVENLABS_AGENT_ID,              // public: agent_... ; private: UUID
  ELEVENLABS_API_KEY,               // required for private agents
  TEST_PHONE_NUMBER,                // optional default test target
  DEBUG_LOGS = 'false',             // 'true' to see more logs
  DEBUG_VAD = 'false',              // 'true' to log VAD start/stop
  TWILIO_EDGE = 'dublin',           // override with 'frankfurt' if you want
  TWILIO_REGION = 'ie1',            // stable IE routing
  OUT_JITTER_MS = '100',            // outbound EL->Twilio jitter buffer (ms)
  PREBUFFER_MS = '250',             // initial TTS prebuffer (ms)
} = process.env;

const DEBUG = (String(DEBUG_LOGS).toLowerCase() === 'true');
const DBG_VAD = (String(DEBUG_VAD).toLowerCase() === 'true');
const OUTBUF_MS = Math.max(0, parseInt(OUT_JITTER_MS, 10) || 0);
const PREFILL_MS = Math.max(0, parseInt(PREBUFFER_MS, 10) || 0);

const app = express();
app.use(express.json());
app.use(express.static('public'));

const VoiceResponse = twilio.twiml.VoiceResponse;
const client = twilio(
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  { edge: TWILIO_EDGE, region: TWILIO_REGION }
);

// Node 18 has global fetch; provide fallback if needed
const _fetch = (...args) =>
  (globalThis.fetch ? globalThis.fetch(...args) : import('node-fetch').then(({ default: f }) => f(...args)));

/* ------------------ AUDIO HELPERS ------------------ */

// μ-law byte -> PCM16 sample
function muLawDecodeByte(mu) {
  mu = ~mu & 0xff;
  const sign = mu & 0x80 ? -1 : 1;
  const exp = (mu >> 4) & 0x07;
  const mant = mu & 0x0f;
  let sample = ((mant << 4) + 0x08) << (exp + 3);
  sample -= 0x84; // bias
  return sign * sample;
}

// base64 μ-law -> Int16Array PCM (8 kHz)
function muLawB64ToPCM16(b64) {
  const u = Buffer.from(b64, 'base64');
  const out = new Int16Array(u.length);
  for (let i = 0; i < u.length; i++) out[i] = muLawDecodeByte(u[i]);
  return out;
}

// Linear resample Int16Array from inRate -> outRate
function resampleInt16(int16, inRate, outRate) {
  const inLen = int16.length;
  if (inLen === 0 || inRate === outRate) return int16;
  const outLen = Math.max(1, Math.floor(inLen * outRate / inRate));
  const out = new Int16Array(outLen);
  for (let j = 0; j < outLen; j++) {
    const srcPos = j * (inRate / outRate);
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, inLen - 1);
    const frac = srcPos - i0;
    out[j] = (int16[i0] * (1 - frac) + int16[i1] * frac) | 0;
  }
  return out;
}

// Int16Array -> base64 PCM16LE
function int16ToPCM16LEBase64(int16) {
  const buf = Buffer.alloc(int16.length * 2);
  for (let i = 0; i < int16.length; i++) buf.writeInt16LE(int16[i], i * 2);
  return buf.toString('base64');
}

// PCM16 sample -> μ-law byte (for Twilio playback)
function linearToMuLawSample(sample) {
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;
  const BIAS = 0x84, CLIP = 32635;
  let sign = (sample < 0) ? 0x80 : 0x00;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

// base64 PCM16LE @ any rate -> base64 μ-law @ 8k
function pcm16b64ToMuLaw8kB64_fromAnyRate(b64, inRate) {
  const pcm = Buffer.from(b64, 'base64');
  const inLen = Math.floor(pcm.length / 2);
  if (!inRate || inRate <= 0) inRate = 16000;
  const outLen = Math.max(1, Math.floor(inLen * 8000 / inRate));
  const out = Buffer.alloc(outLen);
  for (let j = 0; j < outLen; j++) {
    const srcPos = j * (inRate / 8000);
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, inLen - 1);
    const frac = srcPos - i0;
    const s0 = pcm.readInt16LE(i0 * 2);
    const s1 = pcm.readInt16LE(i1 * 2);
    const s  = (s0 * (1 - frac) + s1 * frac) | 0;
    out[j] = linearToMuLawSample(s);
  }
  return out.toString('base64');
}

// Simple RMS
function rms(int16) {
  let acc = 0;
  const n = int16.length || 1;
  for (let i = 0; i < n; i++) { const v = int16[i]; acc += v * v; }
  return Math.sqrt(acc / n);
}

/* ------------------ ROUTES ------------------ */

app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

// Click-to-call test endpoint (POST {to?})
app.post('/test/call', async (req, res) => {
  try {
    const target = (req.body?.to || TEST_PHONE_NUMBER || '').replace(/[^\d+]/g, '');
    if (!/^\+\d{7,15}$/.test(target)) {
      return res.status(400).json({ message: 'Use E.164 like +353851234567' });
    }
    if (!BASE_URL) return res.status(500).json({ message: 'Set BASE_URL to your production HTTPS domain' });
    if (!TWILIO_CALLER_ID) return res.status(500).json({ message: 'Set TWILIO_CALLER_ID' });

    const call = await client.calls.create({
      to: target,
      from: TWILIO_CALLER_ID,
      url: `${BASE_URL}/twiml`,
      method: 'POST'
    });

    if (DEBUG) console.log('📞 Outbound call SID:', call.sid);
    res.json({ message: `Calling ${target}…`, sid: call.sid });
  } catch (e) {
    console.error('❌ /test/call error:', e.message);
    res.status(500).json({ message: e.message });
  }
});

// TwiML → open a bidirectional stream
app.all('/twiml', (req, res) => {
  if (!BASE_URL) return res.status(500).send('Set BASE_URL');
  if (DEBUG) console.log('📡 Twilio fetched /twiml via', req.method);
  const vr = new VoiceResponse();
  vr.connect().stream({ url: `${BASE_URL.replace('https','wss')}/media` });
  res.type('text/xml').send(vr.toString());
});

/* ------------------ WS BRIDGE ------------------ */

const wss = new WebSocketServer({ noServer: true });
const server = app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on 0.0.0.0:${PORT}`));

// Accept /media even with query (?streamSid=...)
server.on('upgrade', (req, socket, head) => {
  const path = (req.url || '').split('?')[0];
  if (path === '/media') {
    if (DEBUG) console.log('🔌 WS upgrade for', req.url);
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', async (twilioWS) => {
  /* ---- Keep the Twilio WS alive ---- */
  const ka = setInterval(() => {
    try { if (twilioWS.readyState === WebSocket.OPEN) twilioWS.ping(); } catch {}
  }, 15000);
  twilioWS.on('close', () => clearInterval(ka));
  twilioWS.on('error', () => clearInterval(ka));

  // VAD state (fast + robust)
  let speaking = false;
  let lastVoiceMs = Date.now();
  let lastStartedAt = 0;
  let smooth = 0;
  const VOICE_ON_RMS  = 700;     // lower = more sensitive
  const VOICE_OFF_RMS = 300;
  const SILENCE_MS    = 400;     // quick stop for snappy replies
  const MAX_UTTERANCE_MS = 7000; // hard cut after very long speech
  const FALLBACK_MS      = 1200; // ensure we always send a stop
  const SMOOTH_A = 0.7;          // EMA smoothing factor

  let streamSid = null;
  let elOutFmt = 'pcm_16000';
  let elOutRate = 16000;

  /* ---- Outbound jitter buffer (EL -> Twilio) ---- */
  const FRAME_MS = 20;
  let outQueue = [];
  let pumpTimer = null;
  let buffering = false;
  let prebuffer = [];

  function startPump() {
    if (pumpTimer) return;
    pumpTimer = setInterval(() => {
      if (outQueue.length && twilioWS.readyState === WebSocket.OPEN) {
        const payloadB64 = outQueue.shift();
        twilioWS.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: payloadB64 }
        }));
      }
    }, FRAME_MS);
  }

  function sendToTwilio(payloadB64) {
    outQueue.push(payloadB64);
    if (outQueue.length * FRAME_MS >= OUTBUF_MS) startPump();
  }

  function startNewReply() {
    if (PREFILL_MS > 0) {
      buffering = true;
      prebuffer = [];
    } else {
      buffering = false;
      prebuffer = [];
    }
  }

  function handleTTSChunk(payloadB64) {
    if (buffering) {
      prebuffer.push(payloadB64);
      const bufferedMs = prebuffer.length * FRAME_MS;
      if (bufferedMs >= PREFILL_MS) {
        buffering = false;
        for (const f of prebuffer) sendToTwilio(f);
        prebuffer = [];
      }
    } else {
      sendToTwilio(payloadB64);
    }
  }

  /* ---- Open ElevenLabs WS ---- */
  async function openElevenLabsWS() {
    const id = ELEVENLABS_AGENT_ID || '';
    if (!id) throw new Error('ELEVENLABS_AGENT_ID missing');

    if (id.startsWith('agent_')) {
      return new WebSocket(`wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(id)}`);
    }
    if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY missing for private agent');
    const r = await _fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(id)}`,
      { headers: { 'xi-api-key': ELEVENLABS_API_KEY } }
    );
    if (!r.ok) throw new Error(`get-signed-url failed: ${r.status} ${await r.text()}`);
    const { signed_url } = await r.json();
    return new WebSocket(signed_url);
  }

  let elWS;
  try {
    elWS = await openElevenLabsWS();
  } catch (e) {
    console.error('❌ EL connect failed:', e.message);
    twilioWS.on('message', () => {}); // drain
    return;
  }

  /* ---- Keep EL WS alive ---- */
  elWS.on('open', () => {
    if (DEBUG) console.log('🎙️  ElevenLabs WS open');

    // We send PCM/16k upstream; ask EL to output PCM/16k (we will downsample to 8k μ-law for Twilio)
    const init = {
      type: 'conversation_initiation_client_data',
      conversation_config_override: {
        asr: { user_input_audio_format: 'pcm_16000' },
        tts: { agent_output_audio_format: 'pcm_16000' }
      }
    };
    try { elWS.send(JSON.stringify(init)); } catch {}

    // keepalive
    const elKA = setInterval(() => {
      try { if (elWS.readyState === WebSocket.OPEN) elWS.ping(); } catch {}
    }, 15000);
    elWS.on('close', () => clearInterval(elKA));
    elWS.on('error', () => clearInterval(elKA));
  });
  elWS.on('error', e => console.error('❌ ElevenLabs WS error:', e.message));
  elWS.on('close', () => { if (DEBUG) console.log('🛑 ElevenLabs WS closed'); });

  // EL -> Twilio (agent audio)
  elWS.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.type === 'conversation_initiation_metadata') {
        const meta = data.conversation_initiation_metadata_event || {};
        elOutFmt = meta.agent_output_audio_format || elOutFmt;
        const m = String(elOutFmt).match(/^pcm_(\d{4,5})$/);
        if (m) elOutRate = parseInt(m[1], 10);
        if (DEBUG) console.log('🎛️ EL formats:', {
          agent_output_audio_format: meta.agent_output_audio_format,
          user_input_audio_format: meta.user_input_audio_format
        });
        return;
      }

      if (data.type === 'agent_response') {
        // new reply is starting -> prebuffer first chunks
        startNewReply();
        return;
      }

      if (data.type === 'audio' && streamSid && twilioWS.readyState === WebSocket.OPEN) {
        const pcmB64 = data?.audio_event?.audio_base_64;
        if (!pcmB64) return;
        const ulawB64 = pcm16b64ToMuLaw8kB64_fromAnyRate(pcmB64, elOutRate || 16000);
        handleTTSChunk(ulawB64);
        return;
      }
    } catch { /* ignore non-JSON */ }
  });

  // Twilio -> EL (caller audio + VAD)
  twilioWS.on('message', (buf) => {
    try {
      const msg = JSON.parse(buf.toString());

      if (msg.event === 'start') {
        streamSid = msg.start?.streamSid || msg.streamSid || null;
        if (DEBUG) console.log('▶️ Twilio stream started', streamSid, msg.start?.mediaFormat);
        return;
      }

      if (msg.event === 'media' && msg.media?.payload) {
        // 1) Convert Twilio μ-law/8k -> PCM/16k for EL ASR
        const pcm8 = muLawB64ToPCM16(msg.media.payload);   // Int16 @ 8k
        const pcm16k = resampleInt16(pcm8, 8000, 16000);   // Int16 @ 16k
        const b64pcm = int16ToPCM16LEBase64(pcm16k);       // base64 PCM16LE

        if (elWS.readyState === WebSocket.OPEN) {
          elWS.send(JSON.stringify({ user_audio_chunk: b64pcm }));
        }

        // 2) VAD — EMA-smoothed RMS with fast stop + fallbacks
        const level = rms(pcm8);
        smooth = SMOOTH_A * smooth + (1 - SMOOTH_A) * level;

        const now = Date.now();
        if (smooth > VOICE_ON_RMS) {
          lastVoiceMs = now;
          if (!speaking) {
            try { elWS.send(JSON.stringify({ type: 'user_started_speaking' })); } catch {}
            speaking = true;
            lastStartedAt = now;
            if (DBG_VAD) console.log('🎤 VAD start');
          }
        } else {
          const silentFor = now - lastVoiceMs;
          const longSpeech = speaking && (now - lastStartedAt) > MAX_UTTERANCE_MS;
          if (speaking && (silentFor > SILENCE_MS || longSpeech)) {
            try { elWS.send(JSON.stringify({ type: 'user_stopped_speaking' })); } catch {}
            speaking = false;
            // next agent turn will start -> enable prebuffer
            startNewReply();
            if (DBG_VAD) console.log('🤫 VAD stop', longSpeech ? '(max utterance)' : '');
          }
        }

        // 3) Safety fallback
        if (!speaking && lastStartedAt && (now - lastVoiceMs) > FALLBACK_MS && (now - lastStartedAt) > 500) {
          try { elWS.send(JSON.stringify({ type: 'user_stopped_speaking' })); } catch {}
          lastStartedAt = 0;
          startNewReply();
          if (DBG_VAD) console.log('🛟 VAD forced stop');
        }

        return;
      }

      if (msg.event === 'stop') {
        if (speaking) {
          try { elWS.send(JSON.stringify({ type: 'user_stopped_speaking' })); } catch {}
        }
        if (DEBUG) console.log('⏹️ Twilio stream stopped');
        try { elWS.close(); } catch {}
        try { twilioWS.close(); } catch {}
        return;
      }
    } catch (e) {
      console.error('parse twilio msg', e.message);
    }
  });

  twilioWS.on('error', e => console.error('❌ Twilio WS error:', e.message));
  twilioWS.on('close', () => { try { elWS.close(); } catch {} });
});

/* ------------------ END ------------------ */
