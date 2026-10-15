// Scout for Flipkart — frontend
"use strict";

/* ================================================================ helpers */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const inr = (n) => (n == null ? "—" : "₹" + Math.round(n).toLocaleString("en-IN"));
const inrShort = (n) => n >= 1e5 ? "₹" + +(n / 1e5).toFixed(1) + "L" : n >= 1e3 ? "₹" + +(n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k" : "₹" + Math.round(n);
const compact = (n) => (n == null ? "" : n >= 1e5 ? +(n / 1e5).toFixed(1) + "L" : n >= 1e3 ? +(n / 1e3).toFixed(1) + "k" : String(n));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const secs = (ms) => (ms < 60000 ? Math.floor(ms / 1000) + "s" : Math.floor(ms / 60000) + "m " + Math.floor((ms % 60000) / 1000) + "s");

const ICON = {
  star: '<svg viewBox="0 0 24 24"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6L2.5 9.4l6.6-.8z"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
  box: '<svg viewBox="0 0 24 24"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};
const noImg = (cls = "noimg") => `<span class="${cls}">${ICON.box}</span>`;

function toast(msg, type = "") {
  const t = document.createElement("div");
  t.className = "toast " + type;
  t.innerHTML = (type === "err" ? "" : ICON.check) + `<span>${esc(msg)}</span>`;
  $("#toasts").appendChild(t);
  setTimeout(() => t.classList.add("out"), 2600);
  setTimeout(() => t.remove(), 2900);
}

/* ================================================================ state */
const DEFAULTS = { sort: "relevance", minPrice: "", maxPrice: "", minRating: "", limit: "10", stealth: true, proxy: "", notes: "" };
const PROXIES = ["", "US", "GB", "CA", "DE", "FR", "JP", "AU"];

const state = {
  filters: { ...DEFAULTS, ...store.get("fs.filters", {}) },
  products: [],
  query: "",
  view: store.get("fs.view", "grid"),
  running: false,
  controller: null,
  runId: null,
  lastOpts: null,
  tableSort: null,
  picked: new Set(),
  serverHasKey: false,
};
if (!PROXIES.includes(state.filters.proxy)) state.filters.proxy = ""; // old builds stored a boolean here

const userKey = () => store.get("fs.key", "");
const hasKey = () => state.serverHasKey || !!userKey();

/* ================================================================ theme + chrome */
function applyTheme(t) { t ? (document.documentElement.dataset.theme = t) : delete document.documentElement.dataset.theme; }
applyTheme(store.get("fs.theme", null));
$("#themeBtn").onclick = () => {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  applyTheme(next); store.set("fs.theme", next);
  if (state.products.length) renderOverview();
};
addEventListener("scroll", () => $(".topbar").classList.toggle("scrolled", scrollY > 8), { passive: true });

/* ================================================================ API key */
function renderKey() {
  const pill = $("#keyPill"), ok = hasKey();
  pill.className = "status-pill " + (ok ? "ok" : "bad");
  $("#keyPillText").textContent = ok ? "Connected" : "Connect TinyFish";
  pill.title = ok ? (userKey() ? "Using the key saved in this browser" : "Using TINYFISH_API_KEY from .env") : "Add your TinyFish API key";
  $("#connect").classList.toggle("hidden", ok || state.running || !!state.products.length);
  $("#keySource").textContent = userKey() ? "Saved in this browser." : state.serverHasKey ? "Currently using the key from .env." : "No key set yet.";
}
fetch("/api/health").then((r) => r.json()).then((j) => { state.serverHasKey = !!j.hasKey; renderKey(); })
  .catch(() => { $("#keyPillText").textContent = "Server offline"; $("#keyPill").className = "status-pill bad"; });

function saveKey(v) {
  v = (v || "").trim();
  v ? store.set("fs.key", v) : store.del("fs.key");
  renderKey();
  return v;
}
$("#connectForm").onsubmit = (e) => {
  e.preventDefault();
  if (!saveKey($("#connectKey").value)) return $("#connectKey").focus();
  $("#connectKey").value = "";
  toast("Connected to TinyFish");
  $("#query").focus();
};
$("#keyPill").onclick = () => openOverlay("settings");
$("#settingsBtn").onclick = () => openOverlay("settings");
$("#toggleKey").onclick = () => {
  const i = $("#apiKey"); i.type = i.type === "password" ? "text" : "password";
  $("#toggleKey").textContent = i.type === "password" ? "Show" : "Hide";
};
$("#saveKey").onclick = () => { const v = saveKey($("#apiKey").value); closeOverlays(); toast(v ? "API key saved" : "API key removed"); };
$("#clearKey").onclick = () => { saveKey(""); $("#apiKey").value = ""; toast("API key removed"); };

/* ================================================================ overlays */
function openOverlay(id) {
  closePops();
  const el = $("#" + id);
  el.classList.add("show"); el.setAttribute("aria-hidden", "false");
  $("#scrim").classList.add("show");
  if (id === "settings") { $("#apiKey").value = userKey(); renderKey(); setTimeout(() => $("#apiKey").focus(), 60); }
  if (id === "drawer") renderHistory();
}
function closeOverlays() {
  $$(".drawer.show, .modal.show").forEach((el) => { el.classList.remove("show"); el.setAttribute("aria-hidden", "true"); });
  $("#scrim").classList.remove("show");
}
$("#scrim").onclick = closeOverlays;
$$("[data-close]").forEach((b) => (b.onclick = closeOverlays));
$$(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) closeOverlays(); }));
$("#historyBtn").onclick = () => openOverlay("drawer");

/* ================================================================ popovers */
function closePops(except) {
  $$(".pop.open").forEach((p) => { if (p !== except) { p.classList.remove("open"); $(`[data-pop="${p.id.slice(4)}"]`)?.setAttribute("aria-expanded", "false"); } });
}
document.addEventListener("click", (e) => {
  const trigger = e.target.closest("[data-pop]");
  if (trigger) {
    const pop = $("#pop-" + trigger.dataset.pop);
    const opening = !pop.classList.contains("open");
    closePops(pop);
    pop.classList.toggle("open", opening);
    trigger.setAttribute("aria-expanded", String(opening));
    if (opening && trigger.dataset.pop === "price") {
      $("#minPrice").value = state.filters.minPrice; $("#maxPrice").value = state.filters.maxPrice;
      setTimeout(() => $("#minPrice").focus(), 30);
    }
    return;
  }
  if (!e.target.closest(".pop")) closePops();
  if (!e.target.closest(".command-bar")) hideSuggest();
});

