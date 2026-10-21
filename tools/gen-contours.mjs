// Generates a seeded contour-line SVG (marching squares on a synthetic height field).
// Usage: node tools/gen-contours.mjs <out.svg> <stroke> <opacity> [indexStroke]
import fs from 'node:fs';
const [out, stroke = '#888', op = '0.12', idx = stroke] = process.argv.slice(2);
const W = 1600, H = 1000, CELL = 10, NX = W / CELL + 1, NY = H / CELL + 1;
let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
const bumps = Array.from({ length: 9 }, () => ({ x: rnd() * W, y: rnd() * H, r: 160 + rnd() * 300, a: 0.5 + rnd() * 0.9 }));
const f = (x, y) => {
  let v = 0;
  for (const b of bumps) v += b.a * Math.exp(-((x - b.x) ** 2 + (y - b.y) ** 2) / (2 * b.r * b.r));
  return v + 0.05 * Math.sin(x / 70 + y / 110) + 0.03 * Math.sin(y / 45 - x / 90);
};
const g = []; let max = 0;
for (let j = 0; j < NY; j++) { g[j] = []; for (let i = 0; i < NX; i++) { g[j][i] = f(i * CELL, j * CELL); max = Math.max(max, g[j][i]); } }
const levels = []; for (let l = 0.12; l < max; l += 0.085) levels.push(l);
const paths = { thin: [], index: [] };
levels.forEach((L, li) => {
  const segs = [];
  const P = (x1, y1, v1, x2, y2, v2) => { const t = (L - v1) / (v2 - v1); return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]; };
  for (let j = 0; j < NY - 1; j++) for (let i = 0; i < NX - 1; i++) {
    const x = i * CELL, y = j * CELL, a = g[j][i], b = g[j][i + 1], c = g[j + 1][i + 1], d = g[j + 1][i];
    const code = (a > L) * 8 + (b > L) * 4 + (c > L) * 2 + (d > L);
    if (code === 0 || code === 15) continue;
    const T = () => P(x, y, a, x + CELL, y, b), R = () => P(x + CELL, y, b, x + CELL, y + CELL, c), B = () => P(x, y + CELL, d, x + CELL, y + CELL, c), Lf = () => P(x, y, a, x, y + CELL, d);
    const m = { 1: [Lf, B], 2: [B, R], 3: [Lf, R], 4: [T, R], 6: [T, B], 7: [Lf, T], 8: [Lf, T], 9: [T, B], 11: [T, R], 12: [Lf, R], 13: [B, R], 14: [Lf, B] }[code];
    if (m) segs.push([m[0](), m[1]()]); else if (code === 5) { segs.push([Lf(), T()], [B(), R()]); } else if (code === 10) { segs.push([T(), R()], [Lf(), B()]); }
  }
  const k = (p) => p[0].toFixed(1) + ',' + p[1].toFixed(1);
  const map = new Map(); segs.forEach((sg, n) => sg.forEach((p) => { const key = k(p); (map.get(key) || map.set(key, []).get(key)).push(n); }));
  const used = new Set(); const d = [];
  for (let n = 0; n < segs.length; n++) {
    if (used.has(n)) continue; used.add(n);
    let line = [segs[n][0], segs[n][1]];
    for (const dir of [1, 0]) {
      for (;;) {
        const end = dir ? line[line.length - 1] : line[0];
        const nxt = (map.get(k(end)) || []).find((q) => !used.has(q)); if (nxt === undefined) break;
        used.add(nxt); const sg = segs[nxt]; const other = k(sg[0]) === k(end) ? sg[1] : sg[0];
        dir ? line.push(other) : line.unshift(other);
      }
    }
    d.push('M' + line.map((p) => p[0].toFixed(0) + ' ' + p[1].toFixed(0)).join('L'));
  }
  paths[li % 5 === 0 ? 'index' : 'thin'].push(...d);
});
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice"><g fill="none" stroke-linejoin="round"><path stroke="${stroke}" stroke-opacity="${op}" stroke-width="1" d="${paths.thin.join('')}"/><path stroke="${idx}" stroke-opacity="${Math.min(1, op * 1.9)}" stroke-width="1.6" d="${paths.index.join('')}"/></g></svg>`;
fs.writeFileSync(out, svg); console.log(out, (svg.length / 1024).toFixed(0) + 'KB');
