/**
 * Execution risk gates — the only thing standing between "research tool" and
 * "unattended bot spending money".
 *
 * Deliberately a PURE function over an explicit state object: no Playwright, no
 * clock, no filesystem beyond the kill-switch probe. Every rule here is
 * therefore provable in the self-test, which is the point — this is the code
 * that must not have a bug you discover live.
 *
 * Order matters. Cheap, absolute gates come first (disabled, kill switch,
 * halted, wrong account) so that no amount of downstream logic can talk its way
 * past them. Sizing is computed LAST, after every reason to refuse has been
 * exhausted.
 *
 * The demo gate is not a preference. `isDemo` is a fact read from the live page
 * (URL + balance label), never a config flag, because a config flag is exactly
 * the thing that gets flipped at 2am "just to test something". Trading a real
 * account requires setting PV_ALLOW_LIVE to a sentinel string that nobody types
 * by accident.
 */
import fs from 'node:fs';

/** Opt-out sentinel for the demo gate. Anything else keeps demo enforcement on. */
export const LIVE_ACCOUNT_SENTINEL = 'I_UNDERSTAND_REAL_MONEY';

export interface RiskLimits {
  /** Master switch. False → the executor observes and journals, never clicks. */
  enabled: boolean;
  /** True → run the full pipeline (arm, decide, journal) but skip the click. */
  dryRun: boolean;
  /**
   * Flat cash stake. When > 0 this WINS over stakePct.
   *
   * Preferred while collecting research data: with a fixed stake every trade
   * weighs the same, so the win rate and the P&L tell the same story. A
   * percentage stake compounds, which makes the equity curve path-dependent —
   * the same 60 trades in a different order give a different final balance,
   * and you can no longer read the edge off the P&L. Switch to stakePct when
   * the goal changes from measuring to compounding.
   */
  stakeFixed: number;
  /** Stake as a % of current balance. Used only when stakeFixed is 0. */
  stakePct: number;
  /** Absolute stake ceiling, whatever the % says. */
  maxStake: number;
  /** Never stake less than this (broker minimum). */
  minStake: number;
  /** Refuse to trade a pair paying less than this at click time. */
  minPayout: number;
  maxConcurrent: number;
  maxTradesPerDay: number;
  /** Halt for the day after this many losses in a row. */
  maxConsecutiveLosses: number;
  /** Halt for the day at this drawdown from the day's starting balance. */
  dailyLossPct: number;
  /** Minimum gap between two clicks. */
  cooldownSec: number;
  /** Touch this file to stop execution immediately. */
  killSwitchFile: string;
  /** Streak length that triggers entry (their rule: confirm at 8, enter on 9). */
  executeStreak: number;
  /** Pre-select the chart when a streak reaches executeStreak − this. */
  armMargin: number;
}

export interface RiskState {
  /** UTC date key; a change resets the daily counters. */
  dayKey: string;
  startBalance: number;
  balance: number;
  tradesToday: number;
  consecutiveLosses: number;
  openPositions: number;
  /** Epoch ms of the last click. */
  lastTradeAt: number;
  halted: boolean;
  haltReason?: string;
}

export interface GateContext {
  /** Read from the live page — URL contains /demo- AND the balance reads Demo. */
  isDemo: boolean;
  /** Payout for the pair AT CLICK TIME, not at signal time. */
  payout: number;
  nowMs: number;
  /** Value of process.env.PV_ALLOW_LIVE. */
  allowLive?: string;
}

export type GateResult =
  | { ok: true; stake: number }
  | { ok: false; reason: string; halt?: boolean };

export const utcDayKey = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

export function freshState(balance: number, nowMs: number): RiskState {
  return {
    dayKey: utcDayKey(nowMs),
    startBalance: balance,
    balance,
    tradesToday: 0,
    consecutiveLosses: 0,
    openPositions: 0,
    lastTradeAt: 0,
    halted: false,
  };
}

/**
 * Roll the daily counters when the UTC date changes. A halt is a DAILY halt —
 * it clears with the day, which is the whole point of a daily stop.
 */
export function rollDay(state: RiskState, nowMs: number): RiskState {
  const key = utcDayKey(nowMs);
  if (key === state.dayKey) return state;
  return {
    ...state,
    dayKey: key,
    startBalance: state.balance,
    tradesToday: 0,
    consecutiveLosses: 0,
    halted: false,
    haltReason: undefined,
  };
}

/** True when the kill-switch file exists. Cheap enough to call per decision. */
export function killSwitchActive(file: string): boolean {
  try { return fs.existsSync(file); } catch { return false; }
}

