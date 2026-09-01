/* 공간 규약 (구현계획.md S0) — 여기 값은 실측으로 확정됐다. 바꾸지 않는다.

   미로는 판마다 서버가 새로 주므로 재대입이 필요한데, ESM 은 모듈 밖에서
   let 을 재대입할 수 없다. 그래서 setGrid()/grid() 로 감싼다. */

import { generate, placeSpawns, bfs, cells } from '../../server/maze.ts';
import { MAZE_W, MAZE_H, type Dir, type Grid } from '../../shared/protocol.ts';

export const CELL = 3.0;
export const WALL_H = 3.2;
export const EYE = 1.6;

/** 북=0, 동=1, 남=2, 서=3. server/maze.ts 의 DIRS 와 인덱스가 같아야 한다. */
export const DIRS: ReadonlyArray<{ dx: number; dy: number }> = [
  { dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 },
];

/* 솔로(오프라인) 미로 — 서버와 같은 생성기로 같은 크기를 만든다.

   손으로 적은 7×7 을 쓰고 있었는데, 그러면 접속하지 않고서는 진짜 크기도
   진짜 탈출구도 볼 수 없다. server/maze.ts 는 네트워크도 타이머도 모르는
   순수 함수라 여기서 그대로 부를 수 있다 — 그러라고 그렇게 짠 것이다.

   판정은 없다. 이건 여전히 연습용이고, 탈출구를 밟아도 아무 일도 안 일어난다. */
const seed = (Math.random()*0xFFFFFFFF) >>> 0;
const SOLO = generate(MAZE_W, MAZE_H, seed);
const spawn = placeSpawns(SOLO.grid, seed, 1);

export const START: { x: number; y: number; dir: Dir } = {
  x: spawn.runnerSpawn.x, y: spawn.runnerSpawn.y, dir: 1,
};
/** 솔로 탈출구. 멀티에서는 서버가 보이는 순간에만 보내준다 (net 이 setExit 한다). */
export const EXIT = { x: spawn.exit.x, y: spawn.exit.y };

/* 그것은 술래 자리(탈출구 반대편)에 두지 않는다 — 33×33 에서 그러면
   한 번도 못 만나고 끝난다. 조우를 확인하는 게 솔로의 목적이므로 8칸쯤에 세운다. */
export const CREATURE = (() => {
  const dist = bfs(SOLO.grid, spawn.runnerSpawn);
  let best = spawn.itSpawn, gap = Infinity;
  for(const c of cells(SOLO.grid)){
    const d = dist[c.y]![c.x]!;
    if(d < 2) continue;                       // 눈앞에 세워두면 놀랄 일이 없다
    if(Math.abs(d - 8) < gap){ gap = Math.abs(d - 8); best = c; }
  }
  return { x: best.x, y: best.y };
})();

let GRID: Grid = SOLO.grid;
export const grid = (): Grid => GRID;
export const setGrid = (g: Grid): void => { GRID = g; };

export const walkable = (x: number, y: number): boolean =>
  !!(GRID[y] && GRID[y]![x] && GRID[y]![x] !== '#');

/** 격자 좌표 → 월드 좌표 */
export const wx = (g: number): number => g * CELL;
export const wz = (g: number): number => g * CELL;
