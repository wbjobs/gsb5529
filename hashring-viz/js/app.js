import { buildRing, computeAssignment, diffAssignments, balanceStats, expectedMigrationRatio, pointLabel } from './ring.js';
import { drawRing, hitTest, colorForNode } from './canvas.js';
import { saveState, loadState, clearState } from './db.js';

// ---------- Web Worker 哈希 ----------
const worker = new Worker('js/worker.js');
let reqId = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const { id, results } = e.data;
  const resolve = pending.get(id);
  if (resolve) { pending.delete(id); resolve(results); }
};
function hashBatch(items) {
  return new Promise((resolve) => {
    const id = ++reqId;
    pending.set(id, resolve);
    worker.postMessage({ id, items });
  });
}

// ---------- 应用状态 ----------
const state = {
  nodes: [],            // [{id}]
  keys: [],             // [{id, position, hash}]
  vnodeCount: 100,
  hashCache: new Map(), // 环点标签 -> {position, hash}
  rings: { vnode: { points: [], collisions: [] }, plain: { points: [], collisions: [] } },
  assignments: { vnode: new Map(), plain: new Map() },
  migrated: { vnode: [], plain: [] },
  migratedKeyIds: new Set(),
  highlightKeyId: null,
  canvasState: { vnode: null, plain: null },
};

const $ = (sel) => document.querySelector(sel);
const canvasVnode = $('#ring-vnode');
const canvasPlain = $('#ring-plain');
const tooltip = $('#tooltip');

// ---------- 哈希缓存 ----------
async function ensureHashes(labels) {
  const missing = labels.filter((l) => !state.hashCache.has(l));
  if (missing.length === 0) return;
  const results = await hashBatch(missing);
  for (const r of results) state.hashCache.set(r.input, { position: r.position, hash: r.hash });
}
const hashOf = (label) => state.hashCache.get(label) || null;

// ---------- 重建环（核心流程） ----------
let rebuilding = false;
async function rebuild() {
  if (rebuilding) return;
  rebuilding = true;
  try {
    const labels = [];
    for (const node of state.nodes) {
      labels.push(pointLabel(node.id, -1));
      for (let i = 0; i < state.vnodeCount; i++) labels.push(pointLabel(node.id, i));
    }
    await ensureHashes(labels);

    const oldAssignments = state.assignments;
    state.rings.vnode = buildRing(state.nodes, state.vnodeCount, hashOf);
    state.rings.plain = buildRing(state.nodes, 1, hashOf);

    const newVnode = computeAssignment(state.rings.vnode.points, state.keys);
    const newPlain = computeAssignment(state.rings.plain.points, state.keys);
    state.migrated.vnode = diffAssignments(oldAssignments.vnode, newVnode);
    state.migrated.plain = diffAssignments(oldAssignments.plain, newPlain);
    state.assignments = { vnode: newVnode, plain: newPlain };

    state.migratedKeyIds = new Set([
      ...state.migrated.vnode.map((m) => m.keyId),
      ...state.migrated.plain.map((m) => m.keyId),
    ]);
    if (state.migratedKeyIds.size > 0) {
      setTimeout(() => { state.migratedKeyIds.clear(); render(); }, 4000);
    }
    render();
    persist();
  } finally {
    rebuilding = false;
  }
}

// ---------- 渲染 ----------
function nodeIds() { return state.nodes.map((n) => n.id); }

function render() {
  const ids = nodeIds();
  for (const mode of ['vnode', 'plain']) {
    const canvas = mode === 'vnode' ? canvasVnode : canvasPlain;
    state.canvasState[mode] = drawRing(canvas, {
      points: state.rings[mode].points,
      keys: state.keys,
      assignment: state.assignments[mode],
      nodeIds: ids,
      highlightKeyId: state.highlightKeyId,
      migratedKeyIds: state.migratedKeyIds,
      emptyText: '环为空：请添加节点',
    });
    renderStats(mode);
    renderMigration(mode);
  }
  renderCollisions();
  renderNodeList();
  renderKeyList();
  $('#vnode-count-label').textContent = state.vnodeCount;
  $('#key-count').textContent = state.keys.length;
  $('#node-count').textContent = state.nodes.length;
}

