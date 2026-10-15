// Sieve — frontend. Vanilla JS, no build step. Talks to server.py over /api/*.
"use strict";

/* ===================================================================== helpers */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.flush = (...a) => { clearTimeout(t); return fn(...a); }; return d; };
const fmtNum = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN"));
const compactNum = (n) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n || 0);
const money = (n, cur = "USD") => (n == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: (cur || "USD").toUpperCase(), maximumFractionDigits: n < 1 ? 3 : 2 }).format(n));
const ts = (iso) => (iso ? new Date(iso).getTime() : 0);
function relTime(iso) {
  if (!iso) return "";
  const d = ts(iso) - Date.now(), a = Math.abs(d), fut = d > 0;
  if (a < 45e3) return fut ? "in a moment" : "now";
  const m = Math.round(a / 6e4), h = Math.round(a / 36e5), dd = Math.round(a / 864e5);
  if (m < 60) return fut ? `in ${m} min` : `${m} min ago`;
  if (h < 24) return fut ? `in ${h} h` : `${h} h ago`;
  if (dd === 1) return fut ? "tomorrow" : "yesterday";
  return fut ? `in ${dd} days` : `${dd} days ago`;
}
function dur(ms) {
  if (ms == null || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const runMs = (r) => (r.started_at ? (r.finished_at ? ts(r.finished_at) : Date.now()) - ts(r.started_at) : null);
const isActive = (st) => st === "queued" || st === "running" || st === "retrying";
const STATUS = { queued: "Queued", running: "Running", retrying: "Retrying", completed: "Completed", failed: "Failed", cancelled: "Stopped" };
const pill = (st) => `<span class="pill ${esc(st)}">${STATUS[st] || esc(st)}</span>`;
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const sameMonth = (iso) => { const d = new Date(iso), n = new Date(); return d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear(); };
const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return u; } };
const pathOf = (u) => { try { const x = new URL(u); return (x.pathname + x.search) || "/"; } catch { return u; } };
const isUrl = (v) => typeof v === "string" && /^https?:\/\//i.test(v);

function estimate(r) {
  const pages = r.mode === "page" ? 1 : Math.max(1, r.max_pages || 1);
  const expected = r.trigger === "test" ? 7 : 8 + (pages - 1) * 6;
  const steps = r.steps_count || 0;
  if (r.status === "completed") return { pct: 100, eta: 0, expected };
  if (r.status === "queued") return { pct: 2, eta: null, expected };
  if (!isActive(r.status)) return { pct: Math.min(100, Math.round((steps / expected) * 100)), eta: null, expected };
  const pct = Math.max(4, Math.min(95, Math.round((steps / expected) * 100)));
  const ms = runMs(r) || 0;
  const per = steps ? ms / steps : 6000;
  return { pct, eta: Math.max(0, (expected - steps) * per), expected };
}
const barCls = (st) => ({ completed: "", running: "blue live", retrying: "orange live", queued: "grey", failed: "red", cancelled: "grey" }[st] ?? "grey");

async function copyText(text, msg = "Copied to clipboard") {
  try { await navigator.clipboard.writeText(text); }
  catch { const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove(); }
  toast(msg);
}

function toast(msg, opts = {}) {
  const el = document.createElement("div");
  el.className = "toast" + (opts.err ? " err" : "");
  el.innerHTML = `<span>${esc(msg)}</span>` + (opts.link ? `<a href="${esc(opts.link.href)}">${esc(opts.link.label)}</a>` : "");
  $("#toasts").appendChild(el);
  setTimeout(() => el.classList.add("out"), opts.ms || 3200);
  setTimeout(() => el.remove(), (opts.ms || 3200) + 250);
}

async function api(method, path, body) {
  if (S.cloud) return window.SieveCloud.api(method, path, body || {});
  const res = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

/* ===================================================================== icons */
const sv = (d, size = 18, sw = 1.7) => `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const I = {
  logo: (s = 26) => `<svg aria-hidden="true" width="${s}" height="${s}" viewBox="0 0 26 26" fill="none"><rect x="1" y="1" width="24" height="24" rx="8" stroke="var(--accent)" stroke-width="1.6"/><path d="M7 9h12M9 13h8M11 17h4" stroke="var(--accent)" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  grid: (s) => sv('<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>', s),
  extract: (s) => sv('<path d="M4 6h16M7 12h10M10 18h4"/>', s),
  db: (s) => sv('<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>', s),
  clock: (s) => sv('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', s),
  globe: (s) => sv('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>', s),
  code: (s) => sv('<path d="M8 9l-4 3 4 3M16 9l4 3-4 3M13.5 6l-3 12"/>', s),
  search: (s = 16) => sv('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>', s, 2),
  bell: (s) => sv('<path d="M6 9a6 6 0 1112 0c0 6 2 7 2 7H4s2-1 2-7M10 20a2 2 0 004 0"/>', s),
  link: (s = 18) => sv('<path d="M10 14a4 4 0 005.66 0l3-3a4 4 0 00-5.66-5.66l-1 1M14 10a4 4 0 00-5.66 0l-3 3a4 4 0 005.66 5.66l1-1"/>', s, 1.8),
  arrow: (s = 16) => sv('<path d="M5 12h14M13 6l6 6-6 6"/>', s, 2.2),
  down: (s = 14) => sv('<path d="M6 9l6 6 6-6"/>', s, 2),
  plus: (s = 18) => sv('<path d="M12 5v14M5 12h14"/>', s, 2.2),
  dl: (s = 16) => sv('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>', s, 2.2),
  stop: (s = 14) => `<svg aria-hidden="true" width="${s}" height="${s}" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>`,
  more: (s = 18) => sv('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>', s, 2),
  left: (s = 14) => sv('<path d="M15 6l-6 6 6 6"/>', s, 2),
  right: (s = 14) => sv('<path d="M9 6l6 6-6 6"/>', s, 2),
  box: (s = 36) => `<svg aria-hidden="true" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="#A3A9B5" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>`,
  copy: (s = 14) => sv('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>', s, 2),
};
const ring = (pct, size = 96, label) => {
  const C = 2 * Math.PI * 40, on = (Math.max(0, Math.min(100, pct)) / 100) * C;
  return `<svg role="img" aria-label="${pct} percent complete" width="${size}" height="${size}" viewBox="0 0 96 96" style="flex:none">
    <circle cx="48" cy="48" r="40" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="8"/>
    <circle cx="48" cy="48" r="40" fill="none" stroke="var(--accent)" stroke-width="8" stroke-linecap="round" stroke-dasharray="${on.toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 48 48)" style="transition:stroke-dasharray .6s ease"/>
    <text x="48" y="54" text-anchor="middle" fill="#EDEFF3" font-size="20" font-family="Geist Mono, monospace">${label ?? pct + "%"}</text></svg>`;
};

const ACCENTS = ["#C8F169", "#7DD3FC", "#F5A97F", "#C4B5FD"];
const FIELD_COLORS = ["#C8F169", "#7DD3FC", "#F5A97F", "#C4B5FD", "#F9A8D4", "#FDE68A", "#86EFAC", "#A5B4FC"];
const FIELD_TYPES = ["text", "number", "integer", "boolean", "url", "date", "list"];
const fieldColor = (i) => FIELD_COLORS[i % FIELD_COLORS.length];

function setAccent(hex) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const mix = (c) => Math.round(c + (255 - c) * 0.45);
  const root = document.documentElement.style;
  root.setProperty("--accent", hex);
  root.setProperty("--accent-rgb", `${r}, ${g}, ${b}`);
  root.setProperty("--accent-hi", `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`);
}

/* ===================================================================== state */
const S = {
  state: null,           // /api/state
  wallet: null,
  route: { view: "workspace" },
  run: null,             // full run for dataset view
  runCache: {},          // id -> full run (for diffs / tests)
  ds: { tab: "table", page: 0, sort: null, q: "" },
  ex: null, exSaved: true, sel: null, adding: false,
  schedForm: false, schedPrefill: null,
  dsFilter: "all", dsQuery: "",
  form: null,
  lastSeen: store.get("sieve.lastSeen", 0),
};
const settings = () => (S.state && S.state.settings) || {};
const runsAll = () => (S.state ? S.state.runs : []);
const runsReal = () => runsAll().filter((r) => r.trigger !== "test");
const exById = (id) => (S.state?.extractors || []).find((e) => e.id === id);

/* ===================================================================== routing */
function parseRoute() {
  const parts = (location.hash.replace(/^#\/?/, "") || "").split("/").filter(Boolean);
  const [a, b] = parts;
  if (!a) return { view: innerWidth <= 760 && !sessionStorage.getItem("sieve.ws") ? "runs" : "workspace" };
  if (a === "datasets") return b ? { view: "dataset", id: b } : { view: "datasets" };
  if (a === "extractors") return { view: "extractors", id: b };
  if (["runs", "schedules", "proxies", "api", "alerts", "workspace"].includes(a)) return { view: a };
  return { view: "workspace" };
}
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
addEventListener("hashchange", () => { closeOverlays(); render(); scrollTo(0, 0); });

/* ===================================================================== shell: sidebar, bottom nav, top bar */
const NAV = [
  { v: "workspace", href: "#/workspace", label: "Workspace", icon: I.grid },
  { v: "extractors", href: "#/extractors", label: "Extractors", icon: I.extract },
  { v: "datasets", href: "#/datasets", label: "Datasets", icon: I.db, also: ["dataset"] },
  { v: "schedules", href: "#/schedules", label: "Schedules", icon: I.clock },
  { v: "proxies", href: "#/proxies", label: "Proxies", icon: I.globe },
  { v: "api", href: "#/api", label: "API & webhooks", icon: I.code },
];

function walletCard() {
  const w = S.wallet, set = settings();
  const monthRuns = runsReal().filter((r) => sameMonth(r.created_at));
  if (!set.has_key) {
    return `<div class="credits"><div class="row"><span>TinyFish</span><span class="mono">Not connected</span></div>
      <div class="bar"><i style="width:0%"></i></div><a href="#/api">Add your API key →</a></div>`;
  }
  if (w && w.available) {
    const spent = monthRuns.reduce((s, r) => s + (r.cost || 0), 0);
    const pct = spent + w.balance > 0 ? Math.round((spent / (spent + w.balance)) * 100) : 0;
    const steps = w.step_rate ? Math.floor(w.balance / w.step_rate) : null;
    return `<div class="credits"><div class="row"><span>Credits this month</span><span class="mono">${pct}%</span></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <small>${money(spent, w.currency)} spent · ${money(w.balance, w.currency)} left${steps != null ? ` (~${compactNum(steps)} steps)` : ""}</small>
      <a href="https://agent.tinyfish.ai/wallet" target="_blank" rel="noopener">Add funds →</a></div>`;
  }
  return `<div class="credits"><div class="row"><span>Runs this month</span><span class="mono">${monthRuns.length}</span></div>
    <div class="bar"><i style="width:${Math.min(100, monthRuns.length * 4)}%"></i></div>
    <a href="https://agent.tinyfish.ai" target="_blank" rel="noopener">Open TinyFish →</a></div>`;
}

function renderShell() {
  const v = S.route.view;
  const active = runsReal().filter((r) => isActive(r.status)).length;
  const enabledSched = (S.state?.schedules || []).filter((s) => s.enabled).length;
  $("#side").className = "side" + (v === "workspace" ? "" : " rail");
  $("#side").innerHTML = `
    <a class="brand" href="#/workspace" aria-label="Sieve home">${I.logo()}<b>Sieve</b></a>
    ${NAV.map((n) => {
      const cur = n.v === v || (n.also || []).includes(v);
      const count = n.v === "datasets" && active ? `<span class="count">${active}</span>` : n.v === "schedules" && enabledSched ? `<span class="count" style="color:var(--soft);background:rgba(255,255,255,.08)">${enabledSched}</span>` : "";
      return `<a class="nav-link${n.v === "datasets" && active ? " has-live" : ""}" href="${n.href}" title="${n.label}" ${cur ? 'aria-current="page"' : ""}>${n.icon(18)}<span>${n.label}</span>${count}</a>`;
    }).join("")}
    <div class="side-grow"></div>
    ${walletCard()}`;
  const unread = notifications().some((n) => n.unread);
  $("#bottomNav").innerHTML = [
    ["runs", "#/runs", "Runs", I.grid(20)], ["datasets", "#/datasets", "Datasets", I.db(20)],
    ["schedules", "#/schedules", "Schedules", I.clock(20)], ["alerts", "#/alerts", "Alerts", I.bell(20)],
  ].map(([k, href, label, ic]) => `<a href="${href}" aria-label="${label}" ${k === v || (k === "datasets" && v === "dataset") ? 'aria-current="page"' : ""}>${ic}${k === "alerts" && unread ? '<span class="dot"></span>' : ""}</a>`).join("");
  document.body.dataset.view = v;
}

function topBar(crumbs) {
  const s = settings(), unread = notifications().some((n) => n.unread);
  return `<header class="top">
    <div class="crumbs">${crumbs}</div>
    <div class="top-right">
      <button class="search-box" type="button" data-act="palette" aria-label="Search runs, datasets, extractors">${I.search()}<span class="ph">Search runs, datasets, extractors</span><span class="kbd">⌘K</span></button>
      <button class="icon-btn m-search" type="button" data-act="palette" aria-label="Search">${I.search(18)}</button>
      <button class="icon-btn bell" type="button" data-act="notifs" aria-label="Notifications">${I.bell(18)}${unread ? '<span class="dot"></span>' : ""}</button>
      <button class="avatar" type="button" data-act="profile" aria-label="${esc(s.user || "Profile")}">${esc((s.user || "S")[0].toUpperCase())}</button>
    </div></header>`;
}
const ws = () => esc(`Team ${settings().workspace || "Sieve"}`);

/* ===================================================================== notifications */
function notifications() {
  return runsReal().filter((r) => ["completed", "failed", "cancelled"].includes(r.status) && r.finished_at)
    .sort((a, b) => ts(b.finished_at) - ts(a.finished_at)).slice(0, 20)
    .map((r) => ({
      run: r, unread: ts(r.finished_at) > S.lastSeen,
      title: r.status === "completed" ? `${r.name} — ${fmtNum(r.row_count)} rows` : r.status === "failed" ? `${r.name} failed` : `${r.name} stopped`,
      sub: (r.status === "failed" ? (r.error_title || "Run failed") + " · " : "") + relTime(r.finished_at) + (r.trigger === "schedule" ? " · scheduled" : ""),
    }));
}
function markSeen() { S.lastSeen = Date.now(); store.set("sieve.lastSeen", S.lastSeen); }
const notifList = () => {
  const list = notifications();
  return list.length ? list.map((n) => `<a class="notif${n.unread ? " unread" : ""}" href="#/datasets/${n.run.id}"><span class="sdot ${n.run.status}"></span><span class="tx"><b>${esc(n.title)}</b><span>${esc(n.sub)}</span></span></a>`).join("")
    : `<div class="panel-empty">No alerts yet. Finished runs show up here.</div>`;
};

/* ===================================================================== overlays: menus, popovers, palette, sheet */
let menuClose = null;
function openMenu(anchor, html, { align = "left", width } = {}) {
  closeOverlays();
  const host = $("#popHost");
  host.innerHTML = `<div class="menu" role="menu" style="position:fixed;${width ? `width:${width}px;` : ""}">${html}</div>`;
  const m = host.firstElementChild, r = anchor.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  let left = align === "right" ? r.right - w : r.left;
  left = Math.max(12, Math.min(left, innerWidth - w - 12));
  let top = r.bottom + 8;
  if (top + h > innerHeight - 12) top = Math.max(12, r.top - h - 8);
  m.style.left = left + "px"; m.style.top = top + "px";
  menuClose = () => { host.innerHTML = ""; menuClose = null; };
  return m;
}
function openPanel(anchor, html) {
  closeOverlays();
  const host = $("#popHost");
  host.innerHTML = `<div class="pop-panel">${html}</div>`;
  const p = host.firstElementChild, r = anchor.getBoundingClientRect();
  p.style.top = Math.max(12, Math.min(r.bottom + 8, innerHeight - p.offsetHeight - 12)) + "px";
  p.style.left = Math.max(12, Math.min(r.right - p.offsetWidth, innerWidth - p.offsetWidth - 12)) + "px";
  menuClose = () => { host.innerHTML = ""; menuClose = null; };
  return p;
}
function closeOverlays() {
  menuClose?.();
  $("#palette").classList.remove("show");
  $("#sheet").classList.remove("show");
  $("#scrim").classList.remove("show");
  sheetRunId = null;
}
$("#scrim").addEventListener("click", closeOverlays);
document.addEventListener("mousedown", (e) => {
  if (menuClose && !e.target.closest("#popHost") && !e.target.closest("[data-keep-menu]")) menuClose();
});

/* command palette */
let palItems = [], palIdx = 0;
function openPalette() {
  closeOverlays();
  $("#scrim").classList.add("show");
  $("#palette").classList.add("show");
  $("#paletteInput").value = "";
  palIdx = 0;
  renderPalette();
  setTimeout(() => $("#paletteInput").focus(), 30);
}
function renderPalette() {
  const q = $("#paletteInput").value.trim().toLowerCase();
  const match = (...s) => !q || s.join(" ").toLowerCase().includes(q);
  const groups = [
    ["Actions", [
      { t: "New extraction", s: "Paste a URL and describe the data", go: "#/workspace", focus: true },
      { t: "New extractor", s: "Build a reusable schema", go: "#/extractors/new" },
      { t: "New schedule", s: "Run an extractor automatically", act: () => { S.schedForm = true; go("#/schedules"); } },
      { t: "API & webhooks", s: "TinyFish key, wallet, webhook, REST API", go: "#/api" },
      { t: "Proxies & anti-bot", s: "Stealth, proxy country, robots.txt", go: "#/proxies" },
      { t: "Run monitor", s: "Follow the active run", go: "#/runs" },
    ].filter((x) => match(x.t, x.s))],
    ["Extractors", (S.state?.extractors || []).filter((e) => match(e.name, e.url)).slice(0, 8).map((e) => ({ t: e.name, s: e.url, go: `#/extractors/${e.id}` }))],
    ["Datasets", runsReal().filter((r) => match(r.name, r.host, "#" + r.num)).slice(0, 10).map((r) => ({ t: r.name, s: `Run #${r.num} · ${STATUS[r.status]} · ${r.row_count ? fmtNum(r.row_count) + " rows · " : ""}${relTime(r.created_at)}`, go: `#/datasets/${r.id}`, st: r.status }))],
  ].filter(([, items]) => items.length);
  palItems = groups.flatMap(([, items]) => items);
  palIdx = Math.min(palIdx, Math.max(0, palItems.length - 1));
  let i = 0;
  $("#paletteList").innerHTML = groups.length ? groups.map(([label, items]) => `<li class="lbl">${label}</li>` + items.map((x) => {
    const idx = i++;
    return `<li class="it" role="option" data-pi="${idx}" aria-selected="${idx === palIdx}">${x.st ? `<span class="sdot ${x.st}"></span>` : `<span class="dim">${I.arrow(14)}</span>`}<span class="tx"><b>${esc(x.t)}</b><span>${esc(x.s)}</span></span></li>`;
  }).join("")).join("") : `<li class="empty">Nothing matches “${esc(q)}”.</li>`;
}
function runPalette(i) {
  const x = palItems[i]; if (!x) return;
  closeOverlays();
  if (x.focus) sessionStorage.setItem("sieve.ws", "1");
  if (x.act) x.act(); else go(x.go);
  if (x.focus) setTimeout(() => $("#url")?.focus(), 80);
}
$("#paletteInput").addEventListener("input", () => { palIdx = 0; renderPalette(); });
$("#paletteInput").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); palIdx = Math.min(palItems.length - 1, palIdx + 1); renderPalette(); $(`[data-pi="${palIdx}"]`)?.scrollIntoView({ block: "nearest" }); }
  else if (e.key === "ArrowUp") { e.preventDefault(); palIdx = Math.max(0, palIdx - 1); renderPalette(); $(`[data-pi="${palIdx}"]`)?.scrollIntoView({ block: "nearest" }); }
  else if (e.key === "Enter") { e.preventDefault(); runPalette(palIdx); }
});
$("#paletteList").addEventListener("click", (e) => { const li = e.target.closest("[data-pi]"); if (li) runPalette(+li.dataset.pi); });

