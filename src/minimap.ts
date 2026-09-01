/* 미니맵 — 지나온 칸만 (§1.2 · §4.3 ③)

   전체 지도를 주면 §1.2 "코너 너머를 알 수 없어서 무섭다" 가 무너진다.
   그래서 밟은 칸과 그 칸에 닿아 있는 벽만 그린다. 탈출구도 상대도 찍지 않는다.
   술래에게도 같은 것만 준다 — 설계 단계(S4)가 아직 없어 술래도 이 미로를 처음 본다.

   플레이어 위치를 import 하지 않고 인자로 받는다. player 가 이동할 때 미니맵을 갱신하고
   미니맵이 player 를 읽으면 순환이 된다. 어차피 '어디를 어느 방향으로' 만 있으면 되는 그림이다. */

import { el } from './core/dom.ts';
import { DIRS, grid } from './core/space.ts';
import type { Dir } from '../shared/protocol.ts';

/** 밟은 칸 집합. "x,y" 문자열로 담는다. */
const seen = new Set<string>();

export const mapReset = (): void => { seen.clear(); };
export const mapMark = (x: number, y: number): void => { seen.add(x + ',' + y); };
/** 테스트가 들여다본다 */
export const mapSeen = (): ReadonlySet<string> => seen;

export function mapDraw(px: number, py: number, dir: Dir): void {
  const cv = el<HTMLCanvasElement>('minimap');
  if(cv.classList.contains('hidden')) return;
  const ctx = cv.getContext('2d');
  if(!ctx) return;

  const g = grid();
  const n = g.length;
  const side = cv.clientWidth * devicePixelRatio;
  if(cv.width !== side){ cv.width = cv.height = side; }
  const s = cv.width / n;

  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = 'rgba(6,4,4,.82)';
  ctx.fillRect(0, 0, cv.width, cv.height);

  // 밟은 칸 + 그 칸에 닿아 있는 벽만
  for(const key of seen){
    const [xs, ys] = key.split(',');
    const x = Number(xs), y = Number(ys);
    ctx.fillStyle = '#2a2422';
    ctx.fillRect(x*s, y*s, s, s);
    for(const d of DIRS){
      const wx2 = x + d.dx, wy2 = y + d.dy;
      if(g[wy2] && g[wy2]![wx2] === '#'){
        ctx.fillStyle = '#574d49';
        ctx.fillRect(wx2*s, wy2*s, s, s);
      }
    }
  }

  // 나 — 삼각형이 바라보는 쪽을 가리킨다
  const cx = (px + 0.5)*s, cy = (py + 0.5)*s, r = s*0.42;
  const a = dir*Math.PI/2;                 // 0=북, 시계방향
  ctx.fillStyle = '#cfc6b4';
  ctx.beginPath();
  for(const [off, k] of [[0, 1], [2.4, 0.62], [-2.4, 0.62]] as [number, number][]){
    const t = a + off;
    ctx.lineTo(cx + Math.sin(t)*r*k, cy - Math.cos(t)*r*k);
  }
  ctx.closePath();
  ctx.fill();
}
