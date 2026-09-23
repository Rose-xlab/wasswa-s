/**
 * Rolling per-symbol candle history + the volatility primitives the feature
 * vector is built from.
 *
 * The streak engine is deliberately memoryless beyond the current run — it
 * only knows "8 reds". Every question worth asking about a setup ("was that a
 * 3-ATR blow-off or a 0.6-ATR grind?", "are the bodies shrinking?") needs the
 * candles themselves, so we keep them here.
 */
import type { Candle } from './candles.js';

/** Candles retained per symbol (~4h at 1m) — enough for ATR + session range. */
const DEFAULT_KEEP = 240;

export class CandleHistory {
  private readonly bySymbol = new Map<string, Candle[]>();

  constructor(private readonly keep = DEFAULT_KEEP) {}

  push(c: Candle): void {
    let a = this.bySymbol.get(c.symbol);
    if (!a) { a = []; this.bySymbol.set(c.symbol, a); }
    a.push(c);
    if (a.length > this.keep) a.splice(0, a.length - this.keep);
  }

  /** All retained candles, oldest → newest. */
  all(symbol: string): readonly Candle[] {
    return this.bySymbol.get(symbol) ?? [];
  }

  /** The last `n` candles, oldest → newest (may be shorter than n). */
  recent(symbol: string, n: number): readonly Candle[] {
    const a = this.bySymbol.get(symbol) ?? [];
    return n >= a.length ? a : a.slice(a.length - n);
  }

  forget(symbol: string): void {
    this.bySymbol.delete(symbol);
  }
}

export const body = (c: Candle): number => Math.abs(c.close - c.open);
export const range = (c: Candle): number => c.high - c.low;

/** Wick beyond the body in the direction the candle moved (the "push"). */
export function wickWith(c: Candle): number {
  return c.close < c.open ? Math.min(c.open, c.close) - c.low : c.high - Math.max(c.open, c.close);
}

/** Wick beyond the body against the direction (the "rejection"). */
export function wickAgainst(c: Candle): number {
  return c.close < c.open ? c.high - Math.max(c.open, c.close) : Math.min(c.open, c.close) - c.low;
}

/** Wilder's true range. `prev` absent → plain high-low. */
export function trueRange(c: Candle, prev?: Candle): number {
  const hl = c.high - c.low;
  if (!prev) return hl;
  return Math.max(hl, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
}

/**
 * Simple-average true range over the LAST `period` candles of `candles`.
 * Returns null when there is not enough history to be meaningful.
 */
export function atr(candles: readonly Candle[], period = 20): number | null {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    sum += trueRange(candles[i]!, candles[i - 1]);
  }
  return sum / period;
}

/**
 * Where the current ATR sits in its own recent distribution (0–1).
 *
 * "Is this pair unusually volatile right now?" is a different question from
 * "how volatile is it?", and it is the one that generalises across assets —
 * 4 pips of ATR means nothing until you know whether that is calm or wild FOR
 * THIS PAIR. Computed as the rank of the latest ATR among the ATR readings of
 * the last `lookback` candles.
 */
export function atrPercentile(candles: readonly Candle[], period = 20, lookback = 120): number | null {
  const need = period + 1;
  if (candles.length < need + 10) return null;
  const series: number[] = [];
  const from = Math.max(need, candles.length - lookback);
  for (let end = from; end <= candles.length; end++) {
    const v = atr(candles.slice(0, end), period);
    if (v !== null) series.push(v);
  }
  if (series.length < 10) return null;
  const cur = series[series.length - 1]!;
  const below = series.filter((v) => v < cur).length;
  return below / (series.length - 1);
}

/** Position of `price` within the high/low range of `candles` (0 = low, 1 = high). */
export function positionInRange(candles: readonly Candle[], price: number): number | null {
  if (candles.length === 0) return null;
  let hi = -Infinity, lo = Infinity;
  for (const c of candles) { if (c.high > hi) hi = c.high; if (c.low < lo) lo = c.low; }
  const span = hi - lo;
  if (!(span > 0)) return null;
  return (price - lo) / span;
}

export const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
