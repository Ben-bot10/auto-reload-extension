/* Refresh Radar — offscreen document.
 *
 * Two jobs:
 *  1. The clock. Timers inside a web page are throttled when its tab is hidden
 *     and stop entirely when the window is minimized. This document is not a
 *     tab, so its interval keeps ticking; it tells the worker which tabs are due
 *     and the worker reloads them with chrome.tabs.reload().
 *  2. Alert audio, which a service worker cannot play at all.
 */

/* ------------------------------------------------------------------ clock */

let deadlines = new Map();          // tabId -> timestamp
let lastTick = 0;

setInterval(loop, 250);

function loop() {
  const now = Date.now();
  const due = [];
  for (const [tabId, at] of deadlines) {
    if (at <= now) { due.push(tabId); deadlines.delete(tabId); }
  }
  if (due.length) chrome.runtime.sendMessage({ type: 'OC_FIRE', tabIds: due }).catch(() => {});

  if (now - lastTick >= 1000 && deadlines.size) {
    lastTick = now;
    const items = [];
    for (const [tabId, at] of deadlines) items.push({ tabId, remaining: Math.max(0, at - now) });
    chrome.runtime.sendMessage({ type: 'OC_TICK', items }).catch(() => {});
  }
}

/* --------------------------------------------------------------- keepalive */

let port = null;
function connect() {
  try {
    port = chrome.runtime.connect({ name: 'rr-keepalive' });
    port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 1000); });
  } catch (e) { setTimeout(connect, 2000); }
}
connect();

setInterval(() => {
  if (!port) return connect();
  try { port.postMessage({ ping: Date.now() }); } catch (e) { port = null; connect(); }
}, 20000);

chrome.runtime.sendMessage({ type: 'OC_READY' }).catch(() => {});

/* ---------------------------------------------------------------- messages */

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (!msg || msg.target !== 'offscreen') return;
  switch (msg.type) {
    case 'CLOCK_SYNC':
      deadlines = new Map((msg.items || []).map(i => [Number(i.tabId), Number(i.at)]));
      send({ ok: true, size: deadlines.size });
      break;
    case 'CLOCK_SET':
      deadlines.set(Number(msg.tabId), Number(msg.at));
      send({ ok: true });
      break;
    case 'CLOCK_CLEAR':
      deadlines.delete(Number(msg.tabId));
      send({ ok: true });
      break;
    case 'PLAY':
      play(msg.tone, Number(msg.repeat) || 1, num(msg.volume));
      send({ ok: true });
      break;
    case 'PLAY_FILE':
      playFile(msg.data, Number(msg.repeat) || 1, num(msg.volume));
      send({ ok: true });
      break;
    default:
      send({ ok: false });
  }
  return true;
});

/* ------------------------------------------------------------------ audio */

let ctx = null;
const num = (v) => (typeof v === 'number' ? Math.max(0, Math.min(1, v)) : 0.7);

const TONES = {
  beep:  [[880, 0.12, 'square']],
  ding:  [[1568, 0.09, 'sine'], [0, 0.04, 'sine'], [2093, 0.22, 'sine']],
  chime: [[988, 0.16, 'sine'], [1319, 0.18, 'sine'], [1568, 0.30, 'sine']],
  alarm: [[740, 0.14, 'sawtooth'], [0, 0.06, 'sine'], [740, 0.14, 'sawtooth'], [0, 0.06, 'sine'], [740, 0.22, 'sawtooth']],
  siren: [[600, 0.25, 'triangle'], [900, 0.25, 'triangle'], [600, 0.25, 'triangle'], [900, 0.25, 'triangle']]
};

async function play(tone, repeat, volume) {
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume();
  } catch (e) { return; }

  const steps = TONES[tone] || TONES.chime;
  let t = ctx.currentTime + 0.02;

  for (let r = 0; r < repeat; r++) {
    for (const [freq, dur, type] of steps) {
      if (freq > 0) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), t + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + dur + 0.02);
      }
      t += dur;
    }
    t += 0.18;
  }
}

function playFile(dataUrl, repeat, volume) {
  if (!dataUrl) return;
  let left = Math.max(1, repeat);
  const audio = new Audio(dataUrl);
  audio.volume = volume;
  audio.addEventListener('ended', () => {
    left--;
    if (left > 0) { audio.currentTime = 0; audio.play().catch(() => {}); }
  });
  audio.play().catch(() => {});
}
