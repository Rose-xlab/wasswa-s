/**
 * Raw candle log — every closed candle, for every tracked pair.
 *
 * WHY THIS EXISTS: the shadow recorder is streak-ANCHORED. It writes a record
 * when a streak is N long and then goes quiet the moment the streak breaks. So
 * any question about what happens AFTER a reversal is unanswerable from it —
 * including the whole second and third leg of a multi-trade wave.
 *
 * Rather than guess in advance which follow-on pattern matters and instrument
 * that one, log the primitive. Candles are the raw material every candle-based
 * hypothesis is made of, so with this file on disk a new idea costs an analysis
 * script instead of another overnight collection run. That is the difference
 * between testing one idea a day and testing ten in an afternoon.
 *
 * Keys are terse because volume is real: ~50 pairs × 1440 candles/day ≈ 72k
 * lines/day, about 6 MB. Cheap for what it buys.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from './candles.js';

/** One line of candles.jsonl. */
export interface CandleRow {
  /** symbol */ s: string;
  /** periodStart, TRUE epoch seconds (clock-corrected) */ t: number;
  /** timeframe seconds */ tf: number;
  o: number; h: number; l: number; c: number;
  /** tick count */ n: number;
  /** payout % at the time, when known — drives break-even in analysis */ p?: number;
  /** display label, when known */ lb?: string;
}

export class CandleLog {
  private written = 0;
  private buf: string[] = [];

  constructor(private readonly file?: string, private readonly flushEvery = 50) {
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  write(candle: Candle, meta?: { payout?: number; label?: string }): void {
    if (!this.file) return;
    const row: CandleRow = {
      s: candle.symbol,
      t: candle.periodStart,
      tf: candle.timeframeSec,
      o: candle.open, h: candle.high, l: candle.low, c: candle.close,
      n: candle.ticks,
      ...(meta?.payout !== undefined ? { p: meta.payout } : {}),
      ...(meta?.label ? { lb: meta.label } : {}),
    };
    this.buf.push(JSON.stringify(row));
    this.written++;
    // Batched: one candle close can fan out across many pairs at once, and a
    // synchronous append per candle would stall the tick loop.
    if (this.buf.length >= this.flushEvery) this.flush();
  }

  flush(): void {
    if (!this.file || this.buf.length === 0) return;
    fs.appendFileSync(this.file, `${this.buf.join('\n')}\n`);
    this.buf = [];
  }

  get count(): number { return this.written; }
}
