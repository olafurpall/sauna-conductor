// Narration cues: which messages a session needs, and their default text (English and Icelandic).
// Other languages start from the English text; "Write with AI" writes them in the chosen language.

export const LANGS = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'is', name: 'Icelandic', native: 'Íslenska' },
  { code: 'da', name: 'Danish', native: 'Dansk' },
  { code: 'sv', name: 'Swedish', native: 'Svenska' },
  { code: 'nb', name: 'Norwegian', native: 'Norsk' },
  { code: 'fi', name: 'Finnish', native: 'Suomi' },
  { code: 'de', name: 'German', native: 'Deutsch' },
  { code: 'pl', name: 'Polish', native: 'Polski' },
  { code: 'es', name: 'Spanish', native: 'Español' },
  { code: 'fr', name: 'French', native: 'Français' },
];
export const langOf = (code) => LANGS.find((l) => l.code === code) || LANGS[0];
export const hasBuiltInText = (code) => code === 'en' || code === 'is';

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const word = (n) => {
  if (n < 20) return WORDS[n] || String(n);
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + WORDS[n % 10] : '');
  return String(n);
};
const Word = (n) => { const w = word(n); return w[0].toUpperCase() + w.slice(1); };

// Icelandic number words, feminine (umferð and mínúta are feminine). nom = nominative, acc = accusative.
const IS_NUM = ['núll', 'ein', 'tvær', 'þrjár', 'fjórar', 'fimm', 'sex', 'sjö', 'átta', 'níu', 'tíu', 'ellefu', 'tólf',
  'þrettán', 'fjórtán', 'fimmtán', 'sextán', 'sautján', 'átján', 'nítján'];
const IS_TENS = ['', '', 'tuttugu', 'þrjátíu', 'fjörutíu', 'fimmtíu', 'sextíu', 'sjötíu', 'áttatíu', 'níutíu'];
const isNum = (n, acc = false) => {
  if (n === 1) return acc ? 'eina' : 'ein';
  if (n < 20) return IS_NUM[n] || String(n);
  if (n < 100) return IS_TENS[Math.floor(n / 10)] + (n % 10 ? ' og ' + (n % 10 === 1 ? (acc ? 'eina' : 'ein') : IS_NUM[n % 10]) : '');
  return String(n);
};
const IS_ORD = ['', 'fyrsta', 'önnur', 'þriðja', 'fjórða', 'fimmta', 'sjötta', 'sjöunda', 'áttunda'];
const isOrd = (n) => IS_ORD[n] || `${n}.`;
const cap1 = (t) => t[0].toUpperCase() + t.slice(1);
const isRounds = (n, acc) => `${isNum(n, acc)} ${n === 1 ? (acc ? 'umferð' : 'umferð') : 'umferðir'}`;
const isMinutes = (n) => (n === 1 ? 'eina mínútu' : `${isNum(n, true)} mínútur`);

// Ordered list of cues for a session with R rounds.
export function cuePlan(R) {
  R = Math.max(1, Math.min(8, R | 0));
  const out = [];
  for (let r = 1; r <= R; r++) {
    if (r === 1) out.push({ id: 'welcome', title: 'Welcome', when: 'Start of round 1' });
    else if (r === R) out.push({ id: 'final', title: 'Final round', when: `Start of round ${r} (the last one)` });
    else out.push({ id: 'round' + r, title: `Round ${r}`, when: `Start of round ${r}` });
    if (r < R) out.push({ id: 'end' + r, title: `Cool-down ${r}`, when: `End of round ${r}, as people step out` });
  }
  out.push({ id: 'closing', title: 'Closing', when: 'End of the session' });
  return out;
}

// Cue id that plays when a phase starts.
export function cueForRound(r, R) { return r === 1 ? 'welcome' : r === R ? 'final' : 'round' + r; }

