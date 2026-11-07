/**
 * Multi-vault server tests: app home persistence, vault switching, guards and
 * the watcher→SSE lifecycle. Runs the real server on an ephemeral port.
 *
 *   bun scripts/test-vaults.mts
 *
 * Everything happens in a temp directory: TYPSIDIAN_HOME, the vault folders and
 * the sample-import destination are all redirected, so a developer's real
 * `~/.typsidian` and `~/Documents` are never touched.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  version?: string;
};

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
const startedAt = Date.now();

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  const suffix = detail ? `  — ${detail}` : '';
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${suffix}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Temp fixture
// ---------------------------------------------------------------------------

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'typsidian-vaults-'));
const home = path.join(tempRoot, 'home');
const documents = path.join(tempRoot, 'documents');
const vaultOne = path.join(tempRoot, 'vault-one');
const vaultTwo = path.join(tempRoot, 'vault-two');
const vaultThree = path.join(tempRoot, 'vault-three');
const sampleSource = path.join(REPO_ROOT, 'sample-vault');

fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(documents, { recursive: true });
fs.mkdirSync(vaultTwo, { recursive: true });
fs.writeFileSync(path.join(vaultTwo, 'note.typ'), '= Second vault\n\nhello from vault two\n');
fs.mkdirSync(vaultThree, { recursive: true });

// ---------------------------------------------------------------------------
// Ephemeral port + server child process
// ---------------------------------------------------------------------------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;

const serverLog: string[] = [];
const child = spawn(process.execPath, ['server/index.ts'], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    TYPSIDIAN_PORT: String(port),
    TYPSIDIAN_HOST: '127.0.0.1',
    TYPSIDIAN_HOME: home,
    TYPSIDIAN_SAMPLE_PARENT: documents,
    TYPSIDIAN_SAMPLE_VAULT: sampleSource,
    // Make sure the developer's own environment cannot leak a boot vault.
    TYPSIDIAN_VAULT: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout?.on('data', (chunk: Buffer) => serverLog.push(chunk.toString()));
child.stderr?.on('data', (chunk: Buffer) => serverLog.push(chunk.toString()));

let exited = false;
child.on('exit', () => {
  exited = true;
});

async function waitForServer(timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) return false;
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return true;
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  return false;
}

interface Reply<T = any> {
  status: number;
  body: T;
}

async function call<T = any>(pathname: string, init?: RequestInit): Promise<Reply<T>> {
  const response = await fetch(`${base}${pathname}`, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  let body: any = null;
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

const post = <T = any>(pathname: string, payload: unknown = {}): Promise<Reply<T>> =>
  call<T>(pathname, { method: 'POST', body: JSON.stringify(payload) });

const real = (target: string): string => {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
};

// ---------------------------------------------------------------------------
// SSE helper (the watcher must survive vault switches on one connection)
// ---------------------------------------------------------------------------

interface SseClient {
  frames: Array<Array<{ type: string; path: string }>>;
  close(): void;
  opened: boolean;
}

async function connectSse(): Promise<SseClient> {
  const controller = new AbortController();
  const client: SseClient = {
    frames: [],
    opened: false,
    close: () => controller.abort(),
  };
  const response = await fetch(`${base}/api/events`, {
    signal: controller.signal,
    headers: { Accept: 'text/event-stream' },
  });
  if (!response.ok || !response.body) throw new Error(`SSE failed: ${response.status}`);
  client.opened = true;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let breakIndex = buffer.indexOf('\n\n');
        while (breakIndex >= 0) {
          const frame = buffer.slice(0, breakIndex);
          buffer = buffer.slice(breakIndex + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              const parsed = JSON.parse(line.slice(5).trim());
              if (Array.isArray(parsed)) client.frames.push(parsed);
            } catch {
              // ignore partial frames
            }
          }
          breakIndex = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // aborted
    }
  })();
  return client;
}

async function waitForEvent(
  client: SseClient,
  predicate: (event: { type: string; path: string }) => boolean,
  timeoutMs = 4000,
): Promise<{ type: string; path: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of client.frames) {
      const hit = frame.find(predicate);
      if (hit) return hit;
    }
    await sleep(50);
  }
  return null;
}

function recentRoots(info: any): string[] {
  return Array.isArray(info?.recent) ? info.recent.map((entry: any) => entry.root) : [];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

try {
  const ready = await waitForServer();
  check('server boots with no vault', ready, ready ? serverLog[0]?.slice(0, 60) : serverLog.join('').slice(-200));
  if (!ready) throw new Error('server did not start');

  // --- boot state ---------------------------------------------------------
  const health = await call('/api/health');
  check('GET /api/health works without a vault', health.status === 200 && health.body.ok === true);
  check(
    'health reports the real package.json version',
    health.body.version === PKG.version,
    `${health.body.version} vs ${PKG.version}`,
  );
  check('health workspace is empty with no vault', health.body.workspace === '', JSON.stringify(health.body.workspace));

  const boot = await call('/api/app');
  check('GET /api/app returns AppInfo', boot.status === 200 && 'vault' in boot.body);
  check('app starts on the welcome screen (no vault)', boot.body.vault === null);
  check('app has no recent vaults at first boot', recentRoots(boot.body).length === 0, JSON.stringify(boot.body.recent));
  check('app home is TYPSIDIAN_HOME', boot.body.home === path.resolve(home), boot.body.home);
  check('app reports the package version', boot.body.version === PKG.version, boot.body.version);
  check('app reports the bundled sample vault', boot.body.sampleAvailable === true);
  check('config.json was not created before any vault op', !fs.existsSync(path.join(home, 'config.json')));

  // --- guards -------------------------------------------------------------
  const guarded = await Promise.all([
    call('/api/workspace'),
    post('/api/render', { path: 'x.typ', source: '= x' }),
    call('/api/file?path=x.typ'),
    call('/api/search?q=x'),
    post('/api/export/pdf', { path: 'x.typ', source: '= x' }),
    post('/api/file', { path: 'x.typ' }),
  ]);
  check(
    'document endpoints answer 409 without a vault',
    guarded.every((reply) => reply.status === 409),
    guarded.map((reply) => reply.status).join(','),
  );
  check(
    'the 409 uses the standard failure shape',
    guarded.every(
      (reply) => reply.body?.ok === false && reply.body?.error?.kind === 'bad-request' && reply.body?.error?.message === 'no vault open',
    ),
    JSON.stringify(guarded[0].body),
  );

  // --- open validation ----------------------------------------------------
  const missing = await post('/api/vault/open', { path: path.join(tempRoot, 'does-not-exist') });
  check('opening a missing folder is a 404', missing.status === 404, JSON.stringify(missing.body));
  check(
    'the 404 says which folder was missing',
    typeof missing.body?.error?.message === 'string' && missing.body.error.message.includes('does-not-exist'),
    missing.body?.error?.message,
  );
  const relative = await post('/api/vault/open', { path: 'relative/folder' });
  check('opening a relative path is a 400', relative.status === 400, JSON.stringify(relative.body));
  const noPath = await post('/api/vault/open', {});
  check('opening without a path is a 400', noPath.status === 400);

  // --- create vault -------------------------------------------------------
  const created = await post('/api/vault/create', { path: vaultOne });
  check('POST /api/vault/create opens the new vault', created.status === 200 && !!created.body.vault, JSON.stringify(created.status));
  check(
    'created vault root is canonical',
    created.body?.vault?.root === real(vaultOne),
    `${created.body?.vault?.root} vs ${real(vaultOne)}`,
  );
  const seeded = created.body?.vault?.files?.find((file: any) => file.path === 'welcome.typ');
  check('create seeds welcome.typ', Boolean(seeded), JSON.stringify(created.body?.vault?.files?.map((f: any) => f.path)));
  check(
    'seed document is a Typst heading',
    fs.readFileSync(path.join(vaultOne, 'welcome.typ'), 'utf8').includes('= '),
  );
  check('create remembers the vault as recent', recentRoots(created.body)[0] === real(vaultOne), JSON.stringify(recentRoots(created.body)));

  const configAfterCreate = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  check(
    'config.json persists recent vaults + lastVault',
    Array.isArray(configAfterCreate.recentVaults) &&
      configAfterCreate.recentVaults[0]?.root === real(vaultOne) &&
      configAfterCreate.lastVault === real(vaultOne),
    JSON.stringify(configAfterCreate),
  );
  check(
    'config writes are atomic (no temp files left behind)',
    fs.readdirSync(home).every((name) => !name.endsWith('.tmp')),
    JSON.stringify(fs.readdirSync(home)),
  );

  // --- render works now that a vault is open ------------------------------
  const welcomeSource = fs.readFileSync(path.join(vaultOne, 'welcome.typ'), 'utf8');
  const rendered = await post('/api/render', { path: 'welcome.typ', source: welcomeSource });
  check(
    'render works with a vault open',
    rendered.status === 200 && rendered.body?.ok === true && rendered.body?.pages?.length > 0,
    `${rendered.status} pages=${rendered.body?.pages?.length} diags=${rendered.body?.diagnostics?.length}`,
  );

  // --- switching + recency order + de-dupe --------------------------------
  const openedTwo = await post('/api/vault/open', { path: vaultTwo });
  check('POST /api/vault/open switches vaults', openedTwo.status === 200 && openedTwo.body?.vault?.root === real(vaultTwo));
  check(
    'recent list is newest first',
    JSON.stringify(recentRoots(openedTwo.body)) === JSON.stringify([real(vaultTwo), real(vaultOne)]),
    JSON.stringify(recentRoots(openedTwo.body)),
  );

  const reopenedOne = await post('/api/vault/open', { path: vaultOne });
  check(
    're-opening an existing vault de-duplicates instead of appending',
    JSON.stringify(recentRoots(reopenedOne.body)) === JSON.stringify([real(vaultOne), real(vaultTwo)]),
    JSON.stringify(recentRoots(reopenedOne.body)),
  );

  // --- missing recent folders are flagged --------------------------------
  await post('/api/vault/open', { path: vaultThree });
  await post('/api/vault/open', { path: vaultOne });
  // Canonical path has to be captured before the folder disappears.
  const canonicalThree = real(vaultThree);
  fs.rmSync(vaultThree, { recursive: true, force: true });
  const afterDelete = await call('/api/app');
  const missingEntry = (afterDelete.body.recent ?? []).find((entry: any) => entry.root === canonicalThree);
  check('recent entries expose an exists flag', Boolean(missingEntry) && missingEntry.exists === false, JSON.stringify(missingEntry));
  check(
    'the missing vault is still listed',
    recentRoots(afterDelete.body).includes(canonicalThree),
    JSON.stringify(recentRoots(afterDelete.body)),
  );

  // --- watcher survives a vault switch (SSE) ------------------------------
  const sse = await connectSse();
  await sleep(150);
  check('SSE stream connects', sse.opened);
  fs.writeFileSync(path.join(vaultOne, 'live-one.typ'), '= Live one\n');
  const firstEvent = await waitForEvent(sse, (event) => event.path === 'live-one.typ');
  check('watcher reports changes in the open vault', Boolean(firstEvent), JSON.stringify(firstEvent));

  await post('/api/vault/open', { path: vaultTwo });
  await sleep(250);
  fs.writeFileSync(path.join(vaultTwo, 'live-two.typ'), '= Live two\n');
  const secondEvent = await waitForEvent(sse, (event) => event.path === 'live-two.typ');
  check(
    'the same SSE connection follows the new vault after switching',
    Boolean(secondEvent),
    JSON.stringify(secondEvent),
  );
  check('the SSE stream stayed open across the switch', sse.opened && !exited);
  sse.close();

  // --- close vault --------------------------------------------------------
  const closed = await post('/api/vault/close');
  check('POST /api/vault/close returns the welcome state', closed.status === 200 && closed.body.vault === null);
  check('closing clears lastVault', JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).lastVault === null);
  const blockedRender = await post('/api/render', { path: 'welcome.typ', source: welcomeSource });
  check('render is blocked again after closing', blockedRender.status === 409, JSON.stringify(blockedRender.body));

  const reopened = await post('/api/vault/open', { path: vaultOne });
  const renderAgain = await post('/api/render', { path: 'welcome.typ', source: welcomeSource });
  check('re-opening a vault restores rendering', renderAgain.status === 200 && renderAgain.body?.ok === true);

  // --- recent removal -----------------------------------------------------
  const removed = await post('/api/recent/remove', { path: vaultTwo });
  check(
    'POST /api/recent/remove drops one entry',
    !recentRoots(removed.body).includes(real(vaultTwo)) && recentRoots(removed.body).includes(real(vaultOne)),
    JSON.stringify(recentRoots(removed.body)),
  );
  const removeMissing = await post('/api/recent/remove', { path: path.join(tempRoot, 'never-seen') });
  check('removing an unknown recent entry is harmless', removeMissing.status === 200 && removeMissing.body.ok !== false);

  // --- reveal -------------------------------------------------------------
  const reveal = await post('/api/vault/reveal', { path: vaultOne });
  check('POST /api/vault/reveal validates and echoes the folder', reveal.status === 200 && reveal.body.ok === true && reveal.body.path === real(vaultOne), JSON.stringify(reveal.body));
  const revealRelative = await post('/api/vault/reveal', { path: 'vault-one' });
  check('reveal rejects relative paths', revealRelative.status === 400);
  const revealMissing = await post('/api/vault/reveal', { path: path.join(tempRoot, 'gone') });
  check('reveal rejects missing folders', revealMissing.status === 404);

  // --- max recent ---------------------------------------------------------
  const many: string[] = [];
  for (let index = 0; index < 13; index++) {
    const dir = path.join(tempRoot, `many-${index}`);
    fs.mkdirSync(dir, { recursive: true });
    many.push(real(dir));
    await post('/api/vault/open', { path: dir });
  }
  const capped = await call('/api/app');
  const cappedRoots = recentRoots(capped.body);
  check('recent vaults are capped at 12', cappedRoots.length === 12, `${cappedRoots.length} entries`);
  check('the cap keeps the newest entry', cappedRoots[0] === many[12], `${cappedRoots[0]} vs ${many[12]}`);
  check('the cap drops the oldest entry', !cappedRoots.includes(many[0]), JSON.stringify(cappedRoots.slice(-2)));

  // Put the vault list back into a known state for the remaining checks.
  await post('/api/vault/open', { path: vaultOne });
  const settled = await call('/api/app');
  check('switching back gives a clean recent head', recentRoots(settled.body)[0] === real(vaultOne));

  // --- malformed config tolerates ----------------------------------------
  fs.writeFileSync(path.join(home, 'config.json'), '{ this is not json');
  const tolerant = await call('/api/app');
  check('malformed config.json does not break the app', tolerant.status === 200 && Array.isArray(tolerant.body.recent));
  check('malformed config degrades to an empty recent list', recentRoots(tolerant.body).length === 0, JSON.stringify(tolerant.body.recent));
  const recovered = await post('/api/vault/open', { path: vaultTwo });
  check('opening a vault rewrites a valid config', recovered.status === 200 && recentRoots(recovered.body)[0] === real(vaultTwo));
  const configRecovered = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  check(
    'config.json is valid JSON again',
    Array.isArray(configRecovered.recentVaults) && configRecovered.recentVaults.length === 1,
    JSON.stringify(configRecovered.recentVaults?.length),
  );

  // --- sample import ------------------------------------------------------
  const sampleFirst = await post('/api/vault/sample');
  const firstSampleRoot = sampleFirst.body?.vault?.root ?? '';
  check('POST /api/vault/sample imports and opens the sample', sampleFirst.status === 200 && firstSampleRoot.length > 0, firstSampleRoot);
  check('the sample is copied under the sample parent', firstSampleRoot.startsWith(real(documents)), `${firstSampleRoot} under ${real(documents)}`);
  check(
    'the imported sample contains the bundled documents',
    fs.existsSync(path.join(firstSampleRoot, 'welcome.typ')) && fs.existsSync(path.join(firstSampleRoot, 'showcase.typ')),
    JSON.stringify(fs.readdirSync(firstSampleRoot)),
  );
  const sampleSecond = await post('/api/vault/sample');
  const secondSampleRoot = sampleSecond.body?.vault?.root ?? '';
  check(
    'importing the sample twice uses a unique folder',
    secondSampleRoot !== firstSampleRoot && secondSampleRoot.length > 0,
    `${firstSampleRoot} -> ${secondSampleRoot}`,
  );
  check(
    'the imported sample renders',
    (await post('/api/render', {
      path: 'welcome.typ',
      source: fs.readFileSync(path.join(secondSampleRoot, 'welcome.typ'), 'utf8'),
    })).status === 200,
  );

  // --- TYPSIDIAN_VAULT (dev) boots straight into a vault -------------------
  const bootPort = await freePort();
  const bootLog: string[] = [];
  const bootChild = spawn(process.execPath, ['server/index.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      TYPSIDIAN_PORT: String(bootPort),
      TYPSIDIAN_HOST: '127.0.0.1',
      TYPSIDIAN_HOME: home,
      TYPSIDIAN_VAULT: vaultOne,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bootChild.stdout?.on('data', (chunk: Buffer) => bootLog.push(chunk.toString()));
  bootChild.stderr?.on('data', (chunk: Buffer) => bootLog.push(chunk.toString()));
  try {
    const bootBase = `http://127.0.0.1:${bootPort}`;
    let bootInfo: any = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${bootBase}/api/app`, { signal: AbortSignal.timeout(500) });
        if (response.ok) {
          bootInfo = await response.json();
          break;
        }
      } catch {
        // starting up
      }
      await sleep(100);
    }
    check('TYPSIDIAN_VAULT boots with that vault already open', bootInfo?.vault?.root === real(vaultOne), JSON.stringify(bootInfo?.vault?.root));
    const bootHealth = await fetch(`${bootBase}/api/health`, { signal: AbortSignal.timeout(1000) }).then((response) => response.json());
    check('health reports the boot vault', bootHealth.workspace === real(vaultOne), JSON.stringify(bootHealth.workspace));
  } finally {
    bootChild.kill('SIGTERM');
    await sleep(200);
    bootChild.kill('SIGKILL');
  }

  // --- a broken TYPSIDIAN_VAULT must not take the server down --------------
  const brokenPort = await freePort();
  const brokenLog: string[] = [];
  const brokenChild = spawn(process.execPath, ['server/index.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      TYPSIDIAN_PORT: String(brokenPort),
      TYPSIDIAN_HOST: '127.0.0.1',
      TYPSIDIAN_HOME: path.join(tempRoot, 'broken-home'),
      TYPSIDIAN_VAULT: path.join(tempRoot, 'missing-on-purpose'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  brokenChild.stdout?.on('data', (chunk: Buffer) => brokenLog.push(chunk.toString()));
  brokenChild.stderr?.on('data', (chunk: Buffer) => brokenLog.push(chunk.toString()));
  let brokenExited = false;
  brokenChild.on('exit', () => {
    brokenExited = true;
  });
  try {
    const brokenBase = `http://127.0.0.1:${brokenPort}`;
    let brokenInfo: any = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${brokenBase}/api/app`, { signal: AbortSignal.timeout(500) });
        if (response.ok) {
          brokenInfo = await response.json();
          break;
        }
      } catch {
        // starting up
      }
      await sleep(100);
    }
    check('a broken TYPSIDIAN_VAULT still boots to the welcome screen', brokenInfo?.vault === null && brokenInfo !== null);
    check('the broken vault boot warns instead of crashing', !brokenExited && brokenLog.join('').includes('could not open TYPSIDIAN_VAULT'), brokenLog.join('').split('\n').slice(-3).join(' | '));
  } finally {
    brokenChild.kill('SIGTERM');
    await sleep(200);
    brokenChild.kill('SIGKILL');
  }

  // --- health after all the churn ----------------------------------------
  const finalHealth = await call('/api/health');
  check('server is still healthy at the end', finalHealth.status === 200 && finalHealth.body.ok === true);
  check('server process never crashed', !exited);

  const elapsed = Date.now() - startedAt;
  check('suite runs in under 15s', elapsed < 15_000, `${elapsed}ms`);
} catch (error) {
  check('suite did not throw', false, error instanceof Error ? error.message : String(error));
} finally {
  try {
    child.kill('SIGTERM');
  } catch {
    // already gone
  }
  await sleep(250);
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log('failed:');
  for (const entry of failed) console.log(`  - ${entry.name}${entry.detail ? ` (${entry.detail})` : ''}`);
  if (serverLog.length) {
    console.log('\nserver log:');
    console.log(serverLog.join('').split('\n').slice(-30).join('\n'));
  }
  process.exit(1);
}
process.exit(0);
