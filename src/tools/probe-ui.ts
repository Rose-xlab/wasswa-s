/**
 * Trade-panel selector probe. Opens the terminal, reports what each selector
 * resolves to, and PLACES NOTHING.
 *
 * Run this before enabling execution, and again any time Pocket Option ships a
 * redesign. The failure this prevents is the quiet one: a selector that no
 * longer matches makes `setAmount` a no-op, and the bot then trades whatever
 * stake happened to be in the box — or clicks a control that moved.
 *
 * Run:  npm run probe:ui
 */
import { config, paths } from '../config.js';
import { openPersistentContext, firstPage, dismissPopups, installNameShim } from '../lib/browser.js';
import {
  Terminal, DEFAULT_SELECTORS, SELECTOR_ENV, parseAmount, parseDuration, parsePercent,
  type TerminalSelectors,
} from '../exec/terminal.js';

/** Compact one-line description of a discovered input. */
function describeInput(i: Record<string, string>): string {
  const bits = [
    i.type && i.type !== 'text' ? `type=${i.type}` : '',
    i.name ? `name="${i.name}"` : '',
    i.id ? `id="${i.id}"` : '',
    i.placeholder ? `ph="${i.placeholder}"` : '',
    i.value ? `value="${i.value}"` : '',
  ].filter(Boolean).join(' ');
  return `${bits || '(no attrs)'}\n        class="${i.cls}"\n        parent="${i.parent}"`;
}