// opts: { lang: 'en' | 'is' | …, host: name of the person leading the heat ('' = no name) }.
// Sessions made before version 3 have no host and keep their original text, which named Thora.
export function defaultText(id, R, roundMin = 15, opts = {}) {
  const lang = opts.lang || 'en';
  const host = opts.host === undefined ? 'Thora' : String(opts.host || '').trim();
  if (lang === 'is') return isText(id, R, roundMin, host);
  return enText(id, R, roundMin, host);
}

function enText(id, R, roundMin, host) {
  const legacy = host === 'Thora';
  if (id === 'welcome') {
    const guide = legacy
      ? `Your guide on this journey is Thora. She'll be guiding the heat, and she'll be looking out for every one of you. So trust her. Trust the music. And above all... listen to your body.`
      : host
        ? `Your guide on this journey is ${host}, who'll be leading the heat and looking out for every one of you. So trust your guide. Trust the music. And above all... listen to your body.`
        : `Trust the heat. Trust the music. And above all... listen to your body.`;
    return `Welcome, everybody. Come on in... find your spot, and let your shoulders drop.

We're going on a little mission together. ${R === 1 ? 'One round' : Word(R) + ' rounds'} in the heat, ${word(roundMin)} minutes each. In between, you'll step out, cool down, and come back to Earth for a few minutes... before we launch again.

${guide} If it tells you to step out, you step out. That's not quitting. That's wisdom.

One more thing. Time moves a little different in here. One hour in this room... might feel like seven years out there.

Alright. Close your eyes. Take one deep breath in... and let it go.

Round one. Let's begin.`;
  }

  if (id === 'final') return `Welcome back. This is it... the final round.

The Finns, who know a thing or two about this, have an old saying: in the sauna, you behave as you would in church. Quiet. Present. Grateful.

And here's something to think about. Next time you look up at the stars, remember that the light you're seeing left them a long, long time ago. It travelled all that way... just to land in your eyes. What you feel in here, this round... you get to carry that with you, too.

So give it everything you've got left. Last round. Let's fly.`;

  if (id === 'closing') return `And that's the mission. ${R === 1 ? 'One round' : Word(R) + ' rounds'}. You made it.

Take your time now. Cool down slowly, drink plenty of water, and don't rush back out into the world. It'll still be there.

${host ? `Give a big thank you to ${host} for guiding you through the heat.\n\n` : ''}Until next time... stay curious, stay warm... and take care of each other.`;

  if (id === 'round2') return `Welcome back. Find your seat... and let the heat find you.

There's an old story about a rancher out in West Texas. He'd been setting fence posts his whole life, and he used to say that the post that lasts isn't the one made from the hardest wood. It's the one you set the deepest. The wind comes, the storms come... and the deep one just stays.

So this round, don't fight the heat. Go deep. Breathe low, down into your belly. Slow in... and slow out.

Round two. Here we go.`;

  if (id === 'round3') return `Welcome back, crew.

You know the hardest part of a space mission? It's not the launch. It's coming home. A capsule hits the atmosphere at around twenty-five times the speed of sound, and the air around it turns to fire... thousands of degrees. And here's the thing. That fire is exactly what slows it down. Without the heat, there's no safe landing.

So whatever you brought in here today... the stress, the noise, the to-do list... let the heat slow it down.

Round three. Settle in.`;

  let m = id.match(/^round(\d+)$/);
  if (m) {
    const n = +m[1];
    return `Welcome back. Round ${word(n)}.

Settle in, find your breath, and let the heat do its work. Nothing to chase in here... nowhere else to be.

Round ${word(n)}. Let's go.`;
  }

  m = id.match(/^end(\d+)$/);
  if (m) {
    const k = +m[1];
    if (k === R - 1 && R > 2) return `Round ${word(k)}, done. One more to go.

Step out, cool down, drink some water... and get ready. The last one's always the best one.`;
    if (k * 2 === R) return `That's round ${word(k)}. Halfway there... and you're doing beautifully.

Head on out, cool off, and take a breath of that cold Icelandic air. We'll launch again in a few minutes.`;
    if (k === 1) return `And that's round one. Nice work, everybody.

Step out slow... no rushing. Cool down, drink some water, and let your heart come back to Earth. We'll see you back in here in a few minutes.`;
    return `That's round ${word(k)}. Beautiful work.

Step out slow, cool down, and drink some water. We'll see you back in here in a few minutes.`;
  }
  return '';
}

