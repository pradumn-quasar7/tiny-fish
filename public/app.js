
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const state = {
  products: [],
  view: store.get("fs.view", "grid"),
  query: "",
  runId: null,
  controller: null,
  running: false,
  tableSort: null,
  serverHasKey: false,
};

const inr = (n) => (n == null ? "—" : "₹" + Math.round(n).toLocaleString("en-IN"));
const compact = (n) => (n == null ? "" : n >= 1e5 ? (n / 1e5).toFixed(1) + "L" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (u && /^https?:\/\//i.test(u) ? u : null);

function toast(msg, type = "") {
  const t = document.createElement("div");
  t.className = "toast " + type;
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = ".3s"; }, 2800);
  setTimeout(() => t.remove(), 3200);
}

/* ---------------- theme ---------------- */
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}
applyTheme(store.get("fs.theme", null));
$("#themeBtn").onclick = () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark";
  applyTheme(next);
  store.set("fs.theme", next);
};

/* ---------------- key status ---------------- */
function userKey() { return store.get("fs.key", ""); }
function renderKeyPill() {
  const pill = $("#keyPill"), txt = $("#keyPillText");
  const ok = state.serverHasKey || !!userKey();
  pill.className = "pill " + (ok ? "pill-ok" : "pill-bad");
  txt.textContent = ok ? (userKey() ? "API key (browser)" : "API key ready") : "Add API key";
}
fetch("/api/health").then((r) => r.json()).then((j) => { state.serverHasKey = !!j.hasKey; renderKeyPill(); })
  .catch(() => { $("#keyPillText").textContent = "Server offline"; $("#keyPill").className = "pill pill-bad"; });
$("#keyPill").onclick = () => openOverlay("settings");


function openOverlay(id) {
  $("#" + id).classList.add("show");
  $("#" + id).setAttribute("aria-hidden", "false");
  $("#scrim").classList.add("show");
  if (id === "settings") { $("#apiKey").value = userKey(); setTimeout(() => $("#apiKey").focus(), 50); }
  if (id === "drawer") renderHistory();
}
function closeOverlays() {
  $$(".drawer.show, .modal.show").forEach((el) => { el.classList.remove("show"); el.setAttribute("aria-hidden", "true"); });
  $("#scrim").classList.remove("show");
}
$("#scrim").onclick = closeOverlays;
$$("[data-close]").forEach((b) => (b.onclick = closeOverlays));
$("#settings").onclick = (e) => { if (e.target.id === "settings") closeOverlays(); };
$("#settingsBtn").onclick = () => openOverlay("settings");
$("#historyBtn").onclick = () => openOverlay("drawer");
$("#toggleKey").onclick = () => {
  const i = $("#apiKey");
  i.type = i.type === "password" ? "text" : "password";
  $("#toggleKey").textContent = i.type === "password" ? "Show" : "Hide";
};
$("#saveKey").onclick = () => {
  const v = $("#apiKey").value.trim();
  if (v) store.set("fs.key", v); else store.del("fs.key");
  renderKeyPill(); closeOverlays(); toast(v ? "API key saved in this browser" : "API key removed");
};
$("#clearKey").onclick = () => { store.del("fs.key"); $("#apiKey").value = ""; renderKeyPill(); toast("API key removed"); };


$("#limit").oninput = (e) => ($("#limitVal").textContent = e.target.value);
$$("#chips .chip").forEach((c) => (c.onclick = () => { $("#query").value = c.textContent; $("#searchForm").requestSubmit(); }));


const prefIds = ["sort", "minPrice", "maxPrice", "minRating", "limit", "notes", "stealth", "proxy"];
const prefs = store.get("fs.prefs", {});
prefIds.forEach((id) => {
  const el = $("#" + id);
  if (id === "proxy" && typeof prefs[id] !== "string") return;
  if (prefs[id] !== undefined) el.type === "checkbox" ? (el.checked = prefs[id]) : (el.value = prefs[id]);
  el.addEventListener("change", () => {
    const p = store.get("fs.prefs", {});
    p[id] = el.type === "checkbox" ? el.checked : el.value;
    store.set("fs.prefs", p);
  });
});
$("#limitVal").textContent = $("#limit").value;

