# Refresh Radar — Auto Reload & Page Monitor

**v3.0** — a Chrome/Edge/Brave extension (Manifest V3) that auto-refreshes pages, watches
them for keywords, elements or changes, acts on the page when it finds something, and
alerts you — and **keeps running while the tab is hidden and the window is minimized**.
Everything is unlocked: no tiers, no account, no server.

## Install (unpacked)

1. Unzip `refresh-radar.zip` somewhere permanent (not Downloads — Chrome reloads it from
   this folder every launch).
2. Open `chrome://extensions` → **Developer mode** → **Load unpacked** → select the
   `refresh-radar` folder.
3. Pin the icon to the toolbar.

Windows: allow notifications for Chrome in **Settings → System → Notifications** and turn
off Focus Assist, or toasts get swallowed silently.

## The thing that actually matters

Timers inside a web page are throttled when the tab is hidden and **stop entirely when the
window is minimized**. That is why refresh extensions quietly stall the moment you look
away — the very situation you started them for.

Refresh Radar never puts the clock in the page:

- an **offscreen document** owns every deadline and ticks four times a second;
- the **background worker** performs the reload with `chrome.tabs.reload()`, which does not
  care whether the tab is visible;
- a keepalive port holds the worker awake, and a **once-a-minute alarm sweep** fires
  anything overdue if either is ever suspended;
- a tab Chrome **discarded** to reclaim memory is revived by its next scheduled reload.

Verified in headless Chromium: with the watched tab behind another tab and the window
reporting `minimized`, a 2-second watch logged 4 reloads in 11 seconds.

## Popup

**Interval** — Fixed, Random range, or Custom (h/m/s) · stepper with 2s–15m presets ·
hard refresh · **prevent form resubmission** (reloads as a fresh visit, no re-post prompt) ·
set refresh number · only while backgrounded · pause while you're using the page · retry
failed loads · pause on captcha · keep the computer awake · stop if the tab navigates away ·
auto scroll restoration · form-field restore.

**Timer** — visual on-page countdown in four styles (compact monitor, progress ring,
minimal dot, top progress bar) and any corner · **don't restart the timer on page update** ·
first-reload delay · begin-at and stop-at date/time · live session stats.

**Tabs** — every watch running right now with its live countdown, reload count and
keywords; click to jump, × to stop one · watch a URL in a pinned background tab · apply the
current setup to all tabs · stop all.

**Monitor** — Found / Lost / Change · a **keyword list** rather than one box: add as many
terms as you like, each auto-tagged **text**, **regex**, **CSS** or **XPath** (or set the
type yourself), click a tag to mute a term without deleting it · **Match any / Match all** ·
import and export keyword files · one-click defaults · saved templates · monitored area by
selector or by clicking **Pick** and choosing the region with your mouse · search HTML
source · real-time DOM detection · wait-before-scanning.

*On detection*: highlight the keyword · scroll to it · flash a banner · **auto-click** the
match or a named target, optionally in a new tab · run your own JavaScript on load and on
match.

*Alerts*: desktop notification (optionally sticky) · sound — beep, ding, chime, alarm,
siren **or your own audio file**, with repeat count, volume and preview · focus the window
(it un-minimizes) · **continue refreshing after a match** · alert once · copy match to
clipboard · webhook POST.

## Settings page

A proper sidebar: autostart profiles with URL patterns, keyword templates, a library of
ready-made regexes, alert sound, notification defaults, hotkeys, theme (dark / light /
system), Chrome-account sync, backup, and an honest "how it works" page.

Keyboard: `Alt+Shift+R` start/stop · `Alt+Shift+P` pause · `Alt+Shift+E` pick an element ·
`Alt+Shift+X` stop everything. The badge shows the live countdown, `||` paused, `ERR` on a
failed load, red `HIT` on a match.

### Autostart

Save a profile from the popup, then in Settings give it a URL pattern and switch on **Auto**.
Matching pages start watching themselves the moment they load, including after a browser
restart — sessions are re-bound to their tabs on startup. Patterns take a hostname, a
substring, a glob (`https://shop.*/item/*`) or a regex (`/item\/\d+/i`).

## Upgrading from v2

Old configs migrate automatically: a single query becomes a keyword list, `element appears`
becomes a CSS/XPath keyword in **Found** mode, `any of`/`all of` becomes Match any / Match all.

## Not included

**Email alerts** (needs a mail relay — point the webhook at Zapier/Make/n8n for the same
result), an **AI script or expression generator** (needs a paid API key — the settings page
ships a regex library instead) and a **script marketplace**. Sync uses your Chrome account,
so there is no sync key or device pairing to manage.

## Limits worth knowing

- Content scripts cannot run on `chrome://` pages, the Web Store, or other extensions' pages.
- **Change** mode needs one reload to set its baseline, so the first load never alerts.
- Page scripts are blocked on sites with a strict Content-Security-Policy.
- Form restore deliberately skips password, file and hidden inputs.
- Nothing leaves your machine unless you set a webhook yourself.

## Files

```
manifest.json     MV3 manifest, permissions, commands
background.js     state, keyword matching, scheduling, reloads, alerts, sync
offscreen.js      the clock (and alert audio) — the reason it survives minimizing
content.js        scanning, on-page actions, timer overlay, element picker
popup.html/.css/.js   four-tab control panel
options.html/.css/.js sidebar settings, profiles, templates, history
icons/            16/32/48/128 px
```

Tested end to end in headless Chromium: 11/11 checks including background/minimized
operation, match-any vs match-all, auto-detected CSS and XPath keywords, and v2 migration.

MIT-style: do whatever you like with it.
