// The placement phone bench (round 128m, townlab; the user: "How about you build a bench for me to run that places
// buildings?"). One link, run on the phone, on a fresh world (?fresh=1: the saved world cleared at the start, so the run
// changes nothing it would keep):
//   /?skipmenu=1&level=atlas&town=1&fortress=1&fresh=1&q=low&bench=place          (…&placearrive=300 sim s, &placetypes=house,wall)
// Each building type at points round the start town (perf/placebench/points.ts: inside the walls, 30/60/120 m eight
// ways, across the water, on a hill): the reach's answer and the panel's line, the tap's CPU, the answer's delay, the
// frames round it; then houses at the points they were kept on, Build at 16x, and which the builders reach. A plain
// summary on screen and a JSON to download; the screen kept awake. The lab runs the same (lab.placeBench(), the
// `town` recipe: scripts/lab/placebench.mjs).
import { deviceFacts, keepAwake, letSleep, Panel, reportButtons, wakeLog } from './bench';
import { runPlaceBench, type PlaceBenchIO, type PlaceBenchResult } from './placebench/run';
import { placeSummary } from './placebench/summary';
import { diagnose, diagnosisLines, type Diagnosis } from './placebench/diagnose';
import type { PackedWorld } from '../world/layout';
import type { Fortress } from '../fortress/fortress';
import type { StructureType } from '../api/contracts/fortress';

