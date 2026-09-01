/* 게임 규칙 — 권위(authoritative) 상태. 기획서 §4 를 그대로 옮긴다.
   시간을 인자로 받는다 (Date.now() 를 내부에서 부르지 않는다).
   그래야 테스트에서 5분짜리 라운드를 즉시 돌려볼 수 있다.

   여기서 절대 하지 않는 것: 소켓 접근, 타이머 등록, 콘솔 출력.
   전부 KkakkungRoom 이 한다. 그 덕에 전송 계층을 ws → Colyseus 로 갈아끼울 때
   이 파일은 한 줄도 안 고쳤다. */

import * as M from './maze.ts';
import {
  COOLDOWN, SIGHT_CELLS, CAPTURE_CELLS, IT_COUNT, MAZE_W, MAZE_H,
  type Action, type Cell, type Dir, type GameEvent, type Grid,
  type LobbyPlayer, type Player, type PlayerView, type Role, type Winner,
} from '../shared/protocol.ts';

export { COOLDOWN, SIGHT_CELLS, CAPTURE_CELLS, IT_COUNT };

export const DEFAULTS = {
  w: MAZE_W, h: MAZE_H,         // 크기 근거는 protocol.ts. 솔로도 같은 값을 쓴다
  infiltrateMs: 10_000,         // §4.1 잠입 10초
  chaseMs: 300_000,             // §4.1 추격 5~7분 — 5분에서 시작한다
};

export interface Game {
  seed: number;
  grid: Grid;
  w: number;
  h: number;
  exit: Cell;
  runnerSpawn: Cell;
  itSpawns: Cell[];
  itSpawn: Cell;
  /** 탈출구에서의 거리장 — 탈출구 방향 신호용 (§4.3 ③) */
  exitDistField: number[][];
  players: Map<string, Player>;
  phase: PlayerView['phase'];
  phaseEndsAt: number;
  infiltrateMs: number;
  chaseMs: number;
  winner: Winner | null;
  endReason: string | null;
  events: GameEvent[];
}

export interface GameOptions {
  seed?: number;
  w?: number;
  h?: number;
  infiltrateMs?: number;
  chaseMs?: number;
}

/** 북쪽 0, 시계방향 */
const dirOf = (from: Cell, to: Cell): number => Math.atan2(to.x - from.x, -(to.y - from.y));
export const stepDist = (a: Cell, b: Cell): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

export function createGame(opt: GameOptions = {}): Game {
  const o = { ...DEFAULTS, ...opt };
  const seed = (opt.seed ?? (Math.random()*0xFFFFFFFF)) >>> 0;
  const maze = M.generate(o.w, o.h, seed);
  const spawn = M.placeSpawns(maze.grid, seed);
  return {
    seed, grid: maze.grid, w: maze.w, h: maze.h,
    exit: spawn.exit, runnerSpawn: spawn.runnerSpawn,
    itSpawns: spawn.itSpawns, itSpawn: spawn.itSpawns[0]!,
    exitDistField: M.bfs(maze.grid, spawn.exit),
    players: new Map<string, Player>(),
    phase: 'lobby',
    phaseEndsAt: 0,
    infiltrateMs: o.infiltrateMs, chaseMs: o.chaseMs,
    winner: null, endReason: null,
    events: [],
  };
}

export function addPlayer(g: Game, id: string, name?: string): Player {
  const existing = g.players.get(id);
  if(existing) return existing;
  const p: Player = {
    id, name: String(name || '이름없음').slice(0, 16),
    role: 'runner', x: g.runnerSpawn.x, y: g.runnerSpawn.y, dir: 1,
    alive: true, escaped: false, nextMoveAt: 0, ready: false, connected: true,
  };
  g.players.set(id, p);
  return p;
}
export const removePlayer = (g: Game, id: string): boolean => g.players.delete(id);
export const list = (g: Game): Player[] => [...g.players.values()];
export const runners = (g: Game): Player[] => list(g).filter(p => p.role === 'runner');
export const theIts = (g: Game): Player[] => list(g).filter(p => p.role === 'it');
/** 예전 호출부 호환 */
export const theIt = (g: Game): Player | null => theIts(g)[0] ?? null;

