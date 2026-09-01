/* 소리 — 전부 실시간 합성. 음원 파일이 하나도 없다.

   scene 에서 카메라·그것의 위치만 읽는다. net 을 import 하지 않는다 —
   탈출구 신호(§4.3 ③)는 net 이 setExitDread() 로 밀어 넣는다. 그래야 순환이 안 생긴다. */
import { CELL, DIRS, CREATURE, grid, walkable } from './core/space.ts';
import { $ } from './core/dom.ts';
import { showErr } from './core/dom.ts';
import { camera, creature } from './scene.ts';

/* 탈출구 방향 신호 (§4.3 ③). net 이 매 상태마다 밀어 넣는다.
   audio 가 net 을 import 하면 net → audio → net 순환이 된다. 그래서 뒤집었다. */
let exitDread: number | null = null;
export const setExitDread = (v: number | null): void => { exitDread = v; };

/* 멀티에서는 서버가 보내준 조우로 스팅어를 판정한다.
   net 이 접속하면 true 로 바꾼다 — 여기서도 net 을 모르게 유지한다. */
let online = false;
export const setOnline = (v: boolean): void => { online = v; };

/* ══ 소리 — 전부 실시간 합성 ══════════════════════
   절차적 텍스처와 같은 이유로 음원 파일을 쓰지 않는다: 받을 게 없으니
   로딩 실패도 라이선스도 없고, 무엇보다 거리·방향에 따라 소리 자체를
   실시간으로 바꿀 수 있다 (심장박동이 빨라지는 건 재생속도가 아니라 진짜 간격이다).

   무서움은 음량이 아니라 셋에서 나온다:
     ① 불규칙 — 언제 날지 모르는 소리 (방 소리·부정맥)
     ② 방향   — 뒤에서 나는 소리 (그것의 숨·끄는 발소리)
     ③ 대비   — 스팅어가 터질 때 나머지를 죽여서 낙차를 만든다
   그래서 마스터 앞에 리미터를 두고 크게 밀어도 찌그러지지 않게 했다.
   자동재생 정책상 AudioContext 는 반드시 사용자 제스처 안에서 만들어야 한다. */
export const SND = {
  ctx:null, master:null, limiter:null, bed:null, verb:null, muted:false,
  droneLp:null,
  gDrone:null, gRoom:null, gHeart:null, gWhis:null, gWhisNear:null, gAmb:null,
  gStep:null, gSting:null,
  white:null, brown:null,
  hbTimer:null as ReturnType<typeof setTimeout> | null, hbNext:0,
  wsTimer:null as ReturnType<typeof setTimeout> | null,
  ambTimer:null as ReturnType<typeof setTimeout> | null,
  brTimer:null as ReturnType<typeof setTimeout> | null,
  lastSting:-99, sighted:false,
  vol:{ master:0.95, drone:0.85, heart:0.95, whisper:0.8, amb:0.85 },
  onStep:true, onSting:true,
};

/* 노이즈 버퍼는 한 번만 만들어 두고 재생 오프셋만 바꿔 쓴다.
   발소리마다 버퍼를 새로 채우면 GC 가 프레임을 갉아먹는다. */