/* ================================================================ filters */
const SORT_LABEL = { relevance: "Relevance", popularity: "Popularity", price_asc: "Price ↑", price_desc: "Price ↓", newest: "Newest" };

function setFilter(k, v) { state.filters[k] = v; store.set("fs.filters", state.filters); renderPills(); }

function renderPills() {
  const f = state.filters;
  $("#pv-sort").textContent = SORT_LABEL[f.sort] || "Relevance";
  $("#pv-price").textContent = f.minPrice && f.maxPrice ? `${inrShort(+f.minPrice)}–${inrShort(+f.maxPrice)}`
    : f.minPrice ? `${inrShort(+f.minPrice)}+` : f.maxPrice ? `Under ${inrShort(+f.maxPrice)}` : "Any";
  $("#pv-rating").textContent = f.minRating ? `${f.minRating}★+` : "Any";
  $("#pv-limit").textContent = `${f.limit} products`;
  const optsChanged = !f.stealth || f.proxy || f.notes.trim();
  $("#pv-opts").textContent = f.proxy ? `Proxy ${f.proxy}` : optsChanged ? "Agent •" : "Agent";

  $('[data-pop="sort"]').classList.toggle("active", f.sort !== "relevance");
  $('[data-pop="price"]').classList.toggle("active", !!(f.minPrice || f.maxPrice));
  $('[data-pop="rating"]').classList.toggle("active", !!f.minRating);
  $('[data-pop="limit"]').classList.toggle("active", f.limit !== DEFAULTS.limit);
  $('[data-pop="opts"]').classList.toggle("active", !!optsChanged);

  $$('.opt-list[data-name="sort"] button').forEach((b) => b.classList.toggle("sel", b.dataset.v === f.sort));
  $$('.opt-list[data-name="minRating"] button').forEach((b) => b.classList.toggle("sel", b.dataset.v === String(f.minRating)));
  $$('.seg-choice[data-name="limit"] button').forEach((b) => b.classList.toggle("sel", b.dataset.v === String(f.limit)));
  $("#stealth").checked = f.stealth; $("#proxy").value = f.proxy; $("#notes").value = f.notes;

  const dirty = Object.keys(DEFAULTS).some((k) => String(f[k]) !== String(DEFAULTS[k]));
  $("#resetFilters").classList.toggle("hidden", !dirty);
}

$$(".opt-list").forEach((list) => list.addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  setFilter(list.dataset.name, b.dataset.v); closePops();
}));
$(".seg-choice").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  setFilter("limit", b.dataset.v); setTimeout(closePops, 120);
});
$$(".preset").forEach((b) => (b.onclick = () => { $("#minPrice").value = b.dataset.min; $("#maxPrice").value = b.dataset.max; applyPrice(); }));
function applyPrice() {
  let lo = $("#minPrice").value.trim(), hi = $("#maxPrice").value.trim();
  if (lo && hi && +lo > +hi) [lo, hi] = [hi, lo];
  state.filters.minPrice = lo; setFilter("maxPrice", hi); closePops();
}
$("#priceApply").onclick = applyPrice;
$("#priceClear").onclick = () => { $("#minPrice").value = $("#maxPrice").value = ""; applyPrice(); };
["#minPrice", "#maxPrice"].forEach((s) => $(s).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); applyPrice(); } }));
$("#stealth").onchange = (e) => setFilter("stealth", e.target.checked);
$("#proxy").onchange = (e) => setFilter("proxy", e.target.value);
$("#notes").oninput = debounce((e) => setFilter("notes", e.target.value), 250);
$("#resetFilters").onclick = () => { state.filters = { ...DEFAULTS }; store.set("fs.filters", state.filters); renderPills(); toast("Filters reset"); };

/* ================================================================ ideas + suggestions */
const IDEAS = [
  { e: "📱", t: "5G phones under ₹20k", s: "Popular · 4★ and up", q: "5G mobile", f: { maxPrice: "20000", minPrice: "", sort: "popularity", minRating: "4" } },
  { e: "🎧", t: "Wireless earbuds", s: "Lowest price first", q: "wireless earbuds", f: { sort: "price_asc", minRating: "4", minPrice: "", maxPrice: "" } },
  { e: "💻", t: "Laptops for students", s: "₹30k – ₹60k", q: "laptop for students", f: { minPrice: "30000", maxPrice: "60000", sort: "relevance", minRating: "" } },
  { e: "⌚", t: "Smartwatches", s: "Top rated", q: "smartwatch", f: { minRating: "4", sort: "popularity", minPrice: "", maxPrice: "" } },
  { e: "👟", t: "Running shoes", s: "Under ₹3,000", q: "running shoes men", f: { maxPrice: "3000", minPrice: "", sort: "popularity", minRating: "" } },
  { e: "🍳", t: "Air fryers", s: "Newest models", q: "air fryer", f: { sort: "newest", minRating: "", minPrice: "", maxPrice: "" } },
];
$("#ideaGrid").innerHTML = IDEAS.map((x, i) => `
  <button class="idea" type="button" data-i="${i}">
    <span class="idea-emoji">${x.e}</span>
    <span><b>${esc(x.t)}</b><small>${esc(x.s)}</small></span>
    <span class="go">${ICON.arrow}</span>
  </button>`).join("");
$("#ideaGrid").onclick = (e) => {
  const b = e.target.closest(".idea"); if (!b) return;
  const x = IDEAS[+b.dataset.i];
  Object.assign(state.filters, x.f); store.set("fs.filters", state.filters); renderPills();
  $("#query").value = x.q; syncClear();
  submit();
};

