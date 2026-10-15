

import json
import mimetypes
import os
import re
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(ROOT, "public")
TF_BASE = "https://agent.tinyfish.ai/v1"



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


def env_key():
    key = os.environ.get("TINYFISH_API_KEY", "").strip()
    return "" if key in ("paste_your_key_here", "your_key_here") else key



PROXY_COUNTRIES = {"US", "GB", "CA", "DE", "FR", "JP", "AU"}  # TinyFish-supported proxy locations
SORTS = {"popularity": "popularity", "price_asc": "price_asc", "price_desc": "price_desc", "newest": "recency_desc"}

FIELDS = """{
  "name": string (full product title),
  "price": number (current selling price in INR, digits only),
  "original_price": number | null (MRP before discount),
  "discount_percent": number | null,
  "rating": number | null (out of 5),
  "rating_count": number | null (number of ratings),
  "review_count": number | null,
  "image_url": string | null (absolute URL of the main product image),
  "product_url": string | null (absolute flipkart.com URL of the product page),
  "highlights": string[] (up to 4 key specs/features shown),
  "assured": boolean (true if it shows the "Flipkart Assured" badge),
  "sponsored": boolean (true if marked Ad/Sponsored)
}"""


def build_target(opts):
    raw = str(opts.get("query") or "").strip()
    if re.match(r"^https?://(www\.)?flipkart\.com/", raw, re.I):
        return raw, not re.search(r"/p/itm", raw, re.I)
    params = {"q": raw}
    sort = opts.get("sort")
    if sort in SORTS:
        params["sort"] = SORTS[sort]
    return "https://www.flipkart.com/search?" + urllib.parse.urlencode(params), True


def to_num(v):
    if v is None or v == "" or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return v
    s = re.sub(r"[^0-9.]", "", str(v))
    try:
        return float(s) if "." in s else int(s)
    except ValueError:
        return None


def build_goal(opts, is_search):
    limit = max(1, min(int(to_num(opts.get("limit")) or 10), 50))
    filters = []
    if to_num(opts.get("minPrice")):
        filters.append("price >= ₹%s" % to_num(opts["minPrice"]))
    if to_num(opts.get("maxPrice")):
        filters.append("price <= ₹%s" % to_num(opts["maxPrice"]))
    if to_num(opts.get("minRating")):
        filters.append("rating >= %s" % to_num(opts["minRating"]))

    if is_search:
        task = (
            "You are on a Flipkart search results page. If a login popup appears, close it (click the ✕). "
            "Scroll as needed and extract the first %d products listed%s. If fewer are on the first page, "
            "go to the next results page until you have %d or results run out."
            % (limit, (" that match: " + ", ".join(filters)) if filters else "", limit)
        )
    else:
        task = "You are on a Flipkart product page. If a login popup appears, close it. Extract this single product's details."

    notes = str(opts.get("notes") or "").strip()[:500]
    extra = ("\nAdditional instructions from the user: " + notes) if notes else ""

    return (
        task + extra + "\nReturn ONLY valid JSON of the shape {\"products\": [ ... ]} where each item is:\n" + FIELDS +
        "\nDo not invent values; use null when a field is not visible. If the page shows a CAPTCHA, \"Access Denied\", "
        "or blocks you, return {\"products\": [], \"error\": \"blocked\"}. If there are no results, "
        "return {\"products\": [], \"error\": \"no_results\"}."
    )


def parse_jsonish(s):
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", s)
    s = m.group(1) if m else s
    try:
        return json.loads(s)
    except ValueError:
        a, b = s.find("{"), s.rfind("}")
        if a >= 0 and b > a:
            try:
                return json.loads(s[a:b + 1])
            except ValueError:
                pass
    return None


def normalize_result(result):
    """TinyFish returns either the object directly or a JSON string under result.result."""
    r = result
    for _ in range(3):
        if isinstance(r, dict) and "products" not in r and "result" in r:
            r = r["result"]
    if isinstance(r, str):
        parsed = parse_jsonish(r)
        if parsed is None:
            return {"products": [], "error": "unparseable"}
        r = parsed
    if isinstance(r, list):
        return {"products": r}
    if isinstance(r, dict):
        if isinstance(r.get("products"), list):
            return r
        for v in r.values():
            if isinstance(v, list) and any(isinstance(x, dict) for x in v):
                return {"products": v, "error": r.get("error")}
        if r.get("name"):
            return {"products": [r]}
        return {"products": [], "error": r.get("error") or "empty"}
    return {"products": [], "error": "empty"}


def absolute(u):
    if not u or not isinstance(u, str):
        return None
    if u.startswith("//"):
        return "https:" + u
    if u.startswith("/"):
        return "https://www.flipkart.com" + u
    return u


def clean_product(p, i):
    price = to_num(p.get("price"))
    original = to_num(p.get("original_price", p.get("mrp")))
    discount = to_num(p.get("discount_percent", p.get("discount")))
    if discount is None and price and original and original > price:
        discount = round((1 - price / original) * 100)
    hl = p.get("highlights")
    return {
        "id": i + 1,
        "name": str(p.get("name") or p.get("title") or "Untitled product").strip(),
        "price": price,
        "original_price": original,
        "discount_percent": discount,
        "rating": to_num(p.get("rating")),
        "rating_count": to_num(p.get("rating_count", p.get("ratings"))),
        "review_count": to_num(p.get("review_count", p.get("reviews"))),
        "image_url": absolute(p.get("image_url") or p.get("image")),
        "product_url": absolute(p.get("product_url") or p.get("url") or p.get("link")),
        "highlights": [str(h) for h in hl[:6]] if isinstance(hl, list) else [],
        "assured": bool(p.get("assured")),
        "sponsored": bool(p.get("sponsored")),
    }


