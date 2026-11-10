# SEASON_LOOP — opportunity-based city building, a season at a time

The playable test of the city loop on a field town (`?skipmenu=1&level=atlas&town=1&fresh=1&citygen=fields&opps=1`).
Authority: DECISIONS 2026-11-10 "season loop" (the user's three answers), round 128r (seasons, pools, stages),
CITYGEN.md (districts, the per-lot progress buffer), the draft DESIGN §18/§21 (`docs/handoff/DESIGN_18_21_DRAFT.md`).

## The user's rules

- The sim runs in real time while the player picks cards. Nothing waits on a timer.
- **Next season** is a button. Every project in progress advances one season, all at once.
- A building takes 1–4 seasons and shows each in-between step (the shader for now).
- Six pools: Magic, Might, Labor, Resources, Intel, Unrest. The card lab's labor/influence/power set is not used here.
- The player picks cards; the town places and builds them. No painting.
- No raids in this test.

## Data flow

```
catalog (data) ──proposals──▶ dealer.deal (opps/dealer.ts, the one dealer) ──▶ the hand (N cards, a reason each)
      ▲                                                                         │ Start / Undo (within the pools)
      │ what's built, unrest, districts left                                    ▼
 ledger (season/ledger.ts, pure) ◀──────────── commit / uncommit ───────── the season's picks
      │ Next season: nextSeason(ledger) → new ledger + ordered changes {project, from, to, at}
      ▼
 SeasonLoop (season/loop.ts) ── a new project: CityDistricts.claimDistrict(kind) (GPU argmax, 4 words back)
      │                       └ every change: CityDistricts.stageDistrict(id, from, to) at its `at` (16 B up)
      ▼
 SimTiers.showcase (sim/tiers.ts): the changes over a few seconds, the camera on each; Skip lands the end at once
      ▼
 citygen (GPU): district stage table → each lot's progress → buildings risen, scaffold tint → claims follow
```

- The **dealer** gets one proposal a catalog card: no agents, its cost in pools, `sense` filters (what it needs built,
  a district left, not already building), and score parts (urgency from unrest, unlocks, neglect). The holdings it sees
  are the pools as goods, with Labor less Unrest. It deals at most `HAND` affordable cards and one it can't afford yet.
- The **ledger** is the season's truth: pools, base income, projects (card, season played, seasons worked), what is
  built. `commit` pays the cost; `uncommit` refunds it before the season ends. `nextSeason` adds income (Labor less
  Unrest), works every project one season, and on a project's last season adds its income and lowers or raises Unrest.
  Pure, the same input giving the same output.

## The catalog (`season/catalog.ts`)

| Card | Cost | Seasons | Effect | When done, each season |
|---|---|---|---|---|
| Build houses | 2 Labor, 1 Resources | 2 | housing district | +1 Labor |
| Clear land for farms | 1 Labor, 1 Resources | 1 | farms district | +1 Labor, −1 Unrest once |
| Open a market | 2 Labor, 2 Resources | 2 | market district (needs houses) | +1 Resources, +1 Intel |
| Build workshops | 2 Labor, 3 Resources | 3 | workshops district (needs houses) | +2 Resources |
| Build a harbour | 3 Labor, 2 Resources, 1 Intel | 3 | harbour district (needs a market) | +2 Resources, +1 Intel |
| Raise the keep | 3 Labor, 3 Resources, 1 Magic | 4 | keep district (needs workshops) | +2 Might, −1 Unrest once |
| Open a quarry | 2 Labor | 1 | stub until trackA-haul merges | +1 Resources |
| Start a lumber camp | 1 Labor | 1 | stub until trackA-haul merges | +1 Resources |
| Bridge the river | 2 Labor, 2 Resources | 2 | stub (citygen already bridges its arterials) | +1 Intel |
| Build town walls | 3 Labor, 3 Resources | 3 | stub, +1 Unrest when started | +2 Might |

Start: Magic 1, Might 1, Labor 4, Resources 3, Intel 1, Unrest 0; income Labor +3, Resources +2, Magic +1.

## Stages, seasons and progress

- A project of `n` seasons has stage `worked / n` (0 … 1). Each Next season moves it from `k/n` to `(k+1)/n`.
- citygen keeps a **stage table** (a vec4 per district: on, from, to, when) beside the district clocks. `tlProgress`
  reads it: a staged district's build time is `s × 1.75 × BUILD_S`, where `s` eases from `from` to `to` over
  `1.75 × BUILD_S` of the town's clock from `when`. Each lot keeps its own delay (up to ¾ of the build), so at 1/3 some
  lots are part risen and later ones not begun; at 1 every lot is up. Without a stage the district runs on wall time.
- Skip writes every changed district with `when` far in the past: the end at once, the same progress as played.
- **The look ("the shader for now"):** `tlRise` tints a rising building's top vertices plank brown and its roof a
  scaffold colour while its progress is under 1, restoring the roof colour at 1. The walls read stone at the foot and
  plank at the top. The full construction shader reads the same progress buffer (contract unchanged).

## UI (phone first, `season/ui.ts`, words in `season/words.ts`)

- Top: the pools as six chips (`Labor 4 +3`), the season number.
- Bottom sheet: the hand as cards (title, a reason line, cost, seasons, what it gives) with **Start**; started cards
  show **Undo**. A strip of what's building: name and seasons left. **Next season** (and **Skip** while it plays).
- A one-line summary of the last season. Plain words (docs/WRITING.md); no "commit", "stage" or "tier" on screen.

## CPU and GPU

- **CPU (bookkeeping only):** the catalog, the dealer, the ledger, the hand, the UI, the showcase's timing. Inputs
  to the GPU: which purpose to claim (a word), a district's stage (16 bytes), the town's clock.
- **GPU:** which district a card gets (argmax), each lot's progress, the buildings risen and tinted, roads shown,
  claims. Read back: the claim's 4 words (id, centre, districts left) once per new project — an event, never a frame.
