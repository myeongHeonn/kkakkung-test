/* 헤드리스 규칙 검증 —  node server/test.js
   브라우저 없이 돌아가는 부분은 전부 여기서 잡는다.
   특히 마지막 「추격 성립」은 기획서 §4.3 ① 의 미해결 문제에 실측으로 답하는 자리다. */

const M = require('./maze');
const R = require('./rules');

let pass = 0, fail = 0;
const ok = (cond, label) => { cond ? (pass++, 0) : (fail++, console.log('  ✗ ' + label)); };
const eq = (a, b, label) => ok(a === b, `${label} — 기대 ${b}, 실제 ${a}`);
function group(name, fn){ console.log('\n' + name); fn(); }

/* ── 미로 ───────────────────────────────────────── */
group('미로 생성', () => {
  for(const seed of [1, 7, 12345, 0xBEEF]){
    const m = M.generate(13, 13, seed);
    eq(m.w % 2, 1, 'w 홀수');
    eq(m.h % 2, 1, 'h 홀수');
    ok(m.grid[0].split('').every(c => c === '#'), '위쪽 테두리가 벽');
    ok(m.grid.every(r => r[0] === '#' && r[r.length-1] === '#'), '좌우 테두리가 벽');

    // 모든 통로가 서로 이어져 있어야 한다 — 고립된 방이 생기면 게임이 끝난다
    const cs = M.cells(m.grid);
    const d = M.bfs(m.grid, cs[0]);
    ok(cs.every(c => d[c.y][c.x] >= 0), `seed ${seed}: 전 통로 연결`);
  }
  // 같은 시드 = 같은 미로 (방 전원이 같은 걸 봐야 한다)
  ok(JSON.stringify(M.generate(13,13,42).grid) === JSON.stringify(M.generate(13,13,42).grid),
     '같은 시드는 같은 미로');
  ok(JSON.stringify(M.generate(13,13,42).grid) !== JSON.stringify(M.generate(13,13,43).grid),
     '다른 시드는 다른 미로');
});

group('고리 — 막다른 길이 줄어드는가', () => {
  // 완전미로는 술래잡기에서 도망자가 즉사한다. 고리가 실제로 생겼는지 본다.
  let dead = 0, total = 0;
  for(let seed=1; seed<=30; seed++){
    const m = M.generate(13, 13, seed);
    for(const c of M.cells(m.grid)){
      total++;
      if(M.DIRS.filter(d => M.walkable(m.grid, c.x+d.dx, c.y+d.dy)).length === 1) dead++;
    }
  }
  const ratio = dead/total;
  console.log(`  막다른 칸 비율 ${(ratio*100).toFixed(1)}%`);
  ok(ratio < 0.12, `막다른 길이 충분히 줄었다 (${(ratio*100).toFixed(1)}% < 12%)`);
  ok(ratio > 0.005, '전부 트이지는 않았다 (긴장 유지)');
});

group('배치', () => {
  for(let seed=1; seed<=40; seed++){
    const m = M.generate(13, 13, seed);
    const s = M.placeSpawns(m.grid, seed);
    ok(m.grid[s.runnerSpawn.y][s.runnerSpawn.x] !== '#', '도망자 시작점이 통로');
    ok(m.grid[s.exit.y][s.exit.x] !== '#', '탈출구가 통로');
    ok(m.grid[s.itSpawn.y][s.itSpawn.x] !== '#', '술래 시작점이 통로');
    ok(M.reachable(m.grid, s.runnerSpawn, s.exit), '도망자 → 탈출구 경로 존재 (§4.2 절대 규칙)');
    const dR = M.bfs(m.grid, s.runnerSpawn);
    // 술래를 탈출구나 도망자 코앞에 두면 게임이 성립하지 않는다
    ok(dR[s.itSpawn.y][s.itSpawn.x] >= 3, `술래가 도망자에게서 3칸 이상 (seed ${seed})`);
  }
});

