/* Colyseus 방 — 전송 계층. 판정은 전부 rules.ts 가 한다.

   ⚠️ Colyseus 의 Schema 상태 동기화를 쓰지 않는다.
   Schema 는 '한 방 상태를 전원에게' 모델인데, 이 게임의 규칙은 §4.3 ②③ —
   사람마다 볼 수 있는 게 다르다(술래는 도망자 좌표를 모르고, 도망자는 탈출구를 모른다).
   그래서 viewFor() 로 1인분씩 만들어 client.send() 로 보낸다.
   Colyseus 는 방·매치메이킹·생명주기·재접속만 맡는다.

   방 두 종류:
     · 공개  — code 없이(빈 문자열) joinOrCreate. 모르는 사람과 매칭된다. 얼굴 공유 금지
     · 비공개 — code 를 들고 joinOrCreate. filterBy 가 같은 코드끼리 묶는다. 얼굴 공유 허용 */

import colyseus from 'colyseus';
import * as R from './rules.ts';
import {
  MAX_PLAYERS, CODE_RE,
  type ClientMessages, type GameEvent, type JoinOptions,
  type LobbyInfo, type ServerMessages,
} from '../shared/protocol.ts';

const { Room } = colyseus;
type Client = colyseus.Client;

const TICK_MS = 100;
const RECONNECT_SEC = 30;           // 와이파이가 끊겨도 이 안에 돌아오면 판이 유지된다
const FACE_MAX = 80_000;            // 약 60KB. 256px JPEG 한 장이면 충분하다
const FACE_PREFIX = 'data:image/jpeg;base64,';

export function normCode(c: unknown): string | null {
  if(typeof c !== 'string') return null;
  const up = c.trim().toUpperCase();
  return CODE_RE.test(up) ? up : null;
}

export class KkakkungRoom extends Room {
  code: string | null = null;
  isPrivate = false;
  allowFaces = false;
  game!: R.Game;
  faces!: Map<string, string>;      // sessionId → data URL. 메모리에만 (§7-2)
  previousIts: string[] = [];

  /** 타입이 붙은 send — 오타나 모양이 어긋나면 컴파일이 깨진다 */
  private tell<K extends keyof ServerMessages>(c: Client, type: K, payload: ServerMessages[K]): void {
    c.send(type as string, payload);
  }
  private tellAll<K extends keyof ServerMessages>(type: K, payload: ServerMessages[K], except?: Client): void {
    this.broadcast(type as string, payload, except ? { except } : undefined);
  }

  override onCreate(options: Partial<JoinOptions> = {}): void {
    this.maxClients = MAX_PLAYERS;
    this.code = normCode(options.code);
    this.isPrivate = !!this.code;

    /* 얼굴은 비공개 방에서만 오간다.
       공개 매칭은 모르는 사람과 묶이는데, 거기까지 얼굴을 보내는 건
       §7 이 전제한 "같은 방 참가자" 의 범위를 넘는다. */
    this.allowFaces = this.isPrivate;

    this.game = R.createGame({});
    this.faces = new Map<string, string>();

    /* 메타데이터에 코드를 넣지 않는다 — getAvailableRooms 로 코드가 새어 나간다.
       setPrivate(true) 도 쓰지 않는다. 그걸 켜면 매치메이킹에서 방이 통째로 빠져
       같은 코드를 든 사람조차 못 들어온다 (filterBy 가 그 방을 못 찾는다).
       대신 onAuth 에서 코드를 검사한다 — roomId 를 알아내 joinById 로 우회해도 거기서 막힌다. */
    this.setMetadata({ isPrivate: this.isPrivate, players: 0 });

    this.onMessage('start', (client: Client) => this.onStart(client));
    this.onMessage('input', (client: Client, m: ClientMessages['input']) => this.onInput(client, m));
    this.onMessage('face', (client: Client, m: ClientMessages['face']) => this.onFace(client, m));
    this.onMessage('faceOff', (client: Client) => this.onFaceOff(client));

    this.setSimulationInterval(() => this.tick(), TICK_MS);
  }

  /* 방 코드 검문. filterBy 는 매치메이킹만 가르므로 roomId 를 알아낸 사람이
     joinById 로 곧장 들어오는 경로가 남는다. 얼굴이 오가는 방이라 여기서 막는다. */
  override onAuth(_client: Client, options: Partial<JoinOptions> = {}): boolean {
    const given = normCode(options.code);
    if(this.code && given !== this.code) throw new Error('방 코드가 맞지 않다');
    if(!this.code && given) throw new Error('공개 방에는 코드로 들어올 수 없다');
    return true;
  }

  override onJoin(client: Client, options: Partial<JoinOptions> = {}): void {
    R.addPlayer(this.game, client.sessionId, options.name);
    this.setMetadata({ isPrivate: this.isPrivate, players: this.game.players.size });
    this.tell(client, 'room', {
      code: this.code, isPrivate: this.isPrivate,
      allowFaces: this.allowFaces, max: MAX_PLAYERS,
    });
    this.sendMaze(client);
    this.sendKnownFaces(client);
    this.pushState();
  }

