/* 까꿍 — 진입점. 모듈을 잇고 렌더 루프를 돈다.

   의존 방향은 한 줄기다:
     core/space · core/dom          (아무것도 import 하지 않는다)
       → scene → audio → player → minimap · quality · face · net
         → main (여기)
   순환이 되려던 두 곳은 뒤집었다:
     · audio 가 net 을 부르는 대신 net 이 setExitDread() 로 민다
     · player 가 net 을 부르는 대신 net 이 setSender() 로 자기를 꽂는다 */

import * as THREE from 'three';
import { EYE } from './core/space.ts';
import { $, P } from './core/dom.ts';
import { renderer, scene, camera, composer, grade, isPost, sizeBloomHalf, creature } from './scene.ts';
import { player, view, ease, bindKeys, setOnMoved } from './player.ts';
import { peekNow, peekTarget, infer, pumpBitmap, inferFps, inferMs, onWorker, trackProcessorOK } from './face.ts';
import { mapMark, mapDraw } from './minimap.ts';
import { autoQuality, qualPill, AQ, LADDER } from './quality.ts';
import { dread, sndDread, sndSight, SND } from './audio.ts';
import './ui.ts';
import './net.ts';

// 이동·회전이 끝나면 미니맵을 갱신한다. player 가 minimap 을 import 하면
// minimap → player → minimap 이 되므로 여기서 이어준다.
setOnMoved(() => { mapMark(player.x, player.y); mapDraw(player.x, player.y, player.dir); });
bindKeys();
qualPill();
mapMark(player.x, player.y);
mapDraw(player.x, player.y, player.dir);

/* 튜닝값 덤프 — 모든 모듈의 현재 값을 한 번에 찍는다.
   여기 있는 이유는 이 함수만 유일하게 전 모듈을 알기 때문이다. */


/* ══ 렌더 루프 — 60fps ════════════════════════════ */
let last = performance.now(), rAcc = 0, rN = 0, renderFps = 0;
function loop(now){
  requestAnimationFrame(loop);
  const dt = Math.min((now-last)/1000, 0.05); last = now;

  infer(now, dt);
  pumpBitmap(dt);

  if(view.anim){
    view.anim.t = Math.min(1, view.anim.t + dt/0.4);
    const e = ease(view.anim.t);
    if(view.anim.kind === 'move'){
      camera.position.x = view.anim.fx + (view.anim.tx-view.anim.fx)*e;
      camera.position.z = view.anim.fz + (view.anim.tz-view.anim.fz)*e;
      view.bob += dt*11;
    } else view.camYaw = view.anim.from + (view.anim.to-view.anim.from)*e;
    // 시야 판정은 이동·회전이 끝난 뒤 한 번만 한다 (스팅어를 한 번만 터뜨리기 위해)
    if(view.anim.t >= 1){ view.anim = null; sndSight(player.x, player.y, player.dir); }
  }

  // 저주기 추론 신호를 렌더 프레임레이트로 보간 (기획서 §2.2.4).
  // tau 가 작으면 반응이 빠르지만 계단이 보이고, 크면 매끄럽지만 늦다.
  const lerp = 1 - Math.exp(-dt/Math.max(0.005, P.peekTau));
  peekNow.yaw += (peekTarget.yaw - peekNow.yaw) * lerp;
  peekNow.pitch += (peekTarget.pitch - peekNow.pitch) * lerp;

  const idle = now/1000;
  camera.position.y = EYE + Math.sin(idle*0.9)*0.012 + Math.sin(view.bob)*0.035;
  camera.rotation.set(
    peekNow.pitch + Math.sin(idle*0.7)*0.006,
    view.camYaw + peekNow.yaw,
    Math.sin(idle*0.5)*0.004, 'YXZ');

  if(creature.visible) creature.lookAt(camera.position.x, 0, camera.position.z);
  grade.uniforms.uTime.value = idle;

  if(isPost()) composer.render(); else renderer.render(scene, camera);

  rN++; rAcc += dt;
  if(rAcc >= 0.5){
    /* 워커 추론의 fps 집계는 face.ts 가 자기 안에서 한다.
       워커 경로는 보류 중이라(docs/구현계획.md S2) onWorker() 는 늘 false 다. */
    renderFps = Math.round(rN/rAcc);
    const frameMs = (rAcc/rN)*1000;
    $('pRender').textContent = '렌더 '+renderFps+' fps';
    $('pFrame').textContent = '프레임 '+frameMs.toFixed(1)+' ms';
    $('pFrame').classList.toggle('warn', frameMs > 20);
    $('pRender').classList.toggle('warn', renderFps < 50);
    autoQuality(now, frameMs, inferMs, onWorker());
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
