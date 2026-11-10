// (round 128l, tooling) The lab's runner: one headless Chrome and one lab page kept open on this worktree's build
// (docs/TOOLING.md). Since the switchover (2026-11-10) the page is the town game — the atlas level at the start town
// (Muru), its GPU town, living town and season loop, ?lab=1 (src/lab/lab.ts) — not the behaviour lab's fortress recipes.
//
//   node scripts/lab.mjs serve                     keep Chrome + the lab page up (started by `run` when it isn't)
//   node scripts/lab.mjs run <scenario> [--args '{"k":1}'] [--out dir] [--reload] [--flags "&agentprof=1"]
//                                                  (round 128o: --flags, the page's own URL flags — a page loaded
//                                                  with other flags is loaded again)
//                                                  run a scenario on it: prints its console and its JSON result,
//                                                  saves its shots (default .testcache/lab-shots/)
//   node scripts/lab.mjs status | stop
//
// A scenario is an ES module run IN THE PAGE (no closures over the module's variables):
//   export default async function (lab, args) {     // lab: window.reclaimed.lab (src/lab/lab.ts)
//     const S = lab.season;                         // the season loop; lab.towns, lab.living, lab.town (its id)
//     await lab.run(30, 16);
//     await lab.shot('after');
//     return { left: S.left };                      // printed as JSON
//   }
// or a plain .js file: the body of `async (lab, args) => { … }`.
//
// Each run: the build checked (vite build, cached by the sources' content: ~2 s when something changed); the page
// loaded again for every scenario (the town game's world can't be put back: lab.resettable is false), its storage
// cleared first (?fresh=1's). The GPU is leased as a behaviour check for the run (scripts/lib/runner.mjs: shared with
// other worktrees' checks).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { overlayBlocks } from './lib/overlaycheck.mjs';
import { pathToFileURL } from 'node:url';
import { ROOT, basePort, browser, build, lease, serveBuild, stages } from './lib/runner.mjs';

const CACHE = path.join(ROOT, '.testcache');
const STATE = path.join(CACHE, 'lab.json');
const LOG = path.join(CACHE, 'lab-serve.log');
const CTRL_PORT = basePort() + 8;
const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'status';
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const flag = (k) => argv.includes(`--${k}`);
const now = () => Date.now();
const secs = (ms) => +(ms / 1000).toFixed(1);

/** a request to the serving process (null: none answering) */
function ask(method, pth, body, timeoutMs = 30 * 60 * 1000) {
  return new Promise((res) => {
    const data = body ? JSON.stringify(body) : '';
    const q = http.request({ host: '127.0.0.1', port: CTRL_PORT, path: pth, method, timeout: timeoutMs, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => {
        try {
          res(JSON.parse(b));
        } catch {
          res({ error: b });
        }
      });
    });
    q.on('error', () => res(null));
    q.on('timeout', () => (q.destroy(), res({ error: 'timed out' })));
    q.end(data);
  });
}

// ---------------------------------------------------------------- serve

