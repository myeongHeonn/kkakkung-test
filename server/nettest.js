/* 소켓 통합 검증 —  node server/nettest.js
   진짜 서버(serve.js)를 띄우고 Colyseus 클라이언트로 붙어 한 판 돌린다.
   rules.js 단위 테스트가 못 잡는 것 — 방 매칭·코드·얼굴 정책·재접속·직렬화 — 이 대상이다. */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const Colyseus = require('colyseus.js');

const PORT = 5299;
const ENDPOINT = `ws://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, label) => { c ? pass++ : (fail++, console.log('  ✗ ' + label)); };
const eq = (a, b, label) => ok(a === b, `${label} — 기대 ${b}, 실제 ${JSON.stringify(a)}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function waitPort(){
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll(){
      http.get({ port:PORT, path:'/spike-play.html' }, res => { res.resume(); resolve(); })
        .on('error', () => Date.now() - t0 > 20000 ? reject(new Error('서버가 안 뜬다')) : setTimeout(poll, 200));
    })();
  });
}

// 플레이어 한 명 — 받은 것을 전부 들고 있는다
async function player(name, opt = {}){
  const c = { name, client:new Colyseus.Client(ENDPOINT), faces:new Map(),
              events:[], denied:[], err:null, mazeCount:0 };
  c.room = await c.client.joinOrCreate('kkakkung', { name, code:'', ...opt });
  c.id = c.room.sessionId;
  c.room.onMessage('room', m => c.info = m);
  c.room.onMessage('maze', m => { c.maze = m; c.mazeCount++; });
  c.room.onMessage('state', m => {
    c.last = m.view; c.lobby = m.lobby;
    if(m.events && m.events.length) c.events.push(...m.events);
    if(m.denied) c.denied.push(m.denied);
  });
  c.room.onMessage('face', m => c.faces.set(m.id, m.data));
  c.room.onMessage('faceGone', m => c.faces.delete(m.id));
  c.room.onMessage('faceOk', () => c.faceOk = true);
  c.room.onMessage('faceOff', () => c.faceOff = true);
  c.room.onMessage('error', m => c.err = m.reason);
  return c;
}
const act = (c, a) => c.room.send('input', { a });

