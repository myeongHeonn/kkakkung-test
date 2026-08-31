/* 방 — 규칙(rules.js)과 소켓 사이를 잇는 층.
   타이머·연결 관리·브로드캐스트만 한다. 판정은 전부 rules.js 가 한다.

   v1 은 방이 하나다. 접속하면 전부 같은 방에 들어간다.
   방 코드는 팀원끼리 한 판 돌려보는 데 필요 없고, UI 를 하나 더 늘린다. */

const R = require('./rules');

const TICK_MS = 100;          // 페이즈 전환·시간 갱신 주기
// §4.1 은 1 술래 + 1~3 도망자(최대 4인)로 잡혀 있으나, 팀 인원에 맞춰 6인까지 연다.
// 술래 수는 rules.js 의 IT_COUNT 가 정한다 (4인 이상이면 2명).
const MAX_PLAYERS = 6;

function createRoom(opt = {}){
  const room = {
    game: R.createGame(opt),
    sockets: new Map(),       // id → ws
    faces: new Map(),         // id → data URL. 메모리에만 둔다 (§7-2)
    previousIts: [],
    timer: null,
    opt,
  };
  room.timer = setInterval(() => pump(room), TICK_MS);
  if(room.timer.unref) room.timer.unref();
  return room;
}

let nextId = 1;
const newId = () => 'p' + (nextId++);

function send(ws, msg){
  if(ws && ws.readyState === 1){
    try{ ws.send(JSON.stringify(msg)); }catch{ /* 끊긴 소켓은 곧 close 로 정리된다 */ }
  }
}

// 사람마다 볼 수 있는 게 다르므로 방송이 아니라 1인분씩 만들어 보낸다 (§4.3 ②③)
function pushState(room, events){
  const now = Date.now();
  for(const [id, ws] of room.sockets){
    const view = R.viewFor(room.game, id, now);
    if(view) send(ws, { t:'state', view, events: events || [], lobby: lobbyOf(room) });
  }
}

/* 얼굴 스냅샷 중계 (기획서 §4.4 · §7)

   §7 이 정한 조건을 그대로 옮긴다:
     · 정지 이미지 1장만. 실시간 영상 스트리밍은 하지 않는다
     · 촬영 직전 별도 동의 — 클라이언트가 동의 버튼을 눌러야만 여기로 온다
     · 같은 방 참가자에게만 전달한다
     · 방을 나가면 즉시 폐기하고 남은 사람들에게도 지우라고 알린다
     · 등록하지 않아도 기본 얼굴로 정상 플레이된다

   메모리에만 둔다. 디스크에 쓰지 않는다 — 파일로 남는 순간 §7-2 위반이다.
   rules.js 에는 넣지 않는다. 얼굴은 게임 판정과 무관한 표현일 뿐이고,
   판정 로직에 섞이면 viewFor 를 통해 새어 나갈 수 있다. */
const FACE_MAX = 80_000;                       // 약 60KB. 256px JPEG 한 장이면 충분하다
const FACE_PREFIX = 'data:image/jpeg;base64,';

function faceOk(d){
  return typeof d === 'string' && d.startsWith(FACE_PREFIX) && d.length <= FACE_MAX;
}

// 이미 등록된 얼굴들을 새로 들어온 사람에게 한 번 보낸다
function sendFaces(room, ws, exceptId){
  for(const [id, data] of room.faces) if(id !== exceptId) send(ws, { t:'face', id, data });
}

function broadcast(room, msg, exceptId){
  for(const [id, ws] of room.sockets) if(id !== exceptId) send(ws, msg);
}

const lobbyOf = room => ({
  players: R.list(room.game).map(p => ({
    id:p.id, name:p.name, role:p.role, alive:p.alive, escaped:p.escaped,
  })),
  canStart: room.game.players.size >= 2 && (room.game.phase === 'lobby' || room.game.phase === 'over'),
  max: MAX_PLAYERS,
});

function pump(room){
  const events = R.tick(room.game, Date.now());
  if(events.length) pushState(room, events);
  else if(room.game.phase === 'infiltrate' || room.game.phase === 'chase') pushState(room);
}

/* 새 판 — 미로를 새로 만들고 역할을 바꾼다 (§4.3 ② 역할 교대). */
function restart(room){
  room.previousIts = R.theIts(room.game).map(p => p.id);   // §4.3 ② 다음 판에서 이들은 후보에서 밀린다
  const names = R.list(room.game).map(p => ({ id:p.id, name:p.name }));
  room.game = R.createGame({ ...room.opt, seed: (Math.random()*0xFFFFFFFF) >>> 0 });
  for(const n of names) R.addPlayer(room.game, n.id, n.name);
}

function attach(room, ws){
  const id = newId();
  room.sockets.set(id, ws);
  send(ws, { t:'welcome', id });

  ws.on('message', raw => {
    let m;
    try{ m = JSON.parse(raw); }catch{ return; }
    const now = Date.now();

    if(m.t === 'join'){
      if(room.game.players.size >= MAX_PLAYERS && !room.game.players.has(id))
        return send(ws, { t:'full', max: MAX_PLAYERS });
      R.addPlayer(room.game, id, m.name);
      sendFaces(room, ws, id);        // 먼저 와 있던 사람들의 얼굴
      return pushState(room);
    }
    if(m.t === 'start'){
      if(room.game.phase === 'over') restart(room);
      const r = R.start(room.game, now, room.previousIts);
      if(!r.ok) return send(ws, { t:'error', reason:r.reason });
      return pushState(room, R.drain(room.game));
    }
    if(m.t === 'face'){
      // 동의 없이는 클라이언트가 이 메시지를 보내지 않는다. 서버는 형식만 검증한다.
      if(!faceOk(m.data)) return send(ws, { t:'error', reason:'얼굴 데이터 형식이 아니거나 너무 크다' });
      room.faces.set(id, m.data);
      broadcast(room, { t:'face', id, data:m.data }, id);
      return send(ws, { t:'faceOk' });
    }
    if(m.t === 'faceOff'){                 // 등록 철회 — 언제든 지울 수 있어야 한다
      room.faces.delete(id);
      broadcast(room, { t:'faceGone', id }, id);
      return send(ws, { t:'faceOff' });
    }
    if(m.t === 'input'){
      const r = R.input(room.game, id, m.a, now);
      const ev = R.drain(room.game);
      if(!r.ok && !ev.length){
        // 쿨다운·벽은 흔한 거부다. 상태만 되돌려주고 이벤트는 만들지 않는다.
        return send(ws, { t:'state', view: R.viewFor(room.game, id, now),
                          events: [], lobby: lobbyOf(room), denied: r.reason });
      }
      return pushState(room, ev);
    }
  });

  const bye = () => {
    room.sockets.delete(id);
    R.removePlayer(room.game, id);
    // §7-4 방을 나가면 즉시 폐기하고, 남은 사람들에게도 지우라고 알린다
    if(room.faces.delete(id)) broadcast(room, { t:'faceGone', id });
    // 사람이 빠져서 게임이 성립하지 않으면 로비로 되돌린다
    if(room.game.phase !== 'lobby' && room.game.players.size < 2){
      room.game.phase = 'lobby';
      room.game.winner = null;
      room.game.endReason = '인원 부족으로 중단';
    }
    pushState(room);
  };
  ws.on('close', bye);
  ws.on('error', bye);
}

module.exports = { createRoom, attach, MAX_PLAYERS, TICK_MS };
