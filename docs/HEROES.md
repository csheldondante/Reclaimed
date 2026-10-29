# Heroes in a run story — the interface (round 88, branch `runstory`)

For the hoverbike session (gampeplaygm-40, which vendors `places` as a submodule): how your heroes (the
hoverbike knight, the lich, the tank, the mech, the hookshot knight) plug into a run story on the atlas level.
The user (round 88): "I would like to try spawning as a character like in hoverbike and talking to people or
going places or fighting things for a run story."

## What's there

`?skipmenu=1&level=atlas&run=bell` plays the GM's first story (data/stories/the-bell-under-kaudru.json) as a
hero on foot. Its pieces, each behind its own interface:

| Piece | Interface | Implementation here |
|---|---|---|
| the hero | `Hero` (src/api/contracts/hero.ts) | src/hero/walker.ts `Walker` (on foot, a sword) |
| its controller | `HeroController` | src/hero/touchpad.ts `TouchPad` (a floating stick, ⚔, a context button; WASD, Space, E) |
| the people and monsters | `Units` (src/api/contracts/units.ts) | src/units/simple.ts `SimpleUnits` (CPU); the `settlements` branch's GPU agents next |
| their figures | — | src/units/figures.ts (voxel figures through Renderer.addVoxels) |
| the places | `Stage` (src/story/play.ts) | src/story/stage-gen.ts `stageStory` (the briefs built near the spawn) |
| the story | `Run`, `Dialog` | StoryPlay (src/story/play.ts): StoryRun, DialogBox, the objective list, StoryCamera |
| all of it | — | src/story/hero-run.ts `HeroRun`, started by scenes/level.ts `startRun` |

## Plugging in a hero

A hero implements `Hero`:

```ts
interface Hero {
  readonly id: string;              // its id as an actor: units' targets, Units.hit(…, by)
  readonly role: string;            // 'hoverbike knight' (RunRecord.hero)
  readonly actor: Actor;            // { id, faction, position(), alive(), hurt(damage, by) } — hostile units chase and hit it
  readonly abilities: HeroAbility[];// { id, name, cooldown() }
  readonly camera: HeroCamera;      // { zoom, behind (Orbit.prefer.dead, radians), firm? }
  position(): V3; heading(): number; speed(): number;
  readonly health: number; readonly maxHealth: number; readonly alive: boolean;
  update(dt: number, intent: HeroIntent): void;   // { move: [x, y] world direction 0..1, goTo?, attack?, sprint?, use?: string[] }
  place(at: V2): void;
  shift(dx: number, dy: number, dz: number): void; // the streamed window slid
  readonly hurt: ((damage: number, by: string) => void)[];
  readonly died: (() => void)[];
}
```

