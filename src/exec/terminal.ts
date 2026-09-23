/**
 * Pocket Option trade-panel adapter.
 *
 * ⚠ THE SELECTORS BELOW ARE BEST-EFFORT and derived from the visible terminal
 * layout, not from a verified DOM dump. Pocket Option ships a React SPA with
 * hashed class names that change without notice, so every selector is
 * overridable from .env and every method REPORTS FAILURE rather than throwing
 * or silently doing nothing. Run `npm run probe:ui` to check what actually
 * resolves on your build before enabling execution — a mis-resolved selector
 * that quietly no-ops is how a bot ends up "trading" for an hour and placing
 * nothing, or worse, clicking the wrong control.
 *
 * Locator strategy is text/role-first (`BUY`, `SELL`, `Amount`, `Time`) because
 * visible copy survives a redeploy far more often than a hashed class does.
 */
import type { Page } from 'playwright';

export interface TerminalSelectors {
  balance: string;
  amountInput: string;
  timeInput: string;
  payout: string;
  buyButton: string;
  sellButton: string;
  assetButton: string;
  assetSearch: string;
}

/**
 * Which env var overrides which selector. Single source of truth so the probe
 * can print the *correct* variable name — deriving it from the key produced
 * `PO_SEL_AMOUNT_INPUT` for a var actually called `PO_SEL_AMOUNT`, which is a
 * hint that wastes an hour.
 */
export const SELECTOR_ENV: Record<keyof TerminalSelectors, string> = {
  balance: 'PO_SEL_BALANCE',
  amountInput: 'PO_SEL_AMOUNT',
  timeInput: 'PO_SEL_TIME',
  payout: 'PO_SEL_PAYOUT',
  buyButton: 'PO_SEL_BUY',
  sellButton: 'PO_SEL_SELL',
  assetButton: 'PO_SEL_ASSET',
  assetSearch: 'PO_SEL_ASSET_SEARCH',
};

/**
 * Asset-picker internals, confirmed against the live DOM:
 *
 *   ul.assets-block__alist > li.alist__item > a.alist__link > span.alist__label
 *
 * The LABEL span holds the clean name ("AUD/USD OTC"); the row above it holds
 * the name WITH the payout glued on ("AUD/USD OTC+92%"), which is why matching
 * on row text never worked. The click handler lives on the <a>, not the span.
 *
 * Kept out of TerminalSelectors on purpose: these only exist while the picker
 * is open, so the probe would report them permanently missing.
 */
export const ASSET_PICKER = {
  /** Scope for the search. Anything outside this is not an asset row — an
   *  unscoped scan once matched the left nav ("Top up | Trading | Finance…"). */
  container: process.env.PO_SEL_ASSET_LIST ?? '.assets-block, .drop-down-modal',
  /** Clickable ancestor of the label. */
  row: process.env.PO_SEL_ASSET_ROW ?? 'a.alist__link, li.alist__item',
};

/** Overridable via PO_SEL_* env vars; verify with `npm run probe:ui`. */
export const DEFAULT_SELECTORS: TerminalSelectors = {
  balance: process.env.PO_SEL_BALANCE ?? '.js-balance-demo, .balance-info-block__balance, [class*="balance"] [class*="value"]',
  // NOTE: `input[name="amount"]` is deliberately ABSENT. Pocket Option also
  // renders a DEPOSIT form with `name="amount"` (next to a promo-code
  // checkbox) — matching it would type the stake into a top-up box. The trade
  // panel's stake input carries no class of its own; its parent does.
  amountInput: process.env.PO_SEL_AMOUNT ?? '.value__val input, [class*="value__val"] input',
  // The expiry is a DIV, not an input — so it is verified, never typed into.
  // See ensureExpiry(). Set PO_SEL_TIME from the probe's candidate list.
  timeInput: process.env.PO_SEL_TIME ?? '.block--expiration-inputs .value__val, [class*="expiration"] [class*="value__val"], input[name="time"]',
  payout: process.env.PO_SEL_PAYOUT ?? '.block--payout .value--several-items, [class*="payout"] [class*="value"]',
  buyButton: process.env.PO_SEL_BUY ?? '.btn-call, button:has-text("BUY"), a:has-text("BUY")',
  sellButton: process.env.PO_SEL_SELL ?? '.btn-put, button:has-text("SELL"), a:has-text("SELL")',
  assetButton: process.env.PO_SEL_ASSET ?? '.current-symbol, [class*="current-symbol"]',
  // The class sits on the INPUT ITSELF (`input.search__field`) — an earlier
  // `.search__field input` looked for a child that does not exist. Only ever
  // resolvable while the asset picker is open.
  assetSearch: process.env.PO_SEL_ASSET_SEARCH ?? 'input.search__field, input[placeholder*="Search" i], .search__field',
};