function renderStats(mode) {
  const stats = balanceStats(state.assignments[mode], nodeIds());
  const el = $(`#stats-${mode}`);
  if (state.nodes.length === 0) {
    el.innerHTML = '<div class="muted">空环：无统计信息</div>';
    return;
  }
  const fmt = (v, d = 2) => (v === null ? 'N/A' : (v === Infinity ? '∞' : Number(v).toFixed(d)));
  let rows = '';
  for (const id of nodeIds()) {
    const c = stats.counts.get(id) || 0;
    const pct = stats.total > 0 ? (c / stats.total) * 100 : 0;
    rows += `<tr>
      <td><span class="dot" style="background:${colorForNode(nodeIds(), id)}"></span>${escapeHtml(String(id))}</td>
      <td class="num">${c}</td>
      <td class="num">${pct.toFixed(1)}%</td>
      <td><div class="bar"><div class="bar-fill" style="width:${pct}%;background:${colorForNode(nodeIds(), id)}"></div></div></td>
    </tr>`;
  }
  el.innerHTML = `
    <div class="stat-summary">
      <span>变异系数 CV: <b>${fmt(stats.cv, 4)}</b></span>
      <span>标准差: <b>${fmt(stats.stddev)}</b></span>
      <span>Max/Min: <b>${fmt(stats.maxMinRatio)}</b></span>
      <span>理想均值: <b>${fmt(stats.mean, 1)}</b></span>
    </div>
    <table class="stat-table"><thead><tr><th>节点</th><th>键数</th><th>占比</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderMigration(mode) {
  const el = $(`#migration-${mode}`);
  const migrated = state.migrated[mode];
  const n = state.nodes.length;
  if (n === 0 || state.keys.length === 0) { el.innerHTML = '<div class="muted">无迁移数据</div>'; return; }
  const actual = migrated.length / state.keys.length;
  // 期望比例基于增删前后的节点数估算
  const before = n - lastNodeDelta;
  const expected = before > 0 ? expectedMigrationRatio(before, n) : null;
  const sample = migrated.slice(0, 8).map((m) =>
    `<li><code>${escapeHtml(String(m.keyId))}</code>: ${escapeHtml(String(m.from))} → ${escapeHtml(String(m.to))}</li>`).join('');
  el.innerHTML = `
    <div class="stat-summary">
      <span>迁移键数: <b>${migrated.length}</b> / ${state.keys.length}</span>
      <span>实际比例: <b>${(actual * 100).toFixed(2)}%</b></span>
      ${expected !== null ? `<span>理论最小: <b>≈${(expected * 100).toFixed(2)}%</b></span>` : ''}
    </div>
    ${migrated.length ? `<ul class="migration-list">${sample}${migrated.length > 8 ? `<li class="muted">…共 ${migrated.length} 条</li>` : ''}</ul>` : '<div class="muted">无键迁移</div>'}`;
}

function renderCollisions() {
  const el = $('#collisions');
  const items = [];
  for (const mode of ['vnode', 'plain']) {
    for (const c of state.rings[mode].collisions) {
      items.push(`<li>[${mode === 'vnode' ? '虚拟节点环' : '物理节点环'}] 位置 ${c.position}: ${c.labels.map(escapeHtml).join(', ')}</li>`);
    }
  }
  // 键之间的哈希冲突
  const byPos = new Map();
  for (const k of state.keys) {
    if (!byPos.has(k.position)) byPos.set(k.position, []);
    byPos.get(k.position).push(k.id);
  }
  for (const [pos, ids] of byPos) {
    if (ids.length > 1) items.push(`<li>[键] 位置 ${pos}: ${ids.map(escapeHtml).join(', ')}</li>`);
  }
  el.innerHTML = items.length
    ? `<ul class="collision-list">${items.join('')}</ul>`
    : '<div class="ok">未检测到哈希冲突</div>';
}

function renderNodeList() {
  const el = $('#node-list');
  el.innerHTML = state.nodes.map((n) =>
    `<span class="chip" style="border-color:${colorForNode(nodeIds(), n.id)}">
      <span class="dot" style="background:${colorForNode(nodeIds(), n.id)}"></span>${escapeHtml(String(n.id))}
      <button class="chip-x" data-remove-node="${escapeHtml(String(n.id))}" title="删除节点">×</button>
    </span>`).join('') || '<span class="muted">无节点</span>';
}

function renderKeyList() {
  const el = $('#key-list');
  const shown = state.keys.slice(0, 200);
  el.innerHTML = shown.map((k) => {
    const owner = state.assignments.vnode.get(k.id);
    return `<span class="chip key-chip ${k.id === state.highlightKeyId ? 'active' : ''}" data-key="${escapeHtml(String(k.id))}">
      <span class="dot" style="background:${owner != null ? colorForNode(nodeIds(), owner) : '#666'}"></span>${escapeHtml(String(k.id))}
      <button class="chip-x" data-remove-key="${escapeHtml(String(k.id))}" title="删除键">×</button>
    </span>`;
  }).join('') + (state.keys.length > 200 ? `<span class="muted">…共 ${state.keys.length} 个，仅显示前 200</span>` : '')
    || '<span class="muted">无键</span>';
}

// ---------- 持久化 ----------
let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    saveState({
      nodes: state.nodes,
      keys: state.keys,
      vnodeCount: state.vnodeCount,
    }).catch((err) => console.error('持久化失败', err));
  }, 300);
}

// ---------- 操作 ----------
let lastNodeDelta = 0;

async function addNode(id) {
  id = (id || `node-${state.nodes.length + 1}`).trim();
  if (!id || state.nodes.some((n) => n.id === id)) return;
  state.nodes.push({ id });
  lastNodeDelta = +1;
  await rebuild();
}

async function removeNode(id) {
  const i = state.nodes.findIndex((n) => n.id === id);
  if (i < 0) return;
  state.nodes.splice(i, 1);
  lastNodeDelta = -1;
  await rebuild();
}