group('직선 시야', () => {
  const grid = ['#####', '#...#', '#.#.#', '#...#', '#####'];
  eq(M.lineOfSight(grid, {x:1,y:1}, 1, 4).length, 2, '동쪽 2칸 뒤 벽');
  eq(M.lineOfSight(grid, {x:1,y:1}, 2, 4).length, 2, '남쪽 2칸 뒤 벽');
  eq(M.lineOfSight(grid, {x:1,y:1}, 0, 4).length, 0, '북쪽은 바로 벽');
  eq(M.lineOfSight(grid, {x:1,y:1}, 1, 2).length, 2, '최대 칸수 제한이 걸린다');
});

/* ── 규칙 ───────────────────────────────────────── */
function newGame(seed = 5){
  const g = R.createGame({ seed, w:13, h:13 });
  R.addPlayer(g, 'A', '술래'); R.addPlayer(g, 'B', '도망자1'); R.addPlayer(g, 'C', '도망자2');
  return g;
}
// 역할을 테스트가 정하도록 강제한다 (assignRoles 는 무작위라 단정할 수 없다)
function force(g, itId){
  for(const p of R.list(g)){
    p.role = p.id === itId ? 'it' : 'runner';
    p.alive = true; p.escaped = false; p.nextMoveAt = 0;
    const s = p.role === 'it' ? g.itSpawn : g.runnerSpawn;
    p.x = s.x; p.y = s.y; p.dir = 1;
  }
}

group('기본 설정', () => {
  eq(R.DEFAULTS.w, 19, '맵 가로 19칸');
  eq(R.DEFAULTS.h, 19, '맵 세로 19칸');
  const g = R.createGame({});
  eq(g.grid.length, 19, '실제 생성도 19행');
  ok(M.reachable(g.grid, g.runnerSpawn, g.exit), '넓혀도 탈출 경로는 보장된다');
});

group('로비 워밍업 이동', () => {
  const g = newGame();
  eq(g.phase, 'lobby', '처음엔 로비');
  const b = g.players.get('B'), before = b.dir;
  ok(R.input(g, 'B', 'left', 0).ok, '로비에서 움직일 수 있다');
  eq(b.dir, (before + 3) % 4, '실제로 돌았다');

  // 로비 이동은 어떤 판정도 만들지 않는다 — 겹쳐 서 있어도 아무 일이 없어야 한다
  const a = g.players.get('A');
  a.x = b.x; a.y = b.y; a.role = 'it';
  R.input(g, 'B', 'right', 500);
  ok(b.alive, '로비에서는 겹쳐 있어도 안 잡힌다');
  ok(!g.winner, '로비에서는 승패가 생기지 않는다');

  // 어디로 흩어졌든 시작하면 제자리로 돌아간다 — 그래서 밸런스에 영향이 없다
  R.input(g, 'B', 'forward', 1000);
  R.start(g, 2000);
  ok(R.runners(g).every(r => r.x === g.runnerSpawn.x && r.y === g.runnerSpawn.y),
     '시작 시 도망자 전원이 시작 지점으로 리셋된다');
  const it = R.theIt(g);
  ok(it.x === g.itSpawn.x && it.y === g.itSpawn.y, '술래도 자기 시작 지점으로');
});

group('종료 후에는 못 움직인다', () => {
  const g = newGame(); R.start(g, 0); force(g, 'A');
  g.phase = 'over';
  ok(!R.input(g, 'B', 'left', 0).ok, '결과 화면에서는 이동 불가');
});

group('역할 배정', () => {
  for(let i=0;i<20;i++){
    const g = newGame(i+1);
    R.assignRoles(g);
    eq(R.list(g).filter(p => p.role === 'it').length, 1, '3인이면 술래 1명');
    eq(R.runners(g).length, 2, '나머지는 도망자');
  }
  const g = newGame();
  R.assignRoles(g, ['A']);
  ok(R.theIt(g).id !== 'A', '§4.3 ② 역할 교대 — 직전 술래는 다시 술래가 되지 않는다');
});

