/* DOM 접근과 슬라이더 배선. 아무것도 import 하지 않는다.

   $ 가 any 를 돌려주는 건 임시다. 호출부가 input·select·button 을 가리지 않고 쓰는데,
   한 덩어리였을 때는 좁힐 자리가 없었다. 모듈로 나눈 지금은 각 모듈이
   자기가 쓰는 요소만 el<HTMLInputElement>('mincut') 처럼 좁히면 된다. */

export const $ = (id: string): any => document.getElementById(id);

/** 타입을 아는 곳에서는 이걸 쓴다 — $ 를 점점 대체한다 */
export function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if(!node) throw new Error('DOM 에 #' + id + ' 가 없다');
  return node as T;
}

/* alert 는 실행을 막고 원인 파악을 방해한다. 화면에 남겨서 읽을 수 있게 한다. */
export function showErr(title: string, msg: unknown): void {
  const box = $('err');
  if(!box){ console.error('[까꿍]', title, msg); return; }
  box.innerHTML = '<b>' + title + '</b><br>' + String(msg).replace(/</g, '&lt;') +
    '<button onclick="this.parentNode.classList.remove(\'show\')">닫기</button>';
  box.classList.add('show');
  console.error('[까꿍]', title, msg);
}

/** 슬라이더 값 사전. 키는 요소 id 다. */
export const P: Record<string, number> = {};

/** <input type=range id=X> 와 <output id=Xv> 를 묶고 값을 P[X] 에 담는다 */
export function bind(id: string, fmt: (v: number) => string, fn?: (v: number) => void): void {
  const input = $(id), out = $(id + 'v');
  const run = (): void => {
    P[id] = parseFloat(input.value);
    if(out) out.textContent = fmt(P[id]!);
    if(fn) fn(P[id]!);
  };
  input.addEventListener('input', run);
  run();
}
