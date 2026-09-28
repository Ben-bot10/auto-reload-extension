/* Refresh Radar — background service worker.
 *
 * The countdown does NOT live in the page. Page timers are throttled hard when a
 * tab is hidden and frozen outright when the window is minimized, so the clock
 * runs in an offscreen document, the worker performs the reload with
 * chrome.tabs.reload(), and a chrome.alarms sweep is the backstop if either is
 * ever suspended. That is what lets a watch keep running while minimized.
 */

const DEFAULTS = {
  /* ---- interval ---- */
  refreshEnabled: true,
  intervalMode: 'fixed',       // fixed | random
  interval: 0.5,               // seconds; sub-second allowed, floor 0.2
  intervalMin: 20,
  intervalMax: 60,
  hardReload: false,
  noResubmit: false,           // reload as a fresh GET (avoids form re-post prompts)
  maxRefreshes: 0,             // 0 = unlimited
  onlyWhenHidden: false,
  pauseOnInteract: false,
  resumeAfter: 15,
  retryOnError: true,
  errorRetryDelay: 10,
  captchaPause: true,
  keepAwake: false,
  stopIfUrlChanges: false,
  preserveScroll: true,
  preserveForms: false,

  /* ---- timer ---- */
  startDelay: 0,
  startAt: '',
  stopAt: '',
  visualTimer: false,
  timerStyle: 'compact',       // compact | bar | dot | ring
  timerCorner: 'br',           // tl | tr | bl | br
  continuousTimer: false,      // don't restart the countdown when the page reloads

  /* ---- monitor ---- */
  monitorEnabled: true,
  mode: 'found',               // found | lost | change
  keywords: [],                // [{ value, type: auto|text|regex|css|xpath, enabled }]
  matchLogic: 'any',           // any | all
  caseSensitive: false,
  selector: '',                // monitored area
  selectorType: 'css',
  searchSource: false,
  liveWatch: true,
  liveDebounce: 800,           // ms to settle after DOM mutations
  rescanEvery: 500,            // ms — keep scanning between reloads (0 = off)
  postLoadDelay: 0,
  scanFrames: true,            // also look inside iframes (SPAs render there)
  deepScan: true,              // walk open shadow roots (web-component apps)

  /* ---- actions ---- */
  highlight: true,
  scrollToMatch: true,
  autoClick: false,
  autoClickTarget: '',
  autoClickNewTab: false,
  autoClickDelay: 500,
  flashPage: true,             // an in-page banner still shows if the OS blocks toasts
  scriptOnLoad: '',
  scriptOnMatch: '',

  /* ---- alerts ---- */
  notify: true,
  sticky: true,
  sound: true,
  soundTone: 'chime',          // beep | chime | alarm | siren | ding | custom
  soundRepeat: 3,
  volume: 0.7,
  focusTab: false,
  stopOnMatch: false,          // keep watching a queue after the first hit
  alertMode: 'edge',           // edge | reload | every
  alertCooldown: 30,           // seconds; minimum gap between alerts
  alertOnce: false,
  copyToClipboard: false,
  webhook: ''
};

const SETTINGS_DEFAULTS = {
  syncEnabled: false,
  templates: [],
  soundData: '',
  soundName: '',
  theme: 'dark'                // dark | light | auto
};

const DEFAULT_KEYWORDS = [
  'in stock', 'available now', 'add to cart', 'book now', 'appointment available'
];

const MAX_LOG = 300;

let state = null;
let loading = null;
const retryTimers = {};

/* ------------------------------------------------------------------ state */

async function load() {
  if (state) return state;
  if (loading) return loading;
  loading = (async () => {
    const raw = await chrome.storage.local.get(['sessions', 'pending', 'profiles', 'log', 'defaults', 'settings']);
    state = {
      sessions: raw.sessions || {},
      pending: raw.pending || [],          // watches waiting for their tab to come back
      profiles: (raw.profiles || []).map(p => Object.assign({}, p, { cfg: migrate(p.cfg) })),
      log: raw.log || [],
      defaults: migrate(raw.defaults || {}),
      settings: Object.assign({}, SETTINGS_DEFAULTS, raw.settings || {})
    };
    loading = null;
    return state;
  })();
  return loading;
}

/* v2 configs used a single query + matchType + element_* modes. */
function migrate(cfg) {
  const c = Object.assign({}, DEFAULTS, cfg || {});
  if (!Array.isArray(c.keywords)) c.keywords = [];

  if (cfg && cfg.query && !c.keywords.length) {
    const type = cfg.matchType === 'regex' ? 'regex' : 'text';
    const parts = (cfg.matchType === 'any' || cfg.matchType === 'all')
      ? String(cfg.query).split(/\s*[,\n]\s*/) : [String(cfg.query)];
    c.keywords = parts.filter(Boolean).map(v => ({ value: v, type, enabled: true }));
    if (cfg.matchType === 'all') c.matchLogic = 'all';
  }
  if (cfg && (cfg.mode === 'element_appear' || cfg.mode === 'element_gone') && cfg.selector) {
    c.keywords = c.keywords.concat([{ value: cfg.selector, type: cfg.selectorType === 'xpath' ? 'xpath' : 'css', enabled: true }]);
    c.selector = '';
  }
  const map = { appear: 'found', disappear: 'lost', element_appear: 'found', element_gone: 'lost', change: 'change' };
  if (cfg && map[cfg.mode]) c.mode = map[cfg.mode];
  if (!['found', 'lost', 'change'].includes(c.mode)) c.mode = 'found';
  delete c.query; delete c.matchType;
  return c;
}