function shuffle<T>(a: T[]): T[] {
  const out = a.slice();
  for(let i=out.length-1; i>0; i--){
    const j = (Math.random()*(i+1))|0;
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/* 역할 배정 — 술래 수는 인원에 따른다.
   3인 이하에서 술래를 2명 두면 도망자가 1명뿐이라 게임이 안 된다.
   §4.1 은 술래 1명으로 적혀 있으나, 6인까지 열면서 도망자 쪽이 너무 유리해져
   4인 이상은 2명으로 올린다 (한 명만 탈출해도 도망자 승이기 때문).

   §4.3 ② 역할 교대를 위해 직전 술래들을 후보에서 뒤로 민다.
   순번제는 아니다 — 무작위이되 연속으로 술래가 되는 것만 피한다. */
export function assignRoles(g: Game, previousIts?: string[]): void {
  const ps = list(g);
  if(!ps.length) return;
  const prev = new Set(previousIts ?? []);
  const want = Math.min(IT_COUNT(ps.length), ps.length - 1);   // 도망자가 최소 1명은 남아야 한다

  // 직전 술래가 아닌 사람 먼저, 모자라면 그때 직전 술래도 쓴다
  const order = [...shuffle(ps.filter(p => !prev.has(p.id))),
                 ...shuffle(ps.filter(p => prev.has(p.id)))];
  const its = new Set(order.slice(0, Math.max(1, want)).map(p => p.id));

  let k = 0;
  for(const p of ps){
    p.role = its.has(p.id) ? 'it' : 'runner';
    p.alive = true; p.escaped = false; p.nextMoveAt = 0;
    const s = p.role === 'it' ? g.itSpawns[(k++) % g.itSpawns.length]! : g.runnerSpawn;
    p.x = s.x; p.y = s.y; p.dir = 1;
  }
}

export function start(g: Game, now: number, previousIts?: string[]): { ok: boolean; reason?: string } {
  if(g.players.size < 2) return { ok:false, reason:'2명 이상이어야 시작할 수 있다' };
  assignRoles(g, previousIts);
  g.phase = 'infiltrate';
  g.phaseEndsAt = now + g.infiltrateMs;
  g.winner = null; g.endReason = null;
  g.events.push({ t:'phase', phase:'infiltrate', endsAt:g.phaseEndsAt });
  return { ok:true };
}

/* 입력 — 전부 서버가 검증한다. 클라이언트는 "이렇게 하고 싶다"만 보낸다.
   벽 통과·쿨다운 무시·순간이동이 전부 여기서 막힌다. */
export function input(g: Game, id: string, action: Action | string, now: number): { ok: boolean; reason?: string } {
  const p = g.players.get(id);
  if(!p) return { ok:false, reason:'없는 플레이어' };

  // 로비에서는 자유롭게 걸어다닌다 — 조작을 확인하고 몸을 푸는 시간이다.
  // 시작하면 assignRoles 가 전원을 시작 지점으로 되돌리므로 밸런스에는 영향이 없고,
  // resolve() 도 로비에서는 아무 판정을 하지 않는다.
  const canMove = g.phase === 'lobby' || g.phase === 'chase'
               || (g.phase === 'infiltrate' && p.role === 'runner');
  if(!canMove) return { ok:false, reason:'지금은 움직일 수 없다' };   // 잠입 중 술래 · 종료 후
  if(!p.alive || p.escaped) return { ok:false, reason:'이미 끝났다' };
  if(now < p.nextMoveAt) return { ok:false, reason:'쿨다운' };

  if(action === 'left' || action === 'right'){
    p.dir = ((p.dir + (action === 'left' ? 3 : 1)) % 4) as Dir;
  } else if(action === 'forward' || action === 'back'){
    const s = action === 'forward' ? 1 : -1;
    const d = M.DIRS[p.dir]!;
    const nx = p.x + d.dx*s, ny = p.y + d.dy*s;
    if(!M.walkable(g.grid, nx, ny)) return { ok:false, reason:'벽' };
    p.x = nx; p.y = ny;
    g.events.push({ t:'move', id:p.id, role:p.role, x:nx, y:ny });
  } else return { ok:false, reason:'모르는 동작' };

  p.nextMoveAt = now + COOLDOWN[p.role];
  resolve(g);
  return { ok:true };
}

/* 판정 — 이동이 일어난 뒤에만 부른다.
   포획과 탈출을 같은 곳에서 처리해야 "탈출하는 순간 잡혔다" 같은 순서 문제가 안 생긴다. */
function resolve(g: Game): void {
  if(g.phase !== 'chase' && g.phase !== 'infiltrate') return;
  const its = theIts(g);

  for(const r of runners(g)){
    if(!r.alive || r.escaped) continue;
    // 탈출 먼저 본다 — 탈출구 위에서 잡히면 탈출을 인정한다 (도망자 쪽에 유리하게)
    if(r.x === g.exit.x && r.y === g.exit.y){
      r.escaped = true;
      g.events.push({ t:'escape', id:r.id, name:r.name });
      return end(g, 'runners', `${r.name} 탈출`);   // §4.1 1명이라도 탈출하면 도망자 진영 승
    }
    if(g.phase === 'chase' && its.some(it => it.alive && stepDist(it, r) <= CAPTURE_CELLS)){
      r.alive = false;
      g.events.push({ t:'caught', id:r.id, name:r.name });
    }
  }
  if(g.phase === 'chase' && runners(g).every(r => !r.alive))
    return end(g, 'it', '도망자 전원 포획');
}

function end(g: Game, winner: Winner, reason: string): void {
  g.phase = 'over'; g.winner = winner; g.endReason = reason;
  g.events.push({ t:'over', winner, reason });
}

/** 시간 진행 — 방이 주기적으로 부른다. */
export function tick(g: Game, now: number): GameEvent[] {
  if(g.phase === 'infiltrate' && now >= g.phaseEndsAt){
    g.phase = 'chase';
    g.phaseEndsAt = now + g.chaseMs;
    g.events.push({ t:'phase', phase:'chase', endsAt:g.phaseEndsAt });
  } else if(g.phase === 'chase' && now >= g.phaseEndsAt){
    // §4.1 은 "술래 승 = 제한시간 내 전원 포획" 이다.
    // 시간이 다 됐는데 남아 있으면 포획에 실패한 것이므로 도망자 승으로 본다.
    // (문서에 명시되지 않은 부분 — 생존이 곧 승리라는 해석)
    const alive = runners(g).filter(r => r.alive).length;
    end(g, alive ? 'runners' : 'it', alive ? '제한시간 종료 — 생존' : '전원 포획');
  }
  return drain(g);
}
export function drain(g: Game): GameEvent[] { const e = g.events; g.events = []; return e; }

export const lobbyPlayer = (p: Player): LobbyPlayer => ({
  id: p.id, name: p.name, role: p.role, alive: p.alive,
  escaped: p.escaped, connected: p.connected !== false,
});

/* 이 플레이어가 알아도 되는 것만 추린다.
   보내지 않는 것은 클라이언트를 뜯어봐도 알 수 없다 — 그게 권위 서버의 요점이다.
   PlayerView 타입이 이 규칙을 문법으로 강제한다 (shared/protocol.ts). */
export function viewFor(g: Game, id: string, now: number): PlayerView | null {
  const me = g.players.get(id);
  if(!me) return null;
  const view: PlayerView = {
    phase: g.phase,
    msLeft: Math.max(0, g.phaseEndsAt - now),
    winner: g.winner, endReason: g.endReason,
    me: { id:me.id, name:me.name, role:me.role, x:me.x, y:me.y, dir:me.dir,
          alive:me.alive, escaped:me.escaped },
    alive: runners(g).filter(r => r.alive && !r.escaped).length,
    total: runners(g).length,
    seen: [],
    hints: [],
  };

  // §1.2 직선 시야 — 정면·벽 없음·4칸 이내일 때만 상대가 보인다
  if(me.alive && !me.escaped){
    const los = M.lineOfSight(g.grid, me, me.dir, SIGHT_CELLS);
    for(const c of los){
      for(const o of list(g)){
        if(o.id === me.id || !o.alive || o.escaped) continue;
        if(o.x === c.x && o.y === c.y)
          view.seen.push({ id:o.id, name:o.name, role:o.role, x:o.x, y:o.y, d:c.d,
                           stage: c.d <= 1 ? 'contact' : c.d <= 2 ? 'near' : 'far' });
      }
    }

    /* 탈출구도 같은 시야 규칙을 탄다 — 벽 너머로는 안 보인다.
       로비에서는 주지 않는다. 워밍업으로 문을 미리 찾아두면 판이 시작하기도 전에
       끝나 있는 셈이고, 잠입 10초가 의미를 잃는다. */
    if(g.phase !== 'lobby'){
      const e = los.find(c => c.x === g.exit.x && c.y === g.exit.y);
      if(e) view.exitSeen = { x:e.x, y:e.y, d:e.d };
    }
  }

  if(me.role === 'runner'){
    // §4.3 ③ 탈출구 방향 신호 — 좌표는 주지 않는다. 거리감만.
    const d = g.exitDistField[me.y]?.[me.x] ?? -1;
    view.exitDist = d < 0 ? null : d;
  } else {
    // §4.3 ② 술래는 도망자 위치를 못 받는다. 발소리 방향과 거리만 듣는다.
    for(const r of runners(g)){
      if(!r.alive || r.escaped) continue;
      const d = stepDist(me, r);
      if(d <= 8) view.hints.push({ bearing: dirOf(me, r) - me.dir*Math.PI/2, d });
    }
  }
  return view;
}

export type { Role, Player };
