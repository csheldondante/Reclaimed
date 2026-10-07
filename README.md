# Reclaimed

An atmospheric systemic sandbox in the browser: you play as nature reclaiming
the ruins of an industrial valley. Summon storms, call lightning, push the
wind. Rain washes pollution away, fire clears oil, floods scour the landfill,
and life creeps back through the ruins.

TypeScript + WebGPU, isometric voxel world, simulation on the GPU.

## Run

```
npm install
npm run dev        # http://localhost:5173 — Chrome or Edge (WebGPU required)
```

## Play

| input | does |
|---|---|
| LMB tap under a storm's shadow | lightning |
| LMB tap elsewhere | touch things (crack masonry, ring tanks, splash, startle birds) |
| LMB drag under a storm | gust of wind (moves dust, smoke and the storm itself) |
| RMB drag · WASD | pan |
| wheel · MMB drag | zoom |
| R or ☁ | summon a storm |
| hold Space | life lens: what keeps plants out |

Reclaim 60 % of the valley to complete it; the menu scene remembers.

## Docs

`CLAUDE.md` (developer/agent guide) · `docs/HANDOFF.md` · `docs/ARCHITECTURE.md` ·
`docs/DECISIONS.md` · `docs/DEVLOG.md` · `docs/STATUS.md` ·
design brief: `.claude/docs/design/Reclaimed_Overview.md`