let sugIndex = -1, sugItems = [];
function showSuggest() {
  const q = $("#query").value.trim().toLowerCase();
  const recent = store.get("fs.history", []).map((h) => h.query).filter((v, i, a) => a.indexOf(v) === i);
  const recentMatch = recent.filter((r) => !q || r.toLowerCase().includes(q)).slice(0, 5);
  const ideaMatch = q ? IDEAS.filter((x) => (x.q + " " + x.t).toLowerCase().includes(q) && !recentMatch.includes(x.q)).slice(0, 3) : [];
  sugItems = [...recentMatch.map((r) => ({ q: r, kind: "recent" })), ...ideaMatch.map((x) => ({ q: x.q, kind: "idea", label: x.t }))];
  if (!sugItems.length || /^https?:/i.test(q)) return hideSuggest();
  let html = "", lastKind = "";
  sugItems.forEach((s, i) => {
    if (s.kind !== lastKind) { html += `<li class="s-label" role="presentation">${s.kind === "recent" ? "Recent" : "Ideas"}</li>`; lastKind = s.kind; }
    html += `<li role="option" id="sug-${i}" data-i="${i}" aria-selected="${i === sugIndex}">${s.kind === "recent" ? ICON.clock : ICON.search}<span>${esc(s.label || s.q)}</span>${s.kind === "recent" ? '<span class="s-meta">↵</span>' : ""}</li>`;
  });
  $("#suggest").innerHTML = html;
  $("#suggest").classList.remove("hidden");
  $("#query").setAttribute("aria-expanded", "true");
}
function hideSuggest() { $("#suggest").classList.add("hidden"); $("#query").setAttribute("aria-expanded", "false"); sugIndex = -1; }
function syncClear() { $("#clearQuery").classList.toggle("hidden", !$("#query").value); }
$("#query").addEventListener("focus", showSuggest);
$("#query").addEventListener("input", () => { sugIndex = -1; syncClear(); showSuggest(); });
$("#query").addEventListener("keydown", (e) => {
  const open = !$("#suggest").classList.contains("hidden");
  if (e.key === "ArrowDown" && open) { e.preventDefault(); sugIndex = (sugIndex + 1) % sugItems.length; showSuggest(); }
  else if (e.key === "ArrowUp" && open) { e.preventDefault(); sugIndex = (sugIndex - 1 + sugItems.length) % sugItems.length; showSuggest(); }
  else if (e.key === "Enter" && open && sugIndex >= 0) { e.preventDefault(); $("#query").value = sugItems[sugIndex].q; hideSuggest(); submit(); }
  else if (e.key === "Escape") { hideSuggest(); }
  $("#query").setAttribute("aria-activedescendant", sugIndex >= 0 ? "sug-" + sugIndex : "");
});
$("#suggest").addEventListener("mousedown", (e) => {
  const li = e.target.closest('li[role="option"]'); if (!li) return;
  e.preventDefault();
  $("#query").value = sugItems[+li.dataset.i].q; syncClear(); hideSuggest(); submit();
});
$("#clearQuery").onclick = () => { $("#query").value = ""; syncClear(); $("#query").focus(); };

/* ================================================================ submit */
$("#searchForm").onsubmit = (e) => { e.preventDefault(); submit(); };

function submit(overrides = {}) {
  if (state.running) return;
  hideSuggest(); closePops();
  const query = $("#query").value.trim();
  if (!query) { $("#query").focus(); toast("Type a product or paste a Flipkart link", "err"); return; }
  if (!hasKey()) {
    renderKey(); $("#connect").classList.remove("hidden");
    $("#connectKey").focus(); toast("Connect your TinyFish key first", "err"); return;
  }
  const f = { ...state.filters, ...overrides };
  startRun({ query, ...f, apiKey: userKey() || undefined });
}

/* ================================================================ run */
let timerInt = null, t0 = 0, steps = 0;
const PHASE_RE = /extract|collect|scroll|read|gather|product|listing|price|scrap/i;

function setPhase(i, final) {
  $$("#phases li").forEach((li, j) => {
    li.classList.toggle("done", j < i || (final === "ok"));
    li.classList.toggle("now", j === i && !final);
  });
  if (final === "fail") $$("#phases li")[i]?.classList.add("now");
}
let curPhase = 0;
const advance = (i) => { if (i > curPhase) { curPhase = i; setPhase(i); } };

function logStep(text, cls = "") {
  $$("#log li.cur").forEach((li) => li.classList.remove("cur"));
  const li = document.createElement("li");
  li.className = cls || "cur";
  li.innerHTML = `<i></i><span>${esc(text)}</span><time>${secs(performance.now() - t0)}</time>`;
  $("#log").appendChild(li);
  $("#log").scrollTop = $("#log").scrollHeight;
}

function setRunHeader(kind, label) {
  $("#runStatus").textContent = label;
  const ico = $("#runIco");
  ico.className = "run-ico " + (kind === "ok" ? "ok" : kind === "fail" ? "fail" : "");
  ico.innerHTML = kind === "ok" ? ICON.check : kind === "fail" ? ICON.x : '<span class="spin"></span>';
  $("#runPanel").classList.toggle("is-ok", kind === "ok");
  $("#runPanel").classList.toggle("is-fail", kind === "fail");
  $("#cancelBtn").classList.toggle("hidden", kind !== "run");
}

function showSkeletons(n) {
  $("#results").classList.remove("hidden");
  $("#overview").innerHTML = "";
  ["#notice", "#rawBox", "#tableWrap", "#toolbar"].forEach((s) => $(s).classList.add("hidden"));
  $("#grid").classList.remove("hidden");
  $("#resultsTitle").textContent = "Collecting products…";
  $("#resultsSub").textContent = "Cards fill in when the agent finishes.";
  $("#grid").innerHTML = Array.from({ length: Math.min(n, 8) }, () => `
    <div class="card skeleton"><div class="card-media"><div class="sk" style="width:60%;height:60%"></div></div>
    <div class="card-body"><div class="sk" style="height:13px"></div><div class="sk" style="height:13px;width:72%"></div>
    <div class="sk" style="height:12px;width:40%"></div><div class="sk" style="height:22px;width:50%;margin-top:12px"></div></div></div>`).join("");
}