document.addEventListener("keydown", (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (e.key === "Escape") closeOverlays();
  if (typing) return;
  if (e.key === "/") { e.preventDefault(); $("#query").focus(); }
  if (e.key.toLowerCase() === "h") openOverlay("drawer");
});

$("#searchForm").onsubmit = (e) => {
  e.preventDefault();
  if (state.running) return;
  const query = $("#query").value.trim();
  if (!query) { $("#query").focus(); toast("Type a product or paste a Flipkart URL"); return; }
  if (!state.serverHasKey && !userKey()) { openOverlay("settings"); toast("Add your TinyFish API key first", "err"); return; }
  startRun({
    query,
    sort: $("#sort").value,
    minPrice: $("#minPrice").value,
    maxPrice: $("#maxPrice").value,
    minRating: $("#minRating").value,
    limit: $("#limit").value,
    notes: $("#notes").value,
    stealth: $("#stealth").checked,
    proxy: $("#proxy").value,
    apiKey: userKey() || undefined,
  });
};


let timerInt = null, t0 = 0, steps = 0;

function addStep(text, cls = "") {
  const li = document.createElement("li");
  li.className = cls;
  li.innerHTML = `${esc(text)}<span class="t">${((performance.now() - t0) / 1000).toFixed(1)}s</span>`;
  $("#timeline").appendChild(li);
  $("#timeline").scrollTop = $("#timeline").scrollHeight;
}

function setRunState(kind, label) {
  $("#runStatus").textContent = label;
  $("#runSpinner").className = "spinner " + (kind === "ok" ? "done" : kind === "fail" ? "fail" : "");
  $("#progressBar").className = "progress-bar " + (kind === "ok" ? "done" : kind === "fail" ? "fail" : "");
  $("#cancelBtn").classList.toggle("hidden", kind !== "run");
}

function showSkeletons(n) {
  $("#results").classList.remove("hidden");
  $("#stats").innerHTML = "";
  $("#notice").classList.add("hidden");
  $("#rawBox").classList.add("hidden");
  $("#tableWrap").classList.add("hidden");
  $("#grid").classList.remove("hidden");
  $("#resultsTitle").textContent = "Fetching products…";
  $("#grid").innerHTML = Array.from({ length: Math.min(n, 8) }, () => `
    <div class="card skeleton"><div class="card-img"><div class="sk" style="width:70%;height:70%"></div></div>
    <div class="card-body"><div class="sk" style="height:14px"></div><div class="sk" style="height:14px;width:70%"></div>
    <div class="sk" style="height:12px;width:40%"></div><div class="sk" style="height:22px;width:55%;margin-top:auto"></div></div></div>`).join("");
}

async function startRun(opts) {
  state.running = true;
  state.query = opts.query;
  state.runId = null;
  steps = 0;
  t0 = performance.now();

  $("#how").classList.add("hidden");
  $("#hero").classList.add("compact");
  $("#runPanel").classList.remove("hidden");
  $("#timeline").innerHTML = "";
  $("#runSteps").textContent = "0 steps";
  $("#runLink").classList.add("hidden");
  $("#liveOpen").classList.add("hidden");
  $("#liveFrame").innerHTML = `<div class="live-placeholder"><div class="browser-dots"><i></i><i></i><i></i></div>Waiting for browser stream…</div>`;
  $("#goBtn").disabled = true;
  $("#goBtn .btn-label").textContent = "Scraping…";
  setRunState("run", "Starting agent…");
  showSkeletons(Number(opts.limit));
  $("#runPanel").scrollIntoView({ behavior: "smooth", block: "start" });

  clearInterval(timerInt);
  timerInt = setInterval(() => ($("#runTimer").textContent = ((performance.now() - t0) / 1000).toFixed(1) + "s"), 100);

  state.controller = new AbortController();
  let gotComplete = false;
  try {
    const res = await fetch("/api/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
      signal: state.controller.signal,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || "Server error " + res.status);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (handleEvent(ev, opts)) gotComplete = true;
      }
    }
    if (!gotComplete && state.running) throw new Error("The stream ended before the agent finished.");
  } catch (err) {
    if (err.name === "AbortError") {
      addStep("Stopped by you", "err");
      setRunState("fail", "Run stopped");
      renderResults([], { stopped: true });
    } else {
      addStep(err.message, "err");
      setRunState("fail", "Something went wrong");
      renderResults([], { error: err.message });
      toast(err.message, "err");
    }
  } finally {
    finishRun();
  }
}