/**
 * Decide whether a trade may be placed, and for how much.
 *
 * Returns `halt: true` on breaches that should stop the day, not just this
 * trade — the caller is expected to persist that into RiskState so the next
 * call short-circuits at the `halted` gate.
 */
export function checkGates(limits: RiskLimits, state: RiskState, ctx: GateContext): GateResult {
  if (!limits.enabled) return { ok: false, reason: 'execution disabled (EXECUTE_ENABLED=false)' };

  if (killSwitchActive(limits.killSwitchFile)) {
    return { ok: false, reason: `kill switch present (${limits.killSwitchFile})`, halt: true };
  }

  if (state.halted) return { ok: false, reason: `halted for the day: ${state.haltReason ?? 'unknown'}` };

  // The account gate. A fact about the live page, not a setting.
  if (!ctx.isDemo && ctx.allowLive !== LIVE_ACCOUNT_SENTINEL) {
    return { ok: false, reason: 'NOT a demo account — refusing to trade real money', halt: true };
  }

  // Drawdown stop, evaluated against the day's OPENING balance.
  if (state.startBalance > 0) {
    const ddPct = ((state.startBalance - state.balance) / state.startBalance) * 100;
    if (ddPct >= limits.dailyLossPct) {
      return { ok: false, reason: `daily loss ${ddPct.toFixed(1)}% ≥ ${limits.dailyLossPct}%`, halt: true };
    }
  }

  if (state.consecutiveLosses >= limits.maxConsecutiveLosses) {
    return { ok: false, reason: `${state.consecutiveLosses} consecutive losses ≥ ${limits.maxConsecutiveLosses}`, halt: true };
  }

  if (state.tradesToday >= limits.maxTradesPerDay) {
    return { ok: false, reason: `${state.tradesToday} trades today ≥ ${limits.maxTradesPerDay}` };
  }

  if (state.openPositions >= limits.maxConcurrent) {
    return { ok: false, reason: `${state.openPositions} open ≥ max concurrent ${limits.maxConcurrent}` };
  }

  const sinceLast = (ctx.nowMs - state.lastTradeAt) / 1000;
  if (state.lastTradeAt > 0 && sinceLast < limits.cooldownSec) {
    return { ok: false, reason: `cooldown ${sinceLast.toFixed(0)}s < ${limits.cooldownSec}s` };
  }

  // Payout is re-read at click time: it drifts, and break-even moves with it.
  if (ctx.payout < limits.minPayout) {
    return { ok: false, reason: `payout ${ctx.payout}% < floor ${limits.minPayout}%` };
  }

  // Sizing last — fixed cash or flat percentage, hard cap, never a ladder.
  const wanted = limits.stakeFixed > 0 ? limits.stakeFixed : (state.balance * limits.stakePct) / 100;
  const stake = Math.floor(Math.min(wanted, limits.maxStake));
  if (stake < limits.minStake) {
    return { ok: false, reason: `stake ${stake} < broker minimum ${limits.minStake}` };
  }
  if (stake > state.balance) {
    return { ok: false, reason: `stake ${stake} exceeds balance ${state.balance}` };
  }

  return { ok: true, stake };
}

/**
 * Fold a settled trade back into the risk state.
 *
 * Note what is absent: there is no path here that increases stake after a loss.
 * Sizing is either a flat cash amount or a flat percentage of the CURRENT
 * balance — constant or shrinking in drawdown, never growing. At a 55% win rate
 * a six-loss run arrives every 60–100 trades; recovering one unit after six
 * martingale steps costs 63, which is the mechanism that empties these
 * accounts. Not a setting — not written.
 */
export function applyResult(state: RiskState, result: 'win' | 'loss' | 'tie', newBalance: number): RiskState {
  return {
    ...state,
    balance: newBalance,
    openPositions: Math.max(0, state.openPositions - 1),
    consecutiveLosses: result === 'loss' ? state.consecutiveLosses + 1 : result === 'win' ? 0 : state.consecutiveLosses,
  };
}

/** Human-readable one-liner for status lines. */
export function describeState(limits: RiskLimits, state: RiskState): string {
  const dd = state.startBalance > 0
    ? (((state.balance - state.startBalance) / state.startBalance) * 100).toFixed(1)
    : '0.0';
  return `bal ${state.balance.toFixed(0)} (${Number(dd) >= 0 ? '+' : ''}${dd}%) | ${state.tradesToday}/${limits.maxTradesPerDay} trades` +
    ` | ${state.consecutiveLosses}L streak | open ${state.openPositions}${state.halted ? ` | ⛔ HALTED: ${state.haltReason}` : ''}`;
}
