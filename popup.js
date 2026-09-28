/* Refresh Radar — popup controller */

const BOOL = [
  'refreshEnabled',
  'hardReload', 'noResubmit', 'onlyWhenHidden', 'pauseOnInteract', 'retryOnError',
  'captchaPause', 'keepAwake', 'stopIfUrlChanges', 'preserveScroll', 'preserveForms',
  'visualTimer', 'continuousTimer',
  'monitorEnabled', 'caseSensitive', 'searchSource', 'liveWatch', 'scanFrames', 'deepScan',
  'highlight', 'scrollToMatch', 'autoClick', 'autoClickNewTab', 'flashPage',
  'notify', 'sticky', 'sound', 'focusTab', 'alertOnce', 'copyToClipboard'
];
const NUM = [
  'intervalMin', 'intervalMax', 'resumeAfter', 'errorRetryDelay', 'startDelay',
  'postLoadDelay', 'autoClickDelay', 'soundRepeat', 'volume', 'alertCooldown', 'rescanEvery'
];
const TEXT = [
  'timerStyle', 'timerCorner', 'startAt', 'stopAt', 'selector', 'selectorType',
  'autoClickTarget', 'scriptOnLoad', 'scriptOnMatch', 'soundTone', 'webhook', 'alertMode'
];

let tab = null;
let snap = null;
let running = false, paused = false;
let keywords = [];
let intervalMode = 'fixed';
let watchMode = 'found';
let matchLogic = 'any';
let applyTimer = null, pollTimer = null;

const $ = (id) => document.getElementById(id);
const send = (m) => chrome.runtime.sendMessage(m).then(r => r || {}).catch(() => ({}));