function logHtml(steps, active) {
  if (!steps || !steps.length) return `<ul class="log"><li class="sys"><i></i><span>Waiting for the agent…</span><time></time></li></ul>`;
  const lastStep = active ? steps.map((s) => s.kind).lastIndexOf("step") : -1;
  return `<ul class="log">${steps.map((s, i) => `<li class="${s.kind === "step" ? (i === lastStep ? "cur" : "") : s.kind}"><i></i><span>${esc(s.text)}</span><time>${new Date(s.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></li>`).join("")}</ul>`;
}
let sheetRunId = null;
function openSheet(run) {
  closeOverlays();
  sheetRunId = run.id;
  $("#sheetTitle").textContent = `Run #${run.num} · ${run.name}`;
  $("#sheetBody").innerHTML = logHtml(run.steps, isActive(run.status));
  $("#scrim").classList.add("show");
  $("#sheet").classList.add("show");
  const b = $("#sheetBody"); b.scrollTop = b.scrollHeight;
}

/* ===================================================================== global actions (data-act) */
const ACT = {
  "close-overlays": closeOverlays,
  "copy-code"(el) { copyText(el.parentElement.firstChild.textContent, "Command copied"); },
  "local-only"() { toast("Database sync and webhooks work when you run Sieve on your computer (python3 server.py)"); },
  palette: openPalette,
  notifs(el) {
    const p = openPanel(el, `<div class="ph"><b>Notifications</b><button data-act="mark-read">Mark all read</button></div><div class="notifs">${notifList()}</div>`);
    p.addEventListener("click", (e) => { if (e.target.closest("a")) { markSeen(); closeOverlays(); } });
  },
  "mark-read"() { markSeen(); closeOverlays(); renderShell(); refreshTop(); if (S.route.view === "alerts") render(); },
  profile(el) {
    const s = settings();
    const p = openPanel(el, `<div class="ph"><b>Profile</b><span class="dim mono" style="font-size:12px">this computer</span></div>
      <div class="prof">
        <label class="field">Your name<input class="input" id="pfUser" value="${esc(s.user || "")}" maxlength="40" /></label>
        <label class="field">Workspace<input class="input" id="pfWs" value="${esc(s.workspace || "")}" maxlength="40" /></label>
        <div class="field">Accent<div class="swatches">${ACCENTS.map((c) => `<button type="button" data-act="accent" data-c="${c}" aria-label="Accent ${c}" aria-pressed="${c.toLowerCase() === (s.accent || "").toLowerCase()}" style="background:${c}"></button>`).join("")}</div></div>
        <div class="note-plain" style="font-size:12px"><b class="mono">⌘K</b> or <b class="mono">/</b> search · <b class="mono">N</b> new extraction · <b class="mono">Esc</b> close</div>
      </div>`);
    const save = debounce(async () => { await saveSettings({ user: $("#pfUser").value.trim() || "You", workspace: $("#pfWs").value.trim() || "Sieve" }); refreshTop(); }, 400);
    $("#pfUser", p).addEventListener("input", save); $("#pfWs", p).addEventListener("input", save);
  },
  async accent(el) {
    setAccent(el.dataset.c);
    $$("[data-act=accent]").forEach((b) => b.setAttribute("aria-pressed", String(b === el)));
    await saveSettings({ accent: el.dataset.c });
  },
};
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || el.disabled) return;
  const fn = ACT[el.dataset.act] || VIEW()?.acts?.[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
  if (e.key === "Escape") { closeOverlays(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  if (e.key === "/") { e.preventDefault(); openPalette(); }
  else if (e.key.toLowerCase() === "n") { e.preventDefault(); sessionStorage.setItem("sieve.ws", "1"); go("#/workspace"); setTimeout(() => $("#url")?.focus(), 60); }
});

async function saveSettings(patch) {
  try { const r = await api("POST", "/api/settings", patch); S.state.settings = r.settings; return r.settings; }
  catch (err) { toast(err.message, { err: true }); throw err; }
}

/* ===================================================================== data refresh loop */
async function refreshState() {
  try { S.state = await api("GET", "/api/state"); }
  catch {
    const why = location.protocol === "file:"
      ? `This page was opened as a file. Run <span class="mono">python3 server.py</span> in the project folder and open the <b>http://localhost:…</b> address it prints instead.`
      : `Nothing at <span class="mono">${esc(location.host)}</span> answered like Sieve — another app may be using this port. Run <span class="mono">python3 server.py</span> and open the exact address it prints (e.g. <span class="mono">http://localhost:8001</span>).`;
    if (!S.state) $("#view").innerHTML = `<div class="err-card" style="margin-top:40px"><div class="ico">!</div><div><h3>Can't reach the Sieve server</h3><p>${why}</p><button class="btn" onclick="location.reload()">Reload</button></div></div>`;
    return false;
  }
  return true;
}
async function refreshWallet(force) {
  try { S.wallet = await api("GET", "/api/wallet" + (force ? "?force=1" : "")); } catch { S.wallet = null; }
}
async function fetchRun(id) {
  const r = await api("GET", `/api/runs/${id}`);
  S.runCache[id] = r;
  return r;
}
let tickTimer = null, lastWallet = 0, ticking = false;
const sig = () => JSON.stringify(runsAll().map((r) => [r.id, r.status, r.steps_count, r.row_count, r.deliveries]).concat([(S.state?.schedules || []).map((s) => [s.id, s.enabled, s.next_at, s.last_run_id])]));
async function tick() {
  clearTimeout(tickTimer);
  if (ticking) return;
  ticking = true;
  try {
    const before = sig();
    const ok = await refreshState();
    if (ok) {
      if (Date.now() - lastWallet > 60000) { lastWallet = Date.now(); refreshWallet().then(renderShell); }
      const changed = before !== sig();
      for (const id of VIEW()?.liveIds?.() || []) {
        const sum = runsAll().find((r) => r.id === id);
        const cached = S.runCache[id];
        if (!cached || isActive(cached.status) || (sum && (sum.status !== cached.status || sum.steps_count !== cached.steps_count))) {
          try { await fetchRun(id); } catch {}
        }
      }
      if (changed) { renderShell(); refreshTop(); }
      VIEW()?.update?.(changed);
      if (sheetRunId && S.runCache[sheetRunId]) {
        const r = S.runCache[sheetRunId], b = $("#sheetBody"), atEnd = b.scrollTop + b.clientHeight >= b.scrollHeight - 30;
        b.innerHTML = logHtml(r.steps, isActive(r.status));
        if (atEnd) b.scrollTop = b.scrollHeight;
      }
      notifyFinished();
    }
  } finally { ticking = false; }
  const anyActive = runsAll().some((r) => isActive(r.status));
  tickTimer = setTimeout(tick, anyActive ? 1200 : 6000);
}
let knownStatus = null;
function notifyFinished() {
  const now = Object.fromEntries(runsAll().map((r) => [r.id, r.status]));
  if (knownStatus) {
    for (const r of runsReal()) {
      if (isActive(knownStatus[r.id]) && !isActive(r.status)) {
        const here = S.route.view === "dataset" && S.route.id === r.id;
        if (!here) toast(r.status === "completed" ? `${r.name}: ${fmtNum(r.row_count)} rows ready` : `${r.name}: ${STATUS[r.status].toLowerCase()}`, { err: r.status === "failed", link: { href: `#/datasets/${r.id}`, label: "Open" } });
        lastWallet = 0;
      }
    }
  }
  knownStatus = now;
}
function refreshTop() {
  const t = $(".top"); if (!t) return;
  const unread = notifications().some((n) => n.unread);
  const bell = $(".bell", t); if (bell) bell.innerHTML = I.bell(18) + (unread ? '<span class="dot"></span>' : "");
  const av = $(".avatar", t); if (av) av.textContent = (settings().user || "S")[0].toUpperCase();
  const c = $(".crumbs .ws", t); if (c) c.textContent = `Team ${settings().workspace || "Sieve"}`;
}

/* ===================================================================== shared renderers */
function runRow(r) {
  const e = estimate(r);
  const when = r.status === "queued" ? "queued" : isActive(r.status) ? "now" : relTime(r.finished_at || r.created_at);
  return `<a class="run-row" href="#/datasets/${r.id}">
    <div class="nm"><b>${esc(r.name)}${r.trigger === "test" ? ' <span class="chip-tag">test</span>' : r.trigger === "schedule" ? ' <span class="chip-tag">scheduled</span>' : ""}</b><span>${esc(r.host)}</span></div>
    ${pill(r.status)}
    <div class="bar ${barCls(r.status)}"><i style="width:${e.pct}%"></i></div>
    <span class="rows">${r.status === "completed" ? fmtNum(r.row_count) + " rows" : isActive(r.status) ? `${r.steps_count} steps` : "0 rows"}</span>
    <span class="when">${esc(when)}</span></a>`;
}

function inferType(values) {
  const v = values.filter((x) => x != null && x !== "");
  if (!v.length) return "text";
  if (v.every((x) => typeof x === "boolean")) return "boolean";
  if (v.every((x) => typeof x === "number")) return v.every(Number.isInteger) ? "integer" : "number";
  if (v.every((x) => Array.isArray(x))) return "list";
  if (v.every((x) => isUrl(x))) return "url";
  return "text";
}
function columnsOf(run) {
  if (run.fields && run.fields.length) return run.fields.map((f) => ({ key: f.key, type: f.type }));
  const keys = [];
  (run.rows || []).forEach((r) => Object.keys(r).forEach((k) => { if (!keys.includes(k)) keys.push(k); }));
  return keys.map((k) => ({ key: k, type: inferType((run.rows || []).map((r) => r[k])) }));
}
function cell(v, type, first) {
  if (v == null || v === "") return `<td class="${first ? "first" : ""}"><span class="nil">—</span></td>`;
  if (type === "boolean" || typeof v === "boolean") return `<td><span class="bool ${v ? "t" : "f"}">${v ? "true" : "false"}</span></td>`;
  if (Array.isArray(v)) return `<td><div class="tag-list">${v.slice(0, 6).map((x) => `<span class="chip-tag">${esc(typeof x === "object" ? JSON.stringify(x) : x)}</span>`).join("")}${v.length > 6 ? `<span class="dim">+${v.length - 6}</span>` : ""}</div></td>`;
  if (typeof v === "object") return `<td class="u"><span class="clip">${esc(JSON.stringify(v))}</span></td>`;
  if (typeof v === "number") return `<td class="num">${esc(v.toLocaleString("en-IN", { maximumFractionDigits: 2 }))}</td>`;
  if (isUrl(v)) return `<td class="u"><a href="${esc(v)}" target="_blank" rel="noopener" title="${esc(v)}">${esc(pathOf(v).slice(0, 48))}</a></td>`;
  return `<td class="${first ? "first" : ""}"><span class="clip" title="${esc(v)}">${esc(v)}</span></td>`;
}
function jsonHtml(obj) {
  return esc(JSON.stringify(obj, null, 2))
    .replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)/g, '<span class="k">$1</span>$2')
    .replace(/:\s(&quot;(?:[^&]|&(?!quot;))*?&quot;)/g, ': <span class="s">$1</span>')
    .replace(/:\s(-?\d+(?:\.\d+)?)/g, ': <span class="n">$1</span>')
    .replace(/:\s(true|false)/g, ': <span class="b">$1</span>')
    .replace(/:\s(null)/g, ': <span class="z">$1</span>');
}
function toCsv(run) {
  const cols = columnsOf(run).map((c) => c.key);
  const q = (v) => { const s = v == null ? "" : Array.isArray(v) ? v.join(" | ") : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(","), ...(run.rows || []).map((r) => cols.map((c) => q(r[c])).join(","))].join("\n");
}
const kb = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const notFound = (what, back, label) => `<div class="err-card"><div class="ico">?</div><div><h3>${what} not found</h3><p>It may have been deleted.</p><a class="btn" href="${back}">${label}</a></div></div>`;

