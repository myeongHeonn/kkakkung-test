/* Colyseus 방 — 기존 room.js 를 대체한다.
   rules.js · maze.js 는 손대지 않는다. 순수 로직이라 전송 계층을 몰라도 되고,
   그래서 test.js 360건이 그대로 살아 있다.

   ⚠️ Colyseus 의 Schema 상태 동기화를 쓰지 않는다.
   Schema 는 '한 방 상태를 전원에게' 모델인데, 이 게임의 규칙은 §4.3 ②③ —
   사람마다 볼 수 있는 게 다르다(술래는 도망자 좌표를 모르고, 도망자는 탈출구를 모른다).
   그래서 viewFor() 로 1인분씩 만들어 client.send() 로 보낸다.
   Colyseus 는 방·매치메이킹·생명주기·재접속만 맡는다.

   방 두 종류:
     · 공개  — code 없이 joinOrCreate. 모르는 사람과 매칭된다. 얼굴 공유 금지
     · 비공개 — code 를 들고 joinOrCreate. filterBy 가 같은 코드끼리 묶는다. 얼굴 공유 허용 */

const { Room } = require('colyseus');
const R = require('./rules');

const TICK_MS = 100;
const MAX_PLAYERS = 6;
const RECONNECT_SEC = 30;           // 와이파이가 끊겨도 이 안에 돌아오면 판이 유지된다
const FACE_MAX = 80_000;            // 약 60KB. 256px JPEG 한 장이면 충분하다
const FACE_PREFIX = 'data:image/jpeg;base64,';
const CODE_RE = /^[A-Z0-9]{4,8}$/;

class KkakkungRoom extends Room {
  onCreate(options = {}){
    this.maxClients = MAX_PLAYERS;
    this.code = normCode(options.code);
    this.isPrivate = !!this.code;

    /* 얼굴은 비공개 방에서만 오간다.
       공개 매칭은 모르는 사람과 묶이는데, 거기까지 얼굴을 보내는 건
       §7 이 전제한 "같은 방 참가자" 의 범위를 넘는다. */
    this.allowFaces = this.isPrivate;

    this.game = R.createGame({});
    this.faces = new Map();          // sessionId → data URL. 메모리에만 (§7-2)
    this.previousIts = [];
    this.gridKey = null;

    /* 메타데이터에 코드를 넣지 않는다 — getAvailableRooms 로 코드가 새어 나간다.
       setPrivate(true) 도 쓰지 않는다. 그걸 켜면 매치메이킹에서 방이 통째로 빠져
       같은 코드를 든 사람조차 못 들어온다 (filterBy 가 그 방을 못 찾는다).
       대신 onAuth 에서 코드를 검사한다 — roomId 를 알아내 joinById 로 우회해도 거기서 막힌다. */
    this.setMetadata({ isPrivate: this.isPrivate, players: 0 });

    this.onMessage('start', client => this.onStart(client));
    this.onMessage('input', (client, m) => this.onInput(client, m));
    this.onMessage('face', (client, m) => this.onFace(client, m));
    this.onMessage('faceOff', client => this.onFaceOff(client));

    this.setSimulationInterval(() => this.tick(), TICK_MS);
  }

  /* 방 코드 검문. filterBy 는 매치메이킹만 가르므로 roomId 를 알아낸 사람이
     joinById 로 곧장 들어오는 경로가 남는다. 얼굴이 오가는 방이라 여기서 막는다. */
  onAuth(client, options = {}){
    const given = normCode(options.code);
    if(this.code && given !== this.code) throw new Error('방 코드가 맞지 않다');
    if(!this.code && given) throw new Error('공개 방에는 코드로 들어올 수 없다');
    return true;
  }

  onJoin(client, options = {}){
    R.addPlayer(this.game, client.sessionId, options.name);
    this.setMetadata({ isPrivate: this.isPrivate, players: this.game.players.size });
    client.send('room', {
      code: this.code || null, isPrivate: this.isPrivate,
      allowFaces: this.allowFaces, max: MAX_PLAYERS,
    });
    this.sendMaze(client);
    // 먼저 와 있던 사람들의 얼굴 (§7 — 같은 방 안에서만)
    if(this.allowFaces)
      for(const [id, data] of this.faces)
        if(id !== client.sessionId) client.send('face', { id, data });
    this.pushState();
  }

  /* 끊겨도 바로 지우지 않는다. 30초 안에 돌아오면 그 자리를 그대로 돌려준다.
     서버를 재시작하거나 와이파이가 잠깐 끊겼다고 판이 날아가면 안 된다. */
  async onLeave(client, consented){
    const p = this.game.players.get(client.sessionId);
    if(p) p.connected = false;
    if(!consented){
      try{
        await this.allowReconnection(client, RECONNECT_SEC);
        const back = this.game.players.get(client.sessionId);
        if(back) back.connected = true;
        this.sendMaze(client);
        if(this.allowFaces)
          for(const [id, data] of this.faces)
            if(id !== client.sessionId) client.send('face', { id, data });
        this.pushState();
        return;
      }catch{ /* 시간 안에 안 돌아왔다 */ }
    }
    this.dropPlayer(client.sessionId);
  }

