/**
 * End-to-end verification of the packaged macOS app.
 *
 * Launches dist-app/mac-arm64/Typsidian.app with remote debugging, connects
 * over CDP (same devtools protocol as Chrome), and checks that:
 *   - the window loads the welcome screen from the bundled server,
 *   - the preload bridge and native-menu API exist,
 *   - a recent vault can be opened and typeset inside the app,
 *   - the app quits cleanly.
 *
 * Run: bun scripts/verify-app.mjs   (build first: bun run desktop:package)
 */
import puppeteer from 'puppeteer-core';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';

const APP = 'dist-app/mac-arm64/Typsidian.app';
const BINARY = `${APP}/Contents/MacOS/Typsidian`;
const PORT = 9333;
const OUT = '/tmp/typsidian-shots';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(BINARY)) {
  console.error(`missing app binary: ${BINARY}\nrun: bun run desktop:package`);
  process.exit(1);
}

// Make sure no other instance holds the single-instance lock.
try {
  execSync('pkill -f "Typsidian.app/Contents/MacOS/Typsidian"', { stdio: 'ignore' });
} catch {
  /* none running */
}
await sleep(1500);

// The harness shell may export ELECTRON_RUN_AS_NODE=1, which would turn the
// app into a plain Node process; strip it so we launch a real GUI app.
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const app = spawn(BINARY, [`--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  detached: false,
  env: childEnv,
});

let browser;
for (let attempt = 0; attempt < 60; attempt++) {
  await sleep(500);
  try {
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${PORT}`,
      defaultViewport: null,
    });
    break;
  } catch {
    /* not up yet */
  }
}
check('packaged app starts and exposes devtools', Boolean(browser));
if (!browser) {
  app.kill('SIGKILL');
  process.exit(1);
}

let page = null;
for (let attempt = 0; attempt < 60 && !page; attempt++) {
  const pages = (await browser.pages()).filter((candidate) => candidate.url().startsWith('http://127.0.0.1'));
  page = pages[0] ?? null;
  if (!page) await sleep(500);
}
check('window loads the bundled UI', Boolean(page), page?.url() ?? 'no page');
if (!page) {
  app.kill('SIGKILL');
  process.exit(1);
}

const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
await page.waitForSelector('[class*="welcome"], .ts-page', { timeout: 45000 });
await sleep(1500);

const shell = await page.evaluate(() => ({
  bridge: Boolean(window.typsidian?.isDesktop),
  platform: window.typsidian?.platform ?? null,
  appVersion: window.typsidian?.appVersion ?? null,
  menuApi: Object.keys(window.__typsidianMenu ?? {}),
  desktopChrome: document.documentElement.dataset.desktop,
  onWelcome: Boolean(document.querySelector('[class*="welcome"]')),
  recents: document.body.innerText.match(/recent vaults/gi)?.length ?? 0,
  title: document.title,
  userAgent: navigator.userAgent.includes('Electron'),
}));
check('runs inside Electron', shell.userAgent, shell.platform);
check('preload bridge is exposed', shell.bridge, shell.appVersion);
check('native menu API is wired', shell.menuApi.length >= 5, shell.menuApi.join(','));
check('hidden title bar chrome applied', shell.desktopChrome === 'mac', shell.desktopChrome);
check('app boots on the welcome screen', shell.onWelcome, shell.title);
await page.screenshot({ path: `${OUT}/40-app-welcome.png` });

// Open the most recent *existing* vault from the welcome screen.
const recents = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.welcome__row')].filter((el) => !el.hasAttribute('disabled'));
  return rows.map((el) => ({ text: el.textContent?.trim().slice(0, 80), missing: el.className.includes('missing') }));
});
console.log('   recents on welcome:', JSON.stringify(recents));
const opened = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.welcome__row:not(.welcome__row--missing)')];
  const row = rows[0];
  if (!row) return false;
  row.click();
  return true;
});
if (!opened) {
  // Fallback: drive the exposed menu API with the first vault from the server.
  const info = await page.evaluate(async () => (await fetch('/api/app')).json());
  const path = info?.recent?.find((vault) => vault.exists)?.root ?? info?.recent?.[0]?.root;
  console.log('   fallback openVault:', path);
  if (path) await page.evaluate((p) => window.__typsidianMenu?.openVault(p), path);
}
try {
  await page.waitForSelector('.ts-page', { timeout: 60000 });
} catch (error) {
  const state = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    welcome: Boolean(document.querySelector('[class*="welcome"]')),
    text: document.body.innerText.slice(0, 400),
    workspace: window.__typsidianMenu ? 'menu-api' : 'no-menu',
  }));
  console.log('   FAILED STATE:', JSON.stringify(state, null, 1));
  await page.screenshot({ path: `${OUT}/40-app-failed.png` });
  throw error;
}
await sleep(1800);
const editor = await page.evaluate(() => ({
  pages: document.querySelectorAll('.ts-page').length,
  tabs: [...document.querySelectorAll('.tab__label')].map((el) => el.textContent),
  blocks: document.body.innerText.includes('blocks'),
  status: document.querySelector('.statusbar')?.textContent?.slice(0, 120) ?? '',
}));
check('a vault opens inside the desktop app', editor.pages >= 1 && editor.tabs.length >= 1, JSON.stringify(editor.tabs));
check('typesetting works from the bundled server', editor.pages >= 1, editor.status);
await page.screenshot({ path: `${OUT}/41-app-editor.png` });

// Visual mode inside the packaged app.
await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('.segmented__item')];
  buttons[1]?.click();
});
await sleep(1500);
const visual = await page.evaluate(() => Boolean(document.querySelector('.ts-preview--visual')));
check('visual mode works in the packaged app', visual);
await page.screenshot({ path: `${OUT}/42-app-visual.png` });

check('no renderer console errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.disconnect();
app.kill('SIGTERM');
await sleep(1500);
let exited = false;
try {
  process.kill(app.pid, 0);
} catch {
  exited = true;
}
check('app quits cleanly', exited);

console.log('\n=== summary ===');
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log('failed:', failed.map((f) => f.name).join(', '));
process.exit(failed.length ? 1 : 0);
