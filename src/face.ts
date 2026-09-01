/* 얼굴 입력 — MediaPipe + One Euro + 히스테리시스 게이트. */
import * as THREE from 'three';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { $, P, showErr } from './core/dom.ts';
import { EYE } from './core/space.ts';
import { camera, faceCv, fctx, faceTexture, facePlane, setFacePainted } from './scene.ts';
import { step, turn } from './player.ts';

const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const WASM  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';
/* 워커 추론 경로는 보류 중이다 — ready 는 오는데 프레임이 안 흐른다.
   사유와 재개 조건은 docs/구현계획.md S2. */
const WORKER_URL = 'face-worker.js';

/* ══ One Euro Filter ══════════════════════════════ */
export class LowPass {
  s: number | null;
  constructor(){ this.s = null; }
  filter(x: number, a: number): number { this.s = (this.s===null) ? x : a*x + (1-a)*this.s; return this.s; }
}
export class OneEuro {
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
export const fYaw = new OneEuro(), fPitch = new OneEuro(), fSize = new OneEuro();

export class Gate {
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
export const gateYaw = new Gate($('pYawArm')), gateSize = new Gate($('pSizeArm'));

/* ══ 그래프 ═══════════════════════════════════════ */
export function makeGraph(cv){
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
export const graphYaw = makeGraph($('gYaw')), graphSize = makeGraph($('gSize'));

/* ══ MediaPipe ════════════════════════════════════ */
let landmarker: any = null;
let stream: MediaStream | null = null;
/* 추론 옵션은 landmarker 생성 시점에 굳는다. 바꾸면 버리고 다시 만들어야 한다. */
export const dropLandmarker = (): void => { landmarker = null; };
export const hasStream = (): boolean => stream !== null;
let faceOn = false;
export const isFaceOn = (): boolean => faceOn;
/* 워커 경로는 보류 중이라 항상 null 이다. quality 가 '추론이 메인 스레드에 있는가'를 알아야 해서 노출한다. */
export const onWorker = (): boolean => worker !== null;
export async function initMainLandmarker(){
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
export let worker = null, workerReady = false, workerFrames = 0;
export let pumpMode = 'track', bitmapInFlight = false, bitmapAcc = 0;
// setTimeout 의 반환은 브라우저에선 number, Node 타입에선 Timeout 이다. 둘 다 받는다.
export let readyTimer: ReturnType<typeof setTimeout> | undefined;
export const trackProcessorOK = (typeof (globalThis as any).MediaStreamTrackProcessor !== 'undefined');
export function setThreadPill(text, warn?){
  const p = $('pThread');
  p.textContent = '스레드 ' + text;
  p.classList.toggle('warn', !!warn);
}
export const video = $('cam'), dots = $('dots'), dctx = dots.getContext('2d');
export let calibrating = false, calibUntil = 0, calibBuf = [];
export const base = { yaw:0, pitch:0, size:null, dist:null, jaw:0 };
export let lastSeen = 0;
// 목표 엿보기 각 — 추론(30fps)이 갱신하고 렌더(60fps)가 보간한다
export const peekTarget = { yaw:0, pitch:0 };
export const peekNow = { yaw:0, pitch:0 };

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
export function startWorker(){
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
export function pumpBitmap(dt){
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
export async function workerFail(msg){
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
export function resetCalib(){
  calibrating = false; calibBuf = [];
  $('calib').disabled = !stream;
  $('calib').textContent = '중립 자세 캘리브레이션 (2초)';
}
export function drawPoints(pts){
  dctx.clearRect(0,0,dots.width,dots.height);
  dctx.fillStyle = 'rgba(207,198,180,.5)';
  for(let i=0;i<pts.length;i+=2) dctx.fillRect(pts[i]*dots.width-1, pts[i+1]*dots.height-1, 2, 2);
}
export function stopCam(){
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
export function setMode(on){
  faceOn = on;
  const p = $('pMode');
  p.textContent = on ? '얼굴 모드' : '키보드 모드';
  p.classList.toggle('on', on); p.classList.toggle('warn', !on);
}

export function signals(lm, mtx, blend){
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
export function paintFace(b){
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
  setFacePainted(true);
}

/* ══ 추론 루프 — 30fps ════════════════════════════ */
export let inferAcc = 0, inferFps = 0, inferN = 0, inferT = 0, inferMs = 0, gAcc = 0;
export function infer(now, dt){
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

export function onNoFace(now){
  dctx.clearRect(0,0,dots.width,dots.height);
  if(now - lastSeen > 1500){ setMode(false); peekTarget.yaw = peekTarget.pitch = 0; }
}

/* 신호 처리 — 메인 추론과 워커 추론이 공유하는 단일 경로.
   필터·게이트·엿보기는 비용이 미미하므로 메인 스레드에 남긴다. */
export function onSignals(s, now){
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