export function makeNoise(sec, brown){
  const c = SND.ctx, len = Math.floor(c.sampleRate*sec);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for(let i=0;i<len;i++){
    const w = Math.random()*2-1;
    if(brown){ last = (last + 0.02*w)/1.02; d[i] = last*3.5; }
    else d[i] = w;
  }
  return buf;
}
// 노이즈를 지수적으로 감쇠시키면 그게 곧 방의 잔향이다. 복도 하나 분량.
export function makeIR(sec, decay){
  const c = SND.ctx, len = Math.floor(c.sampleRate*sec);
  const buf = c.createBuffer(2, len, c.sampleRate);
  for(let ch=0; ch<2; ch++){
    const d = buf.getChannelData(ch);
    for(let i=0;i<len;i++){
      const t = i/len;
      const pre = t < 0.008 ? t/0.008 : 1;   // 초반 8ms 를 죽여 벽을 조금 떼어놓는다
      d[i] = (Math.random()*2-1) * Math.pow(1-t, decay) * pre;
    }
  }
  return buf;
}
export function noiseSrc(t, dur, brown?){
  const c = SND.ctx, n = c.createBufferSource();
  n.buffer = brown ? SND.brown : SND.white;
  n.loop = true;
  n.start(t, Math.random()*(n.buffer.duration - 0.05));
  n.stop(t + dur);
  return n;
}
// tanh 커브 — 깨끗한 사인을 살짝 찢어서 '기계가 아닌 것'처럼 만든다
export function shaper(amount){
  const n = 1024, curve = new Float32Array(n);
  for(let i=0;i<n;i++) curve[i] = Math.tanh((i*2/n - 1)*amount);
  const ws = SND.ctx.createWaveShaper();
  ws.curve = curve; ws.oversample = '2x';
  return ws;
}
// 레이어 하나 = 자기 볼륨 노드 + 리버브 센드. bed 에 붙은 층만 스팅어에 눌린다.
export function sndBus(send, direct?){
  const c = SND.ctx, g = c.createGain();
  g.connect(direct ? SND.master : SND.bed);
  if(send > 0){ const s = c.createGain(); s.gain.value = send; g.connect(s); s.connect(SND.verb); }
  return g;
}

export function sndStart(){
  if(SND.ctx){ if(SND.ctx.state === 'suspended') SND.ctx.resume().then(sndPill); sndPill(); return; }
  if(SND.muted) return;
  try{
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if(!AC) throw new Error('이 브라우저에 Web Audio 가 없다');
    const c = SND.ctx = new AC();
    SND.white = makeNoise(2, false);
    SND.brown = makeNoise(4, true);

    // 리미터 — 이게 있어야 층을 다 깔고도 크게 밀 수 있다. 없으면 스팅어에서 찌그러진다.
    SND.limiter = c.createDynamicsCompressor();
    SND.limiter.threshold.value = -8; SND.limiter.knee.value = 6;
    SND.limiter.ratio.value = 12;     SND.limiter.attack.value = 0.003;
    SND.limiter.release.value = 0.25;
    SND.limiter.connect(c.destination);

    SND.master = c.createGain(); SND.master.gain.value = 0.0001;
    SND.master.connect(SND.limiter);
    SND.bed = c.createGain(); SND.bed.gain.value = 1;   // 스팅어가 눌러 낙차를 만드는 지점
    SND.bed.connect(SND.master);

    SND.verb = c.createConvolver(); SND.verb.buffer = makeIR(2.6, 2.4);
    const wet = c.createGain(); wet.gain.value = 1.0;
    SND.verb.connect(wet); wet.connect(SND.master);

    SND.gDrone = sndBus(0.25); SND.gRoom  = sndBus(0.35);
    SND.gHeart = sndBus(0.10); SND.gWhis  = sndBus(0.85);
    // 귀 옆 속삭임은 잔향을 거의 안 준다 — 그래야 방 안이 아니라 내 옆이 된다
    SND.gWhisNear = sndBus(0.15, true);
    SND.gAmb   = sndBus(1.10);                       // 방 소리는 잔향이 거리를 만든다
    SND.gStep  = sndBus(0.45, true);
    SND.gSting = sndBus(0.70, true);                 // 자기가 만든 낙차에 자기가 눌리면 안 된다

    buildDrone();
    applyVol();
    // 정적에서 소리가 튀어나오면 그것부터가 놀라움이다. 1.6초에 걸쳐 올린다.
    SND.master.gain.cancelScheduledValues(c.currentTime);
    SND.master.gain.setValueAtTime(0.0001, c.currentTime);
    SND.master.gain.exponentialRampToValueAtTime(Math.max(0.0002, SND.vol.master), c.currentTime + 1.6);

    SND.hbNext = c.currentTime + 0.6;
    hbTick();
    scheduleWhisper();
    scheduleRoom();
    scheduleBreath();
    sndPill();
  }catch(e){
    SND.ctx = null;
    showErr('소리를 시작하지 못했다', e.message || e);
  }
}

