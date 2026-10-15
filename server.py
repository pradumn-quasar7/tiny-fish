#!/usr/bin/env python3
"""Sieve — turn any website into clean data, powered by the TinyFish Web Agent API.

Pure standard library (Python 3.8+), nothing to pip install.
Run:  python3 server.py        then open the address it prints.

Data lives in ./data (runs, extractors, schedules, settings, sieve.db).
"""
import csv
import io
import json
import mimetypes
import os
import re
import socket
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(ROOT, "public")
DATA_DIR = os.path.join(ROOT, "data")
RUNS_DIR = os.path.join(DATA_DIR, "runs")
STORE_PATH = os.path.join(DATA_DIR, "store.json")
DB_PATH = os.path.join(DATA_DIR, "sieve.db")
TF_BASE = "https://agent.tinyfish.ai/v1"  # overridable via TINYFISH_BASE_URL (set after .env loads)
UA ="Mozilla/5.0 (compatible; Sieve/1.0; +https://tinyfish.ai)"
PROXY_COUNTRIES = ["US", "GB", "CA", "DE", "FR", "JP", "AU"]  # TinyFish-supported proxy locations
FIELD_TYPES = ["text", "number", "integer", "boolean", "url", "date", "list"]


# ---------------------------------------------------------------- .env loader
def load_env(path):
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            m = re.match(r"^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$", line)
            if m and m.group(1) not in os.environ:
                os.environ[m.group(1)] = m.group(2).strip("\"'")


load_env(os.path.join(ROOT, ".env"))
PORT = int(os.environ.get("PORT", "8000"))
TF_BASE = os.environ.get("TINYFISH_BASE_URL", TF_BASE).rstrip("/")
if os.environ.get("SIEVE_DATA_DIR"):  # keep test data out of ./data
    DATA_DIR = os.path.abspath(os.environ["SIEVE_DATA_DIR"])
    RUNS_DIR = os.path.join(DATA_DIR, "runs")
    STORE_PATH = os.path.join(DATA_DIR, "store.json")
    DB_PATH = os.path.join(DATA_DIR, "sieve.db")
PLACEHOLDER_KEYS = ("", "paste_your_key_here", "your_key_here")


def now_iso():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def new_id(prefix):
    return prefix + "_" + uuid.uuid4().hex[:10]


# ---------------------------------------------------------------- persistence
LOCK = threading.RLock()
DEFAULT_SETTINGS = {
    "user": "Pradumn",
    "workspace": "TechnoJam",
    "accent": "#C8F169",
    "stealth": True,
    "use_proxy": False,
    "proxy_country": "US",
    "respect_robots": True,
    "auto_retry_blocked": True,
    "default_format": "json",
    "webhook_url": "",
    "webhook_on_run": False,
    "tinyfish_key": "",
}
STORE = {"extractors": [], "schedules": [], "settings": dict(DEFAULT_SETTINGS), "counter": 2840, "deliveries": []}
RUNS = {}          # run_id -> full run dict
RUN_CTX = {}       # run_id -> {"resp": http response, "cancel": bool}


def atomic_write(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def load_data():
    os.makedirs(RUNS_DIR, exist_ok=True)
    if os.path.exists(STORE_PATH):
        try:
            with open(STORE_PATH, encoding="utf-8") as f:
                data = json.load(f)
            STORE.update({k: v for k, v in data.items() if k in STORE})
            STORE["settings"] = {**DEFAULT_SETTINGS, **data.get("settings", {})}
        except (ValueError, OSError) as e:
            print("  ⚠️  could not read store.json:", e)
    for name in os.listdir(RUNS_DIR):
        if name.endswith(".json"):
            try:
                with open(os.path.join(RUNS_DIR, name), encoding="utf-8") as f:
                    run = json.load(f)
                if run.get("status") in ("queued", "running", "retrying"):  # server stopped mid-run
                    run["status"] = "failed"
                    run["error"] = {"title": "Interrupted", "message": "The server stopped while this run was in progress."}
                    run["finished_at"] = run.get("finished_at") or now_iso()
                RUNS[run["id"]] = run
            except (ValueError, OSError, KeyError):
                pass


def save_store():
    with LOCK:
        atomic_write(STORE_PATH, STORE)


def save_run(run):
    with LOCK:
        atomic_write(os.path.join(RUNS_DIR, run["id"] + ".json"), run)


def settings():
    return STORE["settings"]


def api_key():
    k = os.environ.get("TINYFISH_API_KEY", "").strip()
    if k not in PLACEHOLDER_KEYS:
        return k
    k = (settings().get("tinyfish_key") or "").strip()
    return "" if k in PLACEHOLDER_KEYS else k


def key_source():
    if os.environ.get("TINYFISH_API_KEY", "").strip() not in PLACEHOLDER_KEYS:
        return "env"
    return "settings" if api_key() else None


def public_settings():
    s = dict(settings())
    k = s.pop("tinyfish_key", "")
    s["key_source"] = key_source()
    s["key_hint"] = ("…" + api_key()[-4:]) if api_key() else ""
    s["has_key"] = bool(api_key())
    s["proxy_countries"] = PROXY_COUNTRIES
    return s


# ---------------------------------------------------------------- helpers
def to_num(v):
    if v is None or v == "" or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return v
    s = str(v).replace(",", "")
    m = re.search(r"-?\d+(\.\d+)?", s)
    if not m:
        return None
    return float(m.group()) if m.group(1) else int(m.group())


TRUE_WORDS = {"true", "yes", "y", "1", "in stock", "available", "instock", "assured"}
FALSE_WORDS = {"false", "no", "n", "0", "out of stock", "sold out", "unavailable", "outofstock"}


def to_bool(v):
    if isinstance(v, bool) or v is None:
        return v
    s = str(v).strip().lower()
    if s in TRUE_WORDS:
        return True
    if s in FALSE_WORDS:
        return False
    return bool(s)


def coerce(value, ftype, base_url):
    if value is None or value == "":
        return None
    try:
        if ftype == "number":
            return to_num(value)
        if ftype == "integer":
            n = to_num(value)
            return int(n) if n is not None else None
        if ftype == "boolean":
            return to_bool(value)
        if ftype == "url":
            return urllib.parse.urljoin(base_url, str(value).strip())
        if ftype == "list":
            if isinstance(value, list):
                return [str(x) for x in value]
            return [x.strip() for x in re.split(r"[|;,\n]", str(value)) if x.strip()]
        if ftype in ("text", "date"):
            return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value)
    except (ValueError, TypeError):
        return value
    return value


