/*
 * app.js — 主线程：状态管理、Worker 调度、迁移计算、渲染、持久化。
 */
(function () {
  'use strict';

  const PALETTE = [
    '#4fc3f7', '#aed581', '#ffb74d', '#f06292', '#ba68c8', '#4db6ac',
    '#fff176', '#a1887f', '#90a4ae', '#e57373', '#9575cd', '#64b5f6',
  ];

  const state = {
    nodes: [],        // [{id, color}]
    keys: [],         // [string]
    vnodeCount: 100,
  };

  let worker = null;
  let reqSeq = 0;
  let pendingReq = null;     // 最新一次未完成请求 id
  let lastResult = null;     // 最近一次 computeAll 结果
  let lastMigration = null;  // 最近一次拓扑变化的迁移信息
  let prevAssignments = null; // {plain, vnode, mod, nodeIds}
  let highlightKey = null;
  let keyDotsCache = { plain: [], vnode: [] };
  let saveTimer = null;
  let computeTimer = null;

  // ---------- Worker ----------

  function ensureWorker() {
    if (worker) return;
    worker = new Worker('js/worker.js');
    worker.onmessage = (event) => {
      const { id, cmd, payload } = event.data;
      if (cmd === 'error') {
        showStatus('计算出错：' + payload.message, true);
        return;
      }
      if (id !== pendingReq) return; // 过期结果丢弃
      onComputed(payload);
    };
    worker.onerror = (err) => showStatus('Worker 错误：' + err.message, true);
  }

  function scheduleCompute() {
    clearTimeout(computeTimer);
    computeTimer = setTimeout(runCompute, 30);
  }

  function runCompute() {
    ensureWorker();
    const id = ++reqSeq;
    pendingReq = id;
    worker.postMessage({
      id,
      cmd: 'compute',
      payload: {
        nodes: state.nodes.map((n) => ({ id: n.id })),
        keys: state.keys.slice(),
        vnodeCount: state.vnodeCount,
      },
    });
  }

  function onComputed(result) {
    // 迁移 diff：与上一次归属对比（仅拓扑变化时有意义；新增键不算迁移）
    const nodeIds = state.nodes.map((n) => n.id);
    const modAssign = HashRing.modAssignments(state.keys, result.keyPositions, nodeIds);
    if (prevAssignments) {
      const migratedPlain = HashRing.diffAssignments(prevAssignments.plain, result.modes.plain.assignments, state.keys);
      const migratedVnode = HashRing.diffAssignments(prevAssignments.vnode, result.modes.vnode.assignments, state.keys);
      const migratedMod = HashRing.diffAssignments(prevAssignments.mod, modAssign, state.keys);
      lastMigration = {
        plain: migratedPlain,
        vnode: migratedVnode,
        mod: migratedMod,
        total: state.keys.length,
      };
    }
    prevAssignments = {
      plain: result.modes.plain.assignments,
      vnode: result.modes.vnode.assignments,
      mod: modAssign,
      nodeIds,
    };
    lastResult = result;
    render();
    renderNodeList();
    renderKeyList();
  }

  // ---------- 状态变更 ----------

  function addNode(id) {
    id = id.trim();
    if (!id) return showStatus('节点名不能为空', true);
    if (state.nodes.some((n) => n.id === id)) return showStatus(`节点 ${id} 已存在`, true);
    state.nodes.push({ id, color: PALETTE[state.nodes.length % PALETTE.length] });
    afterChange();
  }

  function removeNode(id) {
    state.nodes = state.nodes.filter((n) => n.id !== id);
    afterChange();
  }

  function addKey(key, silent) {
    key = key.trim();
    if (!key) return false;
    if (state.keys.includes(key)) {
      if (!silent) showStatus(`键 ${key} 已存在`, true);
      return false;
    }
    state.keys.push(key);
    return true;
  }

  function removeKey(key) {
    state.keys = state.keys.filter((k) => k !== key);
    if (highlightKey === key) highlightKey = null;
    afterChange();
  }

  function afterChange() {
    scheduleCompute();
    scheduleSave();
    renderNodeList();
    renderKeyList();
  }

  // ---------- 持久化 ----------

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await HashRingDB.set('state', {
          nodes: state.nodes,
          keys: state.keys,
          vnodeCount: state.vnodeCount,
        });
        showStatus('已保存到 IndexedDB');
      } catch (err) {
        showStatus('保存失败：' + err.message, true);
      }
    }, 300);
  }

  async function loadState() {
    try {
      const saved = await HashRingDB.get('state');
      if (saved) {
        state.nodes = saved.nodes || [];
        state.keys = saved.keys || [];
        state.vnodeCount = saved.vnodeCount || 100;
        document.getElementById('vnode-count').value = state.vnodeCount;
        document.getElementById('vnode-count-label').textContent = state.vnodeCount;
        showStatus(`已从 IndexedDB 恢复：${state.nodes.length} 节点 / ${state.keys.length} 键`);
      }
    } catch (err) {
      showStatus('读取本地配置失败：' + err.message, true);
    }
  }

  // ---------- 渲染 ----------

  function keysForViz(assignments, migratedSet) {
    return state.keys.map((key) => ({
      key,
      pos: lastResult.keyPositions[key],
      owner: assignments[key],
      migrated: migratedSet.has(key),
    }));
  }

  function render() {
    if (!lastResult) return;
    const migratedPlain = new Set((lastMigration && lastMigration.plain || []).map((m) => m.key));
    const migratedVnode = new Set((lastMigration && lastMigration.vnode || []).map((m) => m.key));

    keyDotsCache.plain = HashRingViz.drawRing(document.getElementById('ring-plain'), {
      title: '无虚拟节点',
      points: lastResult.modes.plain.points,
      keys: keysForViz(lastResult.modes.plain.assignments, migratedPlain),
      nodes: state.nodes,
      collisions: lastResult.modes.plain.collisions,
      highlightKey,
    }).keyDots;

    keyDotsCache.vnode = HashRingViz.drawRing(document.getElementById('ring-vnode'), {
      title: `虚拟节点 ×${state.vnodeCount}`,
      points: lastResult.modes.vnode.points,
      keys: keysForViz(lastResult.modes.vnode.assignments, migratedVnode),
      nodes: state.nodes,
      collisions: lastResult.modes.vnode.collisions,
      highlightKey,
    }).keyDots;

    HashRingViz.drawBalance(document.getElementById('balance-plain'), {
      nodes: state.nodes,
      counts: lastResult.modes.plain.stats.counts,
      ideal: lastResult.modes.plain.stats.ideal,
    });
    HashRingViz.drawBalance(document.getElementById('balance-vnode'), {
      nodes: state.nodes,
      counts: lastResult.modes.vnode.stats.counts,
      ideal: lastResult.modes.vnode.stats.ideal,
    });

    renderStats('stats-plain', lastResult.modes.plain);
    renderStats('stats-vnode', lastResult.modes.vnode);
    renderMigration();
    renderCollisions();
  }

  function fmtPct(x) { return (x * 100).toFixed(1) + '%'; }

  function renderStats(elId, mode) {
    const s = mode.stats;
    const el = document.getElementById(elId);
    if (state.nodes.length === 0) {
      el.innerHTML = '<div class="muted">空环：无统计</div>';
    } else {
      el.innerHTML = [
        `<div>变异系数 CV：<b>${s.cv.toFixed(3)}</b>（0 为完美均衡）</div>`,
        `<div>标准差：${s.stddev.toFixed(2)} · 理想均值：${s.ideal.toFixed(1)}</div>`,
        `<div>最多/最少：${s.max} / ${s.min}` +
          (isFinite(s.maxMinRatio) ? `（比值 ${s.maxMinRatio.toFixed(2)}）` : '（存在空节点）') + '</div>',
        s.unassigned ? `<div class="warn">未分配键：${s.unassigned}</div>` : '',
      ].join('');
    }
    if (mode.collisions.length > 0) {
      el.innerHTML += `<div class="warn">检测到 ${mode.collisions.length} 次哈希冲突（已自动探测避让）</div>`;
    }
  }

  function renderMigration() {
    const el = document.getElementById('migration-log');
    if (!lastMigration) {
      el.innerHTML = '<div class="muted">增删节点后，这里会显示迁移的键（对比传统取模哈希）。</div>';
      return;
    }
    const m = lastMigration;
    const lines = [
      `<div class="mig-row"><b>无虚拟节点</b>：迁移 ${m.plain.length} / ${m.total} 键</div>`,
      `<div class="mig-row"><b>虚拟节点 ×${state.vnodeCount}</b>：迁移 ${m.vnode.length} / ${m.total} 键</div>`,
      `<div class="mig-row muted">对照 · 传统取模哈希：迁移 ${m.mod.length} / ${m.total} 键</div>`,
    ];
    const show = (list) => list.slice(0, 30)
      .map((x) => `<span class="chip">${esc(x.key)}: ${esc(x.from || '∅')} → ${esc(x.to || '∅')}</span>`)
      .join('');
    if (m.vnode.length) {
      lines.push(`<details><summary>虚拟节点模式迁移明细（前 30 条）</summary><div class="chips">${show(m.vnode)}</div></details>`);
    }
    if (m.plain.length) {
      lines.push(`<details><summary>无虚拟节点模式迁移明细（前 30 条）</summary><div class="chips">${show(m.plain)}</div></details>`);
    }
    el.innerHTML = lines.join('');
  }

  function renderCollisions() {
    const el = document.getElementById('collision-log');
    const all = [
      ...lastResult.modes.plain.collisions.map((c) => ({ ...c, mode: '无虚拟节点' })),
      ...lastResult.modes.vnode.collisions.map((c) => ({ ...c, mode: '虚拟节点' })),
    ];
    if (all.length === 0) {
      el.innerHTML = '<div class="muted">无哈希冲突。</div>';
    } else {
      el.innerHTML = all.map((c) =>
        `<div class="warn">[${c.mode}] 点 <code>${esc(c.pointId)}</code> 与 <code>${esc(c.with)}</code> 在位置 ${c.pos} 冲突，已线性探测避让</div>`
      ).join('');
    }
  }

  function renderNodeList() {
    const el = document.getElementById('node-list');
    if (state.nodes.length === 0) {
      el.innerHTML = '<div class="muted">暂无节点（空环）</div>';
      return;
    }
    el.innerHTML = state.nodes.map((n) => {
      const count = lastResult ? (lastResult.modes.vnode.stats.counts[n.id] || 0) : 0;
      return `<div class="node-item">
        <span class="dot" style="background:${n.color}"></span>
        <span class="node-id">${esc(n.id)}</span>
        <span class="muted">${count} 键</span>
        <button data-remove-node="${esc(n.id)}" title="删除节点">×</button>
      </div>`;
    }).join('');
  }

  function renderKeyList() {
    const el = document.getElementById('key-list');
    document.getElementById('key-count-label').textContent = state.keys.length;
    if (state.keys.length === 0) {
      el.innerHTML = '<div class="muted">暂无键</div>';
      return;
    }
    const assignments = lastResult ? lastResult.modes.vnode.assignments : {};
    el.innerHTML = state.keys.map((k) => {
      const owner = assignments[k];
      return `<div class="key-item" data-key="${esc(k)}">
        <span class="key-name">${esc(k)}</span>
        <span class="muted">→ ${esc(owner || '未分配')}</span>
        <button data-remove-key="${esc(k)}" title="删除键">×</button>
      </div>`;
    }).join('');
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  let statusTimer = null;
  function showStatus(msg, isError) {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.className = isError ? 'status error' : 'status';
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { el.textContent = ''; }, 4000);
  }

  // ---------- 事件 ----------

  function bindEvents() {
    document.getElementById('add-node').onclick = () => {
      const input = document.getElementById('node-input');
      addNode(input.value);
      input.value = '';
      input.focus();
    };
    document.getElementById('node-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('add-node').click();
    });

    document.getElementById('add-key').onclick = () => {
      const input = document.getElementById('key-input');
      if (addKey(input.value)) {
        input.value = '';
        afterChange();
      }
      input.focus();
    };
    document.getElementById('key-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('add-key').click();
    });

    document.getElementById('add-keys-batch').onclick = () => {
      const n = parseInt(document.getElementById('batch-count').value, 10) || 100;
      let added = 0;
      for (let i = 0; i < n; i++) {
        if (addKey('key-' + Math.random().toString(36).slice(2, 10), true)) added++;
      }
      showStatus(`批量添加 ${added} 个键`);
      afterChange();
    };

    document.getElementById('clear-keys').onclick = () => {
      state.keys = [];
      highlightKey = null;
      afterChange();
    };

    document.getElementById('clear-all').onclick = () => {
      state.nodes = [];
      state.keys = [];
      highlightKey = null;
      lastMigration = null;
      afterChange();
    };

    document.getElementById('vnode-count').addEventListener('input', (e) => {
      state.vnodeCount = Math.max(1, parseInt(e.target.value, 10) || 1);
      document.getElementById('vnode-count-label').textContent = state.vnodeCount;
      afterChange();
    });

    // 节点 / 键列表的删除与点选（事件委托）
    document.getElementById('node-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove-node]');
      if (btn) removeNode(btn.dataset.removeNode);
    });
    document.getElementById('key-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove-key]');
      if (btn) { removeKey(btn.dataset.removeKey); return; }
      const item = e.target.closest('.key-item');
      if (item) {
        highlightKey = highlightKey === item.dataset.key ? null : item.dataset.key;
        render();
      }
    });

    // 环上键的悬停提示
    for (const [canvasId, mode] of [['ring-plain', 'plain'], ['ring-vnode', 'vnode']]) {
      const canvas = document.getElementById(canvasId);
      const tooltip = document.getElementById('tooltip');
      canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const dots = keyDotsCache[mode] || [];
        let hit = null;
        for (const d of dots) {
          if ((d.x - x) ** 2 + (d.y - y) ** 2 < 64) { hit = d; break; }
        }
        if (hit && lastResult) {
          const owner = lastResult.modes[mode].assignments[hit.key];
          tooltip.style.display = 'block';
          tooltip.style.left = (e.clientX + 12) + 'px';
          tooltip.style.top = (e.clientY + 12) + 'px';
          tooltip.textContent = `${hit.key} → ${owner || '未分配'}`;
        } else {
          tooltip.style.display = 'none';
        }
      });
      canvas.addEventListener('mouseleave', () => {
        document.getElementById('tooltip').style.display = 'none';
      });
    }

    window.addEventListener('resize', () => render());
  }

  // ---------- 启动 ----------

  async function init() {
    bindEvents();
    await loadState();
    renderNodeList();
    renderKeyList();
    runCompute();
  }

  init();
})();