function handleEvent(ev, opts) {
  switch (ev.type) {
    case "TARGET":
      $("#runTarget").textContent = ev.url.replace(/^https?:\/\/(www\.)?/, "");
      $("#runTarget").href = ev.url;
      addStep("Target: " + decodeURIComponent(ev.url.replace(/^https?:\/\/(www\.)?/, "")), "sys");
      break;
    case "STARTED":
      state.runId = ev.run_id;
      setRunState("run", "Agent is browsing Flipkart…");
      addStep("Cloud browser launched", "sys");
      if (ev.run_id) {
        $("#runLink").href = `https://agent.tinyfish.ai/runs/${ev.run_id}`;
        $("#runLink").classList.remove("hidden");
      }
      break;
    case "STREAMING_URL": {
      const u = safeUrl(ev.streaming_url);
      if (u) {
        $("#liveFrame").innerHTML = `<iframe src="${esc(u)}" title="Live browser view" allow="autoplay"></iframe>`;
        $("#liveOpen").href = u;
        $("#liveOpen").classList.remove("hidden");
      }
      break;
    }
    case "PROGRESS":
      steps++;
      $("#runSteps").textContent = `${steps} step${steps === 1 ? "" : "s"}`;
      if (ev.purpose) { addStep(ev.purpose); $("#runStatus").textContent = ev.purpose; }
      break;
    case "HEARTBEAT":
      break;
    case "ERROR":
      throw new Error(ev.message || "Unknown error");
    case "COMPLETE": {
      if (ev.run_url) { $("#runLink").href = ev.run_url; $("#runLink").classList.remove("hidden"); }
      const failed = ev.status !== "COMPLETED";
      const products = ev.products || [];
      if (failed) {
        const msg = (ev.error && (ev.error.message || ev.error.help_message)) || "Run " + String(ev.status || "failed").toLowerCase();
        addStep(msg, "err");
        setRunState("fail", "Run failed");
        renderResults([], { error: msg, raw: ev.raw });
      } else {
        addStep(`Extracted ${products.length} product${products.length === 1 ? "" : "s"}`, products.length ? "ok" : "err");
        setRunState(products.length ? "ok" : "fail", products.length ? `Done — ${products.length} products in ${((performance.now() - t0) / 1000).toFixed(0)}s` : "No products extracted");
        renderResults(products, { agentError: ev.agent_error, raw: ev.raw });
        if (products.length) {
          saveHistory({ query: opts.query, at: Date.now(), products, runUrl: ev.run_url });
          toast(`✓ ${products.length} products scraped`);
        }
      }
      return true;
    }
  }
  return false;
}

function finishRun() {
  const ph = $("#liveFrame .live-placeholder");
  if (ph) ph.innerHTML = "Live view has ended. Use “Open run ↗” to replay it on TinyFish.";
  state.running = false;
  state.controller = null;
  clearInterval(timerInt);
  $("#goBtn").disabled = false;
  $("#goBtn .btn-label").textContent = "Scrape";
  $("#cancelBtn").classList.add("hidden");
}

$("#cancelBtn").onclick = async () => {
  if (!state.running) return;
  const id = state.runId;
  state.controller?.abort();
  if (id) fetch(`/api/runs/${encodeURIComponent(id)}/cancel`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: userKey() || undefined }),
  }).catch(() => {});
};

