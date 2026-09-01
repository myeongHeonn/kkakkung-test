import { $, P } from './core/dom.ts';
import { applyPixelRatio, flashlight } from './scene.ts';


/* ══ 자동 품질 조절 ═══════════════════════════════
   팀원마다 노트북이 다르다. 기본값을 낮추면 좋은 기기가 손해를 보고,
   높게 두면 약한 기기는 아예 못 논다. 그래서 프레임을 재서 스스로 내려간다.

   핵심은 '무엇이 느린가'를 구분하는 것이다:
     · 추론 ms 가 크면 메인 스레드가 막힌 것 — 추론 주기를 줄여야 한다
     · 그 외에 프레임이 길면 GPU 가 밀리는 것 — 해상도·후처리·그림자를 줄여야 한다
   구분하지 않고 한꺼번에 낮추면 안 잃어도 될 것까지 잃는다.

   내려가는 순서는 '눈에 덜 띄는 것부터'다. 해상도 1.25→1.0 은 거의 티가 안 나고,
   그림자를 끄는 건 손전등 연출이 통째로 바뀌므로 마지막에 가깝다. */
export const LADDER = [
  { px:'1.25', post:true,  shadow:true,  map:768, label:'최고' },
  { px:'1',    post:true,  shadow:true,  map:768, label:'높음' },
  { px:'1',    post:true,  shadow:true,  map:512, label:'높음−' },
  { px:'1',    post:false, shadow:true,  map:512, label:'중간' },
  { px:'1',    post:false, shadow:false, map:512, label:'낮음' },
  { px:'0.75', post:false, shadow:false, map:512, label:'최저' },
];
export const AQ = { auto:true, lv:0, last:0, hold:0 };

export function applyLadder(i){
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
export function qualPill(){
  const p = $('pQual');
  p.textContent = '품질 ' + LADDER[AQ.lv].label + (AQ.auto ? '' : ' (고정)');
  p.classList.toggle('warn', AQ.lv >= 4);
}

/* 0.5초마다 한 번씩 불린다. 잦게 손대면 화면이 계속 깜빡이므로 간격을 둔다. */
export function autoQuality(now: number, frameMs: number, iMs: number, onWorker = false){
  if(!AQ.auto) return;
  if(now - AQ.last < 2500) return;

  if(frameMs > 22){                            // 45fps 아래
    // 추론이 프레임 예산을 먹고 있으면 그것부터. 화질을 깎아도 이건 안 나아진다.
    if(!onWorker && iMs > 14 && P.inferHz! > 10){
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
