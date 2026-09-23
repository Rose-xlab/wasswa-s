import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo root (one level up from src/). */
export const ROOT = path.resolve(__dirname, '..');

export const paths = {
  /** Persistent Chrome profile (cookies/localStorage/etc.) — log in once, reuse. Gitignored. */
  chromeProfile: path.join(ROOT, '.auth', 'chrome-profile'),
  authDir: path.join(ROOT, '.auth'),
  /** Raw (redacted) WebSocket frame captures from the spike. */
  logsDir: path.join(ROOT, 'logs'),
  /** Human-readable spike summaries / diagnostic reports. */
  diagnosticsDir: path.join(ROOT, 'diagnostics'),
  /** Alert outcome log (JSONL, one record per resolved alert). */
  outcomesFile: path.join(ROOT, 'logs', 'outcomes.jsonl'),
  /** Shadow research log (JSONL: features + rolling-expiry settlements). */
  shadowFile: path.join(ROOT, 'logs', 'shadow.jsonl'),
  /** Raw candle log (JSONL: every closed candle) — the primitive every
   *  candle-based hypothesis is replayed from, including multi-leg waves. */
  candlesFile: path.join(ROOT, 'logs', 'candles.jsonl'),
  /** Trade journal (JSONL: every placed / dry-run / refused / missed trade). */
  journalFile: path.join(ROOT, 'logs', 'trades.jsonl'),
  /** Create this file to stop execution immediately. */
  killSwitchFile: path.join(ROOT, 'logs', 'HALT'),
};

