// The structures system (contracts/structures.ts Structures): plan, pieces, columns, buriable assets. Other tracks use
// only this and the contract.
import type { Structures } from '../api/contracts/structures';
import { planCity } from './plan';
import { piecesOf } from './pieces';
import { columnsOf } from './columns';
import { buriable, assetPieces } from './assets';
import { shipPieces } from './pieces';

export const structures: Structures = {
  plan: planCity,
  pieces: piecesOf,
  columns: columnsOf,
  asset: buriable,
  assetPieces,
  shipPieces,
};

export { planCity, piecesOf, columnsOf, buriable, assetPieces, shipPieces };
export { navPath } from './nav';
export { library } from './modules';
export { STYLES, STYLE_IDS } from './styles';