def slug_key(text):
    s = re.sub(r"[^a-z0-9]+", "_", str(text).lower()).strip("_")
    return s[:40] or "field"


def host_of(url):
    try:
        return urllib.parse.urlparse(url).netloc.replace("www.", "") or url
    except ValueError:
        return url


def derive_name(url, prompt):
    try:
        p = urllib.parse.urlparse(url)
        q = urllib.parse.parse_qs(p.query)
        for k in ("q", "query", "search", "keyword", "k"):
            if q.get(k):
                return q[k][0].strip().capitalize()[:48] + " · " + host_of(url)
        segs = [s for s in p.path.split("/") if s and not re.match(r"^(p|dp|item|itm)\w*$", s, re.I)]
        if segs:
            seg = re.sub(r"[-_]+", " ", urllib.parse.unquote(segs[-1])).strip()
            if 2 < len(seg) < 48 and not re.search(r"\d{5,}", seg):
                return seg.capitalize() + " · " + host_of(url)
    except ValueError:
        pass
    words = re.findall(r"[A-Za-z0-9']+", prompt or "")
    return (" ".join(words[:4]).capitalize() or "Extraction") + " · " + host_of(url)


def parse_jsonish(s):
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", s)
    s = m.group(1) if m else s
    try:
        return json.loads(s)
    except ValueError:
        for open_c, close_c in (("{", "}"), ("[", "]")):
            a, b = s.find(open_c), s.rfind(close_c)
            if a >= 0 and b > a:
                try:
                    return json.loads(s[a:b + 1])
                except ValueError:
                    pass
    return None


def normalize_result(result):
    """TinyFish returns the object directly, or a JSON string under result.result."""
    r = result
    for _ in range(3):
        if isinstance(r, dict) and "rows" not in r and "result" in r and len(r) <= 2:
            r = r["result"]
    if isinstance(r, str):
        parsed = parse_jsonish(r)
        if parsed is None:
            return {"rows": [], "error": "unparseable"}
        r = parsed
    if isinstance(r, list):
        return {"rows": [x for x in r if isinstance(x, dict)]}
    if isinstance(r, dict):
        if isinstance(r.get("rows"), list):
            r["rows"] = [x for x in r["rows"] if isinstance(x, dict)]
            return r
        for v in r.values():
            if isinstance(v, list) and any(isinstance(x, dict) for x in v):
                return {"rows": [x for x in v if isinstance(x, dict)], "error": r.get("error"),
                        "pagination": r.get("pagination"), "pages_visited": r.get("pages_visited")}
        if r.get("error"):
            return {"rows": [], "error": r.get("error")}
        return {"rows": [r]} if r else {"rows": [], "error": "empty"}
    return {"rows": [], "error": "empty"}


def clean_rows(rows, fields, base_url):
    out = []
    if fields:
        for row in rows:
            lower = {str(k).lower(): v for k, v in row.items()}
            out.append({f["key"]: coerce(row.get(f["key"], lower.get(f["key"].lower())), f.get("type", "text"), base_url) for f in fields})
    else:
        for row in rows:
            clean = {}
            for k, v in row.items():
                key = slug_key(k)
                if isinstance(v, str) and re.match(r"^(/|//|https?://)", v.strip()) and ("url" in key or "link" in key or "image" in key or "href" in key):
                    v = urllib.parse.urljoin(base_url, v.strip())
                clean[key] = v
            out.append(clean)
    return out


# ---------------------------------------------------------------- robots.txt (Google-style wildcards)
ROBOTS_CACHE = {}


