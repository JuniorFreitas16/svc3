export const CELL = 1.5; // metros por célula da grade (escala real para RA)

export const key = c => `${c.x},${c.y}`;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function buildGrid(layout, shelves) {
  return {
    width: layout.width,
    height: layout.height,
    blocked: new Set(shelves.map(s => key(s))),
  };
}

const inside = (grid, c) => c.x >= 0 && c.y >= 0 && c.x < grid.width && c.y < grid.height;

function neighbors(grid, c) {
  return DIRS.map(([dx, dy]) => ({ x: c.x + dx, y: c.y + dy }))
    .filter(n => inside(grid, n) && !grid.blocked.has(key(n)));
}

export function accessCells(grid, shelf) {
  return DIRS.map(([dx, dy]) => ({ x: shelf.x + dx, y: shelf.y + dy }))
    .filter(n => inside(grid, n) && !grid.blocked.has(key(n)));
}

export function bfs(grid, start) {
  const dist = new Map([[key(start), 0]]);
  const prev = new Map();
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    const d = dist.get(key(c));
    for (const n of neighbors(grid, c)) {
      const k = key(n);
      if (!dist.has(k)) {
        dist.set(k, d + 1);
        prev.set(k, c);
        queue.push(n);
      }
    }
  }
  return { dist, prev };
}

export function pathTo(res, target) {
  const cells = [target];
  let k = key(target);
  while (res.prev.has(k)) {
    const p = res.prev.get(k);
    cells.unshift(p);
    k = key(p);
  }
  return cells;
}

export function planRoute(grid, origin, stops) {
  const originRes = bfs(grid, origin);
  const unreachable = [];
  const nodes = [];

  for (const s of stops) {
    let best = null, bestD = Infinity;
    for (const a of s.access) {
      const d = originRes.dist.get(key(a));
      if (d !== undefined && d < bestD) { best = a; bestD = d; }
    }
    if (best) nodes.push({ ...s, cell: best });
    else unreachable.push(s);
  }

  const points = [origin, ...nodes.map(n => n.cell)];
  const res = points.map(p => bfs(grid, p));
  const D = points.map((_, i) => points.map(p => res[i].dist.get(key(p)) ?? Infinity));

  const left = new Set(nodes.map((_, i) => i + 1));
  let seq = [0];
  let cur = 0;
  while (left.size) {
    let bestJ = -1, bestD = Infinity;
    for (const j of left) if (D[cur][j] < bestD) { bestD = D[cur][j]; bestJ = j; }
    if (bestJ === -1) bestJ = [...left][0];
    seq.push(bestJ);
    left.delete(bestJ);
    cur = bestJ;
  }

  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < seq.length - 1; i++) {
      for (let k = i + 1; k < seq.length; k++) {
        const a = seq[i - 1], b = seq[i], c = seq[k], d = seq[k + 1];
        const before = D[a][b] + (d !== undefined ? D[c][d] : 0);
        const after = D[a][c] + (d !== undefined ? D[b][d] : 0);
        if (after < before) {
          seq = [...seq.slice(0, i), ...seq.slice(i, k + 1).reverse(), ...seq.slice(k + 1)];
          improved = true;
        }
      }
    }
  }

  const legs = [];
  for (let s = 0; s < seq.length - 1; s++) {
    const from = seq[s], to = seq[s + 1];
    legs.push({
      cells: res[from].dist.has(key(points[to])) ? pathTo(res[from], points[to]) : [],
    });
  }

  const orderedStops = seq.slice(1).map(i => nodes[i - 1]);
  const steps = legs.reduce((n, l) => n + Math.max(0, l.cells.length - 1), 0);
  return { stops: orderedStops, legs, steps, unreachable };
}