/* 드론 — 낮은 배음 몇 개를 로우패스 뒤에 두고 아주 느리게 흔든다.
   음정이 아니라 '방이 내는 소리'로 들려야 하므로 어택도 비브라토도 없다. */
export function buildDrone(){
  const c = SND.ctx;
  const lp = SND.droneLp = c.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 200; lp.Q.value = 0.8;
  lp.connect(SND.gDrone);
  // 51.9Hz 는 36.7Hz 의 증4도(트라이톤)다. 절대 협화되지 않아 귀가 계속 불편하다.
  const voices: [number, OscillatorType, number][] = [
    [36.71,'sine',0.95],[51.91,'sine',0.30],[55.00,'sawtooth',0.26],
    [73.42,'sine',0.44],[98.00,'sine',0.11]];
  voices.forEach(([f,type,a], i) => {
      const o = c.createOscillator(); o.type = type;
      o.frequency.value = f; o.detune.value = (i-2)*9;   // 살짝 어긋나야 맥놀이가 생긴다
      const g = c.createGain(); g.gain.value = a*0.55;
      const lfo = c.createOscillator(); lfo.frequency.value = 0.029 + i*0.019;
      const lg = c.createGain(); lg.gain.value = a*0.45;
      lfo.connect(lg); lg.connect(g.gain); lfo.start();
      o.connect(g); g.connect(lp); o.start();
    });
  // 룸톤 — 브라운 노이즈를 좁은 밴드로 천천히 훑으면 복도 바람이 된다
  const n = c.createBufferSource(); n.buffer = SND.brown; n.loop = true;
  const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 330; bp.Q.value = 0.9;
  const swp = c.createOscillator(); swp.frequency.value = 0.041;
  const swg = c.createGain(); swg.gain.value = 170;
  swp.connect(swg); swg.connect(bp.frequency); swp.start();
  const g = c.createGain(); g.gain.value = 0.55;
  n.connect(bp); bp.connect(g); g.connect(SND.gRoom); n.start();
}

/* 그것과의 거리를 0(멀다)~1(코앞) 로. 심장박동·드론 밝기·숨소리가 여기 물린다. */
export function dread(){
  // 멀티 도망자에게는 그것과의 거리가 아니라 탈출구까지의 거리가 심장을 뛰게 한다 (§4.3 ③)
  const nd = exitDread;
  if(nd !== null) return nd;
  const dx = camera.position.x - creature.position.x;
  const dz = camera.position.z - creature.position.z;
  const cells = Math.hypot(dx, dz)/CELL;
  return Math.max(0, Math.min(1, 1 - (cells - 0.7)/4.3));
}
/* 그것이 내 기준 어느 쪽에 있는가. 스테레오만으로는 앞뒤를 못 만들기 때문에
   뒤쪽이면 로우패스를 내려 어둡게 만든다 — 실제로 귀가 앞뒤를 가르는 단서가 그거다. */
export function creatureDir(){
  const dx = creature.position.x - camera.position.x;
  const dz = creature.position.z - camera.position.z;
  const len = Math.max(1e-4, Math.hypot(dx, dz));
  const y = camera.rotation.y, sy = Math.sin(y), cy = Math.cos(y);
  return {
    pan:  (dx*cy - dz*sy)/len,       // 오른쪽 성분
    front:(-dx*sy - dz*cy)/len,      // 앞쪽 성분 (음수면 등 뒤)
  };
}
export function spatial(dir?){
  const c = SND.ctx, d = dir || creatureDir();
  const pan = c.createStereoPanner(); pan.pan.value = Math.max(-1, Math.min(1, d.pan*0.95));
  const lp = c.createBiquadFilter(); lp.type = 'lowpass';
  lp.frequency.value = d.front > 0 ? 5200 : 1500;   // 등 뒤는 어둡게
  lp.connect(pan); pan.connect(SND.gAmb);
  return lp;
}

