/* Refresh Radar — settings page */

let profiles = [];
let settings = { syncEnabled: false, templates: [], soundData: '', soundName: '', theme: 'dark' };
let defaults = {};

const LIBRARY = [
  ['Price under 50', '\\$\\s?([0-9]|[1-4][0-9])\\.\\d{2}\\b'],
  ['Any price', '(?:\\$|€|£|₹)\\s?\\d[\\d,]*(?:\\.\\d{2})?'],
  ['In stock / buyable', '\\b(in stock|available now|add to (cart|bag)|buy now)\\b'],
  ['Out of stock', '\\b(out of stock|sold out|currently unavailable|back ?order)\\b'],
  ['Slot or appointment opened', '\\b(book|reserve|schedule)\\b.{0,20}\\b(now|appointment|slot)\\b'],
  ['Status went final', '\\b(ready|complete[d]?|approved|dispatched|shipped|delivered)\\b'],
  ['Application decision', '\\b(decision|approved|rejected|granted|refused|issued)\\b'],
  ['Something new appeared', '\\b(new|just added|latest)\\b'],
  ['Year 2026 or later', '\\b20(2[6-9]|[3-9]\\d)\\b'],
  ['Email address', '[\\w.+-]+@[\\w-]+\\.[\\w.]{2,}'],
  ['Server error wording', '\\b(5\\d{2}|service unavailable|try again later)\\b'],
  ['Queue position', '\\b(position|you are)\\b.{0,15}\\b\\d{1,6}\\b']
];

const $ = (id) => document.getElementById(id);
const send = (m) => chrome.runtime.sendMessage(m).then(r => r || {}).catch(() => ({}));

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.side nav button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.side nav button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('.opt-pane').forEach(p => p.classList.toggle('active', p.id === 'p-' + b.dataset.p));
  }));

  $('clearLog').addEventListener('click', async () => { await send({ type: 'CLEAR_LOG' }); toast('History cleared'); load(); });
  $('export').addEventListener('click', doExport);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', doImport);

  $('toneRow').addEventListener('click', (e) => {
    const t = e.target.dataset && e.target.dataset.t;
    if (t) send({ type: 'TEST_SOUND', cfg: { soundTone: t, soundRepeat: 1, volume: defaults.volume } });
  });
  $('soundBtn').addEventListener('click', () => $('soundFile').click());
  $('soundFile').addEventListener('change', onSoundFile);
  $('soundClear').addEventListener('click', async () => {
    settings.soundData = ''; settings.soundName = '';
    await saveSettings(); renderSound(); toast('Custom sound removed');
  });
  $('soundTest').addEventListener('click', () => {
    if (!settings.soundData) { toast('No custom sound set'); return; }
    new Audio(settings.soundData).play().catch(() => toast('Could not play that file'));
  });

  ['notify', 'sticky', 'sound', 'focusTab'].forEach(k => {
    $('d_' + k).addEventListener('change', async (e) => {
      defaults[k] = e.target.checked;
      await send({ type: 'SAVE_DEFAULTS', defaults });
      toast('Saved');
    });
  });

  $('theme').addEventListener('change', async (e) => {
    settings.theme = e.target.value;
    await saveSettings();
    applyTheme(settings.theme);
  });

  $('syncEnabled').addEventListener('change', async (e) => {
    settings.syncEnabled = e.target.checked;
    await saveSettings();
    toast(settings.syncEnabled ? 'Syncing on' : 'Syncing off');
  });
  $('pullSync').addEventListener('click', async () => {
    const r = await send({ type: 'PULL_SYNC' });
    toast(r.ok ? 'Pulled from sync' : 'Nothing synced yet');
    load();
  });

  $('openShortcuts').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  renderLibrary();
  load();
});

async function load() {
  const st = await send({ type: 'GET_STATE', tabId: -1 });
  profiles = st.profiles || [];
  defaults = st.defaults || {};
  settings = Object.assign({ syncEnabled: false, templates: [], soundData: '', soundName: '', theme: 'dark' }, st.settings || {});

  applyTheme(settings.theme);
  $('theme').value = settings.theme || 'dark';
  $('syncEnabled').checked = !!settings.syncEnabled;
  ['notify', 'sticky', 'sound', 'focusTab'].forEach(k => { $('d_' + k).checked = !!defaults[k]; });

  renderProfiles();
  renderTemplates();
  renderSound();
  renderLog(st.log || []);
}

function applyTheme(t) {
  if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else if (t === 'auto' && window.matchMedia('(prefers-color-scheme: light)').matches)
    document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
}

const saveSettings = () => send({ type: 'SAVE_SETTINGS', settings });

/* ------------------------------------------------------------- profiles */

function renderProfiles() {
  const tbody = document.querySelector('#profiles tbody');
  tbody.innerHTML = '';
  $('noProfiles').classList.toggle('hidden', profiles.length > 0);
  $('profiles').classList.toggle('hidden', profiles.length === 0);

  profiles.forEach((p, i) => {
    const tr = document.createElement('tr');
    tr.appendChild(cell(p.name));

    const pat = document.createElement('td');
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = p.pattern || '';
    inp.addEventListener('change', () => { profiles[i].pattern = inp.value.trim(); persistProfiles(); });
    pat.appendChild(inp);
    tr.appendChild(pat);

    tr.appendChild(cell(describe(p.cfg || {}), 'mono'));

    const auto = document.createElement('td');
    const lab = document.createElement('label');
    lab.className = 'sw';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!p.autoStart;
    cb.addEventListener('change', () => { profiles[i].autoStart = cb.checked; persistProfiles(); });
    lab.append(cb, document.createElement('i'));
    auto.appendChild(lab);
    tr.appendChild(auto);

    tr.appendChild(btnCell('Delete', () => { profiles.splice(i, 1); persistProfiles(); renderProfiles(); }));
    tbody.appendChild(tr);
  });
}

