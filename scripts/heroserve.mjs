// (round 112, herosandbox) Serves scripts/test-hero/ on its own origin with CORS, as another game's dev server would
// serve its hero module: node scripts/heroserve.mjs [port=5208]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2] ?? 5208);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-hero');
http
  .createServer((req, res) => {
    const f = path.join(root, path.normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[\\/]+/, ''));
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!f.startsWith(root) || !fs.existsSync(f)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', 'text/javascript');
    res.end(fs.readFileSync(f));
  })
  .listen(port, () => console.log(`hero modules on http://localhost:${port}/ (${root})`));