/* At a half-second interval the worker would otherwise write to disk twice a
 * second forever. Coalesce routine writes; anything that must survive an
 * immediate crash (a match, start, stop) calls save(true). */
let saveTimer = null;
let savePending = false;

async function flush() {
  savePending = false;
  await chrome.storage.local.set({
    sessions: state.sessions, pending: state.pending, profiles: state.profiles,
    log: state.log, defaults: state.defaults, settings: state.settings
  });
  if (state.settings.syncEnabled) pushSync();
}

function save(immediate) {
  if (immediate) {
    clearTimeout(saveTimer);
    saveTimer = null;
    return flush();
  }
  savePending = true;
  if (!saveTimer) {
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (savePending) flush();
    }, 2000);
  }
  return Promise.resolve();
}

let syncTimer = null;
function pushSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    const light = Object.assign({}, state.settings);
    delete light.soundData;
    chrome.storage.sync.set({
      defaults: state.defaults, profiles: state.profiles, settings: light, syncedAt: Date.now()
    }).catch(() => {});
  }, 900);
}

async function pullSync() {
  try {
    const s = await chrome.storage.sync.get(['defaults', 'profiles', 'settings']);
    if (!s || !s.defaults) return false;
    state.defaults = migrate(s.defaults);
    state.profiles = Array.isArray(s.profiles) ? s.profiles.map(p => Object.assign({}, p, { cfg: migrate(p.cfg) })) : state.profiles;
    state.settings = Object.assign({}, state.settings, s.settings || {}, { syncEnabled: true });
    await chrome.storage.local.set({ defaults: state.defaults, profiles: state.profiles, settings: state.settings });
    return true;
  } catch (e) { return false; }
}

function newSession(tabId, url, cfg) {
  return {
    tabId, url, active: true, paused: false,
    cfg: migrate(cfg),
    baseline: null, alerted: false, note: '', nextAt: 0,
    condTrue: false,      // is the watched condition currently satisfied?
    frameTrueAt: 0,       // last time a sub-frame said yes
    lastAlertAt: 0, lastAlertKey: '', lastScanAt: 0, recovered: 0, notifyFailed: 0,
    stats: { loads: 0, refreshes: 0, matches: 0, errors: 0, startedAt: Date.now(), lastMatchAt: 0, lastExcerpt: '' }
  };
}

/* ------------------------------------------------------------- utilities */

const parseWhen = (v) => { if (!v) return 0; const t = new Date(v).getTime(); return isNaN(t) ? 0 : t; };

const FLOOR_SECS = 0.2;

function baseDelayMs(cfg, first) {
  if (first && cfg.startDelay > 0) return Math.max(FLOOR_SECS, cfg.startDelay) * 1000;
  let secs;
  if (cfg.intervalMode === 'random') {
    const lo = Math.max(FLOOR_SECS, Math.min(cfg.intervalMin, cfg.intervalMax));
    const hi = Math.max(FLOOR_SECS, Math.max(cfg.intervalMin, cfg.intervalMax));
    secs = lo + Math.random() * (hi - lo);
  } else {
    secs = Math.max(FLOOR_SECS, Number(cfg.interval) || 0.5);
  }
  return Math.round(secs * 1000);
}

function reloadBudget(sess, firstLoad) {
  const cfg = sess.cfg;
  if (!cfg.refreshEnabled) return null;
  if (cfg.maxRefreshes > 0 && sess.stats.refreshes >= cfg.maxRefreshes) return null;

  const now = Date.now();
  const stopAt = parseWhen(cfg.stopAt);
  if (stopAt && now >= stopAt) return null;

  let ms = baseDelayMs(cfg, firstLoad && sess.stats.loads === 1);
  const startAt = parseWhen(cfg.startAt);
  if (startAt && now < startAt) ms = Math.max(ms, startAt - now);
  if (stopAt && now + ms > stopAt) return null;
  return ms;
}

const hostOf = (url) => { try { return new URL(url).hostname; } catch (e) { return url || ''; } };

function matchesPattern(pattern, url) {
  const p = (pattern || '').trim();
  if (!p) return false;
  if (p.startsWith('/') && p.lastIndexOf('/') > 0) {
    const last = p.lastIndexOf('/');
    try { return new RegExp(p.slice(1, last), p.slice(last + 1)).test(url); } catch (e) { return false; }
  }
  if (p.includes('*')) {
    const rx = new RegExp('^' + p.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    return rx.test(url);
  }
  return url.includes(p) || hostOf(url) === p;
}

async function setBadge(tabId, text, color) {
  try {
    await chrome.action.setBadgeText({ tabId, text: text || '' });
    if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color: color || '#10b981' });
  } catch (e) {}
}

function fmtCountdown(ms) {
  if (ms > 0 && ms < 1000) return '<1';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 100) return String(s);
  const m = Math.floor(s / 60);
  return m < 100 ? m + 'm' : '99+';
}

