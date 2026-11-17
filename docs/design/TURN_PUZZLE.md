# The turn as a puzzle: order and assignment, step 1 (card table, 2026-11-17)

For the owner to mark up. Each section is short; open questions are at the end, numbered.

The owner: "Abilities you can activate that make instant changes to strategic resources so optimal play is order
dependent and involves thinking through which choices and what order." "No not every action should resolve but
resources should commit and some should resolve." "I wouldn't make them undoable." Measured before this step: a season
offered 3.9 cards, 2.5 affordable together, 7 affordable sets (median), everything affordable in 20% of seasons, 92%
of cards affordable singly.

## 1. Two kinds of action

| | INSTANT | COMMITTED |
|---|---|---|
| What | Use something on the board ("Sell stone at the market"); post or recall a piece | Take a card: a project ("Sink a mine shaft"), an answer to a need ("Lay in winter stores") |
| When it resolves | At once. Pools change now; the next action sees the new pools | Pools and pieces are taken at once and shown tied up; the project resolves after its seasons (1–4) |
| Pieces | Posting puts a piece on a thing until you recall it | Crews and soldiers on a project come back when it is done |
| Undo | None | None |

A season is one open-ended turn: any number of actions, in any order, then "End the season". What bounds it is what
you hold, how often each use may be made (most: once a season) and how often a piece may move (once a season).

**Preview before a commit** (every card): pools before → after, which crews/soldiers are tied up, the season they come
back, what it gives and when. Example: "Materials 7 → 4. Crews free 4 → 2: 2 crews tied up until season 5. Gives: the
mine (from season 5)".

## 2. Pieces and where they stand

- **Crews** are Labor, **soldiers** are Might: countable pieces, one each, with a place: free, on a project, posted on
  a thing, or on strike (each Unrest point keeps one free crew away, as now).
- **Slots**: a thing in play may have room for pieces: "the mine: 3 crews". What a posted piece does is the thing's:
  a crew on the mine gives +1 Materials each season; a soldier on the watchtower gives +1 Intel each season and, near
  the raiders' road, puts 3 raiders down when they come; a soldier on the wall fights at the wall.
- **Moving**: posting a free piece, or recalling a posted one (it is free at once), is an instant action. Each piece
  moves at most once a season (so recall-and-repost cannot be looped). A posted piece is not free: it cannot go to a
  project until recalled. Posted soldiers still fight a raid at home.
- **Named people as pieces**: not in step 1 (question 4).
- **Old data**: a card's `labor: n` locks n crews, `might: n` locks n soldiers; `pool labor add n` is n new crews,
  `add -n` takes n away (free ones first). Nothing written in draft 9 changes meaning.

## 3. Uses: abilities on things in play

Data on a thing (draft 10, `uses`): a cost, what it gives, how often a season, and optionally "for each crew (or
soldier) posted here". Instant. Examples (base game):

| Thing | Use (once a season unless said) | Slots |
|---|---|---|
| Mine | Dig deep: 1 Magic → +1 Materials for each crew here | 3 crews: +1 Materials each a season |
| Market stalls | Sell stone: 2 Materials → +2 Intel (twice); Buy stone: 2 Intel → +3 Materials | 1 crew: +1 Intel a season |
| Shrine | Pray: 1 Materials → +1 Magic; Calm the town: 2 Magic → Unrest −1 | 1 crew: +1 Magic a season |
| Foundry | Arm a recruit: 2 Materials + 1 Magic → +1 soldier | 2 crews: +1 Materials each a season |
| Muster ground | Call the levy: Unrest +1 → +1 soldier; Stand down: −1 soldier → +1 crew | — |
| Granary | Open the granary: 2 Materials → Unrest −1 | 1 crew: +1 Materials a season |
| Watchtower | — | 1 soldier: +1 Intel a season; 3 raiders down if the raid passes it |
| Wall works | Shore up: 2 Materials → the wall holds 2 more raiders this season | 3 soldiers: each puts 1 raider down |

Order matters because uses read the board as it stands: post two crews on the mine before "Dig deep" and it gives +2,
after it +0; sell stone before you take a card and you cannot afford it; call the levy and a crew goes on strike
before you can send it to a project. A use is recorded as a fact event (`used:<id>`), so the existing rules can
trigger on it ("the first time you use the shrine this season…" is a rule with `perSeason: 1`).

## 4. Known needs with deadlines and numbers

Needs are threat cards with a stated demand and a countdown (cards stay the only thing that changes the world). Two
may stand at once (was one), beside the raiders' standing threat:
- "Lay in winter stores" (every few seasons): 4 Materials and 1 crew for a season, within 2 seasons, or Unrest +2.
- "Mend the old dam": 2 crews, 2 Materials for a season, within 3 seasons, or the mill street floods.
- The raiders (existing): the header states the requirement: "Season 16: 18 raiders. You would meet them with 9."

## 5. More opportunities, fewer of them affordable

By data: the works add 8 cards (things to build, crews sent out for a later return, pieces converted) and two
needs; the board takes 5 opportunities (was 3) while the works are on. Target: about 6 asked, about half affordable
together, "everything affordable" under 5% of seasons.

## 6. What exists and what is new

| Piece | Exists | New |
|---|---|---|
| Crews/soldiers | Agents in the ledger's holdings (one per Labor/Might), locked by a card's commitment | Posting: an agent held by a standing commitment `post:<thing>`; `Realm.pieces/post/recall`; once-a-season moves |
| Slots | Thing upkeep as a generated rule | `slots` on a thing → a generated rule per kind; rules may count pieces (`per: {"posted": "crew"}`); things posted on carry `crewed` / `manned` |
| Uses | Pack abilities (Magic cost, tag or pool effect) | `uses` on a thing: any goods cost, gives, `times`, `per`; `Realm.uses/use`; event `used:<id>` |
| Committed | `Realm.commit` (people locked, goods spent, resolve after build seasons) | `Realm.preview(offer)`; no undo (the table never had one) |
| Needs | Threat cards, one at a time | Two at a time with the works on (`threats` option) |
| Board | `BOARD` = 3 | `board` option, 5 with the works |
| Base content | Catalog cards | `src/season/works.ts`: the works as a pack in draft 10 (loaded like any pack), on at the table by default |

**The 3D loop** (no 3D code here). It needs: the pieces list (each crew a worker figure walking to its thing: the
riders/builders already walk to sites), a tap on a thing to post or recall a piece, the thing's uses as buttons on its
card with "left this season", the preview line before a commit, and the needs' countdowns beside the raiders'. All of
it is Realm API (section 6), so both front ends read the same state.

## 7. Open questions for the owner

1. Should a recalled piece be free at once (now) or next season (moving costs a season)?
2. Uses "mostly once a season": is "twice" on the market right, or should every use be once?
3. Two needs at once plus the raiders: too many? (The bots say how often needs lapse.)
4. Named people as special pieces (the reeve counts as 2 crews; a captain makes posted soldiers count double)?
5. Should the 3D loop turn the works on now, or after you have played them at the table?
