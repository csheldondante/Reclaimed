# Reclaimed

An atmospheric systemic sandbox in the browser: you play as nature reclaiming
the ruins of an industrial valley. Push the wind, raise storms, call
lightning. Rain washes pollution away, fire clears oil, floods scour the
landfill, and life creeps back through the ruins.

TypeScript + WebGPU, isometric voxel world, simulation on the GPU. Built as a
showcase of fast game development with an AI coding agent — the notes on
every change and decision are in `docs/`.

**Play:** https://csheldondante.github.io/Reclaimed/ — needs a browser with
WebGPU: desktop Chrome or Edge, Android Chrome, or a recent Safari.

## Run

```
npm install
npm run dev        # http://localhost:5173
```

## Play

| input | does |
|---|---|
| tap ground or plants | a small growth boost (or a wilt on bad ground) |
| tap under a storm | lightning, drawn to metal |
| tap elsewhere | touch things (crack masonry, ring tanks, splash, startle birds) |
| drag | wind along the drag; near a storm it steers it |
| swirl | a cyclone; over water, a lightning storm |
| RMB drag · WASD | pan |
| wheel · MMB drag · pinch | zoom |
| hold Space | life lens: what keeps plants out |

Reclaim 55 % of the valley to complete it; the title screen remembers.

## Docs

`CLAUDE.md` (developer/agent guide) · `docs/HANDOFF.md` · `docs/ARCHITECTURE.md` ·
`docs/DECISIONS.md` · `docs/DEVLOG.md` · `docs/STATUS.md` ·
design brief: `.claude/docs/design/Reclaimed_Overview.md`

## License

Source-available, not open source: [PolyForm Noncommercial 1.0.0](LICENSE).
You may play, read, change and share it for any noncommercial purpose
(personal, hobby, study, research, nonprofit and educational use). Commercial
use — selling it, ads, or using it in a commercial product — is not
permitted.
