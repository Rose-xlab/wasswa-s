/**
 * Shadow research report — the questions the old outcome log could not answer.
 *
 *   1. WHEN should the click land? Every setup is settled at each configured
 *      entry offset, so the offsets can be compared head to head on identical
 *      setups. This is the one that matters most: the traded instrument is a
 *      60s ROLLING option, so entry timing changes the bet, not just the fill.
 *   2. Does streak DEPTH do anything? Base rates from the collection threshold
 *      up, not just from the alert threshold up.
 *   3. Which FEATURES separate winners from losers? Overextension, exhaustion,
 *      regime, session — each bucketed into terciles and scored.
 *
 * Every rate carries a Wilson 95% interval and is compared against the
 * payout-implied break-even, because a win rate without an interval is a
 * decoration. Cells thinner than MIN_N are printed but flagged: with enough
 * slices, extreme cells are guaranteed to exist and mean nothing.
 *
 * Run:  npm run report:shadow
 *       npm run report:shadow -- path/to/archived-shadow.jsonl
 */
import fs from 'node:fs';
import { paths } from '../config.js';
import type { ShadowRecord } from '../scanner/shadow.js';

/** Below this, a cell is noise no matter how good it looks. */
const MIN_N = 30;

interface Cell { win: number; loss: number; tie: number; payoutSum: number }
const cell = (): Cell => ({ win: 0, loss: 0, tie: 0, payoutSum: 0 });

function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const p = k / n, z = 1.96, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [100 * (c - h), 100 * (c + h)];
}

function add(map: Map<string, Cell>, key: string, result: 'win' | 'loss' | 'tie', payout?: number): void {
  const c = map.get(key) ?? cell();
  c[result]++;
  c.payoutSum += payout ?? 92;
  map.set(key, c);
}

function line(key: string, c: Cell): string {
  const n = c.win + c.loss;
  if (n === 0) return `  ${key.padEnd(24)}      no decided outcomes`;
  const rate = (100 * c.win) / n;
  const [lo, hi] = wilson(c.win, n);
  const payout = c.payoutSum / (n + c.tie) / 100;
  const be = (100 / (100 + payout * 100)) * 100;
  const ev = ((c.win * payout - c.loss) / (n + c.tie)) * 100;
  const edge = rate - be;
  const flag = n < MIN_N ? ' ⚠noise' : edge > 0 ? ' ✅' : '';
  return `  ${key.padEnd(24)}${String(n).padStart(5)}${String(c.win).padStart(6)}${String(c.loss).padStart(6)}` +
    `${rate.toFixed(1).padStart(8)}%  ${`${lo.toFixed(0)}-${hi.toFixed(0)}%`.padStart(10)}` +
    `${be.toFixed(1).padStart(8)}%${`${ev >= 0 ? '+' : ''}${ev.toFixed(1)}%`.padStart(9)}${flag}`;
}

function table(title: string, map: Map<string, Cell>, sortKeys = false): void {
  if (map.size === 0) return;
  console.log(`\n${title}`);
  console.log('  bucket                      n   win  loss    rate      95% CI   b/even       EV');
  const keys = [...map.keys()];
  if (sortKeys) keys.sort();
  else keys.sort((a, b) => (map.get(b)!.win + map.get(b)!.loss) - (map.get(a)!.win + map.get(a)!.loss));
  for (const k of keys) console.log(line(k, map.get(k)!));
}

/** Split a numeric feature into terciles by its own distribution. */
function terciles(values: number[]): [number, number] | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length < 15) return null;
  return [v[Math.floor(v.length / 3)]!, v[Math.floor((2 * v.length) / 3)]!];
}

/** Tercile label. The feature name lives in the table title, not every row. */
function bucketOf(x: number | null | undefined, cuts: [number, number] | null): string | null {
  if (x == null || !Number.isFinite(x) || !cuts) return null;
  const [a, b] = cuts;
  if (x < a) return `1 low  (<${a.toFixed(2)})`;
  if (x < b) return `2 mid  (${a.toFixed(2)}–${b.toFixed(2)})`;
  return `3 high (≥${b.toFixed(2)})`;
}

