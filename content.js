/* Refresh Radar — page engine.
 *
 * Scanning, the on-page actions, the timer overlay and the element picker.
 * The countdown itself is owned by the background worker (page timers stop when
 * a window is minimized), so everything here is scan-on-load plus display.
 */
(() => {
  if (window.__REFRESH_RADAR__) return;
  window.__REFRESH_RADAR__ = true;

  const SCROLL_KEY = '__rr_scroll__';
  const FORM_KEY = '__rr_forms__';

  let cfg = null;
  let deadline = 0;
  let display = null, idleTimer = null, moTimer = null;
  let observer = null;
  let running = false;
  let heldByUser = false;
  let suppressMO = false;
  let ui = null;
  let picker = null;
  let matchRange = null;

  chrome.runtime.onMessage.addListener((msg, sender, send) => {
    if (!msg) return;
    switch (msg.type) {
      case 'RR_STOP': teardown(); send({ ok: true }); break;
      case 'RR_START': boot(); send({ ok: true }); break;
      case 'RR_STATUS': send({ running, held: heldByUser, remaining: Math.max(0, deadline - Date.now()) }); break;
      case 'RR_COPY': copyText(msg.text); send({ ok: true }); break;
      case 'RR_PICK': startPicker(); send({ ok: true }); break;
      case 'RR_DEADLINE': deadline = msg.deadline || 0; send({ ok: true }); break;
      default: send({ ok: false });
    }
    return true;
  });

  boot();

  /* ------------------------------------------------------------ lifecycle */

  async function boot() {
    teardown();
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'CS_INIT', url: location.href, title: document.title });
    } catch (e) { return; }
    if (!res || !res.active) return;

    cfg = res.cfg;
    deadline = res.deadline || 0;
    running = true;

    if (cfg.preserveScroll) restoreScroll();
    if (cfg.preserveForms) restoreForms();
    if (cfg.scriptOnLoad) runUserScript(cfg.scriptOnLoad, { event: 'load', url: location.href });
    if (cfg.visualTimer) buildOverlay();
    if (cfg.pauseOnInteract) watchInteraction();
    startDisplay();

    if (cfg.captchaPause && looksLikeCaptcha()) {
      setLabel('captcha — paused');
      chrome.runtime.sendMessage({ type: 'CAPTCHA' }).catch(() => {});
      return;
    }
    if (cfg.retryOnError && looksLikeErrorPage()) {
      setLabel('error page — retrying');
      chrome.runtime.sendMessage({ type: 'ERROR_PAGE' }).catch(() => {});
      return;
    }

    const wait = Math.max(0, Number(cfg.postLoadDelay) || 0) * 1000;
    if (wait) { setLabel('waiting to scan'); await sleep(wait); if (!running) return; }

    await report();
    if (running && cfg.liveWatch && cfg.monitorEnabled) startObserver();
  }

  function teardown() {
    running = false;
    heldByUser = false;
    clearInterval(display); display = null;
    clearTimeout(idleTimer); idleTimer = null;
    clearTimeout(moTimer); moTimer = null;
    if (observer) { observer.disconnect(); observer = null; }
    deadline = 0;
    removeOverlay();
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /* -------------------------------------------------------- scan / report */

  async function report() {
    const scan = evaluate();
    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'REPORT', found: scan.found, sig: scan.sig,
        excerpt: scan.excerpt, title: document.title, url: location.href
      });
    } catch (e) { teardown(); return; }
    if (!res) { teardown(); return; }
    if (res.matched) onMatch(scan);
    if (res.stop) { teardown(); return; }
    deadline = res.deadline || 0;
    if (!deadline) setLabel('watching');
  }

  /* ------------------------------------------------------ keyword engine */

  function detectType(v) {
    const s = (v || '').trim();
    if (/^\(?\/\//.test(s) || /^\.\//.test(s)) return 'xpath';
    if (/^\/.*\/[gimsuy]*$/.test(s) && s.length > 2) return 'regex';
    if (/^[#.][A-Za-z_][\w-]*/.test(s) || /^[a-z]+\[[^\]]+\]$/i.test(s) || /[>~]|::/.test(s)) return 'css';
    return 'text';
  }

  function toRegex(v, caseSensitive) {
    const s = (v || '').trim();
    const m = s.match(/^\/(.*)\/([gimsuy]*)$/);
    try {
      if (m) return new RegExp(m[1], m[2].includes('i') || !caseSensitive ? (m[2].includes('i') ? m[2] : m[2] + 'i') : m[2]);
      return new RegExp(s, caseSensitive ? '' : 'i');
    } catch (e) { return null; }
  }

  function resolveEl(sel, type) {
    const s = (sel || '').trim();
    if (!s) return null;
    try {
      if (type === 'xpath') {
        const r = document.evaluate(s, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return r.singleNodeValue && r.singleNodeValue.nodeType === 1 ? r.singleNodeValue : null;
      }
      return document.querySelector(s);
    } catch (e) { return null; }
  }

  function scopeRoot() {
    const sel = (cfg.selector || '').trim();
    if (!sel) return document.body || document.documentElement;
    return resolveEl(sel, cfg.selectorType) || document.body || document.documentElement;
  }

  function textOf(root) {
    return (root.innerText || root.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function testKeyword(k, root, hay) {
    const type = (!k.type || k.type === 'auto') ? detectType(k.value) : k.type;
    const v = (k.value || '').trim();
    if (!v) return { found: false };

    if (type === 'css' || type === 'xpath') {
      let el = null;
      if (type === 'xpath') el = resolveEl(v, 'xpath');
      else { try { el = root.querySelector(v) || document.querySelector(v); } catch (e) { el = null; } }
      return el
        ? { found: true, el, excerpt: (el.innerText || el.textContent || '').trim().slice(0, 240) || v }
        : { found: false };
    }

    if (type === 'regex') {
      const rx = toRegex(v, cfg.caseSensitive);
      if (!rx) return { found: false };
      const m = hay.match(rx);
      return m ? { found: true, excerpt: snippet(hay, m.index, m[0].length), needle: m[0], rx } : { found: false };
    }

    const H = cfg.caseSensitive ? hay : hay.toLowerCase();
    const N = cfg.caseSensitive ? v : v.toLowerCase();
    const i = H.indexOf(N);
    return i >= 0 ? { found: true, excerpt: snippet(hay, i, v.length), needle: v } : { found: false };
  }

  function evaluate() {
    const root = scopeRoot();
    if (!root) return { found: false, sig: '0', excerpt: '' };

    const hay = cfg.searchSource ? (root.innerHTML || '') : textOf(root);
    const sig = hash(hay);

    if (cfg.mode === 'change') return { found: true, sig, excerpt: snippet(hay, 0, 200) };

    const list = (cfg.keywords || []).filter(k => k.enabled !== false && (k.value || '').trim());
    if (!list.length) return { found: false, sig, excerpt: '' };

    const hits = [];
    for (const k of list) {
      const r = testKeyword(k, root, hay);
      if (r.found) hits.push(r);
      else if (cfg.matchLogic === 'all') return { found: false, sig, excerpt: '' };
    }
    const ok = cfg.matchLogic === 'all' ? hits.length === list.length : hits.length > 0;
    const first = hits[0] || {};
    return {
      found: ok, sig,
      excerpt: ok ? (first.excerpt || '') : '',
      el: first.el || null, needle: first.needle, rx: first.rx,
      count: hits.length, total: list.length
    };
  }

  function snippet(hay, index, len) {
    const pad = 80;
    const a = Math.max(0, index - pad);
    const b = Math.min(hay.length, index + len + pad);
    return (a > 0 ? '…' : '') + hay.slice(a, b).trim() + (b < hay.length ? '…' : '');
  }

  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h >>> 0) + ':' + s.length;
  }

  /* ------------------------------------------------------ actions on hit */

  function onMatch(scan) {
    setLabel('match');
    let target = scan.el || null;
    if (!target && cfg.mode !== 'change') target = locateText(scan);

    if (cfg.highlight && target) withoutObserver(() => paintHighlight(target));
    if (cfg.scrollToMatch && target) { try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {} }
    if (cfg.flashPage) withoutObserver(() => showBanner(scan.excerpt));
    if (cfg.scriptOnMatch) runUserScript(cfg.scriptOnMatch, { event: 'match', excerpt: scan.excerpt, url: location.href });

    if (cfg.autoClick) {
      const wait = Math.max(0, Number(cfg.autoClickDelay) || 0);
      setTimeout(() => {
        const explicit = (cfg.autoClickTarget || '').trim();
        const el = explicit ? resolveEl(explicit, detectType(explicit) === 'xpath' ? 'xpath' : 'css') : target;
        if (!el) return;
        const clickable = el.closest('a,button,[role=button],input[type=submit],input[type=button]') || el;
        try {
          if (cfg.autoClickNewTab && clickable.tagName === 'A' && clickable.href) {
            window.open(clickable.href, '_blank');
          } else {
            clickable.click();
          }
        } catch (e) {}
      }, wait);
    }
  }

  function locateText(scan) {
    const root = scopeRoot();
    if (!root) return null;
    const needle = scan.needle;
    const rx = scan.rx;
    if (!needle && !rx) return null;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const t = p.tagName;
        if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node;
    while ((node = walker.nextNode())) {
      const v = node.nodeValue;
      let idx = -1, len = 0;
      if (rx) {
        const m = v.match(rx);
        if (m) { idx = m.index; len = m[0].length; }
      } else {
        const hay = cfg.caseSensitive ? v : v.toLowerCase();
        const nd = cfg.caseSensitive ? needle : needle.toLowerCase();
        idx = hay.indexOf(nd);
        len = needle.length;
      }
      if (idx >= 0) { matchRange = { node, idx, len }; return node.parentElement; }
    }
    matchRange = null;
    return null;
  }

  function paintHighlight(el) {
    try {
      if (matchRange && matchRange.node && matchRange.node.parentElement) {
        const r = document.createRange();
        r.setStart(matchRange.node, matchRange.idx);
        r.setEnd(matchRange.node, Math.min(matchRange.node.nodeValue.length, matchRange.idx + matchRange.len));
        const mark = document.createElement('mark');
        mark.setAttribute('data-refresh-radar', '1');
        mark.style.cssText = 'background:#fde047;color:#111;outline:2px solid #f59e0b;border-radius:3px;padding:0 2px';
        r.surroundContents(mark);
        return;
      }
    } catch (e) {}
    try {
      el.style.outline = '3px solid #f59e0b';
      el.style.outlineOffset = '2px';
      el.setAttribute('data-refresh-radar', '1');
    } catch (e) {}
  }

  function withoutObserver(fn) {
    suppressMO = true;
    try { fn(); } finally { setTimeout(() => { suppressMO = false; }, 300); }
  }

  /* --------------------------------------------------------- display loop */

  function startDisplay() {
    clearInterval(display);
    display = setInterval(() => {
      if (!running) return clearInterval(display);
      paintOverlay(Math.max(0, deadline - Date.now()));
    }, 500);
    paintOverlay(Math.max(0, deadline - Date.now()));
  }

  /* ------------------------------------------------- pause on interaction */

  function watchInteraction() {
    const bump = () => {
      if (!running) return;
      heldByUser = true;
      setLabel('paused — page in use');
      chrome.runtime.sendMessage({ type: 'HELD' }).catch(() => {});
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { heldByUser = false; setLabel(''); },
        Math.max(1, Number(cfg.resumeAfter) || 15) * 1000);
    };
    ['mousedown', 'keydown', 'wheel', 'touchstart'].forEach(ev =>
      document.addEventListener(ev, bump, { passive: true, capture: true }));
  }

  /* -------------------------------------------------------- live observer */

  function startObserver() {
    const target = document.body || document.documentElement;
    if (!target) return;
    observer = new MutationObserver(() => {
      if (suppressMO) return;
      clearTimeout(moTimer);
      moTimer = setTimeout(() => { if (running) liveCheck(); }, 400);
    });
    observer.observe(target, { childList: true, subtree: true, characterData: true, attributes: false });
  }

  async function liveCheck() {
    if (cfg.mode === 'change') return;
    const scan = evaluate();
    const wants = cfg.mode === 'lost' ? !scan.found : scan.found;
    if (!wants) return;
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'REPORT', found: scan.found, sig: scan.sig,
        excerpt: scan.excerpt, title: document.title, url: location.href
      });
      if (res && res.matched) onMatch(scan);
      if (res && res.stop) teardown();
      else if (res) deadline = res.deadline || deadline;
    } catch (e) { teardown(); }
  }

  /* ------------------------------------------------ captcha / error pages */

  function looksLikeCaptcha() {
    const sels = [
      'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]',
      'iframe[src*="challenges.cloudflare.com"]', 'iframe[title*="challenge" i]',
      '.g-recaptcha', '#cf-challenge-running', '#challenge-form', '[data-sitekey]'
    ];
    for (const s of sels) { try { if (document.querySelector(s)) return true; } catch (e) {} }
    const t = (document.body ? document.body.innerText || '' : '').slice(0, 1200).toLowerCase();
    return /verify (you are|that you are) (a )?human|are you a robot|unusual traffic|checking your browser/.test(t);
  }

  function looksLikeErrorPage() {
    const title = (document.title || '').trim();
    const body = (document.body ? document.body.innerText || '' : '').trim();
    if (body.length > 2500) return false;
    return /\b(4\d{2}|5\d{2})\b|not found|forbidden|service unavailable|bad gateway|too many requests|temporarily unavailable/i
      .test(title + ' ' + body.slice(0, 400));
  }

  /* ---------------------------------------------------------- overlay UI */

  const CORNERS = {
    tl: 'top:14px;left:14px', tr: 'top:14px;right:14px',
    bl: 'bottom:14px;left:14px', br: 'bottom:14px;right:14px'
  };

  function buildOverlay() {
    removeOverlay();
    const style = cfg.timerStyle || 'compact';
    const host = document.createElement('div');
    host.setAttribute('data-refresh-radar-ui', '1');

    if (style === 'bar') {
      host.style.cssText = 'all:initial;position:fixed;left:0;right:0;top:0;height:3px;z-index:2147483647';
    } else {
      host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;' + (CORNERS[cfg.timerCorner || 'br']);
    }

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = overlayMarkup(style);
    (document.body || document.documentElement).appendChild(host);

    const p = root.querySelector('.p');
    const x = root.querySelector('.x');
    if (p) p.addEventListener('click', () => {
      heldByUser = !heldByUser;
      p.textContent = heldByUser ? 'Resume' : 'Pause';
      if (heldByUser) chrome.runtime.sendMessage({ type: 'HELD' }).catch(() => {});
      setLabel(heldByUser ? 'paused' : '');
    });
    if (x) x.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'STOP' }).catch(() => {});
      teardown();
    });

    ui = {
      host, root, style,
      num: root.querySelector('.n'),
      label: root.querySelector('.s'),
      fill: root.querySelector('.fill'),
      ring: root.querySelector('.ringfg')
    };
  }

  function overlayMarkup(style) {
    const base =
      '<style>' +
      ':host{all:initial}' +
      '.box{font:600 12px/1.3 -apple-system,Segoe UI,Roboto,sans-serif;background:#0f172aee;color:#fff;' +
      'border:1px solid #ffffff1f;border-radius:11px;padding:8px 11px;display:flex;align-items:center;gap:9px;' +
      'box-shadow:0 6px 22px #0007;backdrop-filter:blur(4px);user-select:none}' +
      '.n{font-variant-numeric:tabular-nums;font-size:14px;color:#34d399}' +
      '.s{font-weight:400;opacity:.7;font-size:11px;max-width:180px;color:#e2e8f0}' +
      'button{font:600 11px sans-serif;background:#ffffff1a;border:0;color:#fff;border-radius:6px;padding:3px 7px;cursor:pointer}' +
      'button:hover{background:#ffffff33}' +
      '</style>';

    if (style === 'bar') {
      return '<style>.wrap{height:3px;background:#0f172a55}.fill{height:3px;background:#34d399;width:0%;transition:width .4s linear}</style>' +
             '<div class="wrap"><div class="fill"></div></div>';
    }
    if (style === 'dot') {
      return base + '<div class="box" style="padding:6px 10px"><span class="n">–</span></div>';
    }
    if (style === 'ring') {
      return base +
        '<div class="box" style="padding:7px 10px">' +
        '<svg width="26" height="26" viewBox="0 0 36 36" style="flex:none">' +
        '<circle cx="18" cy="18" r="15" fill="none" stroke="#ffffff26" stroke-width="4"></circle>' +
        '<circle class="ringfg" cx="18" cy="18" r="15" fill="none" stroke="#34d399" stroke-width="4" ' +
        'stroke-linecap="round" stroke-dasharray="94.2" stroke-dashoffset="0" transform="rotate(-90 18 18)"></circle>' +
        '</svg><span class="n">–</span><span class="s"></span></div>';
    }
    return base +
      '<div class="box"><span class="n">–</span><span class="s"></span>' +
      '<button class="p">Pause</button><button class="x">Stop</button></div>';
  }

  function removeOverlay() {
    if (ui && ui.host && ui.host.parentNode) ui.host.parentNode.removeChild(ui.host);
    ui = null;
  }

  let overlayTotal = 0;
  function paintOverlay(ms) {
    if (!ui) return;
    if (ms > overlayTotal) overlayTotal = ms;
    const s = Math.ceil(ms / 1000);
    const text = heldByUser ? '||' : (s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : s + 's');
    if (ui.num) ui.num.textContent = text;
    if (ui.fill && overlayTotal) ui.fill.style.width = (100 - Math.min(100, (ms / overlayTotal) * 100)) + '%';
    if (ui.ring && overlayTotal) {
      const frac = Math.max(0, Math.min(1, ms / overlayTotal));
      ui.ring.setAttribute('stroke-dashoffset', String(94.2 * (1 - frac)));
    }
  }

  function setLabel(text) {
    if (ui && ui.label) ui.label.textContent = text || '';
  }

  function showBanner(excerpt) {
    const host = document.createElement('div');
    host.setAttribute('data-refresh-radar-ui', '1');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;right:0;z-index:2147483647';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>' +
      '.b{font:600 13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;background:#059669;color:#fff;' +
      'padding:11px 16px;display:flex;align-items:center;gap:12px;box-shadow:0 2px 16px #0006;animation:p 1s ease-in-out 3}' +
      '@keyframes p{0%,100%{background:#059669}50%{background:#10b981}}' +
      '.t{flex:1;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      'button{font:600 12px sans-serif;background:#ffffff2e;border:0;color:#fff;border-radius:6px;padding:4px 9px;cursor:pointer}' +
      '</style>' +
      '<div class="b"><b>Refresh Radar — match</b><span class="t"></span><button>Dismiss</button></div>';
    root.querySelector('.t').textContent = (excerpt || '').slice(0, 220);
    root.querySelector('button').addEventListener('click', () => host.remove());
    (document.body || document.documentElement).appendChild(host);
    setTimeout(() => { if (host.parentNode) host.remove(); }, 15000);
  }

  /* ------------------------------------------------------- element picker */

  function startPicker() {
    if (picker) return;
    const box = document.createElement('div');
    box.setAttribute('data-refresh-radar-ui', '1');
    box.style.cssText = 'all:initial;position:fixed;z-index:2147483646;border:2px solid #10b981;' +
      'background:#10b98122;pointer-events:none;border-radius:3px;transition:all .04s';
    const tip = document.createElement('div');
    tip.setAttribute('data-refresh-radar-ui', '1');
    tip.style.cssText = 'all:initial;position:fixed;z-index:2147483647;bottom:16px;left:50%;transform:translateX(-50%);' +
      'font:600 12px -apple-system,Segoe UI,Roboto,sans-serif;background:#0f172aee;color:#fff;padding:8px 14px;' +
      'border-radius:9px;box-shadow:0 6px 22px #0007';
    tip.textContent = 'Click an element to monitor it — Esc to cancel';
    document.documentElement.appendChild(box);
    document.documentElement.appendChild(tip);

    let current = null;

    const move = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === box || el.hasAttribute('data-refresh-radar-ui')) return;
      current = el;
      const r = el.getBoundingClientRect();
      box.style.top = r.top + 'px'; box.style.left = r.left + 'px';
      box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    };
    const click = (e) => {
      if (!current) return;
      e.preventDefault(); e.stopPropagation();
      const sel = cssPath(current);
      chrome.runtime.sendMessage({ type: 'PICKED', selector: sel }).catch(() => {});
      tip.textContent = 'Monitoring: ' + sel;
      setTimeout(stop, 1400);
    };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); stop(); } };

    function stop() {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', key, true);
      box.remove(); tip.remove();
      picker = null;
    }

    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
    picker = { stop };
  }

  function cssPath(el) {
    const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
    const unique = (s) => { try { return document.querySelectorAll(s).length === 1; } catch (e) { return false; } };
    if (el.id && unique('#' + esc(el.id))) return '#' + esc(el.id);

    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      if (node.id && unique('#' + esc(node.id))) { parts.unshift('#' + esc(node.id)); break; }
      let part = node.tagName.toLowerCase();
      const cls = Array.from(node.classList || [])
        .filter(c => /^[a-zA-Z][\w-]{1,30}$/.test(c) && !/(active|hover|open|selected|focus)/i.test(c))
        .slice(0, 2);
      if (cls.length) part += '.' + cls.map(esc).join('.');
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      const candidate = parts.join(' > ');
      if (unique(candidate)) return candidate;
      node = parent;
    }
    return parts.join(' > ');
  }

  /* --------------------------------------------------------- user scripts */

  function runUserScript(code, context) {
    if (!code || !code.trim()) return;
    chrome.runtime.sendMessage({ type: 'RUN_SCRIPT', code, context }).catch(() => {});
  }

  /* -------------------------------------------------- scroll / form state */

  function saveScroll() {
    try { sessionStorage.setItem(SCROLL_KEY, JSON.stringify([window.scrollX, window.scrollY])); } catch (e) {}
  }

  function restoreScroll() {
    try {
      const v = sessionStorage.getItem(SCROLL_KEY);
      if (!v) return;
      const [x, y] = JSON.parse(v);
      const go = () => window.scrollTo(x, y);
      go(); setTimeout(go, 120); setTimeout(go, 500);
    } catch (e) {}
  }

  const fieldKey = (el, i) => [el.tagName, el.type || '', el.name || '', el.id || '', i].join('|');

  function saveForms() {
    try {
      const out = {};
      document.querySelectorAll('input, textarea, select').forEach((el, i) => {
        if (el.type === 'password' || el.type === 'file' || el.type === 'hidden') return;
        out[fieldKey(el, i)] = (el.type === 'checkbox' || el.type === 'radio') ? (el.checked ? 1 : 0) : el.value;
      });
      sessionStorage.setItem(FORM_KEY, JSON.stringify(out));
    } catch (e) {}
  }

  function restoreForms() {
    try {
      const v = sessionStorage.getItem(FORM_KEY);
      if (!v) return;
      const data = JSON.parse(v);
      document.querySelectorAll('input, textarea, select').forEach((el, i) => {
        const k = fieldKey(el, i);
        if (!(k in data)) return;
        if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!data[k];
        else el.value = data[k];
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    } catch (e) {}
  }

  /* The worker reloads the tab, so save state just before we lose the page. */
  window.addEventListener('pagehide', () => {
    if (!running || !cfg) return;
    if (cfg.preserveScroll) saveScroll();
    if (cfg.preserveForms) saveForms();
  });

  function copyText(text) {
    if (!text) return;
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch (e) {}
  }
})();