/* ===================================================================== VIEW: workspace */
const PRESETS = [
  { label: "Books catalogue → CSV", url: "https://books.toscrape.com/", prompt: "Title, price, star rating and availability for every book. Follow pagination.", mode: "crawl", max_pages: 3, format: "csv" },
  { label: "Hacker News front page", url: "https://news.ycombinator.com/", prompt: "Title, link, points, author and comment count for every story on the page.", mode: "page", format: "json" },
  { label: "Quotes by author → JSONL", url: "https://quotes.toscrape.com/", prompt: "Quote text, author name and tags for every quote. Follow pagination.", mode: "crawl", max_pages: 2, format: "jsonl" },
  { label: "Flipkart phones", url: "https://www.flipkart.com/search?q=5g+mobile", prompt: "Product name, price, MRP, discount percent, rating and number of ratings for every phone listed.", mode: "page", format: "csv" },
];

function defaultForm() {
  const s = settings();
  return { url: "", prompt: "", mode: "page", max_pages: 3, format: s.default_format || "json",
    options: { stealth: s.stealth !== false, use_proxy: !!s.use_proxy, respect_robots: s.respect_robots !== false } };
}

function wsStats() {
  const runs = runsReal(), today = new Date(), yest = new Date(Date.now() - 864e5);
  const done = runs.filter((r) => r.status === "completed");
  const rowsOn = (d) => done.filter((r) => sameDay(new Date(r.finished_at || r.created_at), d)).reduce((s, r) => s + (r.row_count || 0), 0);
  const rt = rowsOn(today), ry = rowsOn(yest);
  const delta = ry ? Math.round(((rt - ry) / ry) * 100) : null;
  const finished = runs.filter((r) => r.status === "completed" || r.status === "failed");
  const rate = finished.length ? (done.length / finished.length) * 100 : null;
  const retried = runs.filter((r) => r.retried).length;
  const durs = done.map(runMs).filter((x) => x != null).sort((a, b) => a - b);
  const q = (p) => (durs.length ? durs[Math.min(durs.length - 1, Math.floor(p * durs.length))] : null);
  const total = done.reduce((s, r) => s + (r.row_count || 0), 0);
  const deliveries = S.state?.deliveries || 0;
  const tile = (k, v, s, cls = "") => `<div class="glass stat"><span class="k">${k}</span><span class="v">${v}</span><span class="s ${cls}">${s}</span></div>`;
  return tile("Rows scraped today", fmtNum(rt), delta == null ? (rt ? "first day of data" : "no runs yet today") : `${delta >= 0 ? "+" : ""}${delta}% vs yesterday`, delta == null ? "" : delta >= 0 ? "up" : "down")
    + tile("Success rate", rate == null ? "—" : (Number.isInteger(rate) ? rate : rate.toFixed(1)) + "%", `${retried} block${retried === 1 ? "" : "s"} auto-retried`)
    + tile("Median run time", durs.length ? dur(q(0.5)) : "—", durs.length ? `p95 ${dur(q(0.95))}` : "no finished runs yet")
    + tile("Rows delivered", compactNum(total), `${deliveries} export${deliveries === 1 ? "" : "s"} & syncs`);
}
function wsRuns() {
  const runs = runsReal().slice(0, 6);
  return runs.length ? runs.map(runRow).join("") : `<div class="empty-row">No runs yet — paste a URL above and press <b>Run extraction</b>.</div>`;
}

const Workspace = {
  render() {
    if (!S.form) S.form = { ...defaultForm(), ...store.get("sieve.draft", {}) };
    const f = S.form, s = settings();
    const opt = (id, label) => `<button type="button" class="switch" role="switch" aria-checked="${!!f.options[id]}" data-act="opt" data-opt="${id}"><span class="track"></span><span>${label}</span></button>`;
    return `${topBar(`<span class="ws">${ws()}</span><span aria-hidden="true">/</span><span class="here">Workspace</span>`)}
    <section class="hero" aria-labelledby="new-run">
      <div class="hero-copy">
        <span class="eyebrow">AI extraction · anti-bot · structured output</span>
        <h1 id="new-run">Any website, as clean data.</h1>
        <p>Paste a URL, describe what you need, and Sieve returns structured rows — no selectors required.</p>
      </div>
      <form class="glass-strong runform" id="runForm" novalidate>
        <div class="rf-top">
          <span class="dim">${I.link()}</span>
          <label for="url" class="sr">Target URL</label>
          <input id="url" type="url" inputmode="url" autocomplete="url" spellcheck="false" placeholder="https://example.com/products" value="${esc(f.url)}" />
          <div class="seg" role="radiogroup" aria-label="Scrape mode">
            ${[["page", "Page"], ["crawl", "Crawl"], ["sitemap", "Sitemap"]].map(([id, l]) => `<button type="button" role="radio" aria-checked="${f.mode === id}" data-act="mode" data-mode="${id}" title="${{ page: "Only this page", crawl: "Follow pagination", sitemap: "Pick pages from the sitemap" }[id]}">${l}</button>`).join("")}
          </div>
        </div>
        <div class="rf-mid">
          <label for="prompt">What should we extract?</label>
          <textarea id="prompt" rows="2" placeholder="Product name, price, rating, review count and stock status for every item. Follow pagination.">${esc(f.prompt)}</textarea>
        </div>
        <div class="form-error hidden" id="formError" role="alert"></div>
        <div class="rf-bot">
          <div class="rf-opts">
            ${opt("stealth", "Stealth browser")}
            ${opt("use_proxy", `Use proxy (${esc(s.proxy_country || "US")})`)}
            ${opt("respect_robots", "Respect robots.txt")}
            <label class="rf-pages ${f.mode === "page" ? "hidden" : ""}" id="pagesWrap">Pages
              <select id="maxPages" aria-label="Maximum pages">${[2, 3, 5, 8, 10, 15, 25].map((n) => `<option ${+f.max_pages === n ? "selected" : ""}>${n}</option>`).join("")}</select></label>
          </div>
          <div class="rf-go">
            <button type="button" class="btn" data-act="fmt" aria-haspopup="menu" aria-label="Output format">${esc(f.format.toUpperCase())} ${I.down()}</button>
            <button type="submit" class="btn btn-accent" id="runBtn">Run extraction ${I.arrow()}</button>
          </div>
        </div>
      </form>
      <div class="try"><span>Try:</span>${PRESETS.map((p, i) => `<button type="button" data-act="preset" data-i="${i}">${esc(p.label)}</button>`).join("")}</div>
    </section>
    <section class="stats" aria-label="Overview" id="wsStats">${wsStats()}</section>
    <section class="glass panel" aria-labelledby="runs-h">
      <div class="panel-head"><h2 id="runs-h">Live runs</h2><a href="#/datasets" style="font-size:13px">View all</a></div>
      <div class="runs-scroll"><div class="runs-list" id="wsRuns">${wsRuns()}</div></div>
    </section>`;
  },
  after() {
    const saveDraft = debounce(() => store.set("sieve.draft", { url: S.form.url, prompt: S.form.prompt, mode: S.form.mode, max_pages: S.form.max_pages, format: S.form.format }), 300);
    const ta = $("#prompt");
    const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 240) + "px"; };
    $("#url").addEventListener("input", (e) => { S.form.url = e.target.value; saveDraft(); });
    ta.addEventListener("input", (e) => { S.form.prompt = e.target.value; grow(); saveDraft(); });
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#runForm").requestSubmit(); });
    requestAnimationFrame(grow);
    $("#maxPages").addEventListener("change", (e) => { S.form.max_pages = +e.target.value; saveDraft(); });
    $("#runForm").addEventListener("submit", (e) => { e.preventDefault(); Workspace.submit(); });
    sessionStorage.setItem("sieve.ws", "1");
  },
  update() {
    if ($("#wsStats")) $("#wsStats").innerHTML = wsStats();
    if ($("#wsRuns")) $("#wsRuns").innerHTML = wsRuns();
  },
  async submit() {
    const f = S.form, err = $("#formError");
    let url = f.url.trim();
    if (url && !/^https?:\/\//i.test(url)) { url = "https://" + url; $("#url").value = f.url = url; }
    const fail = (m, html) => { err.innerHTML = html || esc(m); err.classList.remove("hidden"); };
    err.classList.add("hidden");
    try { new URL(url); } catch { $("#url").focus(); return fail("Paste the full address of the page you want to scrape, like https://example.com/products."); }
    if (!f.prompt.trim()) { $("#prompt").focus(); return fail("Describe what to extract — for example “product name, price and rating for every item”."); }
    if (!settings().has_key) return fail("", `Connect TinyFish first — <a href="#/api">add your API key</a>.`);
    const btn = $("#runBtn"); btn.disabled = true; btn.innerHTML = `<span class="spin"></span> Starting…`;
    try {
      const res = await api("POST", "/api/runs", { url, prompt: f.prompt.trim(), mode: f.mode, max_pages: f.mode === "page" ? 1 : f.max_pages, format: f.format, options: f.options });
      store.set("sieve.draft", {});
      S.form = null;
      await refreshState();
      go(`#/datasets/${res.run.id}`);
      setTimeout(tick, 500);
    } catch (e2) {
      fail(e2.message);
      btn.disabled = false; btn.innerHTML = `Run extraction ${I.arrow()}`;
    }
  },
  acts: {
    mode(el) {
      S.form.mode = el.dataset.mode;
      $$('[data-act="mode"]').forEach((b) => b.setAttribute("aria-checked", String(b === el)));
      $("#pagesWrap").classList.toggle("hidden", S.form.mode === "page");
      store.set("sieve.draft", { ...store.get("sieve.draft", {}), mode: S.form.mode });
    },
    opt(el) {
      const k = el.dataset.opt; S.form.options[k] = !S.form.options[k];
      el.setAttribute("aria-checked", String(S.form.options[k]));
    },
    fmt(el) {
      const m = openMenu(el, ["json", "jsonl", "csv"].map((f) => `<button data-f="${f}" class="${S.form.format === f ? "on" : ""}"><span class="tx"><b>${f.toUpperCase()}</b><small>${{ json: "Array of objects", jsonl: "One object per line", csv: "Opens in Excel / Sheets" }[f]}</small></span></button>`).join(""), { align: "right" });
      m.addEventListener("click", (e) => { const b = e.target.closest("[data-f]"); if (!b) return; S.form.format = b.dataset.f; el.innerHTML = `${b.dataset.f.toUpperCase()} ${I.down()}`; menuClose(); });
    },
    preset(el) {
      const p = PRESETS[+el.dataset.i];
      Object.assign(S.form, { url: p.url, prompt: p.prompt, mode: p.mode, max_pages: p.max_pages || 3, format: p.format });
      render();
      $("#prompt").focus();
      toast(`Loaded “${p.label}” — press Run extraction`);
    },
  },
};

/* ===================================================================== VIEW: datasets list */
const Datasets = {
  render() {
    const runs = runsAll();
    const total = runs.filter((r) => r.status === "completed").reduce((s, r) => s + (r.row_count || 0), 0);
    return `${topBar(`<span class="ws">${ws()}</span><span aria-hidden="true">/</span><span class="here">Datasets</span>`)}
      <div class="page-head"><div class="titles"><h1>Datasets</h1><div class="meta" id="dsMeta"><span>${runs.length} runs</span><span>${fmtNum(total)} rows collected</span><span>${runs.filter((r) => isActive(r.status)).length} running</span></div></div>
        <div class="actions"><a class="btn btn-accent" href="#/workspace">New extraction ${I.arrow()}</a></div></div>
      <section class="glass panel">
        <div class="panel-head">
          <div class="seg sm" role="tablist">${[["all", "All"], ["completed", "Completed"], ["active", "Running"], ["failed", "Failed"], ["test", "Tests"]].map(([k, l]) => `<button type="button" aria-pressed="${S.dsFilter === k}" data-act="ds-filter" data-k="${k}">${l}</button>`).join("")}</div>
          <label class="mini-search">${I.search(14)}<input id="dsQuery" placeholder="Filter by name or site" value="${esc(S.dsQuery)}" /></label>
        </div>
        <div class="runs-scroll"><div class="runs-list" id="dsList">${Datasets.list()}</div></div>
      </section>`;
  },
  list() {
    const q = S.dsQuery.toLowerCase();
    const runs = runsAll().filter((r) => {
      if (S.dsFilter === "test") { if (r.trigger !== "test") return false; } else if (r.trigger === "test") return false;
      if (S.dsFilter === "completed" && r.status !== "completed") return false;
      if (S.dsFilter === "active" && !isActive(r.status)) return false;
      if (S.dsFilter === "failed" && !["failed", "cancelled"].includes(r.status)) return false;
      return !q || `${r.name} ${r.host} #${r.num}`.toLowerCase().includes(q);
    });
    return runs.length ? runs.map(runRow).join("") : `<div class="empty-row">${runsAll().length ? "Nothing matches this filter." : 'No datasets yet. <a href="#/workspace">Start your first extraction →</a>'}</div>`;
  },
  after() { $("#dsQuery").addEventListener("input", (e) => { S.dsQuery = e.target.value; $("#dsList").innerHTML = Datasets.list(); }); },
  update(changed) { if (changed && $("#dsList")) $("#dsList").innerHTML = Datasets.list(); },
  acts: { "ds-filter"(el) { S.dsFilter = el.dataset.k; $$('[data-act="ds-filter"]').forEach((b) => b.setAttribute("aria-pressed", String(b === el))); $("#dsList").innerHTML = Datasets.list(); } },
};

