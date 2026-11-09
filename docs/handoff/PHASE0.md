# Phase 0 — private repo, Cloudflare Pages, Synty licence gate

Owner: Track B orchestrator. Account steps: the user. Started 2026-11-09. Status: **baseline recorded, layout proposed,
waiting on the user's account steps**. Licence gate: **CONDITIONAL PASS** (see §3), not yet acted on.

## 1. Baseline (verified 2026-11-09)

| Item | Value |
|---|---|
| Repo | github.com/csheldondante/Reclaimed, public, LICENSE PolyForm Noncommercial |
| Workflow | `.github/workflows/pages.yml` (the only workflow), last changed 0d4732e0 (2026-10-30) |
| Triggers | push to `main` or `places`, or manual dispatch. A push to `fortress` does **not** redeploy |
| Build | Node 22, per branch: `npm ci && npm run build` (`tsc --noEmit && vite build`), output `dist/` |
| Layout | one site: `main` at the root, `places fortress before128o onetown phonefix townlab` under `/<branch>/` |
| Base path | `base: './'` in `vite.config.ts` (relative; works from any folder or subdomain) |
| Build-time inputs | `git rev-parse --short HEAD` (`__BUILD_COMMIT__`), content hash of `src/ data/` + pages, `genHash` |
| Pages entry points | `index.html`, `contract.html`, `structures.html`, `flora.html`, `cardlab.html` |
| Output size (fortress fdaa3f34) | 56 files, 5.1 MB; largest `main-*.js` 1.7 MB, `town-*.rclt` 1.16 MB; local build ~6 s |
| Live | `https://csheldondante.github.io/Reclaimed/{,fortress/,onetown/,places/,phonefix/,townlab/,before128o/}` all 200; last deploy 2026-11-06 16:54 GMT (`Last-Modified`), `Cache-Control: max-age=600` |
| Phone link | `https://csheldondante.github.io/Reclaimed/<branch>/?skipmenu=1&level=atlas&town=1&fortress=1&fresh=1&q=low` |
| Licensed files in git | none (`git ls-files` has no `.fbx/.unitypackage/.prefab/.mat`, no Synty names) |

Note: the live `fortress/` is the 2026-11-06 build, older than fortress's head, because only pushes to `main`/`places` deploy.

GitHub Pages on a private repo needs GitHub Pro/Team/Enterprise, and even then the site stays public. On GitHub Free,
making the repo private takes the Pages site down. (Plan not checked: `gh` is not installed here.)

## 2. Proposed Cloudflare layout (to agree with the user)

Cloudflare Pages Git integration, one project, **one build per branch** (no GitHub Actions, no API token in the repo):

- Project `reclaimed` (if `reclaimed.pages.dev` is taken, Cloudflare adds a suffix; we use whatever it gives).
- Production branch: `fortress` → `https://reclaimed.pages.dev/`.
- Every other branch → preview at `https://<branch>.reclaimed.pages.dev/` (lower-case, `/` → `-`), e.g.
  `https://trackb.reclaimed.pages.dev/?skipmenu=1&level=atlas&town=1&fortress=1&fresh=1&q=low`.
- Build settings: framework preset None; build command `npm run build`; output `dist`; root `/`; env `NODE_VERSION=22`.
  Cloudflare installs from `package-lock.json` itself (`npm ci`).
- Preview branch control: **custom list** (`fortress`, `trackA`, `trackB`, `onetown`, …) so agent branches don't
  eat the free plan's 500 builds a month.
- Later, in a `public/_headers` file: `/assets/*  Cache-Control: public, max-age=31536000, immutable` (Vite names are
  content-hashed). Not added yet; it goes in with the manifest/cache experiment (Experiment 3).

What changes for us: each branch gets its own origin, so saved worlds (OPFS/IndexedDB/localStorage) stop being shared
between branches; old phone links stop working once GitHub Pages is off.

Rejected: keeping the folder-per-branch site through GitHub Actions + `wrangler pages deploy`. It needs a Cloudflare API
token as a repo secret, rebuilds every branch on each push, and on a private Free repo it spends Actions minutes.

Free-plan limits that apply: 500 builds a month, 1 build at a time, 20 min per build, 20,000 files, 25 MiB a file.
We are far inside them (56 files, 1.7 MB largest).

## 3. Licence gate (Synty and the other Unity packs)

The packs on this machine were bought on the **Unity Asset Store**:

- Synty POLYGON Fantasy Rivals, Dungeons, Adventure, Fantasy Kingdom, Pirate, Nature
- MalberS Poly Art Animal Forest Set
- Raygeas Stylized Terrain Textures
- Opsive Omni Animation Core Locomotion
- Explosive RPG Character Mecanim Animation (FREE)

The **Unity Asset Store EULA** (Appendix 1, updated 2024-12-04) governs them, not Synty's own EULA. Synty's One-Time
Purchase licence defines "Store" as "excluding the Unity Asset Store". The Fantasy Kingdom listing names the "Standard
Unity Asset Store EULA".

What the EULA says:
- §2.2.1(a) incorporate the Asset "together with substantial, original content" so that it "does not comprise a
  substantial portion of the Licensed Product";
- §2.2.1(b) "distribute the Asset as incorporated and embedded" in that product;
- §2.2.1(e) modify;
- §2.2.1.1(b) do not "enable a customer or user … to sell, transfer, distribute … the Assets";
- §5.1 no copies beyond incidental ones;
- §3.8(i) no reverse engineering of the store or Assets;
- §2.3.1 unlimited computers for the licensee;
- §2.4 contractors need their own licence.

It does not mention other engines (Unity support says use elsewhere is fine) and has no clause about extraction
protection.

What follows for us:
- **Allowed:** converted, modified meshes and textures packed into the game's own binary data and loaded only by the game.
- **Not allowed:**
  - raw FBX/PNG/`.unitypackage` in any public place (public repo, public URL as loose files);
  - any Synty-derived file in a **public** git repo, since the repo's PolyForm licence would claim to relicense it;
  - an export, mod or "download model" feature;
  - a level editor that lets players publish assets to others.
- **Grey:** "incorporated and embedded" vs. well-named loose files on a public CDN. We use a packed binary (one blob per pack
  or region, our own layout), and no original file names or folder structure.
- **Private repo:** converted data may be committed there. Raw packs stay outside the repo always.

Verdict: **CONDITIONAL PASS**. Shipping converted, packed assets in the browser build is permitted once:

1. the repo is private;
2. each pack's listing is confirmed as Standard EULA, not "Restricted" (checked for Fantasy Kingdom only; the user to
   glance at "My Assets" or let me check each listing);
3. the user accepts the grey-zone reading above, or asks Synty/Unity support in writing.

Opsive and MalberS may carry their own terms; check them before use.

Not legal advice; a reading of the published terms.

## 4. User steps, in order

See the report of 2026-11-09 (copied into CURRENT_STATE when done). Evidence of each step goes here.

## 5. Rollback

- Cloudflare is broken: the GitHub Pages workflow stays in the repo until step 6, so GitHub Pages keeps serving.
- After the repo goes private: make it public again; Settings → Pages → Source: GitHub Actions; re-run `pages.yml` from
  Actions.
- Or keep Cloudflare as primary and fix forward.
