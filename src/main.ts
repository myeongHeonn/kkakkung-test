import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as Colyseus from 'colyseus.js';
import type {
  Action, GameEvent, JoinOptions, LobbyInfo, PlayerView, ServerMessages, SeenPlayer,
} from '../shared/protocol.ts';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs';

/* 워커 추론 경로 — 현재 보류. face-worker.js 는 로드되지만 프레임이 흐르지 않는
   상태에서 원인을 특정하지 못했다. 메인 스레드 추론으로 충분하다고 판단해
   UI 옵션을 제거했다. 배경과 재검토 조건은 구현계획.md S2 에 기록. */
const WORKER_URL = 'face-worker.js';
const WASM  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';
// TODO(모듈 분할): 각 모듈이 HTMLInputElement 등 구체 타입으로 좁힌다
const $ = (id: string): any => document.getElementById(id);
// alert 는 실행을 막고 원인 파악을 방해한다. 화면에 남겨서 읽을 수 있게 한다.
function showErr(title, msg){
  const el = $('err');
  el.innerHTML = '<b>' + title + '</b><br>' + String(msg).replace(/</g,'&lt;') +
    '<button onclick="this.parentNode.classList.remove(\'show\')">닫기</button>';
  el.classList.add('show');
  console.error('[까꿍]', title, msg);
}

/* ══ 공간 규약 (구현계획.md S0) ═════════════════════ */
const CELL = 3.0, WALL_H = 3.2, EYE = 1.6;
let GRID = ['#######','#.....#','#.###.#','#.....#','#.#.#.#','#.....#','#######'];
const START = { x:3, y:5, dir:1 };
const CREATURE = { x:5, y:2 };
const DIRS = [{dx:0,dy:-1},{dx:1,dy:0},{dx:0,dy:1},{dx:-1,dy:0}];
const walkable = (x,y) => GRID[y] && GRID[y][x] && GRID[y][x] !== '#';
const wx = g => g * CELL, wz = g => g * CELL;

/* ══ 절차적 텍스처 ════════════════════════════════ */
function fractalNoise(size, octaves){
  const h = new Float32Array(size*size); let amp = 1, tot = 0;
  for(let o=0;o<octaves;o++){
    const st = Math.max(1, size >> (o+2)), gw = Math.ceil(size/st)+2;
    const g = new Float32Array(gw*gw);
    for(let i=0;i<g.length;i++) g[i] = Math.random();
    for(let y=0;y<size;y++) for(let x=0;x<size;x++){
      const fx=x/st, fy=y/st, ix=Math.floor(fx), iy=Math.floor(fy);
      const tx=fx-ix, ty=fy-iy, sx=tx*tx*(3-2*tx), sy=ty*ty*(3-2*ty);
      const a=g[iy*gw+ix], b=g[iy*gw+ix+1], c=g[(iy+1)*gw+ix], d=g[(iy+1)*gw+ix+1];
      const t0=a+(b-a)*sx, t1=c+(d-c)*sx;
      h[y*size+x] += amp*(t0+(t1-t0)*sy);
    }
    tot += amp; amp *= 0.5;
  }
  for(let i=0;i<h.length;i++) h[i] /= tot;
  return h;
}
function texFrom(h, size, mode, tint?){
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(size,size), d = img.data;
  const at = (x,y) => h[((y+size)%size)*size + ((x+size)%size)];
  for(let y=0;y<size;y++) for(let x=0;x<size;x++){
    const i=(y*size+x)*4, v=at(x,y);
    if(mode==='albedo'){
      const s = (0.42 + v*0.5) * (0.86 + 0.14*Math.sin(x*0.09 + v*7));
      d[i]=tint[0]*s; d[i+1]=tint[1]*s; d[i+2]=tint[2]*s; d[i+3]=255;
    } else if(mode==='normal'){
      const nx=(at(x-1,y)-at(x+1,y))*5.5, ny=(at(x,y-1)-at(x,y+1))*5.5, L=Math.hypot(nx,ny,1);
      d[i]=(nx/L*0.5+0.5)*255; d[i+1]=(ny/L*0.5+0.5)*255; d[i+2]=(1/L*0.5+0.5)*255; d[i+3]=255;
    } else {
      const r=(1-v)*0.45+0.5; d[i]=d[i+1]=d[i+2]=r*255; d[i+3]=255;
    }
  }
  ctx.putImageData(img,0,0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if(mode==='albedo') t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function surface(size, oct, tint, rep?){
  const h = fractalNoise(size, oct);
  const map = texFrom(h,size,'albedo',tint);
  const normalMap = texFrom(h,size,'normal');
  const roughnessMap = texFrom(h,size,'rough');
  [map,normalMap,roughnessMap].forEach(t=>{ t.repeat.set(rep,rep); t.anisotropy = 8; });
  return { map, normalMap, roughnessMap };
}

/* ══ 씬 ═══════════════════════════════════════════ */
const renderer = new THREE.WebGLRenderer({ antialias:true, powerPreference:'high-performance' });
renderer.domElement.id = 'gl';
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const FOG = 0x050303;
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(FOG, 0.105);
scene.background = new THREE.Color(FOG);

const camera = new THREE.PerspectiveCamera(72, innerWidth/innerHeight, 0.1, 60);
camera.position.set(wx(START.x), EYE, wz(START.y));
scene.add(camera);

const ambient = new THREE.AmbientLight(0xa9b4c8, 0.03); scene.add(ambient);
const flashlight = new THREE.SpotLight(0xffd2a0, 34, 17, 0.78, 0.7, 1.5);
flashlight.castShadow = true;
flashlight.shadow.mapSize.set(768,768);
flashlight.shadow.camera.near = 0.4; flashlight.shadow.camera.far = 18;
flashlight.shadow.bias = -0.0035;
camera.add(flashlight); camera.add(flashlight.target);
flashlight.target.position.set(0,0,-1);
camera.add(new THREE.PointLight(0xffc890, 1.1, 5.5, 2.0));

const wallSurf = surface(256,5,[206,198,186],1);
const floorSurf = surface(256,5,[150,142,132],7);
const ceilSurf = surface(256,4,[120,114,108],7);
const wallMat = new THREE.MeshStandardMaterial(Object.assign({},wallSurf,
  { roughness:1, metalness:0, normalScale:new THREE.Vector2(1.3,1.3) }));
const floorMat = new THREE.MeshStandardMaterial(Object.assign({},floorSurf,
  { roughness:1, metalness:0, normalScale:new THREE.Vector2(1.1,1.1) }));
const ceilMat = new THREE.MeshStandardMaterial(Object.assign({},ceilSurf,
  { roughness:1, metalness:0 }));

const SPAN = GRID.length*CELL, plane = new THREE.PlaneGeometry(SPAN,SPAN);
const floor = new THREE.Mesh(plane, floorMat);
floor.rotation.x = -Math.PI/2;
floor.position.set(SPAN/2-CELL/2, 0, SPAN/2-CELL/2);
floor.receiveShadow = true; scene.add(floor);
const ceil = new THREE.Mesh(plane, ceilMat);
ceil.rotation.x = Math.PI/2;
ceil.position.set(SPAN/2-CELL/2, WALL_H, SPAN/2-CELL/2);
ceil.receiveShadow = true; scene.add(ceil);

const box = new THREE.BoxGeometry(CELL, WALL_H, CELL);
let wallMesh = null;
/* 미로는 판마다 서버가 새로 준다. 다시 세울 수 있어야 한다.

   벽 하나에 메시 하나를 쓰면 19×19 에서 180개가 되고, 손전등 그림자가
   그 전부를 매 프레임 다시 그린다. InstancedMesh 로 묶으면 드로우콜이 1개다.
   사방이 벽인 칸은 어차피 안 보이므로 만들지 않는다. */
function rebuildMaze(){
  if(wallMesh){ scene.remove(wallMesh); wallMesh.dispose(); wallMesh = null; }
  const spots = [];
  for(let y=0;y<GRID.length;y++) for(let x=0;x<GRID[y].length;x++){
    if(GRID[y][x] !== '#') continue;
    if(!DIRS.some(d => walkable(x+d.dx, y+d.dy))) continue;
    spots.push([x, y]);
  }
  wallMesh = new THREE.InstancedMesh(box, wallMat, Math.max(1, spots.length));
  wallMesh.castShadow = true; wallMesh.receiveShadow = true;
  const t = new THREE.Object3D();
  spots.forEach(([x, y], i) => {
    t.position.set(wx(x), WALL_H/2, wz(y));
    t.updateMatrix();
    wallMesh.setMatrixAt(i, t.matrix);
  });
  wallMesh.count = spots.length;
  wallMesh.instanceMatrix.needsUpdate = true;
  wallMesh.frustumCulled = false;          // 인스턴스 전체를 감싸는 경계구가 없어 오판한다
  scene.add(wallMesh);

  const span = GRID.length*CELL, k = span/SPAN;
  floor.scale.set(k, k, 1); ceil.scale.set(k, k, 1);
  floor.position.set(span/2-CELL/2, 0, span/2-CELL/2);
  ceil.position.set(span/2-CELL/2, WALL_H, span/2-CELL/2);
}
rebuildMaze();

/* 그것 — 대두 + 길고 가는 팔다리 (기획서 §2.4) */
const dark = new THREE.MeshStandardMaterial({ color:0x0d0b0b, roughness:0.95 });
const skin = new THREE.MeshStandardMaterial({ color:0x8a7f74, roughness:0.72 });
const creature = new THREE.Group();
const head = new THREE.Mesh(new THREE.SphereGeometry(0.56,28,20), skin);
head.scale.set(0.94,1.14,0.9); head.position.y = 2.16;
const torso = new THREE.Mesh(new THREE.BoxGeometry(0.34,0.74,0.22), dark);
torso.position.y = 1.18;
creature.add(head); creature.add(torso);
const armGeo = new THREE.CylinderGeometry(0.055,0.042,1.16,8);
[[-0.24,0.16],[0.24,-0.16]].forEach(p => {
  const a = new THREE.Mesh(armGeo, dark);
  a.position.set(p[0],0.98,0); a.rotation.z = p[1]; creature.add(a);
});
const legGeo = new THREE.CylinderGeometry(0.06,0.05,1.5,8);
[[-0.12,0.05],[0.12,-0.05]].forEach(p => {
  const l = new THREE.Mesh(legGeo, dark);
  l.position.set(p[0],0.75,0); l.rotation.z = p[1]; creature.add(l);
});

/* 얼굴 — 웹캠을 캔버스로 크롭·그레이스케일해서 머리 앞면에 붙인다.
   MeshStandardMaterial 이므로 손전등이 비출 때만 드러난다. */
const faceCv = document.createElement('canvas'); faceCv.width = faceCv.height = 256;
const fctx = faceCv.getContext('2d');
fctx.fillStyle = '#8a7f74'; fctx.fillRect(0,0,256,256);
const faceTexture = new THREE.CanvasTexture(faceCv);
faceTexture.colorSpace = THREE.SRGBColorSpace;
const faceMat = new THREE.MeshStandardMaterial({ map:faceTexture, roughness:0.68 });
const facePlane = new THREE.Mesh(new THREE.PlaneGeometry(0.95,1.15), faceMat);
facePlane.name = 'face';          // 클론에서 찾아 상대 얼굴로 갈아끼운다
let facePainted = false;          // 한 번이라도 실제 얼굴이 그려졌는가
facePlane.position.set(0, 2.16, 0.44);
facePlane.visible = false;
creature.add(facePlane);

creature.traverse(o => { if((o as THREE.Mesh).isMesh) o.castShadow = true; });
creature.position.set(wx(CREATURE.x), 0, wz(CREATURE.y));
scene.add(creature);

/* ══ 후처리 ═══════════════════════════════════════ */
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth/2, innerHeight/2), 0.25, 0.6, 0.85);
composer.addPass(bloom);
// 블룸은 밉 체인을 여러 번 블러하므로 후처리 중 가장 비싸다.
// 절반 해상도로 돌려도 육안 차이가 거의 없고 비용은 1/4이 된다.
const sizeBloomHalf = () => bloom.setSize(innerWidth/2, innerHeight/2);
const grade = new ShaderPass({
  uniforms:{ tDiffuse:{value:null}, uTime:{value:0}, uGrain:{value:0.085},
             uVig:{value:0.8}, uAberr:{value:0.0022} },
  vertexShader:[
    'varying vec2 vUv;',
    'void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }'
  ].join('\n'),
  fragmentShader:[
    'uniform sampler2D tDiffuse; uniform float uTime,uGrain,uVig,uAberr; varying vec2 vUv;',
    'float rand(vec2 c){ return fract(sin(dot(c,vec2(12.9898,78.233)))*43758.5453); }',
    'void main(){',
    '  vec2 d = vUv - 0.5; vec2 off = d * uAberr;',
    '  vec4 c = vec4(texture2D(tDiffuse,vUv+off).r, texture2D(tDiffuse,vUv).g,',
    '                texture2D(tDiffuse,vUv-off).b, 1.0);',
    '  c.rgb *= mix(1.0, smoothstep(0.92,0.22,length(d)), uVig);',
    '  c.rgb += (rand(vUv*vec2(1920.0,1080.0)+uTime)-0.5) * uGrain;',
    '  gl_FragColor = c;',
    '}'
  ].join('\n')
});
composer.addPass(grade);
composer.addPass(new OutputPass());
let postOn = true;