(async () => {
  const srv = spawn(process.execPath, ['serve.js', String(PORT)], { cwd: ROOT });
  let out = '';
  srv.stdout.on('data', d => out += d);
  srv.stderr.on('data', d => out += d);

  try{
    await waitPort();
    await sleep(500);
    ok(/멀티플레이: 켜짐 — Colyseus/.test(out), 'Colyseus 로 뜬다');

    console.log('\n비공개 방 — 코드로 묶인다');
    const A = await player('가', { code:'TEST' });
    const B = await player('나', { code:'TEST' });
    await sleep(400);
    eq(A.room.roomId, B.room.roomId, '같은 코드면 같은 방');
    eq(A.info.code, 'TEST', '방 코드를 알려준다');
    ok(A.info.isPrivate, '코드가 있으면 비공개 방');
    ok(A.info.allowFaces, '비공개 방은 얼굴 공유 허용');
    eq(A.lobby.players.length, 2, '로비에 2명');

    const other = await player('딴사람', { code:'OTHER' });
    ok(other.room.roomId !== A.room.roomId, '코드가 다르면 다른 방');
    await other.room.leave();

    console.log('\n공개 방 — 얼굴 공유 금지');
    const P1 = await player('공개1');
    const P2 = await player('공개2');
    await sleep(400);
    eq(P1.room.roomId, P2.room.roomId, '코드 없는 사람끼리 매칭된다');
    ok(P1.room.roomId !== A.room.roomId, '공개 방은 비공개 방과 분리된다');
    ok(!P1.info.allowFaces, '공개 방은 얼굴 공유 금지');
    P1.room.send('face', { data:'data:image/jpeg;base64,' + 'A'.repeat(100) });
    await sleep(350);
    ok(/공개 방/.test(P1.err || ''), '공개 방에서 얼굴을 보내면 거부한다');
    ok(!P2.faces.has(P1.id), '다른 사람에게도 안 간다');
    await P1.room.leave(); await P2.room.leave();

    console.log('\n미로는 한 번만 보낸다');
    ok(A.maze && Array.isArray(A.maze.grid), '입장 시 미로를 받는다');
    ok(A.maze.grid.length >= 19, '19행 이상');
    ok(A.last && A.last.grid === undefined, 'state 에는 미로가 실리지 않는다');
    const mazeBefore = A.mazeCount;

    console.log('\n얼굴 — 비공개 방 (§4.4 · §7)');
    const JPEG = 'data:image/jpeg;base64,' + '/9j/4AAQSkZJRgABAQEA'.repeat(20);
    A.room.send('face', { data:JPEG });
    await sleep(400);
    ok(A.faceOk, '등록 확인을 받는다');
    ok(B.faces.get(A.id) === JPEG, '같은 방 사람에게 전달된다');
    ok(!A.faces.has(A.id), '자기 얼굴은 되돌아오지 않는다');
    A.room.send('face', { data:'data:text/html,<script>' });
    await sleep(300);
    ok(/형식/.test(A.err || ''), 'jpeg 가 아니면 거부');
    A.err = null;

    const C = await player('다', { code:'TEST' });
    await sleep(450);
    ok(C.faces.get(A.id) === JPEG, '나중에 온 사람도 기존 얼굴을 받는다');

    console.log('\n로비 워밍업 이동');
    const d0 = A.last.me.dir;
    act(A, 'left'); await sleep(350);
    ok(A.last.me.dir !== d0, '시작 전에도 움직일 수 있다');
    ok(!A.denied.includes('지금은 움직일 수 없다'), '로비 이동이 거부되지 않는다');

    console.log('\n시작 · 역할 · 정보 비대칭');
    const D = await player('라', { code:'TEST' });
    await sleep(450);
    eq(A.lobby.players.length, 4, '4명');
    A.room.send('start');
    await sleep(600);
    const all = [A, B, C, D];
    eq(A.last.phase, 'infiltrate', '잠입 단계');
    eq(all.filter(c => c.last.me.role === 'it').length, 2, '4인이면 술래 2명');
    ok(A.mazeCount > mazeBefore, '새 판이면 미로를 다시 보낸다');

    const it = all.find(c => c.last.me.role === 'it');
    const run = all.filter(c => c.last.me.role === 'runner');
    ok(typeof run[0].last.exitDist === 'number', '도망자는 탈출구 거리감을 받는다');
    ok(it.last.exitDist === undefined, '술래는 탈출구 신호를 못 받는다');
    ok(!JSON.stringify(run[0].last).includes('"exit"'), '도망자 패킷에 탈출구 좌표가 없다');
    ok(it.last.hints.every(h => h.x === undefined), '술래 힌트에 좌표가 없다');

    console.log('\n쿨다운 · 잠입 규칙');
    act(it, 'left'); await sleep(350);
    ok(it.denied.includes('지금은 움직일 수 없다'), '술래는 잠입 중 못 움직인다');
    await sleep(500);
    const rd = run[0].last.me.dir;
    act(run[0], 'left'); act(run[0], 'left'); act(run[0], 'left');
    await sleep(400);
    eq(run[0].last.me.dir, (rd + 3) % 4, '연타해도 한 번만 먹는다');
    ok(run[0].denied.includes('쿨다운'), '나머지는 쿨다운으로 거부');

    console.log('\n추격 단계 · 난타');
    await sleep(10_000);
    eq(A.last.phase, 'chase', '10초 뒤 추격');
    const acts = ['forward','back','left','right'];
    for(let i=0;i<80;i++){ for(const c of all) act(c, acts[(Math.random()*4)|0]); await sleep(25); }
    const g = A.maze.grid;
    ok(all.every(c => g[c.last.me.y][c.last.me.x] !== '#'), '아무도 벽 안에 있지 않다');

    console.log('\n재접속 — 끊겨도 판이 유지되는가');
    const token = D.room.reconnectionToken;
    ok(!!token, '재접속 토큰을 받는다');
    const before = { x:D.last.me.x, y:D.last.me.y, role:D.last.me.role };
    await D.room.leave(false);                       // 의도치 않은 끊김처럼
    await sleep(600);
    eq(A.lobby.players.length, 4, '유예 중에는 자리가 남아 있다');
    let rejoined = null;
    const back = await D.client.reconnect(token);
    back.onMessage('state', m => rejoined = m.view);
    await sleep(700);
    ok(rejoined, '재접속 후 상태를 다시 받는다');
    if(rejoined){
      eq(rejoined.me.role, before.role, '역할이 유지된다');
      eq(rejoined.me.x, before.x, '위치도 유지된다');
    }
    await back.leave();

    console.log('\n퇴장 · 얼굴 폐기');
    await A.room.leave(); await sleep(500);
    ok(!B.faces.has(A.id), '§7-4 방을 나가면 얼굴이 즉시 폐기된다');
    await C.room.leave(); await sleep(500);
    eq(B.last.phase, 'lobby', '인원이 부족하면 로비로 되돌아간다');
    await B.room.leave();
  }catch(e){
    fail++; console.log('  ✗ 예외: ' + (e && e.stack ? e.stack.split('\n').slice(0,3).join(' | ') : e));
  }finally{
    srv.kill();
    await sleep(300);
  }

  console.log(`\n${fail ? '✗ 실패 ' + fail + '건' : '✔ 전부 통과'} (${pass}건 검사)`);
  process.exit(fail ? 1 : 0);
})();