/* 심장박동 — setInterval 로 찍으면 박자가 밀린다.
   오디오 시계로 200ms 앞을 미리 예약하고 타이머는 그 예약만 채운다. */
export function thump(t, amp){
  const c = SND.ctx;
  const o = c.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(66, t);
  o.frequency.exponentialRampToValueAtTime(32, t + 0.17);
  const ws = shaper(1.8);                    // 살짝 찢어야 가슴을 친다
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(amp, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.30);
  o.connect(ws); ws.connect(g); g.connect(SND.gHeart); o.start(t); o.stop(t + 0.33);
  // 근육이 조이는 층 — 사인만 있으면 그냥 베이스 음이지 심장이 아니다
  const n = noiseSrc(t, 0.2, true);
  const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 170;
  const ng = c.createGain();
  ng.gain.setValueAtTime(0.0001, t);
  ng.gain.exponentialRampToValueAtTime(amp*0.45, t + 0.01);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
  n.connect(lp); lp.connect(ng); ng.connect(SND.gHeart);
}
// 귀 안쪽에서 도는 피 — 아주 가까울 때만 박에 얹는다
export function bloodRush(t, amp){
  const c = SND.ctx;
  const n = noiseSrc(t, 0.42, true);
  const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.6;
  bp.frequency.setValueAtTime(240, t);
  bp.frequency.exponentialRampToValueAtTime(90, t + 0.4);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(amp, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
  n.connect(bp); bp.connect(g); g.connect(SND.gHeart);
}
export function hbTick(){
  if(!SND.ctx) return;
  const c = SND.ctx;
  while(SND.hbNext < c.currentTime + 0.2){
    const d = dread();
    // 선형이면 플레이어가 눈금을 읽는다 — 몇 칸 남았는지 귀로 세면 그때부터 대비가 된다.
    // 거듭제곱을 씌워 마지막 한두 칸까지는 평온하게 둔다.
    const near = Math.pow(d, 2.4);
    const bpm = 54 + near*84;                       // 코앞에 와서야 급해진다
    const amp = 0.26 + Math.pow(d, 1.8)*0.74;
    thump(SND.hbNext, amp);
    thump(SND.hbNext + (60/bpm)*0.33, amp*0.55);   // 두 번째 박 (dub)
    if(d > 0.55) bloodRush(SND.hbNext, (d-0.55)*0.5);
    let gap = 60/bpm;
    // 부정맥 — 아주 가까우면 가끔 한 박이 어긋난다. 규칙적인 공포는 금방 배경이 된다.
    if(d > 0.7 && Math.random() < 0.16) gap *= (Math.random() < 0.5 ? 0.55 : 1.7);
    SND.hbNext += gap;
  }
  SND.hbTimer = setTimeout(hbTick, 90);
}

/* 속삭임 — 노이즈를 밴드패스로 훑으면 자음처럼 들린다.
   가끔 두 음절만 나오게 하는데, 그게 "까-꿍" 이다. */
export function whisper(){
  if(!SND.ctx) return;
  const c = SND.ctx, t0 = c.currentTime + 0.05;
  // 30% 는 '귀 바로 옆' — 잔향을 끊고 바짝 붙이면 방 안이 아니라 내 옆이 된다
  const inEar = Math.random() < 0.3;
  const pan = c.createStereoPanner();
  pan.pan.value = inEar ? (Math.random() < 0.5 ? -0.97 : 0.97) : (Math.random()*2 - 1)*0.9;
  const dry = c.createGain(); dry.gain.value = inEar ? 1.9 : 1;
  pan.connect(dry); dry.connect(inEar ? SND.gWhisNear : SND.gWhis);
  const kkakkung = Math.random() < 0.42;
  const syl = kkakkung ? [0.15, 0.26]
                       : [0.12, 0.09, 0.18, 0.11].slice(0, 2 + (Math.random()*3|0));
  let at = t0;
  syl.forEach((d, i) => {
    const n = noiseSrc(at, d + 0.06, false);
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = inEar ? 240 : 360;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = inEar ? 6 : 4.5;
    const f0 = kkakkung ? (i ? 820 : 1350) : 700 + Math.random()*900;
    bp.frequency.setValueAtTime(f0, at);
    bp.frequency.linearRampToValueAtTime(f0*(0.6 + Math.random()*0.7), at + d);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(inEar ? 0.55 : 0.42, at + d*0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, at + d);
    n.connect(hp); hp.connect(bp); bp.connect(g); g.connect(pan);
    at += d + 0.03 + Math.random()*0.06;
  });
}
export function scheduleWhisper(){
  // 규칙적이면 무섭지 않다. 간격을 넓게 흩뿌리고, 가까울수록 잦아진다.
  const gap = (4.5 + Math.random()*12) * (1 - dread()*0.5);
  SND.wsTimer = setTimeout(() => { whisper(); scheduleWhisper(); }, gap*1000);
}

/* 방 소리 — 이 게임에서 제일 무서운 층이다.
   그것과 무관하게, 아무 때나, 아무 데서나 난다. 원인을 모르는 소리가 제일 오래 남는다. */
export function farBus(){
  const c = SND.ctx;
  const pan = c.createStereoPanner(); pan.pan.value = (Math.random()*2 - 1)*0.95;
  const lp = c.createBiquadFilter(); lp.type = 'lowpass';
  lp.frequency.value = 700 + Math.random()*1400;   // 멀리 있는 소리는 고역이 먼저 죽는다
  lp.connect(pan); pan.connect(SND.gAmb);
  return lp;
}
export function knock(){
  const c = SND.ctx, out = farBus();
  let t = c.currentTime + 0.05;
  const hits = 2 + (Math.random()*3|0);
  for(let i=0;i<hits;i++){
    const o = c.createOscillator(); o.type = 'triangle';
    const f = 120 + Math.random()*90;
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f*0.45, t + 0.09);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.55 - i*0.06, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.18);
    const n = noiseSrc(t, 0.05, false);
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 1.4;
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.35, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    n.connect(bp); bp.connect(ng); ng.connect(out);
    t += 0.17 + Math.random()*0.26;   // 박자가 어긋나야 사람이 두드리는 것처럼 들린다
  }
}
export function drag(){
  const c = SND.ctx, out = farBus();
  const t = c.currentTime + 0.05, dur = 0.8 + Math.random()*1.1;
  const n = noiseSrc(t, dur + 0.2, true);
  const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.3;
  bp.frequency.setValueAtTime(900 + Math.random()*700, t);
  bp.frequency.exponentialRampToValueAtTime(220, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.5, t + 0.12);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  // 끌리다 걸리는 떨림 — 매끄러우면 바람이고, 걸려야 무거운 게 끌리는 소리가 된다
  const jit = c.createOscillator(); jit.frequency.value = 7 + Math.random()*9;
  const jg = c.createGain(); jg.gain.value = 0.22;
  jit.connect(jg); jg.connect(g.gain); jit.start(t); jit.stop(t + dur);
  n.connect(bp); bp.connect(g); g.connect(out);
}
export function creak(){
  const c = SND.ctx, out = farBus();
  const t = c.currentTime + 0.05, dur = 0.9 + Math.random()*0.9;
  const o = c.createOscillator(); o.type = 'sawtooth';
  const f = 150 + Math.random()*180;
  o.frequency.setValueAtTime(f, t);
  o.frequency.linearRampToValueAtTime(f*(1.5 + Math.random()), t + dur);
  const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1100; bp.Q.value = 7;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.30, t + 0.2);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  // 삐걱거림의 정체는 붙었다 미끄러지는 반복이다. 빠른 진폭 떨림으로 흉내낸다.
  const st = c.createOscillator(); st.frequency.value = 17 + Math.random()*22;
  const sg = c.createGain(); sg.gain.value = 0.5;
  st.connect(sg); sg.connect(g.gain); st.start(t); st.stop(t + dur);
  o.connect(bp); bp.connect(g); g.connect(out); o.start(t); o.stop(t + dur + 0.05);
}
export function scheduleRoom(){
  const r = Math.random();
  (r < 0.4 ? knock : r < 0.72 ? drag : creak)();
  SND.ambTimer = setTimeout(scheduleRoom, (7 + Math.random()*16)*1000);
}

