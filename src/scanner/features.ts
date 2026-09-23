/**
 * Setup feature vector — everything measurable about a streak AT THE MOMENT
 * the decision would be made, and nothing measurable after it.
 *
 * The discipline that matters here is one rule: no lookahead. Every field is
 * computed from candles that had already closed when the entry decision was
 * taken. The label (what happened next) lives in shadow.ts and is never
 * allowed to touch this file. Break that rule once and every backtest you run
 * for the rest of the project is a lie that looks like a discovery.
 *
 * A note on ATR choice: overextension is measured against `atrPre` — the ATR
 * of the 20 candles ending BEFORE the streak began. Using a trailing ATR that
 * includes the streak candles would let the move inflate its own denominator,
 * so a violent 9-candle run and a sleepy one would score alike. The pre-streak
 * ATR is what the pair "normally" does, which is the only baseline that makes
 * displacement mean anything.
 */
import type { Candle } from './candles.js';
import {
  atr, atrPercentile, body, mean, positionInRange, range, trueRange, wickAgainst, wickWith,
} from './history.js';

export interface SetupFeatures {
  // ── identity / instrument ──
  symbol: string;
  label?: string;
  assetType?: string;
  otc: boolean;
  payout?: number;
  /** Win rate this trade must beat to break even: 100/(100+payout). */
  breakEvenPct?: number;

  // ── the streak itself ──
  streak: number;
  colour: 'green' | 'red';
  /** periodStart (true epoch) of the streak's final candle. */
  lastPeriodStart: number;

  // ── overextension: is this a blow-off or a grind? ──
  /** ATR(20) of the candles ending just BEFORE the streak started. */
  atrPre: number | null;
  /** |close(last) − open(first)| of the streak. */
  displacement: number;
  /** displacement / atrPre — the headline overextension number. */
  overextension: number | null;
  /** Sum of all streak candle ranges / atrPre (path length, not net move). */
  pathLength: number | null;
  /** Net move as a fraction of the ground actually covered (1 = straight line). */
  efficiency: number | null;

  // ── exhaustion: is momentum dying into the entry? ──
  /** body(last) / mean(body of all streak candles). <1 = fading. */
  bodyContraction: number | null;
  /** mean(last 3 bodies) / mean(first 3 bodies). <1 = decelerating. */
  bodyTrend: number | null;
  /** Wick beyond the body AGAINST the streak on the last candle, as % of range. */
  rejectionWickPct: number | null;
  /** Wick WITH the streak on the last candle, as % of range. */
  pushWickPct: number | null;
  /** range(last candle) / atrPre. */
  lastRangeAtr: number | null;

  // ── regime / context ──
  /** ATR percentile of this pair against its own last 120 candles (0–1). */
  volPercentile: number | null;
  /** Close's position in the last 240 candles' range (0 = low, 1 = high). */
  positionInRange: number | null;
  /** How many OTHER watchlist pairs were mid-streak (≥3) at this instant. */
  concurrentStreaks: number;
  /** Crowd positioning % if available — see shadow.ts, not yet wired. */
  crowdBuyPct?: number;

  // ── liquidity / time ──
  ticksTotal: number;
  ticksLast: number;
  hourUtc: number;
  dayOfWeek: number;
}

export interface FeatureInput {
  symbol: string;
  streak: number;
  colour: 'green' | 'red';
  /** Full retained history, oldest → newest, ENDING with the streak's last candle. */
  history: readonly Candle[];
  meta?: { label?: string; payout?: number; type?: string; otc?: boolean };
  concurrentStreaks: number;
  atrPeriod?: number;
}

const safeDiv = (a: number, b: number | null): number | null =>
  b === null || !(Math.abs(b) > 0) ? null : a / b;

/**
 * Build the vector. Returns null when the streak's own candles are not all
 * present in history (a fresh symbol, or one just re-seeded after a gap) —
 * a partial setup is worse than no setup, because it silently biases the
 * sample toward pairs we happened to have been watching longer.
 */
export function buildFeatures(input: FeatureInput): SetupFeatures | null {
  const { symbol, streak, colour, history, meta, concurrentStreaks } = input;
  const period = input.atrPeriod ?? 20;
  if (history.length < streak) return null;

  const last = history[history.length - 1]!;
  const streakCandles = history.slice(history.length - streak);
  const preStreak = history.slice(0, history.length - streak);

  const atrPre = atr(preStreak, period);
  const displacement = Math.abs(last.close - streakCandles[0]!.open);
  const pathSum = streakCandles.reduce((s, c) => s + range(c), 0);

  const bodies = streakCandles.map(body);
  const head = bodies.slice(0, Math.min(3, bodies.length));
  const tail = bodies.slice(Math.max(0, bodies.length - 3));
  const meanBody = mean(bodies);

  const lastRange = range(last);
  const d = new Date(last.periodStart * 1000);

  return {
    symbol,
    label: meta?.label,
    assetType: meta?.type,
    otc: meta?.otc ?? /_otc$/i.test(symbol),
    payout: meta?.payout,
    breakEvenPct: meta?.payout ? (100 / (100 + meta.payout)) * 100 : undefined,

    streak,
    colour,
    lastPeriodStart: last.periodStart,

    atrPre,
    displacement,
    overextension: safeDiv(displacement, atrPre),
    pathLength: safeDiv(pathSum, atrPre),
    efficiency: pathSum > 0 ? displacement / pathSum : null,

    bodyContraction: meanBody > 0 ? bodies[bodies.length - 1]! / meanBody : null,
    bodyTrend: mean(head) > 0 ? mean(tail) / mean(head) : null,
    rejectionWickPct: lastRange > 0 ? (wickAgainst(last) / lastRange) * 100 : null,
    pushWickPct: lastRange > 0 ? (wickWith(last) / lastRange) * 100 : null,
    lastRangeAtr: safeDiv(lastRange, atrPre),

    volPercentile: atrPercentile(history, period, 120),
    positionInRange: positionInRange(history.slice(Math.max(0, history.length - 240)), last.close),
    concurrentStreaks,

    ticksTotal: streakCandles.reduce((s, c) => s + c.ticks, 0),
    ticksLast: last.ticks,
    hourUtc: d.getUTCHours(),
    dayOfWeek: d.getUTCDay(),
  };
}

/** Exposed for the self-test: true range without importing history.js twice. */
export { trueRange };
