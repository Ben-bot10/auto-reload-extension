# Refresh Radar — Auto Reload & Page Monitor

**v4.0** — a Chrome/Edge/Brave extension (Manifest V3) that auto-refreshes pages, watches
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

## Why it used to be hit and miss (4.0)

Four separate faults, each of which looked identical from the outside — nothing happens:

1. **Live re-checks pushed the reload deadline forward.** Every report recomputed the next
   deadline, so a page that mutates constantly kept postponing its own reload until
   reloading effectively stopped. Live scans no longer touch the countdown.
2. **A double-fire guard was fixed at 1.5 seconds** and returned without rescheduling, so
   any interval faster than that reloaded once and then died.
3. **Scanning happened once per load.** A list that renders a second or two after the page
   loads was not there yet, so the keyword was missed — reliably, on exactly the apps you
   care about.
4. **The clock document can be reclaimed by Chrome**, and nothing noticed until the
   once-a-minute alarm.

What's there now: a **scan loop** that keeps looking every 500ms until the next reload, a
**heartbeat** on the clock so a reclaimed one is rebuilt within seconds, and **watch
recovery** — after a window close, a browser restart or a reboot, a watch re-attaches to
its page by URL, or by origin and path when the query string has changed. Watches waiting
for their page are listed in the Tabs panel rather than vanishing.

If your OS swallows the notification — Focus Assist, Do Not Disturb, a denied permission —
an **in-page banner** appears instead, and the popup tells you how many were blocked. The
Timer tab shows the last scan time and how many times the watch recovered from a stall.

### Half-second watching

0.5s is the default and 0.2s is the floor. A caveat worth reading: **reloading a heavy app
every half second means it never finishes rendering**, so it will never match. For those,
turn **Reload the page** off on the Interval tab — the app refreshes its own list, and the
500ms scan loop catches the change. Reload fast for simple server-rendered pages; scan fast
for apps.

**Use recommended settings** on the Timer tab applies the defaults to an existing setup.

## Just find the word, like Ctrl+F (3.3)

The scan already runs on every reload. What tripped people up was *alerting*: it was
edge-triggered, so a word that stayed on the page was reported once and then went quiet.

Two controls make that explicit:

- **Monitor → Find on this page now** runs the search against the page in front of you and
  reports how many times each keyword appears, which scope it searched and how many frames
  it looked in. Use it before starting a watch to check a term actually matches.
- **Alert settings → Alert me → "Every reload the word is found"** alerts on every page load
  where the keyword is present. Live DOM re-checks are still ignored in this mode, so a busy
  app can't turn one reload into a burst. Picking it clears the 60-second cooldown for you.

Matching follows find-in-page rules: text inside `display:none` or a `[hidden]` element is
not matched; text under `aria-hidden` is, because it's still on screen.

One honest caveat: Ctrl+F is *page-wide*. On your ServiceNow list, searching `Unassigned`
that way will also hit the **Lists** sidebar, where a saved list is named "Unassigned
Incidents" — the same match that produced the noisy notification. Column scope below is how
you exclude it.

## Watching one column of a table (3.2)

Searching a whole page is often too broad. On a ServiceNow incident list the word
*Unassigned* appears in the **Lists** sidebar as a saved-list name, so a plain keyword
matches navigation rather than any record.

Under **Monitor → Monitored area**, set **Scope** to **Table column** and type the heading
exactly as it appears — `Assigned to`. Only cells under that column are searched. It works
on real `<table>` markup and on ARIA grids (`role="grid"`, `columnheader`, `gridcell`),
which is what component-based apps emit, and it reaches inside shadow roots and iframes.

For an unassigned row the cell is usually **blank** rather than containing the word
"unassigned", so the keyword to use is `(empty)`:

| Goal | Scope | Keyword |
|---|---|---|
| A row has nobody assigned | Table column → `Assigned to` | `(empty)` |
| A specific person gets assigned | Table column → `Assigned to` | `Kishan` |
| Any P1 appears | Table column → `Priority` | `1 - Critical` |
| A record leaves the list | Table column → `Number`, mode **Lost** | `INC9113871` |

Match excerpts report the whole row, so the notification tells you *which* record it was.

## Fixed in 3.1 — web apps like ServiceNow

Three things went wrong on single-page apps, and all three are fixed:

**It was reading the page's source code.** When `innerText` comes back empty — which happens
on app shells that render everything through components — the scanner fell back to
`textContent`, and that includes the body of every `<script>` tag. On ServiceNow that means
the embedded i18n bundle, so a keyword like *Unassigned Incidents* matched a translation
string rather than anything on screen. The scanner now skips `script`, `style`, `noscript`
and `template` outright, in every mode — including *search HTML source*, which strips inline
script and style blocks before matching.

**It couldn't see the actual app.** Those apps render inside iframes and shadow DOM, both
invisible to a plain text read. The content script now runs in every frame (sub-frames scan
and report; only the top frame owns the timer, the overlay and reloads) and walks open
shadow roots. Toggles for both live under **Monitor → Monitored area**.

**One match produced a burst of notifications.** Three causes, three fixes:

- Alerts are now **edge-triggered** — they fire when the condition *becomes* true, not on
  every scan while it stays true. Switch to *Every time a scan matches* under **Alert
  settings** if you want the old behaviour.
- A **cooldown** (default 60s) and duplicate-excerpt suppression cap the rate regardless.
- Reports from the page and its frames could arrive simultaneously and both see an active
  session, so both alerted. Message handling is now serialized per tab.

A fourth bug surfaced during testing: on a page that mutates non-stop, the real-time
detector's debounce timer was reset before it could ever fire, so live detection silently
never ran. It now forces a scan at least every two seconds while mutations continue.

**If you're watching a ServiceNow list**, leave *Look inside iframes*, *Deep scan
components* and *Only when the condition changes* on, and keep the cooldown at 60s.

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
source · real-time DOM detection · **look inside iframes** · **deep scan** of shadow DOM ·
wait-before-scanning.

*On detection*: highlight the keyword · scroll to it · flash a banner · **auto-click** the
match or a named target, optionally in a new tab · run your own JavaScript on load and on
match.

*Alerts*: **alert mode** (only when the condition changes / every matching scan) and a
**minimum gap between alerts** · desktop notification (optionally sticky) · sound — beep, ding, chime, alarm,
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

Tested end to end in headless Chromium: 11/11 core checks (background/minimized operation,
match-any vs match-all, auto-detected CSS and XPath keywords, v2 migration) plus 9/9
single-page-app checks against a ServiceNow-shaped fixture — a page whose keyword exists
only inside an inline JSON bundle, one that hides it in a shadow root, one that hides it in
an iframe, and one that mutates every 150ms.

MIT-style: do whatever you like with it.
