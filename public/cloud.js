// Sieve — hosted (cloud) mode backend, used when the app is deployed on Vercel.
// It implements the same /api/* calls as server.py, but keeps every extractor,
// run and setting in this browser (localStorage) and reaches TinyFish only through
// the stateless /api/tf function with the visitor's own key.
"use strict";
(function () {
  const LS = "sieve.cloud.v1";
  const PROXY_COUNTRIES = ["US", "GB", "CA", "DE", "FR", "JP", "AU"];
  const FIELD_TYPES = ["text", "number", "integer", "boolean", "url", "date", "list"];
  const DEFAULTS = {
    user: "Pradumn", workspace: "TechnoJam", accent: "#C8F169", stealth: true, use_proxy: false, proxy_country: "US",
    respect_robots: true, auto_retry_blocked: true, default_format: "json", webhook_url: "", webhook_on_run: false, tinyfish_key: "",
  };
  const LOCAL_ONLY = "available when you run Sieve on your own computer (python3 server.py)";

  function load() { try { return JSON.parse(localStorage.getItem(LS)) || null; } catch { return null; } }
  const db = Object.assign({ extractors: [], runs: {}, counter: 2840, deliveries: 0 }, load() || {});
  db.settings = Object.assign({}, DEFAULTS, db.settings || {});
  function save() {
    for (let i = 0; i < 6; i++) {
      try { localStorage.setItem(LS, JSON.stringify(db)); return; }
      catch { // storage full: drop the oldest finished runs' rows, then whole runs
        const old = Object.values(db.runs).filter((r) => !active(r.status)).sort((a, b) => a.created_at.localeCompare(b.created_at));
        if (!old.length) return;
        old.slice(0, Math.max(1, Math.ceil(old.length / 4))).forEach((r) => { if (r.rows?.length) { r.rows = []; r.raw = null; } else delete db.runs[r.id]; });
      }
    }
  }

  const nowIso = () => new Date().toISOString();
  const newId = (p) => p + "_" + Math.random().toString(16).slice(2, 12);
  const active = (s) => s === "queued" || s === "running" || s === "retrying";
  const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return u; } };
  const slugKey = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "field";
  const key = () => (db.settings.tinyfish_key || "").trim();
  const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

  function deriveName(url, prompt) {
    try {
      const u = new URL(url);
      for (const k of ["q", "query", "search", "keyword", "k"]) {
        const v = u.searchParams.get(k);
        if (v) return v.trim().replace(/^./, (c) => c.toUpperCase()).slice(0, 48) + " · " + hostOf(url);
      }
      const segs = u.pathname.split("/").filter((s) => s && !/^(p|dp|item|itm)\w*$/i.test(s));
      if (segs.length) {
        const seg = decodeURIComponent(segs[segs.length - 1]).replace(/[-_]+/g, " ").trim();
        if (seg.length > 2 && seg.length < 48 && !/\d{5,}/.test(seg)) return seg.replace(/^./, (c) => c.toUpperCase()) + " · " + hostOf(url);
      }
    } catch {}
    const words = (prompt || "").match(/[A-Za-z0-9']+/g) || [];
    return (words.slice(0, 4).join(" ").replace(/^./, (c) => c.toUpperCase()) || "Extraction") + " · " + hostOf(url);
  }

  async function proxy(action, body = {}) {
    const res = await fetch("/api/tf", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key() ? { "X-TinyFish-Key": key() } : {}) },
      body: JSON.stringify({ action, ...body }),
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw err((data && data.error) || `Sieve's server answered ${res.status}`, (data && data.status) || res.status);
    return data;
  }

  function publicSettings() {
    const s = Object.assign({}, db.settings);
    delete s.tinyfish_key;
    return Object.assign(s, { has_key: !!key(), key_source: key() ? "browser" : null, key_hint: key() ? "…" + key().slice(-4) : "", proxy_countries: PROXY_COUNTRIES });
  }

  function summary(r) {
    const keys = ["id", "num", "extractor_id", "name", "host", "url", "mode", "status", "trigger", "created_at", "started_at", "finished_at",
      "row_count", "steps_count", "max_pages", "pages_visited", "retried", "cost", "format"];
    const s = {};
    keys.forEach((k) => (s[k] = r[k] ?? null));
    s.error_title = r.error?.title || null;
    s.deliveries = (r.deliveries || []).length;
    return s;
  }

  function upsertExtractor(data) {
    let ex = data.id ? db.extractors.find((e) => e.id === data.id) : null;
    if (!ex && !data.id) ex = db.extractors.find((e) => e.url === data.url && e.prompt === data.prompt);
    if (!ex) { ex = { id: newId("ex"), created_at: nowIso(), fields: [] }; db.extractors.unshift(ex); }
    ["name", "url", "prompt", "mode", "max_pages", "max_rows", "fields", "options", "format"].forEach((k) => { if (data[k] != null) ex[k] = data[k]; });
    ex.fields = (ex.fields || []).filter((f) => f.key).map((f) => ({ key: slugKey(f.key), desc: String(f.desc || "").slice(0, 200), type: FIELD_TYPES.includes(f.type) ? f.type : "text" }));
    ex.mode = ex.mode || "page"; ex.max_pages = ex.max_pages || 3; ex.format = ex.format || db.settings.default_format; ex.options = ex.options || {};
    if (!ex.name) ex.name = deriveName(ex.url || "", ex.prompt || "");
    ex.updated_at = nowIso();
    save();
    return ex;
  }

  const log = (run, text, kind = "sys") => run.sys.push({ t: nowIso(), text: String(text).slice(0, 400), kind });
  function syncSteps(run) { run.steps = run.sys.concat(run.tfSteps || []).sort((a, b) => (a.t || "").localeCompare(b.t || "")); }
  function fail(run, title, message, code) {
    run.status = "failed"; run.error = { title, message, code }; run.finished_at = nowIso();
    log(run, message, "error"); syncSteps(run); save();
  }
  const AGENT_ERRORS = {
    blocked: ["The site blocked the agent", "A CAPTCHA or access-denied page stopped the run. Try again with Stealth browser and a proxy turned on."],
    no_results: ["Nothing matched", "The page had nothing that matches your instructions. Check the URL or describe the data differently."],
    unparseable: ["Couldn't read the agent's answer", "The agent replied, but not in the expected JSON. Running it again usually fixes this."],
    empty: ["No rows came back", "The agent finished without returning any rows. Try rephrasing what to extract."],
  };

  function startRun(ex, trigger, overrides) {
    const s = db.settings;
    const options = Object.assign({ stealth: s.stealth, use_proxy: s.use_proxy, proxy_country: s.proxy_country, respect_robots: s.respect_robots, auto_retry_blocked: s.auto_retry_blocked },
      ex.options || {}, (overrides && overrides.options) || {});
    db.counter += 1;
    const run = {
      id: newId("run"), num: db.counter, extractor_id: ex.id, name: ex.name, url: ex.url, host: hostOf(ex.url), prompt: ex.prompt || "",
      mode: trigger === "test" ? "page" : ex.mode || "page", max_pages: ex.max_pages || 3, max_rows: trigger === "test" ? 5 : ex.max_rows || 100,
      fields: ex.fields || [], options, format: ex.format || "json", status: "queued", trigger, created_at: nowIso(), started_at: null, finished_at: null,
      tf_run_id: null, streaming_url: null, sys: [], tfSteps: [], steps: [], steps_count: 0, rows: [], row_count: 0, pagination: null, pages_visited: null,
      error: null, agent_error: null, retried: false, attempts: [], cost: null, deliveries: [],
    };
    db.runs[run.id] = run;
    log(run, `Run #${run.num} queued for ${run.host}`);
    syncSteps(run); save();
    launch(run, options.use_proxy ? options.proxy_country : null, options.stealth !== false);
    return run;
  }

  async function launch(run, proxyCountry, stealth) {
    run.status = run.retried ? "retrying" : "running";
    run.started_at = run.started_at || nowIso();
    run.attempts.push({ at: nowIso(), proxy: proxyCountry, stealth });
    save();
    try {
      const goalRun = { url: run.url, prompt: run.prompt, mode: run.mode, max_pages: run.max_pages, max_rows: run.max_rows, fields: run.fields, trigger: run.trigger,
        options: Object.assign({}, run.options, { stealth, respect_robots: run.retried ? false : run.options.respect_robots }) };
      const res = await proxy("start", { run: goalRun, proxy: proxyCountry });
      if (res.robots_blocked) {
        return fail(run, "Blocked by robots.txt", `${run.host}'s robots.txt disallows this URL (rule: Disallow: ${res.rule}). Turn off “Respect robots.txt” only if you have permission to scrape it.`, "robots");
      }
      if (run.options.respect_robots && !run.retried) log(run, "robots.txt allows this URL");
      run.tf_run_id = res.tf_run_id; run._polled = 0;
      log(run, "Cloud browser launched");
      syncSteps(run); save();
    } catch (e) {
      const titles = { 401: "TinyFish rejected the API key", 402: "TinyFish balance too low", 429: "Too many runs at once" };
      fail(run, titles[e.status] || "TinyFish refused the run", e.message, e.status ? `http_${e.status}` : "network");
    }
  }

  let wallet = null, walletAt = 0;
  async function getWallet(force) {
    if (!key()) return { available: false, reason: "no_key" };
    if (!force && wallet && Date.now() - walletAt < 60000) return wallet;
    try { wallet = await proxy("wallet"); } catch (e) { wallet = { available: false, reason: "error", message: e.message }; }
    walletAt = Date.now();
    return wallet;
  }

  const polling = new Set();
  async function pollRun(run) {
    if (!active(run.status) || !run.tf_run_id || polling.has(run.id) || Date.now() - (run._polled || 0) < 2500) return;
    polling.add(run.id);
    run._polled = Date.now();
    try {
      const r = await proxy("get", { tf_run_id: run.tf_run_id, run: { fields: run.fields, url: run.url } });
      if (!active(run.status)) return; // stopped meanwhile
      run.streaming_url = r.streaming_url || run.streaming_url;
      const prior = run.retried ? (run._firstSteps || []) : [];
      run.tfSteps = prior.concat((r.steps || []).map((s) => ({ t: s.t || nowIso(), text: s.text, kind: "step" })));
      run.steps_count = run.tfSteps.length;
      if (r.status === "COMPLETED") {
        if (r.num_of_steps != null && wallet && wallet.step_rate) run.cost = Math.round(r.num_of_steps * wallet.step_rate * 10000) / 10000;
        walletAt = 0;
        if (r.rows && r.rows.length) {
          Object.assign(run, { status: "completed", rows: r.rows, row_count: r.rows.length, pagination: r.pagination, pages_visited: r.pages_visited, finished_at: nowIso() });
          log(run, `Extracted ${r.rows.length} rows`, "ok");
        } else if (r.agent_error === "blocked" && run.options.auto_retry_blocked && !run.retried) {
          run.retried = true; run._firstSteps = run.tfSteps; run.tf_run_id = null;
          const country = run.options.proxy_country || "US";
          log(run, `Blocked by the site — retrying with stealth browser and a ${country} proxy`, "warn");
          syncSteps(run); save();
          launch(run, country, true);
          return;
        } else {
          const [title, msg] = AGENT_ERRORS[r.agent_error] || AGENT_ERRORS.empty;
          run.agent_error = r.agent_error;
          return fail(run, title, msg, r.agent_error || "empty");
        }
      } else if (r.status === "FAILED") {
        return fail(run, "The agent couldn't finish", r.error?.message || "TinyFish reported the run as failed.", r.error?.code || "agent_failure");
      } else if (r.status === "CANCELLED") {
        run.status = "cancelled"; run.finished_at = nowIso(); log(run, "Stopped", "error");
      }
      syncSteps(run); save();
    } catch (e) {
      if (e.status === 401 || e.status === 404) fail(run, e.status === 401 ? "TinyFish rejected the API key" : "Run not found on TinyFish", e.message, `http_${e.status}`);
    } finally { polling.delete(run.id); }
  }
  const pollActive = () => Promise.all(Object.values(db.runs).filter((r) => active(r.status)).map(pollRun));

  function strip(run) { const { sys, tfSteps, _firstSteps, _polled, ...rest } = run; return rest; }

  async function api(method, path, body = {}) {
    const [p, q] = path.split("?");
    let m;
    if (method === "GET" && p === "/api/state") {
      await pollActive();
      return {
        extractors: db.extractors, schedules: [], settings: publicSettings(), cloud: true,
        runs: Object.values(db.runs).map(summary).sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")),
        deliveries: db.deliveries, db_path: null, server_time: nowIso(),
      };
    }
    if (method === "GET" && p === "/api/wallet") return getWallet(/force/.test(q || ""));
    if ((m = p.match(/^\/api\/runs\/(run_\w+)$/))) {
      const run = db.runs[m[1]];
      if (!run) throw err("Run not found", 404);
      if (method === "DELETE") {
        if (active(run.status)) throw err("Stop the run before deleting it", 409);
        delete db.runs[run.id]; save(); return { ok: true };
      }
      await pollRun(run);
      return strip(run);
    }
    if (method === "POST" && p === "/api/runs") {
      let ex;
      if (body.extractor_id) {
        ex = db.extractors.find((e) => e.id === body.extractor_id);
        if (!ex) throw err("Extractor not found", 404);
        if (["url", "prompt", "fields", "mode", "options"].some((k) => k in body)) ex = upsertExtractor(Object.assign({}, body, { id: ex.id }));
      } else {
        const url = String(body.url || "").trim();
        if (!/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(url)) throw err("Enter a full URL that starts with http:// or https://");
        if (!String(body.prompt || "").trim() && !(body.fields || []).length) throw err("Describe what to extract");
        ex = upsertExtractor(body);
      }
      if (!key()) throw err("Add your TinyFish API key first (API & webhooks → TinyFish key).");
      const run = startRun(ex, body.test ? "test" : body.trigger || "manual", body);
      return { run: summary(run), extractor: ex };
    }
    if ((m = p.match(/^\/api\/runs\/(run_\w+)\/cancel$/))) {
      const run = db.runs[m[1]];
      if (!run) throw err("Run not found", 404);
      if (active(run.status)) {
        run.status = "cancelled"; run.finished_at = nowIso(); log(run, "Stopped by you", "error"); syncSteps(run); save();
        if (run.tf_run_id) proxy("cancel", { tf_run_id: run.tf_run_id }).catch(() => {});
      }
      return { ok: true };
    }
    if (/^\/api\/runs\/run_\w+\/(sync-db|webhook)$/.test(p)) throw err(`This is ${LOCAL_ONLY}.`);
    if (method === "POST" && p === "/api/extractors") {
      if (body.url && !/^https?:\/\//i.test(body.url)) throw err("URL must start with http:// or https://");
      if (!body.id && !body.url) throw err("An extractor needs a URL");
      return { extractor: upsertExtractor(body) };
    }
    if ((m = p.match(/^\/api\/extractors\/(ex_\w+)$/)) && method === "DELETE") {
      db.extractors = db.extractors.filter((e) => e.id !== m[1]); save(); return { ok: true };
    }
    if (p.startsWith("/api/schedules") || p === "/api/settings/test-webhook") throw err(`Schedules and webhooks are ${LOCAL_ONLY}.`);
    if (method === "POST" && p === "/api/settings") {
      for (const [k, v] of Object.entries(body)) {
        if (!(k in DEFAULTS)) continue;
        if (k === "proxy_country" && !PROXY_COUNTRIES.includes(v)) continue;
        db.settings[k] = k === "tinyfish_key" ? String(v || "").trim() : v;
        if (k === "tinyfish_key") { wallet = null; walletAt = 0; }
      }
      save();
      return { settings: publicSettings() };
    }
    if (method === "POST" && p === "/api/robots") return proxy("robots", { url: body.url });
    throw err("Unknown endpoint", 404);
  }

  function recordExport(runId, fmt, bytes) {
    const run = db.runs[runId]; if (!run) return;
    run.deliveries = run.deliveries || [];
    run.deliveries.push({ at: nowIso(), kind: "export_" + fmt, ok: true, detail: bytes + " bytes" });
    db.deliveries += 1; save();
  }

  window.SieveCloud = { api, recordExport, LOCAL_ONLY };
})();