/* Two URLs that mean "the same page" even if query params drift. */
function sameTarget(a, b) {
  try {
    const x = new URL(a), y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch (e) { return a === b; }
}

const PENDING_TTL = 36 * 60 * 60 * 1000;       // give up after a day and a half

function park(sess, why) {
  if (!sess || !sess.active) return;
  sess.pendingSince = Date.now();
  sess.note = why || 'waiting for the tab to come back';
  state.pending = (state.pending || []).filter(p => !sameTarget(p.url, sess.url));
  state.pending.push(sess);
  if (state.pending.length > 30) state.pending.shift();
}

/* A parked watch re-attaches itself as soon as a matching page loads again —
 * after a window close, a browser restart or a reboot with session restore. */
async function adopt(tab) {
  if (!tab || !tab.url || !/^https?:/.test(tab.url)) return false;
  if (state.sessions[tab.id] && state.sessions[tab.id].active) return false;
  const list = state.pending || [];
  const now = Date.now();
  let idx = list.findIndex(p => p.url === tab.url);
  if (idx < 0) idx = list.findIndex(p => sameTarget(p.url, tab.url));
  if (idx < 0) return false;

  const sess = list[idx];
  if (now - (sess.pendingSince || now) > PENDING_TTL) { list.splice(idx, 1); await save(); return false; }

  list.splice(idx, 1);
  sess.tabId = tab.id;
  sess.url = tab.url;
  sess.active = true;
  sess.paused = false;
  sess.note = 'resumed after the tab came back';
  sess.recovered = (sess.recovered || 0) + 1;
  const d = reloadBudget(sess, false);
  sess.nextAt = d === null ? 0 : now + d;
  state.sessions[tab.id] = sess;

  updatePower();
  await save(true);
  await armClock();
  await setBadge(tab.id, 'ON', '#10b981');
  await kick(tab.id);
  return true;
}

function updatePower() {
  if (!chrome.power) return;
  const want = Object.values(state.sessions).some(s => s.active && !s.paused && s.cfg.keepAwake);
  try { want ? chrome.power.requestKeepAwake('system') : chrome.power.releaseKeepAwake(); } catch (e) {}
}

/* ------------------------------------------------- offscreen clock + audio */

let offscreenPending = null;

async function ensureOffscreen() {
  if (!chrome.offscreen) return false;
  try { if (await chrome.offscreen.hasDocument()) return true; } catch (e) {}
  if (!offscreenPending) {
    offscreenPending = chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Run the refresh countdown reliably and play alert sounds.'
    }).catch(() => {});
  }
  await offscreenPending;
  offscreenPending = null;
  return true;
}

function toOffscreen(msg) {
  return chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, msg)).catch(() => {});
}

/* The clock lives in the offscreen document, and Chrome can reclaim it. If its
 * heartbeat goes quiet while work is outstanding, rebuild it — otherwise the
 * watch stalls until the once-a-minute alarm notices, which at a half-second
 * interval is an eternity. */
let lastClockBeat = 0;

async function ensureClockAlive() {
  const busy = Object.values(state.sessions).some(s => s.active && !s.paused && s.nextAt);
  if (!busy) return;
  let has = false;
  try { has = await chrome.offscreen.hasDocument(); } catch (e) {}
  const quiet = lastClockBeat && Date.now() - lastClockBeat > 8000;
  if (!has || quiet) {
    if (!has) {
      for (const s of Object.values(state.sessions)) {
        if (s.active && !s.paused) s.recovered = (s.recovered || 0) + 1;
      }
    }
    await ensureOffscreen();
    await armClock();
    lastClockBeat = Date.now();
  }
}

/* Push every live deadline to the clock. Called after any state change and
 * whenever the worker wakes up, so the clock and the worker cannot drift. */
async function armClock() {
  const items = [];
  for (const [id, s] of Object.entries(state.sessions)) {
    if (s.active && !s.paused && s.nextAt) items.push({ tabId: Number(id), at: s.nextAt });
  }
  if (!items.length) { await toOffscreen({ type: 'CLOCK_SYNC', items: [] }); return; }
  await ensureOffscreen();
  await toOffscreen({ type: 'CLOCK_SYNC', items });
}

async function playSound(cfg) {
  await ensureOffscreen();
  const custom = cfg.soundTone === 'custom' && state.settings.soundData;
  await toOffscreen({
    type: custom ? 'PLAY_FILE' : 'PLAY',
    data: custom ? state.settings.soundData : undefined,
    tone: cfg.soundTone,
    repeat: Math.max(1, Number(cfg.soundRepeat) || 1),
    volume: Math.max(0, Math.min(1, Number(cfg.volume)))
  });
}

/* --------------------------------------------------------------- reloading */

const reloading = {};   // guards against the clock and the sweep firing together

async function doReload(tabId) {
  await load();
  const sess = state.sessions[tabId];
  if (!sess || !sess.active || sess.paused) return;
  /* Guards only against the clock and the sweep firing the same deadline at
   * the same instant — it must stay well under the shortest usable interval,
   * and it must re-arm rather than leaving the session with a stale deadline. */
  const guard = Math.min(200, Math.max(50, baseDelayMs(sess.cfg, false) / 3));
  if (reloading[tabId] && Date.now() - reloading[tabId] < guard) {
    sess.nextAt = Date.now() + baseDelayMs(sess.cfg, false);
    await save();
    await armClock();
    return;
  }
  reloading[tabId] = Date.now();

  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (e) {
    /* The tab is gone — after a restart its id is stale. Park the watch so it
     * can re-attach instead of disappearing without a word. */
    delete state.sessions[tabId];
    park(sess, 'tab closed — will resume if it reopens');
    updatePower();
    await save(true);
    await armClock();
    return;
  }

  if (sess.cfg.onlyWhenHidden && tab.active) {          // you're looking at it — wait
    sess.nextAt = Date.now() + 2000;
    await save();
    await armClock();
    return;
  }

  try {
    if (sess.cfg.noResubmit || tab.discarded) {
      // A fresh navigation: no "confirm form resubmission", and it revives a
      // tab Chrome discarded to save memory.
      await chrome.tabs.update(tabId, { url: sess.url || tab.url });
    } else {
      await chrome.tabs.reload(tabId, { bypassCache: !!sess.cfg.hardReload });
    }
  } catch (e) {}

  /* Provisional next deadline, refined by the page's REPORT when it lands. It
   * has to allow a little slack for the load itself, but never so much that it
   * overrides a deliberately short interval. */
  const base = baseDelayMs(sess.cfg, false);
  sess.nextAt = Date.now() + Math.max(base, Math.min(3000, base * 4));
  await save();
  await armClock();
}