async function serve() {
  fs.mkdirSync(CACHE, { recursive: true });
  // (a lease a run, each with its exit hook)
  process.setMaxListeners(0);
  const say = (...a) => console.log(`[lab ${new Date().toISOString().slice(11, 19)}]`, ...a);
  const br = await browser({ daemon: false });
  say(`chrome: ${br.how}`);
  let srv = null;
  let page = null;
  let loaded = { hash: '', recipe: '', flags: '' };
  let dirty = false;
  let broken = false;
  const out = { dir: path.join(CACHE, 'lab-shots') };
  /** the console and page errors of the run under way */
  let sink = null;

  async function openPage() {
    if (page) await page.close().catch(() => {});
    page = await br.b.newPage();
    await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 1 });
    // (each line also to the server's log as it comes: `tail -f .testcache/lab-serve.log` watches a long scenario)
    page.on('console', (m) => {
      const line = `[${m.type()}] ${m.text().slice(0, 2000)}`;
      if (sink) {
        sink.logs.push(line);
        say(line);
      }
    });
    page.on('pageerror', (e) => sink?.errors.push(`pageerror ${e.message}`));
    await page.exposeFunction('__labShot', async (name) => {
      fs.mkdirSync(out.dir, { recursive: true });
      const f = path.join(out.dir, `${String(name).replace(/[^\w.-]+/g, '_')}.png`);
      await page.screenshot({ path: f });
      sink?.shots.push(f);
      return f;
    });
  }

  /** the lab page on the build now and this recipe: reloaded when either changed; reset otherwise */
  async function ready(recipe, force, flags = '') {
    const t0 = now();
    const b = build();
    const tBuild = now() - t0;
    const timings = { build: secs(tBuild), buildCached: b.cached };
    if (!srv || srv.build.hash !== b.hash) {
      if (srv) await srv.close();
      // (its own server: no check reuses it, so stopping the lab never takes a page's server away)
      srv = await serveBuild(b, { own: true });
    }
    // (onetown: a fixture's town is its site's data — the lab can't put it back in place: a used page is loaded again)
    const resettable = page && !broken ? await page.evaluate(() => window.reclaimed?.lab?.resettable ?? true).catch(() => true) : true;
    if (force || broken || !page || loaded.hash !== b.hash || loaded.recipe !== recipe || loaded.flags !== flags || (dirty && !resettable)) {
      if (!page || broken) await openPage();
      const cdp = await page.createCDPSession();
      await cdp.send('Storage.clearDataForOrigin', { origin: new URL(srv.url).origin, storageTypes: 'indexeddb,local_storage,cache_storage,service_workers' });
      await cdp.detach();
      const t1 = now();
      // (midday, the day held: shots read the same every run)
      if (recipe !== 'town') throw new Error(`lab: the page is the town game (recipe 'town'), not "${recipe}" — the behaviour lab's recipes went with the fortress`);
      const q = new URLSearchParams({ skipmenu: '1', level: 'atlas', town: '1', fresh: '1', lab: '1', tutorial: '0', warmcache: '0', q: 'low', tod: '0.3', day: '100000' });
      for (const [k, v] of new URLSearchParams(flags)) q.set(k, v);
      await page.goto(`${srv.url}/?${q}`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.reclaimed?.lab?.ready || document.querySelector('.fatal'), { timeout: 300000, polling: 100 });
      const fatal = await page.$eval('.fatal', (e) => e.textContent).catch(() => null);
      if (fatal) {
        broken = true;
        throw new Error(`the lab didn't open: ${fatal.slice(0, 1500)}`);
      }
      // (round 128p: a page opened with --flags "&perf=1…" — no debug overlay takes the map's input)
      const blocked = await overlayBlocks(page);
      if (blocked.length) throw new Error(`a debug overlay blocks the map's input: ${blocked.slice(0, 8).join('; ')}`);
      const boot = await page.evaluate(() => window.__boot);
      timings.reload = secs(now() - t1);
      timings.boot = stages(boot);
      loaded = { hash: b.hash, recipe, flags };
      broken = false;
      dirty = false;
    } else if (dirty) {
      const t1 = now();
      await page.evaluate(() => window.reclaimed.lab.reset());
      timings.reset = secs(now() - t1);
    }
    timings.build_hash = b.hash;
    return timings;
  }

  async function runScenario(req) {
    const t0 = now();
    const file = path.resolve(req.cwd ?? ROOT, req.file);
    if (!fs.existsSync(file)) throw new Error(`no scenario ${file}`);
    let src;
    let recipe = req.recipe;
    if (/\.mjs$/.test(file)) {
      const mod = await import(`${pathToFileURL(file).href}?t=${now()}`);
      if (typeof mod.default !== 'function') throw new Error(`${req.file}: export default async function (lab, args) { … }`);
      src = mod.default.toString();
      recipe ??= mod.recipe;
    } else src = `async function (lab, args) {\n${fs.readFileSync(file, 'utf8')}\n}`;
    recipe ??= 'town';
    out.dir = req.out ? path.resolve(req.cwd ?? ROOT, req.out) : path.join(CACHE, 'lab-shots');
    const tLease = now();
    const release = await lease('behaviour', `lab ${path.basename(file)}`);
    const gpuWait = secs(now() - tLease);
    sink = { logs: [], errors: [], shots: [] };
    try {
      const timings = { gpuWait, ...(await ready(recipe, !!req.reload, req.flags ?? '')) };
      const t1 = now();
      dirty = true;
      let result;
      try {
        // (a function's source as written: `async run(lab) {…}` or `async function (lab) {…}`; an arrow is fine)
        const fn = /^async\s+(function\b|\(|[\w$]+\s*=>)/.test(src) || /^\(/.test(src) ? src : `async function ${src.replace(/^async\s+/, '')}`;
        result = await page.evaluate(`(${fn})(window.reclaimed.lab, ${JSON.stringify(req.args ?? {})})`);
      } catch (e) {
        sink.errors.push(`threw: ${e?.message ?? e}`);
      }
      const fatal = await page.$eval('.fatal', (e) => e.textContent).catch(() => null);
      if (fatal) {
        broken = true;
        sink.errors.push(`fatal overlay: ${fatal.slice(0, 1500)}`);
      }
      timings.scenario = secs(now() - t1);
      timings.total = secs(now() - t0);
      return { ok: !sink.errors.length, recipe, result: result ?? null, logs: sink.logs, errors: sink.errors, shots: sink.shots, timings };
    } finally {
      sink = null;
      release();
    }
  }

  let busy = Promise.resolve();
  const ctrl = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const reply = (o) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(o));
      };
      if (req.url === '/status') return reply({ pid: process.pid, url: srv?.url ?? null, loaded, dirty, broken });
      if (req.url === '/stop') {
        reply({ stopping: true });
        await stop();
        return;
      }
      if (req.url === '/run') {
        // (one at a time: the page is one)
        const job = busy.then(() => runScenario(JSON.parse(body || '{}')));
        busy = job.catch(() => {});
        try {
          reply(await job);
        } catch (e) {
          reply({ ok: false, errors: [String(e?.stack ?? e)], logs: [], shots: [] });
        }
        return;
      }
      res.statusCode = 404;
      reply({ error: 'unknown' });
    });
  });
  await new Promise((r, j) => {
    ctrl.once('error', j);
    ctrl.listen(CTRL_PORT, '127.0.0.1', r);
  });
  fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, port: CTRL_PORT }));
  say(`serving on 127.0.0.1:${CTRL_PORT} (pid ${process.pid})`);
  const stop = async () => {
    fs.rmSync(STATE, { force: true });
    ctrl.close();
    await page?.close().catch(() => {});
    await br.close();
    await srv?.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // (warm: the page opened now, so the first run finds it up. In the queue the runs wait in: a run sent
  // while it opens waits for it — two opening the page at once both bound __labShot on the second page, and the run failed)
  const warm = busy.then(async () => {
    const release = await lease('behaviour', 'lab boot');
    try {
      const t = await ready('town', false);
      say(`lab up: ${JSON.stringify(t)}`);
    } catch (e) {
      say(`lab didn't open: ${e?.message ?? e}`);
    } finally {
      release();
    }
  });
  busy = warm;
  await warm;
}

