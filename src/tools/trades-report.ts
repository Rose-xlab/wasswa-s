/**
 * Trade journal report — what the bot actually did, versus what it meant to do.
 *
 * Three questions, in order of how much they matter:
 *
 *   1. FILL QUALITY. Did clicks land? How late were they? An unconfirmed click
 *      is worse than a refused one, because you do not know whether you have a
 *      position. This section is the health check, and it comes first.
 *   2. TICK vs BROKER. Every settled trade is scored twice — once from our tick
 *      feed (strike vs expiry price) and once from the observed balance delta.
 *      Disagreement is the interesting column: it is slippage, a strike that
 *      landed elsewhere, or a click that did not do what we thought.
 *   3. RESULT. Win rate against the payout-implied break-even, with a Wilson
 *      interval, because a win rate without an interval is a decoration.
 *
 * Refused and missed signals are counted too. A journal of only the trades you
 * took is a survivorship-biased record of your own reflexes.
 *
 * Run:  npm run report:trades
 *       npm run report:trades -- logs/archived-trades.jsonl
 */
import fs from 'node:fs';
import { paths } from '../config.js';
import type { TradeRecord } from '../exec/journal.js';

function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const p = k / n, z = 1.96, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [100 * (c - h), 100 * (c + h)];
}

const pctile = (xs: number[], p: number): number =>
  xs.length === 0 ? NaN : xs.slice().sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))]!;

