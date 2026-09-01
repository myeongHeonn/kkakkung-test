/* 슬라이더·체크박스 배선. */
import * as THREE from 'three';
import { $, P, bind } from './core/dom.ts';
import { renderer, scene, flashlight, ambient, bloom, grade, setPost, applyPixelRatio } from './scene.ts';
import { fYaw, fPitch, fSize, dropLandmarker, hasStream } from './face.ts';
import { SND, applyVol, sndStart, sndPill } from './audio.ts';

/* ══ UI 배선 ══════════════════════════════════════ */

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
$('tPost').onchange = (e: Event) => setPost((e.target as HTMLInputElement).checked);
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
export const sndUnlock = e => {
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
$('pxRatio').onchange = applyPixelRatio;
['thread','delegate','useBlend'].forEach(id => {
  $(id).addEventListener('change', () => {
    dropLandmarker();                        // 옵션은 생성 시점에 굳으므로 버린다
    if(hasStream()) $('start').textContent = '카메라 다시 시작 필요';
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