  dropPlayer(id){
    R.removePlayer(this.game, id);
    // §7-4 방을 떠나면 즉시 폐기하고 남은 사람들에게도 지우라고 알린다
    if(this.faces.delete(id)) this.broadcast('faceGone', { id });
    if(this.game.phase !== 'lobby' && this.game.players.size < 2){
      this.game.phase = 'lobby';
      this.game.winner = null;
      this.game.endReason = '인원 부족으로 중단';
    }
    this.pushState();
  }

  onDispose(){ this.faces.clear(); }        // 방이 사라지면 얼굴도 사라진다 (§7-4)

  /* ── 메시지 ── */
  onStart(client){
    if(this.game.phase === 'over') this.restart();
    const r = R.start(this.game, Date.now(), this.previousIts);
    if(!r.ok) return client.send('error', { reason: r.reason });
    this.sendMaze();
    this.pushState(R.drain(this.game));
  }

  onInput(client, m){
    const r = R.input(this.game, client.sessionId, m && m.a, Date.now());
    const ev = R.drain(this.game);
    if(!r.ok && !ev.length) return this.sendState(client, [], r.reason);
    this.pushState(ev);
  }

  onFace(client, m){
    if(!this.allowFaces)
      return client.send('error', { reason: '공개 방에서는 얼굴을 공유하지 않는다. 방 코드로 만든 방에서만 된다' });
    const d = m && m.data;
    if(typeof d !== 'string' || !d.startsWith(FACE_PREFIX) || d.length > FACE_MAX)
      return client.send('error', { reason: '얼굴 데이터 형식이 아니거나 너무 크다' });
    this.faces.set(client.sessionId, d);
    this.broadcast('face', { id: client.sessionId, data: d }, { except: client });
    client.send('faceOk', {});
  }

  onFaceOff(client){
    this.faces.delete(client.sessionId);
    this.broadcast('faceGone', { id: client.sessionId }, { except: client });
    client.send('faceOff', {});
  }

  /* ── 새 판 ── */
  restart(){
    this.previousIts = R.theIts(this.game).map(p => p.id);   // §4.3 ② 역할 교대
    const names = R.list(this.game).map(p => ({ id: p.id, name: p.name }));
    this.game = R.createGame({ seed: (Math.random()*0xFFFFFFFF) >>> 0 });
    for(const n of names) R.addPlayer(this.game, n.id, n.name);
  }

  /* ── 전송 ──
     미로는 판마다 한 번만 보낸다. 매 틱 실어 보내면 그것만으로 트래픽의 42% 였다.
     방 100개를 동시에 굴리면 이게 곧 EC2 아웃바운드 요금이 된다. */
  sendMaze(target){
    const msg = { grid: this.game.grid, w: this.game.w, h: this.game.h, seed: this.game.seed };
    this.gridKey = this.game.seed;
    if(target) target.send('maze', msg); else this.broadcast('maze', msg);
  }

  lobby(){
    return {
      players: R.list(this.game).map(p => ({
        id: p.id, name: p.name, role: p.role, alive: p.alive,
        escaped: p.escaped, connected: p.connected !== false,
      })),
      canStart: this.game.players.size >= 2 &&
                (this.game.phase === 'lobby' || this.game.phase === 'over'),
      max: MAX_PLAYERS, code: this.code || null, allowFaces: this.allowFaces,
    };
  }

  sendState(client, events, denied){
    const view = R.viewFor(this.game, client.sessionId, Date.now());
    if(!view) return;
    delete view.grid;                 // 'maze' 로 따로 보냈다
    const msg = { view, events: events || [], lobby: this.lobby() };
    if(denied) msg.denied = denied;
    client.send('state', msg);
  }

  // 사람마다 볼 수 있는 게 다르므로 방송이 아니라 1인분씩 만든다 (§4.3 ②③)
  pushState(events){
    for(const client of this.clients) this.sendState(client, events);
  }

  tick(){
    const events = R.tick(this.game, Date.now());
    if(events.length) this.pushState(events);
    else if(this.game.phase === 'infiltrate' || this.game.phase === 'chase') this.pushState();
  }
}

function normCode(c){
  if(typeof c !== 'string') return null;
  const up = c.trim().toUpperCase();
  return CODE_RE.test(up) ? up : null;
}

module.exports = { KkakkungRoom, MAX_PLAYERS, RECONNECT_SEC, normCode, CODE_RE };