group('술래 수 — 인원에 따라', () => {
  eq(R.IT_COUNT(2), 1, '2인이면 술래 1명');
  eq(R.IT_COUNT(3), 1, '3인이면 술래 1명');
  eq(R.IT_COUNT(4), 2, '4인이면 술래 2명');
  eq(R.IT_COUNT(6), 2, '6인이면 술래 2명');

  for(let n=2; n<=6; n++){
    const g = R.createGame({ seed:n });
    for(let i=0;i<n;i++) R.addPlayer(g, 'p'+i, 'P'+i);
    R.start(g, 0);
    const its = R.theIts(g), rs = R.runners(g);
    eq(its.length, R.IT_COUNT(n), `${n}인 → 술래 ${R.IT_COUNT(n)}명`);
    ok(rs.length >= 1, `${n}인 → 도망자가 최소 1명은 남는다`);
    eq(its.length + rs.length, n, `${n}인 → 전원에게 역할이 있다`);
    if(its.length === 2)
      ok(its[0].x !== its[1].x || its[0].y !== its[1].y,
         `${n}인 → 두 술래가 다른 곳에서 출발한다`);
  }
});

group('술래 둘 중 누구에게라도 잡힌다', () => {
  const g = R.createGame({ seed:11 });
  for(let i=0;i<4;i++) R.addPlayer(g, 'p'+i, 'P'+i);
  R.start(g, 0);
  g.phase = 'chase';
  const its = R.theIts(g), rs = R.runners(g);
  eq(its.length, 2, '술래 2명');

  // 두 번째 술래만 도망자 옆에 붙인다 — 첫 번째가 아니어도 잡혀야 한다
  const target = rs[0];
  its[1].x = target.x; its[1].y = target.y; its[1].nextMoveAt = 0;
  its[0].x = g.itSpawns[0].x; its[0].y = g.itSpawns[0].y;
  R.input(g, its[1].id, 'left', 5000);
  ok(!target.alive, '두 번째 술래에게도 잡힌다');
});

group('역할 교대 — 직전 술래 2명은 다음 판에서 밀린다 (§4.3 ②)', () => {
  const g = R.createGame({ seed:13 });
  for(let i=0;i<6;i++) R.addPlayer(g, 'p'+i, 'P'+i);
  R.start(g, 0);
  const first = R.theIts(g).map(p => p.id);
  eq(first.length, 2, '첫 판 술래 2명');
  for(let round=0; round<20; round++){
    R.start(g, 0, first);
    const now = R.theIts(g).map(p => p.id);
    ok(now.every(id => !first.includes(id)), '직전 술래는 연속으로 술래가 되지 않는다');
  }
});

group('시작 조건', () => {
  const g = R.createGame({ seed:1 });
  R.addPlayer(g, 'A', '혼자');
  ok(!R.start(g, 0).ok, '1명이면 시작 불가');
  R.addPlayer(g, 'B', '둘째');
  ok(R.start(g, 0).ok, '2명이면 시작');
  eq(g.phase, 'infiltrate', '잠입 단계로 들어간다');
});

group('잠입 단계 — 술래는 묶여 있다 (§4.1)', () => {
  const g = newGame(); R.start(g, 0); force(g, 'A');
  g.phase = 'infiltrate';
  ok(!R.input(g, 'A', 'left', 0).ok, '술래는 잠입 중 움직일 수 없다');
  ok(R.input(g, 'B', 'left', 0).ok, '도망자는 움직인다');
  R.tick(g, 10_001);
  eq(g.phase, 'chase', '10초 뒤 추격 단계');
  ok(R.input(g, 'A', 'left', 10_001).ok, '추격 단계에선 술래도 움직인다');
});

group('쿨다운 차등 (§4.3 ① A안)', () => {
  eq(R.COOLDOWN.it, 320, '술래 320ms');
  eq(R.COOLDOWN.runner, 400, '도망자 400ms');
  const g = newGame(); R.start(g, 0); force(g, 'A'); g.phase = 'chase';
  ok(R.input(g, 'B', 'left', 1000).ok, '첫 입력 통과');
  ok(!R.input(g, 'B', 'left', 1200).ok, '400ms 안에 두 번째는 거부');
  ok(R.input(g, 'B', 'left', 1400).ok, '400ms 뒤엔 통과');
  ok(R.input(g, 'A', 'left', 1000).ok, '술래 첫 입력');
  ok(R.input(g, 'A', 'left', 1330).ok, '술래는 320ms 만에 다음 입력');
});

