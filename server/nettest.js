/* 소켓 통합 검증 —  node server/nettest.js
   진짜 서버를 띄우고 진짜 WebSocket 3개를 붙여 한 판을 돌린다.
   rules.js 단위 테스트가 못 잡는 것 — serve.js 배선, 직렬화, 연결/해제 — 이 대상이다. */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const PORT = 5299;
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
        .on('error', () => Date.now() - t0 > 15000 ? reject(new Error('서버가 안 뜬다')) : setTimeout(poll, 150));
    })();
  });
}

// 클라이언트 한 명 — 마지막 state 를 들고 있는다
function client(name){
  const c = { name, ws:null, id:null, last:null, events:[], denied:[], faces:new Map() };
  return new Promise((resolve, reject) => {
    const ws = c.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on('error', reject);
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if(m.t === 'welcome'){ c.id = m.id; ws.send(JSON.stringify({ t:'join', name })); resolve(c); }
      else if(m.t === 'state'){ c.last = m.view; c.lobby = m.lobby;
                                if(m.events && m.events.length) c.events.push(...m.events);
                                if(m.denied) c.denied.push(m.denied); }
      else if(m.t === 'error') c.err = m.reason;
      else if(m.t === 'full') c.full = true;
      else if(m.t === 'face') c.faces.set(m.id, m.data);
      else if(m.t === 'faceGone') c.faces.delete(m.id);
      else if(m.t === 'faceOk') c.faceOk = true;
      else if(m.t === 'faceOff') c.faceOff = true;
    });
  });
}
const act = (c, a) => c.ws.send(JSON.stringify({ t:'input', a }));

