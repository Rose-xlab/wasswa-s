/**
 * Trade journal — every intended trade, whether it was placed, and what it did.
 *
 * This is the artefact that turns "the win rate has been around 70%" into a
 * falsifiable number. Recalled win rates run high in every trader; a journal
 * does not. It records the trades that were REFUSED and the signals that were
 * MISSED as well as the ones that filled, because a log of only the trades you
 * took is a survivorship-biased record of your own memory.
 *
 * Settlement is recorded twice on purpose:
 *   • `settlePrice` from the tick buffer — strike vs expiry price, which is the
 *     theoretical result and the thing comparable to the shadow log;
 *   • `pnl` from the observed BALANCE DELTA — the broker's actual verdict.
 * When those two disagree, believe the balance and go looking for why: that
 * gap is slippage, a rejected click, or a strike that landed somewhere other
 * than where the tick feed said it did. It is the single most valuable column
 * in the file.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SetupFeatures } from '../scanner/features.js';

export type TradeOutcome = 'win' | 'loss' | 'tie' | 'unknown';

export interface TradeRecord {
  v: 1;
  id: string;
  /** 'placed' = click issued, 'dry-run' = decided but not clicked,
   *  'refused' = a gate blocked it, 'missed' = signal fired on an unarmed pair. */
  status: 'placed' | 'dry-run' | 'refused' | 'missed';
  reason?: string;

  at: string;
  symbol: string;
  label?: string;
  direction: 'buy' | 'sell';
  /**
   * Which side this row took. Without it a log spanning a strategy change is
   * unreadable — you cannot tell a losing fade from a winning ride.
   */
  mode: 'fade' | 'ride';
  /** The streak's colour (NOT the trade direction — see `mode`). */
  colour: 'green' | 'red';
  streak: number;
  payout: number;
  expirySec: number;
  stake: number;

  /** True epoch of the intended entry — the entry candle's open. */
  entryTs: number;
  /** Milliseconds from the signal to the click landing. */
  clickLatencyMs?: number;
  /** Price from our tick buffer at click time. */
  strike?: number;

  balanceBefore?: number;
  balanceAfter?: number;
  /** Did the balance actually move by the stake? Unconfirmed clicks are suspect. */
  confirmed?: boolean;

  features?: SetupFeatures;

  // ── filled in at settlement ──
  settledAt?: string;
  settlePrice?: number;
  /** Result implied by strike vs settlePrice (tick-feed truth). */
  result?: TradeOutcome;
  /** Result implied by the balance delta (broker truth). */
  brokerResult?: TradeOutcome;
  pnl?: number;
}

export class TradeJournal {
  private readonly open = new Map<string, TradeRecord>();
  private readonly tally = { placed: 0, dryRun: 0, refused: 0, missed: 0, win: 0, loss: 0, tie: 0 };
  private seq = 0;

  constructor(private readonly file?: string) {
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  nextId(symbol: string): string {
    return `${Date.now().toString(36)}-${(++this.seq).toString(36)}-${symbol}`;
  }

  /** Record a decision. Only 'placed' trades stay open awaiting settlement. */
  record(rec: TradeRecord): void {
    if (rec.status === 'placed') { this.open.set(rec.id, rec); this.tally.placed++; return; }
    if (rec.status === 'dry-run') this.tally.dryRun++;
    else if (rec.status === 'refused') this.tally.refused++;
    else this.tally.missed++;
    this.write(rec);
  }

  /** Trades whose expiry has passed and which need settling. */
  due(nowSec: number): TradeRecord[] {
    return [...this.open.values()].filter((r) => nowSec >= r.entryTs + r.expirySec + 2);
  }

  /**
   * Close a trade out. `settlePrice` is from the tick buffer (may be absent for
   * a pair we rotated away from); `balanceAfter` is the broker's word.
   */
  settle(id: string, info: { settlePrice?: number; balanceAfter?: number }): TradeRecord | null {
    const rec = this.open.get(id);
    if (!rec) return null;
    this.open.delete(id);

    if (info.settlePrice !== undefined && rec.strike !== undefined) {
      const dir = rec.direction === 'buy' ? 1 : -1;
      const move = (info.settlePrice - rec.strike) * dir;
      rec.settlePrice = info.settlePrice;
      rec.result = move > 0 ? 'win' : move < 0 ? 'loss' : 'tie';
    } else {
      rec.result = 'unknown';
    }

    if (info.balanceAfter !== undefined && rec.balanceBefore !== undefined) {
      rec.balanceAfter = info.balanceAfter;
      const pnl = info.balanceAfter - rec.balanceBefore;
      rec.pnl = pnl;
      // The stake left the balance at open, so a win returns stake+profit.
      rec.brokerResult = pnl > 0.005 ? 'win' : pnl < -0.005 ? 'loss' : 'tie';
    }

    const scored = rec.brokerResult ?? rec.result ?? 'unknown';
    if (scored === 'win' || scored === 'loss' || scored === 'tie') this.tally[scored]++;

    rec.settledAt = new Date().toISOString();
    this.write(rec);
    return rec;
  }

  private write(rec: TradeRecord): void {
    if (this.file) fs.appendFileSync(this.file, `${JSON.stringify(rec)}\n`);
  }

  get openCount(): number { return this.open.size; }

  /** Flush anything still open (called at shutdown) so nothing is lost. */
  drain(): void {
    for (const rec of this.open.values()) { rec.result = 'unknown'; this.write(rec); }
    this.open.clear();
  }

  summary(): string {
    const t = this.tally;
    const decided = t.win + t.loss;
    const rate = decided > 0 ? `${((t.win / decided) * 100).toFixed(1)}%` : '—';
    return `trades: ${t.placed} placed${t.dryRun ? ` / ${t.dryRun} dry` : ''} | ${t.win}W ${t.loss}L (${rate})` +
      `${t.tie ? ` ${t.tie}T` : ''}${t.refused ? ` | ${t.refused} refused` : ''}${t.missed ? ` | ${t.missed} missed` : ''}`;
  }
}
