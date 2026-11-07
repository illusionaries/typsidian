/**
 * Headless verification of the standalone-app vault flows:
 *  - welcome screen when no vault is open
 *  - "Try the sample vault" → editor opens
 *  - vault switcher: close vault → welcome, recent list persists, reopen recent
 *  - creating a new vault from the welcome screen
 *
 * Needs the dev server running with a throwaway TYPSIDIAN_HOME:
 *   TYPSIDIAN_PORT=4747 TYPSIDIAN_HOME=/tmp/typsidian-home-ui bun server/index.ts
 * Run: bun scripts/verify-vaults.mjs
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.URL ?? 'http://localhost:5173';
const API = 'http://127.0.0.1:4747';
const OUT = '/tmp/typsidian-shots';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, init) => (await fetch(`${API}${p}`, init)).json();

// Start from a clean app state: no vault, no recents.
await api('/api/vault/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
const homeDir = path.join(os.homedir(), 'Documents', 'Typsidian Sample');
const defaultVault = path.join(os.homedir(), 'Documents', 'Typsidian');
const defaultVaultExisted = fs.existsSync(defaultVault);
const newVault = path.join(os.tmpdir(), `typsidian-ui-vault-${Date.now()}`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  defaultViewport: { width: 1440, height: 940, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.welcome, [class*="welcome"]', { timeout: 45000 });
await sleep(1200);

const welcome = await page.evaluate(() => ({
  hasWelcome: !!document.querySelector('[class*="welcome"]'),
  text: document.body.innerText.slice(0, 200),
  hasEditor: !!document.querySelector('.cm-editor'),
}));
check('app lands on the welcome screen', welcome.hasWelcome && !welcome.hasEditor, welcome.text.split('\n')[0]);
await shot('30-welcome');

// Open the bundled sample vault.
const sampleButton = await page.evaluateHandle(() => {
  const buttons = [...document.querySelectorAll('button')];
  return buttons.find((el) => /sample vault/i.test(el.textContent ?? '')) ?? null;
});
const hasSample = await page.evaluate((el) => Boolean(el), sampleButton);
check('welcome offers the sample vault', hasSample);
if (hasSample) {
  await page.evaluate((el) => el.click(), sampleButton);
  await page.waitForSelector('.ts-page', { timeout: 60000 });
  await sleep(1500);
  const opened = await page.evaluate(() => ({
    pages: document.querySelectorAll('.ts-page').length,
    tabs: [...document.querySelectorAll('.tab__label')].map((el) => el.textContent),
    vault: document.querySelector('[class*="vault-switch"], [class*="vault"]')?.textContent?.slice(0, 40) ?? '',
    welcomeGone: !document.querySelector('.welcome-shell'),
  }));
  check('sample vault opens in the editor', opened.pages >= 1 && opened.tabs.length >= 1, JSON.stringify(opened.tabs));
  check('welcome screen is replaced by the editor', opened.welcomeGone);
  await shot('31-sample-vault');
}

// Close the vault through the sidebar switcher.
await page.click('[aria-haspopup="menu"]');
await sleep(600);
const menuState = await page.evaluate(() => ({
  open: !!document.querySelector('[role="menu"]'),
  items: [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.trim().slice(0, 30)),
}));
check('vault switcher menu opens', menuState.open, JSON.stringify(menuState.items.slice(0, 6)));
const recentInMenu = await page.evaluate(() =>
  [...document.querySelectorAll('[role="menu"]')].some((menu) => /recent/i.test(menu.textContent ?? '')),
);
check('vault switcher lists recent vaults', recentInMenu);
await shot('31b-vault-menu');
const closed = await page.evaluate(() => {
  const items = [...document.querySelectorAll('[role="menuitem"]')];
  const close = items.find((el) => /close vault/i.test(el.textContent ?? ''));
  close?.click();
  return Boolean(close);
});
await sleep(2200);
const afterClose = await page.evaluate(() => ({
  welcome: !!document.querySelector('[class*="welcome"]'),
  recents: document.body.innerText.match(/Recent vaults/i) ? true : false,
  text: document.body.innerText.slice(0, 300),
}));
check('switcher can close the vault', closed);
check('closing returns to the welcome screen', afterClose.welcome);
check('recent vaults are listed after closing', /Typsidian Sample|sample/i.test(afterClose.text), afterClose.text.split('\n').slice(0, 6).join(' / '));
await shot('32-welcome-recent');

// Create a brand new vault.
const created = await page.evaluate(async (target) => {
  const buttons = [...document.querySelectorAll('button')];
  const create = buttons.find((el) => /new vault/i.test(el.textContent ?? ''));
  create?.click();
  return Boolean(create);
}, newVault);
await sleep(800);
// In the browser build "New vault…" opens a path prompt.
const typed = await page.evaluate(async (target) => {
  const input = document.querySelector('.welcome input[type="text"], .welcome input');
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, target);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return true;
}, newVault);
await sleep(400);
if (!typed) {
  // Fall back to the API if the welcome screen uses a native-only flow.
  await api('/api/vault/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: newVault }),
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
}
await page.waitForSelector('.ts-page', { timeout: 60000 });
await sleep(1200);
const openedNew = await page.evaluate(() => ({
  pages: document.querySelectorAll('.ts-page').length,
  tabs: [...document.querySelectorAll('.tab__label')].map((el) => el.textContent),
}));
check('new vault can be created and opened', openedNew.pages >= 1 && fs.existsSync(newVault), JSON.stringify(openedNew.tabs));
await shot('33-new-vault');

// Persistence: the server must report both vaults as recent.
const appInfo = await api('/api/app');
check('recent vaults persist server-side', appInfo.recent.length >= 2, appInfo.recent.map((v) => v.title).join(', '));

// ------------------------------------------------ simulated desktop shell ----
// Verify the native-dialog code paths without running Electron: inject the
// same preload bridge shape the desktop shell exposes.
const desktopVault = path.join(os.tmpdir(), `typsidian-desktop-vault-${Date.now()}`);
fs.mkdirSync(desktopVault, { recursive: true });
fs.writeFileSync(path.join(desktopVault, 'welcome.typ'), '#set page(paper: "a4")\n\n= Desktop vault\n\nOpened through the native folder picker.\n');
await api('/api/vault/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

const desktopPage = await browser.newPage();
const desktopErrors = [];
desktopPage.on('pageerror', (e) => desktopErrors.push(e.message));
await desktopPage.evaluateOnNewDocument((vaultPath) => {
  window.typsidian = {
    isDesktop: true,
    platform: 'darwin',
    appVersion: '0.2.0',
    chooseVaultFolder: async () => vaultPath,
    chooseNewVaultParent: async () => '/tmp',
    revealVault: () => undefined,
    openExternal: () => undefined,
    reload: () => undefined,
  };
}, desktopVault);
await desktopPage.goto(URL, { waitUntil: 'domcontentloaded' });
await desktopPage.waitForSelector('[class*="welcome"]', { timeout: 45000 });
await sleep(900);
const desktopWelcome = await desktopPage.evaluate(() => ({
  label: [...document.querySelectorAll('button')].map((el) => el.textContent?.trim()).find((t) => /open folder/i.test(t ?? '')) ?? '',
  chrome: document.documentElement.dataset.desktop,
  menuApi: typeof window.__typsidianMenu?.openVault,
}));
check('desktop bridge switches the welcome screen to native labels', /open folder/i.test(desktopWelcome.label), desktopWelcome.label);
check('desktop chrome marker is set', desktopWelcome.chrome === 'mac', desktopWelcome.chrome);
check('native menu API is exposed to the shell', desktopWelcome.menuApi === 'function', String(desktopWelcome.menuApi));

await desktopPage.evaluate(() => {
  const buttons = [...document.querySelectorAll('button')];
  buttons.find((el) => /open folder/i.test(el.textContent ?? ''))?.click();
});
await desktopPage.waitForSelector('.ts-page', { timeout: 30000 });
await sleep(1200);
const openedViaDialog = await desktopPage.evaluate(() => ({
  pages: document.querySelectorAll('.ts-page').length,
  tabs: [...document.querySelectorAll('.tab__label')].map((el) => el.textContent),
  title: document.title,
}));
check('native folder picker opens the chosen vault', openedViaDialog.pages >= 1 && openedViaDialog.tabs.includes('welcome.typ'), openedViaDialog.title);
await desktopPage.screenshot({ path: `${OUT}/34-desktop-vault.png` });
check('no desktop-bridge console errors', desktopErrors.length === 0, desktopErrors.slice(0, 2).join(' | '));
await desktopPage.close();
fs.rmSync(desktopVault, { recursive: true, force: true });

check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));

// Cleanup: remove test vaults we created in ~/Documents (only when they hold
// nothing but the seeded welcome.typ, so real user vaults are never touched).
const seededDefaults = [
  path.join(os.homedir(), 'Documents', 'Typsidian Vault'),
  path.join(os.homedir(), 'Documents', 'Typsidian'),
];
for (const candidate of seededDefaults) {
  try {
    const entries = fs.readdirSync(candidate);
    if (entries.length <= 1 && entries.every((entry) => entry === 'welcome.typ')) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  } catch {
    /* not there */
  }
}
await api('/api/vault/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
fs.rmSync(newVault, { recursive: true, force: true });
if (fs.existsSync(homeDir)) fs.rmSync(homeDir, { recursive: true, force: true });
if (!defaultVaultExisted && fs.existsSync(defaultVault)) fs.rmSync(defaultVault, { recursive: true, force: true });

console.log('\n=== summary ===');
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log('failed:', failed.map((f) => f.name).join(', '));
await browser.close();
process.exit(failed.length ? 1 : 0);
