import { defineConfig } from 'vite';

/* 까꿍 클라이언트 빌드 · 개발 서버

   ⚠️ 5173(Vite 기본 포트)을 쓰지 않는다. 이전 프로젝트가 남긴 서비스 워커가
   그 오리진에 영구 등록돼 있어 페이지를 가로채고 중복 내비게이션을 일으킨다.
   서비스 워커 스코프는 포트를 포함하므로 포트를 옮기면 깨끗한 오리진이 된다.
   (docs/다음작업.md 에 기록된 실측 사항)

   게임 서버(Colyseus)는 5199 에서 따로 돈다. 매치메이킹 HTTP 와 WebSocket 을
   같은 오리진처럼 보이게 프록시한다 — 그래야 클라이언트가 location.host 로
   접속 주소를 만드는 코드를 개발·배포에서 똑같이 쓸 수 있다. */
export default defineConfig({
  server: {
    port: 5200,
    /* 프록시를 두지 않는다.
       Colyseus 의 WebSocket 경로가 /{processId}/{roomId} 라 접두사로 프록시할 수 없고,
       매치메이킹 HTTP 는 Colyseus 가 이미 CORS 헤더를 붙여준다(실측 확인).
       그래서 개발에서는 클라이언트가 5199 로 직접 붙는다 — src/net.ts 의 endpoint 참조.
       배포에서는 serve.ts 가 정적 파일과 Colyseus 를 같은 포트에서 내보내므로 같은 오리진이 된다. */
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    // 소스맵이 있어야 배포된 화면에서 난 오류를 원본 줄로 되짚을 수 있다
    sourcemap: true,
  },
});