async function startRun(opts) {
  state.running = true;
  state.lastOpts = opts;
  state.query = opts.query;
  state.runId = null;
  state.picked.clear(); renderTray();
  steps = 0; curPhase = 0; t0 = performance.now();

  $("#ideas").classList.add("hidden");
  $("#connect").classList.add("hidden");
  $("#errorCard").classList.add("hidden");
  $("#hero").classList.add("compact");
  const run = $("#runPanel");
  run.classList.remove("hidden", "collapsed", "is-ok", "is-fail");
  $("#toggleDetails").classList.add("hidden");
  $("#log").innerHTML = "";
  $("#runSteps").textContent = "0 steps";
  $("#runHint").textContent = `${opts.limit} products · usually 30–90s`;
  $("#runLink").classList.add("hidden");
  $("#liveOpen").classList.add("hidden");
  $("#addr").textContent = "flipkart.com";
  $("#liveFrame").innerHTML = `<div class="live-wait"><span class="pulse-ring"></span><span>Starting a cloud browser…</span></div>`;
  $("#goBtn").disabled = true; $("#goBtn").classList.add("loading"); $("#goBtn .btn-label").textContent = "Scraping";
  setRunHeader("run", "Starting the agent");
  setPhase(0);
  showSkeletons(+opts.limit);
  scrollTo({ top: 0, behavior: "smooth" });

  clearInterval(timerInt);
  timerInt = setInterval(() => ($("#runTimer").textContent = secs(performance.now() - t0)), 250);

  state.controller = new AbortController();
  let done = false;
  try {
    const res = await fetch("/api/scrape", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts), signal: state.controller.signal,
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || "Server error " + res.status); }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data:"));
        buf = buf.slice(i + 2);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (handleEvent(ev)) done = true;
      }
    }
    if (!done) throw new Error("The connection closed before the agent finished.");
  } catch (err) {
    if (err.name === "AbortError") {
      logStep("Stopped", "err");
      setRunHeader("fail", "You stopped the run");
      setPhase(curPhase, "fail");
      resetResultsArea();
    } else {
      logStep(err.message, "err");
      setRunHeader("fail", "The run didn't finish");
      setPhase(curPhase, "fail");
      resetResultsArea();
      showError(err.message);
    }
  } finally {
    finishRun();
  }
}

function handleEvent(ev) {
  switch (ev.type) {
    case "TARGET": {
      const short = decodeURIComponent(ev.url.replace(/^https?:\/\/(www\.)?/, ""));
      $("#addr").textContent = short;
      logStep("Target: " + short, "sys");
      break;
    }
    case "STARTED":
      state.runId = ev.run_id;
      advance(1);
      setRunHeader("run", "Opening Flipkart");
      logStep("Cloud browser launched", "sys");
      if (ev.run_id) { $("#runLink").href = `https://agent.tinyfish.ai/runs/${ev.run_id}`; $("#runLink").classList.remove("hidden"); }
      break;
    case "STREAMING_URL": {
      const u = safeUrl(ev.streaming_url);
      if (u) {
        $("#liveFrame").innerHTML = `<iframe src="${esc(u)}" title="Live browser view" allow="autoplay"></iframe>`;
        $("#liveOpen").href = u; $("#liveOpen").classList.remove("hidden");
      }
      break;
    }
    case "PROGRESS":
      steps++;
      $("#runSteps").textContent = `${steps} step${steps === 1 ? "" : "s"}`;
      if (ev.purpose) {
        logStep(ev.purpose);
        $("#runStatus").textContent = ev.purpose;
        if (PHASE_RE.test(ev.purpose)) advance(2);
      }
      break;
    case "HEARTBEAT":
      break;
    case "ERROR":
      throw new Error(ev.message || "Unknown error");
    case "COMPLETE":
      onComplete(ev);
      return true;
  }
  return false;
}

function onComplete(ev) {
  advance(3);
  if (ev.run_url) { $("#runLink").href = ev.run_url; $("#runLink").classList.remove("hidden"); }
  const took = secs(performance.now() - t0);
  const products = ev.products || [];
  if (ev.status !== "COMPLETED") {
    const msg = (ev.error && (ev.error.message || ev.error.help_message)) || `The run ended with status ${String(ev.status || "FAILED").toLowerCase()}.`;
    logStep(msg, "err");
    setRunHeader("fail", "The run failed");
    setPhase(3, "fail");
    resetResultsArea();
    showError(msg, ev.error);
    return;
  }
  if (!products.length) {
    logStep("No products came back", "err");
    setRunHeader("fail", "No products found");
    setPhase(3, "fail");
    resetResultsArea();
    showAgentError(ev.agent_error, ev.raw);
    return;
  }
  logStep(`Extracted ${products.length} products`, "ok");
  setPhase(3, "ok");
  setRunHeader("ok", `Found ${products.length} products in ${took}`);
  collapseRun(true);
  renderResults(products, { raw: ev.raw });
  saveHistory({ query: state.query, at: Date.now(), products, filters: { ...state.filters } });
  toast(`${products.length} products scraped`);
  setTimeout(() => $("#results").scrollIntoView({ behavior: "smooth", block: "start" }), 150);
}

function finishRun() {
  state.running = false; state.controller = null;
  clearInterval(timerInt);
  $("#runTimer").textContent = secs(performance.now() - t0);
  $("#goBtn").disabled = false; $("#goBtn").classList.remove("loading"); $("#goBtn .btn-label").textContent = "Scrape";
  $("#cancelBtn").classList.add("hidden");
  $("#toggleDetails").classList.remove("hidden");
  const wait = $("#liveFrame .live-wait");
  if (wait) {
    wait.classList.add("ended");
    wait.lastElementChild.textContent = state.runId ? "The live view has ended. Use Replay to watch the recording." : "The browser never started.";
  }
  // keep the outcome (results or error + fixes) in view; the log stays one click away
  collapseRun(true);
  if (!$("#errorCard").classList.contains("hidden")) $("#errorCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function collapseRun(c) {
  $("#runPanel").classList.toggle("collapsed", c);
  $("#toggleDetails").textContent = c ? "Show details" : "Hide details";
}
$("#toggleDetails").onclick = () => collapseRun(!$("#runPanel").classList.contains("collapsed"));

$("#cancelBtn").onclick = () => {
  if (!state.running) return;
  const id = state.runId;
  state.controller?.abort();
  if (id) fetch(`/api/runs/${encodeURIComponent(id)}/cancel`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: userKey() || undefined }),
  }).catch(() => {});
};

/* ================================================================ errors */
function resetResultsArea() {
  state.products = [];
  $("#results").classList.add("hidden");
}

