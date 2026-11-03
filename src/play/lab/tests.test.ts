// (round 128, herolab) every test in the menu names a real hero, station, handling and camera; its words are plain
import { describe as suite, expect, it } from 'vitest';
import { parseCam } from '../camera/rig';
import { isPlayHero } from '../heroes/make';
import { parseHandling } from './handling';
import { LAB_TERRAINS } from './terrains';
import { describe, findTest, LAB_TESTS, STATION_WORDS } from './tests';

suite('lab tests', () => {
  const stations = new Set([...LAB_TERRAINS.map((t) => t.id), 'tour', 'hill', 'climb', 'fight-waves', 'moves-canyon', 'moves-city', 'traits', 'enemy']);
  const all = LAB_TESTS.flatMap((g) => g.tests);
  it('name real things', () => {
    for (const t of all) {
      expect(isPlayHero(t.hero), t.id).toBe(true);
      expect(stations.has(t.station), t.id).toBe(true);
      expect(STATION_WORDS[t.station], t.id).toBeTruthy();
      parseHandling(t.handling);
      parseCam(t.cam ?? null);
      expect(findTest(t.id)).toBe(t);
    }
    expect(new Set(all.map((t) => t.id)).size).toBe(all.length);
  });
  it('every hero has tests', () => {
    expect(LAB_TESTS.map((g) => g.hero).sort()).toEqual(['horse', 'hoverbike', 'knight', 'lich']);
  });
  it('plain words: no parentheses, colons or semicolons in a question', () => {
    for (const t of all) expect(t.ask, t.id).not.toMatch(/[();:]/);
    // (an encounter's line is its goal's, not a question)
  });
  it('describes what is on', () => {
    expect(describe({ hero: 'hoverbike', station: 'moves-canyon', handling: ['stock', 'carve'], cam: ['chase', 'cutaway', 'tilt'] })).toBe(
      'Bike in the canyon. Handling: carve. Camera: cut and tilt.',
    );
    expect(describe({ hero: 'knight', station: 'enemy', handling: ['stock'], cam: ['chase'] })).toBe("Knight in the raiders' field. Camera: follow.");
  });
});