function scheduleRetry(tabId, secs) {
  clearTimeout(retryTimers[tabId]);
  retryTimers[tabId] = setTimeout(() => doReload(tabId), Math.max(1, Number(secs) || 10) * 1000);
  load().then(() => {
    const s = state.sessions[tabId];
    if (s) { s.nextAt = Date.now() + Math.max(1, Number(secs) || 10) * 1000; save().then(armClock); }
  });
}

/* ---------------------------------------------------------------- alerts */

const notifTab = {};

async function raiseAlert(sess, payload) {
  const cfg = sess.cfg;
  const when = Date.now();
  sess.stats.matches++;
  sess.stats.lastMatchAt = when;
  sess.stats.lastExcerpt = payload.excerpt || '';
  sess.alerted = true;

  state.log.unshift({
    when, url: sess.url, title: payload.title || sess.url,
    excerpt: payload.excerpt || '', mode: cfg.mode,
    query: (cfg.keywords || []).map(k => k.value).join(', ')
  });
  if (state.log.length > MAX_LOG) state.log.length = MAX_LOG;

  let notified = false;
  if (cfg.notify) {
    const id = 'rr-' + when + '-' + sess.tabId;
    notifTab[id] = sess.tabId;
    try {
      const made = await chrome.notifications.create(id, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Match: ' + (payload.title || hostOf(sess.url)),
        message: (payload.excerpt || '').slice(0, 240) || describeMode(cfg),
        contextMessage: hostOf(sess.url),
        priority: 2, requireInteraction: !!cfg.sticky, silent: false
      });
      notified = !!made;
    } catch (e) { notified = false; }
    if (!notified) sess.notifyFailed = (sess.notifyFailed || 0) + 1;
  }

  /* Windows Focus Assist, Do Not Disturb or a denied permission swallow toasts
   * silently. The in-page banner does not depend on the OS, so it is the
   * fallback whenever the toast could not be created. */
  if (cfg.flashPage || (cfg.notify && !notified)) {
    chrome.tabs.sendMessage(sess.tabId, {
      type: 'RR_BANNER', text: payload.excerpt || describeMode(cfg),
      warn: cfg.notify && !notified
    }, { frameId: 0 }).catch(() => {});
  }

  if (cfg.sound) playSound(cfg);

  if (cfg.focusTab) {
    try {
      const tab = await chrome.tabs.get(sess.tabId);
      await chrome.tabs.update(sess.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true, state: 'normal' });
    } catch (e) {}
  }

  if (cfg.webhook) {
    fetch(cfg.webhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'refresh-radar.match', url: sess.url, title: payload.title || '',
        excerpt: payload.excerpt || '', mode: cfg.mode,
        keywords: (cfg.keywords || []).map(k => k.value), at: new Date(when).toISOString()
      })
    }).catch(() => {});
  }

  if (cfg.copyToClipboard) {
    chrome.tabs.sendMessage(sess.tabId, { type: 'RR_COPY', text: payload.excerpt || '' }).catch(() => {});
  }

  await setBadge(sess.tabId, 'HIT', '#ef4444');
}

function describeMode(cfg) {
  const words = (cfg.keywords || []).map(k => k.value).join(', ');
  if (cfg.mode === 'change') return 'Page content changed';
  return cfg.mode === 'lost' ? 'No longer on the page: ' + words : 'Found: ' + words;
}

async function notifyPlain(title, message, tabId) {
  const id = 'rr-info-' + Date.now();
  if (tabId != null) notifTab[id] = tabId;
  try {
    await chrome.notifications.create(id, {
      type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title, message, priority: 2
    });
  } catch (e) {}
}

chrome.notifications.onClicked.addListener(async (id) => {
  const tabId = notifTab[id];
  chrome.notifications.clear(id);
  if (tabId == null) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true, state: 'normal' });
  } catch (e) {}
});
chrome.notifications.onClosed.addListener((id) => { delete notifTab[id]; });

/* ------------------------------------------------------------- messaging */

/* Reports from the page (and its frames) can arrive at the same moment. Without
 * this, two of them both see an active session and both raise an alert — which
 * is how one match turns into a burst of notifications. One queue per tab. */
const queues = {};
function serial(key, fn) {
  const prev = queues[key] || Promise.resolve();
  const next = prev.then(fn, fn);
  queues[key] = next.then(() => {}, () => {});
  return next;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;
  const id = (sender && sender.tab) ? sender.tab.id : msg.tabId;
  serial(id == null ? 'global' : 't' + id, () => handle(msg, sender))
    .then(sendResponse)
    .catch((e) => sendResponse({ error: String(e) }));
  return true;
});

/* The offscreen document holds this port open, which keeps the worker alive
 * while anything is being watched. */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'rr-keepalive') return;
  port.onMessage.addListener(async () => {
    lastClockBeat = Date.now();
    await load();
    await sweep();
  });
  port.onDisconnect.addListener(() => { load().then(armClock); });
});