/* ══ One Euro Filter ══════════════════════════════ */
class LowPass {
  s: number | null;
  constructor(){ this.s = null; }
  filter(x: number, a: number): number { this.s = (this.s===null) ? x : a*x + (1-a)*this.s; return this.s; }
}
class OneEuro {
  mincutoff: number; beta: number; dcutoff: number;
  x: LowPass; dx: LowPass;
  prev: number | null; prevT: number | null;
  constructor(mincutoff = 1.0, beta = 0.007, dcutoff = 1.0){
    this.mincutoff = mincutoff; this.beta = beta; this.dcutoff = dcutoff;
    this.x = new LowPass(); this.dx = new LowPass(); this.prev = null; this.prevT = null;
  }
  alpha(cut: number, dt: number): number { const tau = 1/(2*Math.PI*cut); return 1/(1+tau/dt); }
  filter(v: number, t: number): number {
    const dt = (this.prevT===null) ? 1/30 : Math.max(1e-3, t-this.prevT);
    this.prevT = t;
    const dv = (this.prev===null) ? 0 : (v-this.prev)/dt;
    this.prev = v;
    const edv = this.dx.filter(dv, this.alpha(this.dcutoff,dt));
    return this.x.filter(v, this.alpha(this.mincutoff + this.beta*Math.abs(edv), dt));
  }
}
const fYaw = new OneEuro(), fPitch = new OneEuro(), fSize = new OneEuro();

class Gate {
  armed: boolean; until: number; pill: any;
  constructor(pill: any){ this.armed = true; this.until = 0; this.pill = pill; }
  // hold=true 면 중립 복귀 없이 쿨다운마다 재발동한다.
  // 전진은 hold, 회전은 재장전 — 계속 돌아가면 안 되므로.
  update(v: number, trig: number, rel: number, cool: number, now: number,
         fire: (sign: number) => void, hold: boolean){
    if(now < this.until){ this.paint(hold ? '반복' : '쿨다운'); return; }
    if(Math.abs(v) >= trig && (this.armed || hold)){
      this.armed = false; this.until = now + cool; fire(Math.sign(v));
    }
    if(!this.armed && Math.abs(v) < rel) this.armed = true;
    this.paint(hold ? (Math.abs(v) >= trig ? '반복' : '대기') : (this.armed ? '장전' : '해제'));
  }
  paint(t: string){
    this.pill.textContent = t;
    this.pill.classList.toggle('on', t === '장전' || t === '반복');
  }
}
const gateYaw = new Gate($('pYawArm')), gateSize = new Gate($('pSizeArm'));

/* ══ 한 칸 이동 ═══════════════════════════════════ */
const player = { x:START.x, y:START.y, dir:START.dir };
let anim = null, bob = 0;
const ease = t => t<0.5 ? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2;
let camYaw = -START.dir*Math.PI/2;

