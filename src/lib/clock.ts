/**
 * Feed clock calibration.
 *
 * Pocket Option's tick timestamps are NOT epoch UTC — they run on the broker's
 * server timezone. Measured across every capture in logs/outcomes.jsonl the
 * offset is a flat +7200s (UTC+2), stable within ±2s on all four sessions.
 *
 * Nothing looked broken, because candle bucketing is immune to a whole-minute
 * shift. Three things broke silently:
 *
 *   • the alert freshness gate (scan-all) compares a feed timestamp against
 *     Date.now(), so it read as ~7200s IN THE FUTURE and never suppressed a
 *     single stale alert — startup backfill has been alerting all along;
 *   • CandleBuilder.flush() needed two hours of wall clock to fire, so the
 *     safety-net close for a dropped pair never ran;
 *   • every timestamp in Telegram / Supabase / reports was two hours out, which
 *     silently shifted the whole by-hour analysis into the wrong session.
 *
 * The offset is MEASURED, not hardcoded: it moves with the broker's DST, and a
 * wrong constant is worse than no constant. Only LIVE (`updateStream`) ticks
 * calibrate — they arrive within a second of being generated, so `feedTs - now`
 * IS the offset. History-backfill ticks are minutes old and would drag the
 * estimate down; they are a fallback only (taking the NEWEST sample, which is
 * the one closest to live).
 *
 * Two deliberate choices:
 *
 *   • QUANTIZED to whole minutes. Real timezone offsets are always a multiple
 *     of 15 minutes, and network latency makes the raw estimate a second or two
 *     short. Subtracting a raw 7198 would shift every candle boundary by two
 *     seconds and silently desync our candles from Pocket Option's own.
 *   • LATCHED once calibrated. A moving offset would shift periodStart under
 *     the streak engine and trip gap-detection on every symbol. It re-latches
 *     only on a sustained change of a minute or more — i.e. a real DST flip.
 */

const QUANTUM_SEC = 60;
/** Live samples kept for the median. */
const LIVE_WINDOW = 60;
/** Live samples needed before the estimate is trusted. */
const MIN_LIVE = 8;
/** After this long, calibrate from whatever we have rather than stalling. */
const FALLBACK_AFTER_MS = 90_000;
/** Sustained disagreement (in checks) before re-latching — DST, not jitter. */
const RELATCH_CHECKS = 10;
/**
 * Minimum move that counts as a re-latch.
 *
 * Every real timezone offset on earth is a multiple of 15 minutes, so a
 * genuine broker DST change is at least 900s. The old threshold of 120s let
 * ordinary feed jitter re-latch the clock: a live session shifted +6960s →
 * +7200s (four minutes — not a timezone), and because a re-latch moves every
 * periodStart it reset every streak on the watchlist mid-session.
 */
const RELATCH_MIN_DELTA = 900;
/**
 * Minimum gap between calibration samples.
 *
 * `updateStream` frames carry MANY ticks at once, and sampling every one let a
 * single burst of stale-timestamped ticks refill the whole window and drag the
 * median with it. One sample per second keeps the window spread across real
 * time, so no single frame can dominate it.
 */
const MIN_SAMPLE_GAP_MS = 1000;

const quantize = (sec: number): number => Math.round(sec / QUANTUM_SEC) * QUANTUM_SEC;

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export class FeedClock {
  private readonly live: number[] = [];
  private backfillNewest = Number.NEGATIVE_INFINITY;
  private backfillCount = 0;
  private readonly startedAt = Date.now();

  private latched: number | null = null;
  private disagreeFor = 0;
  private lastSampleAt = 0;
  /** Queued so two events in the same second cannot silently overwrite one another. */
  private readonly notes: string[] = [];

  /**
   * A live `updateStream` tick — the only high-quality calibration source.
   * Rate-limited: one frame can carry dozens of ticks, and taking all of them
   * lets a single burst refill the median window.
   */
  observeLive(feedTs: number, nowMs = Date.now()): void {
    if (!Number.isFinite(feedTs)) return;
    if (nowMs - this.lastSampleAt < MIN_SAMPLE_GAP_MS) return;
    this.lastSampleAt = nowMs;
    this.live.push(feedTs - nowMs / 1000);
    if (this.live.length > LIVE_WINDOW) this.live.shift();
    this.reconcile();
  }

  /** A history-backfill tick — minutes stale, fallback only. */
  observeBackfill(feedTs: number, nowMs = Date.now()): void {
    if (!Number.isFinite(feedTs)) return;
    this.backfillCount++;
    this.backfillNewest = Math.max(this.backfillNewest, feedTs - nowMs / 1000);
  }

  /** Best raw (unquantized) estimate from the samples we have, or null. */
  private estimate(): number | null {
    if (this.live.length > 0) return median(this.live);
    if (this.backfillCount > 0) return this.backfillNewest;
    return null;
  }

  /** Latch on first confidence; re-latch only on a sustained, large change. */
  private reconcile(): void {
    const raw = this.estimate();
    if (raw === null) return;
    const q = quantize(raw);

    if (this.latched === null) {
      if (this.live.length >= MIN_LIVE || Date.now() - this.startedAt > FALLBACK_AFTER_MS) {
        this.latched = q;
        this.notes.push(`feed clock calibrated: ${this.describe()}`);
      }
      return;
    }

    if (Math.abs(q - this.latched) >= RELATCH_MIN_DELTA) {
      if (++this.disagreeFor >= RELATCH_CHECKS) {
        const from = this.latched;
        this.latched = q;
        this.disagreeFor = 0;
        this.notes.push(`feed clock SHIFTED ${from >= 0 ? '+' : ''}${from}s → ${q >= 0 ? '+' : ''}${q}s (broker DST?) — streaks will reset once`);
      }
    } else {
      this.disagreeFor = 0;
    }
  }

  /**
   * True once an offset is latched. Ticks observed before this should be
   * DROPPED, not ingested with a guessed offset: feeding raw timestamps and
   * then switching would jump every periodStart by ~2h and reset every streak.
   */
  get ready(): boolean {
    if (this.latched === null) this.reconcile(); // time-based fallback needs a poke
    return this.latched !== null;
  }

  /** Feed seconds ahead of true epoch (0 until calibrated). */
  get offsetSec(): number {
    return this.latched ?? 0;
  }

  /** Convert a feed timestamp to true epoch seconds. */
  toReal(feedTs: number): number {
    return feedTs - this.offsetSec;
  }

  /** Convert true epoch seconds back to feed time (for chart cross-checks). */
  toFeed(realTs: number): number {
    return realTs + this.offsetSec;
  }

  /** One-shot log line when the offset latches or shifts; null otherwise. */
  takeNote(): string | null {
    return this.notes.shift() ?? null;
  }

  describe(): string {
    const off = this.offsetSec;
    const src = this.live.length > 0 ? `${this.live.length} live samples` : `${this.backfillCount} backfill samples`;
    const hrs = off / 3600;
    const tz = Number.isInteger(hrs) ? `UTC${hrs >= 0 ? '+' : ''}${hrs}` : `${off}s`;
    return `${off >= 0 ? '+' : ''}${off}s (${tz}) from ${src}`;
  }
}
