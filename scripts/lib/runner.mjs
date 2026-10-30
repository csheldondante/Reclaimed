// Round 112 (testspeed): the shared test runner — one place for the server, the browser, the page and the GPU's
// schedule, so a headless check starts in seconds instead of a minute and says what it needs of the GPU.
//
//   import { run } from './lib/runner.mjs';
//   await run({ name: 'mycheck', kind: 'behaviour' }, async (R) => {
//     const p = await R.level({ level: 'atlas', at: '11956,15471' });   // waits for the level, not a fixed sleep
//     await R.ticks(p, 600);                                             // sim time, not wall time
//     R.check('rivers wet', ok, detail);
//   });
//
// What it does for every check:
//   server   a production build (vite build, ~1.5 s, cached by the sources' content) served by a tiny static server
//            on this worktree's own port — no dev server, no on-demand transform, no 30 s first load. `--dev` (or
//            { dev: true }) runs Vite's dev server instead, for checks that import /src/... modules in the page.
//   browser  Chrome with a profile kept per worktree and slot (.testcache/chrome-<slot>): its GPU shader cache
//            survives between runs (the pipelines compiled once); the origin's storage (the world store's IndexedDB,
//            localStorage) is cleared before every page, so each check starts from a fresh world as before.
//            `node scripts/run.mjs daemon` keeps one Chrome up; checks then connect to it instead of launching.
//   kind     'behaviour' (states, sim-time speeds, coverage, pixels: may share the GPU, up to 3 at once) or
//            'timing' (frame cost: the GPU alone). The lease is a file in the OS temp dir shared by every worktree
//            (reclaimed-gpu/); `node scripts/run.mjs status` lists who holds the GPU. A timing check waits for the
//            behaviour checks to finish and keeps new ones out while it runs.
//   page     console errors, page errors and the fatal overlay fail the check; the boot timeline
//            (src/perf/boot-marks.ts: atlas, window, warmup, store …) is printed for every level opened.
//   size     behaviour checks default to a small window (412×915 at dpr 1); timing checks the phone proxy
//            (412×915, dpr 2.6) — pass { size, dpr } when a check depends on them.
import puppeteer from 'puppeteer-core';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = path.join(ROOT, '.testcache');
export const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const GPU_DIR = path.join(os.tmpdir(), 'reclaimed-gpu');
/** behaviour checks that may share the GPU at once */
export const BEHAVIOUR_SLOTS = Number(process.env.RECLAIMED_GPU_SLOTS ?? 3);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const since = () => ((Date.now() - t0) / 1000).toFixed(1);
export const log = (...a) => console.log(`[run ${since()}s]`, ...a);

// ---------------------------------------------------------------- the build and its server

/** the sources' content hash: a build is reused while nothing it's made of changed */
function sourceHash(root = ROOT) {
  const h = crypto.createHash('sha1');
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else {
        h.update(path.relative(root, f).split(path.sep).join('/'));
        h.update(fs.readFileSync(f));
      }
    }
  };
  // (everything at the top but what's not the game's: a build imports outside src/ too — data/ — and a file left out
  // of the hash would serve a stale build; round 112's self-check found data/ missing)
  for (const e of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (NOT_BUILT.has(e.name) || e.name.startsWith('.') || e.name.endsWith('.md')) continue;
    if (e.isDirectory()) walk(path.join(root, e.name));
    else {
      h.update(e.name);
      h.update(fs.readFileSync(path.join(root, e.name)));
    }
  }
  return h.digest('hex').slice(0, 12);
}

/** what's at the worktree's top that no build reads (everything else is hashed and copied) */
const NOT_BUILT = new Set(['node_modules', 'dist', 'docs', 'scripts', 'perf-reports', 'LICENSE', 'package-lock.json']);
/** the worktree's top-level entries a build is made of */
export const buildInputs = (root = ROOT) => fs.readdirSync(root).filter((n) => !NOT_BUILT.has(n) && !n.startsWith('.') && !n.endsWith('.md'));

