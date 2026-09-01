/* 서버 ↔ 클라이언트 프로토콜 — 양쪽이 같은 파일을 import 한다.
   이게 이 마이그레이션의 핵심이다. 지금까지 두 쪽이 관례로만 모양을 맞추고 있었고,
   서버에서 필드 이름 하나를 바꾸면 클라이언트가 조용히 망가졌다.
   여기 이름을 바꾸면 양쪽 다 컴파일이 깨진다 — 그게 목적이다.

   ⚠️ 여기에 없는 필드는 보내지 않는다는 뜻이다.
   특히 도망자에게 탈출구 좌표를, 술래에게 도망자 좌표를 주지 않는 규칙(§4.3 ②③)이
   PlayerView 의 모양 자체로 강제된다. */

/** 북=0, 동=1, 남=2, 서=3. maze.ts 의 DIRS 인덱스와 일치해야 한다. */
export type Dir = 0 | 1 | 2 | 3;

export type Role = 'it' | 'runner';

/** lobby → infiltrate → chase → over (기획서 §4.1) */
export type Phase = 'lobby' | 'infiltrate' | 'chase' | 'over';

export type Winner = 'it' | 'runners';

/** §2.3 조우 3단계. 거리 1=contact, 2=near, 3~4=far */
export type Stage = 'contact' | 'near' | 'far';

export type Action = 'forward' | 'back' | 'left' | 'right';

export type Cell = { x: number; y: number };

/** 미로. grid[y][x] === '#' 이면 벽, 그 외는 통로 */
export type Grid = string[];

/* ── 서버가 들고 있는 것 (클라이언트로 통째로 나가지 않는다) ── */
export interface Player {
  id: string;
  name: string;
  role: Role;
  x: number;
  y: number;
  dir: Dir;
  alive: boolean;
  escaped: boolean;
  /** 다음 입력이 허용되는 시각(ms). 쿨다운 차등 §4.3 ① */
  nextMoveAt: number;
  ready: boolean;
  /** 재접속 유예 중이면 false */
  connected?: boolean;
}

/* ── 클라이언트로 나가는 것 ── */

/** 내 상태. 서버가 권한을 갖고, 클라이언트는 이 값을 따라간다. */
export interface MeView {
  id: string;
  name: string;
  role: Role;
  x: number;
  y: number;
  dir: Dir;
  alive: boolean;
  escaped: boolean;
}

/** 정면 4칸 이내 · 벽 없음일 때만 내려온다 (§1.2 · §2.3) */
export interface SeenPlayer {
  id: string;
  name: string;
  role: Role;
  x: number;
  y: number;
  /** 칸 거리 1~4 */
  d: number;
  stage: Stage;
}

/** 탈출구 — 사람과 똑같은 규칙으로만 내려온다 (정면 4칸 · 벽 없음).

    좌표를 판 시작에 한 번 주면 §4.3 ③ "도망자는 탈출구 위치를 모른다" 가 무너진다
    (클라이언트를 열어보면 끝이다). 그렇다고 아예 안 주면 문 앞에 서도 아무것도 안 보인다.
    그래서 **보이는 순간에만** 준다 — 심장박동이 말하던 것의 답이 눈으로 확인되는 지점이다. */
export interface SeenExit {
  x: number;
  y: number;
  /** 칸 거리 1~4 */
  d: number;
}

/** 술래가 받는 발소리 힌트. 좌표는 없다 — 그게 §4.3 ② 다. */
export interface SoundHint {
  /** 내가 보는 방향 기준 상대각(rad). 0 = 정면 */
  bearing: number;
  /** 칸 거리 */
  d: number;
}

/** viewFor() 의 결과. 사람마다 다르다. */
export interface PlayerView {
  phase: Phase;
  /** 현재 단계가 끝나기까지 남은 ms */
  msLeft: number;
  winner: Winner | null;
  endReason: string | null;
  me: MeView;
  /** 살아서 아직 탈출하지 않은 도망자 수 */
  alive: number;
  /** 전체 도망자 수 */
  total: number;
  seen: SeenPlayer[];
  hints: SoundHint[];
  /**
   * 도망자에게만 내려간다. 탈출구까지의 **칸 수**이고 좌표가 아니다 (§4.3 ③).
   * 술래에게는 아예 없다(undefined) — 설계 단계(S4)가 없어 술래도 미로를 처음 본다.
   */
  exitDist?: number | null;
  /** 탈출구가 지금 눈에 보일 때만. 안 보이면 없다(undefined) — 위 SeenExit 참조. */
  exitSeen?: SeenExit | null;
  /** 서버는 'maze' 메시지로 따로 보낸다. state 에는 싣지 않는다(대역폭). */
  grid?: never;
}

