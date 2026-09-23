# PocketVision AI — Candle Streak Scanner

Detects 7+ consecutive red/green 1-minute candles on Pocket Option pairs and sends Telegram alerts.
**Analysis and alerts only — this tool never places trades.**

Built in phases (per the developer brief). We are currently on **Phase 1**.

---

## Phase 1 — Feed-discovery spike ⬅ *you are here*

**Goal:** answer one question before anything else is built — does the Pocket Option feed
expose **all pairs at once**, or **only the currently-selected pair**? The whole design
(multi-pair scan vs. asset-cycling fallback) depends on the answer.

### Setup

```bash
npm install
npx playwright install chromium   # one-time browser download
cp .env.example .env              # adjust PO_BASE_URL if your region differs
```

### Run

```bash
# 1. Log in ONCE (headed browser, persistent profile). Your password is typed into
#    Pocket Option only — never read or stored here. The logged-in session is kept
#    in .auth/chrome-profile/ (gitignored) and reused by every later run.
npm run login

# 2. Record the feed. Keep ONE pair selected — do not switch assets during the run.
#    No re-login needed; it reuses the profile from step 1.
npm run spike

# 3. (optional) Re-analyze a saved capture without reopening the browser.
npm run analyze -- logs/frames-<timestamp>.jsonl

# 4. Multi-subscribe probe — decides Phase 3 architecture. Injects extra `subfor`
#    subscriptions on the live market socket and checks if one connection can
#    stream many pairs. Run while OTC markets are active.
npm run probe
```

### What you get
- `logs/frames-<ts>.jsonl` — every WebSocket text frame, **redacted** (tokens/keys/cookies/sessions masked).
- `diagnostics/spike-<ts>.json` — per-event stats, distinct symbols, samples, and a verdict.
- A console summary ending in **`VERDICT: ALL-PAIRS | SELECTED-ONLY | INCONCLUSIVE`**.

That verdict decides Phase 3's shape. We build nothing past this until it's answered.

### Phase 1 result (2026-07-02): **SELECTED-ONLY**
- Live candle stream (`updateStream`) delivers only the subscribed pair.
- A catalog of ~207 pairs is available via `updateAssets` (watchlist source).
- Sockets: `wss://api-*.po.market/socket.io/` (Socket.IO v4); the market feed uses **binary** events.
- **Open sub-question:** does one socket accept many simultaneous `subfor` subscriptions? Probe decides multi-pair-on-one-session vs. asset-cycling.

---

## Phase 2 — one pair, end-to-end ⬅ *in progress*

Ticks → 1-min candles → streak engine → Telegram alert, for the selected pair.

```bash
# Deterministic core tests (no browser/network): candle building + streak logic.
npm run test:core

# Live single-pair scan: reuses your session, seeds from history, prints closed
# candles + running streak, and (if configured) sends Telegram alerts.
npm run scan:one

# Verify Telegram credentials by sending one test alert.
npm run test:telegram
```

Telegram config (in `.env`, gitignored):
```
TELEGRAM_BOT_TOKEN=...   # from BotFather
TELEGRAM_CHAT_ID=...     # your user/group/channel id
STREAK_THRESHOLD=7       # optional overrides
BREAK_ON_DOJI=true
```

**Feed shape:** `updateStream` is a tick feed (`[symbol, epochSec, price]`), so candles are built locally (`src/scanner/candles.ts`); the open convention (first-tick vs previous-close) is validated against the live PO chart.

## Phase 3 — multi-pair scan ⬅ *in progress*

Verified: PO allows **parallel connections on one session**, **one active pair per connection**
(`changeSymbol` is the stream trigger; the auth frame is reusable). So the scanner opens one
Socket.IO connection per watchlist pair, all feeding the same candle/streak engine.

```bash
npm run probe:multiconn   # the spike that proved this (diagnostic)
npm run scan              # the multi-pair scanner
```

Config (`.env`): `WATCHLIST=auto` (all open assets across every class — currencies, crypto,
commodities, stocks, indices — with payout ≥ `MIN_PAYOUT`, best payout first) or a comma list;
`MIN_PAYOUT=87` sets the payout floor; `MAX_PAIRS=40` caps parallel connections. Alerts for a
pair whose payout drops below the floor mid-session are suppressed. Each connection
auto-reconnects; gaps reset that pair's streak so non-consecutive candles are never treated
as consecutive.

