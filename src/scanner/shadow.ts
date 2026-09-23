/**
 * Shadow recorder — Stage 1 of the auto-trading build.
 *
 * Places NOTHING. Records every streak setup with its full feature vector and
 * then scores it two ways:
 *
 *   1. CANDLE-ALIGNED   — `close(next) vs open(next)`. What logs/outcomes.jsonl
 *      has always measured, kept for continuity with the existing history.
 *
 *   2. ROLLING 60s      — strike = price at (entry + offset), settle = price
 *      60s later. THIS is the instrument actually being traded on Pocket
 *      Option's Quick High/Low: the terminal shows `Time 00:01:00` with a
 *      rolling `Expiration time`, so the option is struck at the click and
 *      expires exactly 60s after it — straddling the candle boundary. The two
 *      scores only agree when the click lands on the candle open.
 *
 * The rolling score is computed at SEVERAL entry offsets in the same pass, so
 * "how many seconds into the entry candle should I click?" stops being an
 * argument and becomes a column you can sort. That single question is the one
 * thing the existing log could never answer, and it is the difference between
 * the ~50% the candle-aligned data shows and whatever the real fills produce.
 *
 * Direction convention: the recorded trade is the FADE — a red streak buys, a
 * green streak sells, matching how these alerts are actually traded. The ride
 * side is the exact complement (minus ties), so nothing is lost by recording
 * one direction.
 *
 * Collection threshold is deliberately LOWER than the trading threshold. You
 * cannot learn where a streak effect starts by only sampling streaks that
 * already reached 8 — you need the base rates at 4, 5, 6 to know whether depth
 * does anything at all. Log wide, trade narrow.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from './candles.js';
import { colourOf } from './streaks.js';
import type { SetupFeatures } from './features.js';
import type { TickBuffer } from './tickbuf.js';

export interface Settlement {
  /** Seconds after the entry candle's open that the click lands. */
  offsetSec: number;
  strike: number;
  settle: number;
  /** Outcome of the FADE trade: red streak → buy, green streak → sell. */
  result: 'win' | 'loss' | 'tie';
  /** Best/worst excursion inside the option's life, in price units, fade-signed. */
  mfe: number;
  mae: number;
}

export interface ShadowRecord {
  /** 2 = pendings keyed per entry candle. v1 records are SURVIVORSHIP-BIASED
   *  (see register()) and must be excluded from analysis. */
  v: 2;
  at: string;
  /** True epoch of the entry candle's open — the earliest possible click. */
  entryTs: number;
  expirySec: number;
  features: SetupFeatures;
  /** Candle-aligned score, for continuity with logs/outcomes.jsonl. */
  candle?: {
    outcome: 'reversal' | 'continuation' | 'doji';
    open: number; high: number; low: number; close: number;
  };
  /** Rolling-expiry scores, one per entry offset. Empty when tick data was short. */
  settlements: Settlement[];
  /** 'full' = every offset settled, 'partial' = some, 'none' = tick data missing. */
  coverage: 'full' | 'partial' | 'none';
}

export interface ShadowConfig {
  /** Log every streak at or above this length (well below the trade threshold). */
  collectStreak: number;
  /** Entry offsets to score, in seconds after the entry candle's open. */
  offsets: number[];
  /** Option life in seconds (Quick High/Low "Time" field). */
  expirySec: number;
  /** Give up waiting for ticks after this long and emit what we have. */
  resolveTimeoutSec: number;
}

export const DEFAULT_SHADOW: ShadowConfig = {
  collectStreak: 4,
  offsets: [0, 2, 5, 10, 15, 30],
  expirySec: 60,
  resolveTimeoutSec: 600,
};

interface Pending {
  features: SetupFeatures;
  entryTs: number;
  /** periodStart the candle-aligned resolver expects. */
  expectedPeriod: number;
  candle?: ShadowRecord['candle'];
}

export class ShadowRecorder {
  private readonly pending = new Map<string, Pending>();
  private readonly cfg: ShadowConfig;
  private written = 0;
  private noCoverage = 0;

  constructor(
    private readonly ticks: TickBuffer,
    private readonly file?: string,
    cfg: Partial<ShadowConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_SHADOW, ...cfg };
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  get config(): Readonly<ShadowConfig> { return this.cfg; }

