import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

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
          if (size > 8 * 1024 * 1024) req.destroy();
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
          const dir = path.resolve(__dirname, 'perf-reports');
          fs.mkdirSync(dir, { recursive: true });
          // (round 101, bench: ?kind=bench → bench-<time>.json, the benchmark's result; else a hitch report)
          const kind = new URL(req.url ?? '/', 'http://x').searchParams.get('kind') === 'bench' ? 'bench' : 'hitch';
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
  // (round 102, bench v3: the build's time on the benchmark's start page — src/perf/bench.ts BUILD)
  define: { __BENCH_BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')) },
  server: { port: 5173, strictPort: true },
  plugins: [hitchSink()],
});