(async () => {
  const srv = spawn(process.execPath, ['serve.js', String(PORT)], { cwd: ROOT });
  let out = '';
  srv.stdout.on('data', d => out += d);
  srv.stderr.on('data', d => out += d);

  try{
    await waitPort();
    ok(/멀티플레이: 켜짐/.test(out), '서버가 멀티플레이 켜짐으로 뜬다');

    console.log('\n접속 · 로비');
    const A = await client('가');
    const B = await client('나');
    const C = await client('다');
    const D = await client('라');
    await sleep(200);
    ok(A.id && B.id && C.id && A.id !== B.id, '각자 다른 id 를 받는다');
    eq(A.lobby.players.length, 4, '로비에 4명');
    ok(A.lobby.canStart, '2명 이상이면 시작 가능');
    ok(Array.isArray(A.last.grid) && A.last.grid.length > 0, '미로를 받았다');
    ok(A.last.grid.join('') === B.last.grid.join(''), '전원이 같은 미로를 본다');

    eq(A.lobby.max, 6, '최대 6인');
    ok(A.last.grid.length >= 19, '맵이 19행 이상');

    console.log('\n로비 워밍업 이동');
    const lobbyDir = A.last.me.dir;
    act(A, 'left'); await sleep(250);
    ok(A.last.me.dir !== lobbyDir, '시작 전에도 걸어다닐 수 있다');
    ok(!A.denied.includes('지금은 움직일 수 없다'), '로비 이동이 거부되지 않는다');
    await sleep(450);

    console.log('\n얼굴 스냅샷 중계 (§4.4 · §7)');
    const JPEG = 'data:image/jpeg;base64,' + '/9j/4AAQSkZJRgABAQEA'.repeat(20);
    A.ws.send(JSON.stringify({ t:'face', data:JPEG }));
    await sleep(300);
    ok(A.faceOk, '등록한 본인은 확인을 받는다');
    ok(B.faces.get(A.id) === JPEG, '같은 방 사람에게 전달된다');
    ok(C.faces.get(A.id) === JPEG, '방 전원에게 전달된다');
    ok(!A.faces.has(A.id), '자기 얼굴은 자기에게 되돌아오지 않는다');

    A.ws.send(JSON.stringify({ t:'face', data:'data:text/html,<script>' }));
    await sleep(200);
    ok(/형식/.test(A.err || ''), 'jpeg 데이터 URL 이 아니면 거부한다');
    A.err = null;
    A.ws.send(JSON.stringify({ t:'face', data:'data:image/jpeg;base64,' + 'A'.repeat(90_000) }));
    await sleep(200);
    ok(/크다/.test(A.err || ''), '용량 상한을 넘으면 거부한다');
    A.err = null;

    // 늦게 온 사람도 이미 등록된 얼굴을 받아야 한다
    const E = await client('마');
    await sleep(300);
    ok(E.faces.get(A.id) === JPEG, '나중에 들어온 사람도 기존 얼굴을 받는다');

    // 철회 — 언제든 지울 수 있어야 한다 (§7)
    A.ws.send(JSON.stringify({ t:'faceOff' }));
    await sleep(300);
    ok(A.faceOff, '철회 확인을 받는다');
    ok(!B.faces.has(A.id), '철회하면 남들 쪽에서도 지워진다');

    // 다시 등록해두고, 나갈 때 폐기되는지 본다 (§7-4)
    A.ws.send(JSON.stringify({ t:'face', data:JPEG }));
    await sleep(250);
    ok(B.faces.get(A.id) === JPEG, '재등록된다');
    E.ws.close(); await sleep(250);

    console.log('\n시작 · 역할');
    A.ws.send(JSON.stringify({ t:'start' }));
    await sleep(300);
    eq(A.last.phase, 'infiltrate', '잠입 단계로 들어간다');
    const roles = [A, B, C, D].map(c => c.last.me.role);
    eq(roles.filter(r => r === 'it').length, 2, '4인이면 술래 2명');
    eq(roles.filter(r => r === 'runner').length, 2, '도망자 2명');

    const its = [A, B, C, D].filter(c => c.last.me.role === 'it');
    const it = its[0];
    const run = [A, B, C, D].filter(c => c.last.me.role === 'runner');
    ok(its[0].last.me.x !== its[1].last.me.x || its[0].last.me.y !== its[1].last.me.y,
       '두 술래가 다른 곳에서 출발한다');
    ok(run.every(r => r.last.me.x === run[0].last.me.x && r.last.me.y === run[0].last.me.y),
       '도망자들은 같은 지점에서 출발한다');
    ok(it.last.me.x !== run[0].last.me.x || it.last.me.y !== run[0].last.me.y,
       '술래는 다른 지점에서 출발한다');

    console.log('\n정보 비대칭 (§4.3 ②③)');
    ok(typeof run[0].last.exitDist === 'number', '도망자는 탈출구 거리감을 받는다');
    ok(it.last.exitDist === undefined, '술래는 탈출구 신호를 못 받는다');
    const runBlob = JSON.stringify(run[0].last);
    ok(!runBlob.includes('"exit"'), '도망자 패킷에 탈출구 좌표가 없다');
    ok(it.last.seen.length === 0, '멀리 있는 도망자는 술래에게 안 보인다');
    ok(it.last.hints.every(h => h.x === undefined && h.y === undefined),
       '술래가 받는 힌트에 좌표가 없다');

    console.log('\n잠입 단계 이동 규칙');
    const beforeIt = { x: it.last.me.x, y: it.last.me.y, dir: it.last.me.dir };
    act(it, 'left'); await sleep(200);
    eq(it.last.me.dir, beforeIt.dir, '술래는 잠입 중 회전조차 못 한다');
    ok(it.denied.includes('지금은 움직일 수 없다'), '거부 사유가 전달된다');
    act(run[0], 'left'); await sleep(200);
    ok(run[0].last.me.dir !== 1, '도망자는 잠입 중에도 움직인다');

    console.log('\n쿨다운 (서버가 강제한다)');
    await sleep(450);                                // 직전 이동의 쿨다운을 넘긴 뒤에 연타해야 의미가 있다
    const d0 = run[0].last.me.dir;
    act(run[0], 'left'); act(run[0], 'left'); act(run[0], 'left');   // 연타
    await sleep(250);
    eq(run[0].last.me.dir, (d0 + 3) % 4, '연타해도 한 칸(한 번)만 먹는다');
    ok(run[0].denied.includes('쿨다운'), '나머지는 쿨다운으로 거부');

    console.log('\n추격 단계 전환 · 한 판 굴리기');
    await sleep(10_000 - 900 + 500);                 // 잠입 10초가 지나기를 기다린다
    eq(it.last.phase, 'chase', '10초 뒤 추격 단계');
    ok(it.last.msLeft > 0, '남은 시간이 내려온다');

    // 아무렇게나 움직여도 서버가 안 죽는지 (벽·경계·연타 전부 섞어서)
    const acts = ['forward','back','left','right'];
    for(let i=0;i<120;i++){
      for(const c of [A,B,C,D]) act(c, acts[(Math.random()*4)|0]);
      await sleep(25);
    }
    ok([A,B,C,D].every(c => c.ws.readyState === 1), '난타 후에도 연결이 살아 있다');
    ok([A,B,C,D].every(c => c.last.me.x >= 0 && c.last.me.y >= 0), '좌표가 정상 범위');
    const g = A.last.grid;
    ok([A,B,C,D].every(c => g[c.last.me.y][c.last.me.x] !== '#'), '아무도 벽 안에 있지 않다');

    console.log('\n연결 해제');
    D.ws.close(); await sleep(300);
    eq(A.lobby.players.length, 3, '나간 사람은 로비에서 빠진다');
    A.ws.close(); await sleep(300);
    ok(!B.faces.has(A.id), '§7-4 방을 나가면 얼굴이 즉시 폐기된다');
    C.ws.close(); await sleep(400);
    eq(B.last.phase, 'lobby', '인원이 부족해지면 로비로 되돌아간다');
    B.ws.close();
  }catch(e){
    fail++; console.log('  ✗ 예외: ' + (e && e.stack ? e.stack.split('\n')[0] : e));
  }finally{
    srv.kill();
    await sleep(200);
  }

  console.log(`\n${fail ? '✗ 실패 ' + fail + '건' : '✔ 전부 통과'} (${pass}건 검사)`);
  process.exit(fail ? 1 : 0);
})();
