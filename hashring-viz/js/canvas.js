// Canvas 环渲染：节点/虚拟节点画在圆周上，键按归属节点着色
import { RING_SIZE } from './ring.js';

export const NODE_COLORS = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#bfef45', '#469990', '#9a6324',
  '#800000', '#000075', '#808000', '#e6beff', '#aaffc3',
];

export function colorForNode(nodeIds, nodeId) {
  const i = nodeIds.indexOf(nodeId);
  return i < 0 ? '#888' : NODE_COLORS[i % NODE_COLORS.length];
}

function angleOf(position) {
  return (position / RING_SIZE) * Math.PI * 2 - Math.PI / 2; // 0 在正上方，顺时针
}

// 命中检测：返回距 (x,y) 最近的环上对象 {type:'point'|'key', ...}
export function hitTest(state, x, y) {
  const { cx, cy, radius, points, keys } = state;
  let best = null, bestDist = 14; // 像素阈值
  const consider = (px, py, obj) => {
    const d = Math.hypot(px - x, py - y);
    if (d < bestDist) { bestDist = d; best = obj; }
  };
  for (const p of points) {
    const a = angleOf(p.position);
    consider(cx + radius * Math.cos(a), cy + radius * Math.sin(a), { type: 'point', point: p });
  }
  for (const k of keys) {
    const a = angleOf(k.position);
    const r = radius - 26;
    consider(cx + r * Math.cos(a), cy + r * Math.sin(a), { type: 'key', key: k });
  }
  return best;
}

// 主绘制函数
// opts: { points, keys, assignment, nodeIds, highlightKeyId, migratedKeyIds, emptyText }
export function drawRing(canvas, opts) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
    canvas.width = W * dpr; canvas.height = H * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const cx = W / 2, cy = H / 2;
  const radius = Math.min(W, H) / 2 - 46;
  const state = { cx, cy, radius, points: opts.points, keys: opts.keys };

  // 环本体
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = '#3a3f4b';
  ctx.lineWidth = 3;
  ctx.stroke();

  // 刻度（0%, 25%, 50%, 75%）
  ctx.fillStyle = '#8b93a3';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  for (const [frac, label] of [[0, '0'], [0.25, '2³⁰'], [0.5, '2³¹'], [0.75, '3×2³⁰']]) {
    const a = frac * Math.PI * 2 - Math.PI / 2;
    ctx.fillText(label, cx + (radius + 16) * Math.cos(a), cy + (radius + 16) * Math.sin(a) + 4);
  }

  if (opts.points.length === 0) {
    ctx.fillStyle = '#8b93a3';
    ctx.font = '14px sans-serif';
    ctx.fillText(opts.emptyText || '环为空：请添加节点', cx, cy);
    return state;
  }

  // 键（小圆点，按归属节点着色；迁移的键加发光描边）
  for (const k of opts.keys) {
    const a = angleOf(k.position);
    const r = radius - 26;
    const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
    const owner = opts.assignment.get(k.id);
    ctx.beginPath();
    ctx.arc(x, y, k.id === opts.highlightKeyId ? 6 : 3.5, 0, Math.PI * 2);
    ctx.fillStyle = owner === null || owner === undefined ? '#666' : colorForNode(opts.nodeIds, owner);
    if (opts.migratedKeyIds && opts.migratedKeyIds.has(k.id)) {
      ctx.shadowColor = '#ffd166';
      ctx.shadowBlur = 10;
      ctx.strokeStyle = '#ffd166';
    }
    ctx.fill();
    ctx.shadowBlur = 0;
    if (k.id === opts.highlightKeyId) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // 连线到归属点
      const p = opts.points.find(pt => pt.nodeId === owner && isOwnerPoint(opts.points, pt, k.position));
      if (p) {
        const pa = angleOf(p.position);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(cx + radius * Math.cos(pa), cy + radius * Math.sin(pa));
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.stroke();
      }
    }
  }

  // 环上的点：虚拟节点小方块，物理节点大圆点 + 标签
  for (const p of opts.points) {
    const a = angleOf(p.position);
    const x = cx + radius * Math.cos(a), y = cy + radius * Math.sin(a);
    const color = colorForNode(opts.nodeIds, p.nodeId);
    if (p.vnodeIndex >= 0) {
      ctx.beginPath();
      ctx.rect(x - 3.5, y - 3.5, 7, 7);
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // 物理节点标签（每节点只标一次，取该节点第一个点位置）
  const labeled = new Set();
  ctx.font = 'bold 12px sans-serif';
  for (const p of opts.points) {
    if (labeled.has(p.nodeId)) continue;
    labeled.add(p.nodeId);
    const a = angleOf(p.position);
    const x = cx + (radius + 30) * Math.cos(a), y = cy + (radius + 30) * Math.sin(a);
    ctx.fillStyle = colorForNode(opts.nodeIds, p.nodeId);
    ctx.fillText(String(p.nodeId), x, y + 4);
  }
  return state;
}

// 判断 point 是否为 key 的归属点（顺时针第一个 >= keyPosition 的点）
function isOwnerPoint(points, point, keyPosition) {
  let lo = 0, hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].position < keyPosition) lo = mid + 1;
    else hi = mid;
  }
  return points[lo % points.length] === point;
}
