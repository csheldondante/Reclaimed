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
      else h.update(path.relative(import.meta.dirname, f).split(path.sep).join('/')).update(fs.readFileSync(f));
    }
  };
  for (const d of ['src', 'data']) if (fs.existsSync(path.resolve(import.meta.dirname, d))) walk(path.resolve(import.meta.dirname, d));
  for (const f of ['index.html', 'contract.html', 'structures.html', 'flora.html', 'package.json', 'vite.config.ts']) if (fs.existsSync(path.resolve(import.meta.dirname, f))) h.update(fs.readFileSync(path.resolve(import.meta.dirname, f)));
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
          const dir = path.resolve(import.meta.dirname, 'perf-reports');
          fs.mkdirSync(dir, { recursive: true });
          // (round 101, bench: ?kind=bench → bench-<time>.json, the benchmark's result; round 108: ?kind=bug, a bug
          // report from the tuning panel's 🐞 — src/ui/bugreport.ts; else a hitch report)
          const k = new URL(req.url ?? '/', 'http://x').searchParams.get('kind');
          // (round 120: ?kind=physbench, the physics phone bench — src/perf/physbench.ts)
          const kind = k === 'bench' || k === 'bug' || k === 'physbench' ? k : 'hitch';
          const name = `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
          fs.writeFileSync(path.join(dir, name), body);
          res.end(`perf-reports/${name}`);
        });
      });
    },
  };
}

export default defineConfig({
  // relative asset paths: the build works from any folder (GitHub Pages serves it at /Reclaimed/)
  base: './',
  // (round 114, worldstore: __GEN_HASH__ the land generator's version — scripts/lib/gen-sources.mjs; a saved region
  // made by another is dropped and made again. The dev server reads it at start: restart it after editing the generator.)
  // (round 102, bench v3: the build's time on the benchmark's start page — src/perf/bench.ts BUILD)
  define: { __BENCH_BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')), __BUILD_HASH__: JSON.stringify(contentHash()), __GEN_HASH__: JSON.stringify(genHash(import.meta.dirname)) },
  server: { port: 5173, strictPort: true },
  // (round 117, flora: flora.html — the flora viewer page, src/flora/viewer.ts)
  // (round 112, testspeed: contract.html — the contract tier's page, src/test/contract.ts: a system on a tiny world)
  // (round 117, structures: structures.html — the structures track's viewer, src/structures/viewer/)
  build: { rolldownOptions: { input: { main: path.resolve(import.meta.dirname, 'index.html'), contract: path.resolve(import.meta.dirname, 'contract.html'), structures: path.resolve(import.meta.dirname, 'structures.html'), flora: path.resolve(import.meta.dirname, 'flora.html') } } },
  plugins: [hitchSink()],
});
