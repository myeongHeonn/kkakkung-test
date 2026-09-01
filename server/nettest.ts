/* 소켓 통합 검증 —  node server/nettest.ts
   진짜 서버(serve.ts)를 띄우고 Colyseus 클라이언트로 붙어 한 판 돌린다.
   rules.ts 단위 테스트가 못 잡는 것 — 방 매칭·코드·얼굴 정책·재접속·직렬화 — 이 대상이다. */

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import * as Colyseus from 'colyseus.js';
import type {
  Action, GameEvent, JoinOptions, LobbyInfo, PlayerView, ServerMessages,
} from '../shared/protocol.ts';

/* 테스트가 들고 있는 '한 사람'. 서버가 보내는 메시지 타입(ServerMessages)을
   그대로 참조하므로, 서버에서 필드를 바꾸면 여기서 컴파일이 깨진다. */
interface Peer {
  name: string;
  client: Colyseus.Client;
  room: Colyseus.Room;
  id: string;
  faces: Map<string, string>;
  events: GameEvent[];
  denied: string[];
  err: string | null;
  mazeCount: number;
  info?: ServerMessages['room'];
  maze?: ServerMessages['maze'];
  last?: PlayerView;
  lobby?: LobbyInfo;
  faceOk?: boolean;
  faceOff?: boolean;
}