  /**
   * Register a setup observed at the close of `lastCandle`.
   *
   * Entry is the OPEN of the following candle — a setup seen at streak N is a
   * trade on candle N+1.
   *
   * KEYED PER ENTRY CANDLE, not per symbol. v1 keyed by symbol alone, and that
   * was a survivorship filter disguised as a data pipeline: settlement needs
   * ~90s of ticks but the next candle arrives in 60s, so a streak running
   * 4 → 5 → 6 had its streak-4 pending overwritten before it could resolve.
   * The only streak-N setups that survived to be written were the ones where
   * the streak ENDED at N — which guarantees the next candle is a reversal.
   * The resulting log showed a 90% win rate that was pure selection effect.
   *
   * Each streak length now resolves independently, so a streak that continued
   * is recorded as the loss it was.
   */
  register(features: SetupFeatures, lastCandle: Candle): void {
    if (features.streak < this.cfg.collectStreak) return;
    const entryTs = lastCandle.periodStart + lastCandle.timeframeSec;
    this.pending.set(`${features.symbol}@${entryTs}`, { features, entryTs, expectedPeriod: entryTs });
  }

  /**
   * Feed every closed candle. Attaches the candle-aligned score when the entry
   * candle itself closes; does NOT emit the record — the rolling settlement
   * needs ticks up to (entry + maxOffset + expiry), which arrive later.
   */
  onCandle(candle: Candle): void {
    // Several pendings can share a symbol now (one per entry candle), so match
    // on the entry period rather than taking "the" pending for the symbol.
    const p = this.pending.get(`${candle.symbol}@${candle.periodStart}`);
    if (!p || p.candle) return;
    const raw = colourOf(candle); // raw colour: how a binary actually pays
    p.candle = {
      outcome: raw === 'doji' ? 'doji' : raw === p.features.colour ? 'continuation' : 'reversal',
      open: candle.open, high: candle.high, low: candle.low, close: candle.close,
    };
  }

  /**
   * Resolve whatever is ready. Call on a timer with true epoch seconds.
   * Returns the records emitted so the caller can log/forward them.
   *
   * The give-up clock runs on DATA time, not wall time: what matters is how
   * far past the entry the feed has advanced, not how long this process has
   * been alive. That keeps the recorder deterministic (and testable) and
   * behaves correctly when a backfill replays several minutes at once.
   */
  sweep(nowSec: number): ShadowRecord[] {
    const out: ShadowRecord[] = [];
    const maxOffset = Math.max(...this.cfg.offsets);
    for (const [key, p] of [...this.pending]) {
      const symbol = p.features.symbol;
      const needThrough = p.entryTs + maxOffset + this.cfg.expirySec;
      const covered = this.ticks.covers(symbol, p.entryTs, needThrough);
      const timedOut = nowSec - p.entryTs > this.cfg.resolveTimeoutSec;
      if (!covered && !timedOut) continue;

      this.pending.delete(key);
      const settlements = this.settle(symbol, p);
      const coverage: ShadowRecord['coverage'] =
        settlements.length === this.cfg.offsets.length ? 'full'
        : settlements.length > 0 ? 'partial'
        : 'none';
      if (coverage === 'none') this.noCoverage++;

      const rec: ShadowRecord = {
        v: 2,
        at: new Date().toISOString(),
        entryTs: p.entryTs,
        expirySec: this.cfg.expirySec,
        features: p.features,
        ...(p.candle ? { candle: p.candle } : {}),
        settlements,
        coverage,
      };
      if (this.file) fs.appendFileSync(this.file, `${JSON.stringify(rec)}\n`);
      this.written++;
      out.push(rec);
    }
    return out;
  }

  /** Score the fade trade at each configured entry offset. */
  private settle(symbol: string, p: Pending): Settlement[] {
    const out: Settlement[] = [];
    // Fade: a red streak is bought (win if price rises), a green streak sold.
    const dir = p.features.colour === 'red' ? 1 : -1;

    for (const offsetSec of this.cfg.offsets) {
      const t0 = p.entryTs + offsetSec;
      const t1 = t0 + this.cfg.expirySec;
      if (!this.ticks.covers(symbol, t0, t1)) continue;
      const strike = this.ticks.priceAt(symbol, t0);
      const settle = this.ticks.priceAt(symbol, t1);
      if (strike === null || settle === null) continue;

      const move = (settle - strike) * dir;
      let mfe = 0, mae = 0;
      for (const t of this.ticks.range(symbol, t0, t1)) {
        const excursion = (t.price - strike) * dir;
        if (excursion > mfe) mfe = excursion;
        if (excursion < mae) mae = excursion;
      }
      out.push({
        offsetSec,
        strike,
        settle,
        result: move > 0 ? 'win' : move < 0 ? 'loss' : 'tie',
        mfe,
        mae,
      });
    }
    return out;
  }

  /** One-line status for the scanner's status/heartbeat lines. */
  summary(): string {
    return `shadow: ${this.written} recorded, ${this.pending.size} pending${this.noCoverage ? `, ${this.noCoverage} no-tick-coverage` : ''}`;
  }
}