/** a production build of the worktree (or `root`, a copy of its sources) as it is now (cached by content; built to a temp dir and renamed: concurrent runs don't clash) */
export function build(root = ROOT) {
  const t = Date.now();
  const hash = sourceHash(root);
  const out = path.join(CACHE, `build-${hash}`);
  if (fs.existsSync(path.join(out, 'index.html'))) return { dir: out, hash, ms: Date.now() - t, cached: true };
  fs.mkdirSync(CACHE, { recursive: true });
  const tmp = `${out}.tmp-${process.pid}`;
  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const r = spawnSync(process.execPath, [vite, 'build', '--outDir', tmp, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`vite build failed:\n${r.stdout}\n${r.stderr}`);
  try {
    fs.renameSync(tmp, out);
  } catch (e) {
    // (another run built the same sources meanwhile: theirs is the same — but only if it's there. Round 114: in a
    // sandboxed shell every directory rename in .testcache fails EPERM; there the build is copied instead, index.html
    // last, since a build counts as there once its index.html is — a run reading it meanwhile sees none yet)
    if (!fs.existsSync(path.join(out, 'index.html')) && e.code === 'EPERM') {
      fs.mkdirSync(out, { recursive: true });
      for (const n of fs.readdirSync(tmp)) if (n !== 'index.html') fs.cpSync(path.join(tmp, n), path.join(out, n), { recursive: true });
      fs.copyFileSync(path.join(tmp, 'index.html'), path.join(out, 'index.html'));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!fs.existsSync(path.join(out, 'index.html'))) throw new Error(`build: couldn't move ${tmp} to ${out} (${e.code ?? e.message}) and no other run's build is there`);
  }
  // (old builds of this worktree: keep the last few)
  const old = fs.readdirSync(CACHE).filter((d) => /^build-[0-9a-f]{12}$/.test(d)).map((d) => ({ d, t: fs.statSync(path.join(CACHE, d)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const o of old.slice(4)) fs.rmSync(path.join(CACHE, o.d), { recursive: true, force: true });
  return { dir: out, hash, ms: Date.now() - t, cached: false };
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.txt': 'text/plain', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.bin': 'application/octet-stream' };

/** this worktree's port: the same every run (the browser's caches are by origin), different from other worktrees' */
export function basePort() {
  const n = parseInt(crypto.createHash('sha1').update(ROOT.toLowerCase()).digest('hex').slice(0, 6), 16);
  return 6100 + (n % 180) * 10;
}

const probe = (port) =>
  new Promise((res) => {
    const q = http.get({ host: '127.0.0.1', port, path: '/__testbuild', timeout: 1500 }, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => res(r.statusCode === 200 ? b.trim() : `other:${r.statusCode}`));
    });
    q.on('error', () => res(null));
    q.on('timeout', () => (q.destroy(), res(null)));
  });

/** Serves a build on this worktree's port (or the next free); one already serving this same build is reused. */
export async function serveBuild(b = build()) {
  const p0 = basePort();
  for (let port = p0; port < p0 + 10; port++) {
    const there = await probe(port);
    if (there === b.hash) return { url: `http://127.0.0.1:${port}`, port, close: async () => {}, reused: true, build: b };
    if (there !== null) continue;
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname === '/__testbuild') return res.end(b.hash);
      // (the dev server's report sink: the build has none — a POST is answered, not written)
      if (u.pathname === '/__hitch') return res.end('not kept (test build)');
      // (the warm snapshots: src/sim/snapshot.ts — a page with ?warmsnap=<key> reads one, or saves the one it made)
      const sm = /^\/__snap\/([0-9a-f]{16,64})$/.exec(u.pathname);
      if (sm) return snapEndpoint(req, res, sm[1]);
      let f = path.normalize(path.join(b.dir, decodeURIComponent(u.pathname)));
      if (!f.startsWith(b.dir)) return (res.statusCode = 403), res.end();
      if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
      fs.readFile(f, (err, data) => {
        if (err) return (res.statusCode = 404), res.end('not found');
        res.setHeader('Content-Type', MIME[path.extname(f)] ?? 'application/octet-stream');
        // (hashed assets never change; the page itself is always asked again)
        res.setHeader('Cache-Control', f.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
        res.end(data);
      });
    });
    const ok = await new Promise((res) => {
      srv.once('error', () => res(false));
      srv.listen(port, '127.0.0.1', () => res(true));
    });
    if (!ok) continue;
    return { url: `http://127.0.0.1:${port}`, port, close: () => new Promise((r) => (srv.close(() => r()), srv.closeAllConnections())), reused: false, build: b };
  }
  throw new Error(`no free port in ${p0}..${p0 + 9} for the test build`);
}