document.addEventListener('DOMContentLoaded', init);

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + b.dataset.tab));
    if (b.dataset.tab === 'tabs') renderTabs();
  }));

  document.querySelectorAll('.sec-h').forEach(h => h.addEventListener('click', () => {
    $(h.dataset.sec).classList.toggle('closed');
  }));

  seg('modeSeg', (v) => { intervalMode = v; syncUI(); onChange(); });
  seg('modeWatch', (v) => { watchMode = v; syncUI(); onChange(); });
  seg('logicSeg', (v) => { matchLogic = v; onChange(); });

  $('minus').addEventListener('click', () => bumpInterval(-step()));
  $('plus').addEventListener('click', () => bumpInterval(step()));
  $('presets').addEventListener('click', (e) => {
    const s = e.target.dataset && e.target.dataset.s;
    if (!s) return;
    $('is').value = s;
    intervalMode = 'fixed';
    syncUI(); onChange();
  });

  BOOL.concat(NUM, TEXT, ['is', 'ih', 'im', 'ics', 'maxRefreshes', 'maxOn', 'continueRefresh'])
    .forEach(id => {
      const el = $(id);
      if (!el) return;
      el.addEventListener((el.tagName === 'SELECT' || el.type === 'checkbox') ? 'change' : 'input', onChange);
    });

  $('toggle').addEventListener('click', toggle);
  $('pause').addEventListener('click', async () => {
    const r = await send({ type: 'PAUSE', tabId: tab.id });
    toast(r.paused ? 'Paused' : 'Resumed');
    refresh();
  });
  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('recommend').addEventListener('click', () => {
    const rec = {
      refreshEnabled: true, intervalMode: 'fixed', interval: 0.5, rescanEvery: 500,
      liveWatch: true, scanFrames: true, deepScan: true,
      monitorEnabled: true, notify: true, sound: true, sticky: true, flashPage: true,
      stopOnMatch: false, alertMode: 'edge', alertCooldown: 30,
      onlyWhenHidden: false, pauseOnInteract: false, retryOnError: true, captchaPause: true,
      maxRefreshes: 0, startDelay: 0, startAt: '', stopAt: ''
    };
    intervalMode = 'fixed';
    setSeg('modeSeg', 'fixed');
    Object.keys(rec).forEach(k => {
      const el = $(k);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!rec[k]; else el.value = rec[k];
    });
    $('is').value = 0.5;
    $('maxOn').checked = false;
    $('continueRefresh').checked = true;     // stopOnMatch false
    onChange();
    toast('Recommended settings applied');
  });

  $('kwAdd').addEventListener('click', addKeyword);
  $('kwInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addKeyword(); } });
  $('kwDefaults').addEventListener('click', () => {
    (snap.defaultKeywords || []).forEach(v => {
      if (!keywords.some(k => k.value.toLowerCase() === v.toLowerCase())) keywords.push({ value: v, type: 'text', enabled: true });
    });
    renderKeywords(); onChange(); toast('Defaults added');
  });
  $('kwClear').addEventListener('click', () => { keywords = []; renderKeywords(); onChange(); });
  $('kwTest').addEventListener('click', findNow);
  $('alertMode').addEventListener('change', () => {
    // "every reload" is pointless behind a 60-second cooldown
    if ($('alertMode').value !== 'edge' && Number($('alertCooldown').value) >= 60) {
      $('alertCooldown').value = 0;
    }
    onChange();
  });
  $('kwExport').addEventListener('click', exportKeywords);
  $('kwImport').addEventListener('click', () => $('kwFile').click());
  $('kwFile').addEventListener('change', importKeywords);

  $('pick').addEventListener('click', async () => {
    const r = await send({ type: 'PICK', tabId: tab.id });
    if (r && r.error) { toast(r.error); return; }
    window.close();
  });

  $('testSound').addEventListener('click', () => send({ type: 'TEST_SOUND', cfg: read() }));
  $('testAlert').addEventListener('click', async () => { await send({ type: 'TEST_ALERT', cfg: read() }); toast('Test alert sent'); });

  $('watchGo').addEventListener('click', async () => {
    const r = await send({ type: 'WATCH_URL', url: $('watchUrl').value, cfg: read() });
    toast(r.ok ? 'Background watcher opened' : (r.error || 'Failed'));
    if (r.ok) $('watchUrl').value = '';
    renderTabs();
  });
  $('applyAll').addEventListener('click', async () => {
    const r = await send({ type: 'APPLY_ALL', cfg: read() });
    toast('Running on ' + (r.count || 0) + ' tab(s)');
    refresh();
  });
  $('stopAll').addEventListener('click', async () => {
    const r = await send({ type: 'STOP_ALL' });
    toast('Stopped ' + (r.stopped || 0) + ' tab(s)');
    refresh();
  });

  $('saveProfile').addEventListener('click', saveProfile);
  $('loadProfile').addEventListener('click', loadProfile);
  $('tplSave').addEventListener('click', saveTemplate);
  $('tplSelect').addEventListener('change', loadTemplate);

  await refresh();
  pollTimer = setInterval(tick, 500);
}

/* ------------------------------------------------------------- utilities */

function seg(id, fn) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !b.dataset.v) return;
    $(id).querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    fn(b.dataset.v);
  });
}

function setSeg(id, v) {
  $(id).querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
}

const step = () => {
  const v = Number($('is').value) || 0;
  if (v >= 300) return 60;
  if (v >= 60) return 15;
  if (v >= 20) return 5;
  if (v >= 3) return 1;
  return 0.5;
};

function bumpInterval(d) {
  const v = Math.max(0.2, Math.round(((Number($('is').value) || 0) + d) * 10) / 10);
  $('is').value = v;
  onChange();
}

/* ------------------------------------------------------------- form I/O */