def robots_check(url):
    """Returns (allowed: bool, detail: str)."""
    p = urllib.parse.urlparse(url)
    if p.scheme not in ("http", "https"):
        return True, "not an http(s) URL"
    origin = "%s://%s" % (p.scheme, p.netloc)
    cached = ROBOTS_CACHE.get(origin)
    if cached and time.time() - cached[0] < 600:
        rules = cached[1]
    else:
        rules = []
        try:
            req = urllib.request.Request(origin + "/robots.txt", headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=8) as r:
                text = r.read(500_000).decode("utf-8", "replace")
        except Exception:  # noqa: BLE001 - unreachable robots.txt means no rules
            text = ""
        agents, in_rules = [], False
        for raw in text.splitlines():
            line = raw.split("#", 1)[0].strip()
            if ":" not in line:
                continue
            field, value = [x.strip() for x in line.split(":", 1)]
            field = field.lower()
            if field == "user-agent":
                if in_rules:
                    agents, in_rules = [], False
                agents.append(value.lower())
            elif field in ("allow", "disallow"):
                in_rules = True
                if any(a == "*" or "sieve" in a for a in agents) and value:
                    rules.append((field, value))
        ROBOTS_CACHE[origin] = (time.time(), rules)
    path = (p.path or "/") + ("?" + p.query if p.query else "")
    best = None
    for kind, pattern in rules:
        rx = "^" + re.escape(pattern).replace(r"\*", ".*")
        if rx.endswith(r"\$"):
            rx = rx[:-2] + "$"
        if re.match(rx, path) or (not pattern.startswith("/") and not pattern.startswith("*") and re.match(rx, path.lstrip("/"))):
            score = (len(pattern), kind == "allow")
            if best is None or score > best[0]:
                best = (score, kind, pattern)
    if best and best[1] == "disallow":
        return False, best[2]
    return True, best[2] if best else "no matching rule"


# ---------------------------------------------------------------- goal builder
MODE_TEXT = {
    "page": "Only extract from this page. Scrolling or clicking 'show more' on the same page is fine, but do not navigate to other pages.",
    "crawl": "Extract from this page, then follow pagination ('Next', page numbers, or 'Load more') and keep extracting, up to {pages} pages in total.",
    "sitemap": "Open this site's sitemap (try /sitemap.xml, or the Sitemap: line in /robots.txt). Pick up to {pages} pages that are relevant to the task, visit each one, and extract from it.",
}


def build_goal(run):
    pages = max(1, min(int(run.get("max_pages") or 1), 25))
    limit = max(1, min(int(run.get("max_rows") or 100), 500))
    fields = run.get("fields") or []
    if fields:
        spec = "\n".join("  \"%s\": %s%s" % (f["key"], f.get("type", "text"), (" — " + f["desc"]) if f.get("desc") else "") for f in fields)
        schema = "Each row must have exactly these keys:\n{\n" + spec + "\n}\nUse null when a value is not shown."
    else:
        schema = "Choose short snake_case keys that fit the task and use the same keys for every row. Use null when a value is not shown."
    test = ""
    if run.get("trigger") == "test":
        test = "\nThis is a quick test: stop after %d rows. Also report whether the page has pagination." % limit
    return (
        "You are a careful web data extraction agent. You start at the URL given.\n"
        + MODE_TEXT.get(run.get("mode"), MODE_TEXT["page"]).format(pages=pages) + "\n"
        "If a cookie banner, location prompt or login popup blocks the content, dismiss it. "
        "Never log in, fill forms, add to cart or buy anything.\n\n"
        "Task: " + (run.get("prompt") or "Extract the main items listed on the page.") + "\n\n"
        + schema + test + "\n"
        "Return at most %d rows. Do not invent values.\n\n" % limit
        + "Return ONLY valid JSON in this shape:\n"
        '{"rows": [ {...}, ... ], "pages_visited": <number>, '
        '"pagination": {"detected": <true|false>, "next_label": <string or null>, "total_pages": <number or null>}}\n'
        'If a CAPTCHA, "Access Denied" or bot check blocks you, return {"rows": [], "error": "blocked"}. '
        'If the page has nothing matching the task, return {"rows": [], "error": "no_results"}.'
    )