/**
 * Parse a broker-formatted number: "45,050", "45 050.25", "$5,580", "+86%".
 * Thousands separators vary by locale and the currency/percent decoration is
 * inconsistent across widgets, so strip to digits and a single decimal point.
 */
export function parseAmount(text: string | null | undefined): number | null {
  if (!text) return null;
  const cleaned = text.replace(/[^\d.,-]/g, '').trim();
  if (cleaned === '') return null;
  // Last separator followed by 1-2 digits is a decimal point; everything else
  // is a grouping separator. "1,234.56" → 1234.56, "1.234,56" → 1234.56.
  const m = cleaned.match(/^(.*)([.,])(\d{1,2})$/);
  let normalized: string;
  if (m) normalized = `${m[1]!.replace(/[.,\s]/g, '')}.${m[3]!}`;
  else normalized = cleaned.replace(/[.,\s]/g, '');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract a PERCENTAGE from a node that may hold several numbers.
 *
 * Pocket Option's payout widget renders as a single text node containing both
 * values — "+92%+$19.20" — so a generic number parse strips the symbols and
 * concatenates them into 9219.20. That number then flows straight into the
 * payout gate, which would wave through every trade regardless of the real
 * payout. Match the digits immediately preceding a '%' and nothing else.
 */
export function parsePercent(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (!m) return null;
  const n = Number(m[1]!.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** "00:01:00" → 60. Also accepts "1:00" and a bare "60". */
export function parseDuration(text: string | null | undefined): number | null {
  if (!text) return null;
  const parts = text.trim().split(':').map((p) => Number(p.replace(/\D/g, '')));
  if (parts.some((p) => !Number.isFinite(p))) return null;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 1) return parts[0]!;
  return null;
}

/** Seconds → the terminal's "HH:MM:SS" field format. */
export function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

export interface ClickResult {
  ok: boolean;
  reason?: string;
  /** Wall-clock ms from method entry to the click landing. */
  latencyMs: number;
}

export class Terminal {
  constructor(
    private readonly page: Page,
    private readonly sel: TerminalSelectors = DEFAULT_SELECTORS,
  ) {}

  /** Which comma-alternative last worked, per selector — see first(). */
  private readonly resolved = new Map<string, string>();

  /**
   * First selector in a comma list that resolves to a visible element.
   *
   * Caches the winning alternative. Without this, every call re-walks the list
   * and pays the full timeout for each dead candidate: the fire path makes five
   * such calls, which is most of the 13.6-second click latency observed live —
   * an eternity on a 60-second option, where the strike moves while you wait.
   */
  private async first(selector: string, timeoutMs = 1500) {
    const known = this.resolved.get(selector);
    const parts = selector.split(',').map((s) => s.trim()).filter(Boolean);
    const ordered = known ? [known, ...parts.filter((p) => p !== known)] : parts;
    for (const part of ordered) {
      try {
        const loc = this.page.locator(part).first();
        await loc.waitFor({ state: 'visible', timeout: timeoutMs });
        this.resolved.set(selector, part);
        return loc;
      } catch { /* try the next candidate */ }
    }
    this.resolved.delete(selector);
    return null;
  }

  /**
   * Dismiss any open overlay (asset picker, promo modal) and confirm it is gone.
   *
   * A picker left open sits over the whole trade panel, so Playwright's
   * actionability checks block: `.current-symbol` clicks hit the full 30s
   * timeout and `setAmount` silently fails. Live, this produced six
   * `could not set the stake` refusals and a string of 30-second stalls during
   * which the executor could do nothing at all. Cheap to call, so call it
   * before anything that must not be obscured.
   */
  async closeOverlays(): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const open = await this.page.evaluate((sel) => {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
        return false;
      }, ASSET_PICKER.container).catch(() => false);
      if (!open) return true;
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.waitForTimeout(250);
    }
    return false;
  }

  private async textOf(selector: string): Promise<string | null> {
    const loc = await this.first(selector);
    if (!loc) return null;
    try {
      const tag = await loc.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
      if (tag === 'input') return await loc.inputValue();
      return (await loc.textContent())?.trim() ?? null;
    } catch { return null; }
  }

  /**
   * Is this a DEMO account? Both signals must agree, and a failure to read is
   * treated as NOT demo. Fail-closed is the only acceptable default here.
   */
  /** Cached label verdict — the URL half is always re-checked, see isDemo(). */
  private labelDemoAt = 0;
  private labelDemoWas = false;

  async isDemo(): Promise<{ isDemo: boolean; detail: string }> {
    const url = this.page.url();
    const urlSaysDemo = /\/demo-|\/demo\b/i.test(url);

    // The URL check is instant and is the strong signal — always re-read it.
    // The label check reads the whole page's innerText, which is slow enough
    // to matter on a 60s option, so cache it for a minute. A short cache is
    // safe because switching accounts changes the URL, which is not cached.
    if (Date.now() - this.labelDemoAt < 60_000) {
      return {
        isDemo: urlSaysDemo && this.labelDemoWas,
        detail: `url=${urlSaysDemo ? 'demo' : 'NOT-demo'} label=${this.labelDemoWas ? 'demo' : 'NOT-demo'} (cached) (${url})`,
      };
    }

    // Corroborate from the ACCOUNT WIDGET, not the whole page. Pocket Option
    // renders the mode next to the balance ("QT Demo USD / 45,050"), but that
    // sits far down the DOM behind the whole nav sidebar — an earlier version
    // of this check only read the first 4000 characters of body text and never
    // reached it, reporting a demo account as NOT-demo. Walk up from the
    // balance element instead, and only fall back to a full-page scan.
    let labelSaysDemo = false;
    try {
      const bal = await this.first(this.sel.balance, 2000);
      if (bal) {
        const region = await bal.evaluate((el) => {
          let node: HTMLElement | null = el as HTMLElement;
          for (let i = 0; i < 4 && node?.parentElement; i++) node = node.parentElement;
          return node?.innerText ?? '';
        });
        labelSaysDemo = /\bdemo\b/i.test(region);
      }
      if (!labelSaysDemo) {
        const body = await this.page.locator('body').innerText({ timeout: 2000 });
        labelSaysDemo = /\bdemo\b/i.test(body) && !/\blive account\b/i.test(body);
      }
    } catch { /* leave false — unreadable means NOT demo */ }

    this.labelDemoWas = labelSaysDemo;
    this.labelDemoAt = Date.now();
    return {
      isDemo: urlSaysDemo && labelSaysDemo,
      detail: `url=${urlSaysDemo ? 'demo' : 'NOT-demo'} label=${labelSaysDemo ? 'demo' : 'NOT-demo'} (${url})`,
    };
  }

  /** Every visible input on the page — powers selector discovery in the probe. */
  async discoverInputs(): Promise<Array<Record<string, string>>> {
    try {
      return await this.page.evaluate(() => {
        const out: Array<Record<string, string>> = [];
        for (const el of Array.from(document.querySelectorAll('input, [contenteditable="true"]'))) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const i = el as HTMLInputElement;
          out.push({
            tag: el.tagName.toLowerCase(),
            type: i.type ?? '',
            name: i.name ?? '',
            id: el.id ?? '',
            cls: String(el.className ?? '').slice(0, 70),
            placeholder: i.placeholder ?? '',
            value: String(i.value ?? '').slice(0, 20),
            parent: String((el.parentElement?.className ?? '')).slice(0, 60),
          });
        }
        return out;
      });
    } catch { return []; }
  }

  /** Does one specific selector resolve right now? Used to test the picker's
   *  search box the instant it opens, rather than after a full probe sweep
   *  (by which point the picker may have closed again). */
  async resolves(selector: string, timeoutMs = 2000): Promise<boolean> {
    return (await this.first(selector, timeoutMs)) !== null;
  }

  /** Open the asset picker so its search field becomes discoverable. */
  async openAssetPicker(): Promise<boolean> {
    const btn = await this.first(this.sel.assetButton);
    if (!btn) return false;
    try { await btn.click(); await this.page.waitForTimeout(900); return true; } catch { return false; }
  }

  async closeAssetPicker(): Promise<void> {
    await this.page.keyboard.press('Escape').catch(() => {});
  }

  async readBalance(): Promise<number | null> {
    return parseAmount(await this.textOf(this.sel.balance));
  }

  async readPayout(): Promise<number | null> {
    return parsePercent(await this.textOf(this.sel.payout));
  }

  async readExpiry(): Promise<number | null> {
    return parseDuration(await this.textOf(this.sel.timeInput));
  }

  /**
   * How many DISTINCT visible elements a selector reaches.
   *
   * Counting per comma-alternative and summing double-counts the common case
   * where two alternatives describe the same node, which reports a perfectly
   * unambiguous selector as ambiguous. Dedupe through a Set of the actual
   * elements. Playwright-only syntax (`:has-text`) is skipped — the check that
   * matters is on the stake field, which is plain CSS.
   */
  async countMatches(selector: string): Promise<number> {
    const parts = selector.split(',').map((s) => s.trim()).filter(Boolean);
    try {
      return await this.page.evaluate((ps) => {
        const seen = new Set<Element>();
        for (const p of ps) {
          try {
            for (const el of Array.from(document.querySelectorAll(p))) {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) seen.add(el);
            }
          } catch { /* not valid plain CSS — skip */ }
        }
        return seen.size;
      }, parts);
    } catch { return 0; }
  }

  /**
   * Find elements whose own text matches a pattern — used to locate the expiry
   * div, which discoverInputs() can never see because it is not an input.
   */
  async discoverText(pattern: string): Promise<Array<Record<string, string>>> {
    try {
      return await this.page.evaluate((src) => {
        const re = new RegExp(src);
        const out: Array<Record<string, string>> = [];
        for (const el of Array.from(document.querySelectorAll('div, span, p, b, strong'))) {
          if (el.children.length > 0) continue; // leaf nodes only
          const text = (el.textContent ?? '').trim();
          if (!re.test(text)) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          out.push({
            text,
            tag: el.tagName.toLowerCase(),
            cls: String(el.className ?? '').slice(0, 70),
            parent: String(el.parentElement?.className ?? '').slice(0, 70),
            grandparent: String(el.parentElement?.parentElement?.className ?? '').slice(0, 70),
          });
        }
        return out.slice(0, 12);
      }, pattern);
    } catch { return []; }
  }

  async readAsset(): Promise<string | null> {
    return (await this.textOf(this.sel.assetButton))?.replace(/\s+/g, ' ').trim() ?? null;
  }

  /**
   * Is the chart currently showing `label`?
   *
   * Checked immediately before every click. The executor arms a pair minutes
   * ahead of the signal, and in that window the chart can move underneath it —
   * a manual click, a Pocket Option auto-switch, a page reload. The trade panel
   * trades whatever is on screen, so an unverified assumption here means real
   * money on a pair we never analysed.
   */
  async chartShows(label: string): Promise<{ ok: boolean; actual: string | null }> {
    const actual = await this.readAsset();
    if (!actual) return { ok: false, actual };
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[/_]/g, '').trim();
    return { ok: norm(actual) === norm(label), actual };
  }

  /** Set the stake field. Verifies the value stuck before returning true. */
  async setAmount(amount: number): Promise<boolean> {
    await this.closeOverlays(); // an open picker makes this a silent no-op
    const loc = await this.first(this.sel.amountInput);
    if (!loc) return false;
    try {
      // fill() alone sets React inputs reliably and is far faster than
      // triple-click + per-character typing on the hot path.
      await loc.fill(String(amount), { timeout: 4000 });
      await loc.blur().catch(() => {});
      const got = parseAmount(await loc.inputValue());
      if (got !== null && Math.abs(got - amount) < 1) return true;
      // Some React inputs ignore fill(); fall back to real key events.
      await loc.click({ clickCount: 3, timeout: 3000 });
      await loc.type(String(amount), { delay: 15 });
      await loc.blur().catch(() => {});
      const retry = parseAmount(await loc.inputValue());
      return retry !== null && Math.abs(retry - amount) < 1;
    } catch { return false; }
  }

  /**
   * VERIFY the expiry rather than set it.
   *
   * On this build the Time field is a div, not an input — there is nothing to
   * type into, and a "set" that silently does nothing is the worst outcome
   * available (you would trade a 5-minute option believing it was 1 minute).
   * So: read it, and refuse the trade if it is not what we expect. You set
   * 00:01:00 by hand once; the bot checks it before every click.
   *
   * If a future redesign makes it a real input, this sets it and re-reads.
   */
  async ensureExpiry(seconds: number): Promise<{ ok: boolean; got: number | null; reason?: string }> {
    const loc = await this.first(this.sel.timeInput);
    if (!loc) return { ok: false, got: null, reason: 'expiry field not found — set PO_SEL_TIME (see npm run probe:ui)' };

    const isInput = await loc.evaluate((el) => el.tagName.toLowerCase() === 'input').catch(() => false);
    let got = parseDuration(isInput ? await loc.inputValue().catch(() => '') : await loc.textContent().catch(() => ''));
    if (got === seconds) return { ok: true, got };

    if (isInput) {
      try {
        await loc.click({ clickCount: 3 });
        await loc.fill('');
        await loc.type(formatDuration(seconds), { delay: 20 });
        await loc.blur().catch(() => {});
        got = parseDuration(await loc.inputValue());
        if (got === seconds) return { ok: true, got };
      } catch { /* fall through to the refusal below */ }
    }
    return {
      ok: false, got,
      reason: `terminal expiry is ${got === null ? 'unreadable' : `${got}s`}, need ${seconds}s — set the Time field to ${formatDuration(seconds)} by hand`,
    };
  }

  /**
   * Point the chart at `label` (the catalog's display name, e.g. "EUR/CHF OTC").
   * Slow — seconds — which is exactly why the executor pre-arms instead of
   * switching assets in response to a signal.
   */
  async selectAsset(label: string): Promise<{ ok: boolean; reason?: string }> {
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '').replace(/[/_-]/g, '');
    const current = await this.readAsset();
    if (current && norm(current) === norm(label)) return { ok: true };

    // A picker left open by an earlier attempt covers the asset button, and
    // the click then burns the full actionability timeout for nothing.
    await this.closeOverlays();

    const btn = await this.first(this.sel.assetButton);
    if (!btn) return { ok: false, reason: 'asset button not found' };

    try {
      await btn.click({ timeout: 5000 });
      const search = await this.first(this.sel.assetSearch, 3000);
      if (!search) { await this.closeAssetPicker(); return { ok: false, reason: 'search box did not appear' }; }

      // Pocket Option's search index does not necessarily hold the display
      // form: "EUR/CHF OTC" is shown, but the slash may not be searchable.
      // ("Avalanche OTC" works precisely because it has no separator.) Try the
      // plausible query shapes rather than assuming one.
      const base = label.replace(/\s*OTC$/i, '').trim();
      const queries = [...new Set([base, base.replace(/\//g, ''), base.replace(/\//g, ' '), base.split('/')[0] ?? base])];

      for (const q of queries) {
        await search.fill('');
        await search.type(q, { delay: 20 });
        await this.page.waitForTimeout(700);

        // Match on NORMALISED text so "EUR/CHF OTC" and "EURCHF OTC" both hit,
        // and click the row's clickable ancestor rather than the text node.
        // No inner named functions: tsx wraps them in __name(), which does not
        // travel into the page (installFeed shims it for the scanner, but this
        // must not silently depend on that).
        const clicked = await this.page.evaluate((arg) => {
          // Search ONLY inside the picker. An unscoped scan previously matched
          // the left nav and reported "no row matched" for every pair.
          const scopes = Array.from(document.querySelectorAll(arg.container));
          if (scopes.length === 0) return 'no-picker';

          // EXACT normalised match on the smallest element — the label span.
          // The list holds both "AUD/USD OTC" and "AUD/USD"; a loose match
          // would silently trade the wrong instrument.
          let best: Element | null = null;
          let bestLen = Infinity;
          for (const root of scopes) {
            for (const el of Array.from(root.querySelectorAll('*'))) {
              const text = (el.textContent ?? '').trim();
              if (!text || text.length > 40) continue;
              if (text.toLowerCase().replace(/\s+/g, '').replace(/[/_-]/g, '') !== arg.target) continue;
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              if (text.length < bestLen) { best = el; bestLen = text.length; }
            }
          }
          if (!best) return 'no-row';

          // The handler sits on the <a>, not the label span it contains.
          const clickable = (best.closest(arg.row) ?? best) as HTMLElement;
          clickable.click();
          return 'clicked';
        }, { target: norm(label), container: ASSET_PICKER.container, row: ASSET_PICKER.row });

        if (clicked !== 'clicked') continue;

        await this.page.waitForTimeout(900);
        const now = await this.readAsset();
        if (now && norm(now) === norm(label)) return { ok: true };
      }

      // Nothing matched — report what the picker actually offered so the next
      // fix is informed rather than another guess.
      const seen = await this.page.evaluate((container) => {
        const scopes = Array.from(document.querySelectorAll(container));
        if (scopes.length === 0) return ['(picker not open)'];
        const out: string[] = [];
        for (const root of scopes) {
          for (const el of Array.from(root.querySelectorAll('a, li'))) {
            const t = (el.textContent ?? '').trim();
            const r = el.getBoundingClientRect();
            if (t && t.length < 40 && r.width > 0 && r.height > 0) out.push(t);
          }
        }
        return [...new Set(out)].slice(0, 8);
      }, ASSET_PICKER.container).catch(() => [] as string[]);
      await this.closeAssetPicker();
      return { ok: false, reason: `no row matched "${label}"; picker showed: ${seen.join(' | ') || '(nothing readable)'}` };
    } catch (err) {
      await this.closeAssetPicker();
      return { ok: false, reason: (err as Error).message.slice(0, 100) };
    }
  }

  /** Click BUY (a rising bet) or SELL (a falling bet). */
  async trade(direction: 'buy' | 'sell'): Promise<ClickResult> {
    const t0 = Date.now();
    const loc = await this.first(direction === 'buy' ? this.sel.buyButton : this.sel.sellButton, 2000);
    if (!loc) return { ok: false, reason: `${direction} button not found`, latencyMs: Date.now() - t0 };
    try {
      await loc.click({ timeout: 3000 });
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      return { ok: false, reason: (err as Error).message.slice(0, 120), latencyMs: Date.now() - t0 };
    }
  }

  /** Which selectors resolve right now — powers `npm run probe:ui`. */
  async probe(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [name, selector] of Object.entries(this.sel)) {
      const loc = await this.first(selector, 1200);
      if (!loc) { out[name] = '✗ NOT FOUND'; continue; }
      const text = await this.textOf(selector);
      out[name] = `✓ "${(text ?? '').slice(0, 40)}"`;
    }
    return out;
  }
}
