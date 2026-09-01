/* 멀티플레이 (Colyseus) + 얼굴 스냅샷.
   의존은 한 방향이다: net → scene · audio · minimap · player. 아무도 net 을 import 하지 않는다. */
import * as THREE from 'three';
import * as Colyseus from 'colyseus.js';
import type { Action, JoinOptions, LobbyInfo, PlayerView, ServerMessages } from '../shared/protocol.ts';
import { $, showErr } from './core/dom.ts';
import { grid, setGrid, wx, wz } from './core/space.ts';
import { scene, camera, creature, rebuildMaze, faceCv, setExit } from './scene.ts';
import { player, view, setSender, setOnMoved } from './player.ts';
import { sting, footstep, rustle, creatureStep, setExitDread, setOnline } from './audio.ts';
import { mapReset, mapMark, mapDraw } from './minimap.ts';
import { isFaceOn } from './face.ts';
import { facePainted } from './scene.ts';

/* ══ 멀티플레이 (Colyseus) ═════════════════════════
   서버가 권한을 갖는다. 클라이언트는 "이렇게 하고 싶다"만 보내고,
   내 위치조차 서버가 내려준 값을 따른다 (server/rules.js).

   Colyseus 의 Schema 상태 동기화는 쓰지 않는다. Schema 는 '한 방 상태를 전원에게'
   모델인데, 이 게임은 사람마다 볼 수 있는 게 다르다(§4.3 ②③).
   서버가 viewFor() 로 1인분씩 만들어 보내고, 여기서는 그걸 받기만 한다.

   방은 두 종류다:
     · 공개 매칭 — 모르는 사람과 묶인다. 얼굴 공유 금지
     · 방 코드   — 아는 사람끼리. 얼굴 공유 허용
   접속하지 않으면 아래는 전부 잠들어 있고 기존 솔로 동작이 그대로 산다. */
export const NET = {
  client:null, room:null, on:false, id:null, view:null, lobby:null, info:null,
  others:new Map(), seenIds:new Set(), lastHintAt:0, faceShared:false, retry:0,
};
export const FACES = new Map();          // id → THREE.Texture

// 헷갈리는 글자(0/O, 1/I)를 뺀 알파벳 — 코드를 불러줘야 하는 상황을 생각한 것
export const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newCode = () => Array.from({length:4}, () => CODE_ABC[(Math.random()*CODE_ABC.length)|0]).join('');

export function mpEndpoint(): string {
  /* 배포에서는 serve.ts 가 정적 파일과 Colyseus 를 같은 포트에서 내보내므로 같은 오리진이다.
     개발에서는 Vite(5200)와 게임 서버(5199)가 갈라져 있어 직접 지정한다.
     https 로 열렸으면 wss 여야 한다 — 섞이면 브라우저가 막는다. */
  if(import.meta.env.DEV) return 'ws://' + location.hostname + ':5199';
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
}

export async function mpJoin(code){
  if(NET.room) return;
  const name = ($('mpName').value || '').trim() || '이름없음';
  try{ localStorage.setItem('kk.name', name); }catch{}
  mpPill('접속 중…');
  try{
    NET.client = NET.client || new Colyseus.Client(mpEndpoint());
    // code 는 항상 보낸다. 빼면 매치메이킹이 코드 있는 방까지 후보로 잡는다.
    const room = await NET.client.joinOrCreate('kkakkung', { name, code: code || '' });
    bindRoom(room);
  }catch(e){
    mpPill('접속 실패');
    showErr('방에 들어가지 못했다', (e && e.message) || e);
  }
}

