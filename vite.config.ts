import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { genHash } from './scripts/lib/gen-sources.mjs';

/** (round 112, testspeed) the build's content: every file of src/ and data/ and the pages — the player's warm cache
 *  is keyed by it (src/sim/warm-cache.ts): any change to what the game is made of, a new key, nothing stale */
function contentHash(): string {
  const h = crypto.createHash('sha1');
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else h.update(path.relative(__dirname, f).split(path.sep).join('/')).update(fs.readFileSync(f));
    }
  };
  for (const d of ['src', 'data']) if (fs.existsSync(path.resolve(__dirname, d))) walk(path.resolve(__dirname, d));
  for (const f of ['index.html', 'contract.html', 'package.json', 'vite.config.ts']) if (fs.existsSync(path.resolve(__dirname, f))) h.update(fs.readFileSync(path.resolve(__dirname, f)));
  return h.digest('hex').slice(0, 16);
}

// (round 100, hitchrec) the dev server keeps the hitch recorder's reports: its "send report" POSTs to /__hitch,
// written to perf-reports/hitch-<time>.json (src/perf/hitch-hud.ts). Dev only; the Pages build has no endpoint.
function hitchSink(): Plugin {
  return {
    name: 'hitch-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__hitch', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 16 * 1024 * 1024) req.destroy();
          else chunks.push(c);
        });
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          try {
            JSON.parse(body);
          } catch {
            res.statusCode = 400;
            res.end('not JSON');
            return;
          }
          const q = new URL(req.url ?? '/', 'http://x').searchParams;
          const k = q.get('kind');
          // (round 112, herosandbox: ?kind=herofeedback&name=<date>-<role> → feedback/hero/<name>.json, the hero
          // sandbox's contract feedback — the folder main commits and forwards: docs/HEROES.md "Contract feedback")
          if (k === 'herofeedback') {
            const name = (q.get('name') ?? new Date().toISOString().replace(/[:.]/g, '-')).replace(/[^\w.-]+/g, '_');
            const fdir = path.resolve(__dirname, 'feedback', 'hero');
            fs.mkdirSync(fdir, { recursive: true });
            fs.writeFileSync(path.join(fdir, `${name}.json`), body);
            res.end(`feedback/hero/${name}.json`);
            return;
          }
          const dir = path.resolve(__dirname, 'perf-reports');
          fs.mkdirSync(dir, { recursive: true });
          // (round 101, bench: ?kind=bench → bench-<time>.json, the benchmark's result; round 108: ?kind=bug, a bug
          // report from the tuning panel's 🐞 — src/ui/bugreport.ts; else a hitch report)
          const kind = k === 'bench' || k === 'bug' ? k : 'hitch';
          const name = `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
          fs.writeFileSync(path.join(dir, name), body);
          res.end(`perf-reports/${name}`);
        });
      });
    },
  };
}

/**
 * (round 112, herosandbox) The import map a hero module from another build resolves Reclaimed through:
 * `reclaimed/<path>` → the host's own module (src/hero/shared-modules.json lists them), so its classes and
 * constants are the host's by identity and nothing is copied (docs/HEROES.md "Heroes from another build"). On the
 * dev server each is its source (/src/<path>.ts); in the build each is an entry of its own (kept with its exports,
 * the app importing the same chunk), mapped to its file.
 */
function heroShared(): Plugin {
  const list = (JSON.parse(fs.readFileSync(path.resolve(__dirname, 'src/hero/shared-modules.json'), 'utf8')) as { modules: string[] }).modules;
  const src = (m: string) => path.resolve(__dirname, 'src', `${m}.ts`).replace(/\\/g, '/');
  return {
    name: 'hero-shared',
    config(_c, env) {
      if (env.command !== 'build') return;
      return {
        build: {
          rolldownOptions: {
            input: { ...Object.fromEntries(list.map((m) => [`shared/${m.replace(/\//g, '-')}`, src(m)])) },
            preserveEntrySignatures: 'exports-only',
          },
        },
      };
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const imports: Record<string, string> = {};
        if (!ctx.bundle) for (const m of list) imports[`reclaimed/${m}`] = `/src/${m}.ts`;
        else {
          const byId = new Map<string, string>();
          for (const c of Object.values(ctx.bundle)) if (c.type === 'chunk' && c.isEntry && c.facadeModuleId) byId.set(c.facadeModuleId.replace(/\\/g, '/'), c.fileName);
          for (const m of list) {
            const f = byId.get(src(m));
            if (!f) throw new Error(`hero-shared: no entry chunk for src/${m}.ts`);
            imports[`reclaimed/${m}`] = `./${f}`;
          }
        }
        return [{ tag: 'script', attrs: { type: 'importmap' }, children: JSON.stringify({ imports }, null, 1), injectTo: 'head-prepend' }];
      },
    },
  };
}

export default defineConfig({
  // relative asset paths: the build works from any folder (GitHub Pages serves it at /Reclaimed/)
  base: './',
  // (round 114, worldstore: __GEN_HASH__ the land generator's version — scripts/lib/gen-sources.mjs; a saved region
  // made by another is dropped and made again. The dev server reads it at start: restart it after editing the generator.)
  // (round 102, bench v3: the build's time on the benchmark's start page — src/perf/bench.ts BUILD)
  define: { __BENCH_BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')), __BUILD_HASH__: JSON.stringify(contentHash()), __GEN_HASH__: JSON.stringify(genHash(__dirname)) },
  server: { port: 5173, strictPort: true },
  // (round 112, testspeed: contract.html — the contract tier's page, src/test/contract.ts: a system on a tiny world;
  // herosandbox: heroShared adds the shared modules' entries beside these)
  build: { rolldownOptions: { input: { main: path.resolve(__dirname, 'index.html'), contract: path.resolve(__dirname, 'contract.html') } } },
  plugins: [hitchSink(), heroShared()],
});
