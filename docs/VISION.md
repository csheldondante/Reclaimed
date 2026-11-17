# VISION — what the game is for (written 2026-11-17 from the owner's statements of 2026-11-15 and 2026-11-16)

This page is the short statement of intent. It quotes the owner; where it paraphrases, it says so. It does not replace
`.claude/docs/design/DESIGN.md` (how the systems are designed), `docs/SYSTEMS.md` (what is built, read from the code) or
`docs/DECISIONS.md` (the owner's rulings, in order). When this page and a ruling disagree, the ruling wins and this page
is corrected.

## 1. The loop

Leader → city → characters petition → allocate → built and alive → prepare → play live events → the world mutates and
persists → the next run starts in the changed world, from a new perspective.

Design: `docs/design/LOOP_SKELETON.md`, `SEASON_LOOP.md`, `RUN_LOOP.md`. Built: SYSTEMS §4.

## 2. Cards make the world; the engine shows it

> "A really important goal here is that the world builds general systems for showing and later playing in the world
> generated and mutated by the cards."

- **The card is the only thing that changes the world during a run.** "I would not have factions act outside of cards
  as it controls the pacing and keeps one gamified mutator." There is no separate raid mechanism: "it should be a card".
  Between runs is one more lever for balance.
- **Pack cards are templates.** "The dealer can always generate cards from parameterized templates to fit the actual
  world."
- **The world remembers through the record of resolved cards**, not a separate history system: "Cards can already play
  into the world as buildings or events like an armory or a parade or a battle. Just keep the history of resolved
  cards."
- **The outside world is big.** "Make the outside world feel big and shaped by decisions not just the player city. The
  city just shows it diagetically to the player." Effects may reach any place on the map: darkness, towns added or
  deleted, trade routes, far mining colonies, vassals, pirates and deals with them.

Design: `docs/design/PACK_FORMAT.md`, `LAWS.md`, `CARD_TABLE.md`, `OPPORTUNITY_CATALOG.md`, `FACTIONS_WORLD_STATE.md`.
Built: SYSTEMS §3, §3b, §3c, §13.

## 3. Engines may break the game

> "I think we want loops and fun engines I wouldn't limit that. I would make it so the infinite loops are tied to user
> actions so they don't run infinitely on their own. But crazy multipliers and triggers are fun"

> "Since it is a roguelite with runs that end we can break things. Look at games like innovation and allow mechanics
> that mutate mechanics in potentially major world changing ways."

- No caps or budgets for balance. Loops are paced by player actions and seasons. Limits exist only to catch bugs.
- Instant wins and losses are allowed. World-wide outcomes persist: "A faction winning and essentially making the whole
  world undead doesn't really break future play sessions if you are an undead leader in the new world order."
- Leaders can start in far cities. Meeting and exploring unlocks content for later runs.

## 4. What it should feel like

> "I want to see all the mutated places and diagetic representations of my choices. […] When my decisions turn the war
> torn plains into a peaceful kingdom with scheming wizards or when those wizards destroy the planet with volcanos that
> cover the world in ash and flame and the next run is as an ash tribe rebuilding civilization or when the Ash hordes
> encounter a fallen ship they deem an angel and the visitors from it establish a new strange city at the crash site
> around their ship etc. I want the world to change in crazy dramatic interesting ways that both build on each other
> and completely shatter the world."

> "The whole point is to make the world feel like it remembers everything the player has ever chosen or done and like
> it all matters."

## 5. Three ways anything a card does is shown

Every card effect gets one of these from existing systems. Nothing a card does is invisible; a plain marker is the
floor. The table that maps each effect word to its showing is SYSTEMS §3c.

| Showing | For | The owner | Systems (SYSTEMS section) |
|---|---|---|---|
| **Instant change** | Things that happened elsewhere or between seasons | "instant mutators […] since a lot of opportunities will happen in other area of the world" | Mutators and signs (§5), map marks (§9) |
| **Time-lapse** | Slow things | "I want to use the seasons and time lapse to show things that would be too slow to be interesting to watch." | Time-lapse and season turn (§4), towns growing (§2) |
| **Live event in the season view** | Things the player answers | "the fun toy like interaction where you can play with physics and agent behavior and the effects system and have fun juicy interaction" | Live events (§3b), units and orders (§1), spells (§7), effects (§10), weather, water, fire, lava (§6) |

The owner's examples of the toy: "Watch your invisibility spell make your units vanish. Watch the shield you raise
divert a pyroclastic flow around your city and preserve it for the ashen world. Beserk the protesters to make them
destroy each other instead of dethroning your rule."

## 6. What each engine system was built for (the owner's intent, condensed)

| System | Built for | State |
|---|---|---|
| Interval-based ground | Underground strongholds as refuge from a hostile surface; digging for artifacts and ruins; caverns, underground lakes and rivers | Engine built; no card uses it |
| Physics | Cliffs crumbling into the sea and taking districts with them; toppling buildings | Parked on `physics10-one`; old physics is the default |
| 3D tile construction | Superstructures and wonders that later crumble or transform and are lived in by descendants | Not in the loop |
| Units as compositions | Variety from permutations of parts, "with the intent that the dealer steer it toward thematic interesting visually distinct units"; a knight on a hoverbike is a pike unit with a mount found in the ruins | Designed (DECISIONS round 85); cards use authored examples for now |
| Flow fields, formations, authored paths | Crowds that stay visible and legible | Wired into the loop in rounds 8 and 9 |
| Flora; cliffside dwellings | Overgrowth; building along or into stone | Not finished |

## 7. Look and sound

- **City legibility.** "We need streets that are integrated with the world and terrain not floating meshes and we want
  them legible and wide enough for crowds to show with plazas and decorations. I would love to hit the visual quality
  of anno 1800 or tiny glade but I would settle for planet coaster as long as it is legible." Detail loads with zoom;
  generated assets are cached and instanced.
- **Buildings and units.** Procedural generators are the first choice; asset packs are an accepted fallback (never in
  the public repo). Either must break, burn and overgrow through the existing systems. Units fall back to composable
  rigged parts.
- **Close-up identity** comes from generated portraits of characters and places, and from "a lot of sound design and
  ambient sounds".
- Effects are considered good already.

Design: `docs/design/CITYGEN.md`, `ARCHGEN.md`; DESIGN.md roads and buildings sections.

## 8. The MVP, and where it stands (2026-11-17)

The owner's instruction: "target the MVP for making this possible as cheaply and easily as possible", using the systems
already built.

| Piece | State |
|---|---|
| The loop playable end to end in 3D on the phone | Works (16-season walks) |
| Packs, laws, rules, endings, the record | Works at the card table and in 3D |
| Raid as a card, far-city starts, unlocks, between runs | Works at the card table and in 3D (loop round 10: the 16-season walk; a far home opens the game on that town; locked leaders show their hint) |
| Units on wide streets, coloured by side | Works; (loop round 11) the arterials, the square and the main streets are graded into the ground as light, calm paving; minor lanes are still drawn strips. Roads 0 and 1 into Muru still bring nobody: their second bridge is not built, and units placed on a deck do not walk in (LS-99) |
| Toy spells on agents (berserk, invisible) | Built on the GPU (loop round 10); (loop round 11) seen at phone size: a pack bout's camera follows the fight close (both sides in frame), berserk units glow in a red mist, your hidden people are drawn faint with glints (foes' stay unseen), a ring of sparks marks the spell's reach. A worker crowd has no blow yet (LS-108) |
| A hazard front that advances on a town, and a shield that diverts it | Not started |
| Weather as packaged presets | Not started |
| The next run shown in the changed world in 3D | Started: "The world now" at each run's start (how runs ended, a move of home, what changed while nobody played, what is still to find), remains of things, the land's changes laid again; a town's buildings kept on it (`built:<card>`) |
| Building and unit art | Generator behind `?arch=1`, not default; no unit art trial yet |
| Ambient sound from game state; portraits | Not started (portrait slot exists) |
| Authored content | Four packs being written outside this repo against `PACK_FORMAT.md` |