declare const __BUILD_COMMIT__: string;
declare const __BENCH_BUILD__: string;
const BUILD = { commit: typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev', at: typeof __BENCH_BUILD__ !== 'undefined' ? __BENCH_BUILD__ : 'dev' };
const LAST = 'reclaimed.placebench.last';
const frame = () => new Promise<number>((r) => requestAnimationFrame(r));

interface Rec {
  core: { host: Parameters<typeof deviceFacts>[0]; readBuffer(name: 'layers' | 'water'): Promise<Float32Array>; packed: PackedWorld; dims: { w: number; h: number } };
  stream: { origin: [number, number] };
  settlements?: { pinnedId: string | null; settlement(id: string): { name: string } | null };
  townFixture(): Promise<string>;
  fortress?: Fortress;
  scene: { speed: number; heightAt(x: number, y: number): number; units?: { get(id: number): { at: [number, number, number] } | undefined } };
  fortressLife?: () => { people(): Iterable<number> } | undefined;
}

/** the bar's button with this text (the player's own buttons) */
function press(text: string): void {
  const b = [...document.querySelectorAll<HTMLButtonElement>('.fort-bar button')].find((e) => e.textContent?.trim() === text);
  if (!b) throw new Error(`place bench: no "${text}" button on the bar`);
  b.click();
}

/** the game's IO: real frames, real time at the bar's speeds (sim seconds counted as frame time x speed, a frame at most 0.1 s) */
export function gameIO(R: Rec, log?: (l: string) => void): PlaceBenchIO {
  const f = R.fortress!;
  let simT = 0;
  return {
    fort: f,
    frame,
    ground: (x, y) => R.scene.heightAt(x, y),
    build: () => {
      const go = document.querySelector<HTMLButtonElement>('.fort-bar button.go');
      if (!go) throw new Error('place bench: no Build button');
      go.click();
    },
    advance: async (seconds, speed) => {
      if (R.scene.speed !== speed) press(`${speed}x`);
      const end = simT + seconds;
      let last = await frame();
      while (simT < end) {
        const t = await frame();
        simT += (Math.min(100, t - last) / 1000) * R.scene.speed;
        last = t;
      }
    },
    simTime: () => simT,
    walkers: () => [...(R.fortressLife?.()?.people() ?? [])].flatMap((id) => {
      const u = R.scene.units?.get(id);
      return u ? [[u.at[0], u.at[1]] as [number, number]] : [];
    }),
    log,
  };
}

/** the report (JSON) of a run */
export function placeReport(result: PlaceBenchResult, extra: Record<string, unknown>): Record<string, unknown> {
  return { kind: 'reclaimed-placebench', version: 2, build: BUILD, ...extra, summary: [...placeSummary(result), ...(result.diagnosis ? diagnosisLines(result.diagnosis as Diagnosis) : [])], result };
}

export async function placeBench(params: URLSearchParams): Promise<void> {
  const R = (window as unknown as { reclaimed: Rec }).reclaimed;
  const panel = new Panel(document.body);
  const prev = localStorage.getItem(LAST);
  if (prev) reportButtons(panel, prev, true, 'placebench', 'Reclaimed placement bench');
  panel.text(`build ${BUILD.commit} (${BUILD.at})`);
  if (params.get('fresh') !== '1') {
    panel.say('The placement bench needs a fresh world: add &fresh=1 to the link and load it again.');
    return;
  }
  if (!R.fortress) {
    panel.say('The placement bench runs on the fortress: add &town=1&fortress=1 to the link.');
    return;
  }
  const held = await keepAwake();
  panel.say('Placement bench: started fresh (?fresh=1), so nothing it builds is kept. Waiting for the fortress…');
  const f = R.fortress;
  while (!f.ready || !f.reachKnown) await frame();
  const startedAt = new Date().toISOString();
  const device = await deviceFacts(R.core.host);
  const arriveS = Number(params.get('placearrive') ?? 300);
  let n = 0;
  // (round 128m: the phone's town wasn't the desktop's — its land saved for the lab, and the reach diagnosed on it)
  let town: string | null = null;
  let diag: Diagnosis | null = null;
  const result = await runPlaceBench(
    gameIO(R, (l) => panel.say(`Placement bench: ${++n} placed. ${l}`)),
    {
      arriveS,
      types: params.get('placetypes') ? (params.get('placetypes')!.split(',') as StructureType[]) : undefined,
      diagnose: async (points) => {
        panel.say('Placement bench: saving the town for the lab and checking the reach…');
        town = await R.townFixture();
        const st = R.settlements;
        const id = st?.pinnedId ?? null;
        diag = await diagnose(
          {
            fort: f,
            readBuffer: (name) => R.core.readBuffer(name),
            packed: R.core.packed,
            dims: R.core.dims,
            windowOrigin: [R.stream.origin[0], R.stream.origin[1]],
            town: { id, name: id ? (st?.settlement(id)?.name ?? null) : null },
            heightAt: (x, y) => R.scene.heightAt(x, y),
          },
          points,
        );
        return diag;
      },
    },
  );
  await letSleep();
  const report = placeReport(result, { startedAt, finishedAt: new Date().toISOString(), url: location.href, fresh: true, device, wakeLock: held, wakeLog: [...wakeLog] });
  const body = JSON.stringify(report, null, 1);
  (window as unknown as { placeBenchReport: string }).placeBenchReport = body;
  try {
    localStorage.setItem(LAST, body);
  } catch {
    // (the browser's storage full: the download is the copy)
  }
  panel.say('Placement bench done. It started fresh, so nothing it built is kept.');
  panel.text((report.summary as string[]).join(String.fromCharCode(10)));
  reportButtons(panel, body, false, 'placebench', 'Reclaimed placement bench', true);
  // (the town's land for the lab: data/lab/town.rclt — the desktop's atlas makes another town)
  const t = town as string | null;
  if (t) {
    const note = panel.text('');
    panel.button('Download the town (for the lab)', false, () => {
      const bin = Uint8Array.from(atob(t), (ch) => ch.charCodeAt(0));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bin], { type: 'application/octet-stream' }));
      a.download = `reclaimed-town-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.rclt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      note.textContent = `saved ${a.download} (${(bin.length / 1024).toFixed(0)} KB) to Downloads`;
    });
    (window as unknown as { placeBenchTown: string }).placeBenchTown = t;
  }
}
