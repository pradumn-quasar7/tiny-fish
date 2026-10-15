# 🛒 Flipkart Scout

An AI web scraper for Flipkart, powered by the [TinyFish Web Agent API](https://docs.tinyfish.ai).
A real cloud browser opens Flipkart, reads the page, and returns clean product data.
You can watch it work live, then filter, compare and export the results.

## Run

1. Copy `.env.example` to `.env` and paste your TinyFish API key (get one at https://agent.tinyfish.ai/api-keys).
   You can also paste the key in the app under ⚙ Settings.
2. Start the server (Python 3.8+, standard library only, nothing to install):

   ```bash
   python3 server.py
   ```

3. Open http://localhost:8000

## Features

- Search by keywords or paste any Flipkart search, category or product URL
- Filters: sort, price range, minimum rating, number of products (1–40), extra instructions for the agent
- Live run view: step-by-step timeline, embedded live browser stream, timer, Stop button
- Results: stat tiles, "Best value" pick, grid and sortable table views, filter-as-you-type
- Export to CSV (opens in Excel) or JSON, or copy to the clipboard
- History of recent scrapes, light/dark theme, keyboard shortcuts (`/` to search, `H` for history, `Esc` to close)
- Stealth browser (on by default) and an optional proxy country (US, GB, CA, DE, FR, JP, AU) if Flipkart blocks the agent

## How it works

`server.py` builds a Flipkart URL and a structured extraction goal, then calls
`POST https://agent.tinyfish.ai/v1/automation/run-sse`. It streams the agent's events
(`STARTED`, `STREAMING_URL`, `PROGRESS`, `COMPLETE`) to the browser and turns the final
result into a consistent product schema. Your API key stays on the server.

Each run uses TinyFish credits. Please respect Flipkart's Terms of Use and scrape responsibly.
# tiny-fish
