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
  update(dt: number, intent: HeroIntent): void;   // { move: [x, y] world direction 0..1, goTo?, attack?, use?: string[] }
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
