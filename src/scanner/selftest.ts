/**
 * Deterministic self-test for the Phase 2 core (candles + streaks).
 * No browser, no network, no credentials. Run: npm run test:core
 */
import { CandleBuilder, type Candle } from './candles.js';
import { StreakEngine, type StreakAlert } from './streaks.js';
import { OutcomeTracker } from './outcomes.js';
import { FeedClock } from '../lib/clock.js';
import { TickBuffer } from './tickbuf.js';
import { CandleHistory, atr, trueRange } from './history.js';
import { buildFeatures } from './features.js';
import { ShadowRecorder } from './shadow.js';
import {
  applyResult, checkGates, freshState, rollDay, LIVE_ACCOUNT_SENTINEL,
  type RiskLimits, type RiskState,
} from '../exec/guards.js';
import { parseAmount, parseDuration, formatDuration, parsePercent, SELECTOR_ENV, DEFAULT_SELECTORS } from '../exec/terminal.js';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ✓ ${msg}`); }
  else { console.log(`  ✗ ${msg}`); failures++; }
}

// ── CandleBuilder ────────────────────────────────────────────
console.log('CandleBuilder');
{
  const b = new CandleBuilder(60, 1.5);
  const S = 'TEST';
  // Bucket [0,60): ticks 1.0, 1.5, 0.8, 1.2
  for (const [ts, price] of [[1, 1.0], [20, 1.5], [40, 0.8], [59, 1.2]] as const) {
    assert(b.addTick({ symbol: S, ts, price }).length === 0, `tick ${ts} keeps bucket open`);
  }
  // First tick of next bucket closes bucket 0.
  const closed = b.addTick({ symbol: S, ts: 61, price: 2.0 });
  assert(closed.length === 1, 'crossing into bucket 60 closes bucket 0');
  const c = closed[0]!;
  assert(c.open === 1.0 && c.high === 1.5 && c.low === 0.8 && c.close === 1.2 && c.ticks === 4,
    `OHLC correct: O${c.open} H${c.high} L${c.low} C${c.close} n${c.ticks}`);
  assert(c.periodStart === 0, 'periodStart aligned to bucket');

  // Late tick for the already-closed bucket 0 is dropped.
  assert(b.addTick({ symbol: S, ts: 30, price: 99 }).length === 0, 'late tick for closed bucket dropped');

  // Time-based flush closes the quiet bucket 60 after grace.
  assert(b.flush(60 + 60 + 1).length === 0, 'flush before grace does nothing');
  const flushed = b.flush(60 + 60 + 2);
  assert(flushed.length === 1 && flushed[0]!.periodStart === 60, 'flush after grace closes bucket 60');
}

// ── StreakEngine ─────────────────────────────────────────────
console.log('\nStreakEngine');
const redCandle = (i: number): Candle => ({ symbol: 'EURUSD_otc', periodStart: i * 60, timeframeSec: 60, open: 1.1, high: 1.1, low: 1.0, close: 1.0, ticks: 10 });
const greenCandle = (i: number): Candle => ({ symbol: 'EURUSD_otc', periodStart: i * 60, timeframeSec: 60, open: 1.0, high: 1.1, low: 1.0, close: 1.1, ticks: 10 });
const dojiCandle = (i: number): Candle => ({ symbol: 'EURUSD_otc', periodStart: i * 60, timeframeSec: 60, open: 1.05, high: 1.1, low: 1.0, close: 1.05, ticks: 10 });

{
  const eng = new StreakEngine({ threshold: 7, breakOnDoji: true });
  const alerts: StreakAlert[] = [];
  for (let i = 0; i < 6; i++) { const a = eng.onCandle(redCandle(i)); if (a) alerts.push(a); }
  assert(alerts.length === 0, 'no alert before threshold (6 reds)');

  const a7 = eng.onCandle(redCandle(6));
  assert(a7?.count === 7 && a7.colour === 'red', 'alert fires at exactly 7 red');

  const a8 = eng.onCandle(redCandle(7));
  assert(a8?.count === 8, 'alert fires again when streak extends to 8');

  // Feeding nothing new / same count must not duplicate — simulate by peeking.
  assert(eng.peek('EURUSD_otc')?.lastAlerted === 8, 'lastAlerted tracks 8 (dedup guard)');

  const broken = eng.onCandle(greenCandle(8));
  assert(broken === null && eng.peek('EURUSD_otc')?.count === 1, 'opposite colour resets run to 1');
}

// Restart safety: snapshot at 8, restore into a fresh engine, extend to 9.
{
  const eng1 = new StreakEngine({ threshold: 7, breakOnDoji: true });
  for (let i = 0; i < 8; i++) eng1.onCandle(redCandle(i)); // alerts at 7 and 8
  const snap = eng1.snapshot();

  assert(snap['EURUSD_otc']?.count === 8 && snap['EURUSD_otc']?.lastAlerted === 8,
    'snapshot captures count=8 and lastAlerted=8');

  const eng2 = new StreakEngine({ threshold: 7, breakOnDoji: true });
  eng2.restore(snap);
  const a9 = eng2.onCandle(redCandle(8));
  assert(a9?.count === 9, 'after restart, the next candle alerts 9 (not a re-alert of 7/8)');
}

// Doji handling.
{
  const brk = new StreakEngine({ threshold: 3, breakOnDoji: true });
  for (let i = 0; i < 3; i++) brk.onCandle(redCandle(i));
  brk.onCandle(dojiCandle(3));
  assert(brk.peek('EURUSD_otc')?.count === 0, 'breakOnDoji resets the run');

  const ign = new StreakEngine({ threshold: 3, breakOnDoji: false });
  for (let i = 0; i < 3; i++) ign.onCandle(redCandle(i));
  ign.onCandle(dojiCandle(3));
  assert(ign.peek('EURUSD_otc')?.count === 3, 'ignore-doji leaves the run untouched');
}

// Gap handling: a non-consecutive candle must reset the run (brief §6).
{
  const eng = new StreakEngine({ threshold: 7, breakOnDoji: true });
  for (let i = 0; i < 7; i++) eng.onCandle(redCandle(i)); // alert at 7
  assert(eng.peek('EURUSD_otc')?.count === 7, 'run at 7 before gap');
  // Skip minute 7 (i=8 is not adjacent to i=6's successor) → gap resets.
  const afterGap = eng.onCandle(redCandle(9));
  assert(afterGap === null && eng.peek('EURUSD_otc')?.count === 1, 'gap resets run to 1 (no false continuation)');

  // Adjacent candles after the reset resume counting normally.
  for (let i = 10; i < 15; i++) eng.onCandle(redCandle(i));
  assert(eng.peek('EURUSD_otc')?.count === 6, 'counting resumes after gap');
}

// ── Body-size filter (micro-candles are noise, not direction) ──
console.log('\nBody-size filter');
{
  // Every candle spans range 1.0 (high 1.5, low 0.5) around open 1.0.
  const mk = (i: number, body: number): Candle =>
    ({ symbol: 'BODY', periodStart: i * 60, timeframeSec: 60, open: 1.0, high: 1.5, low: 0.5, close: 1.0 + body, ticks: 10 });

  const eng = new StreakEngine({ threshold: 7, breakOnDoji: true, minBodyPct: 10 });
  // Warm-up: with fewer than 5 ranges observed, even tiny bodies count.
  for (let i = 0; i < 5; i++) eng.onCandle(mk(i, 0.001));
  assert(eng.peek('BODY')?.count === 5, 'before warm-up, tiny bodies still count (run 5)');

  // Filter engaged: avg range 1.0 → min body 0.1; a 0.001 body is now a doji.
  eng.onCandle(mk(5, 0.001));
  assert(eng.peek('BODY')?.count === 0, 'micro-body (0.1% of range) classified doji → breaks streak');

  // A real body still counts.
  eng.onCandle(mk(6, 0.5));
  assert(eng.peek('BODY')?.count === 1 && eng.peek('BODY')?.colour === 'green', 'normal body (50% of range) still green');

  // Just under the 10% threshold → doji; just over → counts.
  eng.onCandle(mk(7, 0.09));
  assert(eng.peek('BODY')?.count === 0, 'body just under threshold is doji');
  eng.onCandle(mk(8, 0.11));
  assert(eng.peek('BODY')?.count === 1, 'body just over threshold counts');

  // minBodyPct 0 (or omitted) keeps the legacy exact-equality behaviour.
  const legacy = new StreakEngine({ threshold: 7, breakOnDoji: true });
  for (let i = 0; i < 3; i++) legacy.onCandle(mk(i, 0.001));
  legacy.onCandle(mk(3, 0.001));
  assert(legacy.peek('BODY')?.count === 4, 'filter off → tiny bodies keep counting');
}

// ── OutcomeTracker (alert → next-candle scoring) ──
console.log('\nOutcomeTracker');
{
  const alertFrom = (c: Candle, colour: 'green' | 'red', count = 7): StreakAlert =>
    ({ symbol: c.symbol, colour, count, candle: c });
  const t = new OutcomeTracker(); // in-memory (no file)

  assert(t.onCandle(greenCandle(1)) === null, 'candle with no pending alert resolves nothing');

  // Reversal: 7 reds alerted at minute 6, minute 7 closes green.
  t.register(alertFrom(redCandle(6), 'red'));
  assert(t.onCandle(redCandle(5)) === null, 'stale candle (before expected) is ignored');
  const rev = t.onCandle(greenCandle(7));
  assert(rev?.outcome === 'reversal', 'next candle against the streak → reversal');

  // Continuation: next candle extends the streak.
  t.register(alertFrom(redCandle(7), 'red', 8));
  assert(t.onCandle(redCandle(8))?.outcome === 'continuation', 'next candle with the streak → continuation');

  // Doji: exactly flat next candle.
  t.register(alertFrom(redCandle(8), 'red', 9));
  assert(t.onCandle(dojiCandle(9))?.outcome === 'doji', 'flat next candle → doji (refund)');

  // Void: the expected candle never arrived (feed gap).
  t.register(alertFrom(redCandle(9), 'red', 10));
  assert(t.onCandle(redCandle(12))?.outcome === 'void', 'gap over the expected candle → void');

  assert(t.summary().includes('1W/1L'), `summary counts wins/losses: "${t.summary()}"`);
}

// ── FeedClock (the +7200s broker-time offset) ─────────────────
console.log('\nFeedClock');
{
  const now = 1_800_000_000_000; // fixed wall clock, ms
  const nowSec = now / 1000;
  const c = new FeedClock();

  assert(!c.ready, 'not ready before any samples');

  // Samples are rate-limited to one per second (a single updateStream frame
  // carries dozens of ticks), so a test clock has to advance like real time.
  let t = now;
  const feed = (offset: number, n: number) => {
    for (let i = 0; i < n; i++) { t += 1500; c.observeLive(nowSec + offset + (t - now) / 1000, t); }
  };

  // Live ticks arrive ~instantly, so feedTs - now IS the offset. 7198, not a
  // round 7200: network latency shaves a second or two off every sample.
  feed(7198, 8);
  assert(c.ready, 'ready after 8 spaced live samples');
  assert(c.offsetSec === 7200, `raw ~7198 quantized to a whole minute (got ${c.offsetSec})`);
  assert(c.toReal(nowSec + 7200) === nowSec, 'toReal removes the offset');

  // Quantization must preserve candle-bucket alignment with Pocket Option.
  assert(c.offsetSec % 60 === 0, 'offset is a whole number of minutes (buckets stay aligned)');

  // Small drift must NOT re-latch — that would reset every streak.
  feed(7205, 40);
  assert(c.offsetSec === 7200, 'small drift does not move the latched offset');

  // A 4-MINUTE move is not a timezone. This exact case (+6960 → +7200) fired
  // live and reset every streak on the watchlist mid-session.
  feed(6960, 80);
  assert(c.offsetSec === 7200, 'a 240s move does NOT re-latch (no timezone is 4 minutes)');

  // A real DST flip (+1h), sustained, does re-latch.
  feed(10_800, 80);
  assert(c.offsetSec === 10_800, 'sustained 1h shift re-latches (broker DST)');

  // Burst protection: one updateStream frame carries many ticks. Sampling all
  // of them let a single stale burst refill the window and drag the median.
  const b2 = new FeedClock();
  for (let i = 0; i < 8; i++) b2.observeLive(nowSec + 7200, now + i * 1500);
  assert(b2.offsetSec === 7200, 'calibrates from spaced samples');
  for (let i = 0; i < 200; i++) b2.observeLive(nowSec + 3600, now + 12_000); // same ms = one frame
  assert(b2.offsetSec === 7200, 'a 200-tick burst in one frame cannot move the clock');

  // Backfill-only fallback: samples are minutes stale, so the NEWEST is used.
  const b = new FeedClock();
  b.observeBackfill(nowSec + 7200 - 600, now); // 10 min stale
  b.observeBackfill(nowSec + 7200 - 5, now);   // nearly fresh
  assert(!b.ready, 'backfill alone is not trusted immediately');
}

// ── TickBuffer (strike/settle lookup) ────────────────────────
console.log('\nTickBuffer');
{
  const tb = new TickBuffer(600);
  for (let t = 1000; t <= 1200; t += 10) tb.push('X', t, 1 + (t - 1000) / 1000);

  assert(tb.priceAt('X', 1000) === 1, 'priceAt exact tick returns that tick');
  assert(tb.priceAt('X', 1015) === tb.priceAt('X', 1010), 'priceAt between ticks uses the LAST tick at or before (broker strike rule)');
  assert(tb.priceAt('X', 999) === null, 'priceAt before all data is null (never extrapolate)');
  assert(tb.covers('X', 1000, 1200), 'covers a fully-spanned window');
  assert(!tb.covers('X', 1000, 1201), 'does not cover past the newest tick');
  assert(!tb.covers('X', 999, 1100), 'does not cover before the oldest tick');
  assert(tb.range('X', 1000, 1020).length === 3, 'range is inclusive of both ends');

  // Out-of-order insert must keep the array sorted (defensive path).
  const oo = new TickBuffer(600);
  oo.push('Y', 100, 5); oo.push('Y', 300, 7); oo.push('Y', 200, 6);
  assert(oo.priceAt('Y', 250) === 6, 'out-of-order tick is inserted in the right place');

  // Retention drops old ticks.
  const r = new TickBuffer(50);
  for (let t = 0; t <= 200; t += 10) r.push('Z', t, t);
  assert(r.priceAt('Z', 100) === null, 'ticks older than the retention window are dropped');
  assert(r.priceAt('Z', 200) === 200, 'recent ticks survive retention');
}

// ── ATR / features ───────────────────────────────────────────
console.log('\nHistory + features');
{
  const mk = (i: number, o: number, h: number, l: number, c: number): Candle =>
    ({ symbol: 'F', periodStart: i * 60, timeframeSec: 60, open: o, high: h, low: l, close: c, ticks: 10 });

  assert(trueRange(mk(1, 10, 12, 8, 11)) === 4, 'trueRange without prev is high-low');
  assert(trueRange(mk(1, 10, 12, 8, 11), mk(0, 1, 20, 1, 20)) === 12, 'trueRange spans a gap from prev close');
  assert(atr([mk(0, 1, 2, 0, 1)], 20) === null, 'atr needs period+1 candles');

  const hist = new CandleHistory(240);
  // 25 flat candles of range 1.0 → ATR 1.0, then a 6-candle red run of 2.0 each.
  for (let i = 0; i < 25; i++) hist.push(mk(i, 10, 10.5, 9.5, 10));
  for (let i = 25; i < 31; i++) hist.push(mk(i, 10 - (i - 25) * 2, 10 - (i - 25) * 2, 8 - (i - 25) * 2, 8 - (i - 25) * 2));

  const f = buildFeatures({
    symbol: 'F', streak: 6, colour: 'red',
    history: hist.all('F'), concurrentStreaks: 3,
  });
  assert(f !== null, 'features build with enough history');
  assert(f!.atrPre !== null && Math.abs(f!.atrPre - 1) < 1e-9, `atrPre uses PRE-streak candles only (got ${f!.atrPre})`);
  // The run travels 10 → -2, i.e. 12 price units on a 1.0 ATR base.
  assert(Math.abs(f!.displacement - 12) < 1e-9, `displacement = |close(last) - open(first)| (got ${f!.displacement})`);
  assert(f!.overextension !== null && Math.abs(f!.overextension - 12) < 1e-9, 'overextension = displacement / pre-streak ATR');
  assert(f!.concurrentStreaks === 3, 'regime feature carried through');
  assert(f!.colour === 'red' && f!.streak === 6, 'identity fields carried through');

  const short = buildFeatures({ symbol: 'F', streak: 999, colour: 'red', history: hist.all('F'), concurrentStreaks: 0 });
  assert(short === null, 'features refuse to build when the streak exceeds known history');
}

// ── ShadowRecorder (rolling-expiry settlement) ───────────────
console.log('\nShadowRecorder (60s rolling expiry)');
{
  const tb = new TickBuffer(3600);
  const S = 'ROLL';
  // Entry candle opens at t=600. Price falls until t=630, then rallies. A red
  // streak is FADED (bought), so both clicks win here — but the later one
  // strikes into the extra weakness and gets a better price. That gap is
  // exactly what the entry-offset column is for.
  const priceAt = (t: number) => Number((t <= 630 ? 100 - (t - 500) * 0.01 : 100 - 1.3 + (t - 630) * 0.05).toFixed(6));
  for (let t = 500; t <= 650; t++) tb.push(S, t, priceAt(t));

  const rec = new ShadowRecorder(tb, undefined, { collectStreak: 4, offsets: [0, 30], expirySec: 60, resolveTimeoutSec: 600 });
  const lastCandle: Candle = { symbol: S, periodStart: 540, timeframeSec: 60, open: 100.6, high: 100.6, low: 100, close: 100, ticks: 60 };
  const features = buildFeatures({
    symbol: S, streak: 8, colour: 'red',
    history: [...Array(30)].map((_, i): Candle => ({ symbol: S, periodStart: (i - 29) * 60 + 540, timeframeSec: 60, open: 101, high: 101.5, low: 100.5, close: 101, ticks: 10 })).slice(0, 29).concat(lastCandle),
    concurrentStreaks: 0,
  });
  assert(features !== null, 'shadow setup features build');
  rec.register(features!, lastCandle);

  // Ticks only reach t=650; the +30s option does not expire until t=690.
  assert(rec.sweep(660).length === 0, 'no emit before ticks cover entry + maxOffset + expiry');

  for (let t = 651; t <= 800; t++) tb.push(S, t, priceAt(t));
  const out = rec.sweep(800);
  assert(out.length === 1, 'emits once tick coverage reaches the last expiry');
  const r = out[0]!;
  assert(r.entryTs === 600, 'entry is the OPEN of the candle after the streak');

  const s0 = r.settlements.find((x) => x.offsetSec === 0)!;
  const s30 = r.settlements.find((x) => x.offsetSec === 30)!;
  // +0s: strike at t=600 (99.0), settle at t=660 (100.2) → price ROSE → a buy wins.
  assert(s0.strike === tb.priceAt(S, 600) && s0.settle === tb.priceAt(S, 660), '+0s strikes at entry and settles exactly 60s later');
  assert(s0.result === 'win', `+0s fade of a red streak wins when price rises (got ${s0.result})`);
  // +30s: strike at t=630 (the low), settle at t=690 → rallied further → also a win,
  // but from a strictly better strike. That gap IS the entry-timing question.
  assert(s30.strike < s0.strike, 'a later click into continued weakness gets a better strike on a buy');
  assert(s30.mfe >= 0 && s30.mae <= 0, 'MFE is non-negative and MAE non-positive by construction');
  assert(r.coverage === 'full', 'coverage full when every offset settled');

  // Direction flip: a GREEN streak is sold, so the same rally must LOSE.
  const rec2 = new ShadowRecorder(tb, undefined, { collectStreak: 4, offsets: [0], expirySec: 60, resolveTimeoutSec: 600 });
  rec2.register({ ...features!, colour: 'green' }, lastCandle);
  const g = rec2.sweep(800)[0]!;
  assert(g.settlements[0]!.result === 'loss', 'green streak → SELL loses on the same rising path');

  // Candle-aligned scoring still recorded alongside, for continuity.
  const rec3 = new ShadowRecorder(tb, undefined, { collectStreak: 4, offsets: [0], expirySec: 60, resolveTimeoutSec: 600 });
  rec3.register(features!, lastCandle);
  rec3.onCandle({ symbol: S, periodStart: 600, timeframeSec: 60, open: 99, high: 101, low: 98.5, close: 100.5, ticks: 60 });
  const c3 = rec3.sweep(800)[0]!;
  assert(c3.candle?.outcome === 'reversal', 'candle-aligned label: green candle after a red streak = reversal');

  // No tick coverage at all → still emitted once the give-up clock passes (so
  // base rates are not silently biased toward well-covered pairs), but flagged.
  const rec4 = new ShadowRecorder(new TickBuffer(600), undefined, { collectStreak: 4, offsets: [0], expirySec: 60, resolveTimeoutSec: 600 });
  rec4.register(features!, lastCandle);
  assert(rec4.sweep(700).length === 0, 'uncovered setup waits for the give-up clock');
  const n4 = rec4.sweep(1300)[0]!;
  assert(n4.coverage === 'none' && n4.settlements.length === 0, 'setup with no tick data emits with coverage=none');

  // ── Survivorship guard ──
  // v1 keyed pendings by SYMBOL, so a streak running 4→5→6 overwrote its own
  // earlier pending before it could settle (settlement needs ~90s of ticks,
  // the next candle lands in 60s). Only setups where the streak BROKE survived
  // to be written — which guarantees the next candle reversed, and produced a
  // fictional ~90% win rate. Each entry candle must now resolve independently.
  {
    const tb2 = new TickBuffer(3600);
    for (let t = 500; t <= 1200; t++) tb2.push('SEQ', t, 100 + (t - 500) * 0.01);
    const rec6 = new ShadowRecorder(tb2, undefined, { collectStreak: 4, offsets: [0], expirySec: 60, resolveTimeoutSec: 600 });
    const mkC = (start: number): Candle => ({ symbol: 'SEQ', periodStart: start, timeframeSec: 60, open: 101, high: 101.5, low: 100.5, close: 100.9, ticks: 60 });
    const hist = [...Array(30)].map((_, i) => mkC((i - 29) * 60 + 600));
    const f4 = buildFeatures({ symbol: 'SEQ', streak: 4, colour: 'red', history: hist, concurrentStreaks: 0 })!;

    // Three consecutive candles of a CONTINUING streak: 4, then 5, then 6.
    rec6.register({ ...f4, streak: 4 }, mkC(600));
    rec6.register({ ...f4, streak: 5 }, mkC(660));
    rec6.register({ ...f4, streak: 6 }, mkC(720));

    const emitted = rec6.sweep(1200);
    assert(emitted.length === 3, `a continuing streak records EVERY length, not just the last (got ${emitted.length}, want 3)`);
    const lengths = emitted.map((r) => r.features.streak).sort((a, b) => a - b);
    assert(JSON.stringify(lengths) === '[4,5,6]', `streak 4, 5 and 6 each resolve independently (got ${JSON.stringify(lengths)})`);
    assert(emitted.every((r) => r.v === 2), 'records are stamped v2 so v1 data can be excluded');
  }

  // Below the collection threshold is never recorded.
  const rec5 = new ShadowRecorder(tb, undefined, { collectStreak: 7, offsets: [0], expirySec: 60, resolveTimeoutSec: 600 });
  rec5.register({ ...features!, streak: 5 }, lastCandle);
  assert(rec5.sweep(1300).length === 0, 'streak below collectStreak is not recorded');
}

// ── Execution risk gates ─────────────────────────────────────
console.log('\nRisk gates');
{
  const NOW = Date.parse('2026-08-06T12:00:00Z');
  const limits: RiskLimits = {
    enabled: true, dryRun: false,
    stakeFixed: 0, stakePct: 1, maxStake: 1000, minStake: 1, minPayout: 90,
    maxConcurrent: 1, maxTradesPerDay: 30, maxConsecutiveLosses: 3,
    dailyLossPct: 5, cooldownSec: 30,
    killSwitchFile: 'C:\\definitely\\not\\a\\real\\path\\HALT',
    executeStreak: 8, armMargin: 2,
  };
  const base = freshState(10_000, NOW);
  const ctx = { isDemo: true, payout: 92, nowMs: NOW + 60_000 };
  const ok = (r: ReturnType<typeof checkGates>) => r.ok;
  const why = (r: ReturnType<typeof checkGates>) => (r.ok ? '' : r.reason);

  const pass = checkGates(limits, base, ctx);
  assert(ok(pass) && pass.ok && pass.stake === 100, `clean path passes with 1% stake (got ${pass.ok ? pass.stake : why(pass)})`);

  // THE gate: a non-demo account must be refused, and it must halt.
  const live = checkGates(limits, base, { ...ctx, isDemo: false });
  assert(!ok(live) && /NOT a demo/.test(why(live)), 'non-demo account is refused');
  assert(!live.ok && live.halt === true, 'non-demo refusal HALTS rather than retrying next candle');

  // …and cannot be waved through by an ordinary truthy env value.
  assert(!checkGates(limits, base, { ...ctx, isDemo: false, allowLive: 'true' }).ok, 'PV_ALLOW_LIVE=true does NOT bypass the demo gate');
  assert(!checkGates(limits, base, { ...ctx, isDemo: false, allowLive: '1' }).ok, 'PV_ALLOW_LIVE=1 does NOT bypass the demo gate');
  assert(checkGates(limits, base, { ...ctx, isDemo: false, allowLive: LIVE_ACCOUNT_SENTINEL }).ok, 'only the explicit sentinel opts into a real account');

  assert(!checkGates({ ...limits, enabled: false }, base, ctx).ok, 'disabled executor never trades');

  // Risk stops.
  const drawn = { ...base, balance: 9_400 }; // −6% from 10,000
  const dd = checkGates(limits, drawn, ctx);
  assert(!ok(dd) && /daily loss/.test(why(dd)) && !dd.ok && dd.halt === true, 'daily drawdown stop halts the day');
  const bruised = { ...base, balance: 9_600 }; // −4%, inside the limit
  assert(checkGates(limits, bruised, ctx).ok, 'drawdown just inside the limit still trades');

  const losing = { ...base, consecutiveLosses: 3 };
  const cl = checkGates(limits, losing, ctx);
  assert(!ok(cl) && /consecutive losses/.test(why(cl)) && !cl.ok && cl.halt === true, '3 consecutive losses halts the day');
  assert(checkGates(limits, { ...base, consecutiveLosses: 2 }, ctx).ok, '2 consecutive losses still trades');

  assert(!checkGates(limits, { ...base, tradesToday: 30 }, ctx).ok, 'daily trade cap blocks');
  assert(!checkGates(limits, { ...base, openPositions: 1 }, ctx).ok, 'max concurrent blocks a second position');
  assert(!checkGates(limits, { ...base, halted: true, haltReason: 'x' }, ctx).ok, 'halted state blocks everything');

  // Cooldown.
  assert(!checkGates(limits, { ...base, lastTradeAt: NOW + 45_000 }, ctx).ok, 'cooldown blocks a click 15s after the last');
  assert(checkGates(limits, { ...base, lastTradeAt: NOW + 20_000 }, ctx).ok, 'cooldown clears after 40s');

  // Payout floor is checked against CLICK-time payout.
  assert(!checkGates(limits, base, { ...ctx, payout: 86 }).ok, 'payout below the floor is refused (86 < 90)');
  assert(checkGates(limits, base, { ...ctx, payout: 90 }).ok, 'payout exactly at the floor is accepted');

  // Sizing: flat percentage of CURRENT balance, hard cap, never a ladder.
  const rich = checkGates(limits, { ...base, balance: 500_000 }, ctx);
  assert(rich.ok && rich.stake === 1000, `maxStake caps the percentage (got ${rich.ok ? rich.stake : why(rich)})`);
  // A small ACCOUNT (not a drawdown — startBalance matches, so no stop fires).
  const poor = checkGates(limits, { ...base, balance: 50, startBalance: 50 }, ctx);
  assert(!poor.ok && /minimum/.test(why(poor)), `stake below the broker minimum is refused, not rounded up (got "${why(poor)}")`);
  // …and a real drawdown to the same balance stops the day instead.
  const wiped = checkGates(limits, { ...base, balance: 50 }, ctx);
  assert(!wiped.ok && /daily loss/.test(why(wiped)), 'the drawdown stop outranks the sizing check');

  // Sizing must SHRINK after losses, never grow. This is the anti-martingale.
  const after3 = checkGates(limits, { ...base, balance: 9_700, consecutiveLosses: 2 }, ctx);
  assert(after3.ok && after3.stake === 97, `stake shrinks with the balance after losses (got ${after3.ok ? after3.stake : ''})`);
  assert(after3.ok && after3.stake < 100, 'a losing run NEVER increases stake (no martingale path exists)');

  // Fixed cash stake overrides the percentage, and stays FLAT as the balance
  // moves — which is what keeps a research sample readable off the P&L.
  const flat: RiskLimits = { ...limits, stakeFixed: 1000, maxStake: 5000 };
  const f1 = checkGates(flat, { ...base, balance: 50_000, startBalance: 50_000 }, ctx);
  assert(f1.ok && f1.stake === 1000, `fixed stake wins over stakePct (got ${f1.ok ? f1.stake : why(f1)})`);
  const f2 = checkGates(flat, { ...base, balance: 48_000, startBalance: 50_000 }, ctx);
  assert(f2.ok && f2.stake === 1000, 'fixed stake does NOT grow after losses (no martingale)');
  assert(f2.ok && f1.ok && f2.stake === f1.stake, 'fixed stake is identical before and after a drawdown');
  const f3 = checkGates({ ...flat, maxStake: 500 }, { ...base, balance: 50_000, startBalance: 50_000 }, ctx);
  assert(f3.ok && f3.stake === 500, 'maxStake still caps a fixed stake');
  const f4 = checkGates(flat, { ...base, balance: 400, startBalance: 400 }, ctx);
  assert(!f4.ok && /exceeds balance/.test(why(f4)), 'fixed stake larger than the balance is refused');

  // Gate precedence: the demo check must win over a merely-blocking condition.
  const both = checkGates(limits, { ...base, openPositions: 1 }, { ...ctx, isDemo: false });
  assert(/NOT a demo/.test(why(both)), 'the account gate is evaluated before ordinary blocks');
}

// ── Daily roll + result folding ──────────────────────────────
console.log('\nRisk state transitions');
{
  const d1 = Date.parse('2026-08-06T23:59:00Z');
  const d2 = Date.parse('2026-08-07T00:01:00Z');
  const halted: RiskState = { ...freshState(10_000, d1), tradesToday: 30, consecutiveLosses: 5, halted: true, haltReason: 'x', balance: 9_000 };

  const same = rollDay(halted, d1 + 1000);
  assert(same.halted && same.tradesToday === 30, 'same UTC day keeps counters and the halt');

  const next = rollDay(halted, d2);
  assert(!next.halted && next.tradesToday === 0 && next.consecutiveLosses === 0, 'a new UTC day clears the daily halt and counters');
  assert(next.startBalance === 9_000, 'the new day baselines drawdown from the CURRENT balance, not the old one');

  let s = freshState(1000, d1);
  s = { ...s, openPositions: 1 };
  s = applyResult(s, 'loss', 980);
  assert(s.consecutiveLosses === 1 && s.openPositions === 0 && s.balance === 980, 'a loss increments the streak and closes the position');
  s = { ...s, openPositions: 1 };
  s = applyResult(s, 'loss', 960);
  assert(s.consecutiveLosses === 2, 'losses accumulate');
  s = { ...s, openPositions: 1 };
  s = applyResult(s, 'win', 1_043);
  assert(s.consecutiveLosses === 0, 'a win resets the consecutive-loss counter');
  s = { ...s, openPositions: 1 };
  s = applyResult(s, 'tie', 1_043);
  assert(s.consecutiveLosses === 0, 'a tie (refund) leaves the loss streak untouched');
}

// ── Trade direction (fade vs ride) ───────────────────────────
console.log('\nTrade direction');
{
  // Mirrors Executor.sideFor. Getting this backwards puts money on exactly the
  // wrong side of every signal, and the log would still look perfectly normal.
  const sideFor = (colour: 'green' | 'red', mode: 'fade' | 'ride'): 'buy' | 'sell' =>
    ((colour === 'red') === (mode !== 'ride') ? 'buy' : 'sell');

  assert(sideFor('red', 'fade') === 'buy', 'FADE a red streak → BUY (bet it bounces)');
  assert(sideFor('green', 'fade') === 'sell', 'FADE a green streak → SELL (bet it drops)');
  assert(sideFor('red', 'ride') === 'sell', 'RIDE a red streak → SELL (bet it keeps falling)');
  assert(sideFor('green', 'ride') === 'buy', 'RIDE a green streak → BUY (bet it keeps rising)');

  for (const c of ['red', 'green'] as const) {
    assert(sideFor(c, 'fade') !== sideFor(c, 'ride'), `fade and ride are exact opposites for a ${c} streak`);
  }
}

// ── Terminal parsing (broker number formats) ─────────────────
console.log('\nTerminal parsing');
{
  assert(parseAmount('45,050') === 45050, 'parses thousands separator');
  assert(parseAmount('45 050.25') === 45050.25, 'parses space grouping with decimals');
  assert(parseAmount('1.234,56') === 1234.56, 'parses European grouping');
  assert(parseAmount('$5,580') === 5580, 'strips currency symbols');
  // The payout node holds BOTH values: "+92%+$19.20". A generic amount parse
  // glues them into 9219.2, which would sail past the payout gate every time.
  assert(parsePercent('+92%+$19.20') === 92, 'parsePercent takes only the % value from a two-number node');
  assert(parsePercent('+86%') === 86, 'parsePercent on a clean percentage');
  assert(parsePercent('92.5%') === 92.5, 'parsePercent keeps decimals');
  assert(parsePercent('$19.20') === null, 'parsePercent returns null when there is no percentage');
  assert(parseAmount('+92%+$19.20') === 9219.2, 'parseAmount is the WRONG tool here — documents why parsePercent exists');
  assert(parseAmount('') === null && parseAmount(null) === null, 'empty/absent text is null, never 0');
  assert(parseAmount('abc') === null, 'non-numeric text is null (never a silent 0 stake)');

  assert(parseDuration('00:01:00') === 60, 'parses HH:MM:SS');
  assert(parseDuration('1:30') === 90, 'parses MM:SS');
  assert(parseDuration('60') === 60, 'parses bare seconds');
  assert(formatDuration(60) === '00:01:00', 'formats 60s for the terminal field');
  assert(formatDuration(300) === '00:05:00', 'formats 5m for the terminal field');

  // The probe prints "override with X" hints; deriving X from the key produced
  // PO_SEL_AMOUNT_INPUT for a var actually named PO_SEL_AMOUNT. Keep the map
  // and the selector list in lockstep so the hint is always correct.
  const selKeys = Object.keys(DEFAULT_SELECTORS).sort();
  const envKeys = Object.keys(SELECTOR_ENV).sort();
  assert(JSON.stringify(selKeys) === JSON.stringify(envKeys), 'every selector has an env-var mapping (probe hints stay correct)');
  assert(SELECTOR_ENV.amountInput === 'PO_SEL_AMOUNT', 'amountInput maps to PO_SEL_AMOUNT, not PO_SEL_AMOUNT_INPUT');

  // Pocket Option renders a DEPOSIT form with name="amount" beside a promo-code
  // checkbox. If that ever creeps back into the stake selector, the bot types
  // its stake into a top-up box. Pin it shut.
  assert(!DEFAULT_SELECTORS.amountInput.includes('name="amount"'),
    'the stake selector must NOT match input[name="amount"] (that is the deposit form)');
  assert(DEFAULT_SELECTORS.amountInput.includes('value__val'),
    'the stake selector targets the trade panel value block');
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILED ✗`}`);
process.exit(failures === 0 ? 0 : 1);
