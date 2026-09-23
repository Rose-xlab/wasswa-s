/**
 * Stage 2 executor — arms the terminal, fires on the rule, journals everything.
 *
 * THE ARMING CONSTRAINT (the thing that shapes this whole file): Pocket
 * Option's trade panel trades whatever asset the CHART is showing. Switching
 * assets means opening the picker, typing, waiting for the list — seconds. The
 * signal fires at a candle close and the entry is the very next candle's open,
 * so reacting to a signal by switching assets is structurally impossible.
 *
 * So the executor pre-arms: at `executeStreak − armMargin` it selects the
 * hottest candidate on the chart, and by the time the streak completes, the
 * click is the only thing left to do. One armed pair at a time — which also
 * gives the concurrency limit for free.
 *
 * The cost is real and is journaled honestly: a second pair completing its
 * streak while another is armed is recorded as `missed`, not quietly dropped.
 * A log of only the trades you managed to take is a survivorship-biased record
 * of your own reflexes.
 *
 * The entry rule mirrors the manual one: alert at 7, candle 8 confirms, enter
 * on candle 9 fading the run (red streak → BUY, green → SELL). In code that is
 * "when the streak reaches `executeStreak` (8), the candle that just closed is
 * number 8, so NOW is candle 9's open — click."
 */
import type { Page } from 'playwright';
import type { Candle } from '../scanner/candles.js';
import type { SetupFeatures } from '../scanner/features.js';
import type { TickBuffer } from '../scanner/tickbuf.js';
import { Terminal } from './terminal.js';
import { TradeJournal, type TradeRecord } from './journal.js';
import {
  applyResult, checkGates, describeState, freshState, rollDay,
  type RiskLimits, type RiskState,
} from './guards.js';

export interface ExecutorDeps {
  page: Page;
  ticks: TickBuffer;
  limits: RiskLimits;
  journalFile?: string;
  expirySec: number;
  /** 'fade' bets the streak breaks; 'ride' bets it continues. */
  direction: 'fade' | 'ride';
  /** Live payout lookup — payouts drift, so it is re-read at click time. */
  payoutOf: (symbol: string) => number | undefined;
  labelOf: (symbol: string) => string | undefined;
  log?: (msg: string) => void;
}

interface Armed {
  symbol: string;
  count: number;
  at: number;
}

