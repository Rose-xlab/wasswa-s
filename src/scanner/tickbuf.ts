/**
 * Per-symbol tick ring buffer — the raw material for settlement simulation.
 *
 * WHY THIS EXISTS: the trade actually placed on Pocket Option is a 60-SECOND
 * ROLLING option. The strike is the price at the moment of the click and it
 * settles 60s later, so it straddles candle boundaries. logs/outcomes.jsonl
 * scores `close(next) vs open(next)` — a candle-aligned bet nobody is placing.
 * To score the real instrument you need the price at arbitrary instants, which
 * means keeping ticks, not candles.
 *
 * Fed from scan-all's `ingest`, so timestamps are already normalized to true
 * epoch (see lib/clock.ts) and already de-duplicated by the per-symbol
 * watermark — which means what lands here is strictly increasing. Rotation
 * gaps self-heal: the next visit's `updateHistoryNewFast` backfill replays the
 * minutes we missed, and everything past the watermark is appended in order.
 *
 * `priceAt` returns the last tick AT OR BEFORE the instant, which is how a
 * broker strikes an option — never interpolated, never a future tick.
 */

export interface StoredTick {
  /** True epoch seconds. */
  ts: number;
  price: number;
}

export class TickBuffer {
  private readonly buf = new Map<string, StoredTick[]>();

  /** @param retainSec how much history to keep per symbol. */
  constructor(private readonly retainSec = 1200) {}

  /** Append a tick. Callers must supply strictly increasing ts per symbol. */
  push(symbol: string, ts: number, price: number): void {
    let a = this.buf.get(symbol);
    if (!a) { a = []; this.buf.set(symbol, a); }
    // Defensive: keep the array sorted even if a caller ever feeds out of order.
    if (a.length > 0 && ts <= a[a.length - 1]!.ts) {
      if (ts === a[a.length - 1]!.ts) return;
      const at = this.upperBound(a, ts);
      a.splice(at, 0, { ts, price });
    } else {
      a.push({ ts, price });
    }
    const cutoff = a[a.length - 1]!.ts - this.retainSec;
    let drop = 0;
    while (drop < a.length && a[drop]!.ts < cutoff) drop++;
    if (drop > 0) a.splice(0, drop);
  }

  /** Index of the first element with ts > target. */
  private upperBound(a: readonly StoredTick[], target: number): number {
    let lo = 0, hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid]!.ts <= target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Last price at or before `ts` — the broker's strike rule. Null if none. */
  priceAt(symbol: string, ts: number): number | null {
    const a = this.buf.get(symbol);
    if (!a || a.length === 0) return null;
    const i = this.upperBound(a, ts) - 1;
    return i >= 0 ? a[i]!.price : null;
  }

  /** Ticks in [from, to] inclusive. */
  range(symbol: string, from: number, to: number): StoredTick[] {
    const a = this.buf.get(symbol);
    if (!a) return [];
    const start = this.upperBound(a, from - 1e-9);
    const end = this.upperBound(a, to);
    return a.slice(start, end);
  }

  /**
   * True when the window [from, to] can be settled honestly: a tick at or
   * before `from` (so the strike is real, not extrapolated) AND a tick at or
   * after `to` (so we know the feed had actually reached the expiry instant —
   * otherwise a quiet pair looks identical to a pair we simply stopped
   * watching, and we would score a fill that never happened).
   */
  covers(symbol: string, from: number, to: number): boolean {
    const a = this.buf.get(symbol);
    if (!a || a.length === 0) return false;
    return a[0]!.ts <= from && a[a.length - 1]!.ts >= to;
  }

  /** Newest tick timestamp for a symbol, or null. */
  newest(symbol: string): number | null {
    const a = this.buf.get(symbol);
    return a && a.length > 0 ? a[a.length - 1]!.ts : null;
  }

  /** Total ticks held, for status lines. */
  size(): number {
    let n = 0;
    for (const a of this.buf.values()) n += a.length;
    return n;
  }

  /** Drop a symbol entirely (left the watchlist). */
  forget(symbol: string): void {
    this.buf.delete(symbol);
  }
}