/* ===================================================================== VIEW: dataset (one run) */
function prevRunOf(run) {
  return runsAll().filter((r) => r.extractor_id === run.extractor_id && r.id !== run.id && r.status === "completed" && r.trigger !== "test" && ts(r.created_at) < ts(run.created_at))[0];
}
function diffRows(prev, cur, cols) {
  const keyCol = cols.find((c) => /^(name|title|product|url|link|id|sku)/.test(c.key))?.key || cols[0]?.key;
  const k = (r) => String(r[keyCol] ?? JSON.stringify(r));
  const pm = new Map(prev.map((r) => [k(r), r])), cm = new Map(cur.map((r) => [k(r), r]));
  const out = [];
  cur.forEach((r) => { const p = pm.get(k(r)); if (!p) out.push({ t: "add", r }); else if (JSON.stringify(p) !== JSON.stringify(r)) out.push({ t: "chg", r, p }); });
  prev.forEach((r) => { if (!cm.has(k(r))) out.push({ t: "del", r }); });
  return { out, keyCol, same: cur.length - out.filter((d) => d.t !== "del").length };
}

const Dataset = {
  liveIds: () => [S.route.id],
  render() {
    const run = S.runCache[S.route.id];
    if (!run) {
      fetchRun(S.route.id).then(() => S.route.view === "dataset" && render())
        .catch(() => { if (S.route.view === "dataset") $("#view").innerHTML = `${topBar(`<a href="#/datasets">Datasets</a>`)}${notFound("Run", "#/datasets", "All datasets")}`; });
      return `${topBar(`<a href="#/datasets">Datasets</a>`)}<div class="panel-empty"><span class="spin"></span></div>`;
    }
    S.run = run;
    return `${topBar(`<a href="#/datasets">Datasets</a><span aria-hidden="true">/</span><button class="crumb-btn" data-act="run-switch" aria-haspopup="menu"><span>${esc(run.name)}</span>${I.down(12)}</button>`)}
      <div id="dsHead">${Dataset.head(run)}</div>
      <div id="dsBody" style="display:flex;flex-direction:column;gap:20px">${Dataset.body(run)}</div>`;
  },
  head(run) {
    const active = isActive(run.status), e = estimate(run);
    const sched = (S.state?.schedules || []).find((s) => s.extractor_id === run.extractor_id && s.enabled);
    const title = run.status === "completed" ? `${fmtNum(run.row_count)} row${run.row_count === 1 ? "" : "s"}, ready.`
      : run.status === "queued" ? "Queued…" : run.status === "running" ? "Extracting…" : run.status === "retrying" ? "Retrying with a proxy…"
      : run.status === "cancelled" ? "Run stopped." : esc(run.error?.title || "Run failed.");
    const pages = run.pages_visited ? `${run.pages_visited} page${run.pages_visited === 1 ? "" : "s"}` : run.mode === "page" ? "1 page" : `up to ${run.max_pages} pages`;
    const meta = [
      `<span>Run #${run.num}</span>`, `<span>${pages}</span>`, `<span>${dur(runMs(run))}</span>`,
      run.status === "completed" ? `<span class="ok">${run.retried ? "1 block auto-retried" : "0 failed"}</span>` : active ? `<span>${run.steps_count} step${run.steps_count === 1 ? "" : "s"} · ~${e.pct}%</span>` : `<span class="${run.status === "failed" ? "bad" : ""}">${STATUS[run.status]}</span>`,
      run.trigger !== "manual" ? `<span>${run.trigger === "schedule" ? "Scheduled" : run.trigger === "test" ? "Test run" : "via API"}</span>` : "",
      run.cost != null ? `<span>${money(run.cost)}</span>` : "",
    ].join("");
    let acts = "";
    if (active) acts = `<button class="btn" data-act="live-log">Live log</button><button class="btn btn-danger" data-act="stop-run">${I.stop()} Stop</button>`;
    else if (run.status === "completed" && S.cloud) acts = `<button class="btn btn-accent" data-act="export-menu" aria-haspopup="menu">${I.dl()} Export</button>`;
    else if (run.status === "completed") acts = `${sched ? `<a class="btn" href="#/schedules">${I.clock(16)} ${esc(cadence(sched))}</a>` : `<button class="btn" data-act="schedule-daily">${I.clock(16)} Schedule daily</button>`}
      <button class="btn" data-act="copy-api">Copy API call</button>
      <button class="btn btn-accent" data-act="export-menu" aria-haspopup="menu">${I.dl()} Export</button>`;
    else acts = `<button class="btn" data-act="live-log">Run log</button><button class="btn btn-accent" data-act="rerun">Run again ${I.arrow()}</button>`;
    acts += `<button class="icon-btn" data-act="run-more" aria-label="More actions" style="border-radius:12px">${I.more()}</button>`;
    return `<header class="page-head"><div class="titles"><h1>${title}</h1><div class="meta">${meta}</div></div><div class="actions">${acts}</div></header>`;
  },
  body(run) {
    if (isActive(run.status)) return Dataset.live(run);
    if (run.status === "failed" || run.status === "cancelled") return Dataset.failed(run);
    return Dataset.results(run);
  },
  live(run) {
    const e = estimate(run);
    const u = run.streaming_url && /^https:\/\//.test(run.streaming_url) ? run.streaming_url : null;
    return `<div class="live-grid">
      <section class="glass live-card" aria-label="Live browser">
        <div class="chrome"><div class="lights"><i></i><i></i><i></i></div><div class="addr">${esc(run.url.replace(/^https?:\/\//, ""))}</div>${u ? `<a class="hint" href="${esc(u)}" target="_blank" rel="noopener">Pop out ↗</a>` : '<span class="hint">Live</span>'}</div>
        <div class="live-frame" id="liveFrame">${u ? `<iframe src="${esc(u)}" title="Live browser view" allow="autoplay"></iframe>` : `<div class="live-wait"><span class="ring-pulse"></span><span>${run.status === "queued" ? "Checking robots.txt and starting a cloud browser…" : run.status === "retrying" ? "Starting a fresh browser with a proxy…" : "Waiting for the live view…"}</span></div>`}</div>
      </section>
      <section class="glass progress-card" aria-label="Progress">
        <div class="ring-row" id="liveRing">${Dataset.ringBlock(run, e)}</div>
        <div><div class="card-head" style="margin-bottom:6px"><h2 style="font-size:13px;color:var(--muted)">Activity</h2>${pill(run.status)}</div><div id="liveLog">${logHtml(run.steps, true)}</div></div>
      </section></div>`;
  },
  ringBlock(run, e) {
    return `${ring(e.pct)}<div class="kv"><div><span>Rows</span><b>${run.status === "completed" ? fmtNum(run.row_count) : "—"}</b></div><div><span>Steps</span><b>${run.steps_count}</b></div><div><span>Elapsed</span><b>${clock(runMs(run) || 0)}</b></div><div><span>ETA</span><b>${e.eta == null ? "—" : "~" + clock(e.eta)}</b></div></div>`;
  },
  failed(run) {
    const code = run.error?.code || "";
    const btns = [];
    if (run.status === "cancelled") btns.push(`<button class="btn btn-accent" data-act="rerun">Run again ${I.arrow()}</button>`);
    else {
      btns.push(`<button class="btn btn-accent" data-act="rerun">Try again</button>`);
      if (code === "blocked") btns.push(`<button class="btn" data-act="rerun-proxy">Retry with stealth + proxy</button>`);
      if (code === "robots") btns.push(`<button class="btn" data-act="rerun-norobots">I have permission — run without the robots check</button>`);
      if (/no_key|http_401/.test(code)) btns.push(`<a class="btn" href="#/api">Update API key</a>`);
      if (code === "http_402") btns.push(`<a class="btn" href="https://agent.tinyfish.ai/wallet" target="_blank" rel="noopener">Add funds ↗</a>`);
      if (["no_results", "empty", "unparseable"].includes(code)) btns.push(`<a class="btn" href="#/extractors/${run.extractor_id}">Edit extractor</a>`);
    }
    const title = run.status === "cancelled" ? "You stopped this run" : run.error?.title || "Run failed";
    const msg = run.status === "cancelled" ? "Nothing was saved. Run it again whenever you're ready." : run.error?.message || "";
    return `<div class="err-card"><div class="ico">${run.status === "cancelled" ? "■" : "!"}</div><div style="min-width:0;flex:1"><h3>${esc(title)}</h3><p>${esc(msg)}</p><div class="actions">${btns.join("")}</div></div></div>
      <section class="glass set-card"><div class="card-head"><h2>Run log</h2><span class="dim mono" style="font-size:12px">${run.steps.length} events</span></div>${logHtml(run.steps, false)}</section>`;
  },
  dests(run) {
    const csvSize = kb(new Blob(["﻿" + toCsv(run)]).size);
    const dels = run.deliveries || [];
    const lastOf = (k) => [...dels].reverse().find((d) => d.kind === k);
    const db = lastOf("database"), wh = lastOf("webhook"), s = settings();
    const dest = (act, ic, cls, title, sub, state = "") => `<button type="button" class="dest ${state}" data-act="${act}"><span class="ic ${cls}">${ic}</span><span class="tx"><b>${title}</b><span>${sub}</span></span></button>`;
    return `<section class="dests" aria-label="Destinations" id="dests">
        ${dest("dl-csv", "CSV", "lime", "Download CSV", csvSize)}
        ${dest("dl-json", "{ }", "blue", "JSON / JSONL", run.fields?.length ? "Typed schema" : "Auto-detected keys")}
        ${S.cloud ? dest("local-only", "DB", "violet", "Sync to database", "Local app only") : dest("sync-db", "DB", "violet", "Sync to database", db ? `Synced ${relTime(db.at)} · SQLite` : `SQLite · ${esc(S.state?.db_path || "data/sieve.db")}`, db ? "done" : "")}
        ${S.cloud ? dest("local-only", "↗", "orange", "Webhook", "Local app only") : dest("send-webhook", "↗", "orange", "Webhook", wh ? (wh.ok ? `Sent ${relTime(wh.at)} · ${esc(wh.detail)}` : `Failed · ${esc(wh.detail)}`) : s.webhook_url ? `POST to ${esc(hostOf(s.webhook_url))}${s.webhook_on_run ? " · every run" : ""}` : "Set up a URL first", wh ? (wh.ok ? "done" : "bad") : "")}
      </section>`;
  },
  results(run) { return Dataset.dests(run) + `<section class="rows-panel" aria-label="Rows" id="rowsPanel">${Dataset.rows(run)}</section>`; },
  rows(run) {
    const cols = columnsOf(run), d = S.ds;
    const tabs = `<div class="seg sm" role="tablist">${[["table", "Table"], ["json", "JSON"], ["diff", "Diff vs. previous"]].map(([k, l]) => `<button type="button" aria-pressed="${d.tab === k}" data-act="ds-tab" data-k="${k}">${l}</button>`).join("")}</div>`;
    if (d.tab === "diff") return `<div class="rows-bar">${tabs}</div>${Dataset.diff(run, cols)}`;
    let rows = run.rows || [];
    if (d.q) { const q = d.q.toLowerCase(); rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q)); }
    if (d.sort) {
      const { key, dir } = d.sort;
      rows = [...rows].sort((a, b) => { const x = a[key], y = b[key]; if (x == null) return 1; if (y == null) return -1; return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * dir; });
    }
    const per = 25, pages = Math.max(1, Math.ceil(rows.length / per));
    d.page = Math.min(d.page, pages - 1);
    const slice = rows.slice(d.page * per, d.page * per + per);
    const right = `<label class="mini-search">${I.search(14)}<input id="rowQuery" placeholder="Filter rows" value="${esc(d.q)}" aria-label="Filter rows" /></label>
      <span>Showing ${rows.length ? d.page * per + 1 : 0}–${d.page * per + slice.length} of ${fmtNum(rows.length)}</span>
      <div class="pager"><button data-act="pg" data-d="-1" ${d.page === 0 ? "disabled" : ""} aria-label="Previous page">${I.left()}</button><button data-act="pg" data-d="1" ${d.page >= pages - 1 ? "disabled" : ""} aria-label="Next page">${I.right()}</button></div>`;
    const bar = `<div class="rows-bar">${tabs}<div class="right">${right}</div></div>`;
    if (d.tab === "json") return bar + `<pre class="json-view">${jsonHtml(slice)}</pre>`;
    return bar + `<div class="tbl-wrap"><table class="tbl"><thead><tr>${cols.map((c) => `<th scope="col" data-act="sort" data-k="${esc(c.key)}" class="${d.sort?.key === c.key ? "sorted" : ""}">${esc(c.key)}${d.sort?.key === c.key ? (d.sort.dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead>
      <tbody>${slice.map((r) => `<tr>${cols.map((c, i) => cell(r[c.key], c.type, i === 0)).join("")}</tr>`).join("") || `<tr><td colspan="${cols.length || 1}" class="panel-empty">No rows match.</td></tr>`}</tbody></table></div>`;
  },
  diff(run, cols) {
    const prevSum = prevRunOf(run);
    if (!prevSum) return `<div class="panel-empty">This is the first completed run of this extractor, so there's nothing to compare yet.<br>Run it again later${S.cloud ? "" : ` — or <a href="#" data-act="schedule-daily">schedule it daily</a> —`} to see what changed.</div>`;
    const prev = S.runCache[prevSum.id];
    if (!prev) { fetchRun(prevSum.id).then(() => { if (S.ds.tab === "diff") Dataset.redrawRows(); }); return `<div class="panel-empty"><span class="spin"></span></div>`; }
    const { out, keyCol, same } = diffRows(prev.rows || [], run.rows || [], cols);
    const n = (t) => out.filter((x) => x.t === t).length;
    const sum = `<div class="diff-sum"><span>Compared with <a href="#/datasets/${prev.id}">run #${prev.num}</a> (${relTime(prev.finished_at)}) · matched on <span class="mono">${esc(keyCol)}</span></span><span class="a">+${n("add")} added</span><span class="r">−${n("del")} removed</span><span class="c">~${n("chg")} changed</span><span class="dim">${same} unchanged</span></div>`;
    if (!out.length) return sum + `<div class="panel-empty">No differences — every row matches the previous run.</div>`;
    const body = out.slice(0, 200).map((x) => `<tr class="d-${x.t}"><td class="num">${{ add: "+", del: "−", chg: "~" }[x.t]}</td>${cols.map((c, i) => {
      const v = x.r[c.key], was = x.t === "chg" && JSON.stringify(x.p[c.key]) !== JSON.stringify(v);
      const td = cell(v, c.type, i === 0);
      const old = x.p?.[c.key];
      return was ? td.replace(/<\/td>$/, `<span class="was">${esc(old == null ? "—" : typeof old === "object" ? JSON.stringify(old) : old)}</span></td>`) : td;
    }).join("")}</tr>`).join("");
    return sum + `<div class="tbl-wrap"><table class="tbl"><thead><tr><th></th>${cols.map((c) => `<th>${esc(c.key)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
  },
  after() { Dataset.bindRows(); },
  bindRows() {
    const q = $("#rowQuery");
    if (q) q.addEventListener("input", debounce((e) => { S.ds.q = e.target.value; S.ds.page = 0; Dataset.redrawRows(true); }, 150));
  },
  redrawRows(keepFocus) {
    const p = $("#rowsPanel"); if (!p || !S.run) return;
    const pos = keepFocus ? $("#rowQuery")?.selectionStart : null;
    p.innerHTML = Dataset.rows(S.run);
    Dataset.bindRows();
    if (keepFocus) { const q = $("#rowQuery"); if (q) { q.focus(); q.setSelectionRange(pos, pos); } }
  },
  update() {
    const run = S.runCache[S.route.id]; if (!run || !$("#dsHead")) return;
    const was = S.run; S.run = run;
    $("#dsHead").innerHTML = Dataset.head(run);
    if (!was || was.status !== run.status || (isActive(run.status) && !$("#liveRing"))) { $("#dsBody").innerHTML = Dataset.body(run); Dataset.after(); return; }
    if (isActive(run.status)) {
      $("#liveRing").innerHTML = Dataset.ringBlock(run, estimate(run));
      const ul = $("#liveLog .log"), atEnd = !ul || ul.scrollTop + ul.clientHeight >= ul.scrollHeight - 30;
      $("#liveLog").innerHTML = logHtml(run.steps, true);
      if (atEnd) { const n = $("#liveLog .log"); n.scrollTop = n.scrollHeight; }
      if (run.streaming_url && !$("#liveFrame iframe")) { $("#dsBody").innerHTML = Dataset.body(run); }
    } else if (run.status === "completed" && $("#dests")) {
      $("#dests").outerHTML = Dataset.dests(run);
    }
  },
  acts: {
    "run-switch"(el) {
      const list = runsAll().slice(0, 15);
      const m = openMenu(el, `<div class="label">Recent runs</div>` + list.map((r) => `<a href="#/datasets/${r.id}" class="${r.id === S.route.id ? "on" : ""}"><span class="sdot ${r.status}"></span><span class="tx"><b>${esc(r.name)}</b><small>Run #${r.num} · ${r.row_count ? fmtNum(r.row_count) + " rows · " : ""}${relTime(r.created_at)}</small></span></a>`).join("") + `<hr><a href="#/datasets">All datasets</a>`, { width: 320 });
      m.addEventListener("click", () => menuClose?.());
    },
    "ds-tab"(el) { S.ds.tab = el.dataset.k; S.ds.page = 0; Dataset.redrawRows(); },
    pg(el) { S.ds.page += +el.dataset.d; Dataset.redrawRows(); $("#rowsPanel").scrollIntoView({ block: "nearest", behavior: "smooth" }); },
    sort(el) { const k = el.dataset.k; S.ds.sort = S.ds.sort?.key === k ? (S.ds.sort.dir > 0 ? { key: k, dir: -1 } : null) : { key: k, dir: 1 }; Dataset.redrawRows(); },
    "export-menu"(el) {
      const m = openMenu(el, ["csv", "json", "jsonl"].map((f) => `<button data-f="${f}"><span class="tx"><b>${f.toUpperCase()}${f === S.run.format ? " · default" : ""}</b><small>${{ csv: "Spreadsheet", json: "Array of objects", jsonl: "One object per line" }[f]}</small></span></button>`).join("") + `<hr><button data-f="copy"><span class="tx"><b>Copy JSON</b><small>To clipboard</small></span></button>`, { align: "right" });
      m.addEventListener("click", (e) => { const b = e.target.closest("[data-f]"); if (!b) return; menuClose(); b.dataset.f === "copy" ? copyText(JSON.stringify(S.run.rows, null, 2), `Copied ${fmtNum(S.run.row_count)} rows`) : download(b.dataset.f); });
    },
    "dl-csv"() { download("csv"); },
    "dl-json"(el) {
      const m = openMenu(el, `<button data-f="json"><span class="tx"><b>JSON</b><small>Array of objects</small></span></button><button data-f="jsonl"><span class="tx"><b>JSONL</b><small>One object per line</small></span></button>`);
      m.addEventListener("click", (e) => { const b = e.target.closest("[data-f]"); if (b) { menuClose(); download(b.dataset.f); } });
    },
    async "sync-db"(el) {
      $(".tx span", el).textContent = "Syncing…";
      try { const r = await api("POST", `/api/runs/${S.run.id}/sync-db`); toast(`Synced ${fmtNum(r.rows)} rows to ${r.rel_path} (${fmtNum(r.total_rows)} rows total)`); }
      catch (e) { toast(e.message, { err: true }); }
      await fetchRun(S.run.id); Dataset.update();
    },
    async "send-webhook"(el) {
      if (!settings().webhook_url) { toast("Add a webhook URL first"); go("#/api"); return; }
      $(".tx span", el).textContent = "Sending…";
      try { const r = await api("POST", `/api/runs/${S.run.id}/webhook`); toast(r.ok ? `Webhook delivered (HTTP ${r.status})` : r.error || "Webhook failed", { err: !r.ok }); }
      catch (e) { toast(e.message, { err: true }); }
      await fetchRun(S.run.id); Dataset.update();
    },
    async "schedule-daily"() {
      const now = new Date(), at = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      try { await api("POST", "/api/schedules", { extractor_id: S.run.extractor_id, every: "daily", at }); await refreshState(); toast(`Scheduled daily at ${at}`, { link: { href: "#/schedules", label: "Manage" } }); Dataset.update(); renderShell(); }
      catch (e) { toast(e.message, { err: true }); }
    },
    "copy-api"() {
      copyText(`curl -X POST ${location.origin}/api/runs \\\n  -H "Content-Type: application/json" \\\n  -d '{"extractor_id": "${S.run.extractor_id}"}'`, "API call copied — paste it in a terminal");
    },
    "live-log"() { openSheet(S.run); },
    async "stop-run"(el) {
      el.disabled = true; el.innerHTML = `<span class="spin"></span> Stopping…`;
      try { await api("POST", `/api/runs/${S.run.id}/cancel`); toast("Stopping the run…"); } catch (e) { toast(e.message, { err: true }); }
      setTimeout(tick, 600);
    },
    rerun() { rerun({}); },
    "rerun-proxy"() { rerun({ options: { stealth: true, use_proxy: true } }); },
    "rerun-norobots"() { rerun({ options: { respect_robots: false } }); },
    "run-more"(el) {
      const r = S.run;
      const m = openMenu(el, `<a href="#/extractors/${r.extractor_id}"><span class="tx"><b>Open in schema builder</b><small>Edit fields and instructions</small></span></a>
        <button data-m="rerun"><span class="tx"><b>Run again</b><small>Same extractor, fresh data</small></span></button>
        <button data-m="log"><span class="tx"><b>View run log</b><small>${r.steps.length} events</small></span></button>
        ${r.tf_run_id ? `<a href="https://agent.tinyfish.ai/runs/${esc(r.tf_run_id)}" target="_blank" rel="noopener"><span class="tx"><b>Open in TinyFish ↗</b><small>Replay the browser recording</small></span></a>` : ""}
        <button data-m="url"><span class="tx"><b>Copy source URL</b><small>${esc(hostOf(r.url))}</small></span></button>
        <hr><button data-m="del" ${isActive(r.status) ? "disabled" : ""}><span class="tx"><b style="color:var(--red)">Delete run</b><small>Removes this dataset</small></span></button>`, { align: "right", width: 260 });
      m.addEventListener("click", async (e) => {
        const b = e.target.closest("[data-m]"); if (!b) { menuClose?.(); return; }
        menuClose();
        if (b.dataset.m === "rerun") rerun({});
        if (b.dataset.m === "log") openSheet(r);
        if (b.dataset.m === "url") copyText(r.url, "URL copied");
        if (b.dataset.m === "del") {
          if (!confirm(`Delete run #${r.num} (${r.name})? This can't be undone.`)) return;
          try { await api("DELETE", `/api/runs/${r.id}`); delete S.runCache[r.id]; await refreshState(); toast("Run deleted"); go("#/datasets"); } catch (err) { toast(err.message, { err: true }); }
        }
      });
    },
  },
};
function download(fmt) {
  if (S.cloud) {
    const run = S.run, rows = run.rows || [];
    const text = fmt === "csv" ? "\ufeff" + toCsv(run) : fmt === "jsonl" ? rows.map((r) => JSON.stringify(r)).join("\n") + "\n" : JSON.stringify(rows, null, 2);
    const blob = new Blob([text], { type: { csv: "text/csv", jsonl: "application/x-ndjson", json: "application/json" }[fmt] });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${run.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}-run${run.num}.${fmt}`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    window.SieveCloud.recordExport(run.id, fmt, blob.size);
    toast(`${fmt.toUpperCase()} downloaded`);
    setTimeout(tick, 300);
    return;
  }
  const a = document.createElement("a");
  a.href = `/api/runs/${S.run.id}/export?format=${fmt}`;
  a.download = "";
  document.body.appendChild(a); a.click(); a.remove();
  toast(`${fmt.toUpperCase()} download started`);
  setTimeout(tick, 800);
}
async function rerun(overrides) {
  try {
    const res = await api("POST", "/api/runs", { extractor_id: S.run.extractor_id, ...overrides });
    await refreshState();
    go(`#/datasets/${res.run.id}`);
    setTimeout(tick, 500);
  } catch (e) { toast(e.message, { err: true }); }
}

/* ===================================================================== VIEW: extractors (schema builder) */
const saveEx = debounce(async () => {
  if (!S.ex) return;
  const ind = $("#savedInd");
  try {
    const r = await api("POST", "/api/extractors", S.ex);
    S.exSaved = true;
    const i = (S.state.extractors || []).findIndex((e) => e.id === r.extractor.id);
    if (i >= 0) S.state.extractors[i] = r.extractor;
    if (S.ex && S.ex.id === r.extractor.id) S.ex.name = r.extractor.name;
    if (ind) { ind.textContent = "All changes saved"; ind.className = "saved on"; }
  } catch (e) { if (ind) { ind.textContent = e.message; ind.className = "saved"; } }
}, 500);
function touchEx() {
  S.exSaved = false;
  const ind = $("#savedInd"); if (ind) { ind.textContent = "Saving…"; ind.className = "saved"; }
  saveEx();
}
const testRunOf = (exid) => runsAll().find((r) => r.extractor_id === exid && r.trigger === "test");
const fieldKey = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);