async function handle(msg, sender) {
  await load();
  const tabId = sender && sender.tab ? sender.tab.id : msg.tabId;

  switch (msg.type) {

    /* --------------------------------------------------- clock callbacks */

    case 'OC_FIRE': {
      lastClockBeat = Date.now();
      for (const id of msg.tabIds || []) await doReload(Number(id));
      return { ok: true };
    }

    case 'OC_PING': { lastClockBeat = Date.now(); return { ok: true }; }

    case 'OC_TICK': {
      lastClockBeat = Date.now();
      for (const it of msg.items || []) {
        const s = state.sessions[it.tabId];
        if (!s || !s.active) continue;
        await setBadge(it.tabId, s.paused ? '||' : fmtCountdown(it.remaining), s.paused ? '#f59e0b' : '#10b981');
      }
      return { ok: true };
    }

    case 'OC_READY': { await armClock(); return { ok: true }; }

    /* ------------------------------------------------------- page engine */

    case 'CS_INIT': {
      let sess = state.sessions[tabId];

      /* A sub-frame joins an existing watch; it never starts one, never counts
       * as a page load and never triggers the navigation rules below. */
      if (msg.frame) {
        if (!sess || !sess.active || sess.paused) return { active: false };
        return { active: true, cfg: sess.cfg, frame: true };
      }

      if (!sess || !sess.active) {
        const prof = state.profiles.find(p => p.autoStart && matchesPattern(p.pattern, msg.url));
        if (!prof) { await setBadge(tabId, ''); return { active: false }; }
        sess = state.sessions[tabId] = newSession(tabId, msg.url, prof.cfg);
        sess.note = 'auto-started from “' + prof.name + '”';
      }
      if (sess.paused) return { active: false, paused: true };

      if (sess.cfg.stopIfUrlChanges && sess.stats.loads > 0 && msg.url !== sess.url) {
        sess.active = false;
        await save(); await armClock();
        await setBadge(tabId, '');
        await notifyPlain('Refresh Radar stopped', 'The tab navigated away from the monitored URL.', tabId);
        return { active: false };
      }

      sess.url = msg.url;
      sess.stats.loads++;
      if (sess.stats.loads > 1) sess.stats.refreshes++;
      updatePower();
      await save();

      return { active: true, cfg: sess.cfg, stats: sess.stats, deadline: sess.nextAt };
    }

    case 'REPORT': {
      const sess = state.sessions[tabId];
      if (!sess || !sess.active || sess.paused) return { stop: true, deadline: 0 };
      const cfg = sess.cfg;
      const isFrame = !!msg.frame;
      const now = Date.now();

      /* Sub-frames only ever provide positive evidence in "found" mode: a frame
       * that cannot see the keyword proves nothing about the page as a whole. */
      if (isFrame && (cfg.mode !== 'found' || cfg.scanFrames === false || !msg.found)) {
        if (isFrame && msg.found) sess.frameTrueAt = now;
        return { stop: false, matched: false, deadline: sess.nextAt };
      }

      let hit = false;
      let condNow = false;

      if (cfg.monitorEnabled) {
        if (cfg.mode === 'change') {
          if (sess.baseline !== null && msg.sig !== sess.baseline) hit = true;
          sess.baseline = msg.sig;
          condNow = hit;
        } else {
          condNow = cfg.mode === 'lost' ? !msg.found : !!msg.found;
          hit = condNow;
        }
      }

      /* Track whether the condition is *currently* true, so we can alert on the
       * transition rather than on every scan while it stays true. A frame's yes
       * keeps the condition alive briefly even if the top frame cannot see it. */
      if (cfg.mode !== 'change') {
        if (isFrame) {
          if (condNow) sess.frameTrueAt = now;
        } else if (!condNow && now - (sess.frameTrueAt || 0) > 4000) {
          sess.condTrue = false;
        }
        const wasTrue = sess.condTrue;
        if (condNow) sess.condTrue = true;
        if (hit) {
          if (cfg.alertMode === 'reload') hit = !msg.live;   // one check per page load
          else if (cfg.alertMode !== 'every' && wasTrue) hit = false;   // already reported
        }
      }

      /* Backstop for chatty pages: never two alerts inside the cooldown, and
       * never the same excerpt twice in a row. */
      const key = (msg.excerpt || '').slice(0, 160);
      if (hit) {
        const cool = Math.max(0, Number(cfg.alertCooldown) || 0) * 1000;
        if (cool && sess.lastAlertAt && now - sess.lastAlertAt < cool) hit = false;
        else if (cfg.alertMode === 'edge' && key && key === sess.lastAlertKey &&
                 now - sess.lastAlertAt < 600000) hit = false;
      }
      if (hit && cfg.alertOnce && sess.alerted) hit = false;

      if (hit) {
        sess.lastAlertAt = now;
        sess.lastAlertKey = key;
      }

      if (isFrame) {                       // frames never drive the countdown
        if (hit) {
          await raiseAlert(sess, msg);
          if (cfg.stopOnMatch) { sess.active = false; sess.nextAt = 0; updatePower(); }
        }
        await save();
        if (hit && cfg.stopOnMatch) await armClock();
        return { stop: !sess.active, matched: hit, deadline: sess.nextAt };
      }

      if (hit) {
        await raiseAlert(sess, msg);
        if (cfg.stopOnMatch) {
          sess.active = false;
          sess.nextAt = 0;
          updatePower();
          await save(); await armClock();
          return { stop: true, matched: true, deadline: 0 };
        }
      }

      /* A live re-check must never touch the countdown. It used to recompute
       * nextAt on every report, so a page that mutates (or a scan loop) pushed
       * the reload deadline forward indefinitely and reloads quietly stopped. */
      if (msg.live) {
        sess.lastScanAt = now;
        await save();
        return { stop: false, matched: hit, deadline: sess.nextAt };
      }

      const keep = cfg.continuousTimer && sess.nextAt > now;   // "don't restart the timer"
      const nd = keep ? sess.nextAt - now : reloadBudget(sess, true);
      const exhausted = cfg.refreshEnabled && nd === null;
      const done = exhausted && !cfg.liveWatch && !cfg.rescanEvery;

      sess.nextAt = nd === null ? 0 : now + nd;
      sess.lastScanAt = now;
      if (done) { sess.active = false; updatePower(); }
      await save(hit || done); await armClock();

      if (!hit) await setBadge(tabId, nd === null ? 'ON' : fmtCountdown(nd), '#10b981');
      return { stop: done, matched: hit, deadline: sess.nextAt };
    }

    case 'CAPTCHA': {
      const sess = state.sessions[tabId];
      if (!sess || !sess.active) return { ok: false };
      sess.paused = true;
      sess.note = 'paused — captcha detected';
      sess.nextAt = 0;
      updatePower();
      await save(); await armClock();
      await setBadge(tabId, '!', '#f59e0b');
      await notifyPlain('Refresh Radar paused', 'A captcha appeared on ' + hostOf(sess.url) + '. Solve it, then press Resume.', tabId);
      return { ok: true, pause: true };
    }

    case 'ERROR_PAGE': {
      const sess = state.sessions[tabId];
      if (!sess || !sess.active || !sess.cfg.retryOnError) return { ok: false };
      sess.stats.errors++;
      await save();
      scheduleRetry(tabId, sess.cfg.errorRetryDelay);
      return { ok: true, retryIn: sess.cfg.errorRetryDelay };
    }

    case 'HELD': {                                  // page reports user interaction
      const sess = state.sessions[tabId];
      if (!sess || !sess.active) return { ok: false };
      sess.nextAt = Date.now() + Math.max(1, sess.cfg.resumeAfter) * 1000;
      await save(); await armClock();
      return { ok: true };
    }

    case 'RUN_SCRIPT': {
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] }, world: 'MAIN',   // top frame only
          args: [String(msg.code || ''), msg.context || {}],
          func: (code, ctx) => {
            try {
              const s = document.createElement('script');
              s.textContent = '(function(){try{var RR=' + JSON.stringify(ctx) + ';\n' + code +
                '\n}catch(e){console.warn("[Refresh Radar] script:", e)}})();';
              (document.documentElement || document.head).appendChild(s);
              s.remove();
            } catch (e) { console.warn('[Refresh Radar] script blocked:', e); }
          }
        });
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e) }; }
    }

    case 'PICKED': {
      const sess = state.sessions[tabId];
      if (sess) sess.cfg.selector = msg.selector;
      state.defaults.selector = msg.selector;
      state.defaults.selectorType = 'css';
      await save();
      return { ok: true };
    }

    /* -------------------------------------------- popup / options API -- */

    case 'GET_STATE': {
      const sess = state.sessions[msg.tabId];
      return {
        session: sess || null,
        defaults: state.defaults,
        profiles: state.profiles,
        settings: state.settings,
        log: state.log.slice(0, 60),
        defaultKeywords: DEFAULT_KEYWORDS,
        activeCount: Object.values(state.sessions).filter(s => s.active).length
      };
    }

    case 'START': {
      const cfg = migrate(msg.cfg || {});
      const sess = newSession(msg.tabId, msg.url, cfg);
      const first = reloadBudget(sess, true);
      sess.nextAt = first === null ? 0 : Date.now() + first;
      state.sessions[msg.tabId] = sess;
      state.defaults = Object.assign({}, state.defaults, cfg);
      updatePower();
      await save(); await armClock();
      await setBadge(msg.tabId, 'ON', '#10b981');
      const ok = await kick(msg.tabId);
      return ok ? { ok: true } : { ok: false, error: 'Cannot run on this page — try a normal http(s) page.' };
    }

    case 'STOP': {
      const id = msg.tabId != null ? msg.tabId : tabId;
      delete state.sessions[id];
      updatePower();
      await save(); await armClock();
      await setBadge(id, '');
      try { await chrome.tabs.sendMessage(id, { type: 'RR_STOP' }); } catch (e) {}
      return { ok: true };
    }

    case 'PAUSE': {
      const sess = state.sessions[msg.tabId];
      if (!sess) return { ok: false };
      sess.paused = !sess.paused;
      sess.note = sess.paused ? 'paused' : '';
      if (!sess.paused) {
        const nd = reloadBudget(sess, false);
        sess.nextAt = nd === null ? 0 : Date.now() + nd;
      }
      updatePower();
      await save(); await armClock();
      if (sess.paused) {
        await setBadge(msg.tabId, '||', '#f59e0b');
        try { await chrome.tabs.sendMessage(msg.tabId, { type: 'RR_STOP' }); } catch (e) {}
      } else {
        await setBadge(msg.tabId, 'ON', '#10b981');
        await kick(msg.tabId);
      }
      return { ok: true, paused: sess.paused };
    }

    case 'STOP_ALL': {
      const ids = Object.keys(state.sessions);
      for (const id of ids) {
        const n = Number(id);
        await setBadge(n, '');
        try { await chrome.tabs.sendMessage(n, { type: 'RR_STOP' }); } catch (e) {}
      }
      const parked = (state.pending || []).length;
      state.sessions = {};
      state.pending = [];
      updatePower();
      await save(true); await armClock();
      return { ok: true, stopped: ids.length + parked };
    }

    case 'APPLY_ALL': {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      let n = 0;
      for (const t of tabs) {
        if (!t.url || !/^https?:/.test(t.url)) continue;
        const s = newSession(t.id, t.url, msg.cfg);
        const d = reloadBudget(s, true);
        s.nextAt = d === null ? 0 : Date.now() + d;
        state.sessions[t.id] = s;
        await setBadge(t.id, 'ON', '#10b981');
        await kick(t.id);
        n++;
      }
      updatePower();
      await save(); await armClock();
      return { ok: true, count: n };
    }

    case 'WATCH_URL': {
      let url = (msg.url || '').trim();
      if (!url) return { ok: false, error: 'Enter a URL' };
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      let tab;
      try { tab = await chrome.tabs.create({ url, active: false, pinned: true }); }
      catch (e) { return { ok: false, error: 'Could not open that URL' }; }
      const s = newSession(tab.id, url, msg.cfg);
      const d = reloadBudget(s, true);
      s.nextAt = d === null ? 0 : Date.now() + d;
      state.sessions[tab.id] = s;
      updatePower();
      await save(); await armClock();
      await setBadge(tab.id, 'ON', '#10b981');
      return { ok: true, tabId: tab.id };
    }

    /* Run the keyword search on the page right now and report what it finds,
     * across every frame — the answer to "would Ctrl+F match this?" */
    case 'FIND_NOW': {
      const id = msg.tabId;
      let frames = [{ frameId: 0 }];
      try { frames = await chrome.webNavigation.getAllFrames({ tabId: id }) || frames; } catch (e) {}
      const per = [];
      for (const f of frames.slice(0, 20)) {
        try {
          const r = await chrome.tabs.sendMessage(id, { type: 'RR_FIND', cfg: msg.cfg }, { frameId: f.frameId });
          if (r && !r.error) per.push(Object.assign({ frameId: f.frameId }, r));
        } catch (e) { /* no content script in that frame */ }
      }
      if (!per.length) return { ok: false, error: 'Cannot read this page — try a normal http(s) page.' };

      const totals = {};
      let excerpt = '', scope = per[0].scope, frames_with_hits = 0;
      for (const p of per) {
        let any = false;
        for (const k of p.keywords) {
          totals[k.value] = (totals[k.value] || 0) + k.count;
          if (k.count) any = true;
        }
        if (any) frames_with_hits++;
        if (!excerpt && p.excerpt) excerpt = p.excerpt;
      }
      return {
        ok: true, scope, excerpt, frames: per.length, framesWithHits: frames_with_hits,
        keywords: Object.keys(totals).map(v => ({ value: v, count: totals[v] }))
      };
    }

    case 'PICK': {
      try { await chrome.tabs.sendMessage(msg.tabId, { type: 'RR_PICK' }); return { ok: true }; }
      catch (e) {
        try {
          await chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: ['content.js'] });
          await chrome.tabs.sendMessage(msg.tabId, { type: 'RR_PICK' });
          return { ok: true };
        } catch (e2) { return { ok: false, error: 'Cannot pick on this page.' }; }
      }
    }

    case 'SAVE_DEFAULTS': { state.defaults = migrate(msg.defaults || {}); await save(); return { ok: true }; }
    case 'SAVE_PROFILES': { state.profiles = msg.profiles || []; await save(); return { ok: true }; }
    case 'SAVE_SETTINGS': {
      state.settings = Object.assign({}, SETTINGS_DEFAULTS, msg.settings || {});
      await save();
      if (state.settings.syncEnabled) pushSync();
      return { ok: true };
    }
    case 'PULL_SYNC': return { ok: await pullSync() };
    case 'CLEAR_LOG': { state.log = []; await save(); return { ok: true }; }

    case 'TEST_ALERT': {
      const cfg = Object.assign({}, state.defaults, msg.cfg || {});
      if (cfg.notify) {
        try {
          await chrome.notifications.create('rr-test-' + Date.now(), {
            type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
            title: 'Refresh Radar — test alert',
            message: 'This is what a match looks like.',
            priority: 2, requireInteraction: !!cfg.sticky
          });
        } catch (e) {}
      }
      if (cfg.sound) await playSound(cfg);
      return { ok: true };
    }

    case 'TEST_SOUND': {
      await playSound(Object.assign({}, state.defaults, { sound: true }, msg.cfg || {}));
      return { ok: true };
    }

    case 'EXPORT':
      return { data: { version: 3, defaults: state.defaults, profiles: state.profiles, settings: state.settings } };

    case 'IMPORT': {
      const d = msg.data || {};
      if (d.defaults) state.defaults = migrate(d.defaults);
      if (Array.isArray(d.profiles)) state.profiles = d.profiles.map(p => Object.assign({}, p, { cfg: migrate(p.cfg) }));
      if (d.settings) state.settings = Object.assign({}, SETTINGS_DEFAULTS, d.settings);
      await save();
      return { ok: true };
    }

    case 'LIST_ACTIVE': {
      const out = [];
      for (const [id, s] of Object.entries(state.sessions)) {
        if (!s.active) continue;
        let title = '';
        try { const t = await chrome.tabs.get(Number(id)); title = t.title || ''; } catch (e) {}
        out.push({
          tabId: Number(id), url: s.url, title, paused: !!s.paused, note: s.note || '',
          remaining: s.nextAt ? Math.max(0, s.nextAt - Date.now()) : 0,
          recovered: s.recovered || 0,
          stats: s.stats, keywords: (s.cfg.keywords || []).map(k => k.value)
        });
      }
      /* Parked watches are listed too — a watch waiting for its tab should be
       * visible, not a silent nothing. */
      for (const p of state.pending || []) {
        out.push({
          tabId: null, url: p.url, title: p.note || 'waiting for the page',
          paused: false, waiting: true, note: p.note || '', remaining: 0,
          stats: p.stats, keywords: (p.cfg.keywords || []).map(k => k.value)
        });
      }
      return { sessions: out };
    }

    case 'CLEAR_PENDING': {
      state.pending = [];
      await save(true);
      return { ok: true };
    }
  }
  return { error: 'unknown message ' + msg.type };
}

