/* 한 칸 이동과 카메라 연출 상태.

   순환을 끊는 지점이 두 곳 있다:
   1) 멀티에서는 서버가 판정하므로 여기서 움직이면 안 된다. 그렇다고 net 을 import 하면
      net → player → net 이 된다. 그래서 net 이 setSender() 로 자기를 꽂아 넣는다.
   2) 미니맵에 좌표를 넘겨주기만 하고 미니맵을 import 하지 않는다 — main 이 이어준다.

   view 는 카메라 연출 상태다. ESM 은 모듈 밖에서 let 을 재대입할 수 없으므로
   객체에 담아 제자리에서 바꾼다. */

import { CREATURE, DIRS, START, walkable, wx, wz } from './core/space.ts';
import { footstep, rustle } from './audio.ts';
import type { Action, Dir } from '../shared/protocol.ts';

export const player: { x: number; y: number; dir: Dir } =
  { x: START.x, y: START.y, dir: START.dir };

export type Anim =
  | { kind: 'move'; t: number; fx: number; fz: number; tx: number; tz: number }
  | { kind: 'turn'; t: number; from: number; to: number };

export const view: { anim: Anim | null; camYaw: number; bob: number } = {
  anim: null,
  camYaw: -START.dir*Math.PI/2,
  bob: 0,
};

export const ease = (t: number): number =>
  t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2;

/* net 이 접속하면 자기 전송 함수를 꽂는다. 오프라인이면 null 이고,
   그때는 아래 step/turn 이 로컬에서 직접 움직인다. */
let sender: ((a: Action) => void) | null = null;
export const setSender = (fn: ((a: Action) => void) | null): void => { sender = fn; };
export const isOnline = (): boolean => sender !== null;

/** 이동·회전 뒤 미니맵을 갱신하라고 알린다 (main 이 이어준다) */
let onMoved: (() => void) | null = null;
export const setOnMoved = (fn: () => void): void => { onMoved = fn; };

export function step(sign: number): boolean {
  // 멀티에서는 서버가 판정한다. 여기서 움직이면 화면만 거짓말을 하게 된다.
  if(sender){ sender(sign > 0 ? 'forward' : 'back'); return false; }
  if(view.anim) return false;
  const d = DIRS[player.dir]!;
  const nx = player.x + d.dx*sign, ny = player.y + d.dy*sign;
  if(!walkable(nx, ny) || (nx === CREATURE.x && ny === CREATURE.y)) return false;
  view.anim = { kind:'move', t:0, fx:wx(player.x), fz:wz(player.y), tx:wx(nx), tz:wz(ny) };
  player.x = nx; player.y = ny;
  footstep(sign < 0);
  onMoved?.();
  return true;
}

export function turn(side: 'left' | 'right'): boolean {
  if(sender){ sender(side); return false; }
  if(view.anim) return false;
  player.dir = ((player.dir + (side === 'left' ? 3 : 1)) % 4) as Dir;
  view.anim = { kind:'turn', t:0, from:view.camYaw,
                to: view.camYaw + (side === 'left' ? Math.PI/2 : -Math.PI/2) };
  rustle(side);
  onMoved?.();
  return true;
}

export function bindKeys(): void {
  addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    if(k === 'h'){
      document.querySelectorAll('.panel,#hint,#minimap').forEach(n => n.classList.toggle('hidden'));
      return;
    }
    const m: Record<string, () => boolean> = {
      arrowup: () => step(1), w: () => step(1),
      arrowdown: () => step(-1), s: () => step(-1),
      arrowleft: () => turn('left'), a: () => turn('left'),
      arrowright: () => turn('right'), d: () => turn('right'),
    };
    const fn = m[k];
    if(fn){ e.preventDefault(); fn(); }
  });
}