function showError(message, errObj) {
  const m = String(message || "");
  let title = "Something went wrong", body = m, actions = ["retry"];
  if (/401|invalid or expired api key|unauthori[sz]ed/i.test(m)) {
    title = "TinyFish didn't accept your API key";
    body = "The key is missing, mistyped, or expired. Paste a fresh key from your TinyFish dashboard.";
    actions = ["settings", "dashboard"];
  } else if (/402|wallet|balance|billing|credits/i.test(m) || errObj?.category === "BILLING_FAILURE") {
    title = "Your TinyFish balance is too low";
    body = m;
    actions = ["wallet", "retry"];
  } else if (/proxy/i.test(m)) {
    title = "That proxy setting was rejected";
    actions = ["noproxy"];
  } else if (/fetch|network|reach|ECONN|timed? ?out/i.test(m)) {
    title = "Couldn't reach TinyFish";
    body = m + " — check your internet connection and that the server is still running.";
  }
  renderErrorCard(title, body, actions);
}

function showAgentError(code, raw) {
  const map = {
    blocked: ["Flipkart blocked the agent", "Flipkart showed a CAPTCHA or an access-denied page. Running through a proxy usually gets past it.", ["proxy", "retry"]],
    no_results: ["No matching products", "Flipkart had nothing for this search with your filters. Try broader words or loosen the price and rating filters.", ["loosen", "retry"]],
    unparseable: ["The agent's answer couldn't be read", "It replied, but not in the expected format. Running it again usually fixes this.", ["retry"]],
  };
  const [title, body, actions] = map[code] || ["No products came back", "The agent finished without returning any products. Try again, or rephrase the search.", ["retry", "proxy"]];
  renderErrorCard(title, body, actions, raw);
}

function renderErrorCard(title, body, actions, raw) {
  const A = {
    retry: ['<button class="btn btn-ink btn-sm" data-act="retry">Try again</button>', () => rerun()],
    proxy: ['<button class="btn btn-quiet btn-sm" data-act="proxy">Retry with US proxy</button>', () => { setFilter("proxy", "US"); rerun({ proxy: "US" }); }],
    noproxy: ['<button class="btn btn-ink btn-sm" data-act="noproxy">Retry without proxy</button>', () => { setFilter("proxy", ""); rerun({ proxy: "" }); }],
    loosen: ['<button class="btn btn-quiet btn-sm" data-act="loosen">Clear filters &amp; retry</button>', () => { state.filters = { ...DEFAULTS, limit: state.filters.limit }; store.set("fs.filters", state.filters); renderPills(); rerun({ ...state.filters }); }],
    settings: ['<button class="btn btn-ink btn-sm" data-act="settings">Update API key</button>', () => openOverlay("settings")],
    dashboard: ['<a class="btn btn-quiet btn-sm" href="https://agent.tinyfish.ai/api-keys" target="_blank" rel="noopener">Get a key ↗</a>', null],
    wallet: ['<a class="btn btn-ink btn-sm" href="https://agent.tinyfish.ai/wallet" target="_blank" rel="noopener">Add funds ↗</a>', null],
  };
  $("#errTitle").textContent = title;
  $("#errMsg").textContent = body;
  $("#errActions").innerHTML = actions.map((a) => A[a][0]).join("") +
    (raw != null ? '<button class="btn btn-quiet btn-sm" data-act="raw">View raw output</button>' : "");
  $("#errActions").onclick = (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    if (b.dataset.act === "raw") { b.replaceWith(Object.assign(document.createElement("pre"), { className: "raw-inline", textContent: JSON.stringify(raw, null, 2), style: "width:100%;max-height:240px;overflow:auto;font-size:12px;background:var(--surface);padding:10px;border-radius:10px;margin:0" })); return; }
    A[b.dataset.act]?.[1]?.();
  };
  $("#errorCard").classList.remove("hidden");
}
function rerun(overrides = {}) {
  if (!state.lastOpts) return submit(overrides);
  $("#query").value = state.lastOpts.query;
  submit(overrides);
}

/* ================================================================ results */
function valueScore(p, maxPrice) {
  if (!p.price || !p.rating) return -Infinity;
  return p.rating * 2 + (1 - p.price / maxPrice) * 3 + Math.log10((p.rating_count || 1) + 1) * 0.5;
}
function bestValueId(list) {
  const c = list.filter((p) => p.price && p.rating >= 4);
  if (c.length < 3) return null;
  const max = Math.max(...c.map((p) => p.price));
  return c.reduce((a, b) => (valueScore(b, max) > valueScore(a, max) ? b : a)).id;
}

function renderResults(products, meta = {}) {
  state.products = products;
  state.bestId = bestValueId(products);
  state.tableSort = null;
  $("#filterText").value = ""; $("#localSort").value = ""; $("#assuredOnly").checked = false;
  $("#results").classList.remove("hidden");
  $("#toolbar").classList.remove("hidden");
  $("#errorCard").classList.add("hidden");
  $("#notice").classList.add("hidden");

  const isUrl = /^https?:/i.test(state.query);
  $("#resultsTitle").textContent = isUrl ? "Scraped products" : `“${state.query}”`;
  const f = state.filters, bits = [`${products.length} products from Flipkart`];
  if (f.minPrice || f.maxPrice) bits.push($("#pv-price").textContent);
  if (f.minRating) bits.push(`${f.minRating}★ and up`);
  if (f.sort !== "relevance") bits.push(`sorted by ${SORT_LABEL[f.sort].toLowerCase()}`);
  $("#resultsSub").textContent = bits.join(" · ");

  if (meta.raw != null) { $("#rawPre").textContent = JSON.stringify(meta.raw, null, 2); $("#rawBox").classList.remove("hidden"); }
  else $("#rawBox").classList.add("hidden");

  renderOverview();
  renderView();
  renderKey();
}

