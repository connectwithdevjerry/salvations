/**
 * Walks a fresh HIVE and photographs it.
 *
 * Run by the Screenshots workflow against a built app and an empty database:
 * it signs up, builds a team, opens an assistant, visits every page, and
 * writes one PNG per stop into docs/screenshots. Each stop is on its own,
 * so a page that breaks costs one picture, not the tour; what happened is
 * written to docs/screenshots/tour.log.
 *
 * Playwright is resolved from TOOLS_DIR so the workspace lockfile stays as
 * it is. BASE_URL points at the running app.
 */
import { createRequire } from 'node:module';
import process from 'node:process';
import console from 'node:console';
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const toolsDir = process.env.TOOLS_DIR ?? process.cwd();
const require = createRequire(path.join(toolsDir, 'package.json'));
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3101';
const OUT = path.resolve(process.env.OUT_DIR ?? 'docs/screenshots');
mkdirSync(OUT, { recursive: true });
// Only this run's failures should be in the folder.
for (const stale of readdirSync(OUT)) if (stale.startsWith('failed-')) unlinkSync(path.join(OUT, stale));

const lines = [];
const log = (line) => { lines.push(`${new Date().toISOString()} ${line}`); console.log(line); };

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.setDefaultTimeout(20000);

/** The first-visit walkthrough sits over every page until it is skipped. */
async function dismissWalkthrough() {
  const skip = page.locator('button.ghost', { hasText: 'Skip' }).first();
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
    await page.waitForTimeout(400);
  }
}

async function settle(ms = 700) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await dismissWalkthrough();
  await page.waitForTimeout(ms);
}

async function shot(name, { fullPage = false } = {}) {
  await settle();
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage });
  log(`shot ${name}`);
}

async function go(route) {
  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
  await settle();
}

async function step(name, run) {
  try {
    await run();
  } catch (caught) {
    log(`FAILED ${name}: ${caught instanceof Error ? caught.message.split('\n')[0] : String(caught)}`);
    try { await page.screenshot({ path: path.join(OUT, `failed-${name}.png`) }); } catch { /* nothing to add */ }
  }
}

let ws = '';

await step('landing', async () => { await go('/'); await shot('01-landing'); });
await step('signin', async () => { await go('/signin'); await shot('02-signin'); });

await step('signup', async () => {
  await go('/signup');
  await page.fill('#name', 'Ada Okafor');
  await page.fill('#email', 'ada@hive-demo.test');
  await page.fill('#password', 'a-demo-password-that-is-long');
  await shot('03-signup');
  await page.click('button.primary[type=submit]');
  await page.waitForURL(/\/w\/[^/]+\//, { timeout: 90000 });
  ws = page.url().match(/\/w\/([^/]+)\//)[1];
  log(`workspace ${ws}`);
});

await step('trial', async () => {
  await go(`/w/${ws}/billing`);
  await shot('03b-trial-offer');
  await page.locator('input[type=checkbox]').first().check();
  await page.locator('button', { hasText: 'Start the free trial' }).click();
  await page.waitForTimeout(1500);
  await shot('03c-trial-started');
});

await step('team', async () => {
  await go(`/w/${ws}/agents/team`);
  await shot('04-team-picker');
  // Cards toggle, and some start ticked: set each one rather than press it.
  const wanted = new Set(['General manager', 'Marketing', 'Sales', 'Customer support', 'Finance', 'Operations']);
  const cards = page.locator('button.role-card');
  for (let i = 0; i < await cards.count(); i += 1) {
    const card = cards.nth(i);
    const name = (await card.locator('.role-name').textContent() ?? '').trim();
    const on = (await card.getAttribute('aria-pressed')) === 'true';
    if (wanted.has(name) !== on) await card.click();
  }
  await shot('05-team-picked');
  await page.click('.wizard-foot button.primary');
  await page.waitForURL(/\/agents(\?.*)?$/, { timeout: 90000 });
  await shot('06-assistants');
});

await step('assistant', async () => {
  await page.locator('a.agent-row', { hasText: 'Marketing' }).first().click();
  await page.waitForURL(/\/agents\/[^/?]+/);
  await shot('07-assistant-chat');
  for (const [label, name] of [['Speak', '08-speak'], ['Model', '09-model'], ['Integrations', '10-integrations']]) {
    await page.locator('button.agent-tab', { hasText: label }).click();
    await shot(name);
  }
});

await step('ways', async () => {
  await page.locator('button.agent-ways').click();
  await page.waitForSelector('.ways-dialog');
  await shot('11-ways-to-talk');
  for (const [app, name] of [['Telegram', '12-telegram'], ['Slack', '13-slack'], ['WhatsApp', '14-whatsapp'], ['Discord', '15-discord']]) {
    await page.locator('.ways-dialog .ways button', { hasText: app }).first().click();
    await shot(name);
    await page.locator('.ways-dialog button.link', { hasText: 'All the ways' }).click();
    await page.waitForTimeout(300);
  }
  await page.locator('.ways-dialog .ways-close').click();
});

const pages = [
  ['models', '16-models'], ['approvals', '17-approvals'], ['knowledge', '18-knowledge'], ['schedule', '19-schedule'],
  ['activity', '20-activity'], ['mcp', '21-mcp'], ['settings', '22-settings'], ['billing', '23-billing'],
];
for (const [route, name] of pages) {
  await step(route, async () => { await go(`/w/${ws}/${route}`); await shot(name); });
}

await step('admin-dashboard', async () => { await go(`/w/${ws}/admin`); await shot('24-admin-dashboard'); await shot('24b-admin-dashboard-full', { fullPage: true }); });
await step('platform-admin', async () => { await go('/admin'); await shot('25-platform-admin'); await shot('25b-platform-admin-full', { fullPage: true }); });
await step('wizard', async () => { await go(`/w/${ws}/agents/new`); await shot('26-new-assistant'); });
await step('import', async () => { await go(`/w/${ws}/agents/import`); await shot('27-import'); });

await step('phone', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await go(`/w/${ws}/agents`);
  await page.locator('a.agent-row', { hasText: 'Finance' }).first().click();
  await page.waitForURL(/\/agents\/[^/?]+/);
  await shot('28-phone-chat');
});

await browser.close();
writeFileSync(path.join(OUT, 'tour.txt'), `${lines.join('\n')}\n`);
