/**
 * Shared browser bootstrap.
 *
 * We use a PERSISTENT Chrome profile (a real user-data dir on disk) rather than
 * a storageState snapshot. Pocket Option's login doesn't reliably survive a
 * storageState export (auth spans several domains + short-lived tokens), so the
 * persistent profile is what lets you log in ONCE and have every later run —
 * and eventually the always-on VPS scanner — reuse the logged-in session.
 *
 * The profile dir (.auth/chrome-profile) is gitignored. It can be copied to the
 * VPS to carry the session across machines.
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import fs from 'node:fs';
import { paths } from '../config.js';

export async function openPersistentContext(opts: { headless: boolean }): Promise<BrowserContext> {
  fs.mkdirSync(paths.chromeProfile, { recursive: true });
  return chromium.launchPersistentContext(paths.chromeProfile, {
    headless: opts.headless,
    viewport: opts.headless ? { width: 1440, height: 900 } : null,
    // Reduce the "automation" fingerprint a little; PO is picky about bots.
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

/**
 * Shim for tsx/esbuild's `keepNames` helper.
 *
 * esbuild rewrites `const f = () => {}` into `const f = __name(() => {}, "f")`,
 * and `__name` is defined at MODULE scope — it is not carried along when
 * Playwright serializes a callback into the page. Any page.evaluate containing
 * a named inner function therefore dies with `__name is not defined`.
 *
 * The scanner never hit this because installFeed shims `__name` as its first
 * act, so every evaluate on that page works. Tools that do not install the feed
 * must install this, or they fail where the scanner succeeds — which is exactly
 * how a diagnostic ends up less capable than the thing it is diagnosing.
 *
 * Must be passed to `context.addInitScript` BEFORE navigating.
 */
export function installNameShim(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.__name !== 'function') g.__name = (fn: unknown) => fn;
}

/** The first page of a persistent context, creating one if none exists. */
export async function firstPage(context: BrowserContext): Promise<Page> {
  return context.pages()[0] ?? (await context.newPage());
}

/**
 * Best-effort dismissal of Pocket Option promo/ad modals so they don't sit over
 * the terminal. Non-fatal: unknown popups are left for you to close by hand.
 */
export async function dismissPopups(page: Page): Promise<void> {
  const closeSelectors = [
    '[aria-label="Close"]',
    'button[class*="close" i]',
    'div[class*="modal" i] [class*="close" i]',
    '.popup__close',
    '.modal__close',
  ];
  try {
    await page.keyboard.press('Escape').catch(() => {});
    for (const sel of closeSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 300 }).catch(() => false)) {
        await el.click({ timeout: 500 }).catch(() => {});
      }
    }
  } catch {
    /* popups are best-effort; ignore */
  }
}