async function addKeys(ids) {
  const fresh = ids.map((s) => s.trim()).filter((s) => s && !state.keys.some((k) => k.id === s));
  if (fresh.length === 0) return;
  const results = await hashBatch(fresh);
  for (const r of results) state.keys.push({ id: r.input, position: r.position, hash: r.hash });
  lastNodeDelta = 0;
  await rebuild();
}

async function removeKey(id) {
  const i = state.keys.findIndex((k) => k.id === id);
  if (i < 0) return;
  state.keys.splice(i, 1);
  if (state.highlightKeyId === id) state.highlightKeyId = null;
  lastNodeDelta = 0;
  await rebuild();
}

// ---------- UI 事件 ----------
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$('#btn-add-node').addEventListener('click', () => {
  addNode($('#node-input').value);
  $('#node-input').value = '';
});
$('#node-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-add-node').click(); });

$('#btn-add-key').addEventListener('click', () => {
  addKeys([$('#key-input').value || `key-${Math.random().toString(36).slice(2, 8)}`]);
  $('#key-input').value = '';
});
$('#key-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-add-key').click(); });

$('#btn-add-100-keys').addEventListener('click', () => {
  const base = Date.now().toString(36);
  addKeys(Array.from({ length: 100 }, (_, i) => `key-${base}-${i}`));
});

$('#vnode-slider').addEventListener('input', async (e) => {
  state.vnodeCount = Number(e.target.value);
  $('#vnode-count-label').textContent = state.vnodeCount;
  lastNodeDelta = 0;
  await rebuild();
});

$('#btn-clear-keys').addEventListener('click', async () => { state.keys = []; lastNodeDelta = 0; await rebuild(); });
$('#btn-reset').addEventListener('click', async () => {
  await clearState();
  state.nodes = []; state.keys = []; state.hashCache.clear();
  state.assignments = { vnode: new Map(), plain: new Map() };
  state.migrated = { vnode: [], plain: [] };
  await seed();
});

document.body.addEventListener('click', (e) => {
  const rn = e.target.dataset.removeNode;
  const rk = e.target.dataset.removeKey;
  if (rn) removeNode(rn);
  if (rk) removeKey(rk);
  const keyChip = e.target.closest('.key-chip');
  if (keyChip && !rk) {
    const id = keyChip.dataset.key;
    state.highlightKeyId = state.highlightKeyId === id ? null : id;
    render();
  }
});

// 悬停提示
for (const [mode, canvas] of [['vnode', canvasVnode], ['plain', canvasPlain]]) {
  canvas.addEventListener('mousemove', (e) => {
    const cs = state.canvasState[mode];
    if (!cs) return;
    const rect = canvas.getBoundingClientRect();
    const hit = hitTest(cs, e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) { tooltip.style.display = 'none'; return; }
    let html;
    if (hit.type === 'point') {
      const p = hit.point;
      html = p.vnodeIndex >= 0
        ? `<b>${escapeHtml(String(p.nodeId))}</b> 虚拟节点 #${p.vnodeIndex}<br>标签: ${escapeHtml(p.label)}<br>位置: ${p.position}<br>hash: ${p.hash}`
        : `<b>${escapeHtml(String(p.nodeId))}</b>（物理节点）<br>位置: ${p.position}<br>hash: ${p.hash}`;
    } else {
      const k = hit.key;
      const owner = state.assignments[mode].get(k.id);
      html = `键 <b>${escapeHtml(String(k.id))}</b><br>位置: ${k.position}<br>hash: ${k.hash}<br>归属: <b>${owner != null ? escapeHtml(String(owner)) : '无（空环）'}</b>`;
    }
    tooltip.innerHTML = html;
    tooltip.style.display = 'block';
    tooltip.style.left = `${e.clientX + 12}px`;
    tooltip.style.top = `${e.clientY + 12}px`;
  });
  canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
}

window.addEventListener('resize', render);

// ---------- 初始化 ----------
async function seed() {
  state.vnodeCount = 100;
  $('#vnode-slider').value = 100;
  state.nodes = [{ id: 'node-A' }, { id: 'node-B' }, { id: 'node-C' }, { id: 'node-D' }];
  const base = Date.now().toString(36);
  const keyIds = Array.from({ length: 300 }, (_, i) => `key-${base}-${i}`);
  const results = await hashBatch(keyIds);
  state.keys = results.map((r) => ({ id: r.input, position: r.position, hash: r.hash }));
  lastNodeDelta = 0;
  await rebuild();
}

async function init() {
  try {
    const saved = await loadState();
    if (saved && saved.nodes) {
      state.nodes = saved.nodes;
      state.keys = saved.keys || [];
      state.vnodeCount = saved.vnodeCount ?? 100;
      $('#vnode-slider').value = state.vnodeCount;
      lastNodeDelta = 0;
      await rebuild();
      return;
    }
  } catch (err) {
    console.warn('读取持久化配置失败，使用默认数据', err);
  }
  await seed();
}

init();