async function kick(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { type: 'RR_START' }); return true; }
  catch (e) {
    try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); return true; }
    catch (e2) { return false; }
  }
}

/* Backstop: fire anything already overdue and re-arm the clock. Runs on the
 * keepalive ping, on the alarm, and whenever the worker wakes for any reason. */
async function sweep() {
  const now = Date.now();
  const due = [];
  for (const [id, s] of Object.entries(state.sessions)) {
    if (!s.active || s.paused) continue;
    if (s.nextAt && s.nextAt <= now) {
      /* Overdue by more than a couple of cycles means something stalled — the
       * clock died, the worker was evicted, the machine slept. Count it so the
       * popup can say so instead of the user just seeing nothing happen. */
      if (now - s.nextAt > Math.max(4000, baseDelayMs(s.cfg, false) * 3)) {
        s.recovered = (s.recovered || 0) + 1;
      }
      due.push(Number(id));
    }
  }
  for (const id of due) await doReload(id);
  await ensureClockAlive();
  await armClock();
}

/* Re-attach every stored watch to a real tab. Exact URL first, then same
 * origin+path (list URLs carry params that drift), then park it. */
async function rebind() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch (e) { return; }
  const taken = {};
  const fresh = {};

  for (const [id, sess] of Object.entries(state.sessions)) {
    if (!sess.active) continue;
    let tab = tabs.find(t => t.id === Number(id) && t.url);
    if (!tab) tab = tabs.find(t => t.url === sess.url && !taken[t.id]);
    if (!tab) tab = tabs.find(t => sameTarget(t.url || '', sess.url) && !taken[t.id]);

    if (!tab) { park(sess, 'waiting for the page to reopen'); continue; }

    taken[tab.id] = true;
    if (tab.id !== Number(id)) sess.recovered = (sess.recovered || 0) + 1;
    sess.tabId = tab.id;
    sess.url = tab.url || sess.url;
    const d = reloadBudget(sess, false);
    sess.nextAt = d === null ? 0 : Date.now() + d;
    fresh[tab.id] = sess;
    kick(tab.id);
  }

  state.sessions = fresh;
  updatePower();
  await save(true);
  await ensureClockAlive();
  await armClock();
}

