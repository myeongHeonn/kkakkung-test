// 까꿍 — 얼굴 추론 워커  ⚠️ 현재 사용하지 않음 (보류)
//
// 이 파일은 spike-play.html 에서 로드되지 않는다. UI 옵션을 제거했다.
// 워커가 ready 까지는 도달하지만 프레임이 흐르지 않는 원인을 특정하지 못했고,
// 메인 스레드 추론(18ms)으로 프로토타입에 충분하다고 판단했다.
// 되살릴 조건과 그때 확인할 것은 구현계획.md S2 를 볼 것.
//
// MediaPipe 의 detectForVideo() 는 동기 호출이다. 메인 스레드에서 돌리면
// 18ms 짜리 추론이 16.6ms 프레임 예산을 그대로 잡아먹어 초당 20회 히칭이 생긴다.
// 렌더 비용을 0으로 만들어도 사라지지 않는 구조적 문제이므로 추론을 여기로 옮긴다.
//
// 프레임 공급 경로는 두 가지다.
//   track  — MediaStreamTrackProcessor 로 워커가 카메라에서 직접 당겨온다 (메인 비용 0)
//   bitmap — 메인이 createImageBitmap 으로 넘긴다 (메인 1~3ms, 동기 추론보다 훨씬 싸다)
//
// Blob URL 대신 실제 파일로 둔다. blob: 모듈 워커는 임포트 해석이 환경마다 달라
// 원인 파악이 어려운 실패를 낸다.

import { FaceLandmarker, FilesetResolver } from
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs';

let landmarker = null;
let canvas = null, ctx = null;
let ts = 0;                       // detectForVideo 는 단조 증가 타임스탬프를 요구한다
let busy = false;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const fail = (stage, err) =>
  post({ t: 'fail', stage, msg: String((err && err.message) || err) });

/* 랜드마크 → 신호. 메인의 signals() 와 동일한 계산을 유지해야 한다.
   도(°) 대신 정규화 비율을 쓰는 이유는 기획서 §2.2 / 구현계획 S1 참조. */
function signals(marks, mtx, blend){
  const nose = marks[1], L = marks[234], R = marks[454], top = marks[10], chin = marks[152];
  const dL = nose.x - L.x, dR = R.x - nose.x;
  const yaw = (dR - dL) / Math.max(1e-4, dL + dR);
  const faceH = Math.max(1e-4, chin.y - top.y);
  const pitch = (nose.y - (top.y + chin.y) / 2) / faceH;

  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for(const p of marks){
    if(p.x < minX) minX = p.x;
    if(p.x > maxX) maxX = p.x;
    if(p.y < minY) minY = p.y;
    if(p.y > maxY) maxY = p.y;
  }
  // 행렬 병진 성분 — 회전에 영향받지 않는 거리 신호 (bbox 면적의 크로스토크 대안)
  const dist = mtx ? Math.abs(mtx[14]) : 0;
  let jaw = 0;
  if(blend && blend.categories){
    const c = blend.categories.find(x => x.categoryName === 'jawOpen');
    if(c) jaw = c.score;
  }
  return {
    yaw, pitch, dist, jaw,
    size: Math.sqrt(Math.max(0, (maxX - minX) * (maxY - minY))),
    box: { minX, maxX, minY, maxY },
  };
}

function run(src){
  if(!landmarker || busy) return;
  busy = true;
  const t0 = performance.now();
  try {
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    ts += 33;
    const res = landmarker.detectForVideo(canvas, ts);
    const ms = performance.now() - t0;

    if(!res || !res.faceLandmarks || !res.faceLandmarks.length){
      post({ t: 'none', ms });
      return;
    }
    const marks = res.faceLandmarks[0];
    const mtx = (res.facialTransformationMatrixes && res.facialTransformationMatrixes.length)
      ? res.facialTransformationMatrixes[0].data : null;
    const blend = (res.faceBlendshapes && res.faceBlendshapes.length)
      ? res.faceBlendshapes[0] : null;

    // 미리보기용 포인트만 추려서 전송 (478개 전체를 직렬화할 필요는 없다)
    const pts = new Float32Array(Math.ceil(marks.length / 4) * 2);
    for(let i = 0, j = 0; i < marks.length; i += 4, j += 2){
      pts[j] = marks[i].x;
      pts[j + 1] = marks[i].y;
    }
    post({ t: 'sig', s: signals(marks, mtx, blend), ms, pts }, [pts.buffer]);
  } catch(err){
    fail('detect', err);
  } finally {
    busy = false;
  }
}

async function pump(track){
  try {
    if(typeof MediaStreamTrackProcessor === 'undefined')
      throw new Error('MediaStreamTrackProcessor 없음');
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    for(;;){
      const r = await reader.read();
      if(r.done) break;
      run(r.value);
      r.value.close();
    }
  } catch(err){
    fail('pump', err);
  }
}

async function createLandmarker(fileset, model, delegate, blend){
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: model, delegate },
    outputFacialTransformationMatrixes: true,
    outputFaceBlendshapes: !!blend,
    runningMode: 'VIDEO',
    numFaces: 1,
  });
}

self.onmessage = async (e) => {
  const d = e.data;

  if(d.t === 'init'){
    let fileset;
    try {
      fileset = await FilesetResolver.forVisionTasks(d.wasm);
    } catch(err){ return fail('wasm', err); }

    // GPU 델리게이트는 워커의 OffscreenCanvas WebGL 에 의존하므로 환경에 따라 실패한다.
    // 실패하면 CPU 로 자동 재시도하고, 실제로 쓰인 쪽을 메인에 알린다.
    let used = d.delegate;
    try {
      landmarker = await createLandmarker(fileset, d.model, d.delegate, d.blend);
    } catch(err){
      if(d.delegate === 'GPU'){
        try {
          landmarker = await createLandmarker(fileset, d.model, 'CPU', d.blend);
          used = 'CPU';
        } catch(err2){ return fail('model(GPU→CPU 모두 실패)', err2); }
      } else {
        return fail('model', err);
      }
    }

    try {
      canvas = new OffscreenCanvas(d.w, d.h);
      ctx = canvas.getContext('2d');
      if(!ctx) throw new Error('OffscreenCanvas 2d 컨텍스트 없음');
    } catch(err){ return fail('canvas', err); }

    post({ t: 'ready', delegate: used, pump: d.track ? 'track' : 'bitmap' });
    if(d.track) pump(d.track);
    return;
  }

  if(d.t === 'bitmap'){
    run(d.bmp);
    d.bmp.close();
  }
};