// ---------------------------------------------------------------- the client

async function ensureServer() {
  const st = await ask('GET', '/status', null, 3000);
  if (st && !st.error) return;
  console.log(`[lab] starting the lab server (log: ${path.relative(ROOT, LOG)}) …`);
  fs.mkdirSync(CACHE, { recursive: true });
  const fd = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, [fileURLToPathSafe(import.meta.url), 'serve'], { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  child.unref();
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const s = await ask('GET', '/status', null, 2000);
    if (s && !s.error) return;
  }
  throw new Error(`the lab server didn't start: see ${LOG}`);
}
function fileURLToPathSafe(u) {
  return decodeURIComponent(new URL(u).pathname).replace(/^\/([A-Za-z]:)/, '$1');
}

if (cmd === 'serve') await serve();
else if (cmd === 'status') {
  const s = await ask('GET', '/status', null, 3000);
  console.log(s ? JSON.stringify(s) : 'no lab server running');
} else if (cmd === 'stop') {
  const s = await ask('GET', '/stop', null, 10000);
  console.log(s ? 'stopped' : 'no lab server running');
} else if (cmd === 'run') {
  const file = argv[1];
  if (!file) throw new Error('lab.mjs run <scenario.mjs|.js> [--args json] [--out dir] [--reload] [--flags f]');
  const t0 = now();
  await ensureServer();
  const r = await ask('POST', '/run', { file, cwd: process.cwd(), args: opt('args') ? JSON.parse(opt('args')) : {}, out: opt('out'), reload: flag('reload'), flags: opt('flags') ?? '' });
  if (!r) throw new Error('the lab server went away');
  for (const l of r.logs ?? []) console.log(l);
  for (const e of r.errors ?? []) console.log(`ERROR ${e}`);
  for (const s of r.shots ?? []) console.log(`shot ${s}`);
  if (r.result !== undefined) console.log(`result ${JSON.stringify(r.result, null, flag('compact') ? 0 : 1)}`);
  console.log(`[lab] ${r.ok ? 'ok' : 'FAILED'} — ${JSON.stringify({ ...r.timings, wall: secs(now() - t0) })}`);
  process.exit(r.ok ? 0 : 1);
} else throw new Error(`lab.mjs: serve | run <scenario> | status | stop (not "${cmd}")`);