function main(): void {
  const file = process.argv[2] ?? paths.shadowFile;
  if (!fs.existsSync(file)) {
    console.log(`No shadow log yet at ${file}`);
    console.log('Run the scanner (npm run scan) with SHADOW_ENABLED=true and let it collect.');
    return;
  }
  const all: ShadowRecord[] = fs.readFileSync(file, 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l) as ShadowRecord);
  if (all.length === 0) { console.log('Shadow log is empty.'); return; }

  // v1 records are unusable. That version keyed pending setups by symbol, so a
  // streak that continued had its earlier pending overwritten before it could
  // settle — only setups where the streak BROKE survived to be written, which
  // guarantees a reversal and produced a ~90% win rate out of thin air.
  const records = all.filter((r) => (r.v ?? 1) >= 2);
  const stale = all.length - records.length;
  if (stale > 0) {
    console.log(`\n⚠ Skipping ${stale} v1 record(s): survivorship-biased (only streaks that BROKE`);
    console.log('  were ever written, so every "win rate" from them is a selection effect).');
    if (records.length === 0) {
      console.log('\n  No usable records yet. Re-run the scanner to collect v2 data.\n');
      return;
    }
  }

  const withFill = records.filter((r) => r.settlements.length > 0);
  const days = new Set(records.map((r) => r.at.slice(0, 10)));

  console.log('─────────────────────────────────────────────────────────────────────────');
  console.log('  SHADOW RESEARCH REPORT — fade the streak (red→BUY, green→SELL)');
  console.log(`  ${records.length} setups over ${days.size} day(s); ${withFill.length} with tick coverage`);
  console.log(`  Expiry ${records[0]!.expirySec}s ROLLING from the click — not candle-aligned.`);
  console.log(`  Cells under n=${MIN_N} are flagged ⚠noise. EV is per $1 staked, ties refunded.`);
  console.log('─────────────────────────────────────────────────────────────────────────');

  // ── 1. Entry offset: the headline question ──
  const byOffset = new Map<string, Cell>();
  for (const r of withFill) {
    for (const s of r.settlements) {
      add(byOffset, `+${String(s.offsetSec).padStart(2)}s after open`, s.result, r.features.payout);
    }
  }
  table('1. ENTRY TIMING — when should the click land? (same setups, every offset)', byOffset, true);

  // Everything below scores the BEST-PRACTICE offset only: the earliest one.
  const primary = records[0]!.settlements[0]?.offsetSec ?? 0;
  const at = (r: ShadowRecord) => r.settlements.find((s) => s.offsetSec === primary);
  const scored = withFill.filter((r) => at(r) !== undefined);
  console.log(`\n  (sections below score the +${primary}s offset only, n=${scored.length})`);

  // ── 2. Streak depth ──
  const byStreak = new Map<string, Cell>();
  const byStreakCandle = new Map<string, Cell>();
  for (const r of scored) {
    add(byStreak, `streak ${String(r.features.streak).padStart(2)}`, at(r)!.result, r.features.payout);
    if (r.candle) {
      add(byStreakCandle, `streak ${String(r.features.streak).padStart(2)}`,
        r.candle.outcome === 'reversal' ? 'win' : r.candle.outcome === 'continuation' ? 'loss' : 'tie',
        r.features.payout);
    }
  }
  table('2. STREAK DEPTH — rolling 60s expiry', byStreak, true);
  table('   STREAK DEPTH — candle-aligned, for comparison with the old log', byStreakCandle, true);

  // ── 3. Features ──
  const cuts = {
    overextension: terciles(scored.map((r) => r.features.overextension ?? NaN)),
    bodyContraction: terciles(scored.map((r) => r.features.bodyContraction ?? NaN)),
    bodyTrend: terciles(scored.map((r) => r.features.bodyTrend ?? NaN)),
    rejectionWickPct: terciles(scored.map((r) => r.features.rejectionWickPct ?? NaN)),
    efficiency: terciles(scored.map((r) => r.features.efficiency ?? NaN)),
    volPercentile: terciles(scored.map((r) => r.features.volPercentile ?? NaN)),
    concurrentStreaks: terciles(scored.map((r) => r.features.concurrentStreaks)),
  } as const;

  let n = 0;
  for (const [name, cut] of Object.entries(cuts)) {
    const m = new Map<string, Cell>();
    for (const r of scored) {
      const raw = (r.features as unknown as Record<string, number | null>)[name];
      const b = bucketOf(raw, cut);
      if (b) add(m, b, at(r)!.result, r.features.payout);
    }
    table(`3.${++n} FEATURE — ${name} (terciles)`, m, true);
  }

  // ── 4. Context ──
  const byDir = new Map<string, Cell>();
  const byHour = new Map<string, Cell>();
  const byClass = new Map<string, Cell>();
  const byPayout = new Map<string, Cell>();
  for (const r of scored) {
    const res = at(r)!.result;
    byDir.set('x', byDir.get('x') ?? cell());
    add(byDir, r.features.colour === 'red' ? 'red streak → BUY' : 'green streak → SELL', res, r.features.payout);
    add(byHour, `${String(r.features.hourUtc).padStart(2, '0')}:00 UTC`, res, r.features.payout);
    add(byClass, r.features.assetType ?? 'unknown', res, r.features.payout);
    const p = r.features.payout ?? 0;
    add(byPayout, p >= 92 ? 'payout ≥92%' : p >= 88 ? 'payout 88-91%' : 'payout <88%', res, r.features.payout);
  }
  byDir.delete('x');
  table('4. DIRECTION', byDir);
  table('5. SESSION (true UTC — clock-corrected)', byHour, true);
  table('6. ASSET CLASS', byClass);
  table('7. PAYOUT TIER', byPayout, true);

  // ── 8. Reality check ──
  const decided = scored.filter((r) => at(r)!.result !== 'tie').length;
  console.log('\n─────────────────────────────────────────────────────────────────────────');
  console.log(`  Decided outcomes at +${primary}s: ${decided}`);
  console.log('  To PROVE a 55% edge clears a 52.1% break-even needs ~2,178 independent');
  console.log('  trades. Until then every ✅ above is a hypothesis, not a result.');
  console.log('─────────────────────────────────────────────────────────────────────────\n');
}

main();
