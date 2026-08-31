/* 미로 생성 · 경로 · 시야 — 순수 함수만 둔다.
   네트워크도 타이머도 여기 넣지 않는다. 그래야 브라우저 없이 전부 검증할 수 있다.

   좌표 규약은 클라이언트와 같다 (구현계획.md S0):
     grid[y][x] === '#' 이면 벽, 그 외는 통로
     DIRS = [북, 동, 남, 서]  — 클라이언트 DIRS 와 인덱스가 일치해야 한다 */

const DIRS = [{ dx:0, dy:-1 }, { dx:1, dy:0 }, { dx:0, dy:1 }, { dx:-1, dy:0 }];

// 시드 난수 — 같은 시드는 같은 미로를 준다. 테스트가 재현 가능해야 하고,
// 방에 접속한 전원이 똑같은 미로를 봐야 한다.
function rng(seed){
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const walkable = (grid, x, y) =>
  y >= 0 && y < grid.length && x >= 0 && x < grid[y].length && grid[y][x] !== '#';

/* 재귀적 백트래커로 완전미로를 만든 뒤, 막다른 길을 일부 터서 고리를 낸다.
   완전미로는 술래잡기에 최악이다 — 도망자가 막다른 길에 들어가면 그 순간 끝난다.
   고리가 있어야 "돌아서 빠져나간다"는 선택지가 생기고, 그때부터 추격이 게임이 된다. */
function generate(w, h, seed){
  // 홀수여야 벽/통로가 교대로 맞아떨어진다
  w = w % 2 ? w : w + 1;
  h = h % 2 ? h : h + 1;
  const rand = rng(seed);
  const g = Array.from({ length:h }, () => Array(w).fill('#'));

  const stack = [{ x:1, y:1 }];
  g[1][1] = '.';
  while(stack.length){
    const cur = stack[stack.length - 1];
    const cand = [];
    for(const d of DIRS){
      const nx = cur.x + d.dx*2, ny = cur.y + d.dy*2;
      if(nx > 0 && nx < w-1 && ny > 0 && ny < h-1 && g[ny][nx] === '#') cand.push({ nx, ny, d });
    }
    if(!cand.length){ stack.pop(); continue; }
    const p = cand[(rand()*cand.length)|0];
    g[cur.y + p.d.dy][cur.x + p.d.dx] = '.';   // 사이 벽을 튼다
    g[p.ny][p.nx] = '.';
    stack.push({ x:p.nx, y:p.ny });
  }

  // 고리 내기 — 막다른 칸의 벽 하나를 확률적으로 튼다
  const deadEnds = [];
  for(let y=1; y<h-1; y++) for(let x=1; x<w-1; x++){
    if(g[y][x] === '#') continue;
    if(DIRS.filter(d => walkable(g, x+d.dx, y+d.dy)).length === 1) deadEnds.push({ x, y });
  }
  for(const de of deadEnds){
    if(rand() > 0.72) continue;                // 28% 는 막다른 길로 남긴다 — 전부 트면 긴장이 사라진다
    const opts = DIRS.filter(d => {
      const wx = de.x + d.dx, wy = de.y + d.dy;
      const bx = de.x + d.dx*2, by = de.y + d.dy*2;
      return g[wy] && g[wy][wx] === '#' && walkable(g, bx, by);
    });
    if(opts.length){
      const d = opts[(rand()*opts.length)|0];
      g[de.y + d.dy][de.x + d.dx] = '.';
    }
  }
  return { grid: g.map(r => r.join('')), w, h, seed };
}

/* 시작점에서의 칸 거리. 도달 불가는 -1.
   탈출구 배치·경로 보장·탈출구 방향 신호가 전부 이걸 쓴다. */
function bfs(grid, start){
  const h = grid.length, w = grid[0].length;
  const dist = Array.from({ length:h }, () => Array(w).fill(-1));
  if(!walkable(grid, start.x, start.y)) return dist;
  dist[start.y][start.x] = 0;
  const q = [start];
  for(let i=0; i<q.length; i++){
    const c = q[i];
    for(const d of DIRS){
      const nx = c.x + d.dx, ny = c.y + d.dy;
      if(!walkable(grid, nx, ny) || dist[ny][nx] !== -1) continue;
      dist[ny][nx] = dist[c.y][c.x] + 1;
      q.push({ x:nx, y:ny });
    }
  }
  return dist;
}

const reachable = (grid, a, b) => bfs(grid, a)[b.y][b.x] >= 0;

function cells(grid){
  const out = [];
  for(let y=0; y<grid.length; y++) for(let x=0; x<grid[y].length; x++)
    if(grid[y][x] !== '#') out.push({ x, y });
  return out;
}

// from 에서 가장 먼 통로 칸
function farthest(grid, from){
  const d = bfs(grid, from);
  let best = { x:from.x, y:from.y, d:0 };
  for(const c of cells(grid)) if(d[c.y][c.x] > best.d) best = { x:c.x, y:c.y, d:d[c.y][c.x] };
  return best;
}

/* 배치 — 도망자는 한곳에서 같이 출발하고, 탈출구는 거기서 가장 멀리,
   술래는 도망자와 탈출구 양쪽에서 떨어진 곳에 둔다.
   술래를 탈출구 옆에 두면 그냥 지키고 서 있으면 되므로 게임이 성립하지 않는다.

   술래가 2명이면 두 번째는 첫 번째와도 떨어뜨린다 — 같은 데서 출발하면
   둘이 한 덩어리로 몰려다녀서 사실상 1명과 다를 게 없다. */
function placeSpawns(grid, seed, itCount = 2){
  const rand = rng(seed ^ 0x9E3779B9);
  const all = cells(grid);
  const runner = all[(rand()*all.length)|0];
  const exit = farthest(grid, runner);
  const dR = bfs(grid, runner), dE = bfs(grid, exit);

  const itSpawns = [];
  for(let k=0; k<Math.max(1, itCount); k++){
    const prev = itSpawns.map(s => bfs(grid, s));
    let best = null, bestScore = -1;
    for(const c of all){
      const a = dR[c.y][c.x], b = dE[c.y][c.x];
      if(a < 0 || b < 0) continue;
      // 도망자·탈출구·이미 뽑은 술래 자리 — 그중 가장 가까운 것을 최대화한다
      let score = Math.min(a, b);
      for(const p of prev) score = Math.min(score, p[c.y][c.x]);
      if(score > bestScore){ bestScore = score; best = { x:c.x, y:c.y }; }
    }
    itSpawns.push(best || { x:runner.x, y:runner.y });
  }
  return {
    runnerSpawn: { x:runner.x, y:runner.y },
    exit: { x:exit.x, y:exit.y },
    itSpawns,
    itSpawn: itSpawns[0],          // 예전 이름 — 호출부가 남아 있어도 깨지지 않게
    exitDist: exit.d,
  };
}

/* 직선 시야 (기획서 §1.2) — 정면 직선상이고 중간에 벽이 없을 때만 보인다.
   서버가 이걸로 걸러서 보낸다. 안 보내면 클라이언트를 열어봐도 알 수 없다. */
function lineOfSight(grid, from, dir, maxCells = 12){
  const d = DIRS[dir], seen = [];
  let x = from.x, y = from.y;
  for(let i=0; i<maxCells; i++){
    x += d.dx; y += d.dy;
    if(!walkable(grid, x, y)) break;
    seen.push({ x, y, d:i + 1 });
  }
  return seen;
}

module.exports = { DIRS, rng, walkable, generate, bfs, reachable, cells, farthest, placeSpawns, lineOfSight };
