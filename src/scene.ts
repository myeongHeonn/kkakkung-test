/* 씬 · 재료 · 후처리 — three.js 로 만드는 모든 것.
   audio·net·face 를 import 하지 않는다. 이 모듈은 '보여주는 것'만 안다. */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CELL, WALL_H, EYE, DIRS, START, CREATURE, grid, walkable, wx, wz } from './core/space.ts';
import { $ } from './core/dom.ts';

/* ══ 절차적 텍스처 ════════════════════════════════ */
export function fractalNoise(size, octaves){
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
export function texFrom(h, size, mode, tint?){
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
export function surface(size, oct, tint, rep?){
  const h = fractalNoise(size, oct);
  const map = texFrom(h,size,'albedo',tint);
  const normalMap = texFrom(h,size,'normal');
  const roughnessMap = texFrom(h,size,'rough');
  [map,normalMap,roughnessMap].forEach(t=>{ t.repeat.set(rep,rep); t.anisotropy = 8; });
  return { map, normalMap, roughnessMap };
}

/* ══ 씬 ═══════════════════════════════════════════ */
export const renderer = new THREE.WebGLRenderer({ antialias:true, powerPreference:'high-performance' });
renderer.domElement.id = 'gl';
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

export const FOG = 0x050303;
export const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(FOG, 0.105);
scene.background = new THREE.Color(FOG);

export const camera = new THREE.PerspectiveCamera(72, innerWidth/innerHeight, 0.1, 60);
camera.position.set(wx(START.x), EYE, wz(START.y));
scene.add(camera);

export const ambient = new THREE.AmbientLight(0xa9b4c8, 0.03); scene.add(ambient);
export const flashlight = new THREE.SpotLight(0xffd2a0, 34, 17, 0.78, 0.7, 1.5);
flashlight.castShadow = true;
flashlight.shadow.mapSize.set(768,768);
flashlight.shadow.camera.near = 0.4; flashlight.shadow.camera.far = 18;
flashlight.shadow.bias = -0.0035;
camera.add(flashlight); camera.add(flashlight.target);
flashlight.target.position.set(0,0,-1);
camera.add(new THREE.PointLight(0xffc890, 1.1, 5.5, 2.0));

export const wallSurf = surface(256,5,[206,198,186],1);
export const floorSurf = surface(256,5,[150,142,132],7);
export const ceilSurf = surface(256,4,[120,114,108],7);
export const wallMat = new THREE.MeshStandardMaterial(Object.assign({},wallSurf,
  { roughness:1, metalness:0, normalScale:new THREE.Vector2(1.3,1.3) }));
export const floorMat = new THREE.MeshStandardMaterial(Object.assign({},floorSurf,
  { roughness:1, metalness:0, normalScale:new THREE.Vector2(1.1,1.1) }));
export const ceilMat = new THREE.MeshStandardMaterial(Object.assign({},ceilSurf,
  { roughness:1, metalness:0 }));

export const SPAN = grid().length*CELL, plane = new THREE.PlaneGeometry(SPAN,SPAN);
export const floor = new THREE.Mesh(plane, floorMat);
floor.rotation.x = -Math.PI/2;
floor.position.set(SPAN/2-CELL/2, 0, SPAN/2-CELL/2);
floor.receiveShadow = true; scene.add(floor);
export const ceil = new THREE.Mesh(plane, ceilMat);
ceil.rotation.x = Math.PI/2;
ceil.position.set(SPAN/2-CELL/2, WALL_H, SPAN/2-CELL/2);
ceil.receiveShadow = true; scene.add(ceil);

export const box = new THREE.BoxGeometry(CELL, WALL_H, CELL);
export let wallMesh = null;
/* 미로는 판마다 서버가 새로 준다. 다시 세울 수 있어야 한다.

   벽 하나에 메시 하나를 쓰면 33×33 에서 540개가 되고, 손전등 그림자가
   그 전부를 매 프레임 다시 그린다. InstancedMesh 로 묶으면 드로우콜이 1개다.
   사방이 벽인 칸은 어차피 안 보이므로 만들지 않는다. */
export function rebuildMaze(){
  if(wallMesh){ scene.remove(wallMesh); wallMesh.dispose(); wallMesh = null; }
  const spots = [];
  const g = grid();
  for(let y=0;y<g.length;y++) for(let x=0;x<g[y]!.length;x++){
    if(g[y]![x] !== '#') continue;
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

  const span = grid().length*CELL, k = span/SPAN;
  floor.scale.set(k, k, 1); ceil.scale.set(k, k, 1);
  floor.position.set(span/2-CELL/2, 0, span/2-CELL/2);
  ceil.position.set(span/2-CELL/2, WALL_H, span/2-CELL/2);
}
rebuildMaze();

/* 그것 — 대두 + 길고 가는 팔다리 (기획서 §2.4) */
export const dark = new THREE.MeshStandardMaterial({ color:0x0d0b0b, roughness:0.95 });
export const skin = new THREE.MeshStandardMaterial({ color:0x8a7f74, roughness:0.72 });
export const creature = new THREE.Group();
export const head = new THREE.Mesh(new THREE.SphereGeometry(0.56,28,20), skin);
head.scale.set(0.94,1.14,0.9); head.position.y = 2.16;
export const torso = new THREE.Mesh(new THREE.BoxGeometry(0.34,0.74,0.22), dark);
torso.position.y = 1.18;
creature.add(head); creature.add(torso);
export const armGeo = new THREE.CylinderGeometry(0.055,0.042,1.16,8);
[[-0.24,0.16],[0.24,-0.16]].forEach(p => {
  const a = new THREE.Mesh(armGeo, dark);
  a.position.set(p[0],0.98,0); a.rotation.z = p[1]; creature.add(a);
});
export const legGeo = new THREE.CylinderGeometry(0.06,0.05,1.5,8);
[[-0.12,0.05],[0.12,-0.05]].forEach(p => {
  const l = new THREE.Mesh(legGeo, dark);
  l.position.set(p[0],0.75,0); l.rotation.z = p[1]; creature.add(l);
});

/* 얼굴 — 웹캠을 캔버스로 크롭·그레이스케일해서 머리 앞면에 붙인다.
   MeshStandardMaterial 이므로 손전등이 비출 때만 드러난다. */
export const faceCv = document.createElement('canvas'); faceCv.width = faceCv.height = 256;
export const fctx = faceCv.getContext('2d');
fctx.fillStyle = '#8a7f74'; fctx.fillRect(0,0,256,256);
export const faceTexture = new THREE.CanvasTexture(faceCv);
faceTexture.colorSpace = THREE.SRGBColorSpace;
export const faceMat = new THREE.MeshStandardMaterial({ map:faceTexture, roughness:0.68 });
export const facePlane = new THREE.Mesh(new THREE.PlaneGeometry(0.95,1.15), faceMat);
facePlane.name = 'face';          // 클론에서 찾아 상대 얼굴로 갈아끼운다
let painted = false;          // 한 번이라도 실제 얼굴이 그려졌는가
export const facePainted = (): boolean => painted;
export const setFacePainted = (v: boolean): void => { painted = v; };
facePlane.position.set(0, 2.16, 0.44);
facePlane.visible = false;
creature.add(facePlane);

creature.traverse(o => { if((o as THREE.Mesh).isMesh) o.castShadow = true; });
creature.position.set(wx(CREATURE.x), 0, wz(CREATURE.y));
scene.add(creature);

/* ══ 탈출구 ═══════════════════════════════════════
   서버가 "지금 보인다"고 할 때만 세운다 (shared/protocol.ts 의 SeenExit).
   좌표를 늘 들고 있으면 클라이언트를 열어보는 것으로 위치를 알 수 있다.

   여기서는 MeshBasicMaterial 이 맞다. 그것의 얼굴에서는 이게 틀린 선택이었지만
   (어둠 속에서 스스로 빛나면 손전등으로 드러나는 연출이 무너진다) 탈출구는 반대다 —
   안개 너머로 빛이 먼저 오고, 그게 심장박동이 말하던 것의 답이어야 한다. */
export const exitGate = new THREE.Group();
const gateFrame = new THREE.MeshStandardMaterial({ color:0x17130f, roughness:0.92 });
const gateGlow = new THREE.MeshBasicMaterial({
  color:0xffc98e, transparent:true, opacity:0, side:THREE.DoubleSide, depthWrite:false });
const postGeo = new THREE.BoxGeometry(0.2, 2.62, 0.2);
for(const px of [-0.82, 0.82]){
  const p = new THREE.Mesh(postGeo, gateFrame); p.position.set(px, 1.31, 0); exitGate.add(p);
}
const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.84, 0.2, 0.2), gateFrame);
lintel.position.y = 2.52; exitGate.add(lintel);
const gatePane = new THREE.Mesh(new THREE.PlaneGeometry(1.44, 2.42), gateGlow);
gatePane.position.y = 1.21; exitGate.add(gatePane);
/* 문틈으로 새는 빛. 그림자를 만들지 않는다 — 그림자 맵은 손전등 하나로 충분하고,
   여기에 하나 더 붙이면 자동 품질이 제일 먼저 깎아낼 비용이 된다. */
const gateLamp = new THREE.PointLight(0xffc98e, 0, 7.5, 2);
gateLamp.position.y = 1.5; exitGate.add(gateLamp);
exitGate.visible = false;
scene.add(exitGate);

let exitAt: { x: number; y: number } | null = null;
let gateFade = 0, gateT = 0;

/** 서버가 보인다고 한 칸. null 이면 지금은 안 보인다. */
export function setExit(cell: { x: number; y: number } | null): void {
  if(cell) exitGate.position.set(wx(cell.x), 0, wz(cell.y));
  exitAt = cell;
}

/* 켜고 끄는 것을 즉시 하지 않는다. 고개를 조금 돌렸다고 문이 딱 사라지면
   '서버가 안 보내기 시작했다'는 게 눈에 보인다. 0.25초쯤 걸쳐 여닫는다. */
export function updateExit(dt: number): void {
  const want = exitAt ? 1 : 0;
  if(gateFade === want && !exitGate.visible) return;
  gateT += dt;
  gateFade += (want - gateFade) * Math.min(1, dt*7);
  if(gateFade < 0.01 && !exitAt){ gateFade = 0; exitGate.visible = false; return; }
  exitGate.visible = true;
  // 아주 느린 맥동 — 완전히 고정된 빛은 소품처럼 보인다
  const pulse = 0.86 + Math.sin(gateT*1.7)*0.14;
  gateGlow.opacity = gateFade * 0.82 * pulse;
  gateLamp.intensity = gateFade * 2.6 * pulse;
  exitGate.lookAt(camera.position.x, 0, camera.position.z);
}

/* ══ 후처리 ═══════════════════════════════════════ */
export const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
export const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth/2, innerHeight/2), 0.25, 0.6, 0.85);
composer.addPass(bloom);
// 블룸은 밉 체인을 여러 번 블러하므로 후처리 중 가장 비싸다.
// 절반 해상도로 돌려도 육안 차이가 거의 없고 비용은 1/4이 된다.
export const sizeBloomHalf = () => bloom.setSize(innerWidth/2, innerHeight/2);
export const grade = new ShaderPass({
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
export const isPost = (): boolean => postOn;
export function setPost(on: boolean): void {
  postOn = on; bloom.enabled = on; grade.enabled = on;
}


/* 해상도 배율 — 렌더러와 컴포저를 함께 맞춰야 한다 */
export function applyPixelRatio(){
  renderer.setPixelRatio(parseFloat($('pxRatio').value));
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  sizeBloomHalf();
}