export function bindRoom(room){
  NET.room = room; NET.id = room.sessionId; NET.on = true;
  /* 여기서부터 서버가 권한을 갖는다.
     · player 는 이제 로컬 이동 대신 이 함수로 의도만 보낸다
     · audio 는 솔로 조우 판정을 멈춘다 (서버가 보내준 seen 으로 스팅어를 띄운다) */
  setSender(mpSend);
  setOnline(true);
  try{ localStorage.setItem('kk.token', room.reconnectionToken || ''); }catch{}
  creature.visible = false;                 // 멀티에서는 실제 플레이어만 보인다
  mpPill('접속됨');

  room.onMessage('room', m => { NET.info = m; mpRoomUI(); });
  room.onMessage('maze', m => {
    setGrid(m.grid); rebuildMaze(); mapReset(); NET.seenIds.clear();
  });
  room.onMessage('state', mpApply);
  room.onMessage('face', m => faceRecv(m.id, m.data));
  room.onMessage('faceGone', m => faceDrop(m.id));
  room.onMessage('faceOk', () => { faceSharePill(true); banner('얼굴 등록됨', '이 방 사람들에게만 전달된다'); });
  room.onMessage('faceOff', () => { faceSharePill(false); banner('얼굴 등록을 지웠다', ''); });
  room.onMessage('error', m => showErr('서버', m.reason));

  room.onLeave(code => {
    NET.on = false; NET.room = null; NET.view = null;
    // 솔로로 되돌린다 — 안 풀면 오프라인인데도 입력이 허공으로 나간다
    setSender(null);
    setOnline(false);
    setExitDread(null);
    for(const g of NET.others.values()) scene.remove(g);
    NET.others.clear();
    for(const t of FACES.values()) t.dispose();
    FACES.clear(); faceSharePill(false);
    creature.visible = true;                // 솔로 연출로 되돌린다
    mpRoomUI();
    // 1000 = 정상 종료. 그 외는 사고이므로 되돌아갈 수 있게 알린다.
    if(code === 1000){ mpPill('나감'); }
    else { mpPill('끊김'); banner('연결이 끊겼다', '`다시 접속` 을 누르면 자리로 돌아간다'); }
  });
}

/* 재접속 — 서버가 30초 자리를 잡아둔다. 그 안에 돌아오면 역할·위치가 그대로다. */
export async function mpReconnect(){
  let token = '';
  try{ token = localStorage.getItem('kk.token') || ''; }catch{}
  if(!token || !NET.client) return mpJoin($('mpCode').value.trim().toUpperCase());
  mpPill('재접속 중…');
  try{ bindRoom(await NET.client.reconnect(token)); }
  catch(e){ mpPill('재접속 실패'); banner('자리가 사라졌다', '새로 들어가야 한다'); }
}

export function mpLeave(){ if(NET.room) NET.room.leave(true); }

export function mpPill(text: string){
  const p = $('pNet');
  p.textContent = text;
  p.classList.toggle('on', text === '접속됨');
  p.classList.toggle('warn', /실패|끊김/.test(text));
}
export function mpRoomUI(){
  const on = NET.on, info = NET.info;
  $('mpPublic').classList.toggle('hidden', on);
  $('mpCreate').classList.toggle('hidden', on);
  $('mpCodeRow').classList.toggle('hidden', on);
  $('mpLeave').classList.toggle('hidden', !on);
  $('faceShare').classList.toggle('hidden', !on || !(info && info.allowFaces));
  $('mpWhere').textContent = !on ? ''
    : (info && info.code ? '방 코드 ' + info.code : '공개 매칭 — 얼굴 공유 없음');
}

export const mmss = ms => {
  const s = Math.max(0, Math.round(ms/1000));
  return String((s/60)|0).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
};

export function mpApply(msg){
  NET.view = msg.view; NET.lobby = msg.lobby;
  applyMe(msg.view.me);
  applySeen(msg.view.seen);
  applyHints(msg.view);
  // 안 보이면 서버가 아예 안 보낸다 — 여기서 걸러낼 것이 없다 (applySeen 과 같은 원칙)
  setExit(msg.view.exitSeen ?? null);
  setExitDread(netDread());
  mpHud(msg.view, msg.lobby);
  (msg.events || []).forEach(mpEvent);
}

/* 서버가 내려준 내 위치를 따른다. 로컬에서 미리 움직이지 않는다 —
   예측 이동은 서버가 거부했을 때 되감기가 필요한데, 400ms 쿨다운 게임에서
   그 복잡도를 감수할 이유가 없다.

   상태는 10Hz 로 계속 온다. '바뀐 것만' 보고 애니메이션을 걸어야 한다.
   매번 새로 걸면 카메라가 목적지에 영영 도착하지 못한다. */
export function applyMe(me){
  const dirChanged = player.dir !== me.dir;
  const cellChanged = player.x !== me.x || player.y !== me.y;
  player.x = me.x; player.y = me.y; player.dir = me.dir;

  const wantYaw = -me.dir*Math.PI/2;
  const px = wx(me.x), pz = wz(me.y);

  if(dirChanged || cellChanged) mapDraw(player.x, player.y, player.dir);
  if(dirChanged){
    // 최단 방향으로 돈다. 3→0 을 그냥 빼면 반대로 한 바퀴 돈다.
    const delta = Math.atan2(Math.sin(wantYaw - view.camYaw), Math.cos(wantYaw - view.camYaw));
    view.anim = { kind:'turn', t:0, from:view.camYaw, to:view.camYaw + delta };
    rustle(delta > 0 ? 'left' : 'right');
  } else if(cellChanged){
    view.anim = { kind:'move', t:0, fx:camera.position.x, fz:camera.position.z, tx:px, tz:pz };
    footstep(false); mapMark(player.x, player.y);
  } else if(!view.anim){
    camera.position.x = px; camera.position.z = pz;
    view.camYaw = wantYaw;
  }
}

