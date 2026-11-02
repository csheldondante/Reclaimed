// merge124: the living world's mutations reach the game world when the player looks — headless, on the atlas level as
// the deployed page runs it (?run=opps, every system, 1x). A run's cards resolve; then the run travels (warps) there
// and the systems that realise the world show it:
//   --case tower   the levy raises a watchtower at the town (settlement-building → the settlements' plan → a landmark
//                  tower through the structures contract); the town looked at; then it burns (settlement-condition)
//                  and falls to the dead (warn's failure: settlement-owner → the town's holder)
//   --case weir    the levy closes the hold's weir (river-inflow → the river field's factor); the hold looked at before
//                  and after, the field's values probed
//   --case lead    the town's people led out (lead-out's success: migrate → the hold's people), the hold looked at
//   node scripts/m124world.mjs --case tower|weir|lead [--out C:/Projects/shots88/merge124]
import fs from 'node:fs';
import path from 'node:path';
import { run, sleep } from './lib/runner.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const which = arg('case', 'tower');

await run({ name: `m124world-${which}`, kind: 'behaviour', size: arg('size', '412x915') }, async (R) => {
  const dir = R.opt('out', 'C:/Projects/shots88/merge124');
  fs.mkdirSync(dir, { recursive: true });
  const shot = async (name) => {
    const f = path.join(dir, `world-${which}-${name}.png`);
    await p.screenshot({ path: f });
    R.log(`saved ${f}`);
  };
  const p = await R.level({ level: 'atlas', run: 'opps', hero: 'hoverbike', tod: '0.35' });
  await p.waitForFunction(() => (window.reclaimed?.opps && window.reclaimed.runhero?.hero) || document.querySelector('.fatal'), { timeout: 180000, polling: 250 });
  await R.fatal(p);
  await p.evaluate(() => {
    const L = window.reclaimed.opps;
    L.pickHero('hoverbike');
    L.stage = 'play';
    L.render();
  });
  await sleep(Number(R.opt('settle', 30000)));
  await R.fatal(p);
  // the cast at the locus (the fact layer seeded from the atlas world)
  const cast = await p.evaluate(() => {
    const O = window.reclaimed.opps.opps;
    return { locus: O.w.name(O.locus), cast: O.cast.map((id) => `${O.w.name(id)} (${O.w.ws.character(id)?.role})`), voice: O.w.name(O.stage.voice) };
  });
  R.log(`the locus ${cast.locus}, its voice ${cast.voice}, its cast: ${cast.cast.join(', ')}`);
  R.check('a cast of 5-8 named people at the locus', cast.cast.length >= 5 && cast.cast.length <= 8, cast);

  /** look at a world point (world units): the window warped there, the card and the map out of the way */
  const lookAt = async (pt, name, wait = 12000, zoom = 0) => {
    await p.evaluate(async (pt, zoom) => {
      const L = window.reclaimed.opps;
      L.card.style.display = 'none';
      L.d.map.close();
      const ROW_H = Math.sqrt(3) / 2;
      await L.d.warp(pt[0], pt[1] / ROW_H);
      const cam = window.reclaimed.camera;
      const w = L.d.toWin(pt);
      cam.target[0] = w[0];
      cam.target[1] = w[1];
      cam.target[2] = window.reclaimed.runhero.world.top(w[0], w[1]);
      if (zoom) cam.zoom = zoom;
    }, pt, zoom);
    await sleep(wait);
    await R.fatal(p);
    await shot(name);
  };
  const toHoldEdge = async () => {
    await p.evaluate(() => window.reclaimed.runsit.fastForward(['c-hold']));
    await sleep(6000);
    await p.evaluate(() => window.reclaimed.opps.skipArea(true));
    await sleep(1500);
    return p.evaluate(() => {
      const O = window.reclaimed.opps.opps;
      return { offered: O.offered.map((o) => `${o.template}${o.affordable ? '' : ' (unaffordable)'}`), hold: O.sit.areas.find((a) => a.play.kind === 'deliver'), town: O.sit.target };
    });
  };
  /** the way on with this template taken without playing its leg, then the climax (what's running comes off) */
  const ride = (template) =>
    p.evaluate((template) => {
      const L = window.reclaimed.opps;
      const O = L.opps;
      const o = O.offered.find((x) => x.template === template);
      if (!o) throw new Error(`no ${template} offered: ${O.offered.map((x) => x.template).join(', ')}`);
      O.play(o.id);
      O.arrive();
      L.log.push(...O.log.splice(0));
      return { at: O.sr.at, phase: O.sr.phase, climaxed: O.climaxed };
    }, template);

  if (which === 'tower' || which === 'weir') {
    const edge = await toHoldEdge();
    R.log(`at the hold's edge: ${edge.offered.join(', ')}`);
    const card = which === 'tower' ? 'watchtower' : 'weir';
    R.check(`the ${card} card is dealt to the levy`, edge.offered.includes(card), edge.offered);
    // its detail (an effect card with its reward)
    await p.evaluate((card) => {
      const L = window.reclaimed.opps;
      L.card.style.display = '';
      if (L.run.offers.length) L.run.take(null);
      L.selected = L.opps.offered.find((x) => x.template === card).id;
      L.render();
    }, card);
    await sleep(2500);
    await shot('card');
    const holdAt = await p.evaluate(() => {
      const O = window.reclaimed.opps.opps;
      return O.sr.map.areaAt(O.sit.areas.find((a) => a.play.kind === 'deliver'));
    });
    const townAt0 = await p.evaluate(() => window.reclaimed.opps.opps.sr.map.areaAt(window.reclaimed.opps.opps.sr.finaleArea));
    if (which === 'tower') {
      await lookAt(townAt0, 'town-before', 25000, 5);
      // (back to the hold, where the levy is committed: the town is looked at again when the run gets there)
      await lookAt(holdAt, 'at-hold', 8000);
    }
    if (which === 'weir') {
      await lookAt(holdAt, 'river-before', 20000, 4);
      const before = await p.evaluate(() => window.reclaimed.opps.opps.w.ws.region(window.reclaimed.opps.opps.sit.areas.find((a) => a.play.kind === 'deliver').region).wetness);
      R.log(`the hold's region's inflow before: ${before}`);
    }
    await p.evaluate((card) => {
      const L = window.reclaimed.opps;
      L.commitTemplate(card);
    }, card);
    const r = await ride('warn');
    R.log(`rode on: ${JSON.stringify(r)}`);
    const done = await p.evaluate((card) => {
      const O = window.reclaimed.opps.opps;
      const res = O.engine.past.find((x) => x.template === card);
      const t = O.sit.target.settlement;
      const st = window.reclaimed.opps.d.settlements;
      return { tier: res?.resolution?.tier, result: res?.result, placed: st.byId?.get(t)?.placed ?? null, buildings: O.w.ws.settlements.find((s) => s.id === t)?.buildings.map((b) => b.id) };
    }, card);
    R.log(`${card} resolved: ${JSON.stringify(done)}`);
    R.check(`the ${card} came off`, done.tier === 'success' || done.tier === 'cost', done);
    if (which === 'tower') {
      R.check('the world placed it (settlement-building) and the settlements system took it (its plan to make again)', (done.buildings ?? []).includes('watchtower') && (done.placed ?? []).some((x) => x.id === 'watchtower'), done);
      const townAt = await p.evaluate(() => window.reclaimed.opps.opps.sr.map.areaAt(window.reclaimed.opps.opps.sr.finaleArea));
      await lookAt(townAt, 'town', 25000, 5);
      const towerAt = await p.evaluate(() => {
        const O = window.reclaimed.opps.opps;
        const S = window.reclaimed.opps.d.settlements;
        const pl = S.plan(O.sit.target.settlement);
        const b = pl?.city.placed?.[0];
        const t = b ? S.things.get(`${O.sit.target.settlement}:b${b.building}`) : null;
        return t ? [t.place.at[0], t.place.at[1]] : null;
      });
      R.log(`the watchtower stands at ${JSON.stringify(towerAt)}`);
      if (towerAt) await lookAt(towerAt, 'tower-close', 8000, 9);
      const plan = await p.evaluate(() => {
        const O = window.reclaimed.opps.opps;
        const pl = window.reclaimed.opps.d.settlements.plan(O.sit.target.settlement);
        return pl ? { placed: pl.city.placed ?? null, towers: pl.city.megas.filter((m) => m.kind === 'tower').length } : null;
      });
      R.log(`the town's plan now: ${JSON.stringify(plan)}`);
      R.check('the town, looked at, stands with the watchtower raised (the plan made again with it)', !!plan?.placed?.length, plan);
      // the town burns and falls: condition and holder
      const end = await p.evaluate(async () => {
        const L = window.reclaimed.opps;
        const O = L.opps;
        const t = O.sit.target.settlement;
        const was = L.d.settlements.settlement(t)?.faction;
        L.finishRun('burned', 60);
        L.end();
        return { was, now: L.d.settlements.settlement(t)?.faction, world: O.w.ws.settlements.find((s) => s.id === t)?.faction, condition: L.d.settlements.settlement(t)?.condition, foe: O.sit.threat.faction };
      });
      R.log(`the town after: ${JSON.stringify(end)}`);
      R.check('burned: the settlements system has it ruined (the settlement-condition event, its one owner)', end.condition === 'ruined', end);
      R.check("fallen: the town's holder is the dead's faction, in the world and the settlements system (settlement-owner)", end.now === end.foe && end.world === end.foe, end);
    } else {
      await lookAt(holdAt, 'river-after', 20000, 4);
      const probe = await p.evaluate(() => {
        const O = window.reclaimed.opps.opps;
        const hold = O.sit.areas.find((a) => a.play.kind === 'deliver');
        const lv = window.reclaimed.level ?? null;
        return { inflow: O.w.ws.region(hold.region).wetness, region: hold.region };
      });
      R.log(`the hold's region's inflow after: ${JSON.stringify(probe)}`);
      R.check("the weir set the hold's rivers' inflow (river-inflow)", probe.inflow < 0.5, probe);
    }
  } else {
    // lead out: the road, then warn and lead the people out; the run ends evacuated
    await p.evaluate(() => window.reclaimed.runsit.fastForward(['c-road']));
    await sleep(6000);
    await p.evaluate(() => window.reclaimed.opps.skipArea(true));
    await sleep(1500);
    const before = await p.evaluate(() => {
      const O = window.reclaimed.opps.opps;
      const hold = O.sit.areas.find((a) => a.play.kind === 'deliver')?.settlement;
      const S = window.reclaimed.opps.d.settlements;
      return { hold, people: JSON.stringify(S.settlement(hold)?.people ?? []), town: JSON.stringify(S.settlement(O.sit.target.settlement)?.people ?? []) };
    });
    await ride('lead-out');
    const after = await p.evaluate(() => {
      const L = window.reclaimed.opps;
      const O = L.opps;
      L.finishRun('evacuated', 60);
      L.end();
      const S = L.d.settlements;
      const hold = O.sit.areas.find((a) => a.play.kind === 'deliver')?.settlement;
      return { people: S.settlement(hold)?.people ?? [], world: O.w.ws.settlements.find((s) => s.id === hold)?.people ?? [], town: S.settlement(O.sit.target.settlement)?.people ?? [], history: O.w.ws.history().filter((e) => e.kind === 'migrate').length };
    });
    R.log(`the hold's people before ${before.people}, after ${JSON.stringify(after.people)}; the town's before ${before.town}, after ${JSON.stringify(after.town)}; migrate events ${after.history}`);
    R.check('led out: the town\'s people moved to the hold (migrate), in the world and the settlements system', after.history > 0 && after.people.some((x) => x.role === 'refugee' && x.count > 0), after);
    const holdAt = await p.evaluate(() => {
      const O = window.reclaimed.opps.opps;
      return O.sr.map.areaAt(O.sit.areas.find((a) => a.play.kind === 'deliver'));
    });
    await lookAt(holdAt, 'hold-refugees', 20000);
    const units = await p.evaluate(() => {
      const L = window.reclaimed.opps;
      const O = L.opps;
      const hold = O.sit.areas.find((a) => a.play.kind === 'deliver')?.settlement;
      const all = L.d.units.query(L.d.toWin(O.sr.map.areaAt(O.sit.areas.find((a) => a.play.kind === 'deliver'))), 200);
      return { here: all.filter((u) => u.settlement === hold).length, refugees: all.filter((u) => u.settlement === hold && u.role === 'refugee').length };
    });
    R.log(`at the hold: ${JSON.stringify(units)}`);
    R.check('the hold, looked at, has the refugees among its people (its units)', units.refugees > 0, units);
  }
  const log = await p.evaluate(() => window.reclaimed.runsit.log.slice(-40));
  for (const l of log) R.log(`run: ${l}`);
  await R.fatal(p);
});
