/*
 * viz.js — Canvas 绘制哈希环：节点/虚拟节点、键分布、迁移高亮、均衡度柱状图。
 */
(function (global) {
  'use strict';

  const TAU = Math.PI * 2;
  const RING_SIZE = 0x100000000;

  function posToAngle(pos) {
    return (pos / RING_SIZE) * TAU - Math.PI / 2; // 0 度在正上方，顺时针
  }

  /**
   * 绘制一个哈希环。
   * opts: {
   *   points, keys: [{key, pos, owner, migrated}], nodes: [{id, color}],
   *   collisions, title, highlightKey, empty
   * }
   * 返回键的屏幕坐标映射，供鼠标拾取。
   */
  function drawRing(canvas, opts) {
    const dpr = global.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || canvas.width;
    const cssH = canvas.clientHeight || canvas.height;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    const cx = cssW / 2;
    const cy = cssH / 2 + 6;
    const radius = Math.min(cssW, cssH) / 2 - 46;
    const colorOf = {};
    for (const n of opts.nodes) colorOf[n.id] = n.color;

    // 环本体
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.setLineDash(opts.points.length === 0 ? [6, 6] : []);
    ctx.strokeStyle = '#3a4157';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.setLineDash([]);

    // 空环提示
    if (opts.points.length === 0) {
      ctx.fillStyle = '#8a93ab';
      ctx.font = '14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('空环：请先添加节点', cx, cy);
      return { keyDots: [] };
    }

    // 节点 / 虚拟节点刻度
    const vnodeMode = opts.points.some((p) => p.vnode >= 0);
    for (const p of opts.points) {
      const a = posToAngle(p.pos);
      const inner = radius - (vnodeMode ? 7 : 10);
      const outer = radius + (vnodeMode ? 7 : 10);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
      ctx.strokeStyle = colorOf[p.nodeId] || '#999';
      ctx.lineWidth = vnodeMode ? 2 : 4;
      ctx.stroke();
      if (!vnodeMode) {
        // 无虚拟节点模式：画实心圆点 + 标签
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius, 6, 0, TAU);
        ctx.fillStyle = colorOf[p.nodeId] || '#999';
        ctx.fill();
        ctx.fillStyle = '#e8ebf4';
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        const lx = cx + Math.cos(a) * (radius + 24);
        const ly = cy + Math.sin(a) * (radius + 24);
        ctx.fillText(shortLabel(p.nodeId), lx, ly + 4);
      }
    }

    // 键
    const keyDots = [];
    for (const k of opts.keys) {
      const a = posToAngle(k.pos);
      const r = radius - 22;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      const color = k.owner ? (colorOf[k.owner] || '#888') : '#5a6072';
      ctx.beginPath();
      ctx.arc(x, y, k.key === opts.highlightKey ? 6 : 3.5, 0, TAU);
      ctx.fillStyle = color;
      ctx.fill();
      if (k.migrated) {
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, TAU);
        ctx.strokeStyle = '#ffd54a';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (k.key === opts.highlightKey) {
        ctx.beginPath();
        ctx.arc(x, y, 10, 0, TAU);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      keyDots.push({ key: k.key, x, y });
    }

    // 中心摘要
    ctx.fillStyle = '#8a93ab';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(opts.title || '', cx, cy - 6);
    ctx.fillText(
      `点 ${opts.points.length} · 键 ${opts.keys.length}` +
      (opts.collisions && opts.collisions.length ? ` · 冲突 ${opts.collisions.length}` : ''),
      cx, cy + 12
    );
    return { keyDots };
  }

  function shortLabel(id) {
    return id.length > 10 ? id.slice(0, 9) + '…' : id;
  }

  /**
   * 均衡度柱状图：每个节点一根柱，虚线为理想均值。
   */
  function drawBalance(canvas, opts) {
    const dpr = global.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || canvas.width;
    const cssH = canvas.clientHeight || canvas.height;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    const { nodes, counts, ideal } = opts;
    if (nodes.length === 0) {
      ctx.fillStyle = '#8a93ab';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('无节点', cssW / 2, cssH / 2);
      return;
    }
    const padL = 8, padB = 18, padT = 8;
    const chartH = cssH - padT - padB;
    const barArea = cssW - padL * 2;
    const maxVal = Math.max(ideal * 1.5, ...nodes.map((n) => counts[n.id] || 0), 1);
    const barW = Math.max(4, Math.min(40, barArea / nodes.length - 6));

    nodes.forEach((n, i) => {
      const x = padL + (barArea / nodes.length) * i + (barArea / nodes.length - barW) / 2;
      const v = counts[n.id] || 0;
      const h = (v / maxVal) * chartH;
      ctx.fillStyle = n.color;
      ctx.fillRect(x, padT + chartH - h, barW, h);
      ctx.fillStyle = '#c6cddd';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(v), x + barW / 2, padT + chartH - h - 3);
      ctx.fillStyle = '#8a93ab';
      ctx.fillText(shortLabel(n.id), x + barW / 2, cssH - 5);
    });

    // 理想均值虚线
    const yIdeal = padT + chartH - (ideal / maxVal) * chartH;
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.moveTo(padL, yIdeal);
    ctx.lineTo(cssW - padL, yIdeal);
    ctx.strokeStyle = '#ffd54a';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  global.HashRingViz = { drawRing, drawBalance, posToAngle };
})(self);
