// Nested scales (round 10): the owner's "floating columns" stills. Two scenes on the sandbox, each run with round 9's
// rules (before: derive's top surface from every neighbour, no residual cleared by a coarse carve) and with round 10's:
//  cave: a cave carved at the root just under the surface (its top breaking through on one side), zoomed into until
//        level 1 and then level 2 open over its rim;
//  blob: a blob added in mid-air and a cave carved at level 1, the level dropped, a root carve over both, zoomed in.
// Stills under local/nested/r10-*.png. The counts are the self-test's (src/nested/carves.ts, ?selftest=1&carves=only).
// node scripts/nested-carves.mjs --chromeargs ignore-certificate-errors [--port 5461]
import { run, sleep } from './lib/runner.mjs';

await run({ name: 'nested-carves', kind: 'behaviour', size: '960x640', dpr: 1, echo: false }, async (R) => {
  const port = R.opt('port', '5461');
  for (const mode of ['before', 'after']) {
    for (const scene of ['cave', 'blob']) {
      const page = await R.page();
      page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`);
      });
      const at = scene === 'cave' ? { x: 106.3, y: 141 } : { x: 160.5, y: 100.5 };
      await page.goto(`https://localhost:${port}/nested.html?k=8&d=40&pitch=0.6&yaw=0.6&tx=${at.x}&ty=${at.y}`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.nested && nested.app.frameCount > 60, { timeout: 120000, polling: 100 });
      await sleep(800);
      const shots = await page.evaluate(
        async (mode, scene, at) => {
          const nest = nested.app.nest;
          if (mode === 'before') {
            nest.oldTop = 1;
            nest.skip.add('resClear');
          }
          const frames = async (n) => {
            const f = nested.app.frameCount + n;
            while (nested.app.frameCount < f) await new Promise((r) => setTimeout(r, 8));
          };
          const settle = async (live) => {
            for (let i = 0; i < 600; i++) {
              if (nest.settled && nested.state().queue === 0 && (live === undefined || nest.live === live)) break;
              await frames(1);
            }
            await frames(30);
          };
          const top = async (m, x, y) => {
            const s = await nest.readAll();
            const k = 8 ** m;
            const c = s.column(m, Math.floor(x * k), Math.floor(y * k));
            return c.z1[c.z1.length - 1];
          };
          const edit = async (op, m, x, y, z, r) => {
            nested.app.frozen = true;
            await settle();
            const w = nest.wins[m];
            const k = 8 ** m;
            for (let i = 0; i < 200 && !nest.edit({ op, radius: r, amount: 0, at: { level: m, x: x * k - w.gx, y: y * k - w.gy, z } }); i++) await frames(1);
            await settle();
            nested.app.frozen = false;
          };
          const out = [];
          if (scene === 'cave') {
            await settle(1);
            await edit('carve', 0, at.x, at.y, (await top(0, at.x, at.y)) - 3.3, 3);
            for (const [d, live, yaws] of [
              [10, 2, [0.6, 3.7]],
              [2.5, 3, [0.6, 3.7]],
            ]) {
              for (const yaw of yaws) {
                nested.setView({ tx: at.x + 1.2, ty: at.y, d, yaw, pitch: 0.9 });
                await settle(live);
                out.push({ name: `cave-L${live - 1}-yaw${yaw}`, live: nest.live });
              }
            }
          } else {
            nested.setView({ tx: at.x, ty: at.y, d: 10, yaw: 0.6, pitch: 0.9 });
            await settle(2);
            const t = await top(1, at.x, at.y);
            await edit('add', 1, at.x + 0.5, at.y + 0.3, t + 12, 0.5);
            await edit('carve', 1, at.x - 0.8, at.y - 0.5, (await top(1, at.x - 0.8, at.y - 0.5)) - 6, 0.6);
            out.push({ name: 'blob-1-fine-edits', live: nest.live });
            nested.setView({ tx: at.x, ty: at.y, d: 60 });
            await settle(1);
            await edit('carve', 0, at.x, at.y, (await top(0, at.x, at.y)) + 1, 3.5);
            out.push({ name: 'blob-2-root-carve', live: nest.live });
            nested.setView({ tx: at.x, ty: at.y, d: 10, yaw: 0.6, pitch: 0.9 });
            await settle(2);
            out.push({ name: 'blob-3-zoomed-in', live: nest.live });
          }
          return out;
        },
        mode,
        scene,
        at,
      );
      // (each pose again, then the still)
      const views = {
        'cave-L1-yaw0.6': { tx: at.x + 1.2, ty: at.y, d: 10, yaw: 0.6, pitch: 0.9 },
        'cave-L1-yaw3.7': { tx: at.x + 1.2, ty: at.y, d: 10, yaw: 3.7, pitch: 0.9 },
        'cave-L2-yaw0.6': { tx: at.x + 1.2, ty: at.y, d: 2.5, yaw: 0.6, pitch: 0.9 },
        'cave-L2-yaw3.7': { tx: at.x + 1.2, ty: at.y, d: 2.5, yaw: 3.7, pitch: 0.9 },
        'blob-3-zoomed-in': { tx: at.x, ty: at.y, d: 10, yaw: 0.6, pitch: 0.9 },
      };
      for (const s of shots) {
        const v = views[s.name];
        if (!v) continue;
        await page.evaluate((v) => nested.setView(v), v);
        await sleep(1500);
        const file = `local/nested/r10-${s.name}-${mode}.png`;
        await page.screenshot({ path: file });
        const live = await page.evaluate(() => nested.state().live);
        console.log(`${file}: ${live} levels live`);
      }
      await page.close();
    }
  }
});