function renderOverview() {
  const ps = state.products;
  if (!ps.length) { $("#overview").innerHTML = ""; return; }
  const priced = ps.filter((p) => p.price != null);
  const rated = ps.filter((p) => p.rating != null);
  const cheapest = priced.reduce((a, b) => (!a || b.price < a.price ? b : a), null);
  const avgR = rated.length ? rated.reduce((s, p) => s + p.rating, 0) / rated.length : null;
  const deal = ps.filter((p) => p.discount_percent).sort((a, b) => b.discount_percent - a.discount_percent)[0];
  const best = ps.find((p) => p.id === state.bestId);
  const tile = (k, v, s) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s" title="${esc(s)}">${esc(s)}</div></div>`;
  $("#overview").innerHTML =
    tile("Lowest price", inr(cheapest?.price), cheapest?.name || "—") +
    tile("Average rating", avgR ? avgR.toFixed(1) + "★" : "—", `${rated.length} of ${ps.length} rated · ${ps.filter((p) => p.assured).length} Assured`) +
    tile("Biggest discount", deal ? deal.discount_percent + "%" : "—", deal?.name || "No discounts listed") +
    `<div class="tile tile-chart"><div class="k"><span>Price spread</span><span>${best ? "★ = best value" : priced.length + " prices"}</span></div><div id="stripHost"></div></div>`;
  drawStrip();
}

/* price strip plot: one dot per product on a shared price axis */
function drawStrip() {
  const host = $("#stripHost"); if (!host) return;
  const ps = state.products.filter((p) => p.price != null);
  if (ps.length < 2) { host.innerHTML = '<div class="s muted" style="padding:22px 0">Not enough prices to chart.</div>'; return; }
  const W = Math.max(host.clientWidth, 200), H = 76, pad = 10, axisY = 54;
  const lo = Math.min(...ps.map((p) => p.price)), hi = Math.max(...ps.map((p) => p.price));
  const span = hi - lo || 1;
  const x = (v) => pad + ((v - lo) / span) * (W - pad * 2);
  // simple beeswarm: stack dots that would overlap into rows around the centre line
  const rowsY = [30, 18, 42, 6], placed = [];
  const pts = [...ps].sort((a, b) => a.price - b.price).map((p) => {
    const cx = x(p.price);
    let row = 0;
    while (row < rowsY.length - 1 && placed.some((q) => q.row === row && Math.abs(q.cx - cx) < 13)) row++;
    const pt = { p, cx, cy: rowsY[row], row };
    placed.push(pt);
    return pt;
  });
  const sorted = ps.map((p) => p.price).sort((a, b) => a - b);
  const med = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const mx = x(med);
  const ticks = [lo, lo + span / 2, hi];
  host.innerHTML = `<svg class="strip" viewBox="0 0 ${W} ${H}" role="img" aria-label="Prices range from ${inr(lo)} to ${inr(hi)}, median ${inr(med)}">
    <line class="axis" x1="${pad}" x2="${W - pad}" y1="${axisY}" y2="${axisY}"/>
    <line class="med" x1="${mx}" x2="${mx}" y1="0" y2="${axisY}"/>
    ${ticks.map((t, i) => `<text class="tick" x="${x(t)}" y="${H - 4}" text-anchor="${i === 0 ? "start" : i === 2 ? "end" : "middle"}">${inrShort(t)}</text>`).join("")}
    ${pts.map((d) => `<circle class="pt${d.p.id === state.bestId ? " best" : ""}" data-id="${d.p.id}" cx="${d.cx}" cy="${d.cy}" r="5.5"/>`).join("")}
    ${pts.map((d) => `<circle class="hit" data-id="${d.p.id}" cx="${d.cx}" cy="${d.cy}" r="11"/>`).join("")}
  </svg>`;
  const svg = $("svg", host);
  svg.addEventListener("mousemove", (e) => {
    const h = e.target.closest(".hit");
    $$(".pt.hl", svg).forEach((c) => c.classList.remove("hl"));
    if (!h) return hideTip();
    const p = state.products.find((q) => q.id === +h.dataset.id);
    $(`.pt[data-id="${p.id}"]`, svg).classList.add("hl");
    showTip(e, `<b>${inr(p.price)}</b>${esc(p.name)}${p.rating ? `<br>${p.rating}★ · ${compact(p.rating_count) || 0} ratings` : ""}${p.id === state.bestId ? "<br>★ Best value" : ""}`);
  });
  svg.addEventListener("mouseleave", () => { hideTip(); $$(".pt.hl", svg).forEach((c) => c.classList.remove("hl")); });
  svg.addEventListener("click", (e) => { const h = e.target.closest(".hit"); if (h) focusCard(+h.dataset.id); });
}
addEventListener("resize", debounce(() => state.products.length && drawStrip(), 120));

function showTip(e, html) {
  const t = $("#tip");
  t.innerHTML = html; t.classList.add("show");
  const r = t.getBoundingClientRect();
  let left = e.clientX + 14, top = e.clientY - r.height - 12;
  if (left + r.width > innerWidth - 8) left = e.clientX - r.width - 14;
  if (top < 8) top = e.clientY + 16;
  t.style.left = left + "px"; t.style.top = top + "px";
}
function hideTip() { $("#tip").classList.remove("show"); }

function focusCard(id) {
  if (state.view !== "grid") setView("grid");
  $("#filterText").value = ""; $("#assuredOnly").checked = false; renderView();
  const c = $(`.card[data-id="${id}"]`); if (!c) return;
  c.scrollIntoView({ behavior: "smooth", block: "center" });
  c.animate([{ boxShadow: "0 0 0 0 var(--brand)" }, { boxShadow: "0 0 0 6px var(--brand-soft)" }, { boxShadow: "0 0 0 0 transparent" }], { duration: 1200 });
}