/* 보이는 상대만 세운다. 서버가 정면 4칸 밖은 아예 안 보내므로
   여기서 걸러낼 것이 없다 — 없는 정보는 그릴 수도 없다. */
export function applySeen(seen){
  const live = new Set();
  for(const s of seen){
    live.add(s.id);
    let g = NET.others.get(s.id);
    if(!g){
      g = creature.clone(true);
      // clone 은 재료를 공유한다. 그대로 두면 한 명을 흐리게 할 때 전원이 흐려지고,
      // 얼굴도 전부 '내 얼굴'이 된다 — 각자 자기 재료를 갖게 떼어낸다.
      g.traverse(o => { if((o as THREE.Mesh).isMesh) ((o as THREE.Mesh).material as THREE.Material) = ((o as THREE.Mesh).material as THREE.Material).clone(); });
      const fp = g.getObjectByName('face');
      if(fp){ fp.material.map = null; fp.visible = false; }
      g.visible = true; scene.add(g); NET.others.set(s.id, g);
      applyFaceTo(s.id);
    }
    g.position.set(wx(s.x), 0, wz(s.y));
    g.lookAt(camera.position.x, 0, camera.position.z);
    // §2.3 3단계 — far 는 실루엣만. 형체를 확신할 수 없어야 한다.
    const far = s.stage === 'far';
    g.traverse(o => {
      if(!(o as THREE.Mesh).isMesh) return;
      ((o as THREE.Mesh).material as THREE.Material).transparent = far;
      ((o as THREE.Mesh).material as THREE.Material).opacity = far ? 0.5 : 1;
    });
    if(!NET.seenIds.has(s.id)){ NET.seenIds.add(s.id); sting(); }
  }
  for(const [id, g] of NET.others){
    if(live.has(id)) continue;
    scene.remove(g);
    g.traverse(o => { if((o as THREE.Mesh).isMesh) ((o as THREE.Mesh).material as THREE.Material).dispose(); });
    NET.others.delete(id); NET.seenIds.delete(id);
  }
}

/* 술래는 좌표 대신 방향·거리만 받는다 (§4.3 ②). 그걸 발소리로 바꾼다.
   화면에 점을 찍으면 그건 레이더지 술래잡기가 아니다. */
export function applyHints(v){
  if(v.me.role !== 'it' || !v.hints || !v.hints.length) return;
  const now = performance.now();
  if(now - NET.lastHintAt < 900) return;
  NET.lastHintAt = now;
  const h = v.hints.reduce((a, b) => a.d <= b.d ? a : b);
  const level = Math.max(0.15, 1 - h.d/8);
  creatureStep(level, { pan: Math.sin(h.bearing), front: Math.cos(h.bearing) });
}

export function mpHud(v, lobby){
  $('pRole').textContent = v.me.role === 'it' ? '술래' : (v.me.escaped ? '탈출' : v.me.alive ? '도망자' : '잡힘');
  $('pRole').classList.toggle('warn', v.me.role === 'it');
  $('pRole').classList.toggle('on', v.me.role === 'runner' && v.me.alive);
  $('pTime').textContent = (v.phase === 'chase' || v.phase === 'infiltrate') ? mmss(v.msLeft) : '--:--';
  $('pAlive').textContent = `생존 ${v.alive}/${v.total}`;
  $('mpStart').disabled = !(lobby && lobby.canStart);
  $('mpStart').textContent = v.phase === 'over' ? '다시 (역할 교대)' : '시작';
  $('mpList').innerHTML = (lobby ? lobby.players : []).map(p =>
    `<div class="mprow${p.id === NET.id ? ' me' : ''}">${p.name}` +
    `<span>${p.escaped ? '탈출' : p.alive ? (p.connected ? '' : '끊김') : '잡힘'}</span></div>`).join('');
}

