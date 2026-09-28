# Changelog

## 4.0.0

Reliability release. "Hit or miss" had four separate causes, all now fixed.

- **Live re-checks were starving the reload timer.** Every report recomputed the
  next deadline, so a page that mutates — or the new scan loop — pushed the
  reload forward indefinitely and reloading quietly stopped. Live scans no
  longer touch the countdown; only a real page load reschedules.
- **A double-fire guard blocked short intervals.** It was fixed at 1.5s and
  returned without re-arming, so anything faster than that reloaded exactly
  once and then died. The guard is now proportional to the interval and always
  reschedules.
- **Scanning once per load missed slow apps.** A list that renders a second or
  two after load simply was not there when the scan ran. A scan loop (default
  every 500ms) keeps looking until the next reload. It is what makes detection
  independent of render timing.
- **A reclaimed clock stalled everything until the next minute.** The offscreen
  document now sends a heartbeat; if it goes quiet or the document is gone, the
  worker rebuilds it and re-arms immediately.

Recovery after a restart:

- Watches are **re-bound** on every worker start: exact URL, then same
  origin+path (list URLs carry params that drift), then parked.
- A **parked watch re-attaches itself** when a matching page loads again —
  after a window close, a browser restart or a reboot with session restore.
  Closing a single tab still ends the watch; closing the window does not.
- A session pointing at a dead tab id is re-bound instead of silently deleted.
- Parked watches are listed in the Tabs panel, so a waiting watch is visible
  rather than nothing at all.

Other:

- **Sub-second intervals**, down to 0.2s, with 0.5s the new default.
- **New defaults**: 0.5s reload, 500ms scan loop, notify with sound, in-page
  banner on, keep watching after a match, no focus stealing. A **Use
  recommended settings** button applies them to an existing setup.
- **Notification fallback**: if the OS refuses the toast (Focus Assist, Do Not
  Disturb, denied permission) the in-page banner is shown instead and the popup
  says how many were blocked.
- **Health readout** in the Timer tab: last scan, and how many times the watch
  recovered from a stall.
- Storage writes are coalesced, so a 2Hz watch does not write to disk twice a
  second.
- A **Reload the page** toggle: turn it off to watch a self-updating app
  without reloading it.

## 3.3.0

Plain find-in-page behaviour, and a way to see it before committing to a watch.

- **"Find on this page now"** in the Monitor tab runs the keyword search against
  the live page and reports a count per keyword, which scope it searched and how
  many frames it looked in — the answer to "would Ctrl+F match this?" without
  starting a watch.
- **New alert mode: "Every reload the word is found."** The scan always ran on
  every reload; only alerting was edge-triggered, so a word that stayed on the
  page was reported once and then went quiet. This mode alerts on every page
  load where the keyword is present, while still ignoring live DOM re-checks so
  a busy app cannot turn one reload into a burst. Choosing it clears a 60-second
  cooldown automatically, since the two contradict each other.
- **Matching now mirrors Ctrl+F on hidden content.** Text inside `display:none`
  or a `[hidden]` element is not matched. Text under `aria-hidden` *is* — it is
  still rendered, and find-in-page matches it; treating it as hidden was a
  divergence, caught by a test.

## 3.2.0

Column-scoped matching, so a keyword can be tied to one column of a table.

- **New monitored-area scope: Table column.** Give it a column heading —
  `Assigned to` — and only cells in that column are searched. A sidebar link, a
  saved-list name or a filter chip with the same wording is ignored. Works on
  real `<table>` markup and on ARIA grids (`role="grid"` / `columnheader` /
  `gridcell`), which is what component-based apps emit.
- **`(empty)` keyword.** Matches a blank cell in the scoped column. An
  unassigned row usually renders as an empty cell rather than the word
  "unassigned", so this is the one that actually catches it. `(blank)` and
  `(none)` work too.
- **Match excerpts name the row.** A column hit reports the whole row's text, so
  the notification says which record it was rather than just echoing the keyword.
- **CSS selectors now pierce shadow DOM.** `document.querySelector` cannot see
  into shadow roots, so monitored-area selectors, CSS keywords and auto-click
  targets silently failed on component-based apps. All of them now fall back to
  a shadow-piercing lookup. Shadow roots are collected once per scan rather than
  per query.

## 3.1.0

Fixes for single-page apps such as ServiceNow Agent Workspace.

- **The scanner was reading `<script>` contents.** When `innerText` returned empty — normal
  for an app shell that renders through components — it fell back to `textContent`, which
  includes script bodies. On ServiceNow that meant matching the inline i18n/JSON bundle, so
  a keyword like *Unassigned Incidents* "matched" a translation string. `script`, `style`,
  `noscript` and `template` are now excluded in every mode, and *search HTML source* strips
  inline script and style blocks before matching.
- **Content inside iframes is now scanned.** The content script runs in every frame;
  sub-frames only scan and report, while the top frame keeps the timer, overlay and reloads.
  Sub-frames contribute positive evidence only — a frame that cannot see a keyword proves
  nothing about the page.
- **Shadow DOM is now scanned.** Open shadow roots are walked, so web-component apps are
  readable. Both of these are toggles under Monitor → Monitored area.
- **One match no longer produces a burst of notifications.** Alerts are edge-triggered
  (fire when the condition *becomes* true) with a configurable cooldown, default 60s, plus
  duplicate-excerpt suppression. `alertMode: 'every'` restores per-scan alerting.
- **Race fixed:** reports from the page and its frames could arrive simultaneously, both
  see an active session and both alert. Message handling is serialized per tab.
- **Real-time detection actually runs on busy pages.** The MutationObserver used a plain
  debounce, which starves on a page that mutates continuously — the timer was reset before
  it could ever fire. It now forces a scan at least every two seconds while mutations
  continue.
- User scripts are injected into the top frame only.

## 3.0.0

- **Runs while the window is minimized.** Page timers are throttled when a tab is hidden
  and stop entirely when the window is minimized. The countdown moved into an offscreen
  document; the worker performs reloads via `chrome.tabs.reload()`; a keepalive port holds
  the worker awake and a once-a-minute alarm sweep catches anything overdue. Discarded tabs
  are revived by their next scheduled reload.
- **Multi-keyword monitoring.** A keyword list replaces the single query box, each entry
  auto-tagged text / regex / CSS / XPath, individually mutable, with Match any / Match all,
  import and export, defaults and saved templates.
- Modes simplified to Found / Lost / Change.
- Prevent form resubmission, set refresh number, visual timer in four styles and any
  corner, don't-restart-timer-on-page-update, auto-click with new-tab option,
  scroll-to-keyword, monitored area, continue-refreshing-after-match.
- Custom alert sound file plus five built-in tones with preview.
- Rebuilt UI: dark card-based four-tab popup and a sidebar settings page with theming.
- v2 configs migrate automatically.

## 2.0.0

- Scheduling (begin-at / stop-at), keep-computer-awake, retry on failed load, captcha
  detection and pause, stop-if-URL-changes.
- XPath support, visual element picker, highlight and scroll to match, auto-click,
  custom JavaScript hooks.
- Profiles with URL patterns and auto-start, keyword templates, regex library,
  Chrome-account sync, alert history, JSON export/import.

## 1.0.0

- Auto-refresh with fixed or randomised intervals, hard reload, reload caps, scroll and
  form restoration.
- Text appears / disappears / page changed / element appears / disappears, with contains,
  exact, regex, any-of and all-of matching.
- Desktop notifications, synthesised alert tones, focus tab, stop on match, webhook.