function write(cfg) {
  BOOL.forEach(id => { const el = $(id); if (el) el.checked = !!cfg[id]; });
  NUM.forEach(id => { const el = $(id); if (el && cfg[id] !== undefined) el.value = cfg[id]; });
  TEXT.forEach(id => { const el = $(id); if (el && cfg[id] !== undefined) el.value = cfg[id]; });

  $('continueRefresh').checked = !cfg.stopOnMatch;
  $('maxOn').checked = Number(cfg.maxRefreshes) > 0;
  $('maxRefreshes').value = Number(cfg.maxRefreshes) > 0 ? cfg.maxRefreshes : 10;

  const secs = Math.max(0.2, Number(cfg.interval) || 0.5);
  $('is').value = secs;
  $('ih').value = Math.floor(secs / 3600);
  $('im').value = Math.floor((secs % 3600) / 60);
  $('ics').value = Math.round(secs % 60);

  intervalMode = cfg.intervalMode || 'fixed';
  watchMode = cfg.mode || 'found';
  matchLogic = cfg.matchLogic || 'any';
  setSeg('modeSeg', intervalMode);
  setSeg('modeWatch', watchMode);
  setSeg('logicSeg', matchLogic);

  keywords = (cfg.keywords || []).map(k => ({ value: k.value, type: k.type || 'auto', enabled: k.enabled !== false }));
  renderKeywords();
  syncUI();
}

function read() {
  const out = {};
  BOOL.forEach(id => { const el = $(id); if (el) out[id] = el.checked; });
  NUM.forEach(id => { const el = $(id); if (el) out[id] = Number(el.value) || 0; });
  TEXT.forEach(id => { const el = $(id); if (el) out[id] = el.value; });

  out.refreshEnabled = true;
  out.stopOnMatch = !$('continueRefresh').checked;
  out.maxRefreshes = $('maxOn').checked ? Math.max(1, Number($('maxRefreshes').value) || 1) : 0;
  out.intervalMode = intervalMode;
  out.mode = watchMode;
  out.matchLogic = matchLogic;
  out.keywords = keywords.slice();

  out.interval = intervalMode === 'custom'
    ? Math.max(0.2, (Number($('ih').value) || 0) * 3600 + (Number($('im').value) || 0) * 60 + (Number($('ics').value) || 0))
    : Math.max(0.2, Number($('is').value) || 0.5);
  return out;
}

function syncUI() {

  $('presets').querySelectorAll('button').forEach(b =>
    b.classList.toggle('on', Number(b.dataset.s) === Number($('is').value)));

  const reloading = $('refreshEnabled').checked;
  $('fixedWrap').classList.toggle('hidden', intervalMode !== 'fixed' || !reloading);
  $('randomWrap').classList.toggle('hidden', intervalMode !== 'random' || !reloading);
  $('customWrap').classList.toggle('hidden', intervalMode !== 'custom' || !reloading);
  $('modeSeg').classList.toggle('hidden', !reloading);

  $('maxExtra').classList.toggle('hidden', !$('maxOn').checked);
  $('resumeExtra').classList.toggle('hidden', !$('pauseOnInteract').checked);
  $('errExtra').classList.toggle('hidden', !$('retryOnError').checked);
  $('clickExtra').classList.toggle('hidden', !$('autoClick').checked);
  $('soundExtra').classList.toggle('hidden', !$('sound').checked);
  $('timerStyleWrap').classList.toggle('hidden', !$('visualTimer').checked);
  $('kwWrap').classList.toggle('hidden', watchMode === 'change');

  const isColumn = $('selectorType').value === 'column';
  $('colNote').classList.toggle('hidden', !isColumn);
  $('pick').classList.toggle('hidden', isColumn);
  $('selector').placeholder = isColumn ? 'Assigned to' : '#price, .status, //div[@id=\'x\']';
  $('selLabel').innerHTML = isColumn
    ? 'Column heading'
    : 'Limit the search to one region <em class="hint">blank = whole page</em>';
}

function onChange() {
  syncUI();
  clearTimeout(applyTimer);
  applyTimer = setTimeout(async () => {
    const cfg = read();
    if (running) await send({ type: 'START', tabId: tab.id, url: tab.url, cfg });
    else await send({ type: 'SAVE_DEFAULTS', defaults: cfg });
  }, 550);
}

/* -------------------------------------------------------------- keywords */