function visibleProducts() {
  const q = $("#filterText").value.trim().toLowerCase();
  const assured = $("#assuredOnly").checked;
  let list = state.products.filter((p) => (!q || (p.name + " " + p.highlights.join(" ")).toLowerCase().includes(q)) && (!assured || p.assured));
  const maxPrice = Math.max(1, ...state.products.map((p) => p.price || 0));
  const by = {
    value: (a, b) => valueScore(b, maxPrice) - valueScore(a, maxPrice),
    price_asc: (a, b) => (a.price ?? 1e12) - (b.price ?? 1e12),
    price_desc: (a, b) => (b.price ?? -1) - (a.price ?? -1),
    rating: (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || (b.rating_count ?? 0) - (a.rating_count ?? 0),
    discount: (a, b) => (b.discount_percent ?? -1) - (a.discount_percent ?? -1),
    reviews: (a, b) => (b.rating_count ?? 0) - (a.rating_count ?? 0),
  }[$("#localSort").value];
  if (by) list = [...list].sort(by);
  if (state.tableSort) {
    const { key, dir } = state.tableSort;
    list = [...list].sort((a, b) => {
      const x = a[key], y = b[key];
      if (x == null) return 1; if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir;
    });
  }
  return list;
}

function setView(v) { state.view = v; store.set("fs.view", v); renderView(); }
function renderView() {
  const list = visibleProducts();
  $$(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === state.view));
  $("#countLabel").textContent = list.length === state.products.length ? `${list.length} items` : `${list.length} of ${state.products.length}`;
  const grid = state.view === "grid";
  $("#grid").classList.toggle("hidden", !grid && list.length > 0);
  $("#tableWrap").classList.toggle("hidden", grid || !list.length);
  if (!list.length) {
    $("#grid").innerHTML = `<div class="empty"><b>Nothing matches</b>Try a different filter word or turn off “Assured only”.</div>`;
    return;
  }
  grid ? renderGrid(list) : renderTable(list);
}

const ratingCls = (r) => (r >= 4 ? "" : r >= 3 ? "mid" : "low");
const ratingBadge = (r) => `<span class="rating ${ratingCls(r)}">${r}${ICON.star}</span>`;
const imgTag = (u, alt = "") => (safeUrl(u) ? `<img src="${esc(u)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='${noImg().replace(/"/g, "&quot;")}'">` : noImg());