def error_message(status, body):
    msg = body
    try:
        j = json.loads(body)
        err = j.get("error") if isinstance(j, dict) else None
        msg = (err.get("message") if isinstance(err, dict) else err) or j.get("message") or body
    except ValueError:
        pass
    return ("TinyFish %s: %s" % (status, msg if isinstance(msg, str) else json.dumps(msg)))[:600]



class Handler(BaseHTTPRequestHandler):
    server_version = "FlipkartScout/1.0"

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("  %s\n" % (fmt % args))

   
    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 1_000_000:
            raise ValueError("body too large")
        raw = self.rfile.read(length) if length else b""
        return json.loads(raw or b"{}")

    def send_json(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def sse(self, obj):
        self.wfile.write(("data: %s\n\n" % json.dumps(obj)).encode())
        self.wfile.flush()

    
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/health":
            return self.send_json(200, {"ok": True, "hasKey": bool(env_key())})
        self.serve_static(path)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/scrape":
            return self.scrape()
        m = re.match(r"^/api/runs/([^/]+)/cancel$", path)
        if m:
            return self.cancel(m.group(1))
        self.send_json(405, {"error": "method not allowed"})

    def serve_static(self, path):
        rel = "index.html" if path in ("", "/") else urllib.parse.unquote(path).lstrip("/")
        file = os.path.normpath(os.path.join(PUBLIC_DIR, rel))
        if not file.startswith(PUBLIC_DIR) or not os.path.isfile(file):
            return self.send_json(404, {"error": "not found"})
        with open(file, "rb") as f:
            data = f.read()
        ctype = mimetypes.guess_type(file)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # -- /api/scrape : proxy TinyFish SSE stream, normalize final result
    def scrape(self):
        try:
            opts = self.read_json()
        except ValueError:
            return self.send_json(400, {"error": "Invalid JSON body"})
        if not str(opts.get("query") or "").strip():
            return self.send_json(400, {"error": "Enter a search term or Flipkart URL"})
        key = opts.get("apiKey") or env_key()
        if not key:
            return self.send_json(400, {"error": "No TinyFish API key. Add TINYFISH_API_KEY to .env or paste one in Settings."})

        url, is_search = build_target(opts)
        payload = {
            "url": url,
            "goal": build_goal(opts, is_search),
            "browser_profile": "lite" if opts.get("stealth") is False else "stealth",
        }
        proxy = str(opts.get("proxy") or "").upper()
        if proxy in PROXY_COUNTRIES:
            payload["proxy_config"] = {"enabled": True, "country_code": proxy}

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        try:
            self.sse({"type": "TARGET", "url": url, "goal": payload["goal"]})
            req = urllib.request.Request(
                TF_BASE + "/automation/run-sse",
                data=json.dumps(payload).encode(),
                headers={"X-API-Key": key, "Content-Type": "application/json", "Accept": "text/event-stream"},
                method="POST",
            )
            try:
                upstream = urllib.request.urlopen(req, timeout=600)
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", "replace")
                return self.sse({"type": "ERROR", "status": e.code, "message": error_message(e.code, body)})
            except (urllib.error.URLError, socket.timeout) as e:
                return self.sse({"type": "ERROR", "message": "Could not reach TinyFish: %s" % getattr(e, "reason", e)})

            with upstream:
                for raw in upstream:  # SSE is line-oriented
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    try:
                        ev = json.loads(line[5:].strip())
                    except ValueError:
                        continue
                    if ev.get("type") == "COMPLETE":
                        norm = normalize_result(ev.get("result"))
                        products = [clean_product(p, i) for i, p in enumerate(
                            p for p in norm.get("products") or [] if isinstance(p, dict))]
                        run_id = ev.get("run_id")
                        self.sse({
                            "type": "COMPLETE",
                            "run_id": run_id,
                            "status": ev.get("status"),
                            "error": ev.get("error"),
                            "agent_error": norm.get("error"),
                            "products": products,
                            "raw": ev.get("result"),
                            "run_url": ev.get("run_url") or ("https://agent.tinyfish.ai/runs/%s" % run_id if run_id else None),
                        })
                    else:
                        self.sse(ev)
        except (BrokenPipeError, ConnectionResetError):
            pass  # browser closed the tab / pressed Stop
        except Exception as e:  # noqa: BLE001 - surface anything else to the UI
            try:
                self.sse({"type": "ERROR", "message": str(e)})
            except OSError:
                pass

    # -- /api/runs/<id>/cancel
    def cancel(self, run_id):
        try:
            body = self.read_json()
        except ValueError:
            body = {}
        key = body.get("apiKey") or env_key()
        req = urllib.request.Request(
            "%s/runs/%s/cancel" % (TF_BASE, urllib.parse.quote(run_id, safe="")),
            data=b"{}", headers={"X-API-Key": key, "Content-Type": "application/json"}, method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                self.send_json(r.status, json.loads(r.read() or b"{}"))
        except urllib.error.HTTPError as e:
            self.send_json(e.code, {"error": error_message(e.code, e.read().decode("utf-8", "replace"))})
        except Exception as e:  # noqa: BLE001
            self.send_json(502, {"error": str(e)})


def main():
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
    print("\n  🛒  Flipkart Scout running at  http://localhost:%d" % srv.server_address[1], flush=True)
    print("  🔑  TinyFish API key loaded from .env\n" if env_key()
          else "  ⚠️   No TINYFISH_API_KEY set — add it to .env or paste it in the UI Settings\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  bye 👋")


if __name__ == "__main__":
    main()