/* 그것의 숨 — 가까워지면 들린다. 등 뒤에 있으면 어둡게, 오른쪽에 있으면 오른쪽에서.
   보이지 않는데 방향이 있는 소리가 화면 안의 무엇보다 무섭다. */
export function breath(level?, dir?){
  if(!SND.ctx) return;
  const d = level === undefined ? dread() : level;
  if(d < 0.18) return;
  const c = SND.ctx, out = spatial(dir);
  const t = c.currentTime + 0.05;
  const amp = 0.18 + d*0.6;
  // 들이쉬고(길게·높게) 내쉰다(짧게·낮게)
  [[0.62, 620, 1], [0.42, 330, 0.72]].forEach(([dur, f, k], i) => {
    const at = t + (i ? 0.72 : 0);
    const n = noiseSrc(at, dur + 0.08, false);
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(f, at);
    bp.frequency.exponentialRampToValueAtTime(f*(i ? 0.55 : 1.7), at + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(amp*k, at + dur*0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    // 젖은 떨림 — 목에 뭔가 걸린 소리
    const rat = c.createOscillator(); rat.frequency.value = 24 + Math.random()*14;
    const rg = c.createGain(); rg.gain.value = 0.35;
    rat.connect(rg); rg.connect(g.gain); rat.start(at); rat.stop(at + dur);
    n.connect(bp); bp.connect(g); g.connect(out);
  });
}
// 그것이 발을 끄는 소리 — 보이지 않을 때만. 보이면 눈이 답을 주므로 소리가 할 일이 없다.
export function creatureStep(level?, dir?){
  if(!SND.ctx) return;
  const lv = level === undefined ? dread() : level;
  const c = SND.ctx, out = spatial(dir), t = c.currentTime + 0.05;
  const n = noiseSrc(t, 0.5, true);
  const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.0;
  bp.frequency.setValueAtTime(700, t);
  bp.frequency.exponentialRampToValueAtTime(180, t + 0.42);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.4*lv), t + 0.06);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
  n.connect(bp); bp.connect(g); g.connect(out);
  const o = c.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(70, t + 0.36);
  o.frequency.exponentialRampToValueAtTime(34, t + 0.46);
  const og = c.createGain();
  og.gain.setValueAtTime(0.0001, t + 0.36);
  og.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.45*lv), t + 0.375);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
  o.connect(og); og.connect(out); o.start(t + 0.35); o.stop(t + 0.52);
}
/* 정직한 소리는 거리 측정기다. 읽을 수 있으면 대비할 수 있다.
   그래서 양쪽으로 거짓말을 시킨다:
     · 멀리 있어도 가끔 등 뒤 한 뼘에서 난 것처럼 (허풍)
     · 코앞에 있어도 가끔 아무 소리도 안 냄 (침묵이 안전을 뜻하지 않도록)
   어느 쪽도 믿을 수 없게 되면 그때부터 소리는 정보가 아니라 압박이 된다. */
