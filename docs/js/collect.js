// The public recording page (record.html?i=<token>): someone the admin invited records the callouts
// for Sauna Conductor, with no account. Their name is filled in from the invitation; there is a short
// introduction, one line per callout (Record → Stop → Listen → Record again), their own lines at the
// bottom, an agreement to tick, and Send. Everything goes through the "collect" server function.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js?v=3.2-3eb3c514';
import { $, h, toast } from './util.js?v=3.2-3eb3c514';
import { tidy, canRecord } from './recorder.js?v=3.2-3eb3c514';

const MAX_MS = 30000;
const T = {
  en: {
    title: 'Record a few callouts',
    hi: (n) => `Hi ${n}!`,
    p1: (from) => `${from ? from + ' would' : 'We’d'} love to have your voice in Sauna Conductor, an app that runs guided sauna sessions: music from Spotify and a narrator who takes everyone through the rounds of heat and the cool-downs.`,
    p2: 'Your callouts, short lines like “Let’s do this!” or “Last song!”, play between and during the songs, so the people in the sauna hear you cheering them on.',
    how: 'It takes about five minutes. For each line: press Record, say it your way (the words are only a suggestion), press Stop, and listen. Want to change it? Just record it again. You can add lines of your own at the bottom. When everything is ready, press Send.',
    tip: 'Tip: a quiet room, the phone about a hand’s width from your mouth, and plenty of energy!',
    note: 'A note for you',
    name: 'Your name', nameHint: 'This is how your name shows next to your callouts in the app.',
    lines: 'The lines', linesHint: 'Say them in your own words. Short and punchy works best.',
    record: '● Record', stop: '■ Stop', play: '▶ Listen', stopPlay: '■ Stop', again: '↺ Record again', recorded: 'Recorded', sent: 'Sent', wait: 'One moment…',
    own: 'Your own lines', ownHint: 'Want to say something else? Write the words, then record them.', ownPh: 'e.g. “Breathe in deep!”', add: '+ Add a line', remove: 'Remove',
    consent: 'I agree that my recordings can be played in sauna sessions run with Sauna Conductor. I can ask for them to be removed at any time.',
    send: 'Send the recordings', sending: (i, n) => `Sending ${i} of ${n}…`, finishing: 'Finishing…',
    doneTitle: 'Thank you! 🙏', doneP: (n) => `${n} recording${n === 1 ? ' has' : 's have'} arrived. They’ll be played in sauna sessions with Sauna Conductor.`,
    doneAgain: 'You can open this link again to change or add recordings.', change: 'Change or add recordings',
    gone: 'This link doesn’t work any more. Ask the person who sent it to you for a new one.',
    mic: 'The microphone is blocked for this page. Allow it in the browser’s settings for this site (on iPhone: aA → Website Settings → Microphone) and try again.',
    noMic: 'This browser can’t record. Open the link in Safari or Chrome.',
    inApp: 'If recording doesn’t work here, open the link in Safari or Chrome.',
    needName: 'Write your name.', needConsent: 'Tick that you agree, then press Send.', needOne: 'Record at least one line first.',
    needWords: 'Write the words you said for each of your own lines.', failed: 'Sending didn’t work. Check the connection and try again.',
    tooLong: 'Recordings stop after 30 seconds.', silent: 'We didn’t hear anything. Check the microphone and try again.',
    unsent: 'You have recordings that haven’t been sent.', other: 'Íslenska',
  },
  is: {
    title: 'Taktu upp nokkur hvatningarorð',
    hi: (n) => `Hæ ${n}!`,
    p1: (from) => `${from ? from + ' langar' : 'Okkur langar'} að fá röddina þína í Sauna Conductor, app sem stýrir gufustundum: tónlist af Spotify og sögumaður sem leiðir fólk í gegnum heitu umferðirnar og kælipásurnar.`,
    p2: 'Hvatningarorðin þín, stuttar setningar eins og „Gerum þetta!“ eða „Síðasta lagið!“, spilast á milli laga og inni í þeim, svo fólkið í gufunni heyrir þig hvetja það áfram.',
    how: 'Þetta tekur um fimm mínútur. Fyrir hverja setningu: ýttu á Taka upp, segðu hana á þinn hátt (orðin eru bara tillaga), ýttu á Stöðva og hlustaðu. Viltu breyta? Taktu hana bara aftur upp. Neðst geturðu bætt við þínum eigin setningum. Þegar allt er tilbúið ýtirðu á Senda.',
    tip: 'Gott ráð: rólegt herbergi, síminn í lófabreidd frá munninum og nóg af orku!',
    note: 'Skilaboð til þín',
    name: 'Nafnið þitt', nameHint: 'Svona birtist nafnið þitt við upptökurnar í appinu.',
    lines: 'Setningarnar', linesHint: 'Segðu þær með þínum orðum. Stutt og kraftmikið virkar best.',
    record: '● Taka upp', stop: '■ Stöðva', play: '▶ Hlusta', stopPlay: '■ Stöðva', again: '↺ Taka aftur upp', recorded: 'Tekið upp', sent: 'Sent', wait: 'Augnablik…',
    own: 'Þínar eigin setningar', ownHint: 'Viltu segja eitthvað annað? Skrifaðu orðin og taktu þau upp.', ownPh: 'T.d. „Andið djúpt!“', add: '+ Bæta við setningu', remove: 'Fjarlægja',
    consent: 'Ég samþykki að upptökurnar mínar verði spilaðar í gufustundum sem haldnar eru með Sauna Conductor. Ég get beðið um að þeim verði eytt hvenær sem er.',
    send: 'Senda upptökurnar', sending: (i, n) => `Sendi ${i} af ${n}…`, finishing: 'Klára…',
    doneTitle: 'Takk fyrir! 🙏', doneP: (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'upptaka er komin' : 'upptökur eru komnar'} til skila. Þær verða spilaðar í gufustundum með Sauna Conductor.`,
    doneAgain: 'Þú getur opnað þessa slóð aftur til að breyta eða bæta við.', change: 'Breyta eða bæta við',
    gone: 'Þessi slóð virkar ekki lengur. Biddu þann sem sendi þér hana um nýja.',
    mic: 'Hljóðneminn er lokaður fyrir þessa síðu. Leyfðu hann í stillingum vafrans fyrir síðuna (á iPhone: aA → Stillingar vefsvæðis → Hljóðnemi) og reyndu aftur.',
    noMic: 'Þessi vafri getur ekki tekið upp. Opnaðu slóðina í Safari eða Chrome.',
    inApp: 'Ef upptakan virkar ekki hér, opnaðu slóðina í Safari eða Chrome.',
    needName: 'Skrifaðu nafnið þitt.', needConsent: 'Hakaðu við samþykkið og ýttu svo á Senda.', needOne: 'Taktu upp að minnsta kosti eina setningu fyrst.',
    needWords: 'Skrifaðu orðin sem þú sagðir við hverja af þínum eigin setningum.', failed: 'Það tókst ekki að senda. Athugaðu nettenginguna og reyndu aftur.',
    tooLong: 'Upptökur stoppa eftir 30 sekúndur.', silent: 'Ekkert heyrðist. Athugaðu hljóðnemann og reyndu aftur.',
    unsent: 'Þú átt upptökur sem hafa ekki verið sendar.', other: 'English',
  },
};

const token = new URLSearchParams(location.search).get('i') || '';
const main = $('#rc');
let L = T.is, lang = 'is';
let inv = null;
let rows = [];            // { key, text, when, custom, blob, ms, sent, state: 'empty'|'recording'|'wait'|'done'|'sent' }
let nameVal = '', consent = false, busy = false;

async function call(payload) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
    body: JSON.stringify({ token, ...payload }),
  });
  let j = null;
  try { j = await r.json(); } catch { /* not json */ }
  if (!r.ok) { const e = new Error((j && j.error && j.error.message) || `Error ${r.status}`); e.code = j && j.error && j.error.code; e.status = r.status; throw e; }
  return j;
}

const slugify = (s) => String(s || '').toLowerCase().replace(/þ/g, 'th').replace(/æ/g, 'ae').replace(/ð/g, 'd').replace(/ø/g, 'o')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 36).replace(/-$/, '');
const inApp = /Instagram|FBAN|FBAV|FB_IAB|Line\/|MicroMessenger/i.test(navigator.userAgent || '');

// ---------------------------------------------------------------- start
async function start() {
  if (!token) { showGone(); return; }
  try { inv = await call({ action: 'info' }); }
  catch (e) { if (e.status === 404) showGone(); else { main.innerHTML = ''; main.append(h('p', { class: 'rc-error' }, T.is.failed + ' / ' + T.en.failed)); } return; }
  setLang(inv.lang === 'is' ? 'is' : 'en', false);
  nameVal = inv.name || '';
  const sent = new Map((inv.sent || []).map((x) => [x.key, x]));
  rows = (inv.template || []).map((t) => ({ key: t.key, text: t.text, when: whenOf(t.key), custom: false, blob: null, ms: sent.has(t.key) ? sent.get(t.key).duration_ms : 0, state: sent.has(t.key) ? 'sent' : 'empty' }));
  for (const x of inv.sent || []) if (!rows.some((r) => r.key === x.key)) rows.push({ key: x.key, text: x.said, custom: true, blob: null, ms: x.duration_ms, state: 'sent' });
  if (inv.status === 'submitted' && (inv.sent || []).length) showDone((inv.sent || []).length);
  else render();
}
const WHEN = {
  en: { 'lets-start': 'Start of a round', 'getting-hot': 'Middle of a round', 'almost-there': 'Late in a round', 'one-minute-left': 'One minute before a round ends', 'last-song': 'When the last song of a round starts', done: 'When a round ends', 'final-done': 'End of the session', amazing: 'The very end' },
  is: { 'lets-start': 'Í byrjun umferðar', 'getting-hot': 'Um miðja umferð', 'almost-there': 'Seint í umferð', 'one-minute-left': 'Þegar ein mínúta er eftir af umferð', 'last-song': 'Þegar síðasta lag umferðar byrjar', done: 'Þegar umferð lýkur', 'final-done': 'Í lok gufustundarinnar', amazing: 'Alveg í lokin' },
};
const whenOf = (key) => (WHEN[lang] || WHEN.en)[key] || '';

function setLang(l, repaint = true) {
  lang = l; L = T[l];
  document.documentElement.lang = l;
  const b = $('#langToggle');
  b.hidden = false; b.textContent = L.other;
  for (const r of rows) if (!r.custom) r.when = whenOf(r.key);
  if (repaint) render();
}
$('#langToggle').addEventListener('click', () => setLang(lang === 'is' ? 'en' : 'is'));

function showGone() {
  main.innerHTML = '';
  main.append(h('div', { class: 'rc-card' }, h('h1', {}, '🔗'), h('p', {}, T.is.gone), h('p', { class: 'muted' }, T.en.gone)));
}

// ---------------------------------------------------------------- the page
function render() {
  main.innerHTML = '';
  const name = h('input', { type: 'text', value: nameVal, maxlength: 80, autocomplete: 'name', 'aria-label': L.name });
  name.addEventListener('input', () => { nameVal = name.value; });
  const ok = h('input', { type: 'checkbox', checked: consent });
  ok.addEventListener('change', () => { consent = ok.checked; });
  const send = h('button', { class: 'primary rc-send' }, L.send);
  send.addEventListener('click', submit);
  const addOwn = h('button', { class: 'small' }, L.add);
  addOwn.addEventListener('click', () => {
    rows.push({ key: '', text: '', custom: true, blob: null, ms: 0, state: 'empty' });
    render();
    const all = main.querySelectorAll('.rc-own input'); if (all.length) all[all.length - 1].focus();
  });
  main.append(
    h('section', { class: 'rc-card rc-intro' },
      h('h1', {}, L.title),
      h('p', { class: 'rc-hi' }, L.hi(nameVal || '')),
      h('p', {}, L.p1(inv.from)), h('p', {}, L.p2), h('p', {}, L.how),
      inv.note ? h('blockquote', { class: 'rc-note' }, h('div', { class: 'label' }, L.note), h('p', {}, inv.note)) : null,
      h('p', { class: 'muted small' }, L.tip),
      !canRecord() ? h('p', { class: 'rc-error' }, L.noMic) : inApp ? h('p', { class: 'muted small' }, L.inApp) : null),
    h('section', { class: 'rc-card' },
      h('label', { class: 'f rc-name' }, h('span', {}, L.name), name, h('small', { class: 'muted' }, L.nameHint))),
    h('section', { class: 'rc-card' },
      h('h2', {}, L.lines), h('p', { class: 'muted small' }, L.linesHint),
      h('div', { class: 'rc-rows' }, ...rows.filter((r) => !r.custom).map(rowEl))),
    h('section', { class: 'rc-card' },
      h('h2', {}, L.own), h('p', { class: 'muted small' }, L.ownHint),
      h('div', { class: 'rc-rows' }, ...rows.filter((r) => r.custom).map(rowEl)),
      h('div', { class: 'row' }, addOwn)),
    h('section', { class: 'rc-card rc-final' },
      h('label', { class: 'chk' }, ok, h('span', {}, L.consent)),
      h('div', { class: 'row' }, h('span', { class: 'rc-status muted small', role: 'status' }), h('span', { class: 'spacer' }), send)));
  paintSend();
}

function rowEl(r) {
  const el = h('div', { class: 'rc-row' + (r.custom ? ' rc-own' : ''), 'data-state': r.state });
  r.el = el;
  paintRow(r);
  return el;
}

const fmtS = (ms) => (ms / 1000).toFixed(1).replace('.', lang === 'is' ? ',' : '.') + ' s';

function paintRow(r) {
  const el = r.el;
  if (!el) return;
  el.dataset.state = r.state;
  el.innerHTML = '';
  let text;
  if (r.custom) {
    const inp = h('input', { type: 'text', value: r.text, placeholder: L.ownPh, maxlength: 120, 'aria-label': L.own });
    inp.addEventListener('input', () => { r.text = inp.value; });
    const rm = h('button', { class: 'small ghost rc-rm', title: L.remove, 'aria-label': L.remove }, '✕');
    rm.addEventListener('click', () => { if (rec && rec.row === r) stopRec(true); stopPlay(); rows = rows.filter((x) => x !== r); render(); });
    text = h('div', { class: 'rc-text' }, h('div', { class: 'row' }, inp, rm));
  } else {
    text = h('div', { class: 'rc-text' }, h('b', {}, r.text), r.when ? h('small', {}, r.when) : null);
  }
  const ctl = h('div', { class: 'rc-ctl' });
  const btn = (label, cls, fn) => { const b = h('button', { class: cls }, label); b.addEventListener('click', fn); return b; };
  if (r.state === 'recording') {
    ctl.append(h('span', { class: 'rc-live' }, h('span', { class: 'rec-dot', 'aria-hidden': 'true' }), h('span', { class: 'rc-time' }, '0:00')),
      btn(L.stop, 'primary rc-stop', () => stopRec()));
  } else if (r.state === 'wait') {
    ctl.append(h('span', { class: 'muted small' }, L.wait));
  } else if (r.state === 'done') {
    ctl.append(h('span', { class: 'rc-ok' }, `✓ ${L.recorded} · ${fmtS(r.ms)}`),
      btn(playing === r ? L.stopPlay : L.play, 'small', () => togglePlay(r)),
      btn(L.again, 'small ghost', () => startRec(r)));
  } else if (r.state === 'sent') {
    ctl.append(h('span', { class: 'rc-ok' }, `✓ ${L.sent}` + (r.ms ? ` · ${fmtS(r.ms)}` : '')), btn(L.again, 'small ghost', () => startRec(r)));
  } else {
    const b = btn(L.record, 'rc-rec', () => startRec(r));
    b.disabled = !canRecord();
    ctl.append(b);
  }
  el.append(text, ctl);
}

// ---------------------------------------------------------------- recording (one at a time)
// The microphone is opened for each take and closed right after it (on iPhone an open microphone
// makes playback quiet, and a mic left open after a call or app switch can go silent).
let rec = null;            // { mr, chunks, row, tick, stream } while recording
let starting = false;
let pending = null;        // the stop-and-tidy in progress
function pickMime() {
  for (const t of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm']) { try { if (MediaRecorder.isTypeSupported(t)) return t; } catch { /* old browser */ } }
  return '';
}
const closeMic = (stream) => { try { stream && stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ } };
function paintSend() { const b = main.querySelector('.rc-send'); if (b) b.disabled = busy || !!rec || !!pending || rows.some((r) => r.state === 'wait'); }

async function startRec(r) {
  if (busy || starting) return;
  starting = true;
  try {
    stopPlay();
    if (rec) await stopRec();
    if (pending) await pending;
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (e) { toast(/NotAllowed|Permission/i.test(e.name || e.message) ? L.mic : L.noMic, 8000); return; }
    const mime = pickMime();
    let mr;
    try {
      try { mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); } catch { mr = new MediaRecorder(stream); }
      const me = { mr, chunks: [], row: r, stream, tick: 0 };
      mr.ondataavailable = (e) => { if (e.data && e.data.size) me.chunks.push(e.data); };
      r.prev = { blob: r.blob, ms: r.ms, state: r.state };
      mr.start(250);
      rec = me;
      r.state = 'recording';
      paintRow(r); paintSend();
      const t0 = Date.now();
      me.tick = setInterval(() => {
        if (rec !== me) { clearInterval(me.tick); return; }
        const ms = Date.now() - t0;
        const t = r.el && r.el.querySelector('.rc-time');
        if (t) t.textContent = `0:${String(Math.floor(ms / 1000)).padStart(2, '0')}`;
        if (ms >= MAX_MS) { toast(L.tooLong); stopRec(); }
      }, 200);
    } catch (e) {
      closeMic(stream);
      if (r.prev) Object.assign(r, r.prev);
      paintRow(r);
      toast(L.noMic, 6000);
    }
  } finally { starting = false; }
}

function stopRec(discard = false) {
  const me = rec;
  if (!me) return pending || Promise.resolve();
  rec = null;
  clearInterval(me.tick);
  const r = me.row;
  pending = new Promise((resolve) => {
    me.mr.onstop = async () => {
      closeMic(me.stream);
      if (discard) { resolve(); return; }
      const raw = new Blob(me.chunks, { type: me.mr.mimeType || 'audio/webm' });
      r.state = 'wait'; paintRow(r); paintSend();
      try {
        const x = await tidy(raw);
        r.blob = x.blob; r.ms = x.durationMs; r.state = 'done';
      } catch (e) {
        toast(/hear anything/i.test(e.message || '') ? L.silent : (e.message || String(e)), 6000);
        Object.assign(r, r.prev || { state: 'empty' });
      }
      paintRow(r);
      resolve();
    };
    try { me.mr.stop(); } catch { closeMic(me.stream); resolve(); }
  }).finally(() => { pending = null; paintSend(); });
  return pending;
}
window.addEventListener('pagehide', () => { if (rec) stopRec(true); });
window.addEventListener('beforeunload', (e) => { if (!busy && rows.some((r) => r.blob) && !main.querySelector('.rc-done')) { e.preventDefault(); e.returnValue = L.unsent; } });

// ---------------------------------------------------------------- listening back
const audio = new Audio();
let playing = null, playUrl = null;
function stopPlay() {
  audio.pause();
  const r = playing; playing = null;
  if (playUrl) { URL.revokeObjectURL(playUrl); playUrl = null; }
  if (r) paintRow(r);
}
function togglePlay(r) {
  if (playing === r) { stopPlay(); return; }
  stopPlay();
  if (!r.blob) return;
  playUrl = URL.createObjectURL(r.blob);
  audio.src = playUrl;
  playing = r;
  audio.onended = () => stopPlay();
  audio.play().catch(() => stopPlay());
  paintRow(r);
}

// ---------------------------------------------------------------- sending
const b64 = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });

async function submit() {
  const status = main.querySelector('.rc-status');
  const say = (t) => { if (status) status.textContent = t; };
  if (busy || starting) return;
  if (rec) await stopRec();
  if (pending) await pending;
  nameVal = nameVal.trim();
  if (!nameVal) { toast(L.needName); main.querySelector('.rc-name input').focus(); return; }
  const keep = rows.filter((r) => r.blob || r.state === 'sent');
  if (!keep.length) { toast(L.needOne); return; }
  if (keep.some((r) => r.custom && !r.text.trim())) { toast(L.needWords); return; }
  if (!consent) { toast(L.needConsent); return; }
  // Keys for their own lines, from the words (never the same as another line's).
  const taken = new Set(rows.filter((r) => !r.custom || r.state === 'sent').map((r) => r.key));
  for (const r of rows) {
    if (!r.custom || r.key) continue;
    const base = slugify(r.text) || 'line';
    let k = base, n = 2;
    while (taken.has(k)) k = `${base}-${n++}`;
    r.key = k; taken.add(k);
  }
  busy = true;
  const send = main.querySelector('.rc-send'); if (send) send.disabled = true;
  const todo = keep.filter((r) => r.blob);
  try {
    let i = 0;
    for (const r of todo) {
      say(L.sending(++i, todo.length));
      await call({ action: 'upload', key: r.key, said: r.text.trim(), type: r.blob.type || 'audio/wav', duration_ms: r.ms, data: await b64(r.blob) });
      r.blob = null; r.state = 'sent'; paintRow(r);
    }
    say(L.finishing);
    const res = await call({ action: 'submit', name: nameVal, consent: true, keep: keep.map((r) => r.key) });
    busy = false;
    showDone(res.count);
  } catch (e) {
    busy = false;
    if (send) send.disabled = false;
    say('');
    toast(e.status === 404 ? L.gone : e.status && e.status < 500 ? e.message : L.failed, 8000);
  }
}

function showDone(n) {
  stopPlay();
  main.innerHTML = '';
  const change = h('button', { class: 'small' }, L.change);
  change.addEventListener('click', () => render());
  main.append(h('section', { class: 'rc-card rc-done' }, h('h1', {}, L.doneTitle), h('p', {}, L.doneP(n)), h('p', { class: 'muted' }, L.doneAgain), change));
  window.scrollTo(0, 0);
}

start();