- It's made with a `HeroWorld`, `{ ground, units }`. `ground.heightAt(x, y, { smooth: true })` is the world API's
  terrain (the drawn mesh's height), and `units` is the `Units` it fights. Abilities act on the world only
  through the world API (terrain, water, fx …), `Units.hit` and items. Never through another system's buffers.
- Pass it as `HeroRunDeps.makeHero: (world, at) => new HoverbikeKnight(world, at)`. HeroRun draws a `Walker`
  itself. Any other hero draws itself: your own models, through `Renderer.addVoxels` / `addMesh` or your own
  draw.
- The controller is yours too. Anything with `intent(): HeroIntent`; TouchPad is the on-foot one. A tap on a
  person or the ground is HeroRun's (talk, fight, walk there). A vehicle may ignore `goTo`.
- Coordinates: the level's window (x in cells, y in world units, z the ground), the same as the world API's.

## The chase camera

HeroRun follows `position()` (StoryCamera.follow, a spring), sets `camera.zoom` from `hero.camera.zoom`, and,
while `speed() > 0.5`, sets the cutaway's `Orbit.prefer = { az: heading + π, dead: camera.behind, firm:
camera.firm }`. That draws the view round behind the hero, the hoverbike's "settle within 30° of behind";
the Walker uses 35° and 80°. When a cliff hides the hero, the orbit still turns to a clear angle. A talk
frames the speaker; then the view eases back.

## The run's rules a hero meets

- `reached` comes from `position()`: the story's places and their rooms (BACKLOG D8).
- A locked door (a brief's lock) opens when the hero comes within 4.5 cells of it holding its key.
- Hostile units (`spawn.hostile`, or a cast member an outcome turns `hostile`) notice the actor within their
  sight, chase it and swing: a 0.45 s wind-up, then the blow lands if the actor is still in reach. The hero's
  `hurt` and `died` follow; dying ends the run, lost.
- Killing a unit notes `killed { character, unitKind }`, which the story's conditions read.

## Handoff note (round 88)

- On `runstory`: the contracts (hero.ts, units.ts) and the on-foot hero, tested headlessly by
  scripts/runtest.mjs (won and lost).
- To try a hoverbike hero: implement `Hero` over your bike's controller, give HeroRun a `makeHero`, and use
  `?run=bell`. The bike must keep `position()` on the ground the world API reports. It must take blows through
  `actor.hurt` and call `died` at 0 health.
- Changes to these contracts are additive only; tell `places` (main) before changing a signature.

## Round 97 (branch `heroapi`): a game's own hero, controller, units and camera

The hoverbike game plays the run through `startAtlasRun` (src/story/atlas-run.ts) with:

- `makeHero` — its HoverHero (a `Hero` around each of its Units). `claims(sx, sy)`: the taps its mechanics take
  (the lich's float, the mech's aim) are asked first and never walk or talk; `goesTo: false` for a vehicle.
- `makeController` — its own Controls as a `RunController` (onTap for the taps it doesn't claim, onAction /
  setAction for "Talk to …", setHealth, hidden). Or emit `HeroIntent.talk`.
- `units` — its Units over sim.agents (the same agents its abilities hold, fling and burn), so the story counts
  every kill; HeroRun draws no figures for them.
- `ownCamera` — it keeps its chase camera; it drives it while `hr.cameraFree` (no story shot).
- `again`, `remember` — the end card's new run (back to its hero select); past runs' events realised at the start.

Dialog as an event: a happening's `when` (a `killed`, a `reached`, a `saw`, an `event`) can fire `say` (barks over a
speaker, or the narrator's) and `talk` (a dialog opens once the player is by the speaker).

## Round 112 (branch `herosandbox`, BACKLOG HS1): the hero sandbox, the registry, heroes from another build

The user (round 112): "we need a hero sandbox where I can just drop into the map as different heros and play
generated gauntlets or maps I edit. Maybe like the airplane mode? A way to spawn enemies would be good though or to
instantly fill up a vessel with a sand or liquid" — "You have to bring in the other heros via what contract" — "I
need to test the actual interfaces and tweak them" — "Or at least provide feedback".

### Using it

In every sandbox level (the playground, the atlas sandbox, the editor's sandbox, the labs):
`/Reclaimed/herosandbox/?skipmenu=1&level=playground` (or `level=atlas`, `level=sandbox`).

- **🧍** (top left, or **H**) drops you in as the hero chosen beside it, at the ground under the screen's middle (or
  the map's 📍 start), and back out to the editor, like ✈ does for the free camera. In: drag anywhere for the stick, ⚔
  to swing, 🏃 to run (WASD, Space, Shift on a keyboard); a tap on the ground walks there.
- **The inspector** (under 🧍; ▾ folds it, and on a phone it starts folded): position, heading, speed, health, the
  camera's zoom / behind / firm, the HeroIntent this frame (move, goTo, attack, sprint, use, talk, and the keys of
  `input` when a controller passes its own through), each ability's cooldown against its duration, and the hero's
  flags (claims, goesTo, ownCamera, how many tunables). Under it, the last calls across the boundary.
- **🎚 hero** (top right while in): the hero's tuning panel, with the camera (zoom, behind°, firm°, the sandbox's
  follow rate) and every `Hero.tunables` entry as a slider. It keeps presets per role, exports them and copies a
  `?herotune=` string.
- **💬 feedback**: the contract feedback note (below).
- **Tools.** Each takes the next taps on the world, ahead of the hero's controller. Tap the tool again to stop.
  - 👹 + a kind: spawn a raider, brute, runner (hostile), an ally (follows you and fights) or a villager, through
    the Units contract.
  - 🪣 + a fill: tap inside an enclosed vessel. It fills to just under its rim with water, oil, sand, soil, snow or
    rubble.
  - 📍: where the hero starts on this map, kept in the map's `poi.heroStart`.
  - 🏁: a generated obstacle course, laid from the hero along the view, with the hero put at its start.
  - 🧹: remove the units.
- **An edited map**: make it in the editor, set 📍, then use **save**. Later, load it from the editor's list and press
  🧍. The hero starts at 📍.
- `?hero=<role>` drops you in at the start. `?heroes=<url>[,<url>…]` loads hero modules. The panel's URL field and
  **load** button load one at runtime.
- Scripts: `window.reclaimed.heroSandbox` (`enter()`, `exit()`, `choose(role)`, `spawn(kind, at)`,
  `fill(at, what)`, `gauntlet()`, `loadModule(url)`, `log`, `lastFill`).

### The registry (src/hero/registry.ts)

Heroes register by role through one function, `registerHero(entry, source)`, where the entry is
`HeroEntry { role, name, icon?, makeHero(world, at), makeController?(hero), units? }`. The Walker is registered
built-in as `wanderer`. When a role is already taken by another source, registering it is an error: one game's hero
never silently shadows another's.

### Heroes from another build: hero modules (contract 1.1)

A hero module is an ES module, served by its own build (another origin is fine with CORS). It exports two things:

```js
export const heroContract = '1.1';            // the HERO_CONTRACT it was built against
export function mount(host) {                 // host: HeroHost (contracts/hero.ts)
  return { heroes: [{ role: 'hoverbike knight', name: 'Hoverbike knight', makeHero: (world, at) => …, makeController: (hero) => … }] };
}
```

- **The version.** `HERO_CONTRACT` is "major.minor" (contracts/hero.ts). A module loads when its major equals the
  host's and its minor is no newer. Otherwise the load is refused and the panel and the console show both versions:
  "it was built against hero contract 2.0, this host is 1.1 (a different major: signatures changed)". There is no
  fallback. Additive changes bump the minor, and a changed signature bumps the major.
- **No Reclaimed code is copied.** The module imports Reclaimed as bare specifiers, `reclaimed/<path>`. For example,
  `import { Figures } from 'reclaimed/units/figures'` or `import { MAT } from 'reclaimed/world/materials'`. The page's
  import map (vite.config.ts `heroShared`) resolves each one to the host's own module, so classes and constants are
  the host's by identity. On the dev server the map points at `/src/<path>.ts`. In the build, each shared module is
  an entry chunk of its own, which the app imports too. The modules a hero module may import are listed in
  `src/hero/shared-modules.json`. Adding one is additive, and removing one is a major change. In a hero game's own
  build, mark `reclaimed/*` as external (Vite library mode, `rollupOptions.external: [/^reclaimed\//]`) and alias
  its `vendor/reclaimed/src/<path>` imports to `reclaimed/<path>`.
- **What `mount` gets (HeroHost):**
  - `world` (HeroWorld: ground, units, water, plus `solidAt` and `floorUnder` in 1.1) and `ui`.
  - `project(x, y, z)` and `groundAt(sx, sy)` for picking taps.
  - `zMax`, `wake(x, y, r)` and `log(line)`, which writes into the boundary log.
  - `raw`: `sim`, `core`, `camera`, `renderer`, `device`. These are **debt**: handles that have no API yet. Each is
    to become an API (below).
- The test module `scripts/test-hero/hero.mjs` (served by `node scripts/heroserve.mjs 5208`) is the smallest example.
  Its hero, the roller, imports Figures, MAT and TouchPad through the map, draws itself, has a real dash cooldown and
  five tunables, and logs through `host.log`. `scripts/test-hero/hero-old.mjs` declares 0.9 and is refused.

### What 1.1 added (additive)

| | what | why |
|---|---|---|
| `HeroIntent.input?: unknown` | a controller's own input passed to its own hero untouched | the hoverbike heroes read a rich per-frame Input (stick, gestures, drags, world taps); the inspector shows its keys |
| `Hero.tunables?: Record<string, HeroTunable>` | `{ label, units?, min, max, step, get(), set(v), help? }` | the sandbox's live sliders; the sandbox converts them to a tuning registry at the boundary (hero/tunables.ts) |
| `Hero.ownCamera?: boolean` | the hero drives the camera; the host neither follows nor zooms | the hoverbike's chase camera (`HeroRunDeps.ownCamera` was the run's flag; this is the hero's) |
| `Hero.dispose?()` | what it draws and holds let go when the sandbox takes it out | a hero that draws itself (Figures, meshes) |
| `HeroAbility.duration?: number` | its full cooldown (s) | the inspector's bar; cooldowns should be real (`cooldown()` 0 always hides them) |
| `Hero.mobility?: Mobility` | how it gets over the ground (contracts/traversal.ts) | traversal fields for it: the autopilot, the course check (GE3) |
| `HeroWorld.solidAt?`, `floorUnder?` | a point in the ground; the floor under feet reaching z | caves, overhangs, rays (GameplayGM's World has them) |
| `HeroEntry`, `HeroHost`, `HeroMount`, `HeroModule`, `HERO_CONTRACT` | the registry and runtime modules | this section |

### The boundary log (src/hero/trace.ts)

The log records each call that crosses the contract:

- **host→hero**: makeHero, makeController, place, shift (window slides), claims (with its answer), onAction,
  units.spawn and dispose.
- **hero→host**: `hurt` and `died`, the hero's calls on its units (`units.hit`, `order`, `setHostile`, `remove` …)
  and `host.log`. Reads (query, get, all) are counted per second, not listed.
- **units→hero**: `actor.hurt`.

The HeroIntent is kept for the last 10 s.

### Contract feedback

The user: "Or at least provide feedback". The 💬 button reuses the bug report (src/ui/bugreport.ts, its `as` option).
It takes a picture, asks for a note and saves one JSON (the picture inside as a data URL) plus the PNG.

- **Where it goes:** on the dev server, to `feedback/hero/<YYYY-MM-DD-HH-MM-SS>-<role>.json` in the checkout
  (vite.config.ts, `/__hitch?kind=herofeedback`). It is also downloaded, or sent through the share sheet on a phone.
  On Pages, only the download happens. **Main commits `feedback/hero/` and forwards the files to the GameplayGM
  session.** Both sessions read the same files.
- **What it holds:**

```
{ kind: 'reclaimed-hero-feedback', version: 1, at, page, level, device, world, camera, time, tune, state,
  note, shot: 'data:image/png;base64,…',
  hero: { role, source: 'built-in' | <module url>, contract: '1.1', modules: [urls], in, state: { position, heading,
          speed, health, maxHealth, alive, camera, ownCamera, goesTo, claims, abilities: [{ id, name, cooldown, duration }] } },
  boundary: { seconds: 60, calls: [{ t, dir, call, args }], reads: { query: n, … } },
  intents: [{ t, move, goTo, attack, sprint, use, talk, input: [keys] | null }],      // the last 10 s
  tunables: { all: { 'camera.zoom': 14, 'hero.speed': 8, … }, changed: {…}, string: '<?herotune= string>' },
  sandbox: { units: [...], lastFill, course } }
```

### What the contract lacks for GameplayGM's heroes (from gampeplaygm-40, round 112), and the proposal

The hoverbike game (GameplayGM `experiment/slice`: slice/hero.ts HoverHero, slice/units.ts FoeUnits) told us:

1. **HeroWorld is too thin.** Their heroes need `solidAt` and `floorUnder` (caves, rays), the physics bodies (wake,
   hold, throw), fx, wind, the wake for streamed worlds and the agents (grab, levitate, hook).
   Proposal: 1.1 adds `solidAt` and `floorUnder` to HeroWorld and `wake` to HeroHost. The rest comes as `raw`
   handles for now and is listed as debt, each to become a named API in a later 1.x: `host.bodies` (wake, hold,
   throw over physics/physics), `host.fx` and `host.wind` (the world API's, typed), `host.agents.grab` / `levitate`.
2. **Input.** Their units read a rich per-frame Input, so a generic TouchPad leaves them inert. 1.1 adds
   `HeroIntent.input` (passed through untouched). Their own controller comes with their HeroEntry (`makeController`),
   and the sandbox uses it in place of the TouchPad.
3. **claims() always true, goesTo false, talk only through their context button.** That works in the sandbox. The
   sandbox's tools take their taps ahead of the controller, so 👹 and 🪣 still work with a hero that claims every tap.
   Suggestion to them: return `claims` true only for the taps their mechanics take, so a tap on the ground can still
   reach the host.
4. **They drive their own chase camera.** 1.1 adds `Hero.ownCamera`; the sandbox then neither follows nor zooms.
5. **Hits go as Hit[] to their Foes, not through Units/Actor,** and `Actor.hurt` maps to an approximate radius-3
   Hit. Proposal: their hits go through `Units.hit` on whatever Units the host gives them. In their own build their
   FoeUnits is that Units, so nothing changes for them. In the sandbox it means our spawned units take their blows.
   Additive for a later 1.x: `Units.hitArea?(at, radius, damage, by, push?)` for area blows.
6. **place() keeps health across a warp, and shift() follows slides.** Both match the contract; nothing to change.
7. **HeroAbility.cooldown() is always 0; the real cooldowns live in the units.** Proposal: return the unit's real
   cooldown and set `duration` (1.1). The inspector shows it as a bar.
8. **The runtime seam.** They proposed `mount(host) → { makeHero, makeController, units }` over raw handles. 1.1 is
   that seam: `mount(host) → { heroes: HeroEntry[] }` with an explicit, versioned HeroHost. The named capabilities
   come first, and the raw handles remain as listed debt. Their ~30 vendored modules resolve through the shared-modules
   import map; anything they import that isn't listed in `src/hero/shared-modules.json` is to be added there
   (additive).

### Traversal fields and the autopilot (round 112)

The user: "Don't we have pathfinding? Can't we build a traversal field for the hero agent and use that instead of
input? Or steer along that?"

- **The contract** is `src/api/contracts/traversal.ts`: `Traversal.field(goal, mobility, { radius })` returns a
  `TraversalField` with `cost(at)`, `reachable(at)`, `dir(at)` (a unit vector down the field), `route(at)` and `ms`.
  `Mobility` is the body's own way over the ground. It is not the agents' fixed numbers. It holds `step` (the
  highest climb a stride takes), `drop`, `deep` (the water it won't wade into), `jump` (with `jumpCost`),
  `climbCost`, `wadeCost` and `hugCost` (the extra cost of a cell at a wall's foot: a body has width).
- **A hero states its mobility** as `Hero.mobility` (1.1). The Walker's comes from its tunables: `step`, a drop of
  the same, and `deep`. Tuning the hero changes the field.
- **Implementation.** `src/hero/traversal.ts` `CpuTraversal` runs a Dijkstra from the goal over the window's hex
  cells, using the world API's heights and water. Within 40 cells it takes about 1 ms in Node; within 96 cells,
  20-26 ms. The GPU agents' distance and flow fields (agents.wgsl `navCost`) are the next implementation behind the
  same contract (HS10): many surfaces a column, caves and bridges.
- **The pilot.** `src/hero/pilot.ts` `Pilot` is a HeroController that steers along a field: `move` is `dir(position)`
  until the hero is there. It follows a moving goal by making the field again every second. With `fight` set, it
  swings at hostiles within reach. A hero that makes no progress for 3 s is marked `stuck` (its own rules refused a
  stride the field allowed). It drives any hero through the contract: `position()`, `mobility` and `intent()`.
- **In the sandbox**, 🧭 is "autopilot to here": a tap sends the hero there, and pushing the stick takes control
  back. Scripts call `hs.pilotTo(point | () => point)` and `hs.pilotToUnit(id)`. The inspector shows the pilot's
  state, its cost and the field's time.
- **Courses.** `hero/gauntlet.ts` `crossable(traversal, course, mobility)` checks the hero's field from the course's
  goal at its start. The sandbox runs it for each course it lays and logs whether the hero can cross. **This is the
  basis for checking that a generated gauntlet is traversable by a given hero (GE3):** a generator keeps only the
  courses each of its heroes can cross.
- **The headless test** drives the hero with the pilot rather than a scripted stick. It walks to a point, goes at a
  raider and fights it, and crosses the course to its crystal.
- **Contract gap (GameplayGM).** Their heroes ignore `move` and `goTo` and read their own `input`, so a pilot can't
  drive them yet. A pilot for them needs the input passthrough the other way round: their controller (or their
  hero) has to take a steering direction. That means a documented field in their Input, or a `HeroIntent.move`
  their hero honours when no gesture is in progress. They also need `Hero.mobility`. Both are on their checklist.

### What GameplayGM must provide (checklist)

- [ ] A build of their heroes as one ES module, using Vite library mode, format `es`, with `reclaimed/*` external.
      Their `vendor/reclaimed/src/<path>` imports must be rewritten to `reclaimed/<path>`, for example with a resolve
      alias plugin. No Reclaimed code may be in the bundle.
- [ ] `export const heroContract = '1.1'`.
- [ ] `export function mount(host)` returning
      `{ heroes: [{ role, name, icon?, makeHero(world, at), makeController(hero), units? }], dispose? }`, one entry
      per hero: the bike, the knight with its hook, the lich, the tank, the mech and the gorilla. Their World is built
      from `host` (`host.world`, `host.raw.*`, `host.wake`, `host.project`, `host.groundAt`, `host.zMax`).
- [ ] `makeController(hero)` returns their Controls as a RunController, mounted in `host.ui`, emitting
      `HeroIntent.input`.
- [ ] Each hero has real cooldowns: `cooldown()` returns the unit's value, and `duration` is set.
- [ ] Each hero has its numbers as `tunables` (their bike / air tuning, ability numbers), each with `get` and `set`.
- [ ] `ownCamera: true` if they keep their chase camera; otherwise Hero.camera is used.
- [ ] Hits on the host's units go through `world.units.hit` (and `Units.query` to find them).
- [ ] `dispose()` lets go of what the hero draws and holds.
- [ ] Each hero states its `mobility` (`step`, `drop`, `deep`, `jump`) for traversal fields.
- [ ] Each hero can be steered by a pilot: it honours `HeroIntent.move` when no gesture of its own is in progress, or its Input takes a steering direction. Without this, the 🧭 autopilot, the headless tests and the course checks can't drive it.
- [ ] They serve the module from their dev server with CORS, then try
      `https://csheldondante.github.io/Reclaimed/herosandbox/?skipmenu=1&level=playground&heroes=<their url>&hero=<role>`
      (or the dev server's equivalent).
- [ ] They send a list of the Reclaimed modules they import at runtime that are missing from
      `src/hero/shared-modules.json`.
