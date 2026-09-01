/* 공간 규약 (구현계획.md S0) — 여기 값은 실측으로 확정됐다. 바꾸지 않는다.

   이 모듈은 아무것도 import 하지 않는다. 순환 참조를 끊는 바닥이다.
   미로는 판마다 서버가 새로 주므로 재대입이 필요한데, ESM 은 모듈 밖에서
   let 을 재대입할 수 없다. 그래서 setGrid()/grid() 로 감싼다. */

import type { Dir, Grid } from '../../shared/protocol.ts';

export const CELL = 3.0;
export const WALL_H = 3.2;
export const EYE = 1.6;

/** 북=0, 동=1, 남=2, 서=3. server/maze.ts 의 DIRS 와 인덱스가 같아야 한다. */
export const DIRS: ReadonlyArray<{ dx: number; dy: number }> = [
  { dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 },
];

/** 솔로(오프라인) 기본 미로. 접속하면 서버가 준 것으로 갈아끼운다. */
const SOLO_GRID: Grid = ['#######', '#.....#', '#.###.#', '#.....#', '#.#.#.#', '#.....#', '#######'];
export const START: { x: number; y: number; dir: Dir } = { x: 3, y: 5, dir: 1 };
export const CREATURE = { x: 5, y: 2 };

let GRID: Grid = SOLO_GRID;
export const grid = (): Grid => GRID;
export const setGrid = (g: Grid): void => { GRID = g; };

export const walkable = (x: number, y: number): boolean =>
  !!(GRID[y] && GRID[y]![x] && GRID[y]![x] !== '#');

/** 격자 좌표 → 월드 좌표 */
export const wx = (g: number): number => g * CELL;
export const wz = (g: number): number => g * CELL;