export const SNAP_DIR = path.join(CACHE, 'snap');
function snapEndpoint(req, res, key) {
  const f = path.join(SNAP_DIR, `${key}.bin`);
  if (req.method === 'POST') {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    const tmp = `${f}.tmp-${process.pid}-${Date.now()}`;
    const w = fs.createWriteStream(tmp);
    req.pipe(w);
    w.on('finish', () => {
      fs.renameSync(tmp, f);
      res.end('saved');
    });
    w.on('error', (e) => ((res.statusCode = 500), res.end(String(e))));
    return;
  }
  if (!fs.existsSync(f)) return (res.statusCode = 404), res.end('no snapshot');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(f).pipe(res);
}
/** a warm snapshot's key: the build and the level's URL (every setting the world is made from) */
export function snapKey(buildHash, params) {
  const q = Object.entries(params).filter(([k]) => k !== 'warmsnap').map(([k, v]) => `${k}=${v}`).sort().join('&');
  return crypto.createHash('sha1').update(`${buildHash}?${q}`).digest('hex').slice(0, 24);
}

/** Vite's dev server (for checks that import /src/... in the page): started on a free port, closed after */
export async function serveDev({ force = false } = {}) {
  const p0 = basePort() + 5;
  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [vite, '--port', String(p0), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let outp = '';
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error(`vite dev didn't start:\n${outp}`)), 60000);
    const on = (c) => {
      outp += c;
      if (/ready in|Local:/.test(outp)) (clearTimeout(to), res());
    };
    child.stdout.on('data', on);
    child.stderr.on('data', on);
    child.on('exit', (c) => rej(new Error(`vite dev exited ${c}:\n${outp}`)));
  });
  return { url: `http://127.0.0.1:${p0}`, port: p0, close: async () => void child.kill(), reused: false, dev: true };
}

// ---------------------------------------------------------------- the GPU's schedule

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
/** the leases held now (stale ones — their process gone — removed) */
export function leases() {
  fs.mkdirSync(GPU_DIR, { recursive: true });
  const out = [];
  for (const f of fs.readdirSync(GPU_DIR)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(GPU_DIR, f);
    try {
      const l = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!alive(l.pid)) fs.rmSync(p, { force: true });
      else out.push({ ...l, file: p });
    } catch {
      /* (being written) */
    }
  }
  return out;
}
/**
 * Takes the GPU for a check: 'timing' alone, 'behaviour' with up to BEHAVIOUR_SLOTS others. Waits its turn (a
 * waiting timing check holds new behaviour checks back so it isn't starved). Returns the release.
 */
export async function lease(kind, name) {
  if (kind !== 'behaviour' && kind !== 'timing') throw new Error(`check kind "${kind}": 'behaviour' or 'timing'`);
  fs.mkdirSync(GPU_DIR, { recursive: true });
  const me = path.join(GPU_DIR, `${process.pid}-${Date.now()}.json`);
  const rec = { pid: process.pid, kind, name, cwd: ROOT, since: new Date().toISOString(), state: 'waiting' };
  fs.writeFileSync(me, JSON.stringify(rec));
  let said = false;
  for (;;) {
    const ls = leases().filter((l) => l.file !== me);
    const held = ls.filter((l) => l.state === 'held');
    const timingWaiting = ls.some((l) => l.kind === 'timing' && l.state === 'waiting' && l.since < rec.since);
    const ok = kind === 'timing' ? held.length === 0 : !held.some((l) => l.kind === 'timing') && !timingWaiting && held.length < BEHAVIOUR_SLOTS;
    if (ok) break;
    if (!said) log(`waiting for the GPU (${held.map((l) => `${l.kind}:${l.name}`).join(', ') || 'a timing check queued'})`);
    said = true;
    await sleep(1000);
  }
  fs.writeFileSync(me, JSON.stringify({ ...rec, state: 'held', since: new Date().toISOString() }));
  const release = () => fs.rmSync(me, { force: true });
  process.once('exit', release);
  return release;
}

