/* 까꿍 개발용 정적 서버 —  node serve.ts  (기본 5199 포트)
   ES 모듈은 file:// 에서 CORS로 차단되고, getUserMedia 는 보안 컨텍스트(localhost)를 요구한다.

   Node 24 는 .ts 를 타입만 벗겨내고 그대로 실행한다. 빌드 단계가 없다.
   타입 검사는 `npm run typecheck` (tsc --noEmit) 가 따로 한다. */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// 5173 은 Vite 기본 포트다. 이전 프로젝트가 남긴 서비스 워커가 그 오리진에
// 영구 등록돼 있으면 페이지를 가로채 중복 내비게이션을 일으킨다.
// 서비스 워커 스코프는 포트까지 포함하므로 포트를 옮기면 깨끗한 오리진이 된다.
const PORT = Number(process.argv[2] || 5199);

/* 빌드 산출물이 있으면 그걸 내보낸다 (배포). 없으면 저장소 루트다 (개발·스파이크).
   개발 중에는 Vite(5200)가 클라이언트를 서빙하고 이 서버는 Colyseus 만 맡는다.
   배포에서는 정적 파일과 게임 서버가 같은 포트에서 나가므로 같은 오리진이 된다 —
   그래야 클라이언트가 location.host 로 접속 주소를 만들 수 있다. */
const REPO = import.meta.dirname;
const DIST = path.join(REPO, 'dist');
const ROOT = fs.existsSync(path.join(DIST, 'index.html')) ? DIST : REPO;
const TYPES: Record<string, string> = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8', '.ts':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8', '.md':'text/markdown; charset=utf-8',
  '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml',
  '.wasm':'application/wasm', '.task':'application/octet-stream',
};

let seq = 0;
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]!);
  // Colyseus 가 /matchmake 를 자기 리스너로 처리한다. 여기서 응답하면 충돌한다.
  if(url.startsWith('/matchmake')) return;
  // 브라우저가 실제로 무엇을 몇 번 요청하는지 남긴다 (중복 로드 추적용)
  const tag = String(++seq).padStart(3, '0');
  const h = req.headers;
  const meta = (h['sec-fetch-dest'] ? ' dest:' + h['sec-fetch-dest'] : '')
             + (h['sec-fetch-mode'] ? ' mode:' + h['sec-fetch-mode'] : '')
             + (h.referer ? ' ref:' + h.referer.replace(/^https?:\/\/[^/]+/, '') : '');
  res.on('finish', () => console.log(tag, req.method, res.statusCode, url + meta));

  // dist 를 내보내는 중에도 docs/ · spikes/ 는 저장소에서 읽는다 (빌드에 안 들어간다)
  const base = (url.startsWith('/docs/') || url.startsWith('/spikes/')) ? REPO : ROOT;
  const file = path.join(base, url === '/' ? 'index.html' : url);

  // 루트 밖 접근 차단
  if(!path.resolve(file).startsWith(path.resolve(REPO))){
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.stat(file, (err, st) => {
    if(err || st.isDirectory()){
      // 목록은 루트 요청에만 준다. 없는 파일에 HTML 을 돌려주면
      // 서비스워커·스크립트·아이콘 요청이 파싱 오류로 이어진다.
      if(err && url !== '/'){
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 ' + url);
        return;
      }
      // 루트와 한 단계 하위 폴더까지 훑는다. docs/ · spikes/ 로 나눈 뒤에도 목록이 비지 않도록.
      const listDir = (dir: string): string[] =>
        fs.readdirSync(path.join(REPO, dir), { withFileTypes:true })
          .filter(d => d.isFile() && /\.html$|\.md$/.test(d.name))
          .map(d => (dir ? dir + '/' : '') + d.name);
      const items = ['', 'spikes', 'docs']
        .filter(d => !d || fs.existsSync(path.join(REPO, d)))
        .flatMap(listDir)
        .map(n => `<li><a href="/${n.split('/').map(encodeURIComponent).join('/')}">${n}</a></li>`).join('');
      res.writeHead(err ? 404 : 200, { 'Content-Type': TYPES['.html']! });
      res.end(`<meta charset="utf-8"><title>까꿍 dev</title>
        <body style="background:#060404;color:#ebe4d9;font:14px system-ui;padding:40px">
        <h1 style="font-size:18px">까꿍 · dev server</h1><ul>${items}</ul>`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
});

/* 멀티플레이 — Colyseus. 설치돼 있을 때만 붙는다.
   혼자 톤·입력만 볼 때는 npm install 없이도 정적 서버가 떠야 한다. */
let multi = '꺼짐 — `npm install` 하면 켜진다';
let listen: (cb: () => void) => void = cb => { server.listen(PORT, cb); };
try{
  const colyseus = (await import('colyseus')).default;
  const { WebSocketTransport } = await import('@colyseus/ws-transport');
  const { KkakkungRoom } = await import('./server/KkakkungRoom.ts');
  const { MAX_PLAYERS } = await import('./shared/protocol.ts');

  /* maxPayload 를 올린다. 기본값이 4KB 라 얼굴 스냅샷(수십 KB)을 보내면
     전송 계층이 코드 1009(Message Too Big)로 연결을 끊어버린다 —
     앱 레벨 검증(KkakkungRoom 의 FACE_MAX)에 닿지도 못한다.
     여기서 걸러지면 '연결이 끊겼다'만 뜨고 이유를 알 수 없으므로,
     한도를 FACE_MAX 보다 넉넉히 두고 거부는 방에서 하도록 한다. */
  const gameServer = new colyseus.Server({
    transport: new WebSocketTransport({ server, maxPayload: 96 * 1024 }),
  });
  // 공개·비공개를 같은 방 정의로 쓰고 code 로 가른다.
  // code 가 같은 사람끼리 묶이고, code 가 빈 문자열인 사람들은 공개 풀에서 매칭된다.
  gameServer.define('kkakkung', KkakkungRoom).filterBy(['code']);

  listen = cb => { void gameServer.listen(PORT).then(cb); };
  multi = `켜짐 — Colyseus (방당 최대 ${MAX_PLAYERS}인)`;
}catch(e){
  if((e as NodeJS.ErrnoException)?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
}

listen(() => {
  const where = ROOT === DIST ? '빌드본(dist)' : '저장소 루트';
  console.log(`까꿍 서버 → http://localhost:${PORT}/  (${where})`);
  if(ROOT !== DIST) console.log(`개발 중이면 클라이언트는 Vite 로: npm run dev → http://localhost:5200/`);
  console.log(`멀티플레이: ${multi}`);
});
