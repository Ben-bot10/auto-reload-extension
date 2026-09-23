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
  interval: 30,                // seconds
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
  postLoadDelay: 0,

  /* ---- actions ---- */
  highlight: true,
  scrollToMatch: true,
  autoClick: false,
  autoClickTarget: '',
  autoClickNewTab: false,
  autoClickDelay: 500,
  flashPage: false,
  scriptOnLoad: '',
  scriptOnMatch: '',

  /* ---- alerts ---- */
  notify: true,
  sticky: true,
  sound: true,
  soundTone: 'chime',          // beep | chime | alarm | siren | ding | custom
  soundRepeat: 3,
  volume: 0.7,
  focusTab: true,
  stopOnMatch: true,
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
    const raw = await chrome.storage.local.get(['sessions', 'profiles', 'log', 'defaults', 'settings']);
    state = {
      sessions: raw.sessions || {},
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

async function save() {
  await chrome.storage.local.set({
    sessions: state.sessions, profiles: state.profiles, log: state.log,
    defaults: state.defaults, settings: state.settings
  });
  if (state.settings.syncEnabled) pushSync();
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
    stats: { loads: 0, refreshes: 0, matches: 0, errors: 0, startedAt: Date.now(), lastMatchAt: 0, lastExcerpt: '' }
  };
}

/* ------------------------------------------------------------- utilities */

const parseWhen = (v) => { if (!v) return 0; const t = new Date(v).getTime(); return isNaN(t) ? 0 : t; };

function baseDelayMs(cfg, first) {
  if (first && cfg.startDelay > 0) return Math.max(1, cfg.startDelay) * 1000;
  let secs;
  if (cfg.intervalMode === 'random') {
    const lo = Math.max(1, Math.min(cfg.intervalMin, cfg.intervalMax));
    const hi = Math.max(1, Math.max(cfg.intervalMin, cfg.intervalMax));
    secs = lo + Math.random() * (hi - lo);
  } else {
    secs = Math.max(1, Number(cfg.interval) || 30);
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
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 100) return String(s);
  const m = Math.floor(s / 60);
  return m < 100 ? m + 'm' : '99+';
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
  if (reloading[tabId] && Date.now() - reloading[tabId] < 1500) return;
  reloading[tabId] = Date.now();

  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch (e) { delete state.sessions[tabId]; await save(); return; }

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

  // Provisional next deadline; the content script's REPORT will refine it.
  sess.nextAt = Date.now() + Math.max(3000, baseDelayMs(sess.cfg, false));
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

  if (cfg.notify) {
    const id = 'rr-' + when + '-' + sess.tabId;
    notifTab[id] = sess.tabId;
    try {
      await chrome.notifications.create(id, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Match: ' + (payload.title || hostOf(sess.url)),
        message: (payload.excerpt || '').slice(0, 240) || describeMode(cfg),
        contextMessage: hostOf(sess.url),
        priority: 2, requireInteraction: !!cfg.sticky, silent: false
      });
    } catch (e) {}
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;
  handle(msg, sender).then(sendResponse).catch((e) => sendResponse({ error: String(e) }));
  return true;
});

/* The offscreen document holds this port open, which keeps the worker alive
 * while anything is being watched. */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'rr-keepalive') return;
  port.onMessage.addListener(async () => {
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
      for (const id of msg.tabIds || []) await doReload(Number(id));
      return { ok: true };
    }

    case 'OC_TICK': {
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
      let hit = false;

      if (cfg.monitorEnabled) {
        if (cfg.mode === 'change') {
          if (sess.baseline !== null && msg.sig !== sess.baseline) hit = true;
          sess.baseline = msg.sig;
        } else if (cfg.mode === 'lost') {
          hit = !msg.found;
        } else {
          hit = !!msg.found;
        }
      }
      if (hit && cfg.alertOnce && sess.alerted) hit = false;

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

      const now = Date.now();
      const keep = cfg.continuousTimer && sess.nextAt > now;   // "don't restart the timer"
      const nd = keep ? sess.nextAt - now : reloadBudget(sess, true);
      const exhausted = cfg.refreshEnabled && nd === null;
      const done = exhausted && !cfg.liveWatch;

      sess.nextAt = nd === null ? 0 : now + nd;
      if (done) { sess.active = false; updatePower(); }
      await save(); await armClock();

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
          target: { tabId }, world: 'MAIN',
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
      state.sessions = {};
      updatePower();
      await save(); await armClock();
      return { ok: true, stopped: ids.length };
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
          stats: s.stats, keywords: (s.cfg.keywords || []).map(k => k.value)
        });
      }
      return { sessions: out };
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
    if (s.active && !s.paused && s.nextAt && s.nextAt <= now) due.push(Number(id));
  }
  for (const id of due) await doReload(id);
  await armClock();
}

/* ------------------------------------------------------- lifecycle hooks */

chrome.alarms.create('rr-sweep', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'rr-sweep') return;
  await load();
  await ensureOffscreen();
  await sweep();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await load();
  if (state.sessions[tabId]) {
    delete state.sessions[tabId];
    updatePower();
    await save(); await armClock();
  }
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
  const tabs = await chrome.tabs.query({});
  const fresh = {};
  for (const sess of Object.values(state.sessions)) {
    if (!sess.active) continue;
    const tab = tabs.find(t => t.url === sess.url && !fresh[t.id]);
    if (!tab) continue;
    sess.tabId = tab.id;
    const d = reloadBudget(sess, false);
    sess.nextAt = d === null ? 0 : Date.now() + d;
    fresh[tab.id] = sess;
    kick(tab.id);
  }
  state.sessions = fresh;
  updatePower();
  await save();
  await ensureOffscreen();
  await armClock();
});

chrome.runtime.onInstalled.addListener(async () => {
  await load();
  await save();
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

/* Cold start of the worker for any reason: make sure the clock is running. */
load().then(async () => { await ensureOffscreen(); await sweep(); });