export function mpEvent(e){
  if(e.t === 'phase' && e.phase === 'infiltrate') banner('잠입', '10초 안에 흩어져라');
  else if(e.t === 'phase' && e.phase === 'chase') banner('추격 시작', '술래가 풀렸다');
  else if(e.t === 'caught') banner(`${e.name} 잡혔다`, '');
  else if(e.t === 'escape') banner(`${e.name} 탈출`, '');
  else if(e.t === 'over'){
    const v = NET.view;
    const win = (e.winner === 'it') === (v.me.role === 'it');
    banner(win ? '승리' : '패배', e.reason, 4200);
  }
}

export let bannerTimer: ReturnType<typeof setTimeout> | null = null;
export function banner(title, sub?, ms = 2200){
  $('bannerT').textContent = title;
  $('bannerS').textContent = sub || '';
  $('banner').classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => $('banner').classList.remove('show'), ms);
}

/* 탈출구 방향 신호 (§4.3 ③) — 좌표는 안 준다. 가까울수록 심장이 빨라진다. */
export function netDread(){
  const v = NET.view;
  if(!v || v.me.role !== 'runner' || v.exitDist == null) return null;
  return Math.max(0, Math.min(1, 1 - v.exitDist/14));
}

/* ══ 얼굴 스냅샷 (기획서 §4.4 · §7) ═══════════════
   §7 을 지키는 방식:
     · 정지 이미지 1장. 실시간 영상은 보내지 않는다
     · 동의 버튼을 눌러야만 호출된다 — 게임 참여 동의에 묶지 않는다
     · 서버는 같은 방 사람에게만 중계하고, 나가면 즉시 지운다
     · 공개 매칭에서는 서버가 아예 거부한다 — 모르는 사람에게 얼굴을 보내지 않는다
     · 등록하지 않아도 기본 얼굴로 정상 플레이된다 */
export function faceShare(){
  if(!NET.on) return banner('먼저 방에 들어가야 한다', '');
  if(!NET.info || !NET.info.allowFaces)
    return banner('공개 방에서는 안 된다', '방 코드로 만든 방에서만 얼굴을 공유한다');
  if(!isFaceOn() || !facePainted())
    return banner('얼굴이 아직 안 잡혔다', '카메라를 켜고 캘리브레이션을 마친 뒤 다시');
  NET.room.send('face', { data: faceCv.toDataURL('image/jpeg', 0.7) });
  $('faceShare').textContent = '보내는 중…';
}
export function faceRevoke(){ if(NET.room) NET.room.send('faceOff', {}); }
export function faceSharePill(on){
  $('faceShare').textContent = on ? '내 얼굴 등록 지우기' : '내 얼굴 등록하기';
  NET.faceShared = on;
}
export function faceRecv(id, dataUrl){
  const tex = new THREE.TextureLoader().load(dataUrl, () => { tex.needsUpdate = true; });
  tex.colorSpace = THREE.SRGBColorSpace;
  const old = FACES.get(id);
  if(old) old.dispose();
  FACES.set(id, tex);
  applyFaceTo(id);
}
export function faceDrop(id){
  const t = FACES.get(id);
  if(t) t.dispose();
  FACES.delete(id);
  applyFaceTo(id);
}
export function applyFaceTo(id){
  const g = NET.others.get(id);
  if(!g) return;
  const fp = g.getObjectByName('face');
  if(!fp) return;
  const tex = FACES.get(id);
  fp.material.map = tex || null;
  fp.material.needsUpdate = true;
  fp.visible = !!tex;
}

export function mpSend(a){ if(NET.room) NET.room.send('input', { a }); }

$('mpPublic').addEventListener('click', () => mpJoin(''));
$('mpCreate').addEventListener('click', () => {
  const c = newCode();
  $('mpCode').value = c;
  mpJoin(c);
});
$('mpEnter').addEventListener('click', () => {
  const c = ($('mpCode').value || '').trim().toUpperCase();
  if(!/^[A-Z0-9]{4,8}$/.test(c)) return banner('코드를 확인해줘', '영문·숫자 4~8자');
  mpJoin(c);
});
$('mpLeave').addEventListener('click', mpLeave);
$('mpStart').addEventListener('click', () => { if(NET.room) NET.room.send('start'); });
$('faceShare').addEventListener('click', () => NET.faceShared ? faceRevoke() : faceShare());
$('pNet').addEventListener('click', () => { if(!NET.on) mpReconnect(); });
try{ $('mpName').value = localStorage.getItem('kk.name') || ''; }catch{}
mpRoomUI();
mapMark(player.x, player.y); mapDraw(player.x, player.y, player.dir);          // 시작 칸부터 찍고 들어간다

