// Round 112 (physfix2): runs scripts/physfix2-cpu.ts (both judges, the rigid bodies and the columns pieces on the CPU, the playground's
// map) through Vite's SSR loader — no browser, no GPU.  node scripts/physfix2-cpu.mjs [bases|tower1|towermid|board|bridge|bridgedig|arch|archtop|tower|arm ...]
import { createServer } from 'vite';
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] } });
try { globalThis.NECKDBG = 1;
  const m = await server.ssrLoadModule('/scripts/physfix2-cpu.ts');
  for (const s of process.argv.slice(2).length ? process.argv.slice(2) : ['bases', 'tower1', 'arch', 'tower']) for (const l of m.run(s)) console.log(l);
} finally {
  await server.close();
}
