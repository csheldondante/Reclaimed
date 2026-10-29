// Round 112 (testspeed): the test runner's command line (the library is scripts/lib/runner.mjs).
//
//   node scripts/run.mjs status            who holds the GPU now (behaviour / timing leases, every worktree)
//   node scripts/run.mjs build             the production build the checks serve (cached by the sources' content)
//   node scripts/run.mjs serve             serve this worktree's build and keep serving (Ctrl+C to stop)
//   node scripts/run.mjs daemon            one Chrome kept up for this worktree's checks (they connect to it)
//   node scripts/run.mjs boot [--level atlas] [--at x,y] [--extra "&k=v"] [--reps 2] [--dev] [--fresh-profile]
//                                          the boot timeline: where a check's first minute goes (behaviour kind)
//   node scripts/run.mjs selfcheck [--gpu]  the runner's own checks: hashed assets and cache headers, a WGSL edit (a
//                                          kernel's own and common.wgsl's) changes the build; with --gpu, the edited
//                                          kernel's new constants come back on the same kept Chrome profile (never a
//                                          stale cached pipeline), in the same browser and in a relaunched one
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { BEHAVIOUR_SLOTS, buildInputs, CHROME, CHROME_ARGS, ROOT, browser, build, lease, leases, log, run, serveBuild, stages } from './lib/runner.mjs';

const [cmd = 'status'] = process.argv.slice(2);