const Extractors = {
  liveIds() { const t = S.ex && testRunOf(S.ex.id); return t ? [t.id] : []; },
  render() {
    const list = S.state.extractors || [];
    if (S.route.id === "new" || !list.length) return Extractors.create(!list.length);
    if (!S.route.id) { setTimeout(() => go(`#/extractors/${list[0].id}`)); return ""; }
    const src = exById(S.route.id);
    if (!src) return `${topBar(`<a href="#/extractors">Extractors</a>`)}${notFound("Extractor", "#/extractors", "All extractors")}`;
    if (!S.ex || S.ex.id !== src.id) { S.ex = JSON.parse(JSON.stringify(src)); S.ex.options = S.ex.options || {}; S.sel = S.ex.fields[0]?.key || null; S.adding = false; S.exSaved = true; }
    const t = testRunOf(src.id); if (t && !S.runCache[t.id]) fetchRun(t.id).then(() => { Extractors._sig = null; Extractors.update(); }).catch(() => {});
    return `${topBar(`<a href="#/extractors">Extractors</a><span aria-hidden="true">/</span><button class="crumb-btn" data-act="ex-switch" aria-haspopup="menu"><span>${esc(S.ex.name)}</span>${I.down(12)}</button>`)}
      <header class="page-head" style="padding-top:0">
        <div class="titles"><h1 class="sm">Schema builder</h1><span class="saved ${S.exSaved ? "on" : ""}" id="savedInd">${S.exSaved ? "All changes saved" : "Saving…"}</span></div>
        <div class="actions" id="exActions">${Extractors.actions()}</div>
      </header>
      <div class="builder">
        <section class="preview" aria-label="Live page preview" id="exPreview">${Extractors.preview()}</section>
        <aside class="fields-col" aria-label="Fields" id="exSide">${Extractors.side()}</aside>
      </div>`;
  },
  create(first) {
    return `${topBar(`<a href="#/extractors">Extractors</a><span aria-hidden="true">/</span><span class="here">New</span>`)}
      <div class="page-head"><div class="titles"><h1>${first ? "Build your first extractor" : "New extractor"}</h1><div class="meta"><span>A reusable recipe: a URL, instructions and a schema. Test it, then run or schedule it.</span></div></div></div>
      <form class="glass-strong runform" id="newEx" style="max-width:720px">
        <div class="rf-top"><span class="dim">${I.link()}</span><label class="sr" for="nxUrl">URL</label><input id="nxUrl" type="url" placeholder="https://example.com/products" /></div>
        <div class="rf-mid"><label for="nxPrompt">What should it extract?</label><textarea id="nxPrompt" rows="2" placeholder="Name, price and rating for every product"></textarea></div>
        <div class="form-error hidden" id="nxErr" role="alert"></div>
        <div class="rf-bot"><input class="input" id="nxName" placeholder="Name (optional)" style="max-width:280px" aria-label="Name" /><div class="rf-go"><a class="btn" href="#/workspace">Cancel</a><button class="btn btn-accent" type="submit">Create extractor ${I.arrow()}</button></div></div>
      </form>`;
  },
  actions() {
    const t = testRunOf(S.ex.id), testing = t && isActive(t.status);
    return `<span class="badge-soft">AI extraction · no selectors</span>
      <button class="btn" data-act="test-ex" ${testing ? "disabled" : ""}>${testing ? `<span class="spin"></span> Testing…` : "Test on 5 rows"}</button>
      <button class="btn btn-accent" data-act="save-run">Save &amp; run ${I.arrow()}</button>`;
  },
  testRun() { const t = testRunOf(S.ex.id); return t ? S.runCache[t.id] || null : null; },
  preview() {
    const ex = S.ex, t = Extractors.testRun(), tSum = testRunOf(ex.id);
    const testing = tSum && isActive(tSum.status);
    const chrome = `<div class="chrome"><div class="lights" aria-hidden="true"><i></i><i></i><i></i></div>
      <label class="addr"><span class="sr">Page URL</span><input id="exUrl" value="${esc(ex.url)}" spellcheck="false" /></label>
      <span class="hint">${testing ? "Live · test run" : t?.rows?.length ? "Click a value to select its field" : "Preview"}</span></div>`;
    if (testing) {
      const u = t?.streaming_url && /^https:\/\//.test(t.streaming_url) ? t.streaming_url : null;
      const last = t?.steps?.filter((s) => s.kind === "step").slice(-1)[0]?.text;
      return chrome + `<div class="live-frame">${u ? `<iframe src="${esc(u)}" title="Live test run"></iframe>` : `<div class="live-wait"><span class="ring-pulse"></span><span>${esc(last || "Starting a test run on 5 rows…")}</span></div>`}</div>`;
    }
    if (t && (t.status === "failed" || t.status === "cancelled")) {
      return chrome + `<div class="page"><div class="page-empty"><div><b>${esc(t.status === "cancelled" ? "Test stopped" : t.error?.title || "Test failed")}</b>${esc(t.error?.message || "")}<br><button class="btn" data-act="test-ex">Try the test again</button>${t.error?.code === "robots" ? `<br><button class="btn" data-act="ex-robots-off" style="margin-top:8px">I have permission — turn off the robots check</button>` : ""}</div></div></div>`;
    }
    if (!t || !t.rows?.length) {
      return chrome + `<div class="page"><div class="page-empty"><div><b>See exactly what Sieve extracts</b>Run a quick test on 5 rows. The live browser appears here, then each row<br>shows up as a card with every field outlined in its colour.<br><button class="btn" data-act="test-ex">Test on 5 rows</button></div></div></div>`;
    }
    const keys = ex.fields.length ? ex.fields.map((f) => f.key) : columnsOf(t).map((c) => c.key);
    const color = (k) => fieldColor(Math.max(0, keys.indexOf(k)));
    const imgKey = Object.keys(t.rows[0] || {}).find((k) => /image|img|thumb|photo|picture/i.test(k));
    const cards = t.rows.slice(0, 6).map((row) => {
      const img = imgKey && isUrl(row[imgKey]) ? `<img src="${esc(row[imgKey])}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : "";
      return `<div class="pcard"><div class="pimg" aria-hidden="true">${img || I.box()}</div>${keys.filter((k) => k !== imgKey).slice(0, 6).map((k) => {
        const v = row[k], c = color(k), on = S.sel === k;
        const txt = v == null ? "null" : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
        return `<button type="button" class="fv ${v == null ? "null" : ""}" data-act="pick-field" data-k="${esc(k)}" title="${esc(k)}: ${esc(txt)}" style="outline:2px solid ${c};background:${on ? c + "55" : "transparent"}"><span class="k">${esc(k)}</span>${esc(txt)}</button>`;
      }).join("")}</div>`;
    }).join("");
    const pg = t.pagination;
    const foot = pg && pg.detected ? `<div class="page-foot"><span class="cur">1</span>${[2, 3].filter((n) => !pg.total_pages || n <= pg.total_pages).map((n) => `<span>${n}</span>`).join("")}<span class="nxt">${esc(pg.next_label || "Next")} →</span></div>` : "";
    return chrome + `<div class="page"><div class="page-top"><b>${esc(ex.name)}</b><span>${t.row_count} rows in test · ${relTime(t.finished_at)}</span></div><div class="cards">${cards}</div>${foot}</div>`;
  },
  side() {
    const ex = S.ex, t = Extractors.testRun();
    const sample = t?.rows?.[0];
    const fieldBtns = ex.fields.map((f, i) => {
      const on = S.sel === f.key, c = fieldColor(i);
      return `<button type="button" class="fbtn" data-act="pick-field" data-k="${esc(f.key)}" aria-pressed="${on}" style="border-color:${on ? c : "rgba(255,255,255,0.08)"}">
          <span class="sw" style="background:${c}"></span><span class="txt"><b>${esc(f.key)}</b><span>${esc(f.desc || "AI finds the best match")}</span></span><span class="chip-tag">${esc(f.type)}</span></button>
        ${on ? `<div class="fedit">
          <label class="field">Key<input class="input mono" data-fe="key" value="${esc(f.key)}" /></label>
          <label class="field">Type<select class="select" data-fe="type">${FIELD_TYPES.map((t2) => `<option ${t2 === f.type ? "selected" : ""}>${t2}</option>`).join("")}</select></label>
          <label class="field full">Description (helps the AI)<input class="input" data-fe="desc" value="${esc(f.desc)}" placeholder="e.g. the price after discount, digits only" /></label>
          <div class="fedit-actions"><button type="button" class="btn btn-xs btn-danger" data-act="del-field">Remove field</button><div class="inline"><button type="button" class="btn btn-xs" data-act="move-field" data-d="-1" aria-label="Move up" ${i === 0 ? "disabled" : ""}>↑</button><button type="button" class="btn btn-xs" data-act="move-field" data-d="1" aria-label="Move down" ${i === ex.fields.length - 1 ? "disabled" : ""}>↓</button></div></div>
        </div>` : ""}`;
    }).join("");
    const detected = sample && !ex.fields.length ? Object.keys(sample).length : 0;
    const pg = t?.pagination;
    const pagNote = pg && pg.detected ? `<div class="note-violet">${I.arrow()}<span>Pagination detected: “${esc(pg.next_label || "Next")} →”${pg.total_pages ? ` · ${pg.total_pages} pages` : ""}</span>${ex.mode === "page" ? ` <button class="btn btn-xs" data-act="ex-crawl" style="margin-left:auto">Use crawl</button>` : ""}</div>`
      : ex.mode !== "page" ? `<div class="note-plain">${ex.mode === "crawl" ? `Crawl mode follows pagination up to ${ex.max_pages} pages.` : `Sitemap mode picks up to ${ex.max_pages} relevant pages from the sitemap.`}</div>` : "";
    const preview = sample ? (ex.fields.length ? Object.fromEntries(ex.fields.map((f) => [f.key, sample[f.key] ?? null])) : sample)
      : ex.fields.length ? Object.fromEntries(ex.fields.map((f) => [f.key, { text: "…", number: 0, integer: 0, boolean: true, url: "https://…", date: "2026-01-01", list: ["…"] }[f.type]])) : { "…": "Sieve picks keys from your instructions" };
    let pj = esc(JSON.stringify(preview, null, 2));
    Object.keys(preview).forEach((k, i) => { pj = pj.replace(`&quot;${esc(k)}&quot;:`, `<span style="color:${fieldColor(i)}">&quot;${esc(k)}&quot;</span>:`); });
    const o = ex.options || {};
    const opt = (id, label) => `<button type="button" class="switch" role="switch" aria-checked="${!!o[id]}" data-act="ex-opt" data-opt="${id}"><span class="track"></span><span>${label}</span></button>`;
    return `<div class="card">
        <div class="card-head"><h2>Fields</h2><span class="mono">${ex.fields.length ? `item · ${ex.fields.length} fields` : "auto"}${t?.row_count ? ` · ${t.row_count} test rows` : ""}</span></div>
        ${fieldBtns || `<div class="note-plain">No fields yet — Sieve chooses sensible keys from your instructions. Add fields to lock the output shape.</div>`}
        ${detected ? `<button type="button" class="btn btn-sm" data-act="detect-fields">Use the ${detected} detected fields</button>` : ""}
        ${S.adding ? `<div class="add-input"><input class="input" id="newField" placeholder="Field name, or describe it: “seller name”" aria-label="New field" /><button class="btn" data-act="add-field-go">Add</button></div>` : `<button type="button" class="add-field" data-act="add-field">+ Add field or describe one</button>`}
        ${pagNote}
      </div>
      <div class="card">
        <div class="card-head"><h2>Instructions</h2><span class="mono">${esc(ex.mode)}</span></div>
        <label class="field">Name<input class="input" id="exName" value="${esc(ex.name)}" /></label>
        <label class="field">What to extract<textarea class="textarea" id="exPrompt" rows="3">${esc(ex.prompt || "")}</textarea></label>
        <div class="inline" style="flex-wrap:wrap">
          <div class="seg sm" role="radiogroup" aria-label="Mode">${[["page", "Page"], ["crawl", "Crawl"], ["sitemap", "Sitemap"]].map(([k, l]) => `<button type="button" role="radio" aria-checked="${ex.mode === k}" data-act="ex-mode" data-k="${k}">${l}</button>`).join("")}</div>
          ${ex.mode !== "page" ? `<label class="rf-pages" style="height:38px">Pages<select id="exPages">${[2, 3, 5, 8, 10, 15, 25].map((n) => `<option ${+ex.max_pages === n ? "selected" : ""}>${n}</option>`).join("")}</select></label>` : ""}
          <label class="rf-pages" style="height:38px">Format<select id="exFormat">${["json", "jsonl", "csv"].map((f) => `<option value="${f}" ${ex.format === f ? "selected" : ""}>${f.toUpperCase()}</option>`).join("")}</select></label>
        </div>
        <div class="inline" style="flex-wrap:wrap">${opt("stealth", "Stealth")}${opt("use_proxy", "Proxy")}${opt("respect_robots", "robots.txt")}</div>
        <div class="inline" style="justify-content:space-between">${S.cloud ? "<span></span>" : `<a href="#" data-act="ex-schedule" style="font-size:13px;display:inline-flex;gap:6px;align-items:center">${I.clock(14)} Schedule this extractor</a>`}<button class="btn btn-xs btn-danger" data-act="ex-delete">Delete extractor</button></div>
      </div>
      <div class="card dark">
        <div class="card-head"><h2>Output preview</h2><span class="muted" style="font-size:12px">${esc((ex.format || "json").toUpperCase())}${sample ? " · from test" : " · shape"}</span></div>
        <pre class="json">${pj}</pre>
      </div>`;
  },
  after() {
    const nx = $("#newEx");
    if (nx) {
      $("#nxUrl").focus();
      nx.addEventListener("submit", async (e) => {
        e.preventDefault();
        let url = $("#nxUrl").value.trim(); if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
        const err = $("#nxErr");
        try { new URL(url); } catch { err.textContent = "Enter the full URL of the page to scrape."; err.classList.remove("hidden"); return; }
        try {
          const s = settings();
          const r = await api("POST", "/api/extractors", { url, prompt: $("#nxPrompt").value.trim(), name: $("#nxName").value.trim() || undefined, mode: "page", options: { stealth: s.stealth, use_proxy: s.use_proxy, respect_robots: s.respect_robots } });
          await refreshState(); S.ex = null; go(`#/extractors/${r.extractor.id}`);
        } catch (e2) { err.textContent = e2.message; err.classList.remove("hidden"); }
      });
      return;
    }
    Extractors.bindPreview();
    Extractors.bindSide();
  },
  bindPreview() {
    $("#exUrl")?.addEventListener("change", (e) => { let u = e.target.value.trim(); if (u && !/^https?:\/\//i.test(u)) u = "https://" + u; S.ex.url = u; e.target.value = u; touchEx(); });
  },
  bindSide() {
    const ex = S.ex; if (!ex) return;
    $("#exName")?.addEventListener("input", (e) => { ex.name = e.target.value; const c = $(".crumb-btn span"); if (c) c.textContent = ex.name; touchEx(); });
    $("#exPrompt")?.addEventListener("input", (e) => { ex.prompt = e.target.value; touchEx(); });
    $("#exPages")?.addEventListener("change", (e) => { ex.max_pages = +e.target.value; touchEx(); });
    $("#exFormat")?.addEventListener("change", (e) => { ex.format = e.target.value; touchEx(); Extractors.redrawSide(); });
    $$("[data-fe]").forEach((inp) => inp.addEventListener(inp.tagName === "SELECT" ? "change" : "input", () => {
      const f = ex.fields.find((x) => x.key === S.sel); if (!f) return;
      const k = inp.dataset.fe;
      if (k === "key") { const nk = fieldKey(inp.value); if (!nk || ex.fields.some((x) => x !== f && x.key === nk)) return; f.key = nk; S.sel = nk; }
      else f[k] = inp.value;
      touchEx();
      Extractors.redrawPreview();
      const b = $('.fbtn[aria-pressed="true"]');
      if (b) { $(".txt b", b).textContent = f.key; $(".txt span", b).textContent = f.desc || "AI finds the best match"; $(".chip-tag", b).textContent = f.type; b.dataset.k = f.key; }
    }));
    const nf = $("#newField");
    if (nf) { nf.focus(); nf.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); Extractors.acts["add-field-go"](); } if (e.key === "Escape") { S.adding = false; Extractors.redrawSide(); } }); }
  },
  redrawSide() { const s = $("#exSide"); if (s) { s.innerHTML = Extractors.side(); Extractors.bindSide(); } },
  redrawPreview() {
    const p = $("#exPreview"); if (!p || document.activeElement?.id === "exUrl") return;
    p.innerHTML = Extractors.preview(); Extractors.bindPreview();
  },
  update() {
    if (!S.ex || !$("#exActions")) return;
    $("#exActions").innerHTML = Extractors.actions();
    const tSum = testRunOf(S.ex.id), t = Extractors.testRun();
    const sig = JSON.stringify([tSum?.id, tSum?.status, t?.status, t?.streaming_url, t?.steps?.length]);
    if (sig !== Extractors._sig) {
      const prev = Extractors._sig ? JSON.parse(Extractors._sig) : null;
      Extractors._sig = sig;
      Extractors.redrawPreview();
      const statusChanged = !prev || prev[2] !== t?.status;
      if (statusChanged && !document.activeElement?.closest?.("#exSide")) Extractors.redrawSide();
    }
  },
  acts: {
    "ex-switch"(el) {
      const m = openMenu(el, `<div class="label">Extractors</div>` + (S.state.extractors || []).map((e) => `<a href="#/extractors/${e.id}" class="${e.id === S.ex?.id ? "on" : ""}"><span class="tx"><b>${esc(e.name)}</b><small>${esc(hostOf(e.url))} · ${e.fields?.length || 0} fields</small></span></a>`).join("") + `<hr><a href="#/extractors/new">+ New extractor</a>`, { width: 320 });
      m.addEventListener("click", () => menuClose?.());
    },
    "pick-field"(el) {
      const k = el.dataset.k;
      if (!S.ex.fields.some((f) => f.key === k)) { S.sel = k; Extractors.redrawPreview(); toast(`“${k}” was picked by the AI — choose “Use the detected fields” to edit it`); return; }
      S.sel = S.sel === k && el.classList.contains("fbtn") ? null : k;
      Extractors.redrawPreview(); Extractors.redrawSide();
    },
    "add-field"() { S.adding = true; Extractors.redrawSide(); },
    "add-field-go"() {
      const inp = $("#newField"); const text = (inp?.value || "").trim().replace(/[“”"']/g, ""); if (!text) { inp?.focus(); return; }
      const isPhrase = text.split(/\s+/).length > 3;
      let key = isPhrase ? fieldKey(text.split(/\s+/).filter((w) => !/^(the|a|an|of|for|each|every|and|to|in)$/i.test(w)).slice(0, 3).join(" ")) : fieldKey(text);
      key = key || "field";
      let k2 = key, n = 2; while (S.ex.fields.some((f) => f.key === k2)) k2 = `${key}_${n++}`;
      const type = /^(is_|has_)|in_stock|available/.test(k2) ? "boolean" : /price|cost|amount|mrp|rating|score|percent|discount/.test(k2) ? "number" : /count|reviews|qty|quantity|points|comments|votes/.test(k2) ? "integer" : /url|link|href|image|img/.test(k2) ? "url" : /date|time|posted|published/.test(k2) ? "date" : /tags|features|highlights/.test(k2) ? "list" : "text";
      S.ex.fields.push({ key: k2, type, desc: isPhrase ? text : "" });
      S.sel = k2; S.adding = false; touchEx(); Extractors.redrawSide(); Extractors.redrawPreview();
    },
    "del-field"() { S.ex.fields = S.ex.fields.filter((f) => f.key !== S.sel); S.sel = S.ex.fields[0]?.key || null; touchEx(); Extractors.redrawSide(); Extractors.redrawPreview(); },
    "move-field"(el) {
      const i = S.ex.fields.findIndex((f) => f.key === S.sel), j = i + +el.dataset.d;
      if (i < 0 || j < 0 || j >= S.ex.fields.length) return;
      [S.ex.fields[i], S.ex.fields[j]] = [S.ex.fields[j], S.ex.fields[i]]; touchEx(); Extractors.redrawSide(); Extractors.redrawPreview();
    },
    "detect-fields"() {
      const t = Extractors.testRun(); if (!t) return;
      S.ex.fields = columnsOf(t).map((c) => ({ key: c.key, type: FIELD_TYPES.includes(c.type) ? c.type : "text", desc: "" }));
      S.sel = S.ex.fields[0]?.key; touchEx(); Extractors.redrawSide(); Extractors.redrawPreview();
      toast(`Locked ${S.ex.fields.length} fields — edit any of them`);
    },
    "ex-mode"(el) { S.ex.mode = el.dataset.k; if (S.ex.mode !== "page" && (!S.ex.max_pages || S.ex.max_pages < 2)) S.ex.max_pages = 3; touchEx(); Extractors.redrawSide(); },
    "ex-crawl"() { S.ex.mode = "crawl"; S.ex.max_pages = Math.max(3, S.ex.max_pages || 3); touchEx(); Extractors.redrawSide(); toast("Switched to crawl mode"); },
    "ex-opt"(el) { const k = el.dataset.opt; S.ex.options[k] = !S.ex.options[k]; el.setAttribute("aria-checked", String(S.ex.options[k])); touchEx(); },
    "ex-robots-off"() { S.ex.options.respect_robots = false; touchEx(); Extractors.redrawSide(); toast("robots.txt check is off for this extractor"); },
    async "test-ex"() {
      await saveEx.flush();
      try { const r = await api("POST", "/api/runs", { extractor_id: S.ex.id, test: true }); await refreshState(); await fetchRun(r.run.id).catch(() => {}); Extractors._sig = null; Extractors.update(); setTimeout(tick, 400); toast("Test started — the live browser appears in the preview"); }
      catch (e) { toast(e.message, { err: true }); }
    },
    async "save-run"(el) {
      el.disabled = true;
      await saveEx.flush();
      try { const r = await api("POST", "/api/runs", { extractor_id: S.ex.id }); await refreshState(); go(`#/datasets/${r.run.id}`); setTimeout(tick, 500); }
      catch (e) { toast(e.message, { err: true }); el.disabled = false; }
    },
    "ex-schedule"() { S.schedForm = true; S.schedPrefill = S.ex.id; go("#/schedules"); },
    async "ex-delete"() {
      if (!confirm(`Delete the extractor “${S.ex.name}”? Its schedules are removed too; past datasets stay.`)) return;
      try { await api("DELETE", `/api/extractors/${S.ex.id}`); S.ex = null; await refreshState(); toast("Extractor deleted"); go("#/extractors"); } catch (e) { toast(e.message, { err: true }); }
    },
  },
};

/* ===================================================================== VIEW: schedules */
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
function cadence(s) {
  if (s.every === "hourly") return `Hourly at :${(s.at || "00:00").split(":")[1]}`;
  if (s.every === "weekly") return `${WEEKDAYS[+s.weekday || 0]}s at ${s.at}`;
  return `Daily at ${s.at}`;
}
const LOCAL_CARD = (what) => `<section class="glass set-card" style="max-width:720px"><h2>${what} run on your own computer</h2>
  <p class="help" style="margin:0">This hosted copy of Sieve keeps everything in your browser and can't run jobs on its own. Run Sieve locally to get ${what.toLowerCase()}, SQLite sync and webhooks:</p>
  <pre class="codeblock">git clone https://github.com/pradumn-quasar7/tiny-fish.git
cd tiny-fish && python3 server.py<button class="btn btn-xs" data-act="copy-code">Copy</button></pre></section>`;
const Schedules = {
  render() {
    if (S.cloud) return `${topBar(`<span class="ws">${ws()}</span><span aria-hidden="true">/</span><span class="here">Schedules</span>`)}
      <div class="page-head"><div class="titles"><h1>Schedules</h1><div class="meta"><span>Local app only</span></div></div></div>${LOCAL_CARD("Schedules")}`;
    const list = S.state.schedules || [], exs = S.state.extractors || [];
    const now = new Date(), at = `${String((now.getHours() + 1) % 24).padStart(2, "0")}:00`;
    const form = S.schedForm && exs.length ? `<div class="form-grid">
        <label class="field full-m">Extractor<select class="select" id="scEx">${exs.map((e) => `<option value="${e.id}" ${S.schedPrefill === e.id ? "selected" : ""}>${esc(e.name)}</option>`).join("")}</select></label>
        <label class="field">Every<select class="select" id="scEvery"><option value="daily">Day</option><option value="hourly">Hour</option><option value="weekly">Week</option></select></label>
        <label class="field">At<input class="input mono" type="time" id="scAt" value="${at}" /></label>
        <label class="field" id="scWdWrap" style="visibility:hidden">Day<select class="select" id="scWd">${WEEKDAYS.map((d, i) => `<option value="${i}">${d}</option>`).join("")}</select></label>
        <button class="btn btn-accent full-m" data-act="sched-create">Create</button></div>` : "";
    return `${topBar(`<span class="ws">${ws()}</span><span aria-hidden="true">/</span><span class="here">Schedules</span>`)}
      <div class="page-head"><div class="titles"><h1>Schedules</h1><div class="meta"><span>${list.filter((s) => s.enabled).length} active</span><span>${list.length} total</span></div></div>
        <div class="actions"><button class="btn btn-accent" data-act="sched-toggle-form" ${exs.length ? "" : "disabled"}>${S.schedForm ? "Close" : `${I.plus(16)} New schedule`}</button></div></div>
      <div class="note-banner">${I.clock(16)}<span>Schedules run while Sieve's server is running on this computer (<span class="mono">python3 server.py</span>). A missed time runs at the next check.</span></div>
      <section class="glass panel">
        <div class="panel-head"><h2>${S.schedForm ? "New schedule" : "All schedules"}</h2></div>
        ${form}
        <div id="schedList">${Schedules.list()}</div>
      </section>`;
  },
  list() {
    const list = S.state.schedules || [];
    if (!list.length) return `<div class="empty-row">${(S.state.extractors || []).length ? "No schedules yet. Create one above, or open a dataset and choose <b>Schedule daily</b>." : 'Create an extractor first — <a href="#/workspace">run an extraction</a>, then schedule it.'}</div>`;
    return list.map((s) => {
      const ex = exById(s.extractor_id), last = s.last_run_id ? runsAll().find((r) => r.id === s.last_run_id) : null;
      return `<div class="sched">
        <div class="nm"><b>${esc(ex?.name || "Deleted extractor")}</b><span>${esc(ex ? hostOf(ex.url) : "")}</span></div>
        <div class="hide-m"><span class="lbl">Cadence</span>${esc(cadence(s))}</div>
        <div class="hide-m"><span class="lbl">Next run</span>${s.enabled ? esc(relTime(s.next_at)) : '<span class="dim">paused</span>'}</div>
        <div class="hide-m"><span class="lbl">Last run</span>${last ? `<a href="#/datasets/${last.id}">${pill(last.status)}</a> <span class="dim" style="font-size:12px">${esc(relTime(last.created_at))}</span>` : '<span class="dim">never</span>'}</div>
        <div class="act">
          <button type="button" class="switch bare" role="switch" aria-checked="${!!s.enabled}" aria-label="Enabled" data-act="sched-enable" data-id="${s.id}"><span class="track"></span></button>
          <button class="btn btn-xs" data-act="sched-run" data-id="${s.id}">Run now</button>
          <button class="btn btn-xs btn-danger" data-act="sched-del" data-id="${s.id}" aria-label="Delete schedule">✕</button>
        </div></div>`;
    }).join("");
  },
  after() {
    const ev = $("#scEvery");
    if (ev) ev.addEventListener("change", () => { $("#scWdWrap").style.visibility = ev.value === "weekly" ? "visible" : "hidden"; });
  },
  update(changed) { const l = $("#schedList"); if (l && changed) l.innerHTML = Schedules.list(); },
  acts: {
    "sched-toggle-form"() { S.schedForm = !S.schedForm; render(); },
    async "sched-create"() {
      try {
        await api("POST", "/api/schedules", { extractor_id: $("#scEx").value, every: $("#scEvery").value, at: $("#scAt").value || "09:00", weekday: +$("#scWd").value });
        S.schedForm = false; S.schedPrefill = null; await refreshState(); render(); toast("Schedule created");
      } catch (e) { toast(e.message, { err: true }); }
    },
    async "sched-enable"(el) {
      const s = S.state.schedules.find((x) => x.id === el.dataset.id); const on = !s.enabled;
      el.setAttribute("aria-checked", String(on));
      try { await api("POST", "/api/schedules", { id: s.id, enabled: on }); await refreshState(); Schedules.update(true); renderShell(); toast(on ? "Schedule resumed" : "Schedule paused"); } catch (e) { toast(e.message, { err: true }); }
    },
    async "sched-run"(el) {
      try { const r = await api("POST", `/api/schedules/${el.dataset.id}/run`); await refreshState(); toast("Run started", { link: { href: `#/datasets/${r.run.id}`, label: "Watch" } }); Schedules.update(true); setTimeout(tick, 500); } catch (e) { toast(e.message, { err: true }); }
    },
    async "sched-del"(el) {
      if (!confirm("Delete this schedule?")) return;
      try { await api("DELETE", `/api/schedules/${el.dataset.id}`); await refreshState(); Schedules.update(true); renderShell(); toast("Schedule deleted"); } catch (e) { toast(e.message, { err: true }); }
    },
  },
};

/* ===================================================================== VIEW: proxies */
const Proxies = {
  render() {
    const s = settings();
    const row = (k, title, sub, extra = "", first) => `<div class="set-row ${first ? "first" : ""}"><div class="tx"><b>${title}</b><span>${sub}</span></div><div class="inline">${extra}<button type="button" class="switch bare" role="switch" aria-checked="${!!s[k]}" aria-label="${title}" data-act="set-toggle" data-k="${k}"><span class="track"></span></button></div></div>`;
    return `${topBar(`<span class="ws">${ws()}</span><span aria-hidden="true">/</span><span class="here">Proxies</span>`)}
      <div class="page-head"><div class="titles"><h1>Proxies &amp; anti-bot</h1><div class="meta"><span>Defaults for every new run. Each extractor can override them.</span></div></div></div>
      <div class="grid-2">
        <section class="glass set-card"><h2>Defaults</h2>
          ${row("stealth", "Stealth browser", "A browser profile that is harder for sites to flag as a bot.", "", true)}
          ${row("use_proxy", "Route through a proxy", "Use a proxy in the country you pick here.", `<select class="select" id="proxyCountry" style="width:auto;height:36px" aria-label="Proxy country">${(s.proxy_countries || []).map((c) => `<option ${c === s.proxy_country ? "selected" : ""}>${c}</option>`).join("")}</select>`)}
          ${row("auto_retry_blocked", "Auto-retry blocked runs", "If a site shows a CAPTCHA or blocks the agent, retry once with stealth + proxy.")}
          ${row("respect_robots", "Respect robots.txt", "Refuse URLs the site's robots.txt disallows. Turn off only when you have permission.")}
        </section>
        <section class="glass set-card"><h2>Check a URL against robots.txt</h2><p class="help">See whether a site allows automated access to a page before you run it.</p>
          <div class="inline"><input class="input mono" id="robotsUrl" placeholder="https://example.com/products" aria-label="URL to check" /><button class="btn" data-act="robots-check">Check</button></div>
          <div id="robotsOut"></div>
          <h2 style="margin-top:8px">Proxy locations</h2><p class="help">TinyFish offers proxies in ${(s.proxy_countries || []).join(", ")}. Most sites work without one — turn it on when a run gets blocked, or to see a country's local prices.</p>
        </section>
      </div>`;
  },
  after() {
    $("#proxyCountry")?.addEventListener("change", async (e) => { await saveSettings({ proxy_country: e.target.value }); S.form = null; toast(`Proxy country set to ${e.target.value}`); });
    $("#robotsUrl")?.addEventListener("keydown", (e) => { if (e.key === "Enter") Proxies.acts["robots-check"](); });
  },
  acts: {
    async "set-toggle"(el) {
      const k = el.dataset.k, on = !settings()[k];
      el.setAttribute("aria-checked", String(on));
      try { await saveSettings({ [k]: on }); S.form = null; toast("Saved"); } catch { el.setAttribute("aria-checked", String(!on)); }
    },
    async "robots-check"() {
      let u = $("#robotsUrl").value.trim(); if (!u) return $("#robotsUrl").focus();
      if (!/^https?:\/\//i.test(u)) u = "https://" + u;
      $("#robotsOut").innerHTML = `<div class="result-line"><span class="spin"></span></div>`;
      try {
        const r = await api("POST", "/api/robots", { url: u });
        $("#robotsOut").innerHTML = r.allowed ? `<div class="result-line ok">Allowed — ${esc(r.rule === "no matching rule" ? "no rule blocks this URL" : `matched “Allow: ${r.rule}”`)}.</div>` : `<div class="result-line bad">Disallowed by robots.txt (rule: <span class="mono">Disallow: ${esc(r.rule)}</span>).</div>`;
      } catch (e) { $("#robotsOut").innerHTML = `<div class="result-line bad">${esc(e.message)}</div>`; }
    },
  },
};

/* ===================================================================== VIEW: API & webhooks */
const Api = {
  render() {
    const s = settings(), w = S.wallet, ex = (S.state.extractors || [])[0], run = runsReal().find((r) => r.status === "completed");
    const o = location.origin;
    const code = (txt) => `<pre class="codeblock">${esc(txt)}<button class="btn btn-xs" data-act="copy-code">Copy</button></pre>`;
    const keyStatus = s.key_source === "env" ? `<div class="result-line ok">Connected · key ${esc(s.key_hint)} from <span class="mono">.env</span></div>`
      : s.key_source === "settings" ? `<div class="result-line ok">Connected · key ${esc(s.key_hint)} saved in Sieve</div>` : `<div class="result-line bad">Not connected — scraping is disabled until you add a key.</div>`;
    const walletHtml = !s.has_key ? `<p class="help">Connect a key to see your balance.</p>`
      : !w ? `<div><span class="spin"></span></div>`
      : w.available ? `<div class="big-num">${money(w.balance, w.currency)}</div><p class="help">${w.step_rate ? `${money(w.step_rate, w.currency)} per agent step · about ${fmtNum(Math.floor(w.balance / w.step_rate))} steps left` : "Available balance"}</p>`
      : `<p class="help">${w.reason === "legacy" ? "Your account is on TinyFish's credit plan, so the balance isn't available over the API." : "Couldn't load the wallet right now."}</p>`;
    if (S.cloud) return `${topBar(`<span class="ws">${ws()}</span><span aria-hidden="true">/</span><span class="here">API &amp; webhooks</span>`)}
      <div class="page-head"><div class="titles"><h1>API &amp; webhooks</h1><div class="meta"><span>Hosted mode — your key and data stay in this browser.</span></div></div></div>
      <div class="grid-2">
        <section class="glass set-card"><h2>TinyFish API key</h2>${s.has_key ? `<div class="result-line ok">Connected · key ${esc(s.key_hint)} saved in this browser</div>` : `<div class="result-line bad">Not connected — add your own TinyFish key to start scraping.</div>`}
          <div class="inline"><input class="input mono" type="password" id="tfKey" placeholder="Paste your TinyFish key" autocomplete="off" aria-label="TinyFish API key" /><button class="btn" data-act="save-key">Save</button></div>
          <p class="help">Stored only in this browser. It's sent with your own requests through Sieve's Vercel function to TinyFish and never saved on the server. Runs use your TinyFish credits. <a href="https://agent.tinyfish.ai/api-keys" target="_blank" rel="noopener">Get a key ↗</a>${s.has_key ? ` · <a href="#" data-act="remove-key">Remove key</a>` : ""}</p>
        </section>
        <section class="glass set-card"><div class="card-head"><h2>Wallet</h2><div class="inline"><button class="btn btn-xs" data-act="wallet-refresh">Refresh</button><a class="btn btn-xs" href="https://agent.tinyfish.ai/wallet" target="_blank" rel="noopener">Add funds ↗</a></div></div>${walletHtml}</section>
      </div>${LOCAL_CARD("Webhooks, the REST API and schedules")}`;
    return `${topBar(`<span class="ws">${ws()}</span><span aria-hidden="true">/</span><span class="here">API &amp; webhooks</span>`)}
      <div class="page-head"><div class="titles"><h1>API &amp; webhooks</h1><div class="meta"><span>Connect TinyFish, send results to your systems, and drive Sieve from scripts.</span></div></div></div>
      <div class="grid-2">
        <section class="glass set-card"><h2>TinyFish API key</h2>${keyStatus}
          <div class="inline"><input class="input mono" type="password" id="tfKey" placeholder="${s.key_source === "env" ? "Set in .env — that key takes priority" : "Paste your TinyFish key"}" autocomplete="off" aria-label="TinyFish API key" /><button class="btn" data-act="save-key">Save</button></div>
          <p class="help">Saved in <span class="mono">data/store.json</span> on this computer. A key in <span class="mono">.env</span> always wins. <a href="https://agent.tinyfish.ai/api-keys" target="_blank" rel="noopener">Get a key ↗</a>${s.key_source === "settings" ? ` · <a href="#" data-act="remove-key">Remove saved key</a>` : ""}</p>
        </section>
        <section class="glass set-card"><div class="card-head"><h2>Wallet</h2><div class="inline"><button class="btn btn-xs" data-act="wallet-refresh">Refresh</button><a class="btn btn-xs" href="https://agent.tinyfish.ai/wallet" target="_blank" rel="noopener">Add funds ↗</a></div></div>${walletHtml}</section>
        <section class="glass set-card"><h2>Webhook</h2><p class="help">Sieve POSTs <span class="mono">{event, run, rows}</span> as JSON to this URL.</p>
          <div class="inline"><input class="input mono" id="whUrl" placeholder="https://hooks.example.com/sieve" value="${esc(s.webhook_url || "")}" aria-label="Webhook URL" /><button class="btn" data-act="save-webhook">Save</button></div>
          <div class="set-row first"><div class="tx"><b>Send every completed run</b><span>Automatically, including scheduled runs.</span></div><button type="button" class="switch bare" role="switch" aria-checked="${!!s.webhook_on_run}" aria-label="Send every completed run" data-act="set-toggle-wh"><span class="track"></span></button></div>
          <div class="inline"><button class="btn btn-sm" data-act="test-webhook">Send a test event</button></div><div id="whOut"></div>
        </section>
        <section class="glass set-card"><h2>Local REST API</h2><p class="help">Available only on this computer at <span class="mono">${esc(o)}</span>.</p>
          <div class="field">Run a saved extractor${code(`curl -X POST ${o}/api/runs -H "Content-Type: application/json" \\\n  -d '{"extractor_id": "${ex ? ex.id : "ex_…"}"}'`)}</div>
          <div class="field">Run any URL${code(`curl -X POST ${o}/api/runs -H "Content-Type: application/json" \\\n  -d '{"url": "https://books.toscrape.com/", "prompt": "Title and price of every book"}'`)}</div>
          <div class="field">Get a run (status, log, rows)${code(`curl ${o}/api/runs/${run ? run.id : "run_…"}`)}</div>
          <div class="field">Download rows${code(`curl -OJ "${o}/api/runs/${run ? run.id : "run_…"}/export?format=csv"`)}</div>
        </section>
      </div>`;
  },
  acts: {
    "copy-code"(el) { copyText(el.parentElement.firstChild.textContent, "Command copied"); },
    async "save-key"() {
      const v = $("#tfKey").value.trim(); if (!v) return $("#tfKey").focus();
      try { await saveSettings({ tinyfish_key: v }); await refreshState(); await refreshWallet(true); render(); toast(settings().key_source === "env" ? "Saved — but the key in .env is still used" : "TinyFish connected"); renderShell(); } catch {}
    },
    async "remove-key"() { try { await saveSettings({ tinyfish_key: "" }); await refreshState(); S.wallet = null; render(); toast("Saved key removed"); } catch {} },
    async "wallet-refresh"() { S.wallet = null; render(); await refreshWallet(true); render(); },
    async "save-webhook"() { try { await saveSettings({ webhook_url: $("#whUrl").value.trim() }); toast("Webhook URL saved"); } catch {} },
    async "set-toggle-wh"(el) {
      const on = !settings().webhook_on_run; el.setAttribute("aria-checked", String(on));
      try { await saveSettings({ webhook_on_run: on }); toast(on ? "Every completed run will be sent" : "Automatic sending off"); } catch { el.setAttribute("aria-checked", String(!on)); }
    },
    async "test-webhook"() {
      const url = $("#whUrl").value.trim(); if (!url) { $("#whUrl").focus(); return; }
      $("#whOut").innerHTML = `<div class="result-line"><span class="spin"></span></div>`;
      try { const r = await api("POST", "/api/settings/test-webhook", { url }); $("#whOut").innerHTML = `<div class="result-line ${r.ok ? "ok" : "bad"}">${r.ok ? `Delivered — HTTP ${r.status}` : esc(r.error || `HTTP ${r.status}`)}</div>`; }
      catch (e) { $("#whOut").innerHTML = `<div class="result-line bad">${esc(e.message)}</div>`; }
    },
  },
};

/* ===================================================================== VIEW: runs (mobile run monitor) */
const Runs = {
  liveIds() { const a = Runs.focus(); return a ? [a.id] : []; },
  focus() { return runsReal().find((r) => isActive(r.status)) || runsReal()[0]; },
  render() {
    return `<header class="m-head"><a class="brand" href="#/workspace">${I.logo(24)}<b>Runs</b></a>
      <div class="inline"><button class="icon-btn" data-act="palette" aria-label="Search">${I.search(18)}</button><a class="icon-btn" href="#/workspace" aria-label="New run" style="background:var(--accent);border:0;color:var(--bg)">${I.plus()}</a></div></header>
      <div id="runsBody" style="display:flex;flex-direction:column;gap:16px">${Runs.body()}</div>`;
  },
  body() {
    const a = Runs.focus();
    if (!a) return `<section class="m-active"><b style="font-size:16px;font-weight:500">No runs yet</b><span class="muted">Start an extraction and follow it here, step by step.</span><a class="btn btn-accent" href="#/workspace">New extraction ${I.arrow()}</a></section>`;
    const full = S.runCache[a.id] || a, e = estimate(full), active = isActive(a.status);
    const others = runsReal().filter((r) => r.id !== a.id).slice(0, 12);
    const today = others.filter((r) => sameDay(new Date(r.created_at), new Date()));
    const earlier = others.filter((r) => !sameDay(new Date(r.created_at), new Date()));
    const item = (r) => `<a class="m-item" href="#/datasets/${r.id}"><span class="tx"><b>${esc(r.name)}</b><span>${r.status === "completed" ? `${fmtNum(r.row_count)} rows · ${relTime(r.finished_at)}` : r.status === "failed" ? `${esc(r.error_title || "failed")} · ${relTime(r.finished_at)}` : isActive(r.status) ? `${STATUS[r.status].toLowerCase()} · ${r.steps_count} steps` : `stopped · ${relTime(r.finished_at)}`}</span></span><span class="sdot ${r.status}" role="img" aria-label="${STATUS[r.status]}"></span></a>`;
    return `<section class="m-active" aria-label="${active ? "Active run" : "Latest run"}">
        <div class="top-line"><div><b>${esc(a.name)}</b><span class="mono">${esc(a.host)}</span></div>${pill(a.status)}</div>
        <div class="ring-row">${ring(e.pct, 96, a.status === "failed" ? "!" : undefined)}
          <div class="kv">
            <div><span>Rows</span><b>${a.status === "completed" ? fmtNum(a.row_count) : "—"}</b></div>
            <div><span>Steps</span><b>${a.steps_count}</b></div>
            <div><span>${active ? "Elapsed" : "Duration"}</span><b>${clock(runMs(full) || 0)}</b></div>
            <div><span>${active ? "ETA" : "Cost"}</span><b>${active ? (e.eta == null ? "—" : "~" + clock(e.eta)) : a.cost != null ? money(a.cost) : "—"}</b></div>
          </div></div>
        <div class="m-buttons">${active ? `<button class="btn" data-act="m-stop" data-id="${a.id}">Stop</button>` : `<a class="btn" href="#/datasets/${a.id}">Open dataset</a>`}<button class="btn" data-act="m-log" data-id="${a.id}">${active ? "Live log" : "Run log"}</button></div>
      </section>
      ${today.length ? `<h2 class="section-label">Earlier today</h2><div class="glass m-list">${today.map(item).join("")}</div>` : ""}
      ${earlier.length ? `<h2 class="section-label">Before today</h2><div class="glass m-list">${earlier.map(item).join("")}</div>` : ""}`;
  },
  update() { const b = $("#runsBody"); if (b) b.innerHTML = Runs.body(); },
  acts: {
    async "m-stop"(el) { el.disabled = true; try { await api("POST", `/api/runs/${el.dataset.id}/cancel`); toast("Stopping…"); } catch (e) { toast(e.message, { err: true }); } setTimeout(tick, 600); },
    async "m-log"(el) { const r = S.runCache[el.dataset.id] || await fetchRun(el.dataset.id); openSheet(r); },
  },
};

/* ===================================================================== VIEW: alerts (mobile) */
const Alerts = {
  render() {
    return `${topBar(`<span class="here">Alerts</span>`)}
      <div class="page-head"><div class="titles"><h1>Alerts</h1></div><div class="actions"><button class="btn btn-sm" data-act="mark-read">Mark all read</button></div></div>
      <section class="glass m-list" style="max-width:none">${notifList()}</section>`;
  },
  update(changed) { if (changed) render(); },
};

/* ===================================================================== render */
const VIEWS = { workspace: Workspace, datasets: Datasets, dataset: Dataset, extractors: Extractors, schedules: Schedules, proxies: Proxies, api: Api, runs: Runs, alerts: Alerts };
const VIEW = () => VIEWS[S.route.view];
let lastRouteKey = "";
function render() {
  if (!S.state) return;
  S.route = parseRoute();
  const key = S.route.view + "/" + (S.route.id || "");
  if (key !== lastRouteKey) {
    if (S.route.view === "dataset") { S.ds = { tab: "table", page: 0, sort: null, q: "" }; S.run = null; }
    if (S.route.view !== "extractors") S.ex = null;
    Extractors._sig = null;
    lastRouteKey = key;
  }
  renderShell();
  const v = VIEW();
  $("#view").innerHTML = v.render();
  v.after?.();
}

/* ===================================================================== boot */
(async function boot() {
  try { const h = await fetch("/api/health").then((r) => r.json()); S.cloud = h.mode === "cloud" && !!window.SieveCloud; } catch { S.cloud = false; }
  document.body.classList.toggle("cloud", S.cloud);
  const ok = await refreshState();
  if (!ok) return;
  setAccent(settings().accent || ACCENTS[0]);
  render();
  refreshWallet().then(() => { lastWallet = Date.now(); renderShell(); if (S.route.view === "api") render(); });
  knownStatus = Object.fromEntries(runsAll().map((r) => [r.id, r.status]));
  tick();
})();
