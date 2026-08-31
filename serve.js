// 까꿍 개발용 정적 서버 —  node serve.js  (기본 5199 포트)
// ES 모듈은 file:// 에서 CORS로 차단되고, getUserMedia 는 보안 컨텍스트(localhost)를 요구한다.
const http = require('http');
const fs = require('fs');
const path = require('path');

// 5173 은 Vite 기본 포트다. 이전 프로젝트가 남긴 서비스 워커가 그 오리진에
// 영구 등록돼 있으면 페이지를 가로채 중복 내비게이션을 일으킨다.
// 서비스 워커 스코프는 포트까지 포함하므로 포트를 옮기면 깨끗한 오리진이 된다.
const PORT = Number(process.argv[2] || 5199);
const ROOT = __dirname;
const TYPES = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8', '.md':'text/markdown; charset=utf-8',
  '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml',
  '.wasm':'application/wasm', '.task':'application/octet-stream',
};

let seq = 0;
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  // Colyseus 가 /matchmake 를 자기 리스너로 처리한다. 여기서 응답하면 충돌한다.
  if(url.startsWith('/matchmake')) return;
  // 브라우저가 실제로 무엇을 몇 번 요청하는지 남긴다 (중복 로드 추적용)
  const tag = String(++seq).padStart(3, '0');
  const h = req.headers;
  const meta = (h['sec-fetch-dest'] ? ' dest:' + h['sec-fetch-dest'] : '')
             + (h['sec-fetch-mode'] ? ' mode:' + h['sec-fetch-mode'] : '')
             + (h.referer ? ' ref:' + h.referer.replace(/^https?:\/\/[^/]+/, '') : '');
  res.on('finish', () => console.log(tag, req.method, res.statusCode, url + meta));

  let file = path.join(ROOT, url === '/' ? 'index.html' : url);

  // 루트 밖 접근 차단
  if (!path.resolve(file).startsWith(path.resolve(ROOT))) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.stat(file, (err, st) => {
    if (err || st.isDirectory()) {
      // 목록은 루트 요청에만 준다. 없는 파일에 HTML 을 돌려주면
      // 서비스워커·스크립트·아이콘 요청이 파싱 오류로 이어진다.
      if(err && url !== '/'){
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 ' + url);
        return;
      }
      // 루트와 한 단계 하위 폴더까지 훑는다. docs/ · spikes/ 로 나눈 뒤에도 목록이 비지 않도록.
      const list = dir => fs.readdirSync(path.join(ROOT, dir), { withFileTypes:true })
        .filter(d => d.isFile() && /\.html$|\.md$/.test(d.name))
        .map(d => (dir ? dir + '/' : '') + d.name);
      const items = ['', 'spikes', 'docs']
        .filter(d => !d || fs.existsSync(path.join(ROOT, d)))
        .flatMap(list)
        .map(n => `<li><a href="/${n.split('/').map(encodeURIComponent).join('/')}">${n}</a></li>`).join('');
      res.writeHead(err ? 404 : 200, { 'Content-Type': TYPES['.html'] });
      res.end(`<meta charset="utf-8"><title>까꿍 dev</title>
        <body style="background:#060404;color:#ebe4d9;font:14px system-ui;padding:40px">
        <h1 style="font-size:18px">까꿍 · dev server</h1><ul>${items}</ul>`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
});

/* 멀티플레이 — Colyseus. 설치돼 있을 때만 붙는다.
   혼자 톤·입력만 볼 때는 npm install 없이도 정적 서버가 떠야 한다. */
let multi = '꺼짐 — `npm install` 하면 켜진다';
let listen = cb => server.listen(PORT, cb);
try{
  const { Server: ColyseusServer } = require('colyseus');
  const { WebSocketTransport } = require('@colyseus/ws-transport');
  const { KkakkungRoom, MAX_PLAYERS } = require('./server/KkakkungRoom');

  const gameServer = new ColyseusServer({
    transport: new WebSocketTransport({ server }),
  });
  // 공개·비공개를 같은 방 정의로 쓰고 code 로 가른다.
  // code 가 같은 사람끼리 묶이고, code 없는 사람들은 공개 풀에서 매칭된다.
  gameServer.define('kkakkung', KkakkungRoom).filterBy(['code']);

  listen = cb => gameServer.listen(PORT).then(cb);
  multi = `켜짐 — Colyseus (방당 최대 ${MAX_PLAYERS}인)`;
}catch(e){
  if(e.code !== 'MODULE_NOT_FOUND') throw e;
}

listen(() => {
  console.log(`까꿍 dev server → http://localhost:${PORT}/spike-play.html`);
  console.log(`멀티플레이: ${multi}`);
});