/* ------------------------------------------------------- lifecycle hooks */

chrome.alarms.create('rr-sweep', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'rr-sweep') return;
  await load();
  await ensureOffscreen();
  await sweep();
  /* Expire watches nobody is coming back for. */
  const now = Date.now();
  const before = (state.pending || []).length;
  state.pending = (state.pending || []).filter(p => now - (p.pendingSince || now) < PENDING_TTL);
  if (state.pending.length !== before) await save();
});

chrome.tabs.onRemoved.addListener(async (tabId, info) => {
  await load();
  const sess = state.sessions[tabId];
  if (!sess) return;
  delete state.sessions[tabId];
  /* Closing the window (or shutting down) is not the same as closing the tab:
   * park the watch so it comes back, rather than losing it on every restart. */
  if (info && info.isWindowClosing) park(sess, 'window closed — will resume when the page reopens');
  updatePower();
  await save(true);
  await armClock();
});

/* Any page finishing a load is a chance to re-attach a parked watch. */
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete') return;
  await load();
  if (!state.pending || !state.pending.length) return;
  await adopt(tab);
});

chrome.webNavigation.onErrorOccurred.addListener(async (d) => {
  if (d.frameId !== 0) return;
  await load();
  const sess = state.sessions[d.tabId];
  if (!sess || !sess.active || sess.paused || !sess.cfg.retryOnError) return;
  sess.stats.errors++;
  await save();
  await setBadge(d.tabId, 'ERR', '#f59e0b');
  scheduleRetry(d.tabId, sess.cfg.errorRetryDelay);
});

