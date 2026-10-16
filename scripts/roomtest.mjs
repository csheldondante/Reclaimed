// The structure-grids room test (docs/GRIDS.md, multi-span projection): a
// hollow room — floor, four walls, a roof with a hole, a doorway — placed as a
// slightly tilted structure grid in the sandbox. Sand poured over the roof's
// hole should fall through it onto the floor inside; sand upwind of the
// doorway, in a steady wind, should drift in through it; the corner away from
// both should stay bare. Prints what lies on the floor at those points, and
// writes screenshots.
//
//   node scripts/roomtest.mjs [--url http://localhost:5177] [--out prefix] [--seconds 40]
//     [--calm] (the calm drop only)  [--debug] (the projection along the doorway's line)
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const url = opt('url', 'http://localhost:5177');
const out = opt('out', 'room');
const seconds = Number(opt('seconds', 40));
const browser = await puppeteer.launch({
  executablePath: opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--window-size=1600,900'],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
  protocolTimeout: 10 * 60 * 1000,
});
let failed = false;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => {
    failed = true;
    console.log('pageerror:', e.message);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) console.log('console.error:', m.text());
  });
  await page.goto(`${url}/?skipmenu=1&level=sandbox&tutorial=0&speed=4`, {
    waitUntil: 'load',
  });
  await page.waitForFunction(() => window.reclaimed?.core && window.reclaimed.scene.surfaceCache?.length, { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 4000));
  // the room: 16 × 16, a foundation (its walls carried 3 cells down, z 0..2),
  // floor z 3, roof z 12 with a 4 × 4 hole, a doorway in the x = 0 wall
  await page.evaluate(async () => {
    const R = window.reclaimed;
    const { qYawPitchRoll, qRotate } = await import('/src/grids/structures.ts');
    const [W, D, H] = [16, 16, 13];
    const vox = new Uint8Array(W * D * H);
    const CONCRETE = 5;
    const F = 3;
    for (let z = 0; z < H; z++)
      for (let y = 0; y < D; y++)
        for (let x = 0; x < W; x++) {
          const wall = x === 0 || y === 0 || x === W - 1 || y === D - 1;
          const hole = z === H - 1 && x >= 6 && x <= 9 && y >= 6 && y <= 9;
          const door = x === 0 && y >= 6 && y <= 9 && z >= 4 && z <= 6;
          const solid = (z === F || z === H - 1 || wall) && !hole && !door;
          if (solid) vox[x + W * (y + D * z)] = CONCRETE;
        }
    const model = { id: 'room', name: 'Room', size: [W, D, H], vox, sink: 0 };
    const q = qYawPitchRoll(0.25, (6 * Math.PI) / 180, (3 * Math.PI) / 180);
    const s = R.core.structures.place(model, 128, 120, q, R.scene.heightAt, 0);
    // (placed on the mean ground it would sit in the sand — nothing is
    // displaced yet: lift it so its floor clears the ground everywhere; the
    // foundation goes into the ground)
    // (the ground's top: the columns' top intervals, sand and all)
    const { cellAt } = await import('/src/world/lattice.ts');
    const { readColumn } = await import('/src/world/layout.ts');
    const slots = new Uint32Array((await R.core.readBuffer('layers')).buffer);
    const top = (x, y) => {
      const col = readColumn(R.packed, slots, ...cellAt(x, y));
      return col.length ? col[col.length - 1].z1 : 0;
    };
    let lift = -1e9;
    for (let ly = 0; ly <= D; ly += 1)
      for (let lx = 0; lx <= W; lx += 1) {
        const v = qRotate(q, [lx, ly, F]);
        lift = Math.max(lift, top(s.pos[0] + v[0], s.pos[1] + v[1]) - (s.pos[2] + v[2]));
      }
    R.core.structures.setPose(s, [s.pos[0], s.pos[1], s.pos[2] + lift + 0.1], q);
    window.room = s;
    // calm, for the first part
    R.weather.params.baseWindX = 0;
    R.weather.params.baseWindY = 0;
    const c = R.camera;
    c.target[0] = 128;
    c.target[1] = 120;
    c.zoom *= 2.2;
  });
  // a point of the room (local cell centre) in world coordinates
  const local = (lx, ly, lz) =>
    page.evaluate(
      async (p) => {
        const { qRotate } = await import('/src/grids/structures.ts');
        const s = window.room;
        const v = qRotate(s.q, p);
        return [s.pos[0] + v[0], s.pos[1] + v[1], s.pos[2] + v[2]];
      },
      [lx, ly, lz],
    );
  const F = 3;
  // a cone of sand r cells across and h high stamped on top of the columns
  // around a room point (written straight into the layers: deterministic,
  // unlike the brush, whose pours fall over time)
  const heap = async (lx, ly, r, h) => {
    const [x, y] = await local(lx, ly, 0);
    await page.evaluate(
      async (x, y, r, h) => {
        const R = window.reclaimed;
        const { cellAt, cellPos } = await import('/src/world/lattice.ts');
        const { readColumn, columnSlots, packColumn, SLOT_WORDS } = await import('/src/world/layout.ts');
        const slots = new Uint32Array((await R.core.readBuffer('layers')).buffer);
        const [cx, cy] = cellAt(x, y);
        for (let j = cy - r - 1; j <= cy + r + 1; j++)
          for (let i = cx - r - 1; i <= cx + r + 1; i++) {
            const [px, py] = cellPos(i, j);
            const d = Math.hypot(px - x, py - y);
            const add = h * (1 - d / r);
            if (add <= 0.05) continue;
            const col = readColumn(R.packed, slots, i, j);
            const { base, k } = columnSlots(R.packed, i, j);
            const top = col[col.length - 1];
            if (top.mat === 3) top.z1 += add;
            else if (col.length < k) col.push({ z0: top.z1, z1: top.z1 + add, mat: 3 });
            else continue;
            R.core.host.gpu.device.queue.writeBuffer(R.world.layers, base * SLOT_WORDS * 4, packColumn(col, k));
          }
      },
      x,
      y,
      r,
      h,
    );
  };
  const report = async (label) => {
    const pts = {
      hole: [8, 8],
      sill: [0.5, 8],
      inside: [1.5, 8],
      door: [3, 8],
      corner: [12, 2.5],
      outside: [-1, 8],
    };
    const res = {};
    for (const [k, [lx, ly]] of Object.entries(pts)) {
      const [x, y] = await local(lx, ly, 0);
      const [, , floorZ] = await local(lx, ly, F + 1);
      res[k] = await page.evaluate(
        async (x, y, floorZ) => {
          const R = window.reclaimed;
          const { cellAt } = await import('/src/world/lattice.ts');
          const { readColumn } = await import('/src/world/layout.ts');
          const [cx, cy] = cellAt(x, y);
          const slots = new Uint32Array((await R.core.readBuffer('layers')).buffer);
          const col = readColumn(R.packed, slots, cx, cy);
          // loose ground at or above the room's floor
          const on = col.filter((iv) => iv.z1 > floorZ - 0.6);
          return {
            floor: +floorZ.toFixed(2),
            loose: +on.reduce((a, iv) => a + iv.z1 - Math.max(iv.z0, floorZ - 0.6), 0).toFixed(2),
            col: col.map((iv) => `${iv.z0.toFixed(1)}-${iv.z1.toFixed(1)}:${iv.mat}`).join(' '),
          };
        },
        x,
        y,
        floorZ,
      );
    }
    console.log(label);
    for (const [k, v] of Object.entries(res)) console.log(`  ${k.padEnd(8)} floor ${v.floor}  on it ${v.loose}   [${v.col}]`);
    // a section through the room along its x at y = 8 (the doorway's and the hole's line): sand on the floor
    const line = [];
    for (let lx = -4; lx <= 19; lx++) {
      const [x, y] = await local(lx + 0.5, 8, 0);
      const [, , floorZ] = await local(lx + 0.5, 8, F + 1);
      line.push(
        await page.evaluate(
          async (x, y, floorZ, inside) => {
            const R = window.reclaimed;
            const { cellAt } = await import('/src/world/lattice.ts');
            const { readColumn } = await import('/src/world/layout.ts');
            const slots = new Uint32Array((await R.core.readBuffer('layers')).buffer);
            const col = readColumn(R.packed, slots, ...cellAt(x, y));
            if (!inside) return (col.length ? col[col.length - 1].z1 : 0).toFixed(1);
            const on = col.filter((iv) => iv.z0 >= floorZ - 0.05 && iv.z1 < floorZ + 8);
            return on.reduce((a, iv) => a + iv.z1 - iv.z0, 0).toFixed(1);
          },
          x,
          y,
          floorZ,
          lx >= 1 && lx <= 14,
        ),
      );
    }
    // all the sand on the room's floor (cells sampled at their centres)
    const pts2 = [];
    for (let ly = 1; ly <= 14; ly++)
      for (let lx = 1; lx <= 14; lx++) pts2.push([...(await local(lx + 0.5, ly + 0.5, 0)).slice(0, 2), (await local(lx + 0.5, ly + 0.5, F + 1))[2]]);
    const total = await page.evaluate(async (pts) => {
      const R = window.reclaimed;
      const { cellAt } = await import('/src/world/lattice.ts');
      const { readColumn } = await import('/src/world/layout.ts');
      const slots = new Uint32Array((await R.core.readBuffer('layers')).buffer);
      let t = 0;
      for (const [x, y, f] of pts) for (const iv of readColumn(R.packed, slots, ...cellAt(x, y))) if (iv.z0 >= f - 0.05 && iv.z1 < f + 8) t += iv.z1 - iv.z0;
      return t;
    }, pts2);
    console.log(`  sand on the room's floor: ${total.toFixed(1)} cells (196 floor cells)`);
    // and all the sand round the room (mass: a calm drop must keep it)
    const [ox, oy] = await local(8, 8, 0);
    const all = await page.evaluate(
      async (ox, oy) => {
        const R = window.reclaimed;
        const { cellAt } = await import('/src/world/lattice.ts');
        const { readColumn } = await import('/src/world/layout.ts');
        const slots = new Uint32Array((await R.core.readBuffer('layers')).buffer);
        const [cx, cy] = cellAt(ox, oy);
        let t = 0;
        for (let j = cy - 26; j <= cy + 26; j++)
          for (let i = cx - 26; i <= cx + 26; i++) for (const iv of readColumn(R.packed, slots, i, j)) if (iv.mat === 3) t += iv.z1 - iv.z0;
        return t;
      },
      ox,
      oy,
    );
    console.log(`  all the sand within 26 cells: ${all.toFixed(1)}`);
    // where the rest is: sand over the room's footprint, by height band
    const bands = await page.evaluate(async (pts) => {
      const R = window.reclaimed;
      const { cellAt } = await import('/src/world/lattice.ts');
      const { readColumn } = await import('/src/world/layout.ts');
      const slots = new Uint32Array((await R.core.readBuffer('layers')).buffer);
      const b = { under: 0, floor: 0, roof: 0 };
      for (const [x, y, f] of pts)
        for (const iv of readColumn(R.packed, slots, ...cellAt(x, y))) {
          if (iv.mat !== 3 || iv.z0 < 11.5) continue;
          const d = iv.z1 - iv.z0;
          if (iv.z0 < f - 1.05) b.under += d;
          else if (iv.z0 < f + 8) b.floor += d;
          else b.roof += d;
        }
      return b;
    }, pts2);
    console.log(
      `  sand over the footprint above z 11.5: under the floor ${bands.under.toFixed(1)}, on it ${bands.floor.toFixed(1)}, on the roof ${bands.roof.toFixed(1)}`,
    );
    console.log(`  section (outside: ground top; inside: sand on the floor): ${line.join(' ')}`);
  };
  await report('before');
  await page.screenshot({ path: `${out}-0.png` });
  const waitFor = async (secs) => {
    const t0 = await page.evaluate(() => window.reclaimed.globals.time);
    await page.waitForFunction((t) => window.reclaimed.globals.time >= t, { timeout: 10 * 60 * 1000, polling: 250 }, t0 + secs);
  };
  // 1. calm: sand stamped in the air under the roof's hole (between the
  // floor and the roof) falls
  // onto the floor and slumps out under the roof; none of it is lost
  const dropped = await page.evaluate(
    async (p) => {
      const R = window.reclaimed;
      const { cellAt, cellPos } = await import('/src/world/lattice.ts');
      const { readColumn, columnSlots, packColumn, SLOT_WORDS } = await import('/src/world/layout.ts');
      const slots = new Uint32Array((await R.core.readBuffer('layers')).buffer);
      const [cx, cy] = cellAt(p[0], p[1]);
      let sum = 0;
      for (let j = cy - 2; j <= cy + 2; j++)
        for (let i = cx - 2; i <= cx + 2; i++) {
          const [px, py] = cellPos(i, j);
          if (Math.hypot(px - p[0], py - p[1]) > 1.8) continue;
          const col = readColumn(R.packed, slots, i, j);
          const { base, k } = columnSlots(R.packed, i, j);
          if (col.length >= k) continue;
          col.push({ z0: p[2] + 3, z1: p[2] + 7, mat: 3 });
          sum += 4;
          R.core.host.gpu.device.queue.writeBuffer(R.world.layers, base * SLOT_WORDS * 4, packColumn(col, k));
        }
      return sum;
    },
    await local(8, 8, F + 1),
  );
  console.log(`1. calm: ${dropped} cells of sand dropped over the roof's hole`);
  await waitFor(1);
  await report('after 1s');
  await waitFor(19);
  await report('after 20s');
  await page.screenshot({ path: `${out}-1.png` });
  if (!argv.includes('--calm')) {
    // 2. a steady wind along the room's x, in at the doorway, strong enough to
    // move sand on a calm day (the prevailing wind is 0.3 of this without
    // storms); sand heaped outside, banked up to the doorway's sill
    await page.evaluate(() => {
      const R = window.reclaimed;
      const dir = [Math.cos(0.25), Math.sin(0.25)];
      R.weather.params.baseWindX = dir[0] * 60;
      R.weather.params.baseWindY = dir[1] * 60;
    });
    await heap(-8, 8, 7, 9);
    await heap(-2.5, 8, 4, 5);
    console.log('2. wind in at the doorway, sand heaped outside it');
    await waitFor(seconds / 4);
    await report(`after ${seconds / 4}s`);
    await waitFor((seconds * 3) / 4);
    await report(`after ${seconds}s`);
    await page.screenshot({ path: `${out}-2.png` });
  }
  // a cutaway to see inside: everything over two cells above the floor
  // cleared (the roof, the walls' tops) and the sim paused, so what lies
  // inside stays as it was
  await page.evaluate(() => {
    const R = window.reclaimed;
    R.scene.editor.select('wind');
    R.core.speed = 0;
    const s = window.room;
    const [W, D, H] = s.model.size;
    const keep = 6; // the foundation, the floor and two cells of wall
    const air = new Uint32Array(W * D * (H - keep));
    R.core.host.gpu.device.queue.writeBuffer(R.world.strVox, (s.offset + W * D * keep) * 4, air);
    R.camera.zoom *= 2.4;
  });
  await page.evaluate(() => {
    const el = document.querySelector('[data-sp="0"]');
    if (el) el.click();
  });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: `${out}-cut.png` });
  if (argv.includes('--debug')) {
    // the projected intervals and the open air's floors along the doorway's line
    for (let lx = -3; lx <= 3; lx++) {
      const [x, y] = await local(lx + 0.5, 8, 0);
      console.log(
        `  x ${lx}: ` +
          (await page.evaluate(
            async (x, y) => {
              const R = window.reclaimed;
              const { cellAt } = await import('/src/world/lattice.ts');
              const { readColumn } = await import('/src/world/layout.ts');
              const [cx, cy] = cellAt(x, y);
              const pr = await R.core.readTexture(R.world.proj);
              const lv = await R.core.readTexture(R.world.levels);
              const slots = new Uint32Array((await R.core.readBuffer('layers')).buffer);
              const col = readColumn(R.packed, slots, cx, cy);
              const ivs = [];
              for (let k = 0; k < 3; k++) {
                const o = (cy * pr.w + cx * 3 + k) * 4;
                if (pr.data[o + 1] > pr.data[o]) ivs.push(`${pr.data[o].toFixed(1)}-${pr.data[o + 1].toFixed(1)}`);
              }
              const o = (cy * lv.w + cx) * 4;
              return `proj [${ivs.join(' ')}] levels [${[...lv.data.slice(o, o + 4)].map((v) => v.toFixed(1)).join(' ')}] top ${col.length ? col[col.length - 1].z1.toFixed(2) : 0}`;
            },
            x,
            y,
          )),
      );
    }
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