function step(sign){
  // 멀티에서는 서버가 판정한다. 여기서 움직이면 화면만 거짓말을 하게 된다.
  if(NET.on){ mpSend(sign > 0 ? 'forward' : 'back'); return false; }
  if(anim) return false;
  const d = DIRS[player.dir];
  const nx = player.x + d.dx*sign, ny = player.y + d.dy*sign;
  if(!walkable(nx,ny) || (nx===CREATURE.x && ny===CREATURE.y)) return false;
  anim = { kind:'move', t:0, fx:wx(player.x), fz:wz(player.y), tx:wx(nx), tz:wz(ny) };
  player.x = nx; player.y = ny;
  footstep(sign < 0); mapMark(); mapDraw();
  return true;
}
function turn(side){
  if(NET.on){ mpSend(side); return false; }
  if(anim) return false;
  player.dir = (player.dir + (side==='left'?3:1))%4;
  anim = { kind:'turn', t:0, from:camYaw, to:camYaw + (side==='left'?Math.PI/2:-Math.PI/2) };
  rustle(side); mapDraw();
  return true;
}
addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if(k === 'h'){
    document.querySelectorAll('.panel,#hint,#minimap').forEach(n => n.classList.toggle('hidden'));
    return;
  }
  const m = { arrowup:()=>step(1), w:()=>step(1), arrowdown:()=>step(-1), s:()=>step(-1),
              arrowleft:()=>turn('left'), a:()=>turn('left'),
              arrowright:()=>turn('right'), d:()=>turn('right') };
  if(m[k]){ e.preventDefault(); m[k](); }
});

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
const SND = {
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
function makeNoise(sec, brown){
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
function makeIR(sec, decay){
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
function noiseSrc(t, dur, brown?){
  const c = SND.ctx, n = c.createBufferSource();
  n.buffer = brown ? SND.brown : SND.white;
  n.loop = true;
  n.start(t, Math.random()*(n.buffer.duration - 0.05));
  n.stop(t + dur);
  return n;
}
// tanh 커브 — 깨끗한 사인을 살짝 찢어서 '기계가 아닌 것'처럼 만든다
function shaper(amount){
  const n = 1024, curve = new Float32Array(n);
  for(let i=0;i<n;i++) curve[i] = Math.tanh((i*2/n - 1)*amount);
  const ws = SND.ctx.createWaveShaper();
  ws.curve = curve; ws.oversample = '2x';
  return ws;
}
// 레이어 하나 = 자기 볼륨 노드 + 리버브 센드. bed 에 붙은 층만 스팅어에 눌린다.
function sndBus(send, direct?){
  const c = SND.ctx, g = c.createGain();
  g.connect(direct ? SND.master : SND.bed);
  if(send > 0){ const s = c.createGain(); s.gain.value = send; g.connect(s); s.connect(SND.verb); }
  return g;
}

function sndStart(){
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
function buildDrone(){
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
function dread(){
  // 멀티 도망자에게는 그것과의 거리가 아니라 탈출구까지의 거리가 심장을 뛰게 한다 (§4.3 ③)
  const nd = netDread();
  if(nd !== null) return nd;
  const dx = camera.position.x - creature.position.x;
  const dz = camera.position.z - creature.position.z;
  const cells = Math.hypot(dx, dz)/CELL;
  return Math.max(0, Math.min(1, 1 - (cells - 0.7)/4.3));
}
/* 그것이 내 기준 어느 쪽에 있는가. 스테레오만으로는 앞뒤를 못 만들기 때문에
   뒤쪽이면 로우패스를 내려 어둡게 만든다 — 실제로 귀가 앞뒤를 가르는 단서가 그거다. */
function creatureDir(){
  const dx = creature.position.x - camera.position.x;
  const dz = creature.position.z - camera.position.z;
  const len = Math.max(1e-4, Math.hypot(dx, dz));
  const y = camera.rotation.y, sy = Math.sin(y), cy = Math.cos(y);
  return {
    pan:  (dx*cy - dz*sy)/len,       // 오른쪽 성분
    front:(-dx*sy - dz*cy)/len,      // 앞쪽 성분 (음수면 등 뒤)
  };
}
function spatial(dir?){
  const c = SND.ctx, d = dir || creatureDir();
  const pan = c.createStereoPanner(); pan.pan.value = Math.max(-1, Math.min(1, d.pan*0.95));
  const lp = c.createBiquadFilter(); lp.type = 'lowpass';
  lp.frequency.value = d.front > 0 ? 5200 : 1500;   // 등 뒤는 어둡게
  lp.connect(pan); pan.connect(SND.gAmb);
  return lp;
}

/* 심장박동 — setInterval 로 찍으면 박자가 밀린다.
   오디오 시계로 200ms 앞을 미리 예약하고 타이머는 그 예약만 채운다. */
function thump(t, amp){
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
function bloodRush(t, amp){
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
function hbTick(){
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
function whisper(){
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
function scheduleWhisper(){
  // 규칙적이면 무섭지 않다. 간격을 넓게 흩뿌리고, 가까울수록 잦아진다.
  const gap = (4.5 + Math.random()*12) * (1 - dread()*0.5);
  SND.wsTimer = setTimeout(() => { whisper(); scheduleWhisper(); }, gap*1000);
}

/* 방 소리 — 이 게임에서 제일 무서운 층이다.
   그것과 무관하게, 아무 때나, 아무 데서나 난다. 원인을 모르는 소리가 제일 오래 남는다. */
function farBus(){
  const c = SND.ctx;
  const pan = c.createStereoPanner(); pan.pan.value = (Math.random()*2 - 1)*0.95;
  const lp = c.createBiquadFilter(); lp.type = 'lowpass';
  lp.frequency.value = 700 + Math.random()*1400;   // 멀리 있는 소리는 고역이 먼저 죽는다
  lp.connect(pan); pan.connect(SND.gAmb);
  return lp;
}
function knock(){
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
function drag(){
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
function creak(){
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
function scheduleRoom(){
  const r = Math.random();
  (r < 0.4 ? knock : r < 0.72 ? drag : creak)();
  SND.ambTimer = setTimeout(scheduleRoom, (7 + Math.random()*16)*1000);
}

/* 그것의 숨 — 가까워지면 들린다. 등 뒤에 있으면 어둡게, 오른쪽에 있으면 오른쪽에서.
   보이지 않는데 방향이 있는 소리가 화면 안의 무엇보다 무섭다. */
function breath(level?, dir?){
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
function creatureStep(level?, dir?){
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
function scheduleBreath(){
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
function scuff(t, amp){
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
function footstep(back){
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
function rustle(side){
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
function creatureInSight(){
  const d = DIRS[player.dir];
  let x = player.x, y = player.y;
  for(let i=0;i<GRID.length;i++){
    x += d.dx; y += d.dy;
    if(!walkable(x, y)) return false;
    if(x === CREATURE.x && y === CREATURE.y) return true;
  }
  return false;
}
function sting(){
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
function sndSight(){
  if(NET.on) return;                 // 멀티에서는 서버가 보내준 조우로 판정한다
  const now = creatureInSight();
  if(now && !SND.sighted) sting();
  SND.sighted = now;
}

/* 상태를 오디오 그래프에 반영. ctx 가 없으면 값만 기억해 둔다. */
function applyVol(){
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
function sndDread(d){
  if(!SND.ctx) return;
  const t = SND.ctx.currentTime;
  // 밝아지는 폭을 좁힌다. 연속적으로 밝아지는 드론은 거리계 바늘과 같다.
  const near = Math.pow(d, 3);
  SND.droneLp.frequency.setTargetAtTime(195 + near*260, t, 0.6);
  SND.gDrone.gain.setTargetAtTime(SND.vol.drone*(0.85 + near*0.25), t, 0.6);
}
function sndPill(){
  const live = !!(SND.ctx && SND.ctx.state === 'running' && !SND.muted);
  const p = $('pAudio');
  p.textContent = live ? '소리 켜짐' : (SND.ctx ? '소리 멈춤' : '소리 꺼짐');
  p.classList.toggle('on', live);
  $('sndOn').textContent = live ? '소리 끄기' : '소리 켜기';
}

/* ══ 그래프 ═══════════════════════════════════════ */
function makeGraph(cv){
  const ctx = cv.getContext('2d'), raw = [], fil = [], N = 150;
  const resize = () => { cv.width = cv.clientWidth*devicePixelRatio; cv.height = cv.clientHeight*devicePixelRatio; };
  resize(); addEventListener('resize', resize);
  return {
    push(r,f){ raw.push(r); fil.push(f); if(raw.length>N){ raw.shift(); fil.shift(); } },
    draw(trig,rel,scale){
      const w = cv.width, h = cv.height, mid = h/2, y = v => mid-(v/scale)*(h/2)*0.9;
      ctx.clearRect(0,0,w,h);
      ctx.lineWidth = devicePixelRatio;
      ctx.setLineDash([3*devicePixelRatio,3*devicePixelRatio]);
      [[trig,'#b81d24'],[-trig,'#b81d24'],[rel,'#4a4342'],[-rel,'#4a4342']].forEach(p => {
        ctx.strokeStyle = p[1]; ctx.beginPath(); ctx.moveTo(0,y(p[0])); ctx.lineTo(w,y(p[0])); ctx.stroke();
      });
      ctx.setLineDash([]);
      ctx.strokeStyle = '#3a3332'; ctx.beginPath(); ctx.moveTo(0,mid); ctx.lineTo(w,mid); ctx.stroke();
      const line = (arr,c,lw) => {
        ctx.strokeStyle = c; ctx.lineWidth = lw*devicePixelRatio; ctx.beginPath();
        arr.forEach((v,i) => { const px = (i/(N-1))*w; i ? ctx.lineTo(px,y(v)) : ctx.moveTo(px,y(v)); });
        ctx.stroke();
      };
      line(raw,'#5c5250',1); line(fil,'#cfc6b4',1.7);
    }
  };
}
const graphYaw = makeGraph($('gYaw')), graphSize = makeGraph($('gSize'));

/* ══ UI 배선 ══════════════════════════════════════ */
const P: Record<string, number> = {};
function bind(id, fmt, fn?){
  const el = $(id), out = $(id+'v');
  const run = () => { P[id] = parseFloat(el.value); if(out) out.textContent = fmt(P[id]); if(fn) fn(P[id]); };
  el.addEventListener('input', run); run();
}
bind('mincut', v => v.toFixed(2), v => [fYaw,fPitch,fSize].forEach(f => f.mincutoff = v));
bind('beta',   v => v.toFixed(3), v => [fYaw,fPitch,fSize].forEach(f => f.beta = v));
bind('yTrig',  v => v.toFixed(2));
bind('yRel',   v => v.toFixed(2));
bind('sTrig',  v => v.toFixed(2));
bind('sRel',   v => v.toFixed(3));
bind('cool',   v => String(v));
bind('peekAmt',v => String(v));
bind('fog',    v => String(v), v => (scene.fog as THREE.FogExp2).density = v);
bind('lamp',   v => String(v), v => flashlight.intensity = v);
bind('amb',    v => v.toFixed(3), v => ambient.intensity = v);
$('tPost').onchange = e => { postOn = (e.target as HTMLInputElement).checked; bloom.enabled = postOn; grade.enabled = postOn; };
bind('inferHz', v => String(v));
bind('peekTau', v => v.toFixed(2));
bind('vMaster', v => v.toFixed(2), v => { SND.vol.master  = v; applyVol(); });
bind('vDrone',  v => v.toFixed(2), v => { SND.vol.drone   = v; applyVol(); });
bind('vHeart',  v => v.toFixed(2), v => { SND.vol.heart   = v; applyVol(); });
bind('vWhis',   v => v.toFixed(2), v => { SND.vol.whisper = v; applyVol(); });
bind('vAmb',    v => v.toFixed(2), v => { SND.vol.amb     = v; applyVol(); });
$('sStep').onchange  = e => SND.onStep  = (e.target as HTMLInputElement).checked;
$('sSting').onchange = e => SND.onSting = (e.target as HTMLInputElement).checked;
$('sndOn').addEventListener('click', () => {
  if(!SND.ctx){ SND.muted = false; sndStart(); return; }
  SND.muted = !SND.muted; applyVol(); sndPill();
});
/* 자동재생 정책 때문에 AudioContext 는 첫 사용자 제스처 안에서만 만들 수 있다.
   무엇을 눌렀든 그 순간을 쓴다 — 단, 소리 버튼 자신은 제외한다.
   그러지 않으면 pointerdown 이 켜고 click 이 곧바로 꺼버린다. */
const sndUnlock = e => {
  if(e.target && e.target.closest && e.target.closest('#sndOn')) return;
  removeEventListener('pointerdown', sndUnlock);
  removeEventListener('keydown', sndUnlock);
  if(!SND.muted) sndStart();
};
addEventListener('pointerdown', sndUnlock);
addEventListener('keydown', sndUnlock);
// 탭을 벗어나면 멈춘다. 보이지도 않는 창에서 계속 속삭이면 그건 버그다.
document.addEventListener('visibilitychange', () => {
  if(!SND.ctx) return;
  if(document.hidden) SND.ctx.suspend().then(sndPill);
  else if(!SND.muted) SND.ctx.resume().then(sndPill);
});
sndPill();
function applyPixelRatio(){
  renderer.setPixelRatio(parseFloat($('pxRatio').value));
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  sizeBloomHalf();
}
$('pxRatio').onchange = applyPixelRatio;
['thread','delegate','useBlend'].forEach(id => {
  $(id).addEventListener('change', () => {
    landmarker = null;                       // 옵션은 생성 시점에 굳으므로 버린다
    if(stream) $('start').textContent = '카메라 다시 시작 필요';
  });
});
// 무엇이 지원되는지 화면에 남긴다 — 실패 원인 파악용
$('diag').innerHTML = [
  'TrackProcessor <b>' + (typeof (globalThis as any).MediaStreamTrackProcessor !== 'undefined' ? '있음' : '없음') + '</b>',
  'OffscreenCanvas <b>' + (typeof OffscreenCanvas !== 'undefined' ? '있음' : '없음') + '</b>',
  'createImageBitmap <b>' + (typeof createImageBitmap !== 'undefined' ? '있음' : '없음') + '</b>',
].join(' · ');
$('fast').addEventListener('click', () => {
  // 자동 조절과 싸우지 않도록 '최저 고정' 으로 넘긴다.
  // 자동인 채로 여기서 값만 낮추면 다음 판정에서 도로 올라가 버린다.
  $('quality').value = 'low';
  $('quality').onchange({ target:$('quality') });
  $('inferHz').value = '12'; $('inferHz').dispatchEvent(new Event('input'));
  $('fast').textContent = '최저 고정됨 — 품질을 자동으로 되돌릴 수 있다';
});
$('tShadow').onchange = e => {
  renderer.shadowMap.enabled = (e.target as HTMLInputElement).checked;
  scene.traverse(o => { if((o as THREE.Mesh).isMesh) ((o as THREE.Mesh).material as THREE.Material).needsUpdate = true; });
};
/* ══ 자동 품질 조절 ═══════════════════════════════
   팀원마다 노트북이 다르다. 기본값을 낮추면 좋은 기기가 손해를 보고,
   높게 두면 약한 기기는 아예 못 논다. 그래서 프레임을 재서 스스로 내려간다.

   핵심은 '무엇이 느린가'를 구분하는 것이다:
     · 추론 ms 가 크면 메인 스레드가 막힌 것 — 추론 주기를 줄여야 한다
     · 그 외에 프레임이 길면 GPU 가 밀리는 것 — 해상도·후처리·그림자를 줄여야 한다
   구분하지 않고 한꺼번에 낮추면 안 잃어도 될 것까지 잃는다.

   내려가는 순서는 '눈에 덜 띄는 것부터'다. 해상도 1.25→1.0 은 거의 티가 안 나고,
   그림자를 끄는 건 손전등 연출이 통째로 바뀌므로 마지막에 가깝다. */
const LADDER = [
  { px:'1.25', post:true,  shadow:true,  map:768, label:'최고' },
  { px:'1',    post:true,  shadow:true,  map:768, label:'높음' },
  { px:'1',    post:true,  shadow:true,  map:512, label:'높음−' },
  { px:'1',    post:false, shadow:true,  map:512, label:'중간' },
  { px:'1',    post:false, shadow:false, map:512, label:'낮음' },
  { px:'0.75', post:false, shadow:false, map:512, label:'최저' },
];
const AQ = { auto:true, lv:0, last:0, hold:0 };

function applyLadder(i){
  i = Math.max(0, Math.min(LADDER.length - 1, i));
  const s = LADDER[i];
  AQ.lv = i;
  $('pxRatio').value = s.px; applyPixelRatio();
  $('tPost').checked = s.post;    $('tPost').onchange({ target:$('tPost') });
  $('tShadow').checked = s.shadow; $('tShadow').onchange({ target:$('tShadow') });
  if(flashlight.shadow.mapSize.x !== s.map){
    flashlight.shadow.mapSize.set(s.map, s.map);
    // 이미 만들어진 그림자 맵은 크기가 굳어 있다. 버려야 새 크기로 다시 만든다.
    if(flashlight.shadow.map){ flashlight.shadow.map.dispose(); flashlight.shadow.map = null; }
  }
  qualPill();
}
function qualPill(){
  const p = $('pQual');
  p.textContent = '품질 ' + LADDER[AQ.lv].label + (AQ.auto ? '' : ' (고정)');
  p.classList.toggle('warn', AQ.lv >= 4);
}

/* 0.5초마다 한 번씩 불린다. 잦게 손대면 화면이 계속 깜빡이므로 간격을 둔다. */
function autoQuality(now, frameMs, iMs){
  if(!AQ.auto) return;
  if(now - AQ.last < 2500) return;

  if(frameMs > 22){                            // 45fps 아래
    // 추론이 프레임 예산을 먹고 있으면 그것부터. 화질을 깎아도 이건 안 나아진다.
    if(!worker && iMs > 14 && P.inferHz > 10){
      $('inferHz').value = String(Math.max(10, Math.round(P.inferHz) - 4));
      $('inferHz').dispatchEvent(new Event('input'));
    } else if(AQ.lv < LADDER.length - 1){
      applyLadder(AQ.lv + 1);
    } else return;                             // 더 내릴 게 없다
    AQ.last = now; AQ.hold = now;
  } else if(frameMs < 13 && AQ.lv > 0 && now - AQ.hold > 15000){
    // 충분히 여유로우면 한 칸 되돌린다. 오르내림이 잦으면 그게 더 거슬리므로 오래 기다린다.
    applyLadder(AQ.lv - 1);
    AQ.last = now; AQ.hold = now;
  }
}

$('quality').onchange = e => {
  const v = (e.target as HTMLInputElement).value;
  AQ.auto = (v === 'auto');
  if(v === 'high') applyLadder(0);
  else if(v === 'mid') applyLadder(3);
  else if(v === 'low') applyLadder(5);
  AQ.last = performance.now(); AQ.hold = AQ.last;
  qualPill();
};
qualPill();

$('dump').addEventListener('click', () => {
  console.log('[까꿍 S2 튜닝값]', {
    mincutoff:P.mincut, beta:P.beta,
    yawTrigger:P.yTrig, yawRelease:P.yRel,
    sizeTrigger:P.sTrig, sizeRelease:P.sRel,
    cooldownMs:P.cool, peekDeg:P.peekAmt,
    invertYaw:$('invY').checked, invertSize:$('invS').checked,
    forwardMode:$('fwdMode').value, distanceSource:$('distSrc').value,
    holdForward:$('holdFwd').checked, suppressOnYaw:$('supYaw').checked,
    fog:P.fog, lamp:P.lamp, ambient:P.amb,
    pixelRatio:$('pxRatio').value, inferHz:P.inferHz, peekTau:P.peekTau,
    quality:{ auto:AQ.auto, level:AQ.lv, label:LADDER[AQ.lv].label },
    thread:$('thread').value, pumpMode:worker ? pumpMode : 'n/a',
    delegate:$('delegate').value,
    blendshapes:$('useBlend').checked, trackProcessor:trackProcessorOK,
    sound:{ started:!!SND.ctx, muted:SND.muted, master:SND.vol.master, drone:SND.vol.drone,
            heart:SND.vol.heart, whisper:SND.vol.whisper,
            amb:SND.vol.amb, steps:SND.onStep, stinger:SND.onSting,
            dread:Number(dread().toFixed(2)) },
    renderFps:renderFps, inferFps:inferFps, inferMs:Number(inferMs.toFixed(1)),
  });
  $('dump').textContent = '콘솔에 출력됨 (F12)';
  setTimeout(() => $('dump').textContent = '튜닝값 콘솔 출력', 1800);
});

/* ══ MediaPipe ════════════════════════════════════ */
let landmarker = null, stream = null, faceOn = false;
async function initMainLandmarker(){
  if(landmarker) return landmarker;
  const fileset = await FilesetResolver.forVisionTasks(WASM);
  landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions:{ modelAssetPath:MODEL, delegate:$('delegate').value },
    outputFacialTransformationMatrixes:true,
    outputFaceBlendshapes:$('useBlend').checked || $('fwdMode').value === 'jaw',
    runningMode:'VIDEO', numFaces:1,
  });
  setThreadPill('메인');
  return landmarker;
}
let worker = null, workerReady = false, workerFrames = 0;
let pumpMode = 'track', bitmapInFlight = false, bitmapAcc = 0;
// setTimeout 의 반환은 브라우저에선 number, Node 타입에선 Timeout 이다. 둘 다 받는다.
let readyTimer: ReturnType<typeof setTimeout> | undefined;
const trackProcessorOK = (typeof (globalThis as any).MediaStreamTrackProcessor !== 'undefined');
function setThreadPill(text, warn?){
  const p = $('pThread');
  p.textContent = '스레드 ' + text;
  p.classList.toggle('warn', !!warn);
}
const video = $('cam'), dots = $('dots'), dctx = dots.getContext('2d');
let calibrating = false, calibUntil = 0, calibBuf = [];
const base = { yaw:0, pitch:0, size:null, dist:null, jaw:0 };
let lastSeen = 0;
// 목표 엿보기 각 — 추론(30fps)이 갱신하고 렌더(60fps)가 보간한다
const peekTarget = { yaw:0, pitch:0 };
const peekNow = { yaw:0, pitch:0 };

$('start').addEventListener('click', async () => {
  if(stream){ stopCam(); return; }
  $('start').disabled = true; $('start').textContent = '모델 로딩 중…';
  try {
    if($('thread').value === 'main') await initMainLandmarker();
    stream = await navigator.mediaDevices.getUserMedia({
      video:{ width:{ideal:640}, height:{ideal:480}, facingMode:'user' }, audio:false });
    video.srcObject = stream; await video.play();
    dots.width = 640; dots.height = 480;
    if($('thread').value === 'worker') startWorker();
    else setThreadPill('메인 (히칭 예상)', true);
    $('start').textContent = '카메라 정지'; $('start').disabled = false;
    $('calib').disabled = false;
  } catch(err){
    console.error(err);
    $('start').textContent = '카메라 시작'; $('start').disabled = false;
    showErr('카메라 또는 모델 초기화 실패', err.message);
  }
});
function startWorker(){
  try {
    worker = new Worker(WORKER_URL, { type:'module' });
  } catch(err){ workerFail('워커 생성 실패: ' + err.message); return; }
  worker.onerror = e => workerFail(
    '워커 스크립트 로드/실행 오류' + (e.message ? ': ' + e.message : '') +
    (e.filename ? ' @ ' + e.filename + ':' + e.lineno : '') +
    ' — DevTools 콘솔에 상세가 남습니다');
  worker.onmessageerror = () => workerFail('워커 메시지 직렬화 실패');
  // ready 가 안 오면 조용히 멈추는 대신 이유를 알린다
  clearTimeout(readyTimer);
  readyTimer = setTimeout(() => {
    if(!workerReady) workerFail('15초 안에 준비 완료 신호가 오지 않았습니다 (모델 다운로드 실패 가능)');
  }, 15000);
  worker.onmessage = e => {
    const d = e.data;
    if(d.t === 'ready'){
      workerReady = true;
      clearTimeout(readyTimer);
      pumpMode = d.pump || pumpMode;
      setThreadPill('워커 · ' + (d.pump === 'track' ? '트랙' : 'bitmap') + ' · ' + d.delegate);
      return;
    }
    if(d.t === 'fail'){ workerFail('[' + (d.stage || '?') + '] ' + d.msg); return; }
    inferMs = inferMs*0.8 + d.ms*0.2;
    workerFrames++;
    if(d.t === 'none'){ onNoFace(performance.now()); return; }
    onSignals(d.s, performance.now());
    if(d.pts) drawPoints(d.pts);
  };
  const base0 = { t:'init', wasm:WASM, model:MODEL, delegate:$('delegate').value,
                  blend:$('useBlend').checked || $('fwdMode').value === 'jaw',
                  w:480, h:360 };
  // 원본 트랙은 <video> 가 계속 써야 하므로 복제본만 워커로 넘긴다
  let sent = false;
  if(trackProcessorOK){
    try {
      const clone = stream.getVideoTracks()[0].clone();
      worker.postMessage(Object.assign({ track:clone }, base0), [clone]);
      pumpMode = 'track'; sent = true;
    } catch(err){ console.warn('[까꿍] 트랙 전송 불가 → bitmap 경로:', err.message); }
  }
  if(!sent){
    worker.postMessage(Object.assign({ track:null }, base0));
    pumpMode = 'bitmap';
  }
  setThreadPill(pumpMode === 'track' ? '워커 준비 중…' : '워커 준비 중… (bitmap)');
}
// bitmap 폴백 펌프. 한 장이 처리될 때까지 다음 장을 만들지 않는다(백프레셔).
function pumpBitmap(dt){
  if(!worker || !workerReady || pumpMode !== 'bitmap') return;
  if(!stream || video.readyState < 2) return;
  bitmapAcc += dt;
  if(bitmapAcc < 1/Math.max(1, P.inferHz) || bitmapInFlight) return;
  bitmapAcc = 0; bitmapInFlight = true;
  createImageBitmap(video, { resizeWidth:480, resizeHeight:360, resizeQuality:'low' })
    .then(bmp => { if(worker) worker.postMessage({ t:'bitmap', bmp }, [bmp]); else bmp.close(); })
    .catch(() => {})
    .finally(() => { bitmapInFlight = false; });
}
async function workerFail(msg){
  clearTimeout(readyTimer);
  if(worker){ worker.terminate(); worker = null; }
  workerReady = false;
  $('thread').value = 'main';
  setThreadPill('메인 폴백', true);
  showErr('워커 추론 실패 — 메인 스레드로 계속합니다', msg);
  // 드롭다운만 바꾸면 landmarker 가 없어 infer() 가 즉시 리턴하고
  // 캘리브레이션이 영원히 끝나지 않는다. 실제로 메인 모델을 만들어야 한다.
  resetCalib();
  try { await initMainLandmarker(); }
  catch(err){ showErr('메인 추론 초기화도 실패', err.message); }
}
function resetCalib(){
  calibrating = false; calibBuf = [];
  $('calib').disabled = !stream;
  $('calib').textContent = '중립 자세 캘리브레이션 (2초)';
}
function drawPoints(pts){
  dctx.clearRect(0,0,dots.width,dots.height);
  dctx.fillStyle = 'rgba(207,198,180,.5)';
  for(let i=0;i<pts.length;i+=2) dctx.fillRect(pts[i]*dots.width-1, pts[i+1]*dots.height-1, 2, 2);
}
function stopCam(){
  clearTimeout(readyTimer);
  if(worker){ worker.terminate(); worker = null; workerReady = false; }
  bitmapInFlight = false; bitmapAcc = 0;
  calibrating = false; calibBuf = [];
  setThreadPill('--');
  if(stream) stream.getTracks().forEach(t => t.stop());
  stream = null; video.srcObject = null; faceOn = false;
  base.size = null; facePlane.visible = false;
  $('start').textContent = '카메라 시작'; $('calib').disabled = true;
  setMode(false);
}
$('calib').addEventListener('click', () => {
  calibrating = true; calibBuf = []; calibUntil = performance.now()+2000;
  $('calib').disabled = true; $('calib').textContent = '측정 중… 정면을 보세요';
});
function setMode(on){
  faceOn = on;
  const p = $('pMode');
  p.textContent = on ? '얼굴 모드' : '키보드 모드';
  p.classList.toggle('on', on); p.classList.toggle('warn', !on);
}

function signals(lm, mtx, blend){
  const nose = lm[1], L = lm[234], R = lm[454], top = lm[10], chin = lm[152];
  // 부호: 고개를 왼쪽으로 돌리면 음수 → 좌회전. 실측으로 확정된 방향.
  const dL = nose.x - L.x, dR = R.x - nose.x;
  const yaw = (dR - dL)/Math.max(1e-4, dL + dR);
  const faceH = Math.max(1e-4, chin.y - top.y);
  const pitch = (nose.y - (top.y + chin.y)/2)/faceH;
  let minX=1,maxX=0,minY=1,maxY=0;
  for(const p of lm){
    if(p.x<minX)minX=p.x; if(p.x>maxX)maxX=p.x;
    if(p.y<minY)minY=p.y; if(p.y>maxY)maxY=p.y;
  }
  // 행렬 병진(translation) — 회전에 영향받지 않는 거리 신호.
  // bbox 면적은 고개를 돌리면 함께 줄어들어 후진이 오발동한다 (크로스토크).
  const dist = mtx ? Math.abs(mtx[14]) : 0;
  let jaw = 0;
  if(blend && blend.categories){
    const c = blend.categories.find(x => x.categoryName === 'jawOpen');
    if(c) jaw = c.score;
  }
  return { yaw, pitch, size:Math.sqrt(Math.max(0,(maxX-minX)*(maxY-minY))),
           dist, jaw, box:{ minX, maxX, minY, maxY } };
}
function paintFace(b){
  if(!$('faceTex').checked){ facePlane.visible = false; return; }
  const vw = video.videoWidth, vh = video.videoHeight;
  if(!vw) return;
  const pad = 0.14;
  const sx = Math.max(0,(b.minX - pad*(b.maxX-b.minX)))*vw;
  const sy = Math.max(0,(b.minY - pad*(b.maxY-b.minY)))*vh;
  const sw = Math.min(vw-sx,(b.maxX-b.minX)*(1+2*pad)*vw);
  const sh = Math.min(vh-sy,(b.maxY-b.minY)*(1+2*pad)*vh);
  fctx.save();
  fctx.filter = 'grayscale(1) contrast(1.7) brightness(0.74)';
  fctx.translate(256,0); fctx.scale(-1,1);           // 거울 반전
  fctx.drawImage(video, sx, sy, sw, sh, 0, 0, 256, 256);
  fctx.restore();
  faceTexture.needsUpdate = true;
  facePlane.visible = true;
  facePainted = true;
}

/* ══ 추론 루프 — 30fps ════════════════════════════ */
let inferAcc = 0, inferFps = 0, inferN = 0, inferT = 0, inferMs = 0, gAcc = 0;
function infer(now, dt){
  if(worker || !landmarker) return;          // 워커 모드에서는 메인 추론을 돌리지 않는다
  if(!stream || video.readyState < 2) return;
  inferAcc += dt;
  if(inferAcc < 1/Math.max(1, P.inferHz)) return;
  inferAcc = 0;

  let res = null;
  const t0 = performance.now();
  try { res = landmarker.detectForVideo(video, now); } catch(e){ return; }
  // 동기 호출이므로 이 시간이 그대로 프레임 예산에서 빠진다
  inferMs = inferMs*0.8 + (performance.now()-t0)*0.2;
  inferN++; inferT += dt;
  if(inferT >= 0.5){
    inferFps = Math.round(inferN/inferT);
    $('pInfer').textContent = '추론 '+inferFps+' fps';
    $('pInferMs').textContent = '추론 '+inferMs.toFixed(1)+' ms';
    $('pInferMs').classList.toggle('warn', inferMs > 16);
    inferN = 0; inferT = 0;
  }

  const found = res && res.faceLandmarks && res.faceLandmarks.length > 0;
  if(!found){ onNoFace(now); return; }
  const lm = res.faceLandmarks[0];
  dctx.clearRect(0,0,dots.width,dots.height);
  dctx.fillStyle = 'rgba(207,198,180,.5)';
  for(let i=0;i<lm.length;i+=3){          // 3개당 1개만 — 미리보기용이므로 충분
    const p = lm[i];
    dctx.fillRect(p.x*dots.width-1, p.y*dots.height-1, 2, 2);
  }

  const mtx = (res.facialTransformationMatrixes && res.facialTransformationMatrixes.length)
    ? res.facialTransformationMatrixes[0].data : null;
  const blend = (res.faceBlendshapes && res.faceBlendshapes.length)
    ? res.faceBlendshapes[0] : null;
  onSignals(signals(lm, mtx, blend), now);
}

function onNoFace(now){
  dctx.clearRect(0,0,dots.width,dots.height);
  if(now - lastSeen > 1500){ setMode(false); peekTarget.yaw = peekTarget.pitch = 0; }
}

/* 신호 처리 — 메인 추론과 워커 추론이 공유하는 단일 경로.
   필터·게이트·엿보기는 비용이 미미하므로 메인 스레드에 남긴다. */
function onSignals(s, now){
  lastSeen = now;
  paintFace(s.box);

  if(calibrating){
    calibBuf.push(s);
    if(now >= calibUntil){
      const n = calibBuf.length;
      base.yaw = calibBuf.reduce((a,b)=>a+b.yaw,0)/n;
      base.pitch = calibBuf.reduce((a,b)=>a+b.pitch,0)/n;
      base.size = calibBuf.reduce((a,b)=>a+b.size,0)/n;
      base.dist = calibBuf.reduce((a,b)=>a+b.dist,0)/n;
      base.jaw  = calibBuf.reduce((a,b)=>a+b.jaw,0)/n;
      calibrating = false;
      $('calib').disabled = false; $('calib').textContent = '중립 자세 재캘리브레이션 (2초)';
      setMode(true);
    }
    return;
  }
  if(base.size === null) return;

  const t = now/1000;
  const rawYaw = (s.yaw - base.yaw) * ($('invY').checked ? -1 : 1);
  const yaw = fYaw.filter(rawYaw, t);
  const pitch = fPitch.filter(s.pitch - base.pitch, t);

  // ── 전후 신호 ──────────────────────────────────
  let rawSize;
  if($('distSrc').value === 'matrix' && base.dist){
    // 카메라에 가까워지면 |z| 가 줄어든다 → 부호 반전해서 "기울이면 +"
    rawSize = -(s.dist - base.dist)/base.dist;
  } else {
    rawSize = (s.size - base.size)/base.size;
  }
  if($('fwdMode').value === 'jaw'){
    // 입을 벌리면 전진, 벌리지 않은 상태에서 몸을 빼면 후진
    const jawV = s.jaw - base.jaw;
    rawSize = (jawV > 0.12) ? jawV*2 : Math.min(0, rawSize);
  }
  rawSize *= ($('invS').checked ? -1 : 1);
  // 크로스토크 억제 — 고개가 중립을 벗어난 동안 전후 신호를 죽인다.
  // bbox 면적은 yaw 에 따라 줄어들므로 회전이 후진으로 오발동한다.
  if($('supYaw').checked && $('distSrc').value === 'bbox' && Math.abs(yaw) > P.yRel*1.5) rawSize = 0;
  const size = fSize.filter(rawSize, t);

  graphYaw.push(rawYaw, yaw);
  graphSize.push(rawSize, size);
  gAcc += 1;
  if(gAcc >= 3){                          // 추론 3회당 1회만 다시 그린다
    gAcc = 0;
    graphYaw.draw(P.yTrig, P.yRel, 0.7);
    graphSize.draw(P.sTrig, P.sRel, 0.45);
  }

  gateYaw.update(yaw, P.yTrig, P.yRel, P.cool, now, sg => turn(sg > 0 ? 'right' : 'left'), false);
  gateSize.update(size, P.sTrig, P.sRel, P.cool, now, sg => step(sg > 0 ? 1 : -1), $('holdFwd').checked);

  // 연속 층 — 임계값 미만 구간을 실제 카메라 회전으로 (기획서 §2.2.1)
  const k = Math.PI/180 * P.peekAmt;
  peekTarget.yaw = -Math.max(-1, Math.min(1, yaw/Math.max(0.001, P.yTrig))) * k;
  peekTarget.pitch = -Math.max(-1, Math.min(1, pitch/0.09)) * k * 0.45;
}

/* ══ 미니맵 — 지나온 칸만 (§1.2 · §4.3 ③) ═══════
   전체 지도를 주면 §1.2 "코너 너머를 알 수 없어서 무섭다" 가 무너진다.
   그래서 밟은 칸과 그 칸에 닿아 있는 벽만 그린다. 탈출구도 상대도 찍지 않는다.
   술래에게도 같은 것만 준다 — 설계 단계(S4)가 아직 없어 술래도 이 미로를 처음 본다. */
const MAP = { seen: new Set<string>(), dirty: true };
function mapReset(){ MAP.seen.clear(); MAP.dirty = true; }
function mapMark(){ MAP.seen.add(player.x + ',' + player.y); MAP.dirty = true; }

function mapDraw(){
  const cv = $('minimap');
  if(!cv || cv.classList.contains('hidden')) return;
  const n = GRID.length, ctx = cv.getContext('2d');
  const px = cv.clientWidth * devicePixelRatio;
  if(cv.width !== px){ cv.width = cv.height = px; }
  const s = cv.width / n;

  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = 'rgba(6,4,4,.82)';
  ctx.fillRect(0, 0, cv.width, cv.height);

  // 밟은 칸 + 그 칸에 닿아 있는 벽만
  for(const key of MAP.seen){
    const [x, y] = key.split(',').map(Number);
    ctx.fillStyle = '#2a2422';
    ctx.fillRect(x*s, y*s, s, s);
    for(const d of DIRS){
      const wx2 = x + d.dx, wy2 = y + d.dy;
      if(GRID[wy2] && GRID[wy2][wx2] === '#'){
        ctx.fillStyle = '#574d49';
        ctx.fillRect(wx2*s, wy2*s, s, s);
      }
    }
  }

  // 나 — 삼각형이 바라보는 쪽을 가리킨다
  const cx = (player.x + 0.5)*s, cy = (player.y + 0.5)*s, r = s*0.42;
  const a = player.dir*Math.PI/2;                 // 0=북, 시계방향
  ctx.fillStyle = '#cfc6b4';
  ctx.beginPath();
  for(const [d, k] of [[0, 1], [2.4, 0.62], [-2.4, 0.62]]){
    const t = a + d;
    ctx.lineTo(cx + Math.sin(t)*r*k, cy - Math.cos(t)*r*k);
  }
  ctx.closePath(); ctx.fill();
  MAP.dirty = false;
}

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
const NET = {
  client:null, room:null, on:false, id:null, view:null, lobby:null, info:null,
  others:new Map(), seenIds:new Set(), lastHintAt:0, faceShared:false, retry:0,
};
const FACES = new Map();          // id → THREE.Texture

// 헷갈리는 글자(0/O, 1/I)를 뺀 알파벳 — 코드를 불러줘야 하는 상황을 생각한 것
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({length:4}, () => CODE_ABC[(Math.random()*CODE_ABC.length)|0]).join('');

function mpEndpoint(): string {
  /* 배포에서는 serve.ts 가 정적 파일과 Colyseus 를 같은 포트에서 내보내므로 같은 오리진이다.
     개발에서는 Vite(5200)와 게임 서버(5199)가 갈라져 있어 직접 지정한다.
     https 로 열렸으면 wss 여야 한다 — 섞이면 브라우저가 막는다. */
  if(import.meta.env.DEV) return 'ws://' + location.hostname + ':5199';
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
}

async function mpJoin(code){
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

function bindRoom(room){
  NET.room = room; NET.id = room.sessionId; NET.on = true;
  try{ localStorage.setItem('kk.token', room.reconnectionToken || ''); }catch{}
  creature.visible = false;                 // 멀티에서는 실제 플레이어만 보인다
  mpPill('접속됨');

  room.onMessage('room', m => { NET.info = m; mpRoomUI(); });
  room.onMessage('maze', m => {
    GRID = m.grid; rebuildMaze(); mapReset(); NET.seenIds.clear();
  });
  room.onMessage('state', mpApply);
  room.onMessage('face', m => faceRecv(m.id, m.data));
  room.onMessage('faceGone', m => faceDrop(m.id));
  room.onMessage('faceOk', () => { faceSharePill(true); banner('얼굴 등록됨', '이 방 사람들에게만 전달된다'); });
  room.onMessage('faceOff', () => { faceSharePill(false); banner('얼굴 등록을 지웠다', ''); });
  room.onMessage('error', m => showErr('서버', m.reason));

  room.onLeave(code => {
    NET.on = false; NET.room = null; NET.view = null;
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
async function mpReconnect(){
  let token = '';
  try{ token = localStorage.getItem('kk.token') || ''; }catch{}
  if(!token || !NET.client) return mpJoin($('mpCode').value.trim().toUpperCase());
  mpPill('재접속 중…');
  try{ bindRoom(await NET.client.reconnect(token)); }
  catch(e){ mpPill('재접속 실패'); banner('자리가 사라졌다', '새로 들어가야 한다'); }
}

function mpLeave(){ if(NET.room) NET.room.leave(true); }

function mpPill(text: string){
  const p = $('pNet');
  p.textContent = text;
  p.classList.toggle('on', text === '접속됨');
  p.classList.toggle('warn', /실패|끊김/.test(text));
}
function mpRoomUI(){
  const on = NET.on, info = NET.info;
  $('mpPublic').classList.toggle('hidden', on);
  $('mpCreate').classList.toggle('hidden', on);
  $('mpCodeRow').classList.toggle('hidden', on);
  $('mpLeave').classList.toggle('hidden', !on);
  $('faceShare').classList.toggle('hidden', !on || !(info && info.allowFaces));
  $('mpWhere').textContent = !on ? ''
    : (info && info.code ? '방 코드 ' + info.code : '공개 매칭 — 얼굴 공유 없음');
}

const mmss = ms => {
  const s = Math.max(0, Math.round(ms/1000));
  return String((s/60)|0).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
};

function mpApply(msg){
  NET.view = msg.view; NET.lobby = msg.lobby;
  applyMe(msg.view.me);
  applySeen(msg.view.seen);
  applyHints(msg.view);
  mpHud(msg.view, msg.lobby);
  (msg.events || []).forEach(mpEvent);
}

/* 서버가 내려준 내 위치를 따른다. 로컬에서 미리 움직이지 않는다 —
   예측 이동은 서버가 거부했을 때 되감기가 필요한데, 400ms 쿨다운 게임에서
   그 복잡도를 감수할 이유가 없다.

   상태는 10Hz 로 계속 온다. '바뀐 것만' 보고 애니메이션을 걸어야 한다.
   매번 새로 걸면 카메라가 목적지에 영영 도착하지 못한다. */
function applyMe(me){
  const dirChanged = player.dir !== me.dir;
  const cellChanged = player.x !== me.x || player.y !== me.y;
  player.x = me.x; player.y = me.y; player.dir = me.dir;

  const wantYaw = -me.dir*Math.PI/2;
  const px = wx(me.x), pz = wz(me.y);

  if(dirChanged || cellChanged) mapDraw();
  if(dirChanged){
    // 최단 방향으로 돈다. 3→0 을 그냥 빼면 반대로 한 바퀴 돈다.
    const delta = Math.atan2(Math.sin(wantYaw - camYaw), Math.cos(wantYaw - camYaw));
    anim = { kind:'turn', t:0, from:camYaw, to:camYaw + delta };
    rustle(delta > 0 ? 'left' : 'right');
  } else if(cellChanged){
    anim = { kind:'move', t:0, fx:camera.position.x, fz:camera.position.z, tx:px, tz:pz };
    footstep(false); mapMark();
  } else if(!anim){
    camera.position.x = px; camera.position.z = pz;
    camYaw = wantYaw;
  }
}

/* 보이는 상대만 세운다. 서버가 정면 4칸 밖은 아예 안 보내므로
   여기서 걸러낼 것이 없다 — 없는 정보는 그릴 수도 없다. */
function applySeen(seen){
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
function applyHints(v){
  if(v.me.role !== 'it' || !v.hints || !v.hints.length) return;
  const now = performance.now();
  if(now - NET.lastHintAt < 900) return;
  NET.lastHintAt = now;
  const h = v.hints.reduce((a, b) => a.d <= b.d ? a : b);
  const level = Math.max(0.15, 1 - h.d/8);
  creatureStep(level, { pan: Math.sin(h.bearing), front: Math.cos(h.bearing) });
}

function mpHud(v, lobby){
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

function mpEvent(e){
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

let bannerTimer: ReturnType<typeof setTimeout> | null = null;
function banner(title, sub?, ms = 2200){
  $('bannerT').textContent = title;
  $('bannerS').textContent = sub || '';
  $('banner').classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => $('banner').classList.remove('show'), ms);
}

/* 탈출구 방향 신호 (§4.3 ③) — 좌표는 안 준다. 가까울수록 심장이 빨라진다. */
function netDread(){
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
function faceShare(){
  if(!NET.on) return banner('먼저 방에 들어가야 한다', '');
  if(!NET.info || !NET.info.allowFaces)
    return banner('공개 방에서는 안 된다', '방 코드로 만든 방에서만 얼굴을 공유한다');
  if(!faceOn || !facePainted)
    return banner('얼굴이 아직 안 잡혔다', '카메라를 켜고 캘리브레이션을 마친 뒤 다시');
  NET.room.send('face', { data: faceCv.toDataURL('image/jpeg', 0.7) });
  $('faceShare').textContent = '보내는 중…';
}
function faceRevoke(){ if(NET.room) NET.room.send('faceOff', {}); }
function faceSharePill(on){
  $('faceShare').textContent = on ? '내 얼굴 등록 지우기' : '내 얼굴 등록하기';
  NET.faceShared = on;
}
function faceRecv(id, dataUrl){
  const tex = new THREE.TextureLoader().load(dataUrl, () => { tex.needsUpdate = true; });
  tex.colorSpace = THREE.SRGBColorSpace;
  const old = FACES.get(id);
  if(old) old.dispose();
  FACES.set(id, tex);
  applyFaceTo(id);
}
function faceDrop(id){
  const t = FACES.get(id);
  if(t) t.dispose();
  FACES.delete(id);
  applyFaceTo(id);
}
function applyFaceTo(id){
  const g = NET.others.get(id);
  if(!g) return;
  const fp = g.getObjectByName('face');
  if(!fp) return;
  const tex = FACES.get(id);
  fp.material.map = tex || null;
  fp.material.needsUpdate = true;
  fp.visible = !!tex;
}

function mpSend(a){ if(NET.room) NET.room.send('input', { a }); }

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
mapMark(); mapDraw();          // 시작 칸부터 찍고 들어간다

/* ══ 렌더 루프 — 60fps ════════════════════════════ */
let last = performance.now(), rAcc = 0, rN = 0, renderFps = 0;
function loop(now){
  requestAnimationFrame(loop);
  const dt = Math.min((now-last)/1000, 0.05); last = now;

  infer(now, dt);
  pumpBitmap(dt);

  if(anim){
    anim.t = Math.min(1, anim.t + dt/0.4);
    const e = ease(anim.t);
    if(anim.kind === 'move'){
      camera.position.x = anim.fx + (anim.tx-anim.fx)*e;
      camera.position.z = anim.fz + (anim.tz-anim.fz)*e;
      bob += dt*11;
    } else camYaw = anim.from + (anim.to-anim.from)*e;
    // 시야 판정은 이동·회전이 끝난 뒤 한 번만 한다 (스팅어를 한 번만 터뜨리기 위해)
    if(anim.t >= 1){ anim = null; sndSight(); }
  }

  // 저주기 추론 신호를 렌더 프레임레이트로 보간 (기획서 §2.2.4).
  // tau 가 작으면 반응이 빠르지만 계단이 보이고, 크면 매끄럽지만 늦다.
  const lerp = 1 - Math.exp(-dt/Math.max(0.005, P.peekTau));
  peekNow.yaw += (peekTarget.yaw - peekNow.yaw) * lerp;
  peekNow.pitch += (peekTarget.pitch - peekNow.pitch) * lerp;

  const idle = now/1000;
  camera.position.y = EYE + Math.sin(idle*0.9)*0.012 + Math.sin(bob)*0.035;
  camera.rotation.set(
    peekNow.pitch + Math.sin(idle*0.7)*0.006,
    camYaw + peekNow.yaw,
    Math.sin(idle*0.5)*0.004, 'YXZ');

  if(creature.visible) creature.lookAt(camera.position.x, 0, camera.position.z);
  grade.uniforms.uTime.value = idle;

  if(postOn) composer.render(); else renderer.render(scene, camera);

  rN++; rAcc += dt;
  if(rAcc >= 0.5){
    if(worker){
      inferFps = Math.round(workerFrames/rAcc); workerFrames = 0;
      $('pInfer').textContent = '추론 ' + inferFps + ' fps';
      $('pInferMs').textContent = '추론 ' + inferMs.toFixed(1) + ' ms';
      $('pInferMs').classList.remove('warn');   // 워커에서는 프레임 예산과 무관
    }
    renderFps = Math.round(rN/rAcc);
    const frameMs = (rAcc/rN)*1000;
    $('pRender').textContent = '렌더 '+renderFps+' fps';
    $('pFrame').textContent = '프레임 '+frameMs.toFixed(1)+' ms';
    $('pFrame').classList.toggle('warn', frameMs > 20);
    $('pRender').classList.toggle('warn', renderFps < 50);
    autoQuality(now, frameMs, inferMs);
    $('pCell').textContent = 'CELL '+player.x+','+player.y;
    const dd = dread();
    sndDread(dd);
    $('pDread').textContent = '근접 '+Math.round(dd*100)+'%';
    $('pDread').classList.toggle('warn', dd > 0.66);
    rN = 0; rAcc = 0;
  }
}
addEventListener('resize', () => {
  camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight);
  sizeBloomHalf();
});
sizeBloomHalf();
$('boot').remove();
requestAnimationFrame(loop);