export const config = {
  poBaseUrl: process.env.PO_BASE_URL ?? 'https://pocketoption.com/en/login',
  poCabinetUrl: process.env.PO_CABINET_URL ?? 'https://pocketoption.com/en/cabinet',
  headless: (process.env.HEADLESS ?? 'false').toLowerCase() === 'true',
  spikeDurationMs: Number(process.env.SPIKE_DURATION_MS ?? 180_000),

  // ── Streak detection ──
  streakThreshold: Number(process.env.STREAK_THRESHOLD ?? 7),
  timeframeSec: Number(process.env.TIMEFRAME_SEC ?? 60),
  graceSec: Number(process.env.GRACE_SEC ?? 1.5),
  breakOnDoji: (process.env.BREAK_ON_DOJI ?? 'true').toLowerCase() === 'true',
  /** Min candle body as % of the asset's recent avg range to count as green/red (0 = off). */
  minBodyPct: Number(process.env.MIN_BODY_PCT ?? 10),

  // ── Telegram ──
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? '',
    chatId: process.env.TELEGRAM_CHAT_ID ?? '',
  },

  // ── Supabase (Phase 4 persistence; service key = VPS scanner ONLY) ──
  supabase: {
    url: (process.env.SUPABASE_URL ?? '').replace(/\/+$/, ''),
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  },

  // ── Multi-pair scan (Phase 3) ──
  /** 'auto' = all open OTC pairs (capped by maxPairs), or a comma list of symbols. */
  watchlist: process.env.WATCHLIST ?? 'auto',
  /** Safety cap on the watchlist size (rotation makes this cheap — not a socket count). */
  maxPairs: Number(process.env.MAX_PAIRS ?? 60),
  /** Only auto-track assets whose payout (%) is at least this. */
  minPayout: Number(process.env.MIN_PAYOUT ?? 87),
  /** Persistent socket pool size — stay under PO's per-IP ceiling (~8 observed). */
  feedPool: Number(process.env.FEED_POOL ?? 6),
  /** Seconds each rotating socket dwells on a pair before moving on. */
  dwellSec: Number(process.env.DWELL_SEC ?? 12),
  /** Pin a pair to a live socket when its streak reaches threshold − this.
   *  Larger margin = earlier pinning = a slower sweep stays safe. */
  pinMargin: Number(process.env.PIN_MARGIN ?? 2),

  // ── Reliability (Phase 3 hardening) ──
  /** No ticks for this many seconds → feed is stale: warn + auto-recover. */
  staleFeedSec: Number(process.env.STALE_FEED_SEC ?? 60),
  /** Telegram "I'm alive" heartbeat interval, minutes (0 = off). */
  heartbeatMin: Number(process.env.HEARTBEAT_MIN ?? 60),
  /** Rebuild the auto-watchlist this often, minutes (0 = off). */
  watchlistRefreshMin: Number(process.env.WATCHLIST_REFRESH_MIN ?? 10),

  // ── Shadow research log (Stage 1 of auto-trading: record, never trade) ──
  shadow: {
    enabled: (process.env.SHADOW_ENABLED ?? 'true').toLowerCase() === 'true',
    /** Log every streak this long or longer — deliberately below the alert
     *  threshold, so the base rates at short streaks are captured too. */
    collectStreak: Number(process.env.SHADOW_COLLECT_STREAK ?? 4),
    /** Click offsets (sec after the entry candle's open) to score. */
    offsets: (process.env.SHADOW_ENTRY_OFFSETS ?? '0,2,5,10,15,30')
      .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0),
    /** Option life — the terminal's "Time" field (Quick High/Low default 60s). */
    expirySec: Number(process.env.SHADOW_EXPIRY_SEC ?? 60),
    /** Stop waiting for settlement ticks after this long. */
    resolveTimeoutSec: Number(process.env.SHADOW_RESOLVE_TIMEOUT_SEC ?? 600),
  },
  /** Per-symbol tick retention, seconds — must exceed a full sweep + expiry. */
  tickRetainSec: Number(process.env.TICK_RETAIN_SEC ?? 1200),
  /** Log every closed candle to logs/candles.jsonl (~6 MB/day). Lets any new
   *  candle hypothesis be replayed offline instead of collected overnight. */
  candleLog: (process.env.CANDLE_LOG ?? 'true').toLowerCase() === 'true',

  // ── Stage 2: auto-execution (DEMO ONLY unless PV_ALLOW_LIVE is set) ──
  // Both switches default OFF. Turning EXECUTE_ENABLED on still leaves DRY_RUN
  // on, so the first thing you get is a full rehearsal that clicks nothing.
  exec: {
    enabled: (process.env.EXECUTE_ENABLED ?? 'false').toLowerCase() === 'true',
    dryRun: (process.env.EXECUTE_DRY_RUN ?? 'true').toLowerCase() === 'true',
    /**
     * Which side to take.
     *   'fade' — bet the streak breaks (red → BUY, green → SELL). The original
     *            strategy; measured at 33% reversal on 33 live alerts.
     *   'ride' — bet the streak continues (red → SELL, green → BUY).
     * Recorded on every journal row, so mixed-mode data stays readable.
     */
    direction: (process.env.EXECUTE_DIRECTION ?? 'fade').toLowerCase() === 'ride' ? 'ride' as const : 'fade' as const,
    /** Streak length that triggers entry — 8 means "enter on candle 9". */
    executeStreak: Number(process.env.EXECUTE_STREAK ?? 8),
    /** Pre-select the chart this many candles before the trigger. */
    armMargin: Number(process.env.EXECUTE_ARM_MARGIN ?? 2),
    /** Flat cash stake; when > 0 it overrides the percentage. */
    stakeFixed: Number(process.env.EXECUTE_STAKE_FIXED ?? 0),
    stakePct: Number(process.env.EXECUTE_STAKE_PCT ?? 1),
    maxStake: Number(process.env.EXECUTE_MAX_STAKE ?? 1000),
    minStake: Number(process.env.EXECUTE_MIN_STAKE ?? 1),
    minPayout: Number(process.env.EXECUTE_MIN_PAYOUT ?? 90),
    maxConcurrent: Number(process.env.EXECUTE_MAX_CONCURRENT ?? 1),
    maxTradesPerDay: Number(process.env.EXECUTE_MAX_TRADES_PER_DAY ?? 30),
    maxConsecutiveLosses: Number(process.env.EXECUTE_MAX_CONSEC_LOSSES ?? 3),
    dailyLossPct: Number(process.env.EXECUTE_DAILY_LOSS_PCT ?? 5),
    cooldownSec: Number(process.env.EXECUTE_COOLDOWN_SEC ?? 30),
  },
};