function typeOf(k) {
  if (k.type && k.type !== 'auto') return k.type;
  const s = (k.value || '').trim();
  if (/^\(?\/\//.test(s) || /^\.\//.test(s)) return 'xpath';
  if (/^\/.*\/[gimsuy]*$/.test(s) && s.length > 2) return 'regex';
  if (/^[#.][A-Za-z_][\w-]*/.test(s) || /^[a-z]+\[[^\]]+\]$/i.test(s) || /[>~]|::/.test(s)) return 'css';
  return 'text';
}

function renderKeywords() {
  const box = $('kwList');
  box.innerHTML = '';
  $('kwEmpty').classList.toggle('hidden', keywords.length > 0);

  keywords.forEach((k, i) => {
    const t = typeOf(k);
    const row = document.createElement('div');
    row.className = 'kw' + (k.enabled ? '' : ' off');

    const tag = document.createElement('span');
    tag.className = 'tag ' + t;
    tag.textContent = t;
    tag.title = 'Click to enable / disable';
    tag.style.cursor = 'pointer';
    tag.addEventListener('click', () => { keywords[i].enabled = !keywords[i].enabled; renderKeywords(); onChange(); });

    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = k.value;
    v.title = k.value;

    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.textContent = '×';
    rm.title = 'Remove';
    rm.addEventListener('click', () => { keywords.splice(i, 1); renderKeywords(); onChange(); });

    row.append(tag, v, rm);
    box.appendChild(row);
  });
}

function addKeyword() {
  const raw = $('kwInput').value.trim();
  if (!raw) return;
  const type = $('kwType').value;
  raw.split('\n').map(s => s.trim()).filter(Boolean).forEach(value => {
    if (!keywords.some(k => k.value === value)) keywords.push({ value, type, enabled: true });
  });
  $('kwInput').value = '';
  renderKeywords();
  onChange();
}

/* Run the search against the live page and show what it found, the way
 * pressing Ctrl+F yourself would. */
async function findNow() {
  const box = $('findResult');
  box.classList.remove('hidden');
  box.textContent = 'Searching…';

  const r = await send({ type: 'FIND_NOW', tabId: tab.id, cfg: read() });
  if (!r || !r.ok) { box.textContent = (r && r.error) || 'Could not search this page.'; return; }
  if (!r.keywords.length) { box.textContent = 'Add a keyword first.'; return; }

  const rows = r.keywords.map(k =>
    '<div style="display:flex;justify-content:space-between;gap:10px;padding:2px 0">' +
    '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(k.value) + '</span>' +
    '<b style="color:' + (k.count ? 'var(--accent-2)' : 'var(--dim)') + '">' +
    (k.count ? k.count + '×' : 'not found') + '</b></div>').join('');

  const where = 'Searched the ' + esc(r.scope) +
    (r.frames > 1 ? ' across ' + r.frames + ' frames' : '') + '.';

  box.innerHTML = rows +
    '<div style="margin-top:6px;color:var(--dim)">' + where + '</div>' +
    (r.excerpt ? '<div style="margin-top:6px;color:var(--muted)">“' + esc(r.excerpt.slice(0, 160)) + '”</div>' : '');
}

function exportKeywords() {
  if (!keywords.length) { toast('No keywords to export'); return; }
  const blob = new Blob([JSON.stringify(keywords, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'refresh-radar-keywords.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function importKeywords(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const fr = new FileReader();
  fr.onload = () => {
    const txt = String(fr.result);
    let added = 0;
    try {
      const data = JSON.parse(txt);
      (Array.isArray(data) ? data : []).forEach(item => {
        const value = typeof item === 'string' ? item : item.value;
        if (!value || keywords.some(k => k.value === value)) return;
        keywords.push({ value, type: (item && item.type) || 'auto', enabled: true });
        added++;
      });
    } catch (err) {
      txt.split('\n').map(s => s.trim()).filter(Boolean).forEach(value => {
        if (keywords.some(k => k.value === value)) return;
        keywords.push({ value, type: 'auto', enabled: true });
        added++;
      });
    }
    renderKeywords();
    onChange();
    toast(added + ' keyword(s) imported');
  };
  fr.readAsText(file);
  e.target.value = '';
}

/* -------------------------------------------------------------- actions */

async function toggle() {
  if (running) {
    await send({ type: 'STOP', tabId: tab.id });
    toast('Stopped');
  } else {
    const cfg = read();
    if (cfg.monitorEnabled && cfg.mode !== 'change' && !cfg.keywords.filter(k => k.enabled).length) {
      toast('Add a keyword, or switch off the monitor');
      document.querySelector('.tab[data-tab="monitor"]').click();
      return;
    }
    const r = await send({ type: 'START', tabId: tab.id, url: tab.url, cfg });
    if (r && r.error) { toast(r.error); return; }
    toast('Watching this tab');
  }
  await refresh();
}

async function refresh() {
  const st = await send({ type: 'GET_STATE', tabId: tab.id });
  if (!st || !st.defaults) return;
  snap = st;

  applyTheme((st.settings && st.settings.theme) || 'dark');

  running = !!(st.session && st.session.active);
  paused = !!(st.session && st.session.paused);
  write(running ? st.session.cfg : st.defaults);

  const btn = $('toggle');
  btn.classList.toggle('stop', running);
  btn.querySelector('span').textContent = running ? 'Stop' : 'Start';
  btn.querySelector('use').setAttribute('href', running ? '#i-stop' : '#i-play');

  const p = $('pause');
  p.classList.toggle('hidden', !running);
  p.classList.toggle('on', paused);
  p.title = paused ? 'Resume' : 'Pause';

  fill('profileSelect', (st.profiles || []).map((x, i) => [String(i), x.name + (x.autoStart ? ' · auto' : '')]));
  fill('tplSelect', ((st.settings && st.settings.templates) || []).map((x, i) => [String(i), x.name]));

  renderStats();
  renderTabs();
}

function applyTheme(t) {
  if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else if (t === 'auto' && window.matchMedia('(prefers-color-scheme: light)').matches)
    document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
}

function fill(id, pairs) {
  const sel = $(id);
  const keep = sel.value;
  sel.innerHTML = '<option value="">—</option>';
  pairs.forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    sel.appendChild(o);
  });
  sel.value = keep;
}

function renderStats() {
  const s = snap && snap.session;
  const box = $('stats');
  if (!s) { box.textContent = 'Not watching this tab yet.'; return; }
  const st = s.stats;
  const last = st.lastMatchAt ? new Date(st.lastMatchAt).toLocaleTimeString() : '—';
  const scanAgo = s.lastScanAt ? Math.round((Date.now() - s.lastScanAt) / 1000) + 's ago' : '—';
  const health = s.recovered
    ? '<span style="color:var(--warn)">recovered ' + s.recovered + '×</span>'
    : '<span style="color:var(--accent-2)">healthy</span>';

  box.innerHTML =
    'Reloads <b>' + st.refreshes + '</b> · Matches <b>' + st.matches + '</b> · Errors <b>' + (st.errors || 0) + '</b><br>' +
    'Last scan <b>' + scanAgo + '</b> · Last hit <b>' + last + '</b> · ' + health +
    (s.notifyFailed ? '<br><span style="color:var(--warn)">' + s.notifyFailed +
      ' notification(s) blocked by your OS — the in-page banner was used</span>' : '') +
    (s.note ? '<br><b>' + esc(s.note) + '</b>' : '') +
    (st.lastExcerpt ? '<br>“' + esc(st.lastExcerpt.slice(0, 110)) + '”' : '');
}

async function renderTabs() {
  const r = await send({ type: 'LIST_ACTIVE' });
  const list = (r && r.sessions) || [];
  $('activeCount').textContent = String(list.length);
  const box = $('tablist');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="empty-note">No tabs refreshing.</div>';
    return;
  }
  list.forEach(s => {
    let host = s.url;
    try { host = new URL(s.url).hostname; } catch (e) {}
    const row = document.createElement('div');
    row.className = 'trow';

    const dot = document.createElement('span');
    dot.className = 'dot' + (s.paused || s.waiting ? ' paused' : '');

    const meta = document.createElement('div');
    meta.className = 'meta';
    const b = document.createElement('b');
    b.textContent = s.title || host;
    const sub = document.createElement('span');
    sub.textContent = s.waiting
      ? host + ' · waiting for the page to reopen'
      : host + ' · ' + s.stats.refreshes + ' reloads' +
        (s.recovered ? ' · recovered ' + s.recovered + '×' : '') +
        (s.keywords && s.keywords.length ? ' · ' + s.keywords.slice(0, 2).join(', ') : '');
    meta.append(b, sub);
    if (!s.waiting) {
      meta.style.cursor = 'pointer';
      meta.addEventListener('click', () => chrome.tabs.update(s.tabId, { active: true }));
    }

    const cd = document.createElement('span');
    cd.className = 'cd';
    cd.textContent = s.waiting ? '⏳' : (s.paused ? '||'
      : (s.remaining ? (s.remaining < 1000 ? '<1s' : Math.ceil(s.remaining / 1000) + 's') : '–'));

    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.textContent = '×';
    rm.title = s.waiting ? 'Forget this parked watch' : 'Stop this tab';
    rm.addEventListener('click', async () => {
      if (s.waiting) await send({ type: 'CLEAR_PENDING' });
      else await send({ type: 'STOP', tabId: s.tabId });
      refresh();
    });

    row.append(dot, meta, cd, rm);
    box.appendChild(row);
  });
}

async function tick() {
  if (!tab) return;
  const el = $('status');
  if (!running) { el.textContent = 'Idle'; return; }
  if (paused) { el.textContent = 'Paused'; return; }
  const st = await send({ type: 'GET_STATE', tabId: tab.id });
  const s = st && st.session;
  if (!s || !s.active) { el.textContent = 'Idle'; running = false; return; }
  const left = s.nextAt ? s.nextAt - Date.now() : 0;
  el.textContent = left > 0 ? 'Next reload in ' + Math.ceil(left / 1000) + 's'
    : (s.nextAt ? 'Reloading…' : 'Watching for changes');
  if (document.querySelector('.tab[data-tab="tabs"]').classList.contains('active')) renderTabs();
}

/* ------------------------------------------------- profiles & templates */

async function saveProfile() {
  const name = $('profileName').value.trim();
  if (!name) { toast('Give the profile a name'); return; }
  let pattern = '';
  try { pattern = new URL(tab.url).hostname; } catch (e) {}
  const profiles = (snap.profiles || []).slice();
  const entry = { name, pattern, autoStart: false, cfg: read() };
  const i = profiles.findIndex(p => p.name === name);
  if (i >= 0) profiles[i] = entry; else profiles.push(entry);
  await send({ type: 'SAVE_PROFILES', profiles });
  $('profileName').value = '';
  toast('Profile saved');
  refresh();
}

function loadProfile() {
  const i = $('profileSelect').value;
  if (i === '') return;
  const p = snap.profiles[Number(i)];
  if (!p) return;
  write(p.cfg);
  onChange();
  toast('Loaded “' + p.name + '”');
}

async function saveTemplate() {
  if (!keywords.length) { toast('No keywords to save'); return; }
  const first = keywords[0].value;
  const name = (keywords.length > 1 ? first + ' +' + (keywords.length - 1) : first).slice(0, 34);
  const settings = Object.assign({}, snap.settings);
  settings.templates = (settings.templates || []).slice();
  settings.templates.push({ name, keywords: keywords.slice(), matchLogic, selector: $('selector').value });
  await send({ type: 'SAVE_SETTINGS', settings });
  toast('Template saved');
  refresh();
}

function loadTemplate() {
  const i = $('tplSelect').value;
  if (i === '') return;
  const t = (snap.settings.templates || [])[Number(i)];
  if (!t) return;
  keywords = (t.keywords || []).slice();
  if (t.matchLogic) { matchLogic = t.matchLogic; setSeg('logicSeg', matchLogic); }
  if (t.selector) $('selector').value = t.selector;
  renderKeywords();
  onChange();
  toast('Template loaded');
}

/* ---------------------------------------------------------------- utils */

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 1900);
}

const esc = (s) => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

window.addEventListener('unload', () => clearInterval(pollTimer));
