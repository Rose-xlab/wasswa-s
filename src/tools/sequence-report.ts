/**
 * Multi-leg wave analysis — the desk rule, replayed candle by candle.
 *
 * The rule under test: a streak reaches N, you FADE it on candle N+1, and then
 * every later leg FOLLOWS whatever the previous candle just did, for up to a
 * few legs. Flat stake throughout.
 *
 * This is a materially different hypothesis from the single-shot test in
 * report:shadow, and it cannot be answered from the shadow log: that recorder
 * is streak-anchored and stops writing the moment a streak breaks, so every
 * leg after the first reversal is invisible to it. Hence logs/candles.jsonl.
 *
 * Streaks are reconstructed with the LIVE StreakEngine — same doji rule, same
 * body filter, same gap handling — so a setup found here is a setup the
 * scanner would genuinely have flagged. Anything else silently backtests a
 * strategy the bot cannot actually trade.
 *
 * Scoring is candle-aligned (close vs open), which is how a binary pays when
 * the click lands on the candle open. The shadow study showed candle-aligned
 * and rolling-60s agree to within a few tenths of a point in aggregate, so it
 * is a sound proxy for comparing RULES — just not for costing execution.
 *
 * Run:  npm run report:sequence
 *       npm run report:sequence -- --streak=8 --legs=4 --min-payout=92
 */
import fs from 'node:fs';
import { paths, config } from '../config.js';
import { StreakEngine } from '../scanner/streaks.js';
import type { Candle } from '../scanner/candles.js';
import type { CandleRow } from '../scanner/candlelog.js';

type Side = 'buy' | 'sell';
type Colour = 'green' | 'red' | 'doji';

const MIN_N = 30;

const arg = (name: string, dflt: number): number => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dflt;
};

const ENTRY_STREAK = arg('streak', 8);
const MAX_LEGS = arg('legs', 4);
const MIN_PAYOUT = arg('min-payout', 0);

/** Raw colour — how a binary actually settles, no body filter. */
const colourOf = (c: { o: number; c: number }): Colour =>
  c.c > c.o ? 'green' : c.c < c.o ? 'red' : 'doji';

function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const p = k / n, z = 1.96, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [100 * (c - h), 100 * (c + h)];
}

interface Tally { win: number; loss: number; tie: number; payoutSum: number }
const tally = (): Tally => ({ win: 0, loss: 0, tie: 0, payoutSum: 0 });

function fmt(name: string, t: Tally): string {
  const n = t.win + t.loss;
  if (n === 0) return `  ${name.padEnd(28)}  no trades`;
  const rate = (100 * t.win) / n;
  const [lo, hi] = wilson(t.win, n);
  const payout = t.payoutSum / (n + t.tie) / 100;
  const be = (100 / (100 + payout * 100)) * 100;
  const ev = ((t.win * payout - t.loss) / (n + t.tie)) * 100;
  const flag = n < MIN_N ? ' ⚠noise' : rate > be ? ' ✅' : '';
  return `  ${name.padEnd(28)}${String(n).padStart(6)}${String(t.win).padStart(6)}${String(t.loss).padStart(6)}` +
    `${rate.toFixed(1).padStart(8)}%  ${`${lo.toFixed(0)}-${hi.toFixed(0)}%`.padStart(9)}` +
    `${be.toFixed(1).padStart(8)}%${`${ev >= 0 ? '+' : ''}${ev.toFixed(1)}%`.padStart(9)}${flag}`;
}

const HEAD = '  strategy                        n   win  loss    rate     95% CI   b/even       EV';

/**
 * A rule decides each leg's side from the streak colour and the previous
 * candle. `null` ends the wave early.
 */
type Rule = (leg: number, streakColour: 'green' | 'red', prev: Colour) => Side | null;

const fade = (c: 'green' | 'red'): Side => (c === 'red' ? 'buy' : 'sell');
const ride = (c: 'green' | 'red'): Side => (c === 'red' ? 'sell' : 'buy');
const follow = (prev: Colour): Side | null => (prev === 'doji' ? null : prev === 'green' ? 'buy' : 'sell');