  /* 끊겨도 바로 지우지 않는다. 30초 안에 돌아오면 그 자리를 그대로 돌려준다.
     서버를 재시작하거나 와이파이가 잠깐 끊겼다고 판이 날아가면 안 된다. */
  override async onLeave(client: Client, consented?: boolean | number): Promise<void> {
    // 런타임은 boolean 을 넘긴다 — @colyseus/core Room.js 가
    //   this.onLeave(client, code === Protocol.WS_CLOSE_CONSENTED)
    // 로 부른다. 타입 선언이 number 까지 넓게 잡혀 있어 둘 다 받고 명시적으로 좁힌다.
    const intentional = consented === true;
    const p = this.game.players.get(client.sessionId);
    if(p) p.connected = false;
    if(!intentional){
      try{
        await this.allowReconnection(client, RECONNECT_SEC);
        const back = this.game.players.get(client.sessionId);
        if(back) back.connected = true;
        this.sendMaze(client);
        this.sendKnownFaces(client);
        this.pushState();
        return;
      }catch{ /* 시간 안에 안 돌아왔다 */ }
    }
    this.dropPlayer(client.sessionId);
  }

  private sendKnownFaces(client: Client): void {
    if(!this.allowFaces) return;
    // 먼저 와 있던 사람들의 얼굴 (§7 — 같은 방 안에서만)
    for(const [id, data] of this.faces)
      if(id !== client.sessionId) this.tell(client, 'face', { id, data });
  }

  private dropPlayer(id: string): void {
    R.removePlayer(this.game, id);
    // §7-4 방을 떠나면 즉시 폐기하고 남은 사람들에게도 지우라고 알린다
    if(this.faces.delete(id)) this.tellAll('faceGone', { id });
    if(this.game.phase !== 'lobby' && this.game.players.size < 2){
      this.game.phase = 'lobby';
      this.game.winner = null;
      this.game.endReason = '인원 부족으로 중단';
    }
    this.pushState();
  }

  override onDispose(): void { this.faces.clear(); }   // 방이 사라지면 얼굴도 사라진다 (§7-4)

  /* ── 메시지 ── */
  private onStart(client: Client): void {
    if(this.game.phase === 'over') this.restart();
    const r = R.start(this.game, Date.now(), this.previousIts);
    if(!r.ok) return this.tell(client, 'error', { reason: r.reason ?? '시작할 수 없다' });
    this.sendMaze();
    this.pushState(R.drain(this.game));
  }

  private onInput(client: Client, m: ClientMessages['input']): void {
    const r = R.input(this.game, client.sessionId, m?.a, Date.now());
    const ev = R.drain(this.game);
    if(!r.ok && !ev.length) return this.sendState(client, [], r.reason);
    this.pushState(ev);
  }

  private onFace(client: Client, m: ClientMessages['face']): void {
    if(!this.allowFaces)
      return this.tell(client, 'error',
        { reason: '공개 방에서는 얼굴을 공유하지 않는다. 방 코드로 만든 방에서만 된다' });
    const d = m?.data;
    if(typeof d !== 'string' || !d.startsWith(FACE_PREFIX) || d.length > FACE_MAX)
      return this.tell(client, 'error', { reason: '얼굴 데이터 형식이 아니거나 너무 크다' });
    this.faces.set(client.sessionId, d);
    this.tellAll('face', { id: client.sessionId, data: d }, client);
    this.tell(client, 'faceOk', {});
  }

  private onFaceOff(client: Client): void {
    this.faces.delete(client.sessionId);
    this.tellAll('faceGone', { id: client.sessionId }, client);
    this.tell(client, 'faceOff', {});
  }

  /* ── 새 판 ── */
  private restart(): void {
    this.previousIts = R.theIts(this.game).map(p => p.id);   // §4.3 ② 역할 교대
    const names = R.list(this.game).map(p => ({ id: p.id, name: p.name }));
    this.game = R.createGame({ seed: (Math.random()*0xFFFFFFFF) >>> 0 });
    for(const n of names) R.addPlayer(this.game, n.id, n.name);
  }

  /* ── 전송 ──
     미로는 판마다 한 번만 보낸다. 매 틱 실어 보내면 그것만으로 트래픽의 42% 였다.
     방 100개를 동시에 굴리면 이게 곧 EC2 아웃바운드 요금이 된다. */
  private sendMaze(target?: Client): void {
    const msg: ServerMessages['maze'] =
      { grid: this.game.grid, w: this.game.w, h: this.game.h, seed: this.game.seed };
    if(target) this.tell(target, 'maze', msg); else this.tellAll('maze', msg);
  }

  private lobby(): LobbyInfo {
    return {
      players: R.list(this.game).map(R.lobbyPlayer),
      canStart: this.game.players.size >= 2 &&
                (this.game.phase === 'lobby' || this.game.phase === 'over'),
      max: MAX_PLAYERS, code: this.code, allowFaces: this.allowFaces,
    };
  }

  private sendState(client: Client, events: GameEvent[], denied?: string): void {
    const view = R.viewFor(this.game, client.sessionId, Date.now());
    if(!view) return;
    const msg: ServerMessages['state'] = { view, events, lobby: this.lobby() };
    if(denied) msg.denied = denied;
    this.tell(client, 'state', msg);
  }

  /** 사람마다 볼 수 있는 게 다르므로 방송이 아니라 1인분씩 만든다 (§4.3 ②③) */
  private pushState(events: GameEvent[] = []): void {
    for(const client of this.clients) this.sendState(client, events);
  }

  private tick(): void {
    const events = R.tick(this.game, Date.now());
    if(events.length) this.pushState(events);
    else if(this.game.phase === 'infiltrate' || this.game.phase === 'chase') this.pushState();
  }
}

export { MAX_PLAYERS, RECONNECT_SEC, CODE_RE };