const AGENT_ERRORS = {
  blocked: "Flipkart blocked the agent with a CAPTCHA or access-denied page. In Advanced options, keep Stealth browser on and try a proxy country, then run again.",
  no_results: "Flipkart returned no results for this search. Try broader words or loosen the price/rating filters.",
  unparseable: "The agent answered, but not in the expected JSON format. Check the raw output below.",
  empty: "The agent finished without returning any products.",
};

function renderResults(products, meta = {}) {
  state.products = products;
  state.tableSort = null;
  $("#filterText").value = "";
  $("#localSort").value = "";
  $("#results").classList.remove("hidden");

  const n = $("#notice");
  n.classList.add("hidden");
  n.classList.remove("err");
  if (meta.error) { n.textContent = meta.error; n.classList.add("err"); n.classList.remove("hidden"); }
  else if (meta.stopped) { n.textContent = "Run stopped before finishing."; n.classList.remove("hidden"); }
  else if (meta.agentError && !products.length) { n.textContent = AGENT_ERRORS[meta.agentError] || "Agent reported: " + meta.agentError; n.classList.remove("hidden"); }

  if (meta.raw != null) { $("#rawPre").textContent = JSON.stringify(meta.raw, null, 2); $("#rawBox").classList.remove("hidden"); }
  else $("#rawBox").classList.add("hidden");

  $("#resultsTitle").textContent = products.length ? `Results for “${state.query}”` : "No products";
  renderStats(products);
  renderView();
}

function renderStats(ps) {
  if (!ps.length) { $("#stats").innerHTML = ""; return; }
  const priced = ps.filter((p) => p.price != null);
  const rated = ps.filter((p) => p.rating != null);
  const cheapest = priced.reduce((a, b) => (!a || b.price < a.price ? b : a), null);
  const avg = priced.length ? priced.reduce((s, p) => s + p.price, 0) / priced.length : null;
  const avgR = rated.length ? rated.reduce((s, p) => s + p.rating, 0) / rated.length : null;
  const bestDeal = ps.filter((p) => p.discount_percent != null).sort((a, b) => b.discount_percent - a.discount_percent)[0];
  const tile = (k, v, s) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s" title="${esc(s)}">${esc(s)}</div></div>`;
  $("#stats").innerHTML =
    tile("Products", ps.length, `${ps.filter((p) => p.assured).length} Flipkart Assured`) +
    tile("Lowest price", inr(cheapest?.price), cheapest?.name || "") +
    tile("Average price", inr(avg), priced.length ? `range ${inr(Math.min(...priced.map((p) => p.price)))} – ${inr(Math.max(...priced.map((p) => p.price)))}` : "") +
    tile("Avg rating", avgR ? avgR.toFixed(2) + "★" : "—", bestDeal ? `Best deal: ${bestDeal.discount_percent}% off` : `${rated.length} rated`);
}