export class Executor {
  private readonly terminal: Terminal;
  private readonly journal: TradeJournal;
  private readonly limits: RiskLimits;
  private state: RiskState;
  private armed: Armed | null = null;
  private arming = false;
  private placing = false;
  private ready = false;
  private demoDetail = 'unchecked';
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: ExecutorDeps) {
    this.terminal = new Terminal(deps.page);
    this.journal = new TradeJournal(deps.journalFile);
    this.limits = deps.limits;
    this.state = freshState(0, Date.now());
    this.log = deps.log ?? ((m) => console.log(m));
  }

  get tradeJournal(): TradeJournal { return this.journal; }
  get isReady(): boolean { return this.ready; }

  /**
   * Verify the account and read the opening balance. Execution stays disabled
   * until this succeeds — an executor that cannot read its own balance cannot
   * size a trade or detect a result, and must not be allowed to click.
   */
  async start(): Promise<boolean> {
    const demo = await this.terminal.isDemo();
    this.demoDetail = demo.detail;
    const balance = await this.terminal.readBalance();
    const expiry = await this.terminal.ensureExpiry(this.deps.expirySec);

    this.log(`  [exec] account: ${demo.detail}`);
    this.log(`  [exec] balance: ${balance ?? 'UNREADABLE'} | terminal expiry: ${expiry.got ?? 'unreadable'}s`);

    if (balance === null) {
      this.log('  [exec] ✗ cannot read balance — execution stays OFF. Run `npm run probe:ui` to fix selectors.');
      return false;
    }
    if (!expiry.ok) {
      this.log(`  [exec] ✗ ${expiry.reason}`);
      this.log('  [exec] execution stays OFF — every trade would be the wrong duration.');
      return false;
    }
    this.state = freshState(balance, Date.now());
    this.ready = true;
    this.log(`  [exec] armed and ready. ${describeState(this.limits, this.state)}`);
    return true;
  }

  /**
   * Called for every closed candle with the CURRENT streak state. Decides
   * whether to arm, fire, or do nothing.
   */
  async onStreak(
    symbol: string,
    count: number,
    colour: 'green' | 'red',
    candle: Candle,
    features?: SetupFeatures,
  ): Promise<void> {
    if (!this.ready) return;
    this.state = rollDay(this.state, Date.now());

    // ── Fire ──
    if (count >= this.limits.executeStreak) {
      // Arming is slow (asset switching takes seconds), so a streak can reach
      // the trigger while arm() is still in flight — live, USD/RUB armed at 7
      // and the arm landed only after the streak had already hit 8, so the
      // trade was recorded as missed with the correct pair sitting on screen.
      // The chart is the thing that actually matters, so ask it directly.
      let ready = this.armed?.symbol === symbol;
      if (!ready) {
        const label = this.deps.labelOf(symbol);
        if (label) ready = (await this.terminal.chartShows(label)).ok;
        if (ready) this.armed = { symbol, count, at: Date.now() };
      }
      if (ready) await this.fire(symbol, count, colour, candle, features);
      else this.recordMissed(symbol, count, colour, candle, features);
      return;
    }

    // ── Arm ──
    if (count >= this.limits.executeStreak - this.limits.armMargin) {
      if (!this.armed || count > this.armed.count) await this.arm(symbol, count);
    } else if (this.armed?.symbol === symbol) {
      this.armed = null; // its streak broke — release the chart
    }
  }

  private async arm(symbol: string, count: number): Promise<void> {
    if (this.arming || this.placing) return;
    const label = this.deps.labelOf(symbol);
    if (!label) return;
    this.arming = true;
    try {
      const res = await this.terminal.selectAsset(label);
      if (res.ok) {
        this.armed = { symbol, count, at: Date.now() };
        this.log(`  [exec] armed ${label} at streak ${count} — chart selected, awaiting ${this.limits.executeStreak}`);
      } else {
        this.log(`  [exec] ⚠ could not select ${label} — staying unarmed (${res.reason})`);
      }
    } finally { this.arming = false; }
  }

  /**
   * Trade direction for a streak of `colour`.
   *
   *   fade — the streak breaks: red → BUY,  green → SELL
   *   ride — the streak continues: red → SELL, green → BUY
   *
   * One place, so the fire path and the missed-signal log can never disagree
   * about which side was intended.
   */
  private sideFor(colour: 'green' | 'red'): 'buy' | 'sell' {
    const fading = this.deps.direction !== 'ride';
    return (colour === 'red') === fading ? 'buy' : 'sell';
  }

  /** Place the trade — side depends on `direction` (fade or ride). */
  private async fire(
    symbol: string, count: number, colour: 'green' | 'red',
    candle: Candle, features?: SetupFeatures,
  ): Promise<void> {
    if (this.placing) return;
    this.placing = true;
    const signalAt = Date.now();
    try {
      const entryTs = candle.periodStart + candle.timeframeSec;
      const direction = this.sideFor(colour);
      const payout = this.deps.payoutOf(symbol) ?? 0;
      const label = this.deps.labelOf(symbol);

      const base = {
        v: 1 as const,
        id: this.journal.nextId(symbol),
        at: new Date().toISOString(),
        symbol, label, direction, mode: this.deps.direction, colour, streak: count,
        payout, expirySec: this.deps.expirySec, entryTs,
        features,
      };

      // Re-verify the account on EVERY fire. A page can navigate, a session can
      // flip to the live account, and the check is cheap next to the mistake.
      const demo = await this.terminal.isDemo();
      this.demoDetail = demo.detail;

      const gate = checkGates(this.limits, this.state, {
        isDemo: demo.isDemo,
        payout,
        nowMs: signalAt,
        allowLive: process.env.PV_ALLOW_LIVE,
      });

      if (!gate.ok) {
        if (gate.halt) {
          this.state = { ...this.state, halted: true, haltReason: gate.reason };
          this.log(`  [exec] ⛔ HALTED: ${gate.reason}`);
        }
        this.journal.record({ ...base, status: 'refused', reason: gate.reason, stake: 0 });
        this.log(`  [exec] refused ${label ?? symbol}: ${gate.reason}`);
        return;
      }

      const stake = gate.stake;
      const strike = this.deps.ticks.priceAt(symbol, Date.now() / 1000) ?? undefined;
      const balanceBefore = (await this.terminal.readBalance()) ?? this.state.balance;

      if (this.limits.dryRun) {
        this.journal.record({
          ...base, status: 'dry-run', stake, strike, balanceBefore,
          reason: 'DRY_RUN=true', clickLatencyMs: Date.now() - signalAt,
        });
        this.log(`  [exec] 🧪 DRY RUN would ${direction.toUpperCase()} ${label ?? symbol} ${stake} @${payout}% (streak ${count})`);
        return;
      }

      // The chart can drift between arming and firing — a manual click, a PO
      // auto-switch, a reload. The panel trades whatever is on screen, so an
      // unverified assumption here puts money on a pair we never analysed.
      if (label) {
        const chart = await this.terminal.chartShows(label);
        if (!chart.ok) {
          const reason = `chart shows "${chart.actual ?? 'unreadable'}", expected "${label}" — refusing`;
          this.journal.record({ ...base, status: 'refused', reason, stake: 0 });
          this.log(`  [exec] ✗ ${reason}`);
          this.armed = null; // force a clean re-arm rather than trusting it again
          return;
        }
      }

      // Expiry is VERIFIED, not set — it is a div on this build, so a "set"
      // that silently no-ops would mean trading a 5-minute option believing it
      // was 1 minute. Check it before every click and refuse on mismatch.
      const expiry = await this.terminal.ensureExpiry(this.deps.expirySec);
      if (!expiry.ok) {
        this.journal.record({ ...base, status: 'refused', reason: expiry.reason ?? 'expiry check failed', stake });
        this.log(`  [exec] ✗ ${expiry.reason}`);
        return;
      }
      if (!(await this.terminal.setAmount(stake))) {
        const reason = 'could not set the stake — refusing to click blind';
        this.journal.record({ ...base, status: 'refused', reason, stake });
        this.log(`  [exec] ✗ ${reason}`);
        return;
      }

      // Latency is not cosmetic here: the option is struck at the click and
      // expires 60s later, so a slow click buys a different bet than the one
      // the signal described. The first live fill took 13.6s.
      const lateMs = Date.now() - signalAt;
      if (lateMs > 10_000) {
        const reason = `too slow to enter (${(lateMs / 1000).toFixed(1)}s after signal) — the entry candle has moved on`;
        this.journal.record({ ...base, status: 'refused', reason, stake });
        this.log(`  [exec] ✗ ${reason}`);
        return;
      }

      const click = await this.terminal.trade(direction);
      if (!click.ok) {
        this.journal.record({ ...base, status: 'refused', reason: click.reason ?? 'click failed', stake });
        this.log(`  [exec] ✗ click failed: ${click.reason}`);
        return;
      }

      // Reconcile: the stake should leave the balance the moment the position
      // opens. An unconfirmed click is the dangerous case — it may have landed.
      await this.deps.page.waitForTimeout(1200);
      const balanceAfter = await this.terminal.readBalance();
      const confirmed = balanceAfter !== null && balanceBefore - balanceAfter >= stake * 0.9;

      const rec: TradeRecord = {
        ...base, status: 'placed', stake, strike, balanceBefore,
        clickLatencyMs: Date.now() - signalAt, confirmed,
      };
      this.journal.record(rec);
      this.state = {
        ...this.state,
        tradesToday: this.state.tradesToday + 1,
        openPositions: this.state.openPositions + 1,
        lastTradeAt: Date.now(),
        balance: balanceAfter ?? this.state.balance,
      };
      this.log(`  [exec] ▶ ${direction.toUpperCase()} ${label ?? symbol} ${stake} @${payout}% ` +
        `(streak ${count}, ${click.latencyMs}ms${confirmed ? '' : ', ⚠ UNCONFIRMED'})`);
      this.armed = null;
    } finally { this.placing = false; }
  }

  private recordMissed(
    symbol: string, count: number, colour: 'green' | 'red',
    candle: Candle, features?: SetupFeatures,
  ): void {
    // Only journal the first candle of the run that qualified, not 9, 10, 11…
    if (count !== this.limits.executeStreak) return;
    this.journal.record({
      v: 1, id: this.journal.nextId(symbol), status: 'missed',
      reason: this.armed ? `chart armed to ${this.armed.symbol}` : 'no pair armed in time',
      at: new Date().toISOString(),
      symbol, label: this.deps.labelOf(symbol),
      direction: this.sideFor(colour), mode: this.deps.direction,
      colour, streak: count, payout: this.deps.payoutOf(symbol) ?? 0,
      expirySec: this.deps.expirySec, stake: 0,
      entryTs: candle.periodStart + candle.timeframeSec, features,
    });
  }

  /** Settle expired positions. Call on a timer with true epoch seconds. */
  async settle(nowSec: number): Promise<void> {
    if (!this.ready) return;
    for (const rec of this.journal.due(nowSec)) {
      const settlePrice = this.deps.ticks.priceAt(rec.symbol, rec.entryTs + rec.expirySec) ?? undefined;
      const balanceAfter = (await this.terminal.readBalance()) ?? undefined;
      const done = this.journal.settle(rec.id, { settlePrice, balanceAfter });
      if (!done) continue;

      const scored = done.brokerResult ?? done.result ?? 'unknown';
      this.state = applyResult(this.state, scored === 'unknown' ? 'tie' : scored, balanceAfter ?? this.state.balance);

      const disagree = done.result && done.brokerResult && done.result !== done.brokerResult
        ? ` ⚠ tick says ${done.result}, broker says ${done.brokerResult}` : '';
      this.log(`  [exec] ⏹ ${done.label ?? done.symbol} ${scored.toUpperCase()}` +
        `${done.pnl !== undefined ? ` ${done.pnl >= 0 ? '+' : ''}${done.pnl.toFixed(2)}` : ''}${disagree} | ${this.journal.summary()}`);

      if (this.state.consecutiveLosses >= this.limits.maxConsecutiveLosses && !this.state.halted) {
        this.state = { ...this.state, halted: true, haltReason: `${this.state.consecutiveLosses} consecutive losses` };
        this.log(`  [exec] ⛔ HALTED for the day: ${this.state.haltReason}`);
      }
    }
  }

  status(): string {
    if (!this.ready) return 'exec: OFF';
    const mode = `${(!this.limits.enabled ? 'observing' : this.limits.dryRun ? 'DRY RUN' : 'LIVE-ON-DEMO')} ${this.deps.direction.toUpperCase()}`;
    const armed = this.armed ? ` | armed ${this.armed.symbol.replace(/_otc$/, '')}@${this.armed.count}` : ' | unarmed';
    return `exec ${mode}${armed} | ${describeState(this.limits, this.state)} | ${this.journal.summary()}`;
  }

  shutdown(): void {
    this.journal.drain();
  }
}
