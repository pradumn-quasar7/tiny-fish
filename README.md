# ◼︎ Sieve — any website, as clean data

Paste a URL, describe what you need, and Sieve returns structured rows — no selectors required.
A real cloud browser from the [TinyFish Web Agent API](https://docs.tinyfish.ai) opens the page,
reads it, and hands back JSON you can browse, diff, export, sync and schedule.

## Run

1. Put your TinyFish key in `.env` (get one at https://agent.tinyfish.ai/api-keys):
   ```
   TINYFISH_API_KEY=your_key_here
   ```
   Or paste it later in the app under **API & webhooks**.
2. Start the server (Python 3.8+, standard library only, nothing to install):
   ```bash
   python3 server.py
   ```
3. Open the address it prints (it starts at port 8000 and moves up if that port is busy).

## What's in the app

| Screen | What it does |
|---|---|
| **Workspace** | URL + "what should we extract?", Page / Crawl / Sitemap mode, stealth, proxy and robots.txt switches, output format, presets, live stats and runs |
| **Extractors** (schema builder) | Name typed fields, test on 5 rows with the live browser, see each field outlined on result cards, detect pagination, autosave, Save & run |
| **Datasets** | Every run with live progress, log and browser view; Table / JSON / Diff-vs-previous; CSV, JSON, JSONL download; sync to SQLite; webhook; schedule daily; copy API call |
| **Schedules** | Hourly, daily or weekly runs of any extractor, pause/resume, run now (runs while the server is on) |
| **Proxies** | Defaults for stealth, proxy country (US, GB, CA, DE, FR, JP, AU), auto-retry of blocked runs, robots.txt, and a robots.txt checker |
| **API & webhooks** | TinyFish key, wallet balance, webhook URL + test, copy-ready `curl` commands for the local REST API |
| **Phone** | Run monitor with progress ring, live log, stop, alerts and bottom navigation |

Also: ⌘K / `/` command palette, notifications for finished runs, profile with accent colour, `N` for a new extraction.

## Data

Everything is stored locally in `./data` (ignored by git):
`store.json` (extractors, schedules, settings), `runs/*.json` (one file per run) and `sieve.db` (SQLite, filled by "Sync to database").

## Local REST API

```bash
curl -X POST http://localhost:8000/api/runs -H "Content-Type: application/json" \
  -d '{"url": "https://books.toscrape.com/", "prompt": "Title and price of every book"}'
curl http://localhost:8000/api/runs/<run_id>
curl -OJ "http://localhost:8000/api/runs/<run_id>/export?format=csv"
```

## Notes

- Each run uses TinyFish credits (the sidebar shows your wallet balance).
- "Respect robots.txt" is on by default. Some sites disallow automated access to certain pages —
  Flipkart's robots.txt, for example, disallows `/search?` pages. Only turn the check off when you have permission.
- The previous "Scout for Flipkart" interface is kept in `archive/scout-ui/`.
