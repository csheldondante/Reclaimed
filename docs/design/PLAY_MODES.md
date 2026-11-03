# Play modes and the hero course — plan v1 (round 128b, for the user to correct)

Status: draft for the user. Nothing is built from this until the user agrees and a planning agent has checked it
against the code. Source of the ideas: DECISIONS round 128b (the user's camera and gameplay direction).

## The idea

The camera is one of the best tools to make play good: each kind of situation gets a view, controls and assists that
suit it, and the world stays the hero. A **play mode** is those three together, plus how it starts and ends:

| Part | What it decides | Examples |
|---|---|---|
| Camera | framing, zoom, lead ahead, pitch, azimuth, projection | iso chase that pulls out with speed and leads off-centre; behind-the-bike canyon cam; side profile with parallax; top-down |
| Controls | what the stick and swipes mean in that view | free steering; free sideways dodge while the route steers; run/jump/duck on a 2D plane |
| Assists | what the game does for the player | auto-steer along the route; speed governor; aim help; obstacle avoidance |
| Entry / exit | when and how it changes | the game decides from the area or the encounter; a brief auto transition that hands back control the moment the player touches the screen |

Every mode keeps the base rule: **the camera pulls out as speed rises and leads the hero off-centre toward where
they're going**.

## What exists to build on (not starting fresh)

- `herolab` (8edae7b): the lab framework (stations, test menu, settings drawer, hero picker), the CameraMode contract
  (api/contracts/camera.ts: modes compose on a CamFrame; chase, tilt, cut, dithered cut, auto zoom), the shared drive
  (play/core/drive.ts) with assist hooks, the horse's route assist, the autopilot, encounters as stations (goal,
  clock, result card), the knight, bike, lich and horse.
- `presentation` (unmerged): PresentationProfile (api/contracts/presentation.ts: camera zoom/pitch/azimuth,
  route-facing, look-ahead, speed-out, canopy treatments, light, transition styles) with prototypes for the canyon
  (route-facing), the cliff (near-profile, look-down) and the throne room. docs/design/REGION_PRESENTATION.md.
- The user's decisions on camera: cut + tilt readable (round 120); auto zoom by what sticks up (128); no free
  rotation that breaks screen-relative controls (128b).

Proposal: a PlayMode = a PresentationProfile (camera, look) + a control mapping + an assist set + entry/exit rules.
The presentation contract grows a `controls` and an `assists` part rather than a second contract.

## The course (the hero playground)

One continuous course built from the world's own generators and the level kit (not a flat test field), with
representative areas in a loop, each holding a few test spots:

1. open plain and rolling hills (speed, jumps off terrain)
2. forest (under the canopy; the woods run)
3. canyon with switchbacks (the canyon run)
4. cliff and cave mouth (climbing; a tight interior space)
5. river and shore (water, a ford, a bridge)
6. ruins with metal structures (things to break and use)
7. a small town (streets, followers, building)

The UI: hero picker (knight, bike, horse, lich) one tap away; an expandable settings drawer for the mode, camera,
controls, assists and abilities, each as chips mirrored in the address so a link reproduces a setup. Teleport to any
area. No balance or performance testing for this work.

## First experiments (the user's examples)

| # | Mode | Where | Camera | Controls | Assists | Question for the user |
|---|---|---|---|---|---|---|
| 1 | Open-world chase (today's, improved) | plains, hills | iso, pulls out with speed, leads off-centre | free steering | none | is the pull-out and lead right? |
| 2 | Canyon run | canyon, switchbacks | zoomed in behind the bike, following the route | **free sideways steering** across the canyon; speed by the stick's push | auto-steer along the route; riders come up the screen, obstacles come down it | is it fun to dodge while the canyon steers you? |
| 3 | Woods run | forest | side profile with parallax layers from the real 3D forest | run speed, jump, duck on the 2D plane | the route through the trees | does a 2D run through the woods feel good? |
| 4 | Cliff climb | cliff | near-profile (presentation's C) | climb, jump, grab | footholds highlighted | can you read the climb? |

Entry and exit (the user's rule): **the game decides** the mode from the area or encounter, takes over only long
enough to transition (a brief auto: camera swing and a few metres of steering), and hands control back **the moment
the player touches the screen**.

## Later loops (each gets its own plan first)

- **Followers** (the user's design): drag from a friendly unit onto the hero = follow; onto an enemy = attack; onto a
  resource = gather or pillage (context by unit); double-tap a unit = select all of its type on screen, then drag to
  order the group.
- **Building**: a Townscaper-like palette of building types painted into the land (settlements, fortresses), on the
  city tile grid and module library.
- **In-session dialog**: pauses the background logic for now (the talk hold from M128-6 is the seed).
- **Feel**: hit-stop, screen shake, anticipation and recovery, impact dust and debris, placeholder sounds.
- **Hero verbs that act on the world** (the strongest system): the wrench, slams that crack ground, blows that chip
  stone and topple metal.

## Process

1. The user corrects this plan.
2. A planning agent checks it against herolab, presentation, the camera and drive contracts and DECISIONS, and
   proposes the file-level build order for the course + experiment 1-2.
3. One implementing agent at a time; short reports; the user tests each experiment on the phone.
