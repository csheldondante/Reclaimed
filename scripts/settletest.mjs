// The settlements' planner through its API (round 88), no browser: every atlas site of seed 1 (the wiki's
// records, data/atlas/seed1.json) planned on a made-up ground (gentle hills, a slope, a pond), checked for
// what the city game and the agents need — districts on their profile's grids, buildings that are Instances
// with a derived use, homes and stores and jobs to walk to, fields, walls, camps — and that the same seed
// plans the same. `--png <dir>`: a top view of a few plans (height shaded, coloured by material).
//   node scripts/settletest.mjs [--png C:/Projects/shots88/settlements]
import { createServer } from 'vite';
import fs from 'node:fs';
import zlib from 'node:zlib';

const v = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
let fails = 0;
const ok = (cond, what) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`);
  if (!cond) fails++;
};
const pngDir = process.argv.includes('--png') ? process.argv[process.argv.indexOf('--png') + 1] : null;

function png(path, w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const crcT = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (b) => {
    let c = -1;
    for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (t, d) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([l, td, c]);
  };
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(w, 0);
  ih.writeUInt32BE(h, 4);
  ih[8] = 8;
  ih[9] = 2;
  fs.writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

try {
  const { buildWiki } = await v.ssrLoadModule('/src/gm/wiki.ts');
  const { recordsFrom } = await v.ssrLoadModule('/src/settle/records.ts');
  const { planSettlement } = await v.ssrLoadModule('/src/settle/plan.ts');
  const { MATERIALS } = await v.ssrLoadModule('/src/world/materials.ts');
  const facts = JSON.parse(fs.readFileSync('data/atlas/seed1.json', 'utf8'));
  const wiki = buildWiki(facts);
  const recs = recordsFrom(wiki, facts.params.seed);
  ok(recs.length === facts.sites.length, `a record for every site (${recs.length})`);
  ok(recs.every((r, i) => r.rec.id === `s${i}` && r.rec.name === wiki.snapshot.settlements[i].name), 'ids and names are the wiki\'s');
  const civs = new Map();
  for (const r of recs) civs.set(r.civ.profile.id, (civs.get(r.civ.profile.id) ?? 0) + 1);
  ok(civs.size >= 3, `several peoples: ${[...civs].map(([k, n]) => `${k} ${n}`).join(', ')}`);
  ok(recs.some((r) => r.campId), `camps by ${recs.filter((r) => r.campId).length} of them`);

  const ground = (box, sea, kind) => {
    const N = box.w * box.h;
    const g = new Float32Array(N);
    const water = new Float32Array(N);
    const top = new Uint8Array(N).fill(14);
    const veg = new Float32Array(N);
    for (let y = 0; y < box.h; y++)
      for (let x = 0; x < box.w; x++) {
        const i = y * box.w + x;
        const wx = x + box.x0;
        const wy = y + box.y0;
        let z = sea + 12 + 4 * Math.sin(wx * 0.05) * Math.cos(wy * 0.04) + (kind === 'slope' ? x * 0.12 : 0);
        if (kind === 'pond' && Math.hypot(x - box.w * 0.7, y - box.h * 0.3) < 10) {
          z = sea - 1;
          water[i] = 1.5;
        }
        g[i] = z;
        if (Math.sin(wx * 0.31) * Math.cos(wy * 0.27) > 0.93) top[i] = 1;
        if (Math.sin(wx * 0.021 + 1) * Math.cos(wy * 0.017) > 0.6) veg[i] = 4;
      }
    return { ground: g, water, top, veg };
  };
  const plans = [];
  let ms = 0;
  for (const [i, r] of recs.entries()) {
    const kind = ['flat', 'slope', 'pond'][i % 3];
    const gr = ground(r.box, facts.params.sea, kind);
    const p = planSettlement({ ...r, rec: structuredClone(r.rec), ...gr, sea: facts.params.sea });
    ms += p.ms;
    plans.push({ r, p, kind, gr });
  }
  console.log(`planned ${plans.length} in ${ms.toFixed(0)} ms (${(ms / plans.length).toFixed(1)} each)`);
  const all = plans.map((x) => x.p);
  ok(all.every((p) => p.rec.grids.length >= 2), 'every one has districts (and fields)');
  const styles = new Set(all.flatMap((p) => p.rec.grids.map((g) => g.style)));
  ok(['radial', 'contour-voronoi', 'irregular', 'orthogonal'].every((s) => styles.has(s)), `all four grid styles used: ${[...styles].join(', ')}`);
  ok(all.every((p) => p.rec.buildings.some((b) => b.use.includes('housing'))), 'every one has homes');
  ok(all.every((p) => p.rec.buildings.every((b) => p.things.has(b.thing))), 'every building is a thing');
  ok(all.every((p) => p.rec.buildings.some((b) => b.use.includes('meeting-hall'))), 'every one has a hall (derived: meeting-hall)');
  const homes = all.map((p) => p.spots.filter((s) => s.kind === 'home').length);
  ok(Math.min(...homes) >= 1, `homes to walk to: ${Math.min(...homes)}..${Math.max(...homes)}`);
  ok(all.every((p) => p.spots.some((s) => s.kind === 'farm')), 'every one has fields to farm');
  ok(all.every((p) => p.spots.some((s) => s.kind === 'store')), 'every one has a store');
  const ruins = all.filter((p) => p.rec.founded?.over);
  ok(ruins.length > 0 && ruins.every((p) => p.things.get(p.rec.founded.over).history.some((e) => e.what === 'adapted')), `ruins adapted: ${ruins.length}`);
  const walls = all.filter((p) => p.rec.buildings.some((b) => b.use.includes('defence')));
  ok(walls.length > 0, `walled: ${walls.length}`);
  const camps = all.filter((p) => p.camp);
  ok(camps.length > 0, `camps placed: ${camps.length} of ${recs.filter((r) => r.campId).length}`);
  const pond = plans.filter((x) => x.kind === 'pond');
  for (const { p, gr } of pond) for (const [c, cp] of p.columns) if (gr.water[c] >= 1 && cp.ivs.length && cp.ivs[cp.ivs.length - 1].z1 - cp.lo >= 1.2) { console.log('  in the pond:', p.rec.id, c, JSON.stringify(cp)); break; }
  ok(pond.every(({ p, gr }) => [...p.columns.entries()].every(([c, cp]) => gr.water[c] < 1 || cp.ivs.length === 0 || cp.ivs[cp.ivs.length - 1].z1 - cp.lo < 1.2)), 'nothing built in the pond');
  // the same again: the same columns
  const again = planSettlement({ ...plans[7].r, rec: structuredClone(plans[7].r.rec), ...plans[7].gr, sea: facts.params.sea });
  const key = (p) => JSON.stringify([...p.columns.entries()].slice(0, 400)) + JSON.stringify(p.rec.buildings);
  ok(key(again) === key(plans[7].p), 'the same seed plans the same');
  const sizes = {};
  for (const p of all) sizes[p.rec.size] = Math.max(sizes[p.rec.size] ?? 0, p.rec.buildings.length);
  console.log('buildings (most) by size', JSON.stringify(sizes));
  if (pngDir) {
    fs.mkdirSync(pngDir, { recursive: true });
    const pick = [];
    for (const st of ['radial', 'contour-voronoi', 'irregular', 'orthogonal']) {
      const x = plans.find((q) => q.p.rec.grids[0].style === st && (q.p.rec.size === 'town' || q.p.rec.size === 'city') && !pick.includes(q));
      if (x) pick.push(x);
    }
    for (const { p, r, gr } of pick) {
      const { w, h } = r.box;
      const S = 3;
      const rgb = Buffer.alloc(w * S * h * S * 3);
      for (let y = 0; y < h * S; y++)
        for (let x = 0; x < w * S; x++) {
          const c = Math.floor(y / S) * w + Math.floor(x / S);
          const cp = p.columns.get(c);
          let col = [0.3, 0.5, 0.25];
          let z = gr.ground[c];
          if (gr.water[c] > 0.3) col = [0.2, 0.3, 0.5];
          if (cp && cp.ivs.length) {
            const t = cp.ivs[cp.ivs.length - 1];
            col = MATERIALS[t.mat].albedo;
            z = t.z1;
          }
          if (!cp || !cp.ivs.length) {
            // the growth field: warm where the settlement is strong
            const cx = (c % w) + 0.5 + 0.5 * (Math.floor(c / w) & 1);
            const cy = (Math.floor(c / w) + 0.5) * 0.866;
            const fv = p.field.at(cx / 3, cy / 3).v;
            col = col.map((v, k) => v * (1 - 0.6 * fv) + [1, 0.45, 0.15][k] * 0.6 * fv);
          }
          const sh = Math.min(1.4, 0.55 + (z - facts.params.sea) / 40);
          const o = (y * w * S + x) * 3;
          for (let k = 0; k < 3; k++) rgb[o + k] = Math.min(255, col[k] * sh * 255);
        }
      // the lots' outlines and the spots
      for (const [gid, lg] of p.grids) {
        for (let c = 0; c < lg.count; c++)
          for (let e = 0; e < 4; e++) {
            const [ax, ay] = lg.corner(c, e);
            const [bx, by] = lg.corner(c, e + 1);
            for (let t = 0; t <= 1; t += 0.02) {
              const px = Math.round((ax + (bx - ax) * t) * S);
              const py = Math.round(((ay + (by - ay) * t) / 0.866) * S);
              if (px < 0 || py < 0 || px >= w * S || py >= h * S) continue;
              const o = (py * w * S + px) * 3;
              const shade = gid.endsWith('fields') ? [120, 110, 60] : [255, 255, 255];
              if (lg.lots[lg.lotOf[c]].inner.includes(c) || gid.endsWith('fields')) rgb.set(shade, o);
            }
          }
      }
      const spotCol = { home: [60, 200, 255], store: [255, 220, 0], farm: [120, 255, 60], mine: [255, 80, 255], post: [255, 40, 40], repair: [255, 140, 0], camp: [255, 0, 0], trade: [0, 255, 200], make: [255, 255, 255] };
      for (const s of p.spots) {
        const px = Math.round(s.at[0] * S);
        const py = Math.round((s.at[1] / 0.866) * S);
        for (let dy = -3; dy <= 3; dy++)
          for (let dx = -3; dx <= 3; dx++) {
            const X = px + dx;
            const Y = py + dy;
            if (X < 0 || Y < 0 || X >= w * S || Y >= h * S) continue;
            rgb.set(spotCol[s.kind] ?? [0, 0, 0], (Y * w * S + X) * 3);
          }
      }
      const f = `${pngDir}/plan-${p.rec.grids[0].style}-${p.rec.id}.png`;
      png(f, w * S, h * S, rgb);
      console.log(`  ${f}: ${p.rec.name} (${p.rec.size}, ${r.civ.profile.id}, ${p.rec.grids.map((g) => g.style).join(' + ')}), ${p.rec.buildings.length} buildings`);
    }
  }
} catch (e) {
  console.error(e);
  fails++;
} finally {
  await v.close();
}
process.exit(fails ? 1 : 0);
