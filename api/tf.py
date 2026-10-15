"""Vercel serverless proxy for Sieve's hosted (cloud) mode.

The browser keeps all data and the visitor's own TinyFish key; this function only
forwards calls to TinyFish (which has no browser CORS) and reuses server.py's goal
builder and result cleaning. Nothing is stored here and the key is never logged.

POST /api/tf  {"action": "start" | "get" | "cancel" | "wallet" | "robots", ...}
The TinyFish key travels in the X-TinyFish-Key header.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server as core  # noqa: E402  (goal builder, result cleaning, robots.txt)

TF = os.environ.get("TINYFISH_BASE_URL", "https://agent.tinyfish.ai/v1").rstrip("/")


def tf(method, path, key, body=None, timeout=25):
    req = urllib.request.Request(
        TF + path, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"X-API-Key": key, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def start(key, b):
    run = b.get("run") or {}
    url = str(run.get("url") or "")
    if not url.startswith(("http://", "https://")):
        return 400, {"error": "Enter a full URL that starts with http:// or https://"}
    opts = run.get("options") or {}
    if opts.get("respect_robots", True):
        allowed, rule = core.robots_check(url)
        if not allowed:
            return 200, {"robots_blocked": True, "rule": rule}
    payload = {"url": url, "goal": core.build_goal(run), "browser_profile": "stealth" if opts.get("stealth", True) else "lite"}
    proxy = b.get("proxy")
    if proxy in core.PROXY_COUNTRIES:
        payload["proxy_config"] = {"enabled": True, "country_code": proxy}
    res = tf("POST", "/automation/run-async", key, payload)
    if res.get("error") or not res.get("run_id"):
        err = res.get("error") or {}
        return 502, {"error": (err.get("message") if isinstance(err, dict) else str(err)) or "TinyFish didn't start the run"}
    return 200, {"tf_run_id": res["run_id"]}


def get(key, b):
    rid = urllib.parse.quote(str(b.get("tf_run_id") or ""), safe="")
    info = tf("GET", "/runs/" + rid, key)
    run = b.get("run") or {}
    out = {
        "status": info.get("status"),
        "streaming_url": info.get("streaming_url"),
        "num_of_steps": info.get("num_of_steps"),
        "started_at": info.get("started_at"),
        "finished_at": info.get("finished_at"),
        "steps": [{"t": s.get("timestamp"), "text": s.get("action") or s.get("purpose") or "Step"} for s in (info.get("steps") or [])][-200:],
    }
    if info.get("status") == "COMPLETED":
        norm = core.normalize_result(info.get("result"))
        rows = core.clean_rows(norm.get("rows") or [], run.get("fields") or [], run.get("url") or "")
        pv = core.to_num(norm.get("pages_visited"))
        out.update(rows=rows, agent_error=None if rows else (norm.get("error") or "empty"),
                   pagination=norm.get("pagination") if isinstance(norm.get("pagination"), dict) else None,
                   pages_visited=int(pv) if pv else None)
    elif info.get("status") == "FAILED":
        err = info.get("error") or {}
        out["error"] = {"message": err.get("message") or err.get("help_message") or "The agent couldn't finish.", "code": err.get("code") or "agent_failure"}
    return 200, out


def wallet(key, b):
    w = tf("GET", "/wallet", key)
    rate = None
    for m in (w.get("rates") or {}).get("meters", []):
        if "step" in (m.get("per") or "") or "step" in (m.get("label") or "").lower():
            rate = float(m.get("unit_amount") or 0)
    return 200, {"available": True, "balance": float(w.get("available_balance") or 0), "currency": w.get("currency", "USD"), "step_rate": rate}


def cancel(key, b):
    rid = urllib.parse.quote(str(b.get("tf_run_id") or ""), safe="")
    tf("POST", "/runs/%s/cancel" % rid, key, {})
    return 200, {"ok": True}


def robots(key, b):
    allowed, rule = core.robots_check(str(b.get("url") or ""))
    return 200, {"allowed": allowed, "rule": rule}


ACTIONS = {"start": start, "get": get, "cancel": cancel, "wallet": wallet, "robots": robots}


class handler(BaseHTTPRequestHandler):
    def _send(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 200_000:
                return self._send(413, {"error": "Request too large"})
            b = json.loads(self.rfile.read(n) or b"{}") if n else {}
        except ValueError:
            return self._send(400, {"error": "Invalid JSON"})
        fn = ACTIONS.get(b.get("action"))
        if not fn:
            return self._send(400, {"error": "Unknown action"})
        key = (self.headers.get("X-TinyFish-Key") or "").strip()
        if fn is not robots and not key:
            return self._send(401, {"error": "Add your TinyFish API key first (API & webhooks → TinyFish key)."})
        try:
            status, obj = fn(key, b)
            self._send(status, obj)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            if b.get("action") == "wallet" and e.code == 404:
                return self._send(200, {"available": False, "reason": "legacy"})
            self._send(e.code if 400 <= e.code < 600 else 502, {"error": "TinyFish %s: %s" % (e.code, core.tf_error_message(e.code, body)), "status": e.code})
        except Exception as e:  # noqa: BLE001
            self._send(502, {"error": "Couldn't reach TinyFish: %s" % e})

    def do_GET(self):
        self._send(200, {"ok": True, "mode": "cloud"})