Hardening (all tunable in `.env`):
- **Body-size filter** (`MIN_BODY_PCT=10`): a candle only counts as green/red if its body is
  ≥ that % of the asset's average range (rolling 20 candles) — micro-bodies are dojis and
  break streaks, killing the noisiest false signals.
- **Watchdog + heartbeat** (`STALE_FEED_SEC`, `HEARTBEAT_MIN`): no ticks for 60 s → Telegram
  warning + automatic page reload/reconnect (and a "recovered" message); an hourly 💓 ping
  proves the bot is alive, so silence always means "no signals", never "bot died".
- **Outcome tracking**: every alert's next candle is scored reversal/continuation/doji and
  appended to `logs/outcomes.jsonl`; `npm run report` breaks win rates down by asset, streak
  length, and hour — the evidence for whether (and where) the signal is profitable.
- **Dynamic watchlist** (`WATCHLIST_REFRESH_MIN=10`): the watchlist is rebuilt from live
  payouts/market hours during the session — pairs that drop below the floor are disconnected,
  newly eligible ones are added.

## Phase 4 — Supabase + 24/7 VPS

The scanner persists every alert, outcome, and heartbeat to Supabase when
`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set in `.env` (run
`supabase/schema.sql` once in the Supabase SQL Editor first; RLS is on and only
the service key can write). Telegram stays the instant-alert path — Supabase is
the durable, queryable history behind it.

For always-on remote operation see **[docs/VPS-WINDOWS.md](docs/VPS-WINDOWS.md)**
(Windows Server: one-file bundle via `deploy/make-bundle.ps1`, one-shot installer
`deploy/vps-setup-windows.ps1`, scheduled task + auto-logon) or
**[docs/VPS.md](docs/VPS.md)** (Ubuntu: systemd unit under xvfb). Either way you
get crash-restart, reboot-start, watchdog recovery, and hourly heartbeats; the
scanner shuts down cleanly on SIGTERM (drains Telegram, closes the browser).

## Phase 5 — shadow research log ⬅ *in progress*

Stage 1 of the auto-trading track. **Places no trades.** It records every streak
setup with a full feature vector and scores it against the instrument that is
actually traded, so strategy questions stop being arguments and become columns.

```bash
npm run scan            # shadow logging runs alongside the scanner
npm run report:shadow   # analyse logs/shadow.jsonl
npm run report:shadow -- logs/archived.jsonl   # or an archived copy
```

**Why it exists:** `logs/outcomes.jsonl` scores `close(next) vs open(next)` — a
candle-aligned bet. Pocket Option's Quick High/Low is a **60-second ROLLING**
option: struck at the click, expiring exactly 60s later, straddling the candle
boundary. The two only agree when the click lands on the candle open. Every
setup is therefore settled at several entry offsets (`0,2,5,10,15,30s`) from
buffered ticks, which is what makes *"how many seconds in should I click?"*
answerable.

Recorded per setup (`src/scanner/features.ts`, no lookahead — every field is
knowable at decision time): overextension (displacement ÷ **pre-streak** ATR),
path length and efficiency, body contraction and trend, rejection/push wicks,
volatility percentile, position in range, concurrent streaks across the
watchlist, tick counts, payout and its break-even, true-UTC session.

Collection threshold (`SHADOW_COLLECT_STREAK=4`) is deliberately **below** the
alert threshold — base rates at short streaks are the only way to tell whether
depth does anything. Log wide, trade narrow.

### Feed clock (fixed here)

Pocket Option's tick timestamps run on broker server time, measured at a flat
**+7200s (UTC+2)** across every capture. Candle bucketing was immune, so it went
unnoticed — but it silently broke three things, now fixed by `src/lib/clock.ts`
(which *measures* the offset live rather than hardcoding it, so it follows DST):

- the **alert freshness gate** compared feed time to `Date.now()` and so read as
  ~2h in the future — it never suppressed anything, and startup backfill has
  been firing alerts for candles that closed up to 10 minutes earlier;
- `CandleBuilder.flush()` needed two hours of wall clock to fire, so the
  safety-net close for a dropped pair never ran;
- every timestamp in Telegram/Supabase/reports was 2h out, which shifted the
  by-hour analysis into the wrong session.

The offset is quantized to whole minutes (real timezone offsets always are) so
candle buckets stay aligned with Pocket Option's own, and latched so it cannot
drift under the streak engine.

## Stage 2 — auto-execution ⬅ *built, ships disabled*

Places trades on the **demo** account. Both switches default off, and enabling
the first one still leaves the second on, so the first thing you get is a full
rehearsal that clicks nothing.

```bash
npm run probe:ui        # verify the trade-panel selectors resolve. Places nothing.
npm run scan            # with EXECUTE_ENABLED=true (+ EXECUTE_DRY_RUN=true first)
npm run report:trades   # fill quality, tick-vs-broker, results
```

**Entry rule:** fire when a streak reaches `EXECUTE_STREAK` (8) — the candle
that just closed is number 8, so *now* is candle 9's open — and **fade** it:
red streak → BUY, green streak → SELL.

### The arming constraint

Pocket Option's trade panel trades whatever asset the **chart** is showing, and
switching assets takes seconds. The signal fires at a candle close and the entry
is the next candle's open, so reacting to a signal by switching assets is
structurally impossible. The executor therefore **pre-arms**: at
`EXECUTE_STREAK − EXECUTE_ARM_MARGIN` it selects the hottest candidate on the
chart, leaving only the click. One armed pair at a time — which enforces the
concurrency limit for free. A second pair completing while another is armed is
journaled as `missed`, never silently dropped.

### Guardrails (`src/exec/guards.ts`)

A pure function over explicit state, so every rule is proved in `npm run test:core`.
Evaluated in order, cheapest and most absolute first:

| Gate | Behaviour |
|---|---|
| `EXECUTE_ENABLED=false` | never clicks |
| `logs/HALT` exists | stops immediately — checked before every click |
| already halted | blocked until the UTC day rolls |
| **not a demo account** | refuses **and halts**; needs `PV_ALLOW_LIVE=I_UNDERSTAND_REAL_MONEY` |
| daily drawdown ≥ 5% | halts the day |
| 3 consecutive losses | halts the day |
| trades/day, concurrency, cooldown, payout floor | blocks this trade |
| sizing (last) | flat % of *current* balance, hard cap |

The demo check is a **fact read from the live page** (URL *and* balance label,
both required, unreadable → not demo), re-verified on every fire — never a
config flag, because a config flag is what gets flipped at 2am. There is **no
martingale path in the code**: stake is always a flat percentage of the current
balance, so it shrinks in drawdown. At a 55% win rate a six-loss run arrives
every 60–100 trades, and recovering one unit after six martingale steps costs 63.

### Trade journal (`logs/trades.jsonl`)

Records `placed` / `dry-run` / `refused` / `missed` — a journal of only the
trades you took is a survivorship-biased record of your own reflexes. Every
settled trade is scored **twice**: from the tick feed (strike vs expiry price)
and from the observed **balance delta** (the broker's verdict). Disagreement is
the most valuable column in the file — it is slippage, a rejected click, or a
strike that did not land where the feed said. Believe the balance.

> ⚠ The trade-panel selectors in `src/exec/terminal.ts` are best-effort against a
> hashed-class React SPA. **Run `npm run probe:ui` before enabling execution**
> and after any Pocket Option redesign. Every selector is overridable via
> `PO_SEL_*` env vars, and every method reports failure rather than clicking
> blind — a mis-resolved `setAmount` would otherwise trade whatever stake
> happened to be in the box.

## Roadmap
- **Stage 3** — adaptive allocation: Thompson sampling over setup buckets
  (asset class × depth × overextension × session) rather than price prediction.
  Beta posteriors stay honest about small samples and decay gracefully when the
  broker changes their generator.
- **Phase 6** — access: login-protected realtime dashboard (anon key + read
  policies), CSV export.

## Security notes (from the brief, section 10)
- Pocket Option password is **never** stored — you log in by hand; only cookies/localStorage are saved locally.
- Debug/spike output is **redacted** for tokens, keys, cookies, and session ids.
- Credentials (Telegram/Supabase) will live in env vars, never hardcoded.
- Supabase **service role key** will live only on the VPS scanner — never shipped to the browser.
- `.auth/`, `logs/`, `diagnostics/`, and `.env` are all gitignored.
#   w a s s w a - s  
 