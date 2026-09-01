/* 미니맵 검증 —  node test/minimap.test.ts

   전에는 spike-play.html 에서 정규식으로 블록을 잘라내 new Function 으로 돌렸다.
   주석 한 줄만 옮겨도 테스트가 깨지는 방식이었다. 이제는 그냥 import 한다.

   확인할 것: 밟지 않은 칸을 그리지 않는가 (§1.2 가 무너지면 게임이 무너진다). */

import { setGrid } from '../src/core/space.ts';

/* 캔버스를 스텁으로 두고 '무엇을 칠했는지' 를 본다.
   mapDraw 는 호출 시점에 document 를 찾으므로 import 전에 심어둔다. */
interface Painted { x: number; y: number; w: number; fill: string }
const painted: Painted[] = [];
let arrow: [number, number][] | null = null;

const ctx = {
  fillStyle: '#000',
  clearRect(){ painted.length = 0; arrow = null; },
  fillRect(x: number, y: number, w: number){ painted.push({ x, y, w, fill: this.fillStyle }); },
  beginPath(){ arrow = []; },
  lineTo(x: number, y: number){ arrow?.push([x, y]); },
  closePath(){}, fill(){},
};
const canvas = {
  width: 0, height: 0, clientWidth: 100,
  getContext: () => ctx,
  classList: { contains: () => false },
};
(globalThis as any).document = { getElementById: (id: string) => (id === 'minimap' ? canvas : null) };
(globalThis as any).devicePixelRatio = 1;

const { mapReset, mapMark, mapDraw } = await import('../src/minimap.ts');

let pass = 0, fail = 0;
const ok = (c: unknown, l: string) => { c ? pass++ : (fail++, console.log('  ✗ ' + l)); };

// 5×5 미로: 가운데 십자 통로
setGrid(['#####', '#...#', '#.#.#', '#...#', '#####']);
/* 칸 크기는 격자 행수에 따라 달라진다 (cv.width / n). 그때그때 계산한다. */
const cellAt = (x: number, y: number, rows: number): Painted | undefined => {
  const s = canvas.width / rows;
  return painted.find(p => Math.abs(p.x - x*s) < 0.01 && Math.abs(p.y - y*s) < 0.01
                           && p.fill !== 'rgba(6,4,4,.82)');
};

let ROWS = 5;
console.log('미니맵');
mapReset();
mapMark(1, 1); mapDraw(1, 1, 1);
ok(cellAt(1, 1, ROWS), '밟은 칸이 칠해진다');
ok(!cellAt(3, 3, ROWS), '안 밟은 통로는 안 칠해진다 (§1.2)');
ok(!cellAt(3, 1, ROWS), '같은 복도라도 안 밟았으면 안 보인다');
ok(cellAt(0, 1, ROWS) && cellAt(1, 0, ROWS), '밟은 칸에 닿은 벽은 보인다');
ok(!cellAt(4, 3, ROWS), '먼 벽은 안 보인다');
ok(arrow !== null && (arrow as [number,number][]).length === 3, '내 위치 화살표가 그려진다');

mapMark(2, 1); mapMark(3, 1); mapDraw(3, 1, 1);
ok(cellAt(1, 1, ROWS) && cellAt(2, 1, ROWS) && cellAt(3, 1, ROWS), '지나온 칸이 누적된다');
ok(!cellAt(3, 3, ROWS), '여전히 안 간 곳은 안 보인다');

const east = JSON.stringify(arrow);
mapDraw(3, 1, 2);
ok(east !== JSON.stringify(arrow), '바라보는 방향이 화살표에 반영된다');

mapReset(); mapDraw(1, 1, 1);
ok(!cellAt(2, 1, ROWS) && !cellAt(3, 1, ROWS), '새 미로면 발자국이 지워진다');
ok(canvas.width === 100, '캔버스 픽셀 크기가 설정된다');

// 미로가 바뀌어도 좌표 규약이 유지되는가
setGrid(['#######', '#.....#', '#######']);
ROWS = 3;
canvas.width = 0;            // 격자가 바뀌면 캔버스 해상도를 다시 잡는다
mapReset(); mapMark(3, 1); mapDraw(3, 1, 1);
ok(cellAt(3, 1, ROWS), '새 미로에서도 밟은 칸이 그려진다');
ok(cellAt(3, 0, ROWS) && cellAt(3, 2, ROWS), '위아래 벽이 보인다');

console.log(`\n${fail ? '✗ 실패 ' + fail + '건' : '✔ 전부 통과'} (${pass}건 검사)`);
process.exit(fail ? 1 : 0);
