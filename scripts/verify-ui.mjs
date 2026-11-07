/**
 * Headless interaction verification for Typsidian.
 * Drives the real app in Chrome: all three modes, click-to-source,
 * visual inline editing, outline jumps, theme toggle.
 * Restores sample-vault/welcome.typ after the destructive edit test.
 *
 * Run with: node scripts/verify-ui.mjs
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
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init) {
  const response = await fetch(`${API}${path}`, init);
  return response.json();
}

async function waitForServer(timeoutMs = 45000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(`${API}/api/health`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > timeoutMs) throw new Error('server did not become healthy');
    await sleep(500);
  }
}
await waitForServer();

const original = await api('/api/file?path=welcome.typ', { headers: {} });
const originalSource = original.source;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  defaultViewport: { width: 1680, height: 1050, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('.ts-page', { timeout: 45000 });
await sleep(1200);
const shot = async (name) => page.screenshot({ path: `${OUT}/${name}.png` });

// ---------------------------------------------------------------- boot ----
const boot = await page.evaluate(() => ({
  title: document.title,
  tabs: [...document.querySelectorAll('.tab__label')].map((el) => el.textContent),
  pages: document.querySelectorAll('.ts-page').length,
  blocks: document.querySelectorAll('.ts-block-outline').length,
  status: document.querySelector('.statusbar')?.textContent ?? '',
  hasEditor: !!document.querySelector('.pane--editor .cm-editor'),
  paperText: [...document.querySelectorAll('.ts-page__sheet .tsel')].map((el) => el.textContent).join('').slice(0, 80),
}));
check('app boots with a single welcome.typ tab', boot.tabs.length === 1, JSON.stringify(boot.tabs));
check('document title set', boot.title.includes('Typsidian'), boot.title);
check('typst page rendered with text', boot.pages >= 1 && boot.paperText.includes('Welcome'), boot.paperText);
check('source editor mounted', boot.hasEditor);
check('block outlines present', boot.blocks > 0, `${boot.blocks} outlines`);
await shot('01-split');

// ------------------------------------------------- click to source (split) --
const beforeLine = await page.evaluate(() => document.querySelector('.cm-activeLine')?.textContent ?? '');
const sheet = await page.$('.ts-page__sheet');
const box = await sheet.boundingBox();
// Click in the middle of the second paragraph area.
await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.33);
await sleep(600);
const afterJump = await page.evaluate(() => ({
  active: document.querySelector('.cm-activeLine')?.textContent ?? '',
  selection: window.getSelection()?.toString()?.slice(0, 40) ?? '',
  focused: document.activeElement?.className ?? '',
}));
check('clicking the rendered page moves the source caret', afterJump.active !== beforeLine, `${JSON.stringify(beforeLine.slice(0, 30))} -> ${JSON.stringify(afterJump.active.slice(0, 40))}`);
const scrollSync = await page.evaluate(() => {
  const scroller = document.querySelector('.ts-preview__scroller');
  return { scrollTop: scroller?.scrollTop ?? -1 };
});
check('preview shows the page stack', scrollSync.scrollTop >= 0);
await shot('02-jump-to-source');

// -------------------------------------------------------- outline jump -----
await page.click('.sidebar-tab:nth-child(2)');
await sleep(400);
const outlineCount = await page.evaluate(() => document.querySelectorAll('[class*="outline"] li, [class*="outline"] button').length);
check('outline lists headings', outlineCount > 3, `${outlineCount} items`);
await shot('03-outline');
// Jump via the outline to the last heading.
const outlineButtons = await page.$$('[class*="outline"] button');
if (outlineButtons.length) {
  await outlineButtons[outlineButtons.length - 1].click();
  await sleep(700);
  const jumped = await page.evaluate(() => document.querySelector('.cm-activeLine')?.textContent ?? '');
  check('outline click jumps the source caret', /What next|universal|design goal/.test(jumped), jumped.slice(0, 40));
}
await page.click('.sidebar-tab:nth-child(1)');
await sleep(300);

// ------------------------------------------------------------- visual ------
const modeButtons = await page.$$('.segmented__item');
await modeButtons[1].click();
await sleep(1200);
const visual = await page.evaluate(() => ({
  hint: document.querySelector('.ts-preview__hint')?.textContent ?? '',
  pages: document.querySelectorAll('.ts-page').length,
}));
check('visual mode shows the page stack', visual.pages >= 1, visual.hint);
// Hover a block, then click it to open the inline editor.
const sheet2 = await page.$('.ts-page__sheet');
const box2 = await sheet2.boundingBox();
await page.mouse.move(box2.x + box2.width * 0.4, box2.y + box2.height * 0.33);
await sleep(350);
const hoverOutline = await page.evaluate(() => document.querySelectorAll('.ts-block-outline--hover').length);
check('hovering a block shows an outline', hoverOutline > 0, `${hoverOutline} hover outlines`);
await page.mouse.click(box2.x + box2.width * 0.4, box2.y + box2.height * 0.33);
await sleep(1200);
const editorOpen = await page.evaluate(() => ({
  open: !!document.querySelector('.ts-inline-editor'),
  kind: document.querySelector('.ts-inline-editor__kind')?.textContent ?? '',
  actions: document.querySelectorAll('.ts-inline-editor__action').length,
  focusInEditor: !!document.activeElement?.closest('.ts-inline-editor'),
}));
check('clicking a block opens the inline editor', editorOpen.open, `kind=${editorOpen.kind}`);
check('inline editor offers block actions', editorOpen.actions > 0, `${editorOpen.actions} actions`);
await shot('04-inline-editor');

// Type into the inline editor and confirm the page re-typesets.
if (editorOpen.open) {
  await page.keyboard.type(' VISUALEDIT-MARKER', { delay: 25 });
  await sleep(1800);
  const afterType = await page.evaluate(() =>
    [...document.querySelectorAll('.ts-page__sheet .tsel')].map((el) => el.textContent).join(''),
  );
  check('typing in the inline editor re-typesets the page', afterType.includes('VISUALEDIT-MARKER'));
  await shot('05-inline-typing');
  await page.keyboard.press('Escape');
  await sleep(500);
  check('Escape closes the inline editor', !(await page.$('.ts-inline-editor')));
  const typedSource = (await api('/api/file?path=welcome.typ')).source;
  const markerCount = typedSource.split('VISUALEDIT-MARKER').length - 1;
  check('no keystroke duplication in source', markerCount === 1, `${markerCount} markers`);
  check(
    'block edit preserves the rest of the document',
    typedSource.includes('The universal document core') && typedSource.length > originalSource.length,
    `${typedSource.length} vs ${originalSource.length} chars`,
  );
}

// ------------------------------------------------------------ preview ------
const buttons2 = await page.$$('.segmented__item');
await buttons2[2].click();
await sleep(1000);
const preview = await page.evaluate(() => ({
  hint: document.querySelector('.ts-preview__hint')?.textContent ?? '',
  hasEditor: !!document.querySelector('.cm-editor'),
}));
check('preview mode hides the source editor', !preview.hasEditor, `pages visible`);
await shot('06-preview');

// ------------------------------------------------------- scroll sync ------
await (await page.$$('.segmented__item'))[0].click();
await sleep(900);
// Use a short viewport so the second page is genuinely out of view.
await page.setViewport({ width: 1680, height: 560, deviceScaleFactor: 2 });
await sleep(900);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.ts-page', { timeout: 45000 });
await sleep(1500);
const syncBefore = await page.evaluate(() => ({
  previewTop: document.querySelector('.ts-preview__scroller')?.scrollTop ?? 0,
  reveal: window.__typsidian.store.getSnapshot().revealBlockId,
}));
await page.evaluate(() => {
  const scroller = document.querySelector('.pane--editor .cm-scroller');
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
});
await sleep(2200);
const syncAfter = await page.evaluate(() => ({
  previewTop: document.querySelector('.ts-preview__scroller')?.scrollTop ?? 0,
  reveal: window.__typsidian.store.getSnapshot().revealBlockId,
}));
check(
  'scrolling the source moves the preview',
  syncAfter.previewTop > syncBefore.previewTop + 20 && syncAfter.reveal !== syncBefore.reveal,
  `${syncBefore.previewTop} -> ${syncAfter.previewTop}, block ${syncBefore.reveal} -> ${syncAfter.reveal}`,
);
await page.setViewport({ width: 1680, height: 1050, deviceScaleFactor: 2 });
await sleep(800);

// ------------------------------------------------------- shortcuts -------
await page.keyboard.down('Alt');
await page.keyboard.press('2');
await page.keyboard.up('Alt');
await sleep(900);
check('⌥2 switches to visual mode', await page.evaluate(() => document.querySelector('.ts-preview--visual') !== null));
await page.keyboard.down('Alt');
await page.keyboard.press('3');
await page.keyboard.up('Alt');
await sleep(700);
check('⌥3 switches to preview mode', await page.evaluate(() => document.querySelector('.ts-preview--preview') !== null));
await page.keyboard.down('Alt');
await page.keyboard.press('1');
await page.keyboard.up('Alt');
await sleep(700);

// ------------------------------------------------- right-click actions ----
const editorBox = await (await page.$('.pane--editor .cm-editor')).boundingBox();
const clickX = editorBox.x + Math.min(240, editorBox.width * 0.4);
const clickY = editorBox.y + editorBox.height * 0.35;
await page.mouse.click(clickX, clickY);
await sleep(300);
await page.mouse.click(clickX, clickY, { button: 'right' });
await sleep(900);
const menu = await page.evaluate(() => {
  const items = [...document.querySelectorAll('[role="menuitem"]')];
  return { count: items.length, labels: items.map((el) => el.textContent?.trim()).slice(0, 6) };
});
check('right-click exposes block actions', menu.count > 0, JSON.stringify(menu.labels));
await page.keyboard.press('Escape');
await sleep(300);

// -------------------------------------------------------------- theme -----
await page.click('.toolbar__group .icon-button:last-child');
await sleep(500);
const light = await page.evaluate(() => document.documentElement.dataset.theme);
check('theme toggle switches to light', light === 'light', light);
await shot('07-preview-light');
await page.click('.toolbar__group .icon-button:last-child');
await sleep(300);

// ------------------------------------------------------ split + verify -----
await (await page.$$('.segmented__item'))[0].click();
await sleep(1000);
const savedSource = (await api('/api/file?path=welcome.typ')).source;
check('visual edit reached the document', savedSource.includes('VISUALEDIT-MARKER'), `${savedSource.length} chars`);

// Restore the sample document.
await api('/api/file', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: 'welcome.typ', source: originalSource }),
});

// ---------------------------------------------------------- file switch ----
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[class*="tree"] button, [class*="tree"] [role="treeitem"]')];
  const target = rows.find((el) => el.textContent?.includes('showcase.typ'));
  target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await sleep(1800);
const switched = await page.evaluate(() => ({
  title: document.title,
  tabs: [...document.querySelectorAll('.tab__label')].map((el) => el.textContent),
}));
check('sidebar opens another document', switched.title.includes('showcase.typ'), JSON.stringify(switched.tabs));

// ------------------------------------------------------------- new file ----
const beforeTabs = await page.evaluate(() => document.querySelectorAll('.tab__label').length);
await page.click('.tab--new');
await sleep(1800);
const afterTabs = await page.evaluate(() => ({
  count: document.querySelectorAll('.tab__label').length,
  labels: [...document.querySelectorAll('.tab__label')].map((el) => el.textContent),
}));
check('new note button opens a tab', afterTabs.count === beforeTabs + 1, JSON.stringify(afterTabs.labels));
await shot('08-new-note');

// Clean up any note created by the test.
const workspace = await api('/api/workspace');
for (const file of workspace.files ?? []) {
  if (/^note-/.test(file.path)) {
    await api(`/api/file?path=${encodeURIComponent(file.path)}`, { method: 'DELETE' });
  }
}

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log('\n=== summary ===');
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log('failed:', failed.map((f) => f.name).join(', '));
await browser.close();
process.exit(failed.length ? 1 : 0);