function main(): void {
  const file = process.argv[2] ?? paths.journalFile;
  if (!fs.existsSync(file)) {
    console.log(`No trade journal yet at ${file}`);
    console.log('Enable execution (EXECUTE_ENABLED=true, EXECUTE_DRY_RUN=true to start) and run npm run scan.');
    return;
  }
  const all: TradeRecord[] = fs.readFileSync(file, 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l) as TradeRecord);
  if (all.length === 0) { console.log('Trade journal is empty.'); return; }

  // A placed trade is written twice (open, then settled) — keep the last.
  const byId = new Map<string, TradeRecord>();
  for (const r of all) byId.set(r.id, r);
  const recs = [...byId.values()];

  const placed = recs.filter((r) => r.status === 'placed');
  const dry = recs.filter((r) => r.status === 'dry-run');
  const refused = recs.filter((r) => r.status === 'refused');
  const missed = recs.filter((r) => r.status === 'missed');
  const days = new Set(recs.map((r) => r.at.slice(0, 10)));

  const modes = new Map<string, number>();
  for (const r of recs) modes.set(r.mode ?? 'fade', (modes.get(r.mode ?? 'fade') ?? 0) + 1);

  console.log('─────────────────────────────────────────────────────────────');
  console.log('  TRADE JOURNAL REPORT');
  console.log(`  ${recs.length} decisions over ${days.size} day(s)`);
  console.log(`  ${placed.length} placed | ${dry.length} dry-run | ${refused.length} refused | ${missed.length} missed`);
  console.log(`  mode: ${[...modes.entries()].map(([m, n]) => `${m} ${n}`).join(', ')}`);
  if (modes.size > 1) console.log('  ⚠ Mixed strategies in one log — read section 3 PER MODE, never pooled.');
  console.log('─────────────────────────────────────────────────────────────');

  // ── 1. Fill quality ──
  console.log('\n1. FILL QUALITY');
  const unconfirmed = placed.filter((r) => r.confirmed === false);
  console.log(`  confirmed by balance delta : ${placed.filter((r) => r.confirmed).length}/${placed.length}`);
  if (unconfirmed.length > 0) {
    console.log(`  ⚠ UNCONFIRMED CLICKS: ${unconfirmed.length} — the click landed but the balance did not move.`);
    console.log('     Either the order was rejected, or the balance selector is wrong. Investigate before trusting any rate below.');
  }
  const lat = placed.map((r) => r.clickLatencyMs ?? NaN).filter(Number.isFinite);
  if (lat.length > 0) {
    console.log(`  click latency (signal→click): median ${pctile(lat, 0.5).toFixed(0)}ms  p90 ${pctile(lat, 0.9).toFixed(0)}ms  max ${Math.max(...lat).toFixed(0)}ms`);
    console.log('     On a 60s rolling option every 1000ms of latency moves the strike. Consistency matters more than speed.');
  }

  // ── 2. Tick vs broker ──
  const settled = placed.filter((r) => r.settledAt);
  const bothScored = settled.filter((r) => r.result && r.brokerResult && r.result !== 'unknown');
  const disagree = bothScored.filter((r) => r.result !== r.brokerResult);
  console.log('\n2. TICK FEED vs BROKER');
  console.log(`  scored both ways : ${bothScored.length}/${settled.length}`);
  console.log(`  disagreements    : ${disagree.length}${bothScored.length > 0 ? ` (${((100 * disagree.length) / bothScored.length).toFixed(1)}%)` : ''}`);
  if (disagree.length > 0) {
    console.log('     Sample:');
    for (const r of disagree.slice(0, 5)) {
      console.log(`       ${(r.label ?? r.symbol).padEnd(16)} tick=${r.result} broker=${r.brokerResult} pnl=${r.pnl?.toFixed(2)} strike=${r.strike}`);
    }
    console.log('     Believe the broker. A persistent gap means the strike is not where the tick feed says.');
  }

  // ── 3. Results, split by strategy ──
  console.log('\n3. RESULT (broker truth where available)');
  const byMode = new Map<string, TradeRecord[]>();
  for (const r of settled) {
    const m = r.mode ?? 'fade';
    byMode.set(m, [...(byMode.get(m) ?? []), r]);
  }
  if (byMode.size === 0) console.log('  No settled trades yet.');
  for (const [mode, rows] of byMode) {
    const scored = rows.map((r) => r.brokerResult ?? r.result).filter((x): x is 'win' | 'loss' | 'tie' => x === 'win' || x === 'loss' || x === 'tie');
    const win = scored.filter((x) => x === 'win').length;
    const loss = scored.filter((x) => x === 'loss').length;
    const tie = scored.filter((x) => x === 'tie').length;
    const decided = win + loss;
    console.log(`\n  ── ${mode.toUpperCase()} ──`);
    if (decided === 0) { console.log('    no decided trades'); continue; }
    const rate = (100 * win) / decided;
    const [lo, hi] = wilson(win, decided);
    const avgPayout = rows.reduce((s, r) => s + (r.payout || 92), 0) / rows.length;
    const be = (100 / (100 + avgPayout)) * 100;
    const pnl = rows.reduce((s, r) => s + (r.pnl ?? 0), 0);
    console.log(`    ${win}W ${loss}L${tie ? ` ${tie}T` : ''} = ${rate.toFixed(1)}%  (95% CI ${lo.toFixed(1)}–${hi.toFixed(1)}%)`);
    console.log(`    break-even at avg payout ${avgPayout.toFixed(0)}% is ${be.toFixed(1)}%  →  ${rate > be ? `+${(rate - be).toFixed(1)}pp above` : `${(rate - be).toFixed(1)}pp BELOW`}`);
    console.log(`    net P&L (balance deltas): ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`);
    if (decided < 30) console.log(`    ⚠ Only ${decided} settled — noise. ~2,178 needed to prove a 3pp edge.`);
    if (hi > be && lo < be) console.log('    ⚠ Break-even sits INSIDE the interval: not distinguishable from no edge.');
  }

  // ── 4. Why trades did not happen ──
  if (refused.length > 0 || missed.length > 0) {
    console.log('\n4. WHY TRADES DID NOT HAPPEN');
    const reasons = new Map<string, number>();
    for (const r of [...refused, ...missed]) {
      const key = (r.reason ?? 'unknown').replace(/\d+(\.\d+)?/g, 'N');
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    for (const [reason, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${reason}`);
    }
    if (missed.length > placed.length && placed.length > 0) {
      console.log('  ⚠ More signals missed than taken — the single-armed-chart limit is binding.');
      console.log('    Lower MAX_PAIRS, or raise EXECUTE_ARM_MARGIN so arming happens earlier.');
    }
  }
  console.log();
}

main();