function describe(c) {
  const every = c.intervalMode === 'random'
    ? c.intervalMin + '–' + c.intervalMax + 's'
    : fmtSecs(c.interval || 0);
  if (!c.monitorEnabled) return 'reload every ' + every;
  const words = (c.keywords || []).map(k => k.value).join(', ') || '—';
  const extra = c.autoClick ? ' + auto-click' : '';
  if (c.mode === 'change') return 'any change · ' + every + extra;
  return (c.mode === 'lost' ? 'lost: ' : 'found: ') + words + ' · ' + every + extra;
}

function fmtSecs(s) {
  s = Number(s) || 0;
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm' + (s % 60 ? ' ' + (s % 60) + 's' : '');
  return Math.floor(s / 3600) + 'h' + (Math.floor((s % 3600) / 60) ? ' ' + Math.floor((s % 3600) / 60) + 'm' : '');
}

async function persistProfiles() { await send({ type: 'SAVE_PROFILES', profiles }); toast('Saved'); }

/* ------------------------------------------------------------ templates */

function renderTemplates() {
  const list = settings.templates || [];
  const tbody = document.querySelector('#templates tbody');
  tbody.innerHTML = '';
  $('noTemplates').classList.toggle('hidden', list.length > 0);
  $('templates').classList.toggle('hidden', list.length === 0);

  list.forEach((t, i) => {
    const tr = document.createElement('tr');
    tr.appendChild(cell(t.name));
    tr.appendChild(cell((t.keywords || []).map(k => k.value).join(', '), 'mono'));
    tr.appendChild(cell(t.matchLogic === 'all' ? 'all' : 'any'));
    tr.appendChild(cell(t.selector || 'whole page', 'mono'));
    tr.appendChild(btnCell('Delete', async () => {
      settings.templates.splice(i, 1);
      await saveSettings();
      renderTemplates();
    }));
    tbody.appendChild(tr);
  });
}

/* -------------------------------------------------------------- library */

function renderLibrary() {
  const box = $('library');
  LIBRARY.forEach(([name, rx]) => {
    const d = document.createElement('button');
    d.className = 'chip';
    const b = document.createElement('b');
    b.textContent = name;
    const c = document.createElement('code');
    c.textContent = rx;
    d.append(b, c);
    d.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(rx); toast('Copied'); }
      catch (e) { toast('Select and copy manually'); }
    });
    box.appendChild(d);
  });
}

/* ---------------------------------------------------------------- sound */

function renderSound() {
  $('soundName').textContent =
    settings.soundData ? 'Current: ' + (settings.soundName || 'custom sound') : 'No custom sound set.';
}

function onSoundFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (file.size > 900 * 1024) { toast('Please pick a file under 900 KB'); e.target.value = ''; return; }
  const fr = new FileReader();
  fr.onload = async () => {
    settings.soundData = String(fr.result);
    settings.soundName = file.name;
    await saveSettings();
    renderSound();
    toast('Saved — choose “My own file” as the tone');
  };
  fr.readAsDataURL(file);
  e.target.value = '';
}

/* ------------------------------------------------------------------ log */

function renderLog(log) {
  const box = $('log');
  box.innerHTML = '';
  if (!log.length) {
    const d = document.createElement('div');
    d.className = 'entry';
    d.innerHTML = '<span class="when">No alerts yet.</span>';
    box.appendChild(d);
    return;
  }
  log.forEach(e => {
    const d = document.createElement('div');
    d.className = 'entry';

    const when = document.createElement('div');
    when.className = 'when';
    when.textContent = new Date(e.when).toLocaleString();

    const t = document.createElement('div');
    t.className = 'title';
    const a = document.createElement('a');
    a.href = e.url; a.target = '_blank'; a.rel = 'noreferrer';
    a.textContent = e.title || e.url;
    t.appendChild(a);

    d.append(when, t);
    if (e.excerpt) {
      const ex = document.createElement('div');
      ex.className = 'ex';
      ex.textContent = '“' + e.excerpt.slice(0, 260) + '”';
      d.appendChild(ex);
    }
    box.appendChild(d);
  });
}

/* --------------------------------------------------------------- backup */

async function doExport() {
  const r = await send({ type: 'EXPORT' });
  const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'refresh-radar-settings.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function doImport(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const fr = new FileReader();
  fr.onload = async () => {
    try { await send({ type: 'IMPORT', data: JSON.parse(String(fr.result)) }); toast('Imported'); load(); }
    catch (err) { toast('That file is not valid JSON'); }
  };
  fr.readAsText(file);
  e.target.value = '';
}

/* ---------------------------------------------------------------- utils */

function cell(text, cls) {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  if (cls === 'mono') td.title = text;
  return td;
}

function btnCell(label, fn) {
  const td = document.createElement('td');
  const b = document.createElement('button');
  b.className = 'btn sm danger';
  b.textContent = label;
  b.addEventListener('click', fn);
  td.appendChild(b);
  return td;
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 1800);
}