group('벽 · 이동 검증', () => {
  const g = newGame(); R.start(g, 0); force(g, 'A'); g.phase = 'chase';
  const p = g.players.get('B');
  let blocked = 0;
  for(let d=0; d<4; d++){
    p.dir = d; p.nextMoveAt = 0;
    const dd = M.DIRS[d];
    const canWalk = M.walkable(g.grid, p.x+dd.dx, p.y+dd.dy);
    const res = R.input(g, 'B', 'forward', 10_000 + d*1000);
    if(!canWalk){ ok(!res.ok && res.reason === '벽', '벽으로는 못 간다'); blocked++; }
  }
  ok(blocked > 0, '실제로 막힌 방향이 있었다');
  ok(!R.input(g, 'B', '순간이동', 99_999).ok, '모르는 동작은 거부');
});

group('포획 — contact 1칸 즉사 (§2.3)', () => {
  const g = newGame(); R.start(g, 0); force(g, 'A'); g.phase = 'chase';
  const it = g.players.get('A'), b = g.players.get('B'), c = g.players.get('C');
  c.alive = false;                              // C 는 미리 잡힌 것으로 둔다
  // 술래를 도망자 바로 옆으로 옮기고 한 번 움직이게 해 판정을 태운다
  it.x = b.x; it.y = b.y; it.dir = 1; it.nextMoveAt = 0;
  R.input(g, 'A', 'left', 20_000);
  ok(!b.alive, '1칸 거리에서 즉사');
  eq(g.winner, 'it', '도망자 전원 포획 → 술래 승');
});

group('탈출 — 1명이라도 나가면 도망자 진영 승 (§4.1)', () => {
  const g = newGame(); R.start(g, 0); force(g, 'A'); g.phase = 'chase';
  const b = g.players.get('B');
  b.x = g.exit.x; b.y = g.exit.y; b.nextMoveAt = 0;
  R.input(g, 'B', 'left', 20_000);
  ok(b.escaped, '탈출 처리');
  eq(g.winner, 'runners', '도망자 진영 승');
  ok(R.runners(g).some(r => !r.escaped && r.alive), '남은 도망자가 있어도 즉시 승리');
});

group('제한시간', () => {
  const g = newGame(); R.start(g, 0); force(g, 'A');
  R.tick(g, 10_001);                             // → chase
  R.tick(g, 10_001 + 300_000);
  eq(g.phase, 'over', '시간이 끝나면 종료');
  eq(g.winner, 'runners', '생존자가 있으면 도망자 승');
});

group('정보 비대칭 — 서버가 아예 안 보낸다', () => {
  const g = newGame(); R.start(g, 0); force(g, 'A'); g.phase = 'chase';
  const it = g.players.get('A'), b = g.players.get('B');
  // 서로 멀리 떨어뜨린다
  it.x = g.itSpawn.x; it.y = g.itSpawn.y; b.x = g.runnerSpawn.x; b.y = g.runnerSpawn.y;

  const vIt = R.viewFor(g, 'A', 0), vRun = R.viewFor(g, 'B', 0);
  const blob = JSON.stringify(vRun);
  ok(vRun.exitDist !== null && vRun.exitDist !== undefined, '도망자는 탈출구까지의 거리감을 받는다');
  ok(!('exit' in vRun) && !blob.includes('"exit":{'), '도망자는 탈출구 좌표를 못 받는다 (§4.3 ③)');
  ok(vRun.seen.length === 0, '멀리 있는 술래는 안 보인다');
  ok(vIt.seen.length === 0, '술래도 멀리 있는 도망자는 안 보인다 (§4.3 ②)');
  ok(vIt.hints.every(h => !('x' in h) && !('y' in h)), '술래가 받는 건 방향·거리뿐 좌표가 아니다');
  ok(vIt.exitDist === undefined, '술래에겐 탈출구 신호를 주지 않는다 (설계 단계가 아직 없으므로)');

  // 정면 4칸 안으로 들여보내면 그때 보인다
  const los = M.lineOfSight(g.grid, it, it.dir, 4);
  if(los.length){
    b.x = los[0].x; b.y = los[0].y;
    const v2 = R.viewFor(g, 'A', 0);
    eq(v2.seen.length, 1, '정면 1칸이면 보인다');
    eq(v2.seen[0].stage, 'contact', '1칸은 contact 단계');
  }
});