if (cmd === 'status') {
  const ls = leases();
  if (!ls.length) console.log(`the GPU is free (behaviour checks share it up to ${BEHAVIOUR_SLOTS} at once; timing checks take it alone)`);
  for (const l of ls) console.log(`${l.state.padEnd(7)} ${l.kind.padEnd(9)} ${l.name}  pid ${l.pid}  ${l.cwd}  since ${l.since}`);
} else if (cmd === 'build') {
  const b = build();
  console.log(`${b.dir} (${b.cached ? 'cached' : `built in ${(b.ms / 1000).toFixed(1)} s`})`);
} else if (cmd === 'serve') {
  const s = await serveBuild();
  console.log(`${s.url}  (build ${s.build.hash}${s.reused ? ', already served' : ''})`);
  if (s.reused) process.exit(0);
} else if (cmd === 'daemon') {
  const dir = path.join(ROOT, '.testcache', 'chrome-daemon');
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', userDataDir: dir, args: CHROME_ARGS, defaultViewport: null });
  fs.writeFileSync(path.join(ROOT, '.testcache', 'daemon.json'), JSON.stringify({ ws: b.wsEndpoint(), pid: process.pid }));
  log(`chrome up: ${b.wsEndpoint()} — checks in this worktree connect to it; Ctrl+C stops it`);
  const stop = async () => {
    fs.rmSync(path.join(ROOT, '.testcache', 'daemon.json'), { force: true });
    await b.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else if (cmd === 'boot') {
  await run({ name: 'boot', kind: 'behaviour' }, async (R) => {
    const reps = Number(R.opt('reps', 1));
    const level = R.opt('level', 'atlas');
    const params = { level, perf: 1 };
    if (R.opt('at', '')) params.at = R.opt('at');
    for (const kv of R.opt('extra', '').split('&').filter(Boolean)) {
      const [k, v] = kv.split('=');
      params[k] = v ?? '';
    }
    for (let i = 0; i < reps; i++) {
      const p = await R.level(params);
      // (the first frames after the level is made: the frame's cost while the window's regions and tiles come in)
      await R.ticks(p, 60);
      const b = await p.evaluate(() => window.__boot);
      const nav = await p.evaluate(() => {
        const n = performance.getEntriesByType('navigation')[0];
        const res = performance.getEntriesByType('resource');
        return { domInteractive: Math.round(n.domInteractive), load: Math.round(n.loadEventEnd), resources: res.length, kb: Math.round(res.reduce((a, r) => a + (r.transferSize || 0), 0) / 1024) };
      });
      const atlas = await p.evaluate(() => (window.reclaimed?.scene?.opts?.atlas?.atlas ?? window.reclaimed?.atlas)?.timings ?? null);
      console.log(`BOOT ${JSON.stringify({ rep: i, wall: p.bootWall, nav, at: b.at, atlas })}`);
      console.log(`  ${stages(b)}`);
      await p.close();
    }
  });
} else if (cmd === 'selfcheck') {
  let bad = 0;
  const ok = (label, cond, detail) => {
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`);
    if (!cond) bad++;
  };
  // 1. every asset's name carries its content hash; only the pages themselves are unhashed (served no-cache)
  const b0 = build();
  const assets = fs.readdirSync(path.join(b0.dir, 'assets'));
  ok('every asset is content-hashed', assets.every((f) => /-[A-Za-z0-9_-]{8}\.(js|css|wasm|png|svg|json)$/.test(f)), assets);
  ok('the only unhashed files are the pages', fs.readdirSync(b0.dir).filter((f) => f !== 'assets').every((f) => f.endsWith('.html')), fs.readdirSync(b0.dir));
  // 2. a copy of the sources with a kernel's own constant and common.wgsl's (prepended to every kernel) edited
  const copy = path.join(ROOT, '.testcache', 'selfcheck-src');
  fs.rmSync(copy, { recursive: true, force: true });
  for (const f of buildInputs()) fs.cpSync(path.join(ROOT, f), path.join(copy, f), { recursive: true });
  const edit = (rel, a, b) => {
    const f = path.join(copy, rel);
    const t = fs.readFileSync(f, 'utf8');
    if (!t.includes(a)) throw new Error(`selfcheck: ${rel} has no "${a}"`);
    fs.writeFileSync(f, t.replace(a, b));
  };
  edit('src/test/probe.wgsl', 'const PROBE_OWN: f32 = 1.0;', 'const PROBE_OWN: f32 = 2.0;');
  edit('src/shaders/common.wgsl', 'const ROW_H: f32 = 0.8660254;', 'const ROW_H: f32 = 0.8660250;');
  const b1 = build(copy);
  ok('the edit makes another build', b1.hash !== b0.hash, { before: b0.hash, after: b1.hash });
  const js = (b) => fs.readdirSync(path.join(b.dir, 'assets')).filter((f) => f.endsWith('.js'));
  const changed = js(b1).filter((f) => !js(b0).includes(f));
  ok('the edited code is in assets of new names', changed.length > 0, changed);
  const text = (b) => js(b).map((f) => fs.readFileSync(path.join(b.dir, 'assets', f), 'utf8')).join(String.fromCharCode(10));
  ok('the new build carries the edited WGSL', text(b1).includes('PROBE_OWN: f32 = 2.0') && text(b1).includes('0.8660250'));
  ok('the old build does not', !text(b0).includes('PROBE_OWN: f32 = 2.0') && !text(b0).includes('0.8660250'));
  // 3. the server's cache headers: the page always asked again, hashed assets kept
  {
    const s = await serveBuild(b1);
    const head = async (u) => (await fetch(`${s.url}${u}`)).headers.get('cache-control');
    ok('the page is no-cache', (await head('/contract.html')) === 'no-cache' && (await head('/')) === 'no-cache');
    ok('hashed assets are immutable', /immutable/.test((await head(`/assets/${js(b1)[0]}`)) ?? ''));
    await s.close();
  }
  // 4. on the GPU: the same kept profile, the same origin (this worktree's port), builds swapped under it
  if (process.argv.includes('--gpu')) {
    const release = await lease('behaviour', 'selfcheck');
    const stamp = async (br, b) => {
      const s = await serveBuild(b);
      const p = await br.b.newPage();
      p.on('pageerror', (e) => ok(`no page error`, false, e.message));
      await p.goto(`${s.url}/contract.html`, { waitUntil: 'load' });
      await p.waitForFunction(() => window.contract, { timeout: 60000 });
      const r = await p.evaluate(() => window.contract.run('stamp'));
      await p.close();
      await s.close();
      return { ...r.data, port: s.port, ms: r.ms.total };
    };
    try {
      let br = await browser({ daemon: false });
      log(`chrome: ${br.how}`);
      const a = await stamp(br, b0);
      ok('the old build: its constants', a.own === 1 && a.rowH === 0.8660254, a);
      const c = await stamp(br, b1);
      ok('the edited build, same browser: the new constants', c.own === 2 && c.rowH === 0.866025, c);
      ok('the same origin both times (the cache would be shared)', a.port === c.port, [a.port, c.port]);
      await br.close();
      br = await browser({ daemon: false });
      const d = await stamp(br, b1);
      ok('the edited build, Chrome relaunched on the profile: the new constants', d.own === 2 && d.rowH === 0.866025, d);
      const e = await stamp(br, b0);
      ok('back to the old build: the old constants', e.own === 1 && e.rowH === 0.8660254, e);
      await br.close();
    } finally {
      release();
    }
  } else console.log('(the GPU half skipped: --gpu runs it, a behaviour check, ~20 s)');
  fs.rmSync(copy, { recursive: true, force: true });
  console.log(bad ? `SELFCHECK: ${bad} FAILED` : 'SELFCHECK: OK');
  process.exit(bad ? 1 : 0);
} else {
  console.log(`unknown command "${cmd}": status | build | serve | daemon | boot | selfcheck`);
  process.exit(2);
}
