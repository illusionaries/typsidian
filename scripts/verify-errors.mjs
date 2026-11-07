/**
 * Headless verification for error paths and block-kind editing:
 *  - diagnostics (status bar, Problems panel, editor underline) for a broken doc
 *  - recovering from the error by typing
 *  - heading inline edit keeps the `=` marker and heading level
 *  - multi-page document paging
 *
 * Run with: node scripts/verify-errors.mjs
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

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
const api = async (path, init) => (await fetch(`${API}${path}`, init)).json();

const TEST_FILE = 'zz-error-test.typ';
const BAD = '= Broken\n\nThis line calls #undefined_function_xyz(1) and should fail.\n';
const GOOD = '= Broken\n\nThis line is fixed now and should compile.\n';

await api(`/api/file?path=${TEST_FILE}`, { method: 'DELETE' }).catch(() => {});
await api('/api/file', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: TEST_FILE, source: BAD }),
});

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  defaultViewport: { width: 1680, height: 1050, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('.ts-page', { timeout: 45000 });
await sleep(1000);

// Open the broken document through the file tree filter.
await page.click('.sidebar input');
await page.keyboard.type('zz-error', { delay: 20 });
await sleep(700);
const openedViaTree = await page.evaluate((name) => {
  const rows = [...document.querySelectorAll('button, [role="treeitem"], li, [class*="file"], [class*="row"]')];
  const row = rows.find((el) => el.textContent?.trim() === name && el.offsetParent);
  if (!row) return false;
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
}, TEST_FILE);
await sleep(2500);
if (!(await page.evaluate(() => document.title)).includes('error')) {
  await page.evaluate((name) => window.__typsidian?.store.openFile(name), TEST_FILE);
  await sleep(2500);
}
check('broken document opened (tree or store)', (await page.evaluate(() => document.title)).includes('error'), await page.evaluate(() => document.title));

const diagnostics = await page.evaluate(() => {
  const status = document.querySelector('.statusbar')?.textContent ?? '';
  const underlines = document.querySelectorAll('.cm-diag-error, [class*="diag-error"], .cm-lintRange-error').length;
  return { status, underlines };
});
check('status bar reports the compile error', /error/i.test(diagnostics.status), diagnostics.status.slice(-80));
check('editor underlines the error range', diagnostics.underlines > 0, `${diagnostics.underlines} decorations`);

// Open the problems panel.
await page.evaluate(() => {
  const items = [...document.querySelectorAll('.statusbar__item--button')];
  items[0]?.click();
});
await sleep(400);
const panel = await page.evaluate(() => ({
  open: !!document.querySelector('.diagnostics-panel'),
  rows: [...document.querySelectorAll('.diagnostic-row__text')].map((el) => el.textContent),
}));
check('problems panel opens with the message', panel.open && panel.rows.length > 0, JSON.stringify(panel.rows));
await shot('09-diagnostics');
await page.keyboard.press('Escape');
await sleep(300);

// Fix the document by typing in the split-mode editor.
await page.click('.pane--editor .cm-content');
await sleep(300);
await page.keyboard.down('Meta');
await page.keyboard.press('a');
await page.keyboard.up('Meta');
await page.keyboard.type(GOOD, { delay: 8 });
await sleep(2500);
const fixed = await page.evaluate(() => {
  const status = document.querySelector('.statusbar')?.textContent ?? '';
  return { status, errorRows: document.querySelectorAll('.diagnostic-row').length };
});
check('fixing the source clears diagnostics', !/error/i.test(fixed.status) || fixed.errorRows === 0, fixed.status.slice(-60));

// Save explicitly, then check disk.
await page.keyboard.down('Meta');
await page.keyboard.press('s');
await page.keyboard.up('Meta');
await sleep(1200);
const disk = (await api(`/api/file?path=${encodeURIComponent(TEST_FILE)}`)).source;
check('Cmd+S wrote the file to the vault', disk.includes('fixed now'), disk.slice(0, 40));

// ------------------------------------------------------- heading editing ----
// Switch to visual mode and edit the heading (marker must survive).
await (await page.$$('.segmented__item'))[1].click();
await sleep(1200);
const sheet = await page.$('.ts-page__sheet');
const box = await sheet.boundingBox();
await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.1);
await sleep(1200);
const headingEditor = await page.evaluate(() => ({
  open: !!document.querySelector('.ts-inline-editor'),
  kind: document.querySelector('.ts-inline-editor__kind')?.textContent ?? '',
  text: document.querySelector('.ts-inline-editor .cm-content')?.textContent ?? '',
}));
check('heading opens an inline editor', headingEditor.open && /Heading/i.test(headingEditor.kind), `${headingEditor.kind} / ${JSON.stringify(headingEditor.text)}`);
if (headingEditor.open) {
  await page.keyboard.press('End');
  await page.keyboard.type(' EDITED', { delay: 25 });
  await sleep(1800);
  await page.keyboard.press('Escape');
  await sleep(600);
  const source = (await api(`/api/file?path=${encodeURIComponent(TEST_FILE)}`)).source;
  check('heading edit keeps the level marker', /^= Broken EDITED/m.test(source), source.split('\n')[0]);
  check('heading edit does not drop the body', source.includes('fixed now'));
}

// ------------------------------------------------------------- paging ------
await api(`/api/file?path=${encodeURIComponent(TEST_FILE)}`, { method: 'DELETE' });
const LONG_FILE = 'zz-long-test.typ';
await api(`/api/file?path=${encodeURIComponent(LONG_FILE)}`, { method: 'DELETE' }).catch(() => {});
const longSource = `#set page(paper: "a4", margin: 2.5cm)
#set text(size: 11pt)

= A long document

${Array.from({ length: 14 }, (_, index) => `== Section ${index + 1}\n\n${'#lorem(120)'}\n`).join('\n')}
`;
await api('/api/file', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: LONG_FILE, source: longSource }),
});
await (await page.$$('.segmented__item'))[2].click();
await sleep(400);
await page.evaluate((name) => window.__typsidian?.store.openFile(name), LONG_FILE);
await sleep(3500);
const paging = await page.evaluate(() => ({
  pages: document.querySelectorAll('.ts-page').length,
  pager: document.querySelector('.ts-preview__pager')?.textContent ?? '',
  status: document.querySelector('.statusbar')?.textContent ?? '',
}));
check('multi-page document renders all pages', paging.pages >= 2, `${paging.pages} pages, pager ${paging.pager}`);
await shot('10-multipage');
await api(`/api/file?path=${encodeURIComponent(LONG_FILE)}`, { method: 'DELETE' });

check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));

console.log('\n=== summary ===');
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log('failed:', failed.map((f) => f.name).join(', '));
await browser.close();
process.exit(failed.length ? 1 : 0);