function visibleProducts() {
  const q = $("#filterText").value.trim().toLowerCase();
  let list = state.products.filter((p) => !q || (p.name + " " + p.highlights.join(" ")).toLowerCase().includes(q));
  const s = $("#localSort").value;
  const by = {
    price_asc: (a, b) => (a.price ?? 1e12) - (b.price ?? 1e12),
    price_desc: (a, b) => (b.price ?? -1) - (a.price ?? -1),
    rating: (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || (b.rating_count ?? 0) - (a.rating_count ?? 0),
    discount: (a, b) => (b.discount_percent ?? -1) - (a.discount_percent ?? -1),
    reviews: (a, b) => (b.rating_count ?? 0) - (a.rating_count ?? 0),
  }[s];
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

function bestValueId(list) {
  const c = list.filter((p) => p.price && p.rating && p.rating >= 4);
  if (c.length < 3) return null;
  const max = Math.max(...c.map((p) => p.price));
  return c.map((p) => ({ id: p.id, s: p.rating * 2 + (1 - p.price / max) * 3 + Math.log10((p.rating_count || 1) + 1) * 0.5 }))
    .sort((a, b) => b.s - a.s)[0].id;
}

function renderView() {
  const list = visibleProducts();
  $$(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === state.view));
  const grid = state.view === "grid";
  $("#grid").classList.toggle("hidden", !grid);
  $("#tableWrap").classList.toggle("hidden", grid || !list.length);
  ["#copyBtn", "#jsonBtn", "#csvBtn"].forEach((s) => ($(s).disabled = !state.products.length));

  if (!list.length) {
    $("#grid").classList.remove("hidden");
    $("#grid").innerHTML = `<div class="empty"><div class="big">${state.products.length ? "🔍" : "🛍️"}</div>
      ${state.products.length ? "Nothing matches that filter." : "No products to show yet."}</div>`;
    return;
  }
  grid ? renderGrid(list) : renderTable(list);
}

function ratingClass(r) { return r >= 4 ? "" : r >= 3 ? "mid" : "low"; }

function renderGrid(list) {
  const best = bestValueId(state.products);
  $("#grid").innerHTML = list.map((p, i) => {
    const url = safeUrl(p.product_url), img = safeUrl(p.image_url);
    return `
    <article class="card ${p.id === best ? "best" : ""}" style="animation-delay:${Math.min(i, 12) * 35}ms">
      <div class="card-img">
        <div class="badges">
          <span class="badge badge-rank">#${p.id}</span>
          <span>${p.sponsored ? '<span class="badge badge-ad">Ad</span> ' : ""}${p.discount_percent ? `<span class="badge badge-off">${p.discount_percent}% off</span>` : ""}</span>
        </div>
        ${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'noimg',textContent:'📦'}))">` : '<div class="noimg">📦</div>'}
        ${p.id === best ? '<span class="best-tag">★ Best value</span>' : ""}
      </div>
      <div class="card-body">
        ${url ? `<a class="card-name" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(p.name)}">${esc(p.name)}</a>` : `<div class="card-name" title="${esc(p.name)}">${esc(p.name)}</div>`}
        <div class="rating-row">
          ${p.rating != null ? `<span class="stars ${ratingClass(p.rating)}">${p.rating} ★</span>` : ""}
          ${p.rating_count ? `<span>${compact(p.rating_count)} ratings</span>` : ""}
          ${p.assured ? '<span class="assured">✓ Assured</span>' : ""}
        </div>
        ${p.highlights.length ? `<ul class="hl">${p.highlights.slice(0, 3).map((h) => `<li title="${esc(h)}">${esc(h)}</li>`).join("")}</ul>` : ""}
        <div class="price-row">
          <span class="price">${inr(p.price)}</span>
          ${p.original_price && p.original_price > (p.price || 0) ? `<span class="mrp">${inr(p.original_price)}</span>` : ""}
          ${p.discount_percent ? `<span class="off">${p.discount_percent}% off</span>` : ""}
        </div>
      </div>
      <div class="card-foot">
        ${url ? `<a class="btn btn-ghost btn-sm" href="${esc(url)}" target="_blank" rel="noopener">View on Flipkart ↗</a>` : ""}
        <button class="btn btn-ghost btn-sm" data-copy="${p.id}" title="Copy as JSON" style="flex:0 0 auto">⧉</button>
      </div>
    </article>`;
  }).join("");
}

const COLS = [
  ["id", "#", "num"], ["image_url", "", ""], ["name", "Product", "name"], ["price", "Price", "num"],
  ["original_price", "MRP", "num"], ["discount_percent", "Off", "num"], ["rating", "Rating", "num"],
  ["rating_count", "Ratings", "num"], ["assured", "Assured", ""],
];
function renderTable(list) {
  const arrow = (k) => (state.tableSort?.key === k ? (state.tableSort.dir > 0 ? " ▲" : " ▼") : "");
  $("#table").innerHTML =
    `<thead><tr>${COLS.map(([k, l]) => `<th data-k="${k}">${l}${arrow(k)}</th>`).join("")}</tr></thead><tbody>` +
    list.map((p) => {
      const url = safeUrl(p.product_url), img = safeUrl(p.image_url);
      return `<tr>
        <td class="num">${p.id}</td>
        <td>${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}</td>
        <td class="name">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name)}</td>
        <td class="num"><b>${inr(p.price)}</b></td>
        <td class="num">${p.original_price ? inr(p.original_price) : "—"}</td>
        <td class="num" style="color:var(--good)">${p.discount_percent ? p.discount_percent + "%" : "—"}</td>
        <td class="num">${p.rating != null ? `<span class="stars ${ratingClass(p.rating)}">${p.rating} ★</span>` : "—"}</td>
        <td class="num">${p.rating_count ? p.rating_count.toLocaleString("en-IN") : "—"}</td>
        <td>${p.assured ? "✓" : ""}</td></tr>`;
    }).join("") + "</tbody>";
}

$("#table").onclick = (e) => {
  const th = e.target.closest("th[data-k]");
  if (!th || th.dataset.k === "image_url") return;
  const k = th.dataset.k;
  state.tableSort = state.tableSort?.key === k ? { key: k, dir: -state.tableSort.dir } : { key: k, dir: k === "name" ? 1 : -1 };
  renderView();
};
$("#grid").onclick = (e) => {
  const b = e.target.closest("[data-copy]");
  if (!b) return;
  const p = state.products.find((x) => x.id === Number(b.dataset.copy));
  navigator.clipboard?.writeText(JSON.stringify(p, null, 2)).then(() => toast("Product copied"), () => toast("Copy failed", "err"));
};
$$(".seg-btn").forEach((b) => (b.onclick = () => { state.view = b.dataset.view; store.set("fs.view", state.view); renderView(); }));
$("#filterText").oninput = renderView;
$("#localSort").onchange = () => { state.tableSort = null; renderView(); };


const slug = () => "flipkart-" + (state.query.replace(/^https?:\/\/\S+/, "url").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "results") + "-" + new Date().toISOString().slice(0, 10);
function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$("#jsonBtn").onclick = () => { download(slug() + ".json", JSON.stringify(visibleProducts(), null, 2), "application/json"); toast("JSON downloaded"); };
$("#csvBtn").onclick = () => {
  const keys = ["id", "name", "price", "original_price", "discount_percent", "rating", "rating_count", "review_count", "assured", "sponsored", "highlights", "product_url", "image_url"];
  const cell = (v) => { const s = Array.isArray(v) ? v.join(" | ") : v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = "﻿" + [keys.join(","), ...visibleProducts().map((p) => keys.map((k) => cell(p[k])).join(","))].join("\n");
  download(slug() + ".csv", csv, "text/csv");
  toast("CSV downloaded");
};
$("#copyBtn").onclick = () => navigator.clipboard?.writeText(JSON.stringify(visibleProducts(), null, 2)).then(() => toast("JSON copied to clipboard"), () => toast("Copy failed", "err"));


function saveHistory(entry) {
  const h = store.get("fs.history", []).filter((x) => x.query !== entry.query);
  h.unshift(entry);
  store.set("fs.history", h.slice(0, 12));
}
function renderHistory() {
  const h = store.get("fs.history", []);
  $("#historyList").innerHTML = h.length
    ? h.map((x, i) => `<button class="h-item" data-i="${i}"><b>${esc(x.query)}</b><span>${x.products.length} products · ${new Date(x.at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span></button>`).join("")
    : `<div class="empty"><div class="big">🕘</div>Your past scrapes show up here.</div>`;
}
$("#historyList").onclick = (e) => {
  const b = e.target.closest(".h-item");
  if (!b || state.running) return;
  const x = store.get("fs.history", [])[Number(b.dataset.i)];
  if (!x) return;
  closeOverlays();
  state.query = x.query;
  $("#query").value = x.query;
  $("#how").classList.add("hidden");
  $("#hero").classList.add("compact");
  $("#runPanel").classList.add("hidden");
  renderResults(x.products, {});
  $("#results").scrollIntoView({ behavior: "smooth" });
};
$("#clearHistory").onclick = () => { store.del("fs.history"); renderHistory(); toast("History cleared"); };

renderKeyPill();