# ---------------------------------------------------------------- TinyFish calls
def tf_request(method, path, body=None, timeout=30):
    req = urllib.request.Request(
        TF_BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"X-API-Key": api_key(), "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def tf_error_message(status, body):
    msg = body
    try:
        j = json.loads(body)
        err = j.get("error") if isinstance(j, dict) else None
        msg = (err.get("message") if isinstance(err, dict) else err) or j.get("message") or body
    except ValueError:
        pass
    return msg if isinstance(msg, str) else json.dumps(msg)


WALLET = {"at": 0, "data": None}


def wallet(force=False):
    if not api_key():
        return {"available": False, "reason": "no_key"}
    if not force and WALLET["data"] and time.time() - WALLET["at"] < 60:
        return WALLET["data"]
    try:
        w = tf_request("GET", "/wallet", timeout=15)
        rate = None
        for m in (w.get("rates") or {}).get("meters", []):
            if "step" in (m.get("per") or "") or "step" in (m.get("label") or "").lower():
                rate = float(m.get("unit_amount") or 0)
        data = {"available": True, "balance": float(w.get("available_balance") or 0), "currency": w.get("currency", "USD"), "step_rate": rate}
    except urllib.error.HTTPError as e:
        data = {"available": False, "reason": "legacy" if e.code == 404 else "error", "status": e.code}
    except Exception as e:  # noqa: BLE001
        data = {"available": False, "reason": "error", "message": str(e)}
    WALLET.update(at=time.time(), data=data)
    return data


# ---------------------------------------------------------------- runs
def summary(run):
    keys = ("id", "num", "extractor_id", "name", "host", "url", "mode", "status", "trigger", "created_at", "started_at",
            "finished_at", "row_count", "steps_count", "max_pages", "pages_visited", "retried", "cost", "format")
    s = {k: run.get(k) for k in keys}
    s["error_title"] = (run.get("error") or {}).get("title")
    s["deliveries"] = len(run.get("deliveries") or [])
    return s


def get_extractor(eid):
    return next((e for e in STORE["extractors"] if e["id"] == eid), None)


def upsert_extractor(data):
    with LOCK:
        ex = get_extractor(data.get("id")) if data.get("id") else None
        if ex is None:
            # reuse an extractor with the same URL + prompt instead of piling up duplicates
            ex = next((e for e in STORE["extractors"] if e["url"] == data.get("url") and e["prompt"] == data.get("prompt") and not data.get("id")), None)
        if ex is None:
            ex = {"id": new_id("ex"), "created_at": now_iso(), "fields": []}
            STORE["extractors"].insert(0, ex)
        for k in ("name", "url", "prompt", "mode", "max_pages", "max_rows", "fields", "options", "format"):
            if k in data and data[k] is not None:
                ex[k] = data[k]
        ex["fields"] = [sanitize_field(f) for f in ex.get("fields") or [] if f.get("key")]
        ex.setdefault("mode", "page")
        ex.setdefault("max_pages", 3)
        ex.setdefault("format", settings()["default_format"])
        ex.setdefault("options", {})
        if not ex.get("name"):
            ex["name"] = derive_name(ex.get("url", ""), ex.get("prompt", ""))
        ex["updated_at"] = now_iso()
        save_store()
        return ex


def sanitize_field(f):
    t = f.get("type") if f.get("type") in FIELD_TYPES else "text"
    return {"key": slug_key(f.get("key")), "desc": str(f.get("desc") or "")[:200], "type": t}


def start_run(ex, trigger="manual", overrides=None):
    s = settings()
    opts = {"stealth": s["stealth"], "use_proxy": s["use_proxy"], "proxy_country": s["proxy_country"],
            "respect_robots": s["respect_robots"], "auto_retry_blocked": s["auto_retry_blocked"]}
    opts.update(ex.get("options") or {})
    if overrides and overrides.get("options"):
        opts.update(overrides["options"])
    with LOCK:
        STORE["counter"] += 1
        run = {
            "id": new_id("run"), "num": STORE["counter"], "extractor_id": ex["id"], "name": ex["name"],
            "url": ex["url"], "host": host_of(ex["url"]), "prompt": ex.get("prompt", ""), "mode": ex.get("mode", "page"),
            "max_pages": ex.get("max_pages", 3), "max_rows": 5 if trigger == "test" else ex.get("max_rows", 100),
            "fields": ex.get("fields") or [], "options": opts, "format": ex.get("format", "json"),
            "status": "queued", "trigger": trigger, "created_at": now_iso(), "started_at": None, "finished_at": None,
            "tf_run_id": None, "streaming_url": None, "steps": [], "steps_count": 0, "rows": [], "row_count": 0,
            "pagination": None, "pages_visited": None, "error": None, "agent_error": None, "raw": None,
            "retried": False, "attempts": [], "cost": None, "deliveries": [],
        }
        if trigger == "test":
            run["mode"] = "page"
        RUNS[run["id"]] = run
        RUN_CTX[run["id"]] = {"cancel": False, "resp": None}
        save_store()
        save_run(run)
    threading.Thread(target=execute_run, args=(run["id"],), daemon=True).start()
    return run


def log(run, text, kind="step"):
    with LOCK:
        run["steps"].append({"t": now_iso(), "text": str(text)[:400], "kind": kind})
        if kind == "step":
            run["steps_count"] += 1


def fail(run, title, message, code=None):
    with LOCK:
        run["status"] = "failed"
        run["error"] = {"title": title, "message": message, "code": code}
        run["finished_at"] = now_iso()
        log(run, message, "error")
        save_run(run)


def execute_run(run_id):
    run = RUNS[run_id]
    ctx = RUN_CTX[run_id]
    try:
        if not api_key():
            return fail(run, "No TinyFish API key", "Add your key under API & webhooks, or set TINYFISH_API_KEY in .env.", "no_key")
        with LOCK:
            run["status"] = "running"
            run["started_at"] = now_iso()
        log(run, "Run #%d queued for %s" % (run["num"], run["host"]), "sys")
        if run["options"].get("respect_robots"):
            allowed, rule = robots_check(run["url"])
            if not allowed:
                return fail(run, "Blocked by robots.txt",
                            "%s's robots.txt disallows this URL (rule: Disallow: %s). Turn off “Respect robots.txt” only if you have permission to scrape it." % (run["host"], rule),
                            "robots")
            log(run, "robots.txt allows this URL", "sys")

        proxy = run["options"].get("proxy_country") if run["options"].get("use_proxy") else None
        stealth = run["options"].get("stealth", True)
        outcome = attempt(run, ctx, proxy, stealth)
        if (outcome == "blocked" and run["options"].get("auto_retry_blocked") and not ctx["cancel"]
                and (not proxy or not stealth)):
            with LOCK:
                run["status"] = "retrying"
                run["retried"] = True
            log(run, "Blocked by the site — retrying with stealth browser and a %s proxy" % (proxy or "US"), "warn")
            outcome = attempt(run, ctx, proxy or "US", True)
        finish(run, outcome)
    except Exception as e:  # noqa: BLE001 - never leave a run hanging
        fail(run, "Unexpected error", str(e), "internal")
    finally:
        RUN_CTX.pop(run_id, None)


def attempt(run, ctx, proxy, stealth):
    """One TinyFish run. Returns 'ok', 'blocked', 'empty', 'failed' or 'cancelled'."""
    payload = {"url": run["url"], "goal": build_goal(run), "browser_profile": "stealth" if stealth else "lite"}
    if proxy in PROXY_COUNTRIES:
        payload["proxy_config"] = {"enabled": True, "country_code": proxy}
    run["attempts"].append({"at": now_iso(), "proxy": proxy, "stealth": stealth})
    req = urllib.request.Request(
        TF_BASE + "/automation/run-sse", data=json.dumps(payload).encode(), method="POST",
        headers={"X-API-Key": api_key(), "Content-Type": "application/json", "Accept": "text/event-stream"},
    )
    try:
        resp = urllib.request.urlopen(req, timeout=900)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        msg = tf_error_message(e.code, body)
        title = {401: "TinyFish rejected the API key", 402: "TinyFish balance too low", 429: "Too many runs at once"}.get(e.code, "TinyFish refused the run")
        fail(run, title, "TinyFish %s: %s" % (e.code, msg), "http_%s" % e.code)
        return "failed"
    except (urllib.error.URLError, socket.timeout) as e:
        fail(run, "Couldn't reach TinyFish", "Network error: %s" % getattr(e, "reason", e), "network")
        return "failed"

    ctx["resp"] = resp
    last_save = time.time()
    result = None
    try:
        with resp:
            for raw in resp:
                if ctx["cancel"]:
                    break
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                try:
                    ev = json.loads(line[5:].strip())
                except ValueError:
                    continue
                t = ev.get("type")
                if t == "STARTED":
                    with LOCK:
                        run["tf_run_id"] = ev.get("run_id")
                    log(run, "Cloud browser launched", "sys")
                elif t == "STREAMING_URL":
                    with LOCK:
                        run["streaming_url"] = ev.get("streaming_url")
                elif t == "PROGRESS" and ev.get("purpose"):
                    log(run, ev["purpose"])
                elif t == "COMPLETE":
                    result = ev
                    break
                if time.time() - last_save > 2:
                    save_run(run)
                    last_save = time.time()
    except (OSError, ValueError, AttributeError):
        pass  # connection closed (usually by cancel)
    finally:
        ctx["resp"] = None

    if ctx["cancel"]:
        return "cancelled"
    if result is None:
        fail(run, "Connection lost", "The stream from TinyFish ended before the run finished.", "stream")
        return "failed"
    if result.get("status") != "COMPLETED":
        err = result.get("error") or {}
        msg = err.get("message") or err.get("help_message") or "TinyFish reported the run as %s." % str(result.get("status") or "failed").lower()
        if result.get("status") == "CANCELLED":
            return "cancelled"
        fail(run, "The agent couldn't finish", msg, err.get("code") or "agent_failure")
        return "failed"

    norm = normalize_result(result.get("result"))
    rows = clean_rows(norm.get("rows") or [], run["fields"], run["url"])
    with LOCK:
        run["raw"] = result.get("result")
        run["rows"] = rows
        run["row_count"] = len(rows)
        run["agent_error"] = norm.get("error") if not rows else None
        run["pagination"] = norm.get("pagination") if isinstance(norm.get("pagination"), dict) else None
        pv = to_num(norm.get("pages_visited"))
        run["pages_visited"] = int(pv) if pv else None
    if rows:
        return "ok"
    return "blocked" if norm.get("error") == "blocked" else "empty"


AGENT_ERRORS = {
    "blocked": ("The site blocked the agent", "A CAPTCHA or access-denied page stopped the run. Try again with Stealth browser and a proxy turned on."),
    "no_results": ("Nothing matched", "The page had nothing that matches your instructions. Check the URL or describe the data differently."),
    "unparseable": ("Couldn't read the agent's answer", "The agent replied, but not in the expected JSON. Running it again usually fixes this."),
    "empty": ("No rows came back", "The agent finished without returning any rows. Try rephrasing what to extract."),
}


def finish(run, outcome):
    if outcome == "failed":
        return
    with LOCK:
        run["finished_at"] = now_iso()
        if outcome == "cancelled":
            run["status"] = "cancelled"
            log(run, "Stopped by you", "error")
        elif outcome == "ok":
            run["status"] = "completed"
            log(run, "Extracted %d rows" % run["row_count"], "ok")
        else:
            code = run.get("agent_error") or ("blocked" if outcome == "blocked" else "empty")
            title, msg = AGENT_ERRORS.get(code, AGENT_ERRORS["empty"])
            run["status"] = "failed"
            run["error"] = {"title": title, "message": msg, "code": code}
            log(run, title, "error")
        save_run(run)
    # cost (best-effort): TinyFish step count × wallet step rate
    if run.get("tf_run_id"):
        try:
            info = tf_request("GET", "/runs/" + urllib.parse.quote(run["tf_run_id"]), timeout=15)
            steps = info.get("num_of_steps")
            w = wallet()
            with LOCK:
                if steps is not None:
                    run["tf_steps"] = steps
                    if w.get("step_rate"):
                        run["cost"] = round(steps * w["step_rate"], 4)
            WALLET["at"] = 0  # balance changed
        except Exception:  # noqa: BLE001
            pass
    if run["status"] == "completed" and run["trigger"] != "test" and settings().get("webhook_on_run") and settings().get("webhook_url"):
        deliver_webhook(run)
    save_run(run)


def cancel_run(run):
    ctx = RUN_CTX.get(run["id"])
    if ctx:
        ctx["cancel"] = True
        if run.get("tf_run_id"):
            try:
                tf_request("POST", "/runs/%s/cancel" % urllib.parse.quote(run["tf_run_id"]), {}, timeout=15)
            except Exception:  # noqa: BLE001
                pass
        resp = ctx.get("resp")
        if resp is not None:
            try:
                resp.close()
            except Exception:  # noqa: BLE001
                pass
    with LOCK:
        if run["status"] in ("queued", "running", "retrying"):
            run["status"] = "cancelled"
            run["finished_at"] = now_iso()
            log(run, "Stopped by you", "error")
            save_run(run)


# ---------------------------------------------------------------- exports & destinations
def columns_for(run):
    if run.get("fields"):
        return [f["key"] for f in run["fields"]]
    cols = []
    for r in run.get("rows") or []:
        for k in r:
            if k not in cols:
                cols.append(k)
    return cols


def export_bytes(run, fmt):
    rows = run.get("rows") or []
    if fmt == "csv":
        buf = io.StringIO()
        cols = columns_for(run)
        w = csv.writer(buf)
        w.writerow(cols)
        for r in rows:
            w.writerow([" | ".join(map(str, v)) if isinstance(v, list) else json.dumps(v, ensure_ascii=False) if isinstance(v, dict) else "" if v is None else v for v in (r.get(c) for c in cols)])
        return ("\ufeff" + buf.getvalue()).encode("utf-8"), "text/csv"
    if fmt == "jsonl":
        return ("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n").encode("utf-8"), "application/x-ndjson"
    return json.dumps(rows, ensure_ascii=False, indent=2).encode("utf-8"), "application/json"


def record_delivery(run, kind, ok, detail=""):
    with LOCK:
        run.setdefault("deliveries", []).append({"at": now_iso(), "kind": kind, "ok": ok, "detail": detail})
        STORE["deliveries"] = (STORE.get("deliveries") or [])[-199:] + [{"at": now_iso(), "kind": kind, "ok": ok, "run_id": run["id"]}]
        save_run(run)
        save_store()


def sync_db(run):
    os.makedirs(DATA_DIR, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    try:
        con.execute("""CREATE TABLE IF NOT EXISTS rows (
            run_id TEXT, run_num INTEGER, extractor_id TEXT, extractor_name TEXT, source_url TEXT,
            row_index INTEGER, data TEXT, scraped_at TEXT, PRIMARY KEY (run_id, row_index))""")
        con.execute("DELETE FROM rows WHERE run_id = ?", (run["id"],))
        con.executemany(
            "INSERT INTO rows VALUES (?,?,?,?,?,?,?,?)",
            [(run["id"], run["num"], run["extractor_id"], run["name"], run["url"], i, json.dumps(r, ensure_ascii=False), run.get("finished_at"))
             for i, r in enumerate(run.get("rows") or [])],
        )
        con.commit()
        total = con.execute("SELECT COUNT(*) FROM rows").fetchone()[0]
    finally:
        con.close()
    record_delivery(run, "database", True, "%d rows → %s" % (run["row_count"], os.path.relpath(DB_PATH, ROOT)))
    return {"ok": True, "path": DB_PATH, "rel_path": os.path.relpath(DB_PATH, ROOT), "rows": run["row_count"], "total_rows": total}


def post_json(url, payload, timeout=15):
    if not re.match(r"^https?://", url or ""):
        raise ValueError("Webhook URL must start with http:// or https://")
    req = urllib.request.Request(url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), method="POST",
                                 headers={"Content-Type": "application/json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status


def deliver_webhook(run):
    url = settings().get("webhook_url")
    payload = {"event": "run.completed", "run": summary(run), "rows": run.get("rows") or []}
    try:
        status = post_json(url, payload)
        record_delivery(run, "webhook", 200 <= status < 300, "HTTP %s" % status)
        return {"ok": 200 <= status < 300, "status": status}
    except urllib.error.HTTPError as e:
        record_delivery(run, "webhook", False, "HTTP %s" % e.code)
        return {"ok": False, "status": e.code, "error": "The webhook answered HTTP %s" % e.code}
    except Exception as e:  # noqa: BLE001
        record_delivery(run, "webhook", False, str(e))
        return {"ok": False, "error": str(e)}


# ---------------------------------------------------------------- schedules
def next_time(s, after=None):
    after = after or datetime.now()
    hh, mm = (int(x) for x in (s.get("at") or "09:00").split(":"))
    if s["every"] == "hourly":
        t = after.replace(minute=mm, second=0, microsecond=0)
        return t if t > after else t + timedelta(hours=1)
    t = after.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if s["every"] == "weekly":
        t += timedelta(days=(int(s.get("weekday", 0)) - t.weekday()) % 7)
        return t if t > after else t + timedelta(days=7)
    return t if t > after else t + timedelta(days=1)


def scheduler_loop():
    while True:
        time.sleep(20)
        try:
            due = []
            with LOCK:
                for s in STORE["schedules"]:
                    if s.get("enabled") and s.get("next_at") and datetime.fromisoformat(s["next_at"]) <= datetime.now():
                        due.append(s)
                        s["next_at"] = next_time(s).isoformat(timespec="minutes")
                if due:
                    save_store()
            for s in due:
                ex = get_extractor(s["extractor_id"])
                if ex:
                    run = start_run(ex, "schedule")
                    with LOCK:
                        s["last_run_id"] = run["id"]
                        s["last_run_at"] = now_iso()
                        save_store()
        except Exception as e:  # noqa: BLE001
            sys.stderr.write("  scheduler: %s\n" % e)


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "Sieve/1.0"

    def log_message(self, fmt, *args):
        line = args[0] if args else ""
        if "/api/" in line and "GET /api/state" not in line and not re.search(r"GET /api/runs/run_\w+ ", line):
            sys.stderr.write("  %s\n" % (fmt % args))

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 2_000_000:
            raise ValueError("body too large")
        return json.loads(self.rfile.read(length) or b"{}") if length else {}

    def send_json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def bad(self, msg, status=400):
        self.send_json(status, {"error": msg})

    # -- routing
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        path, qs = u.path, urllib.parse.parse_qs(u.query)
        if path == "/api/health":
            return self.send_json(200, {"ok": True, "hasKey": bool(api_key())})
        if path == "/api/state":
            return self.send_state()
        if path == "/api/wallet":
            return self.send_json(200, wallet(force="force" in qs))
        m = re.match(r"^/api/runs/(run_\w+)(/export)?$", path)
        if m:
            run = RUNS.get(m.group(1))
            if not run:
                return self.bad("Run not found", 404)
            if m.group(2):
                fmt = (qs.get("format") or ["json"])[0]
                fmt = fmt if fmt in ("csv", "json", "jsonl") else "json"
                data, ctype = export_bytes(run, fmt)
                name = re.sub(r"[^a-z0-9]+", "-", run["name"].lower()).strip("-")[:40] + "-run%d.%s" % (run["num"], fmt)
                self.send_response(200)
                self.send_header("Content-Type", ctype + "; charset=utf-8")
                self.send_header("Content-Disposition", 'attachment; filename="%s"' % name)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                record_delivery(run, "export_" + fmt, True, "%d bytes" % len(data))
                return
            with LOCK:
                return self.send_json(200, run)
        if path.startswith("/api/"):
            return self.bad("Unknown endpoint", 404)
        self.serve_static(path)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            body = self.read_json()
        except ValueError:
            return self.bad("Invalid JSON body")
        routes = [
            (r"^/api/runs$", self.create_run),
            (r"^/api/runs/(run_\w+)/cancel$", self.run_cancel),
            (r"^/api/runs/(run_\w+)/sync-db$", self.run_sync_db),
            (r"^/api/runs/(run_\w+)/webhook$", self.run_webhook),
            (r"^/api/extractors$", self.save_extractor),
            (r"^/api/schedules$", self.save_schedule),
            (r"^/api/schedules/(sch_\w+)/run$", self.schedule_run_now),
            (r"^/api/settings$", self.save_settings),
            (r"^/api/settings/test-webhook$", self.test_webhook),
            (r"^/api/robots$", self.check_robots),
        ]
        for pattern, fn in routes:
            m = re.match(pattern, path)
            if m:
                return fn(body, *m.groups())
        self.bad("Unknown endpoint", 404)

    def do_DELETE(self):
        path = urllib.parse.urlparse(self.path).path
        m = re.match(r"^/api/(runs|extractors|schedules)/(\w+)$", path)
        if not m:
            return self.bad("Unknown endpoint", 404)
        kind, oid = m.groups()
        with LOCK:
            if kind == "runs":
                run = RUNS.get(oid)
                if not run:
                    return self.bad("Run not found", 404)
                if run["status"] in ("queued", "running", "retrying"):
                    return self.bad("Stop the run before deleting it", 409)
                RUNS.pop(oid)
                try:
                    os.remove(os.path.join(RUNS_DIR, oid + ".json"))
                except OSError:
                    pass
            elif kind == "extractors":
                STORE["extractors"] = [e for e in STORE["extractors"] if e["id"] != oid]
                STORE["schedules"] = [s for s in STORE["schedules"] if s["extractor_id"] != oid]
                save_store()
            else:
                STORE["schedules"] = [s for s in STORE["schedules"] if s["id"] != oid]
                save_store()
        self.send_json(200, {"ok": True})

    # -- handlers
    def send_state(self):
        with LOCK:
            runs = sorted((summary(r) for r in RUNS.values()), key=lambda r: r["created_at"] or "", reverse=True)
            state = {
                "extractors": STORE["extractors"],
                "schedules": STORE["schedules"],
                "settings": public_settings(),
                "runs": runs,
                "deliveries": len(STORE.get("deliveries") or []),
                "db_path": os.path.relpath(DB_PATH, ROOT),
                "server_time": now_iso(),
            }
        self.send_json(200, state)

    def create_run(self, body):
        if body.get("extractor_id"):
            ex = get_extractor(body["extractor_id"])
            if not ex:
                return self.bad("Extractor not found", 404)
            if any(k in body for k in ("url", "prompt", "fields", "mode", "options")):
                ex = upsert_extractor({**body, "id": ex["id"]})
        else:
            url = str(body.get("url") or "").strip()
            if not re.match(r"^https?://[^\s/$.?#].[^\s]*$", url, re.I):
                return self.bad("Enter a full URL that starts with http:// or https://")
            if not str(body.get("prompt") or "").strip() and not body.get("fields"):
                return self.bad("Describe what to extract")
            ex = upsert_extractor({k: body.get(k) for k in ("name", "url", "prompt", "mode", "max_pages", "max_rows", "fields", "options", "format")})
        if not api_key():
            return self.bad("Add your TinyFish API key first (API & webhooks → TinyFish key).", 400)
        run = start_run(ex, "test" if body.get("test") else body.get("trigger") or "manual", body)
        self.send_json(201, {"run": summary(run), "extractor": ex})

    def run_cancel(self, body, rid):
        run = RUNS.get(rid)
        if not run:
            return self.bad("Run not found", 404)
        threading.Thread(target=cancel_run, args=(run,), daemon=True).start()
        self.send_json(202, {"ok": True})

    def run_sync_db(self, body, rid):
        run = RUNS.get(rid)
        if not run or not run.get("rows"):
            return self.bad("This run has no rows to sync", 404)
        try:
            self.send_json(200, sync_db(run))
        except sqlite3.Error as e:
            self.bad("Database error: %s" % e, 500)

    def run_webhook(self, body, rid):
        run = RUNS.get(rid)
        if not run:
            return self.bad("Run not found", 404)
        if not settings().get("webhook_url"):
            return self.bad("Set a webhook URL first (API & webhooks).", 400)
        res = deliver_webhook(run)
        self.send_json(200 if res.get("ok") else 502, res)

    def save_extractor(self, body):
        if body.get("url") and not re.match(r"^https?://", body["url"], re.I):
            return self.bad("URL must start with http:// or https://")
        if not body.get("id") and not body.get("url"):
            return self.bad("An extractor needs a URL")
        self.send_json(200, {"extractor": upsert_extractor(body)})

    def save_schedule(self, body):
        with LOCK:
            s = next((x for x in STORE["schedules"] if x["id"] == body.get("id")), None) if body.get("id") else None
            if s is None:
                if not get_extractor(body.get("extractor_id")):
                    return self.bad("Pick an extractor to schedule")
                s = {"id": new_id("sch"), "created_at": now_iso(), "enabled": True}
                STORE["schedules"].insert(0, s)
            for k in ("extractor_id", "every", "at", "weekday", "enabled"):
                if k in body:
                    s[k] = body[k]
            if s.get("every") not in ("hourly", "daily", "weekly"):
                s["every"] = "daily"
            if not re.match(r"^\d{1,2}:\d{2}$", str(s.get("at") or "")):
                s["at"] = "09:00"
            s["next_at"] = next_time(s).isoformat(timespec="minutes")
            save_store()
        self.send_json(200, {"schedule": s})

    def schedule_run_now(self, body, sid):
        s = next((x for x in STORE["schedules"] if x["id"] == sid), None)
        ex = get_extractor(s["extractor_id"]) if s else None
        if not ex:
            return self.bad("Schedule not found", 404)
        if not api_key():
            return self.bad("Add your TinyFish API key first.")
        run = start_run(ex, "schedule")
        with LOCK:
            s["last_run_id"], s["last_run_at"] = run["id"], now_iso()
            save_store()
        self.send_json(201, {"run": summary(run)})

    def save_settings(self, body):
        with LOCK:
            s = settings()
            for k, v in body.items():
                if k not in DEFAULT_SETTINGS:
                    continue
                if k == "proxy_country" and v not in PROXY_COUNTRIES:
                    continue
                if k == "webhook_url" and v and not re.match(r"^https?://", v):
                    return self.bad("Webhook URL must start with http:// or https://")
                if k == "tinyfish_key":
                    v = str(v or "").strip()
                    WALLET["at"] = 0
                s[k] = v
            save_store()
        self.send_json(200, {"settings": public_settings()})

    def test_webhook(self, body):
        url = body.get("url") or settings().get("webhook_url")
        try:
            status = post_json(url, {"event": "test", "message": "Hello from Sieve 👋", "sent_at": now_iso()})
            self.send_json(200, {"ok": 200 <= status < 300, "status": status})
        except urllib.error.HTTPError as e:
            self.send_json(200, {"ok": False, "status": e.code, "error": "The webhook answered HTTP %s" % e.code})
        except Exception as e:  # noqa: BLE001
            self.send_json(200, {"ok": False, "error": str(e)})

    def check_robots(self, body):
        allowed, rule = robots_check(str(body.get("url") or ""))
        self.send_json(200, {"allowed": allowed, "rule": rule})

    def serve_static(self, path):
        rel = "index.html" if path in ("", "/") else urllib.parse.unquote(path).lstrip("/")
        file = os.path.normpath(os.path.join(PUBLIC_DIR, rel))
        if not file.startswith(PUBLIC_DIR) or not os.path.isfile(file):
            return self.bad("Not found", 404)
        with open(file, "rb") as f:
            data = f.read()
        ctype = mimetypes.guess_type(file)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") or ctype.endswith("javascript") else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)


def main():
    load_data()
    threading.Thread(target=scheduler_loop, daemon=True).start()
    srv = None
    for port in range(PORT, PORT + 20):  # fall forward if the port is busy
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    if srv is None:
        sys.exit("No free port found between %d and %d" % (PORT, PORT + 19))
    srv.daemon_threads = True
    print("\n  ◼︎  Sieve running at  http://localhost:%d" % srv.server_address[1], flush=True)
    print("  🔑  TinyFish key loaded from %s\n" % (".env" if key_source() == "env" else "settings") if api_key()
          else "  ⚠️   No TinyFish key yet — add it in the app under API & webhooks\n", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  bye 👋")


if __name__ == "__main__":
    main()