// ---------------------------------------------------------------- the browser

const DAEMON = path.join(CACHE, 'daemon.json');
export const CHROME_ARGS = ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];

/** a profile dir no other Chrome is using now (a lock file in it; the GPU shader cache stays in it between runs) */
function profileSlot() {
  fs.mkdirSync(CACHE, { recursive: true });
  for (let i = 0; i < 8; i++) {
    const dir = path.join(CACHE, `chrome-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, 'runner.lock');
    try {
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      if (pid && alive(pid)) continue;
    } catch {
      /* free */
    }
    fs.writeFileSync(lock, String(process.pid));
    return { dir, free: () => fs.rmSync(lock, { force: true }) };
  }
  throw new Error('eight Chromes from this worktree at once: none free');
}

/** Chrome: the daemon's when one is up (and not `fresh`), else launched on a kept profile (`fresh`: a new empty one) */
export async function browser({ fresh = false, daemon = !fresh, extraArgs = [] } = {}) {
  // (more Chrome switches — a gate's --disable-gpu-vsync — need a Chrome launched with them: not the daemon's)
  if (daemon && !extraArgs.length && fs.existsSync(DAEMON)) {
    try {
      const d = JSON.parse(fs.readFileSync(DAEMON, 'utf8'));
      const b = await puppeteer.connect({ browserWSEndpoint: d.ws, defaultViewport: null, protocolTimeout: 10 * 60 * 1000 });
      return { b, close: async () => void b.disconnect(), how: 'daemon' };
    } catch {
      fs.rmSync(DAEMON, { force: true });
    }
  }
  const slot = fresh ? { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'reclaimed-chrome-')), free: () => {} } : profileSlot();
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', userDataDir: slot.dir, args: [...CHROME_ARGS, ...extraArgs], defaultViewport: null, protocolTimeout: 10 * 60 * 1000 });
  return {
    b,
    how: fresh ? 'fresh profile' : `profile ${path.basename(slot.dir)}`,
    close: async () => {
      await b.close().catch(() => {});
      slot.free();
      if (fresh) fs.rmSync(slot.dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------- the check

const SIZES = { behaviour: { size: '412x915', dpr: 1 }, timing: { size: '412x915', dpr: 2.6 } };

/**
 * Runs a check: the GPU leased for its kind, the server and the browser up, `body(R)` run, everything closed.
 * Exits non-zero when a check failed, the page threw, or the fatal overlay came up.
 */
export async function run(spec, body) {
  const argv = process.argv.slice(2);
  const flag = (k) => argv.includes(`--${k}`);
  const opt = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const kind = opt('kind', spec.kind);
  const name = spec.name ?? path.basename(process.argv[1] ?? 'check');
  const dev = flag('dev') || !!spec.dev;
  const size = opt('size', spec.size ?? SIZES[kind]?.size ?? '412x915');
  const dpr = Number(opt('dpr', spec.dpr ?? SIZES[kind]?.dpr ?? 1));
  const [W, H] = size.split('x').map(Number);
  let failed = false;
  const fail = (m) => {
    failed = true;
    console.log(`FAIL ${m}`);
  };
  const timeline = { start: 0 };
  const T = (k) => (timeline[k] = +((Date.now() - t0) / 1000).toFixed(2));
  const release = await lease(kind, name);
  T('gpu');
  // (`--server URL`: a server already up, e.g. a dev server you run; the scripts whose `--url` was the server's take it too)
  const given = opt('server', null) ?? (spec.urlIsServer ? opt('url', null) : null);
  const srv = given ? { url: given.replace(/\/$/, ''), close: async () => {}, external: true } : dev ? await serveDev({ force: flag('force') }) : await serveBuild();
  T('server');
  log(`${name}: ${kind}; ${srv.external ? 'given server' : srv.dev ? 'vite dev' : `build ${srv.build.hash}${srv.build.cached ? ' (cached)' : ` (built in ${(srv.build.ms / 1000).toFixed(1)} s)`}${srv.reused ? ', server shared' : ''}`} ${srv.url}; ${W}x${H} dpr ${dpr}`);
  // (spec.chromeArgs, or --chromeargs "a,b" / "--a --b": more Chrome switches)
  const extraArgs = spec.chromeArgs ?? (opt('chromeargs', '') || '').split(/[ ,]+/).filter(Boolean).map((a) => (a.startsWith('--') ? a : `--${a}`));
  const br = await browser({ fresh: flag('fresh-profile'), daemon: !flag('no-daemon'), extraArgs });
  T('browser');
  log(`chrome: ${br.how}`);
  const pages = [];
  const R = {
    url: srv.url,
    kind,
    argv,
    opt,
    flag,
    W,
    H,
    dpr,
    fail,
    timeline,
    get failed() {
      return failed;
    },
    check(label, ok, detail) {
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`);
      if (!ok) failed = true;
      return ok;
    },
    /** a new page: console errors / page errors fail the check; the origin's storage cleared first */
    async page({ size: sz, dpr: d, quiet = false, keepStorage = flag('keep-storage') } = {}) {
      const [w, h] = (sz ?? `${W}x${H}`).split('x').map(Number);
      const p = await br.b.newPage();
      pages.push(p);
      await p.setViewport({ width: w, height: h, deviceScaleFactor: d ?? dpr });
      const cdp = await p.createCDPSession();
      // (a fresh world each page, as a fresh profile gave: the world store, settings — not the GPU's shader cache)
      // (keepStorage: a second visit's — the player's warm cache, sim/warm-cache.ts)
      if (!keepStorage) await cdp.send('Storage.clearDataForOrigin', { origin: new URL(srv.url).origin, storageTypes: 'cookies,file_systems,indexeddb,local_storage,cache_storage,service_workers,websql' });
      p.on('pageerror', (e) => fail(`pageerror ${e.message}`));
      p.on('console', (m) => {
        const t = m.type();
        // (console errors print; they fail the check only when it says so — spec.strictConsole — as the scripts before)
        if (t === 'error' && !/favicon|404/.test(m.text())) spec.strictConsole ? fail(`console.error ${m.text().slice(0, 600)}`) : console.log(`[console.error] ${m.text().slice(0, 600)}`);
        else if (t === 'warning' || (!quiet && t === 'log' && spec.echo)) console.log(`[console.${t}] ${m.text().slice(0, 600)}`);
      });
      p.cdp = cdp;
      return p;
    },
    /**
     * A level: the page at `?skipmenu=1&level=…&tutorial=0&q=low` plus `params`; resolves once the level is made
     * (boot mark 'level-ready'), the stream's store open when there is one; prints the boot timeline.
     */
    async level(params = {}, popts = {}) {
      const p = popts.page ?? (await R.page(popts));
      // (warmcache=0: the player's warm cache — sim/warm-cache.ts — neither read nor written: every page's storage is
      // cleared, so it would only ever save 130 MB in the background of a check; --warmcache keeps it, to test it)
      const all = { skipmenu: '1', tutorial: '0', ...(flag('warmcache') ? {} : { warmcache: '0' }), ...(popts.noDefaultQ ? {} : { q: 'low' }), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) };
      // (popts.snapshot, or --snap: start from the warmed world saved for this build and URL — the warmup run and saved
      // the first time; sim/snapshot.ts. Needs the runner's build server: the dev server has no /__snap)
      if (popts.snapshot ?? flag('snap')) {
        if (!srv.build) throw new Error('warm snapshots need the build server the runner starts (not --dev or --server)');
        all.warmsnap = snapKey(srv.build.hash, all);
      }
      const q = new URLSearchParams(all);
      const tNav = Date.now();
      await p.goto(`${srv.url}/?${q}`, { waitUntil: 'load' });
      await p.waitForFunction(() => window.__boot?.at['level-ready'] || document.querySelector('.fatal'), { timeout: 300000, polling: 250 });
      await R.fatal(p);
      if (popts.store !== false) await p.waitForFunction(() => !window.reclaimed?.stream || window.__boot?.at.store || document.querySelector('.fatal'), { timeout: 120000, polling: 250 });
      const boot = await p.evaluate(() => window.__boot);
      p.boot = boot;
      p.bootWall = Date.now() - tNav;
      log(`level ${q.get('level') ?? 'valley'} ready in ${(p.bootWall / 1000).toFixed(1)} s: ${stages(boot)}`);
      return p;
    },
    /** the fatal overlay fails the check (and throws: nothing after it means anything) */
    async fatal(p) {
      const f = await p.$eval('.fatal', (e) => e.textContent).catch(() => null);
      if (f) {
        fail(`fatal overlay: ${f.slice(0, 800)}`);
        throw new Error('fatal overlay');
      }
    },
    /** waits until the sim has run `n` more ticks (sim time: the same on a shared GPU as alone) */
    async ticks(p, n, timeoutMs = 600000) {
      const start = await p.evaluate(() => window.reclaimed.core.globals.tick);
      await p.waitForFunction((t) => window.reclaimed.core.globals.tick >= t || document.querySelector('.fatal'), { timeout: timeoutMs, polling: 100 }, start + n);
      await R.fatal(p);
    },
    /** sim seconds (60 ticks a second: sim/simulation.ts TICK_DT) */
    simSeconds: (p, s, timeoutMs) => R.ticks(p, Math.round(s * 60), timeoutMs),
    sleep,
    log,
  };
  try {
    await body(R);
  } catch (e) {
    fail(`threw: ${e?.stack ?? e}`);
  } finally {
    for (const p of pages) await p.close().catch(() => {});
    await br.close();
    await srv.close();
    release();
  }
  T('end');
  log(`${name} ${failed ? 'FAILED' : 'passed'} — wall ${timeline.end}s (gpu wait ${timeline.gpu}s, server ${(timeline.server - timeline.gpu).toFixed(1)}s, chrome ${(timeline.browser - timeline.server).toFixed(1)}s)`);
  process.exit(failed ? 1 : 0);
}