const PORT = 5299;
const ENDPOINT = `ws://127.0.0.1:${PORT}`;
const ROOT = path.join(import.meta.dirname, '..');
let pass = 0, fail = 0;
const ok = (c: unknown, label: string) => { c ? pass++ : (fail++, console.log('  ✗ ' + label)); };
const eq = (a: unknown, b: unknown, label: string) => ok(a === b, `${label} — 기대 ${b}, 실제 ${JSON.stringify(a)}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function waitPort(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    (function poll(){
      http.get({ port:PORT, path:'/' }, res => { res.resume(); resolve(); })
        .on('error', () => Date.now() - t0 > 20000 ? reject(new Error('서버가 안 뜬다')) : setTimeout(poll, 200));
    })();
  });
}

// 플레이어 한 명 — 받은 것을 전부 들고 있는다
async function player(name: string, opt: Partial<JoinOptions> = {}): Promise<Peer> {
  const client = new Colyseus.Client(ENDPOINT);
  const room = await client.joinOrCreate('kkakkung', { name, code:'', ...opt });
  const c: Peer = { name, client, room, id: room.sessionId, faces:new Map<string,string>(),
                    events:[], denied:[], err:null, mazeCount:0 };
  c.room.onMessage('room', (m: ServerMessages['room']) => c.info = m);
  c.room.onMessage('maze', (m: ServerMessages['maze']) => { c.maze = m; c.mazeCount++; });
  c.room.onMessage('state', (m: ServerMessages['state']) => {
    c.last = m.view; c.lobby = m.lobby;
    if(m.events && m.events.length) c.events.push(...m.events);
    if(m.denied) c.denied.push(m.denied);
  });
  c.room.onMessage('face', (m: ServerMessages['face']) => c.faces.set(m.id, m.data));
  c.room.onMessage('faceGone', (m: ServerMessages['faceGone']) => c.faces.delete(m.id));
  c.room.onMessage('faceOk', () => c.faceOk = true);
  c.room.onMessage('faceOff', () => c.faceOff = true);
  c.room.onMessage('error', (m: ServerMessages['error']) => c.err = m.reason);
  return c;
}
/* 메시지가 실제로 도착했는지 단언한다.
   안 왔는데 조용히 통과하는 것보다 여기서 터지는 게 낫다. */
const must = <T,>(v: T | undefined | null, what: string): T => {
  if(v == null) throw new Error(what + ' 이(가) 없다');
  return v;
};
const got = <K extends 'info' | 'maze' | 'lobby' | 'last'>(c: Peer, k: K): NonNullable<Peer[K]> => {
  const v = c[k];
  if(v == null) throw new Error(c.name + ': ' + k + ' 메시지를 못 받았다');
  return v as NonNullable<Peer[K]>;
};
const act = (c: Peer, a: Action) => c.room.send('input', { a });

(async () => {
  const srv = spawn(process.execPath, ['serve.ts', String(PORT)], { cwd: ROOT });
  let out = '';
  srv.stdout.on('data', d => out += d);
  srv.stderr.on('data', d => out += d);

  try{
    await waitPort();
    /* 포트는 기동 메시지보다 먼저 열린다 (gameServer.listen 안에서 server.listen 이 먼저 돈다).
       고정 시간으로 기다리면 느린 기계에서 깜빡인다 — 메시지 자체를 기다린다. */
    for(let i = 0; i < 50 && !/멀티플레이: 켜짐/.test(out); i++) await sleep(100);
    ok(/멀티플레이: 켜짐 — Colyseus/.test(out), 'Colyseus 로 뜬다');

    console.log('\n비공개 방 — 코드로 묶인다');
    const A = await player('가', { code:'TEST' });
    const B = await player('나', { code:'TEST' });
    await sleep(400);
    eq(A.room.roomId, B.room.roomId, '같은 코드면 같은 방');
    eq(got(A, 'info').code, 'TEST', '방 코드를 알려준다');
    ok(got(A, 'info').isPrivate, '코드가 있으면 비공개 방');
    ok(got(A, 'info').allowFaces, '비공개 방은 얼굴 공유 허용');
    eq(got(A, 'lobby').players.length, 2, '로비에 2명');

    const other = await player('딴사람', { code:'OTHER' });
    ok(other.room.roomId !== A.room.roomId, '코드가 다르면 다른 방');
    await other.room.leave();

    console.log('\n공개 방 — 얼굴 공유 금지');
    const P1 = await player('공개1');
    const P2 = await player('공개2');
    await sleep(400);
    eq(P1.room.roomId, P2.room.roomId, '코드 없는 사람끼리 매칭된다');
    ok(P1.room.roomId !== A.room.roomId, '공개 방은 비공개 방과 분리된다');
    ok(!got(P1, 'info').allowFaces, '공개 방은 얼굴 공유 금지');
    P1.room.send('face', { data:'data:image/jpeg;base64,' + 'A'.repeat(100) });
    await sleep(350);
    ok(/공개 방/.test(P1.err || ''), '공개 방에서 얼굴을 보내면 거부한다');
    ok(!P2.faces.has(P1.id), '다른 사람에게도 안 간다');
    await P1.room.leave(); await P2.room.leave();

    console.log('\n미로는 한 번만 보낸다');
    ok(A.maze && Array.isArray(got(A, 'maze').grid), '입장 시 미로를 받는다');
    ok(got(A, 'maze').grid.length >= 19, '19행 이상');
    ok(A.last && got(A, 'last').grid === undefined, 'state 에는 미로가 실리지 않는다');
    const mazeBefore = A.mazeCount;

    console.log('\n얼굴 — 비공개 방 (§4.4 · §7)');
    // 256×256 JPEG(q0.7) 한 장이 대략 이 정도다. 400자짜리로는 전송 계층 한도를 못 넘어
    // 문제를 못 잡는다 — 실제로 겪은 버그다(maxPayload 기본 4KB → code 1009).
    const JPEG = 'data:image/jpeg;base64,' + '/9j/4AAQSkZJRgABAQEA'.repeat(1000);   // 약 20KB
    A.room.send('face', { data:JPEG });
    await sleep(400);
    ok(A.faceOk, '등록 확인을 받는다');
    ok(B.faces.get(A.id) === JPEG, '같은 방 사람에게 전달된다');
    ok(!A.faces.has(A.id), '자기 얼굴은 되돌아오지 않는다');
    ok(JPEG.length > 4096, '전송 계층 기본 한도(4KB)를 넘는 크기로 시험한다');
    ok(A.room.connection.isOpen, '큰 얼굴을 보내도 연결이 살아 있다');

    A.room.send('face', { data:'data:text/html,<script>' });
    await sleep(300);
    ok(/형식/.test(A.err || ''), 'jpeg 가 아니면 거부');
    A.err = null;

    // 한도를 넘으면 '연결이 끊기는' 게 아니라 '거부' 여야 한다. 끊기면 이유를 알 수 없다.
    A.room.send('face', { data:'data:image/jpeg;base64,' + 'A'.repeat(85_000) });
    await sleep(400);
    ok(/크다/.test(A.err || ''), '한도를 넘으면 거부한다');
    ok(A.room.connection.isOpen, '거부돼도 연결은 유지된다');
    A.err = null;

    const C = await player('다', { code:'TEST' });
    await sleep(450);
    ok(C.faces.get(A.id) === JPEG, '나중에 온 사람도 기존 얼굴을 받는다');

    console.log('\n로비 워밍업 이동');
    const d0 = got(A, 'last').me.dir;
    act(A, 'left'); await sleep(350);
    ok(got(A, 'last').me.dir !== d0, '시작 전에도 움직일 수 있다');
    ok(!A.denied.includes('지금은 움직일 수 없다'), '로비 이동이 거부되지 않는다');

    console.log('\n시작 · 역할 · 정보 비대칭');
    const D = await player('라', { code:'TEST' });
    await sleep(450);
    eq(got(A, 'lobby').players.length, 4, '4명');
    A.room.send('start');
    await sleep(600);
    const all = [A, B, C, D];
    eq(got(A, 'last').phase, 'infiltrate', '잠입 단계');
    eq(all.filter(p => got(p, 'last').me.role === 'it').length, 2, '4인이면 술래 2명');
    ok(A.mazeCount > mazeBefore, '새 판이면 미로를 다시 보낸다');

    const it = must(all.find(p => got(p, 'last').me.role === 'it'), '술래');
    const run = all.filter(p => got(p, 'last').me.role === 'runner');
    const run0 = must(run[0], '도망자');
    ok(typeof got(run0, 'last').exitDist === 'number', '도망자는 탈출구 거리감을 받는다');
    ok(got(it, 'last').exitDist === undefined, '술래는 탈출구 신호를 못 받는다');

    /* 좌표가 안 실렸는지는 이제 두 겹으로 막힌다.
       PlayerView·SoundHint 타입에 x/y 가 아예 없어서 코드로 넣으려 하면 컴파일이 깨지고,
       그래도 런타임에 새어 나올 수 있으니 직렬화된 패킷을 직접 확인한다. */
    const runBlob = JSON.stringify(got(run0, 'last'));
    ok(!runBlob.includes('"exit"'), '도망자 패킷에 탈출구 좌표가 없다');
    const itBlob = JSON.stringify(got(it, 'last').hints);
    ok(!/"x"|"y"/.test(itBlob), '술래 힌트 패킷에 좌표가 없다');

    console.log('\n쿨다운 · 잠입 규칙');
    act(it, 'left'); await sleep(350);
    ok(it.denied.includes('지금은 움직일 수 없다'), '술래는 잠입 중 못 움직인다');
    await sleep(500);
    const rd = got(run0, 'last').me.dir;
    act(run0, 'left'); act(run0, 'left'); act(run0, 'left');
    await sleep(400);
    eq(got(run0, 'last').me.dir, (rd + 3) % 4, '연타해도 한 번만 먹는다');
    ok(run0.denied.includes('쿨다운'), '나머지는 쿨다운으로 거부');

    console.log('\n추격 단계 · 난타');
    await sleep(10_000);
    eq(got(A, 'last').phase, 'chase', '10초 뒤 추격');
    const acts: Action[] = ['forward','back','left','right'];
    for(let i=0;i<80;i++){ for(const p of all) act(p, acts[(Math.random()*4)|0]!); await sleep(25); }
    const g = got(A, 'maze').grid;
    ok(all.every(p => g[got(p, 'last').me.y]?.[got(p, 'last').me.x] !== '#'), '아무도 벽 안에 있지 않다');

    console.log('\n재접속 — 끊겨도 판이 유지되는가');
    const token = D.room.reconnectionToken;
    ok(!!token, '재접속 토큰을 받는다');
    const before = { x:got(D, 'last').me.x, y:got(D, 'last').me.y, role:got(D, 'last').me.role };
    await D.room.leave(false);                       // 의도치 않은 끊김처럼
    await sleep(600);
    eq(got(A, 'lobby').players.length, 4, '유예 중에는 자리가 남아 있다');
    // 콜백 안의 대입은 TS 의 흐름 분석이 못 본다. let 으로 두면 아래에서 계속 null 로 좁혀지므로
    // 객체에 담아 프로퍼티로 읽는다.
    const rj: { view: PlayerView | null } = { view: null };
    const back = await D.client.reconnect(token);
    back.onMessage('state', (m: ServerMessages['state']) => { rj.view = m.view; });
    await sleep(700);
    ok(rj.view, '재접속 후 상태를 다시 받는다');
    if(rj.view){
      eq(rj.view.me.role, before.role, '역할이 유지된다');
      eq(rj.view.me.x, before.x, '위치도 유지된다');
    }
    await back.leave();

    console.log('\n퇴장 · 얼굴 폐기');
    await A.room.leave(); await sleep(500);
    ok(!B.faces.has(A.id), '§7-4 방을 나가면 얼굴이 즉시 폐기된다');
    await C.room.leave(); await sleep(500);
    eq(got(B, 'last').phase, 'lobby', '인원이 부족하면 로비로 되돌아간다');
    await B.room.leave();
  }catch(e){
    fail++;
    const err = e as Error | undefined;
    console.log('  ✗ 예외: ' + (err?.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(e)));
  }finally{
    srv.kill();
    await sleep(300);
  }

  console.log(`\n${fail ? '✗ 실패 ' + fail + '건' : '✔ 전부 통과'} (${pass}건 검사)`);
  process.exit(fail ? 1 : 0);
})();