function isText(id, R, roundMin, host) {
  if (id === 'welcome') return `Verið öll hjartanlega velkomin. Komið ykkur fyrir... finnið ykkar stað og leyfið öxlunum að síga.

Í dag förum við saman í ${isRounds(R, true)} í hitanum, um ${isMinutes(roundMin)} hver. Á milli umferða farið þið út, kælið ykkur og safnið kröftum í nokkrar mínútur.

${host ? `${host} leiðir ykkur í gegnum hitann í dag og passar upp á ykkur öll. ` : ''}Hlustið á líkamann. Ef hann segir ykkur að fara út, þá farið þið út. Það er ekki uppgjöf... það er skynsemi.

Lokið augunum. Andið djúpt inn... og andið rólega frá ykkur.

Fyrsta umferð. Byrjum.`;

  if (id === 'final') return `Velkomin aftur. Nú er komið að því... síðasta umferðin.

Gefið ykkur hitanum á vald eina ferðina enn. Andið rólega, djúpt niður í magann... og verið hér og nú.

Síðasta umferð. Njótið hennar.`;

  if (id === 'closing') return `Og þar með er þessu lokið. ${cap1(isRounds(R, false))}... og þið kláruðuð þetta.

Gefið ykkur tíma núna. Kælið ykkur hægt, drekkið nóg af vatni og ekki flýta ykkur aftur út í daginn. Hann bíður eftir ykkur.

${host ? `Takk fyrir leiðsögnina í hitanum, ${host}.\n\n` : ''}Takk fyrir samveruna... farið vel með ykkur, og hvert annað.`;

  let m = id.match(/^round(\d+)$/);
  if (m) {
    const n = +m[1];
    return `Velkomin aftur. Finnið sætið ykkar... og leyfið hitanum að finna ykkur.

Komið ykkur fyrir, finnið andardráttinn og leyfið hitanum að vinna sitt verk. Hér þarf ekkert að elta... og hvergi annars staðar þarf að vera.

${cap1(isOrd(n))} umferð. Af stað.`;
  }

  m = id.match(/^end(\d+)$/);
  if (m) {
    const k = +m[1];
    if (k === R - 1 && R > 2) return `${cap1(isOrd(k))} umferð búin. Ein eftir.

Farið út, kælið ykkur og drekkið vatn... og verið tilbúin. Síðasta umferðin er alltaf sú besta.`;
    if (k * 2 === R) return `Þetta var ${isOrd(k)} umferðin. Við erum hálfnuð... og þið standið ykkur frábærlega.

Farið út, kælið ykkur og andið að ykkur svölu íslensku loftinu. Við byrjum aftur eftir nokkrar mínútur.`;
    if (k === 1) return `Og þar með er fyrsta umferðin búin. Vel gert, öll sömul.

Farið rólega út... ekkert stress. Kælið ykkur, drekkið vatn og leyfið hjartanu að róast. Við sjáumst hér aftur eftir nokkrar mínútur.`;
    return `${cap1(isOrd(k))} umferð búin. Vel gert.

Farið rólega út, kælið ykkur og drekkið vatn. Við sjáumst hér aftur eftir nokkrar mínútur.`;
  }
  return '';
}

export function defaultScript(R, roundMin = 15, opts = {}) {
  const s = {};
  for (const c of cuePlan(R)) s[c.id] = defaultText(c.id, R, roundMin, opts);
  return s;
}