export function scheduleBreath(){
  const d = dread();
  if(Math.random() < 0.22){
    const a = Math.random()*Math.PI*2;                       // 실제 위치와 무관한 방향
    const dir = { pan:Math.sin(a), front:Math.cos(a) };
    const lv = 0.5 + Math.random()*0.4;
    if(Math.random() < 0.5) creatureStep(lv, dir); else breath(lv, dir);
  } else if(d > 0.18 && Math.random() > 0.28){               // 가까워도 28% 는 침묵
    if(!SND.sighted && Math.random() < 0.45) creatureStep(); else breath();
  }
  // 간격이 거리에 비례해 짧아지면 그것도 눈금이다. 의존을 약하게 남긴다.
  SND.brTimer = setTimeout(scheduleBreath, (2.6 + Math.random()*5.5)*(1 - d*0.25)*1000);
}

/* 내 발소리 — 저역 쿵 + 바닥을 스치는 모래 두 겹 */
export function scuff(t, amp){
  const c = SND.ctx;
  const n = noiseSrc(t, 0.12, false);
  const bp = c.createBiquadFilter(); bp.type = 'bandpass';
  bp.frequency.value = 1700 + Math.random()*1100; bp.Q.value = 1.1;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(amp, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
  n.connect(bp); bp.connect(g); g.connect(SND.gStep);
}
export function footstep(back){
  if(!SND.ctx || !SND.onStep) return;
  const c = SND.ctx, t = c.currentTime + 0.02;
  const o = c.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime((back ? 74 : 92)*(0.94 + Math.random()*0.12), t);
  o.frequency.exponentialRampToValueAtTime(38, t + 0.1);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.55, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
  o.connect(g); g.connect(SND.gStep); o.start(t); o.stop(t + 0.19);
  scuff(t + 0.004, 0.32);
  scuff(t + 0.085, 0.14);
}
// 돌아설 때 옷깃 — 회전하는 쪽으로 패닝해서 방향감을 준다
export function rustle(side){
  if(!SND.ctx || !SND.onStep) return;
  const c = SND.ctx, t = c.currentTime + 0.02;
  const n = noiseSrc(t, 0.3, false);
  const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.9;
  bp.frequency.setValueAtTime(900, t);
  bp.frequency.exponentialRampToValueAtTime(2100, t + 0.22);
  const pan = c.createStereoPanner(); pan.pan.value = side === 'left' ? -0.6 : 0.6;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.18, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
  n.connect(bp); bp.connect(g); g.connect(pan); pan.connect(SND.gStep);
}

/* 스팅어 — 복도 끝에 그것이 서 있는 게 '처음' 보일 때만.
   매번 울리면 그건 배경음악이지 놀람이 아니다. */
export function creatureInSight(px: number, py: number, dir: number){
  const d = DIRS[dir]!;
  let x = px, y = py;
  for(let i=0;i<grid().length;i++){
    x += d.dx; y += d.dy;
    if(!walkable(x, y)) return false;
    if(x === CREATURE.x && y === CREATURE.y) return true;
  }
  return false;
}
export function sting(){
  if(!SND.ctx || !SND.onSting) return;
  const c = SND.ctx, t = c.currentTime + 0.01;
  if(t - SND.lastSting < 5) return;
  SND.lastSting = t;
  // 나머지를 깔아뭉갠다 — 소리를 키우는 것보다 주변을 죽이는 게 더 크게 들린다
  SND.bed.gain.cancelScheduledValues(t);
  SND.bed.gain.setTargetAtTime(0.18, t, 0.015);
  SND.bed.gain.setTargetAtTime(1.0, t + 1.1, 0.55);

  const ws = shaper(3.4);                       // 클러스터를 찢어 금속처럼 만든다
  ws.connect(SND.gSting);
  // 단2도·증4도로 쌓은 불협 클러스터 — 어떤 조성으로도 안 풀린다
  [233.1, 246.9, 329.6, 466.2, 493.9].forEach((f, i) => {
    const o = c.createOscillator(); o.type = i ? 'sawtooth' : 'square';
    o.frequency.setValueAtTime(f*(1 + Math.random()*0.012), t);
    o.frequency.exponentialRampToValueAtTime(f*0.5, t + 1.3);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.26/(i + 1), t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    o.connect(g); g.connect(ws); o.start(t); o.stop(t + 1.45);
  });
  // 서브 드롭 — 가슴을 치는 층
  const s = c.createOscillator(); s.type = 'sine';
  s.frequency.setValueAtTime(92, t);
  s.frequency.exponentialRampToValueAtTime(26, t + 1.0);
  const sg = c.createGain();
  sg.gain.setValueAtTime(0.0001, t);
  sg.gain.exponentialRampToValueAtTime(1.15, t + 0.03);
  sg.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
  s.connect(sg); sg.connect(SND.gSting); s.start(t); s.stop(t + 1.15);
  // 쇠 긁는 히스 한 겹
  const n = noiseSrc(t, 0.7, false);
  const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2700; bp.Q.value = 1.2;
  const ng = c.createGain();
  ng.gain.setValueAtTime(0.0001, t);
  ng.gain.exponentialRampToValueAtTime(0.42, t + 0.015);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
  n.connect(bp); bp.connect(ng); ng.connect(SND.gSting);
  // 꼬리 — 1.4초 뒤 잔향 속에서 한 번 더 훑고 사라진다
  const tail = noiseSrc(t + 1.2, 1.2, true);
  const tf = c.createBiquadFilter(); tf.type = 'bandpass'; tf.Q.value = 2.2;
  tf.frequency.setValueAtTime(1600, t + 1.2);
  tf.frequency.exponentialRampToValueAtTime(180, t + 2.3);
  const tg = c.createGain();
  tg.gain.setValueAtTime(0.0001, t + 1.2);
  tg.gain.exponentialRampToValueAtTime(0.2, t + 1.3);
  tg.gain.exponentialRampToValueAtTime(0.0001, t + 2.3);
  tail.connect(tf); tf.connect(tg); tg.connect(SND.gSting);
}
// 이동·회전이 끝난 시점에만 검사한다. 시야에 '들어온 순간' 한 번만 터뜨리기 위해서다.
export function sndSight(px: number, py: number, dir: number){
  if(online) return;                 // 멀티에서는 서버가 보내준 조우로 판정한다
  const now = creatureInSight(px, py, dir);
  if(now && !SND.sighted) sting();
  SND.sighted = now;
}

/* 상태를 오디오 그래프에 반영. ctx 가 없으면 값만 기억해 둔다. */
export function applyVol(){
  if(!SND.ctx) return;
  const t = SND.ctx.currentTime, v = SND.vol;
  SND.master.gain.setTargetAtTime(SND.muted ? 0 : v.master, t, 0.05);
  SND.gDrone.gain.setTargetAtTime(v.drone*0.85, t, 0.1);
  SND.gRoom.gain.setTargetAtTime(v.drone*0.5,  t, 0.1);
  SND.gHeart.gain.setTargetAtTime(v.heart*0.9, t, 0.1);
  SND.gWhis.gain.setTargetAtTime(v.whisper*0.85, t, 0.1);
  SND.gWhisNear.gain.setTargetAtTime(v.whisper*0.95, t, 0.1);
  SND.gAmb.gain.setTargetAtTime(v.amb*0.9, t, 0.1);
  SND.gStep.gain.setTargetAtTime(0.8, t, 0.1);
  SND.gSting.gain.setTargetAtTime(0.95, t, 0.1);
}
// 가까울수록 드론이 밝아진다 — 커지는 게 아니라 '드러난다'
export function sndDread(d){
  if(!SND.ctx) return;
  const t = SND.ctx.currentTime;
  // 밝아지는 폭을 좁힌다. 연속적으로 밝아지는 드론은 거리계 바늘과 같다.
  const near = Math.pow(d, 3);
  SND.droneLp.frequency.setTargetAtTime(195 + near*260, t, 0.6);
  SND.gDrone.gain.setTargetAtTime(SND.vol.drone*(0.85 + near*0.25), t, 0.6);
}
export function sndPill(){
  const live = !!(SND.ctx && SND.ctx.state === 'running' && !SND.muted);
  const p = $('pAudio');
  p.textContent = live ? '소리 켜짐' : (SND.ctx ? '소리 멈춤' : '소리 꺼짐');
  p.classList.toggle('on', live);
  $('sndOn').textContent = live ? '소리 끄기' : '소리 켜기';
}

