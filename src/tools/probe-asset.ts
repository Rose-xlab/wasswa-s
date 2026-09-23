/**
 * Asset-picker probe. Opens the picker, dumps the DOM of the list, then runs
 * the REAL selectAsset() the executor uses at arming time.
 *
 * It changes the chart — that is the point, it is the thing being verified.
 * It never touches Buy or Sell, so no trade can result.
 *
 * Exists because guessing at Pocket Option's markup has now failed twice. The
 * live executor reported `no row matched "AUD/USD OTC"` and its diagnostic
 * listed the left sidebar (Top up / Trading / Finance …), which means the row
 * matcher was looking at the wrong part of the page entirely. Rather than
 * guess a third time, this prints the real structure so the selector can be
 * written from evidence.
 *
 * Run:  npm run probe:asset -- "AUD/USD OTC"
 */
import { config } from '../config.js';
import { openPersistentContext, firstPage, dismissPopups, installNameShim } from '../lib/browser.js';
import { Terminal, DEFAULT_SELECTORS } from '../exec/terminal.js';

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '').replace(/[/_-]/g, '');

async function main(): Promise<void> {
  const label = process.argv[2] ?? 'AUD/USD OTC';
  console.log('\n─────────────────────────────────────────────────────');
  console.log('  ASSET PICKER PROBE — inspects, then tests selection. NO trades.');
  console.log(`  target: "${label}"`);
  console.log('─────────────────────────────────────────────────────\n');

  const context = await openPersistentContext({ headless: false });
  await context.addInitScript(installNameShim); // or every evaluate below dies
  const page = await firstPage(context);
  await page.goto(config.poCabinetUrl, { waitUntil: 'domcontentloaded' }).catch((e) => console.log(`  (nav note: ${e.message})`));
  await page.waitForTimeout(4000);
  await dismissPopups(page);

  const terminal = new Terminal(page);
  console.log(`  chart currently shows: ${await terminal.readAsset() ?? 'UNREADABLE'}`);

  if (!(await terminal.openAssetPicker())) {
    console.log('  ✗ could not open the picker (assetButton did not click)');
    await context.close();
    return;
  }
  console.log('  ✓ picker opened');

  const search = await terminal.resolves(DEFAULT_SELECTORS.assetSearch);
  console.log(`  search box: ${search ? '✓ found' : '✗ NOT found'}`);

  const base = label.replace(/\s*OTC$/i, '').trim();
  for (const q of [...new Set([base, base.replace(/\//g, ''), base.split('/')[0] ?? base])]) {
    console.log(`\n  ── typing "${q}" ──`);
    const typed = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLInputElement | null;
      return Boolean(el);
    }, DEFAULT_SELECTORS.assetSearch.split(',')[0]!.trim());
    if (typed) {
      const box = page.locator(DEFAULT_SELECTORS.assetSearch.split(',')[0]!.trim()).first();
      await box.fill('').catch(() => {});
      await box.type(q, { delay: 30 }).catch(() => {});
    }
    await page.waitForTimeout(1200);

    // Dump EVERY visible element whose text mentions the asset, with the
    // ancestor chain — that chain is what a reliable selector is built from.
    // No inner named functions in here: tsx wraps them in __name(), which does
    // not travel into the page. The shim above covers it, but a diagnostic
    // should not depend on a shim to diagnose things.
    const rows = await page.evaluate((target) => {
      const out: Array<Record<string, string>> = [];
      for (const el of Array.from(document.querySelectorAll('*'))) {
        const text = (el.textContent ?? '').trim();
        if (!text || text.length > 60) continue;
        if (!text.toLowerCase().replace(/\s+/g, '').replace(/[/_-]/g, '').includes(target)) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const chain: string[] = [];
        let p: Element | null = el.parentElement;
        for (let i = 0; i < 3 && p; i++) { chain.push(`${p.tagName.toLowerCase()}.${String(p.className || '').split(' ')[0] || '?'}`); p = p.parentElement; }
        out.push({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className ?? '').slice(0, 60),
          text: text.slice(0, 50),
          kids: String(el.children.length),
          chain: chain.join(' < '),
          xy: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
        });
      }
      return out.slice(0, 14);
    }, norm(label));

    if (rows.length === 0) {
      console.log('    no visible element contains that text');
      const any = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll('*'))) {
          if (el.children.length !== 0) continue;
          const t = (el.textContent ?? '').trim();
          const r = el.getBoundingClientRect();
          if (t && t.length > 2 && t.length < 30 && r.width > 0 && r.height > 0 && r.x > 200) out.push(t);
        }
        return [...new Set(out)].slice(0, 25);
      });
      console.log(`    visible leaf text on the page: ${any.join(' | ')}`);
    } else {
      for (const r of rows) {
        console.log(`    <${r.tag} class="${r.cls}"> kids=${r.kids} @${r.xy}`);
        console.log(`        text: "${r.text}"`);
        console.log(`        ancestors: ${r.chain}`);
      }
      const exact = rows.filter((r) => norm(r.text ?? '') === norm(label));
      console.log(`\n    ${exact.length} element(s) whose text EXACTLY equals the label (normalised)`);
    }
  }

  await terminal.closeAssetPicker();
  await page.waitForTimeout(500);

  // ── The part that actually matters: run the REAL selectAsset() ──
  // Dumping the DOM only shows what is there; it does not prove the executor
  // can drive it. This calls the same method the executor calls at arming
  // time, so a pass here means arming works. It changes the chart. It places
  // no trades — nothing here touches Buy or Sell.
  console.log('\n  SELECT TEST — calling the real selectAsset() used by the executor');
  const before = await terminal.readAsset();
  const res = await terminal.selectAsset(label);
  await page.waitForTimeout(800);
  const after = await terminal.readAsset();
  console.log(`    before : ${before ?? 'UNREADABLE'}`);
  console.log(`    result : ${res.ok ? '✓ reported success' : `✗ ${res.reason}`}`);
  console.log(`    after  : ${after ?? 'UNREADABLE'}`);
  const norm2 = (s: string | null) => (s ?? '').toLowerCase().replace(/\s+/g, '').replace(/[/_-]/g, '');
  console.log(res.ok && norm2(after) === norm2(label)
    ? '\n  ✓ ARMING WORKS — the executor can select assets. You are clear to run the scanner.'
    : '\n  ✗ arming still broken — paste this block back.');

  console.log('\n  Press Ctrl+C to close.\n');
  await new Promise((r) => setTimeout(r, 120_000));
  await context.close();
}

main().catch((err) => { console.error('Probe failed:', err); process.exit(1); });