chrome.runtime.onStartup.addListener(async () => {
  await load();
  if (state.settings.syncEnabled) await pullSync();
  await ensureOffscreen();
  await rebind();
  /* Session restore reopens tabs a little after the browser starts, so give
   * parked watches a second chance once the dust settles. */
  setTimeout(async () => {
    await load();
    let tabs = [];
    try { tabs = await chrome.tabs.query({}); } catch (e) { return; }
    for (const t of tabs) await adopt(t);
  }, 8000);
});

chrome.runtime.onInstalled.addListener(async () => {
  await load();
  await save(true);
  await ensureOffscreen();
  await armClock();
});

chrome.commands.onCommand.addListener(async (cmd) => {
  await load();
  if (cmd === 'stop-all') { await handle({ type: 'STOP_ALL' }, {}); return; }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (cmd === 'pick-element') { await handle({ type: 'PICK', tabId: tab.id }, {}); return; }
  if (cmd === 'pause-resume') { await handle({ type: 'PAUSE', tabId: tab.id }, {}); return; }
  if (cmd === 'toggle-monitor') {
    if (state.sessions[tab.id] && state.sessions[tab.id].active) await handle({ type: 'STOP', tabId: tab.id }, {});
    else await handle({ type: 'START', tabId: tab.id, url: tab.url, cfg: state.defaults }, {});
  }
});

/* Cold start of the worker for any reason — eviction, crash, restart: rebuild
 * the clock and catch up on anything that was missed while it was gone. */
load().then(async () => {
  await ensureOffscreen();
  await rebind();
  await sweep();
});