const RULES: Record<string, Rule> = {
  // ── THE DESK RULE ──
  'fade→follow': (leg, sc, prev) => (leg === 1 ? fade(sc) : follow(prev)),

  // ── Same shape, opposite opener ──
  'ride→follow': (leg, sc, prev) => (leg === 1 ? ride(sc) : follow(prev)),

  // ── Non-adaptive comparisons: does "follow" actually add anything? ──
  'fade→fade': (_l, sc) => fade(sc),
  'ride→ride': (_l, sc) => ride(sc),

  // ── Contrarian leg 2+: bet against the previous candle ──
  'fade→against': (leg, sc, prev) => {
    if (leg === 1) return fade(sc);
    const f = follow(prev);
    return f === null ? null : f === 'buy' ? 'sell' : 'buy';
  },

  // ── Single-leg baselines: everything above must beat these to earn its keep ──
  'single fade (leg 1)': (leg, sc) => (leg === 1 ? fade(sc) : null),
  'single ride (leg 1)': (leg, sc) => (leg === 1 ? ride(sc) : null),
};

interface WaveResult { legs: number; net: number }

function main(): void {
  const file = process.argv.find((a) => a.endsWith('.jsonl')) ?? paths.candlesFile;
  if (!fs.existsSync(file)) {
    console.log(`\nNo candle log at ${file}`);
    console.log('Run the scanner (npm run scan) — CANDLE_LOG defaults to true — and let it collect.');
    console.log('This analysis needs the candles AFTER a streak breaks, which the shadow log never had.\n');
    return;
  }

  const rows: CandleRow[] = fs.readFileSync(file, 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l) as CandleRow);
  if (rows.length === 0) { console.log('Candle log is empty.'); return; }

  // Group by symbol, de-duplicate by periodStart (backfill overlaps), sort.
  const bySymbol = new Map<string, CandleRow[]>();
  for (const r of rows) {
    let a = bySymbol.get(r.s);
    if (!a) { a = []; bySymbol.set(r.s, a); }
    a.push(r);
  }
  let candles = 0;
  for (const [sym, a] of bySymbol) {
    const seen = new Map<number, CandleRow>();
    for (const r of a) seen.set(r.t, r);
    const sorted = [...seen.values()].sort((x, y) => x.t - y.t);
    bySymbol.set(sym, sorted);
    candles += sorted.length;
  }

  const span = (Math.max(...rows.map((r) => r.t)) - Math.min(...rows.map((r) => r.t))) / 3600;

  console.log('─────────────────────────────────────────────────────────────────────────────');
  console.log('  WAVE ANALYSIS — multi-leg sequences after a streak');
  console.log(`  ${candles} candles across ${bySymbol.size} pairs, spanning ${span.toFixed(1)}h`);
  console.log(`  Entry at streak ${ENTRY_STREAK}; up to ${MAX_LEGS} legs; flat stake.`);
  console.log(`  Payout filter: ${MIN_PAYOUT > 0 ? `≥${MIN_PAYOUT}%` : 'none (all pairs)'}`);
  console.log('  Scored candle-aligned (close vs open). Doji = refund.');
  console.log('─────────────────────────────────────────────────────────────────────────────');

  const overall = new Map<string, Tally>();
  const perLeg = new Map<string, Tally[]>();
  const waves = new Map<string, WaveResult[]>();
  for (const name of Object.keys(RULES)) {
    overall.set(name, tally());
    perLeg.set(name, Array.from({ length: MAX_LEGS }, tally));
    waves.set(name, []);
  }
  let setups = 0;

  for (const [symbol, series] of bySymbol) {
    // Reconstruct streaks with the LIVE engine so setups match what the
    // scanner would really have flagged (body filter, doji rule, gap resets).
    const eng = new StreakEngine({
      threshold: 1e9, // never alert; we only want peek()
      breakOnDoji: config.breakOnDoji,
      minBodyPct: config.minBodyPct,
    });

    for (let i = 0; i < series.length; i++) {
      const r = series[i]!;
      eng.onCandle({
        symbol, periodStart: r.t, timeframeSec: r.tf,
        open: r.o, high: r.h, low: r.l, close: r.c, ticks: r.n,
      } as Candle);

      const st = eng.peek(symbol);
      if (!st?.colour || st.count !== ENTRY_STREAK) continue;
      if (MIN_PAYOUT > 0 && (r.p ?? 0) < MIN_PAYOUT) continue;

      // The legs are the candles that follow — they must be contiguous, or we
      // are stitching across a feed gap and inventing a wave that never was.
      const legs: CandleRow[] = [];
      for (let k = 1; k <= MAX_LEGS; k++) {
        const nxt = series[i + k];
        if (!nxt || nxt.t !== r.t + r.tf * k) break;
        legs.push(nxt);
      }
      if (legs.length === 0) continue;
      setups++;

      for (const [name, rule] of Object.entries(RULES)) {
        let prev: Colour = st.colour; // leg 1 "previous" is the streak itself
        let net = 0, placed = 0;
        for (let k = 0; k < legs.length; k++) {
          const side = rule(k + 1, st.colour, prev);
          if (side === null) break;
          const lc = legs[k]!;
          const actual = colourOf(lc);
          const payout = lc.p ?? 92;
          const t = overall.get(name)!;
          const lt = perLeg.get(name)![k]!;
          const won = actual === 'doji' ? 'tie' : (side === 'buy') === (actual === 'green') ? 'win' : 'loss';
          t[won]++; t.payoutSum += payout;
          lt[won]++; lt.payoutSum += payout;
          net += won === 'win' ? payout / 100 : won === 'loss' ? -1 : 0;
          placed++;
          prev = actual;
        }
        if (placed > 0) waves.get(name)!.push({ legs: placed, net });
      }
    }
  }

  if (setups === 0) {
    console.log(`\n  No streak-${ENTRY_STREAK} setups found in this log yet.`);
    console.log('  Streak 8+ arrives roughly 10×/hour across the watchlist — let it collect longer.\n');
    return;
  }

  console.log(`\n  ${setups} setups at streak ${ENTRY_STREAK}\n`);
  console.log('ALL LEGS POOLED (per-trade economics)');
  console.log(HEAD);
  for (const name of Object.keys(RULES)) console.log(fmt(name, overall.get(name)!));

  console.log('\nPER LEG — does adapting actually add anything, or does it bleed?');
  console.log(HEAD);
  for (const name of Object.keys(RULES)) {
    const legsT = perLeg.get(name)!;
    if (legsT.every((t) => t.win + t.loss === 0)) continue;
    console.log(`  ${name}`);
    legsT.forEach((t, i) => {
      if (t.win + t.loss > 0) console.log(fmt(`    leg ${i + 1}`, t));
    });
  }

  console.log('\nPER WAVE — what one complete sequence is worth, in stake units');
  console.log('  strategy                     waves   avg legs   avg net   total net');
  for (const name of Object.keys(RULES)) {
    const w = waves.get(name)!;
    if (w.length === 0) continue;
    const total = w.reduce((s, x) => s + x.net, 0);
    const avgLegs = w.reduce((s, x) => s + x.legs, 0) / w.length;
    console.log(`  ${name.padEnd(28)}${String(w.length).padStart(6)}${avgLegs.toFixed(2).padStart(11)}` +
      `${(total / w.length >= 0 ? '+' : '')}${(total / w.length).toFixed(3).padStart(9)}` +
      `${(total >= 0 ? '+' : '')}${total.toFixed(1).padStart(11)}`);
  }

  console.log('\n─────────────────────────────────────────────────────────────────────────────');
  console.log('  A rule only earns its keep if it beats BOTH single-leg baselines. Extra legs');
  console.log('  add trades, and more trades against a negative edge lose faster, not slower.');
  console.log('─────────────────────────────────────────────────────────────────────────────\n');
}

main();
