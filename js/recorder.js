// "Use my recording": bring your own audio for a message, either as a file (MP3, M4A, WAV…)
// or recorded right here with the microphone.
// A microphone recording is tidied before it is used: silence trimmed from both ends, the level
// brought up to match the other messages, and saved as a WAV that every browser can play.
import { h, toast, pickFile } from './util.js';
import { stripTokens } from './tokens.js';

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|webm|flac)$/i;
const MAX_UPLOAD = 20 * 1024 * 1024;
const RATE = 32000;                       // mono 16-bit at 32 kHz: clear speech, about 64 KB a second
export const isAudioFile = (f) => !!f && (/^audio\//.test(f.type) || AUDIO_EXT.test(f.name || ''));
export const canRecord = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);

export function checkUpload(f) {
  if (!isAudioFile(f)) return 'That is not an audio file. Use an MP3, M4A or WAV file.';
  if (f.size > MAX_UPLOAD) return 'That file is too big (20 MB at most).';
  return '';
}

const fmtSec = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function pickMime() {
  const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];
  for (const t of types) { try { if (MediaRecorder.isTypeSupported(t)) return t; } catch { /* old browser */ } }
  return '';
}

// ---------------------------------------------------------------- tidying a recording
function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// Decoded audio → mono at RATE, trimmed and levelled. Returns { blob, durationMs } (throws if silent).
export async function tidy(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let decoded;
  try { decoded = await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { ctx.close && ctx.close(); }
  const frames = Math.max(1, Math.ceil(decoded.duration * RATE));
  const off = new OfflineAudioContext(1, frames, RATE);
  const src = off.createBufferSource();
  src.buffer = decoded; src.connect(off.destination); src.start();
  const mono = (await off.startRendering()).getChannelData(0);

  let peak = 0;
  for (let i = 0; i < mono.length; i++) { const a = Math.abs(mono[i]); if (a > peak) peak = a; }
  if (peak < 0.01) throw new Error('We didn’t hear anything. Check that the right microphone is on and try again.');
  // Trim quiet ends (in 10 ms steps), keeping a little air around the words.
  const thr = Math.max(0.015, peak * 0.06);
  const step = Math.round(RATE / 100);
  const loud = (i) => { for (let k = i; k < Math.min(i + step, mono.length); k++) if (Math.abs(mono[k]) > thr) return true; return false; };
  let a = 0, b = mono.length;
  while (a < mono.length && !loud(a)) a += step;
  while (b > a && !loud(Math.max(0, b - step))) b -= step;
  a = Math.max(0, a - Math.round(RATE * 0.15));
  b = Math.min(mono.length, b + Math.round(RATE * 0.25));
  const gain = Math.min(8, 0.9 / peak);
  const out = new Float32Array(b - a);
  for (let i = 0; i < out.length; i++) out[i] = mono[a + i] * gain;
  // Short fades so the cut never clicks.
  const fade = Math.min(out.length >> 1, Math.round(RATE * 0.01));
  for (let i = 0; i < fade; i++) { const f = i / fade; out[i] *= f; out[out.length - 1 - i] *= f; }
  return { blob: encodeWav(out, RATE), durationMs: Math.round((out.length / RATE) * 1000) };
}

// ---------------------------------------------------------------- the dialog
// Resolves with { blob, from: 'file' | 'mic', durationMs? } or null when cancelled.
// opts: { title, text (what to read out), maxSec, upload: false to only record }
export function chooseRecording(opts = {}) {
  const maxMs = (opts.maxSec || 120) * 1000;
  return new Promise((resolve) => {
    let stream = null, rec = null, chunks = [], raf = 0, timer = 0, analyser = null, actx = null;
    let result = null, previewUrl = null, settled = false;

    const body = h('div', { class: 'set-body rec-body' });
    const cancel = h('button', { class: 'small' }, 'Cancel');
    const dlg = h('dialog', { class: 'share-dlg rec-dlg', 'aria-label': opts.title || 'Use my recording' },
      h('div', { class: 'set-head' }, h('h2', {}, opts.title || 'Use my recording'), h('span', { class: 'spacer' }), cancel),
      body);
    document.body.append(dlg);
    dlg.showModal();

    const stopMic = () => {
      cancelAnimationFrame(raf); clearInterval(timer);
      if (rec && rec.state !== 'inactive') { try { rec.ondataavailable = null; rec.onstop = null; rec.stop(); } catch { /* ignore */ } }
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (actx) { try { actx.close(); } catch { /* ignore */ } }
      stream = null; rec = null; actx = null; analyser = null;
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      stopMic();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(null));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });

    const script = () => {
      const t = stripTokens(opts.text || '').replace(/\[[^\]\n]{1,40}\]\s*/g, '').trim();
      return t ? h('div', { class: 'rec-script' }, h('div', { class: 'label' }, 'Read this'), h('p', {}, t)) : null;
    };
    const msg = h('p', { class: 'muted small rec-msg', role: 'status' });

    // 1. Choose: a file or the microphone.
    function choose() {
      stopMic();
      body.innerHTML = '';
      const fileBtn = h('button', { class: 'rec-choice' }, h('span', { class: 'rec-ic', 'aria-hidden': 'true' }, '⬆︎'),
        h('span', {}, h('b', {}, 'Upload a file'), h('small', {}, 'MP3, M4A or WAV from your computer or phone')));
      const micBtn = h('button', { class: 'rec-choice' }, h('span', { class: 'rec-ic mic', 'aria-hidden': 'true' }, '●'),
        h('span', {}, h('b', {}, 'Record it now'), h('small', {}, canRecord() ? 'With your microphone, right here' : 'This browser can’t record. Upload a file instead.')));
      micBtn.disabled = !canRecord();
      fileBtn.hidden = opts.upload === false;
      fileBtn.addEventListener('click', async () => {
        const [f] = await pickFile('audio/*,.mp3,.m4a,.wav');
        if (!f) return;
        const err = checkUpload(f);
        if (err) { msg.textContent = err; return; }
        finish({ blob: f, from: 'file' });
      });
      micBtn.addEventListener('click', openMic);
      body.append(h('div', { class: 'rec-choices' }, fileBtn, micBtn), script(), msg);
    }

    // 2. The microphone is on: check the level, then record.
    async function openMic() {
      msg.textContent = 'Allow the microphone when your browser asks.';
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (settled) { stream.getTracks().forEach((t) => t.stop()); stream = null; return; }   // closed while asking
      } catch (e) {
        if (settled) return;
        msg.textContent = /NotAllowed|Permission/i.test(e.name || e.message)
          ? 'The microphone is blocked for this site. Allow it in the browser’s site settings (on iPhone: aA → Website Settings → Microphone), then try again.'
          : /NotFound/i.test(e.name) ? 'No microphone was found.' : 'The microphone could not be started: ' + (e.message || e.name);
        return;
      }
      const Ctx = window.AudioContext || window.webkitAudioContext;
      actx = new Ctx();
      if (actx.state === 'suspended') actx.resume().catch(() => {});   // iPhone: started outside the tap
      analyser = actx.createAnalyser(); analyser.fftSize = 1024;
      actx.createMediaStreamSource(stream).connect(analyser);
      ready();
    }

    const meter = () => {
      const bar = h('i');
      const wrap = h('div', { class: 'rec-meter', 'aria-hidden': 'true' }, bar);
      const data = new Float32Array(1024);
      const loop = () => {
        if (!analyser) return;
        analyser.getFloatTimeDomainData(data);
        let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const level = Math.min(1, Math.sqrt(sum / data.length) * 5);
        bar.style.width = Math.round(level * 100) + '%';
        raf = requestAnimationFrame(loop);
      };
      cancelAnimationFrame(raf); loop();
      return wrap;
    };

    function ready() {
      body.innerHTML = '';
      const start = h('button', { class: 'primary rec-go' }, '● Start recording');
      const back = h('button', { class: 'small ghost' }, '← Back');
      back.addEventListener('click', choose);
      start.addEventListener('click', () => { if (actx && actx.state === 'suspended') actx.resume().catch(() => {}); countdown(); });
      msg.textContent = 'Speak a few words to check the level. Recording starts after a 3-second count.';
      body.append(script(), meter(), h('div', { class: 'row rec-row' }, back, h('span', { class: 'spacer' }), start), msg);
    }

    function countdown() {
      body.innerHTML = '';
      const big = h('div', { class: 'rec-count' }, '3');
      body.append(script(), meter(), big);
      msg.textContent = '';
      let n = 3;
      timer = setInterval(() => {
        n--;
        if (n > 0) { big.textContent = String(n); return; }
        clearInterval(timer);
        record();
      }, 700);
    }

    function record() {
      body.innerHTML = '';
      const clock = h('div', { class: 'rec-clock' }, h('span', { class: 'rec-dot', 'aria-hidden': 'true' }), h('span', {}, '0:00'));
      const stop = h('button', { class: 'primary rec-go' }, '■ Stop');
      body.append(script(), meter(), clock, h('div', { class: 'row rec-row' }, h('span', { class: 'spacer' }), stop), msg);
      msg.textContent = '';
      chunks = [];
      const mime = pickMime();
      try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); } catch { rec = new MediaRecorder(stream); }
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      // Close the microphone before listening back (on iPhone an open microphone makes playback quiet).
      rec.onstop = () => { const blob = new Blob(chunks, { type: (rec && rec.mimeType) || mime || 'audio/webm' }); stopMic(); review(blob); };
      const t0 = Date.now();
      rec.start(250);
      timer = setInterval(() => {
        const ms = Date.now() - t0;
        clock.lastChild.textContent = fmtSec(ms);
        if (ms >= maxMs) { toast(`Recordings stop at ${Math.round(maxMs / 60000)} minutes.`); stop.click(); }
      }, 250);
      stop.addEventListener('click', () => { clearInterval(timer); stop.disabled = true; if (rec && rec.state !== 'inactive') rec.stop(); });
    }

    // 3. Listen back, then use it or try again.
    async function review(raw) {
      cancelAnimationFrame(raf);
      body.innerHTML = '';
      body.append(h('p', { class: 'muted' }, 'Tidying up the recording…'));
      try {
        result = await tidy(raw);
        if (settled) return;
      } catch (e) {
        if (settled) return;
        body.innerHTML = '';
        const again = h('button', { class: 'primary' }, 'Try again');
        again.addEventListener('click', openMic);
        body.append(h('p', {}, e.message || 'That recording could not be used.'), h('div', { class: 'row' }, h('span', { class: 'spacer' }), again));
        return;
      }
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(result.blob);
      const player = h('audio', { controls: true, src: previewUrl, class: 'rec-audio' });
      const again = h('button', { class: 'small' }, 'Record again');
      const use = h('button', { class: 'primary' }, 'Use this recording');
      again.addEventListener('click', () => { player.pause(); openMic(); });
      use.addEventListener('click', () => { player.pause(); finish({ blob: result.blob, from: 'mic', durationMs: result.durationMs }); });
      body.innerHTML = '';
      body.append(h('div', { class: 'label' }, `Your recording · ${fmtSec(result.durationMs)}`), player,
        h('p', { class: 'muted small' }, 'Quiet bits at the start and end were trimmed and the level evened out.'),
        h('div', { class: 'row rec-row' }, again, h('span', { class: 'spacer' }), use));
      player.play().catch(() => {});
    }

    choose();
  });
}