/* ── 이 프로젝트의 미해결 문제에 답한다 ─────────────
   기획서 §4.3 ①: "같은 속도면 거리가 영원히 좁혀지지 않는다."
   A안(320 vs 400ms)이 정말 추격을 성립시키는지 시뮬레이션으로 확인한다.

   도망자 AI 가 멍청하면 답이 왜곡된다 — 순수 탐욕이면 스스로 막다른 길로 들어가
   같은 속도에서도 잡힌다. 그래서 도망자는 '막다른 칸을 피하면서 멀어지도록' 둔다. */
group('추격이 성립하는가 — §4.3 ① 실측', () => {
  const degree = (g, x, y) => M.DIRS.filter(e => M.walkable(g.grid, x+e.dx, y+e.dy)).length;

  // score 가 가장 큰 이웃 칸으로 한 칸 간다
  function move(g, p, score, now){
    let pick = null, bestV = -Infinity;
    for(let d=0; d<4; d++){
      const dd = M.DIRS[d], nx = p.x + dd.dx, ny = p.y + dd.dy;
      if(!M.walkable(g.grid, nx, ny)) continue;
      const v = score(nx, ny);
      if(v > bestV){ bestV = v; pick = d; }
    }
    if(pick === null) return;
    p.dir = pick;                       // 회전 비용은 양쪽 동일하므로 비교에는 영향이 없다
    p.nextMoveAt = 0;
    R.input(g, p.id, 'forward', now);
  }

  function chase(itCd, runnerCd, seed){
    const g = R.createGame({ seed, w:13, h:13 });
    R.addPlayer(g, 'I', '술래'); R.addPlayer(g, 'R', '도망자');
    force(g, 'I');
    g.phase = 'chase'; g.phaseEndsAt = 1e9;
    const it = g.players.get('I'), r = g.players.get('R');
    const old = { ...R.COOLDOWN };
    R.COOLDOWN.it = itCd; R.COOLDOWN.runner = runnerCd;

    let now = 0;
    const LIMIT = 120_000;              // 2분 안에 못 잡으면 실패로 본다
    while(now < LIMIT && r.alive){
      now += 10;
      if(now >= it.nextMoveAt){
        const d = M.bfs(g.grid, { x:r.x, y:r.y });          // 술래: 최단경로로 접근
        move(g, it, (nx, ny) => -d[ny][nx], now);
      }
      if(now >= r.nextMoveAt && r.alive){
        const d = M.bfs(g.grid, { x:it.x, y:it.y });        // 도망자: 멀어지되 막다른 길은 피한다
        move(g, r, (nx, ny) => d[ny][nx]*4 + degree(g, nx, ny), now);
      }
    }
    Object.assign(R.COOLDOWN, old);
    return { caught: !r.alive, ms: now };
  }

  const N = 25;
  const rows = [];
  for(const [itCd, label] of [[400,'같은 속도 400/400'], [360,'차등 360/400'], [320,'A안 320/400']]){
    let caught = 0; const times = [];
    for(let seed=1; seed<=N; seed++){
      const r = chase(itCd, 400, seed);
      if(r.caught){ caught++; times.push(r.ms); }
    }
    const avg = times.length ? (times.reduce((a,b)=>a+b,0)/times.length/1000) : null;
    rows.push({ label, caught, avg });
    console.log(`  ${label.padEnd(18)} ${String(caught).padStart(2)}/${N}판 포획` +
                (avg ? ` · 평균 ${avg.toFixed(1)}초` : ' · 포획 실패'));
  }
  const same = rows[0], a = rows[2];
  ok(a.caught > same.caught, `A안이 같은 속도보다 확실히 잘 잡는다 (${a.caught} > ${same.caught})`);
  ok(a.caught >= N*0.7, `A안에서 추격이 실제로 성립한다 (${a.caught}/${N})`);
  ok(same.caught <= N*0.5, `같은 속도로는 절반도 못 잡는다 (${same.caught}/${N}) — 문서의 우려가 사실`);
});

console.log(`
${fail ? '✗ 실패 ' + fail + '건' : '✔ 전부 통과'} (${pass}건 검사)`);
process.exit(fail ? 1 : 0);
