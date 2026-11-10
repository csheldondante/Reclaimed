# SEASON_LOOP — opportunity-based city building, a season at a time

The playable test of the city loop on a field town (`?skipmenu=1&level=atlas&town=1&fresh=1&citygen=fields&opps=1`).
Authority: DECISIONS 2026-11-10 "season loop" (the user's answers), round 128r (seasons, pools, stages), CITYGEN.md
(districts, the per-lot progress buffer), the opportunity contract (`src/api/contracts/opportunity.ts`, RUN_LOOP.md,
STRATEGIC_MAP.md), the draft DESIGN §18/§21 (`docs/handoff/DESIGN_18_21_DRAFT.md`).

**The card model in one sentence:** starting a card ties up its people (Labor, Might) and spends its goods (Materials,
Magic, Intel) at once, nothing more is paid while it runs its N seasons, its district part shows a stage each season,
and when it finishes its people come back and its building is whole — the opportunity contract's `commit` and
`resolve` ("Opportunities can take resources for a duration").

## The user's rules

- The sim runs in real time while the player picks cards. Nothing waits on a timer.
- **Next season** is a button. Every card in progress advances one season, all at once.
- A building takes 1–4 seasons and shows each in-between step (the shader for now).
- Six pools: Magic, Might, Labor, Materials (the decision's "Resources", shown as Materials), Intel, Unrest. The card
  lab's labor/influence/power set is not used here.
- The player picks cards; the town places and builds them. No painting. No raids in this test.
- Partial claims: a card's district covers part of a district (a share of its lots), so the town lasts.

## Data flow

```
catalog (data) ──proposals──▶ dealer.deal (opps/dealer.ts, the one dealer) ──▶ the hand (N cards, a reason each)
      ▲                         (over the ledger's own holdings)                │ Start / Undo
      │ what's built, unrest, land                                              ▼
 ledger (season/ledger.ts, pure) ◀── contract commit (people locked, goods spent) / undo ── the season's picks
      │ Next season: nextSeason → contract resolve for cards at their end (people back) + ordered stage changes
      ▼
 SeasonLoop (season/loop.ts) ── a new district card: its land (allocate) — a share of an open district of its kind,
      │                         or a new district: CityDistricts.claimDistrict(kind) (GPU argmax, 4 words back)
      │                       └ every card's change: CityDistricts.stageDistrict(id, {slot, a, b, from, to, end})
      ▼
 SimTiers.showcase (sim/tiers.ts): the changes over a few seconds, the camera on each; Skip lands the end at once
      ▼
 citygen (GPU): lots ranked in growth order a district → each lot's progress from its card's share → risen, tinted
```

- **Pools and the contract.** Labor and Might are people: one agent a unit (`workers`, `army`), required by a card
  and locked (`Agent.committed`) until it resolves. Materials, Magic and Intel are goods, spent at commit. Unrest is
  the town's state: that many free workers are on strike (not with you, so not available — the contract's own rule).
  The mapping is a table (`POOL_ROLE`); each card's `locks` and `costs` are data.
- **The dealer** gets one proposal a catalog card: its people as requirements, its goods as costs, `sense` filters
  (what it needs built, land for it, a one-off not started) and score parts. It deals at most `HAND` cards that can
  be started and one that can't yet.
- **The ledger** is the season's truth: holdings, goods income, cards in progress (their commitments), what is built.
  Pure, the same input giving the same output.

## Land: districts in shares

- A district is 6 parts. A card covers some (houses 2, farms 2, market 3, workshops 3, harbour 3, keep 6).
- `allocate` (season/deal.ts) is the one rule the loop builds by and the dealer offers by: a card goes on in an open
  district of its kind that has the room and a free slot (two cards build in one district at once); else a new
  district is claimed on the GPU.
- The GPU ranks each district's lots by distance from its centre (`stgRank`, a mesh run: n² over a few hundred lots);
  a lot's key is its rank over the district's count, so a share [a, b] is that share of the lots, centre outward.

## Stages, seasons and progress

- A card of `n` seasons in share [a, b] has stage `a + (b − a) × worked / n`. Each Next season moves it one step.
- citygen keeps a **stage table**: 16 f32 a district — on, end (the parts given out so far), and two slots of a, b,
  from, to, when. `tlProgress` gives a lot in a slot's share the progress `f × 1.5 − 0.5 × w` (f how far the stage is
  through the share, eased over the build span; w the lot's place in the share), so its lots rise together, a little
  staggered, and are all up exactly when the card finishes. Other lots stand before `end` and aren't begun after it.
- Skip writes every changed slot with `when` far in the past: the end at once, the same progress as played.
- **The look ("the shader for now"):** `tlRise` tints a rising building's tops plank, its roof a scaffold deck and its
  foot dark stone while its progress is under 1, and puts its colours back at 1. The full construction shader reads
  the same progress buffer (contract unchanged).

## UI (phone first, `season/ui.ts`, words in `season/words.ts`)

- Top: the pools as chips — people free of all (`Labor 2/4`), goods and what each season brings (`Materials 4 +2`).
- Bottom sheet: the hand as a two-column grid (title, a reason line, "Takes 2 Labor for 2 seasons. Uses 2
  Materials.", what it gives, what's missing in its own line), **Start** / **Undo**. What's building: name, seasons
  left, "2 Labor back in season 3." **Next season** (and **Skip** while it plays). A summary of the last season.
- Plain words (docs/WRITING.md); no "commit", "stage" or "tier" on screen.

## CPU and GPU

- **CPU (bookkeeping only):** the catalog, the dealer, the ledger, the hand, land shares, the UI, the showcase's
  timing. Inputs to the GPU: which purpose to claim (a word), a card's stage (28 bytes), the town's clock.
- **GPU:** which district a new card gets (argmax), each district's lot order, each lot's progress, the buildings
  risen and tinted, roads shown, claims. Read back: the claim's 4 words once per new district — an event.