function renderGrid(list) {
  $("#grid").innerHTML = list.map((p, i) => {
    const url = safeUrl(p.product_url);
    const picked = state.picked.has(p.id), best = p.id === state.bestId;
    return `
    <article class="card${picked ? " picked" : ""}${best ? " best" : ""}" data-id="${p.id}" style="animation-delay:${Math.min(i, 12) * 30}ms">
      <div class="card-media">
        ${imgTag(p.image_url)}
        <button class="pick" type="button" data-pick="${p.id}" aria-pressed="${picked}"><span class="box"></span>Compare</button>
        <span class="rank">#${p.id}</span>
        <div class="ribbon">${best ? '<span class="tag tag-best">★ Best value</span>' : ""}${p.sponsored ? '<span class="tag tag-ad">Ad</span>' : ""}</div>
      </div>
      <div class="card-body">
        ${url ? `<a class="card-name" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(p.name)}">${esc(p.name)}</a>` : `<div class="card-name" title="${esc(p.name)}">${esc(p.name)}</div>`}
        <div class="meta-row">
          ${p.rating != null ? ratingBadge(p.rating) : ""}
          ${p.rating_count ? `<span>${compact(p.rating_count)} ratings</span>` : ""}
          ${p.assured ? `<span class="assured">${ICON.shield}Assured</span>` : ""}
        </div>
        ${p.highlights.length ? `<ul class="chips">${p.highlights.slice(0, 3).map((h) => `<li title="${esc(h)}">${esc(h)}</li>`).join("")}</ul>` : ""}
        <div class="price-row">
          <span class="price">${inr(p.price)}</span>
          ${p.original_price && p.original_price > (p.price || 0) ? `<span class="mrp">${inr(p.original_price)}</span>` : ""}
          ${p.discount_percent ? `<span class="off">${p.discount_percent}% off</span>` : ""}
        </div>
      </div>
      ${url ? `<div class="card-foot"><a class="btn btn-quiet btn-sm" href="${esc(url)}" target="_blank" rel="noopener">View on Flipkart ↗</a></div>` : ""}
    </article>`;
  }).join("");
}

const COLS = [
  ["id", "#", "num"], ["image_url", "", ""], ["name", "Product", ""], ["price", "Price", "num"], ["original_price", "MRP", "num"],
  ["discount_percent", "Off", "num"], ["rating", "Rating", "num"], ["rating_count", "Ratings", "num"], ["assured", "Assured", ""],
];
function renderTable(list) {
  const ts = state.tableSort;
  $("#table").innerHTML =
    `<thead><tr>${COLS.map(([k, l, c]) => `<th data-k="${k}" class="${c}${ts?.key === k ? " sorted" : ""}">${l}${ts?.key === k ? (ts.dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead><tbody>` +
    list.map((p) => {
      const url = safeUrl(p.product_url);
      return `<tr>
        <td class="num">${p.id}</td>
        <td><div class="thumb">${imgTag(p.image_url)}</div></td>
        <td class="name">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name)}${p.id === state.bestId ? ' <span class="tag tag-best">★ Best value</span>' : ""}</td>
        <td class="num"><b>${inr(p.price)}</b></td>
        <td class="num muted">${p.original_price ? inr(p.original_price) : "—"}</td>
        <td class="num" style="color:var(--good);font-weight:600">${p.discount_percent ? p.discount_percent + "%" : "—"}</td>
        <td class="num">${p.rating != null ? ratingBadge(p.rating) : "—"}</td>
        <td class="num">${p.rating_count ? p.rating_count.toLocaleString("en-IN") : "—"}</td>
        <td>${p.assured ? `<span class="assured">${ICON.shield}</span>` : ""}</td></tr>`;
    }).join("") + "</tbody>";
}
$("#table").onclick = (e) => {
  const th = e.target.closest("th[data-k]");
  if (!th || th.dataset.k === "image_url") return;
  const k = th.dataset.k;
  state.tableSort = state.tableSort?.key === k ? { key: k, dir: -state.tableSort.dir } : { key: k, dir: k === "name" || k === "price" ? 1 : -1 };
  renderView();
};
$$(".seg-btn").forEach((b) => (b.onclick = () => setView(b.dataset.view)));
$("#filterText").oninput = debounce(renderView, 80);
$("#localSort").onchange = () => { state.tableSort = null; renderView(); };
$("#assuredOnly").onchange = renderView;

/* ================================================================ compare */
$("#grid").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pick]"); if (!b) return;
  const id = +b.dataset.pick;
  if (state.picked.has(id)) state.picked.delete(id);
  else if (state.picked.size >= 4) return toast("You can compare up to 4 products", "err");
  else state.picked.add(id);
  const card = b.closest(".card");
  card.classList.toggle("picked", state.picked.has(id));
  b.setAttribute("aria-pressed", String(state.picked.has(id)));
  renderTray();
});
function renderTray() {
  const items = [...state.picked].map((id) => state.products.find((p) => p.id === id)).filter(Boolean);
  $("#tray").classList.toggle("show", items.length > 0);
  $("#trayItems").innerHTML = items.map((p) => `<button class="tray-thumb" data-unpick="${p.id}" title="Remove ${esc(p.name)}">${imgTag(p.image_url)}</button>`).join("") +
    `<span class="tray-label">${items.length < 2 ? "Pick one more to compare" : `${items.length} selected`}</span>`;
  $("#trayCompare").disabled = items.length < 2;
}
$("#trayItems").onclick = (e) => {
  const b = e.target.closest("[data-unpick]"); if (!b) return;
  state.picked.delete(+b.dataset.unpick); renderTray(); renderView();
};
$("#trayClear").onclick = () => { state.picked.clear(); renderTray(); renderView(); };
$("#trayCompare").onclick = () => {
  const ps = [...state.picked].map((id) => state.products.find((p) => p.id === id)).filter(Boolean);
  const winner = (key, dir) => { const v = ps.map((p) => p[key]).filter((x) => x != null); return v.length > 1 && new Set(v).size > 1 ? (dir > 0 ? Math.max(...v) : Math.min(...v)) : null; };
  const row = (label, key, fmt, dir) => {
    const w = dir ? winner(key, dir) : null;
    return `<tr><th>${label}</th>${ps.map((p) => `<td class="${w != null && p[key] === w ? "win" : ""}">${p[key] == null || p[key] === "" ? "—" : fmt(p[key], p)}</td>`).join("")}</tr>`;
  };
  $("#cmpWrap").innerHTML = `<table class="cmp"><tbody>
    <tr><th></th>${ps.map((p) => `<td><div class="cmp-img">${imgTag(p.image_url)}</div><b>${esc(p.name)}</b></td>`).join("")}</tr>
    ${row("Price", "price", inr, -1)}
    ${row("MRP", "original_price", inr)}
    ${row("Discount", "discount_percent", (v) => v + "%", 1)}
    ${row("Rating", "rating", (v) => v + " ★", 1)}
    ${row("Ratings", "rating_count", (v) => v.toLocaleString("en-IN"), 1)}
    ${row("Assured", "assured", (v) => (v ? "Yes" : "No"))}
    ${row("Highlights", "highlights", (v) => (v.length ? `<ul style="margin:0;padding-left:16px">${v.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>` : "—"))}
    <tr><th></th>${ps.map((p) => `<td>${safeUrl(p.product_url) ? `<a class="btn btn-quiet btn-sm" href="${esc(p.product_url)}" target="_blank" rel="noopener">View ↗</a>` : ""}</td>`).join("")}</tr>
  </tbody></table>`;
  openOverlay("compare");
};

/* ================================================================ export */
const slug = () => "flipkart-" + (state.query.replace(/^https?:\/\/\S+/, "url").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "results") + "-" + new Date().toISOString().slice(0, 10);
function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$("#jsonBtn").onclick = () => { closePops(); download(slug() + ".json", JSON.stringify(visibleProducts(), null, 2), "application/json"); toast("JSON downloaded"); };
$("#csvBtn").onclick = () => {
  closePops();
  const keys = ["id", "name", "price", "original_price", "discount_percent", "rating", "rating_count", "review_count", "assured", "sponsored", "highlights", "product_url", "image_url"];
  const cell = (v) => { const s = Array.isArray(v) ? v.join(" | ") : v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  download(slug() + ".csv", "﻿" + [keys.join(","), ...visibleProducts().map((p) => keys.map((k) => cell(p[k])).join(","))].join("\n"), "text/csv");
  toast("CSV downloaded");
};
$("#copyBtn").onclick = () => {
  closePops();
  navigator.clipboard?.writeText(JSON.stringify(visibleProducts(), null, 2)).then(() => toast("Copied to clipboard"), () => toast("Couldn't copy", "err"));
};

/* ================================================================ history */
function saveHistory(entry) {
  const h = store.get("fs.history", []).filter((x) => x.query !== entry.query);
  h.unshift(entry);
  store.set("fs.history", h.slice(0, 12));
}
function renderHistory() {
  const h = store.get("fs.history", []);
  $("#historyList").innerHTML = h.length
    ? h.map((x, i) => {
        const prices = x.products.map((p) => p.price).filter(Boolean);
        return `<button class="h-item" data-i="${i}"><span class="h-thumb">${imgTag(x.products[0]?.image_url)}</span><span class="h-text"><b>${esc(x.query)}</b>
          <span>${x.products.length} products${prices.length ? " · from " + inr(Math.min(...prices)) : ""} · ${new Date(x.at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span></span></button>`;
      }).join("")
    : `<div class="empty"><b>No history yet</b>Scrapes you run show up here so you can reopen them without spending credits.</div>`;
  $("#clearHistory").classList.toggle("hidden", !h.length);
}
$("#historyList").onclick = (e) => {
  const b = e.target.closest(".h-item"); if (!b || state.running) return;
  const x = store.get("fs.history", [])[+b.dataset.i]; if (!x) return;
  closeOverlays();
  state.query = x.query; $("#query").value = x.query; syncClear();
  state.picked.clear(); renderTray();
  ["#ideas", "#connect", "#runPanel", "#errorCard"].forEach((s) => $(s).classList.add("hidden"));
  $("#hero").classList.add("compact");
  renderResults(x.products, {});
  $("#resultsSub").textContent = `${x.products.length} products · saved ${new Date(x.at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}`;
  $("#results").scrollIntoView({ behavior: "smooth" });
};
$("#clearHistory").onclick = () => { store.del("fs.history"); renderHistory(); toast("History cleared"); };

/* ================================================================ keyboard */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closePops(); closeOverlays(); hideTip(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  const k = e.key.toLowerCase();
  if (e.key === "/") { e.preventDefault(); $("#query").focus(); $("#query").select(); }
  else if (k === "h") openOverlay("drawer");
  else if (k === "g" && state.products.length) setView(state.view === "grid" ? "table" : "grid");
});

/* ================================================================ init */
renderPills();
renderKey();
