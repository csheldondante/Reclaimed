// ---- hero/registry.ts -----------------------------------------------------------
// (round 112, herosandbox; BACKLOG HS1) The heroes a sandbox can drop in as, by role (contracts/hero.ts HeroEntry).
// One way in: registerHero. The Walker registers itself here (built-in); another game's heroes come from an ES
// module loaded at runtime (loadHeroModule: `?heroes=<url>` or the sandbox's list), which exports `heroContract`
// and `mount(host)` (contracts/hero.ts HeroModule) — so the hoverbike game serves its heroes from its own build and
// nothing of it is copied into Reclaimed. The module's version is checked as it loads: a mismatch is an error that
// says both versions, never a silent fallback.

import { HERO_CONTRACT, type HeroEntry, type HeroHost, type HeroModule } from '../api/contracts/hero';
import { Walker } from './walker';

export interface Registered extends HeroEntry {
  /** where it came from: 'built-in' or the module's URL */
  source: string;
}

const heroes = new Map<string, Registered>();
const listeners = new Set<() => void>();

/** Add a hero by its role. A second hero of a role already taken is an error (two games' heroes never shadow each other silently). */
export function registerHero(e: HeroEntry, source = 'built-in'): void {
  if (!e.role) throw new Error(`hero registry: a hero from ${source} has no role`);
  const had = heroes.get(e.role);
  if (had && had.source !== source) throw new Error(`hero registry: the role "${e.role}" from ${source} is taken by ${had.source}`);
  heroes.set(e.role, { ...e, source });
  for (const f of listeners) f();
}

export function heroRoles(): string[] {
  return [...heroes.keys()];
}

export function heroEntry(role: string): Registered {
  const e = heroes.get(role);
  if (!e) throw new Error(`hero registry: no hero "${role}" (${heroRoles().join(', ') || 'none'})`);
  return e;
}

export function heroList(): Registered[] {
  return [...heroes.values()];
}

export function onHeroes(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/**
 * Is a module built against `theirs` loadable by this host (`ours`)? Majors equal and their minor no newer.
 * Returns null when it is, else why not (the message the sandbox shows).
 */
export function contractMismatch(theirs: unknown, ours = HERO_CONTRACT): string | null {
  if (typeof theirs !== 'string' || !/^\d+\.\d+$/.test(theirs)) return `it declares no heroContract "major.minor" (got ${JSON.stringify(theirs)}); this host is ${ours}`;
  const [ma, mi] = theirs.split('.').map(Number);
  const [oa, oi] = ours.split('.').map(Number);
  if (ma !== oa) return `it was built against hero contract ${theirs}, this host is ${ours} (a different major: signatures changed)`;
  if (mi > oi) return `it was built against hero contract ${theirs}, newer than this host's ${ours} (it may use what this host lacks)`;
  return null;
}

/** the modules loaded, by URL: one mount each */
const mounted = new Map<string, { roles: string[]; dispose?: () => void }>();

/**
 * Load a hero module from `url` and register what its `mount(host)` offers. Throws, with the URL and the reason,
 * on a failed import, a missing export, a contract mismatch or a role clash.
 */
export async function loadHeroModule(url: string, host: HeroHost): Promise<string[]> {
  const had = mounted.get(url);
  if (had) return had.roles;
  let mod: Partial<HeroModule>;
  try {
    mod = (await import(/* @vite-ignore */ url)) as Partial<HeroModule>;
  } catch (e) {
    throw new Error(`hero module ${url}: it didn't load (${(e as Error).message})`);
  }
  const why = contractMismatch(mod.heroContract);
  if (why) throw new Error(`hero module ${url}: ${why}`);
  if (typeof mod.mount !== 'function') throw new Error(`hero module ${url}: it exports no mount(host)`);
  const m = await mod.mount(host);
  if (!m || !Array.isArray(m.heroes) || !m.heroes.length) throw new Error(`hero module ${url}: mount() offered no heroes`);
  for (const e of m.heroes) {
    if (typeof e.makeHero !== 'function') throw new Error(`hero module ${url}: the hero "${e.role}" has no makeHero`);
    registerHero(e, url);
  }
  const roles = m.heroes.map((e) => e.role);
  mounted.set(url, { roles, dispose: m.dispose });
  return roles;
}

/** the modules loaded (the feedback file says which) */
export function heroModules(): string[] {
  return [...mounted.keys()];
}

/** Forget every module's heroes (a scene going away: the next mounts again on its own host). */
export function unmountHeroModules(): void {
  for (const [url, m] of mounted) {
    m.dispose?.();
    for (const r of m.roles) if (heroes.get(r)?.source === url) heroes.delete(r);
  }
  mounted.clear();
  for (const f of listeners) f();
}

registerHero({ role: 'wanderer', name: 'Wanderer (on foot, a sword)', icon: '🗡', makeHero: (w, at) => new Walker(w, at) });