/* ── 이벤트 ── */
export type GameEvent =
  | { t: 'phase'; phase: Phase; endsAt: number }
  | { t: 'move'; id: string; role: Role; x: number; y: number }
  | { t: 'caught'; id: string; name: string }
  | { t: 'escape'; id: string; name: string }
  | { t: 'over'; winner: Winner; reason: string };

/* ── 로비 ── */
export interface LobbyPlayer {
  id: string;
  name: string;
  role: Role;
  alive: boolean;
  escaped: boolean;
  connected: boolean;
}
export interface LobbyInfo {
  players: LobbyPlayer[];
  canStart: boolean;
  max: number;
  code: string | null;
  allowFaces: boolean;
}

/* ── 메시지 ──────────────────────────────────────
   Colyseus 의 client.send(type, payload) 에서 type 은 아래 키,
   payload 는 그 값이다. 서버·클라가 같은 표를 본다. */

/** 서버 → 클라이언트 */
export interface ServerMessages {
  /** 입장 직후 한 번. 이 방이 어떤 방인지 */
  room: { code: string | null; isPrivate: boolean; allowFaces: boolean; max: number };
  /** 판마다 한 번. 매 틱 보내면 그것만으로 트래픽의 42% 였다 */
  maze: { grid: Grid; w: number; h: number; seed: number };
  state: { view: PlayerView; events: GameEvent[]; lobby: LobbyInfo; denied?: string };
  /** 같은 방 사람의 얼굴 스냅샷 (§4.4 · §7). 비공개 방에서만 오간다 */
  face: { id: string; data: string };
  /** 그 사람이 철회했거나 방을 나갔다 — 즉시 지운다 (§7-4) */
  faceGone: { id: string };
  faceOk: Record<string, never>;
  faceOff: Record<string, never>;
  error: { reason: string };
}

/** 클라이언트 → 서버 */
export interface ClientMessages {
  input: { a: Action };
  start: void;
  /** 동의 버튼을 눌렀을 때만. jpeg data URL 한 장 */
  face: { data: string };
  faceOff: Record<string, never>;
}

/** 방에 들어갈 때 주는 것. code 는 항상 보낸다 —
    빼면 매치메이킹이 코드 있는 방까지 후보로 잡는다. */
export interface JoinOptions {
  name: string;
  /** 공개 매칭은 빈 문자열, 비공개 방은 4~8자 코드 */
  code: string;
}

/* ── 규칙 상수 (양쪽이 같은 값을 봐야 하는 것) ── */

/** §4.3 ① A안 — 같은 속도면 거리가 안 좁혀져 술래가 못 잡는다 */
export const COOLDOWN: Record<Role, number> = { it: 320, runner: 400 };
/** §2.3 — 정면 4칸을 넘으면 보이지 않는다 */
export const SIGHT_CELLS = 4;
/** §2.3 contact — 1칸 거리에서 즉사 */
export const CAPTURE_CELLS = 1;
/** §4.1 인원. 술래 수는 IT_COUNT 가 정한다 */
export const MAX_PLAYERS = 6;
/** 미로 크기. **홀수여야 한다** — generate() 가 짝수를 받으면 +1 해서 올린다(벽/통로 교대).
    33×33 = 통로 530칸, 탈출구까지 평균 102칸(최단 주파 41초).
    서버 기본값이자 솔로가 만드는 미로다 — 양쪽이 달라지지 않게 여기 둔다. */
export const MAZE_W = 33;
export const MAZE_H = 33;
/** 3인 이하 1명, 4인 이상 2명 */
export const IT_COUNT = (n: number): number => (n >= 4 ? 2 : 1);
/** 방 코드 형식 */
export const CODE_RE = /^[A-Z0-9]{4,8}$/;