/** the boot timeline as one line: each stage's time since the one before (s) */
export function stages(boot) {
  if (!boot) return '(no boot marks)';
  let prev = 0;
  return boot.marks.map(([k, t]) => {
    const s = `${k} +${((t - prev) / 1000).toFixed(1)}`;
    prev = t;
    return s;
  }).join(', ');
}

/**
 * A page hook (page.evaluateOnNewDocument(stateHook)): at the boot mark 'warmup' (src/perf/boot-marks.ts — the
 * warmup's last tick done, no frame yet) every world buffer is copied in queue order, then hashed (FNV-1a over its
 * words); `window.__warmState` resolves to [name, hash, words] for each. Reads only.
 */
export function stateHook() {
  window.__bootHook = (stage, core) => {
    if (stage !== 'warmup' || !core?.world || window.__warmState) return;
    const dev = core.host.gpu.device;
    const enc = dev.createCommandEncoder({ label: 'state hash' });
    const out = [];
    for (const [k, v] of Object.entries(core.world)) {
      if (!(v instanceof GPUBuffer) || !(v.usage & GPUBufferUsage.COPY_SRC)) continue;
      const st = dev.createBuffer({ size: v.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      enc.copyBufferToBuffer(v, 0, st, 0, v.size);
      out.push([k, st]);
    }
    dev.queue.submit([enc.finish()]);
    window.__warmState = Promise.all(
      out.map(async ([k, st]) => {
        await st.mapAsync(GPUMapMode.READ);
        const u = new Uint32Array(st.getMappedRange());
        let h = 2166136261;
        for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
        const n = u.length;
        st.unmap();
        st.destroy();
        return [k, (h >>> 0).toString(16), n];
      }),
    );
  };
}
