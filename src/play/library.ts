// ---- play/library.ts --------------------------------------------------------------------------------------------
// The library of controllers (round 117, contracts/play.ts Playbook): each a ControllerInfo (data + its profile) in
// play/controllers/, its behaviour in play/heroes/. Adding one: write both, list it here (and in heroes/make.ts).
// The user: "we plan to make an expanding library of controllers to interact with the world."

import type { ControllerInfo, Playbook } from '../api/contracts/play';
import { hoverbike } from './controllers/hoverbike';
import { lich } from './controllers/lich';

const ALL: readonly ControllerInfo[] = [hoverbike, lich];

export const library: Playbook = {
  controllers: () => ALL,
  get: (id) => ALL.find((c) => c.id === id) ?? null,
};