async function main(): Promise<void> {
  console.log('\n─────────────────────────────────────────────────────');
  console.log('  TRADE PANEL PROBE — reads only, places NO trades');
  console.log('─────────────────────────────────────────────────────\n');

  // Parser sanity, offline — cheap confidence that a weird locale format is
  // not going to be silently misread as a 1000x stake.
  const cases: [string, number | null][] = [
    ['45,050', 45050], ['45 050.25', 45050.25], ['$5,580', 5580], ['', null],
  ];
  for (const [text, want] of cases) {
    const got = parseAmount(text);
    console.log(`  parseAmount("${text}") = ${got} ${got === want ? '✓' : `✗ expected ${want}`}`);
  }
  // The payout widget holds TWO numbers in one node; a plain amount parse
  // concatenates them into a nonsense payout that would defeat the gate.
  const pay = parsePercent('+92%+$19.20');
  console.log(`  parsePercent("+92%+$19.20") = ${pay} ${pay === 92 ? '✓' : '✗ expected 92'}`);
  console.log(`  parseDuration("00:01:00") = ${parseDuration('00:01:00')} ✓\n`);

  const context = await openPersistentContext({ headless: false });
  await context.addInitScript(installNameShim); // parity with the scanner's page
  const page = await firstPage(context);
  console.log(`→ Opening ${config.poCabinetUrl} …`);
  await page.goto(config.poCabinetUrl, { waitUntil: 'domcontentloaded' }).catch((e) => console.log(`  (nav note: ${e.message})`));
  await page.waitForTimeout(4000);
  await dismissPopups(page);

  const terminal = new Terminal(page);
  const demo = await terminal.isDemo();
  console.log(`\n  ACCOUNT: ${demo.isDemo ? '✓ DEMO' : '✗ NOT DEMO'} — ${demo.detail}`);
  if (!demo.isDemo) {
    console.log('  ⚠ Execution will refuse to run here. Switch to the demo account:');
    console.log('    the balance dropdown at the top right → "QT Demo".');
  }

  console.log('\n  SELECTORS');
  const found = await terminal.probe();
  const missing: string[] = [];
  for (const [name, result] of Object.entries(found)) {
    console.log(`    ${name.padEnd(14)} ${result}`);
    if (result.startsWith('✗')) {
      missing.push(name);
      console.log(`      ↳ override with ${SELECTOR_ENV[name as keyof TerminalSelectors]} in .env`);
      console.log(`      ↳ current: ${(DEFAULT_SELECTORS as unknown as Record<string, string>)[name]}`);
    }
  }

  // Ambiguity is as dangerous as absence: two matches means the wrong one can
  // win. The stake selector in particular sits near a DEPOSIT form.
  const amountMatches = await terminal.countMatches(DEFAULT_SELECTORS.amountInput);
  console.log(`\n  stake selector matches ${amountMatches} visible element(s) — ${amountMatches === 1 ? '✓ unambiguous' : '⚠ must be exactly 1'}`);
  if (amountMatches > 1) console.log('    Narrow PO_SEL_AMOUNT before enabling execution.');

  console.log('\n  READINGS');
  console.log(`    balance     ${await terminal.readBalance() ?? 'UNREADABLE'}`);
  console.log(`    payout      ${await terminal.readPayout() ?? 'UNREADABLE'}%`);
  const exp = await terminal.ensureExpiry(config.shadow.expirySec);
  console.log(`    expiry      ${exp.got ?? 'UNREADABLE'}s  ${exp.ok ? '✓' : `✗ ${exp.reason}`}`);
  console.log(`    asset       ${await terminal.readAsset() ?? 'UNREADABLE'}`);

  // ── Discovery: stop guessing at selectors and list what is actually there ──
  console.log('\n  DISCOVERED INPUTS (trade panel closed)');
  const inputs = await terminal.discoverInputs();
  if (inputs.length === 0) console.log('    (none visible — is the trading terminal open?)');
  inputs.forEach((i, n) => console.log(`    [${n}] ${describeInput(i)}`));

  // The expiry is a DIV on this build, so discoverInputs can never see it.
  // Hunt for leaf elements whose text looks like a duration.
  if (missing.includes('timeInput') || !exp.ok) {
    console.log('\n  EXPIRY CANDIDATES (elements whose text looks like a duration)');
    const cands = await terminal.discoverText('^\\d{1,2}:\\d{2}(:\\d{2})?$');
    if (cands.length === 0) console.log('    (none found — is the trade panel visible?)');
    for (const c of cands) {
      console.log(`    "${c.text}"  <${c.tag} class="${c.cls}">`);
      console.log(`        parent="${c.parent}"  grandparent="${c.grandparent}"`);
    }
  }

  // assetSearch only exists while the picker is open — testing it closed is
  // meaningless. Re-test THAT SELECTOR ALONE the moment the picker opens; a
  // full probe sweep takes seconds, by which point the picker may have closed.
  let searchOk = !missing.includes('assetSearch');
  if (missing.includes('assetSearch')) {
    console.log('\n  ASSET SEARCH (re-tested with the picker OPEN)');
    if (await terminal.openAssetPicker()) {
      searchOk = await terminal.resolves(DEFAULT_SELECTORS.assetSearch);
      console.log(searchOk
        ? '    ✓ resolves once open — it simply cannot resolve while closed. Nothing to fix.'
        : '    ✗ still not found. Inputs that appeared with the picker open:');
      if (!searchOk) {
        const opened = await terminal.discoverInputs();
        const fresh = opened.filter((o) => !inputs.some((i) => i.cls === o.cls && i.name === o.name && i.placeholder === o.placeholder));
        fresh.forEach((i, n) => console.log(`    [+${n}] ${describeInput(i)}`));
      }
      await terminal.closeAssetPicker();
    } else {
      console.log('    (could not open the picker)');
    }
  }

  // assetSearch resolving only-when-open is expected, not a failure.
  const bad = missing.filter((m) => m !== 'assetSearch').length + (searchOk ? 0 : 1) + (exp.ok ? 0 : 1);
  console.log(`\n  ${bad === 0 ? '✓ every selector resolved' : `✗ ${bad} selector(s) missing — fix before EXECUTE_ENABLED=true`}`);
  if (bad > 0) {
    console.log('  Paste the DISCOVERED INPUTS block above and the exact selectors can be written for you.');
  }
  console.log(`  Kill switch: create ${paths.killSwitchFile} to stop execution at any time.`);
  console.log('\n  Press Ctrl+C to close.\n');

  await new Promise((r) => setTimeout(r, 120_000));
  await context.close();
}

main().catch((err) => { console.error('Probe failed:', err); process.exit(1); });
