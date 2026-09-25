/*
 * hashring.js — 一致性哈希环核心逻辑（纯计算，无 DOM 依赖）
 * 同时被主线程（<script>）、Web Worker（importScripts）和 Node 测试复用。
 * 哈希使用 Web Crypto 的 SHA-256，取摘要前 4 字节作为 32 位环上位置。
 */
(function (global) {
  'use strict';

  const RING_SIZE = 0x100000000; // 2^32
  const MAX_PROBE = 256;         // 哈希冲突时线性探测的最大次数

  const encoder = new TextEncoder();

  async function sha256u32(str) {
    const digest = await global.crypto.subtle.digest('SHA-256', encoder.encode(str));
    return new DataView(digest).getUint32(0, false);
  }

  // 批量哈希，分块并发避免一次性创建过多 Promise
  async function hashMany(strings) {
    const result = new Array(strings.length);
    const CHUNK = 256;
    for (let i = 0; i < strings.length; i += CHUNK) {
      const jobs = [];
      for (let j = i; j < Math.min(i + CHUNK, strings.length); j++) {
        jobs.push(sha256u32(strings[j]).then((pos) => { result[j] = pos; }));
      }
      await Promise.all(jobs);
    }
    return result;
  }

  /**
   * 构建哈希环。
   * @param nodes  [{id, label}]
   * @param vnodeCount 每个节点的虚拟节点数；1 表示不使用虚拟节点（直接用节点 id 哈希）
   * @returns {points: [{pos, nodeId, vnode}], collisions: [{pointId, with, pos}], byNode: Map}
   *   points 按 pos 升序；vnode 为虚拟节点编号（无虚拟节点模式为 -1）。
   */
  async function buildRing(nodes, vnodeCount) {
    const labels = [];
    const metas = [];
    for (const node of nodes) {
      if (vnodeCount <= 1) {
        labels.push(node.id);
        metas.push({ pointId: node.id, nodeId: node.id, vnode: -1 });
      } else {
        for (let i = 0; i < vnodeCount; i++) {
          const pointId = node.id + '#' + i; // 虚拟节点编号：节点id#序号
          labels.push(pointId);
          metas.push({ pointId, nodeId: node.id, vnode: i });
        }
      }
    }
    const positions = await hashMany(labels);
    return placePoints(metas, positions);
  }

  /**
   * 将带元信息的点按给定位置放到环上，处理哈希冲突（线性探测）。
   * 单独导出以便测试冲突逻辑。
   */
  function placePoints(metas, positions) {
    const occupied = new Map(); // pos -> pointId
    const collisions = [];
    const points = [];
    for (let i = 0; i < metas.length; i++) {
      let pos = positions[i];
      let probe = 0;
      while (occupied.has(pos) && occupied.get(pos) !== metas[i].pointId) {
        // 哈希冲突：记录并线性探测下一个空位
        collisions.push({ pointId: metas[i].pointId, with: occupied.get(pos), pos });
        probe++;
        if (probe > MAX_PROBE) {
          throw new Error('哈希冲突探测超过上限，环可能已饱和');
        }
        pos = (pos + 1) % RING_SIZE;
      }
      occupied.set(pos, metas[i].pointId);
      points.push({ pos, nodeId: metas[i].nodeId, vnode: metas[i].vnode, pointId: metas[i].pointId });
    }
    points.sort((a, b) => a.pos - b.pos);
    return { points, collisions };
  }

  /**
   * 在有序环上查找 pos 的顺时针后继点（二分查找，到末尾则回绕到第一个点）。
   * 空环返回 null。
   */
  function successor(points, pos) {
    if (points.length === 0) return null;
    let lo = 0, hi = points.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].pos < pos) lo = mid + 1; else hi = mid;
    }
    return points[lo % points.length];
  }

  /**
   * 计算键的归属。空环时所有键 owner 为 null。
   * @returns {assignments: Object<key, nodeId|null>, keyPositions: Object<key, number>}
   */
  function assignKeys(points, keys, keyPositions) {
    const assignments = {};
    for (const key of keys) {
      const point = successor(points, keyPositions[key]);
      assignments[key] = point ? point.nodeId : null;
    }
    return assignments;
  }

  /**
   * 分布均衡度统计。
   * 返回每个节点的键数、均值、标准差、变异系数 CV（越小越均衡，0 为完美均衡）、
   * 最大/最小比、理想值（keys/nodes）。
   */
  function balanceStats(nodes, keys, assignments) {
    const counts = {};
    for (const node of nodes) counts[node.id] = 0;
    let unassigned = 0;
    for (const key of keys) {
      const owner = assignments[key];
      if (owner === null || owner === undefined) unassigned++;
      else counts[owner] = (counts[owner] || 0) + 1;
    }
    const values = nodes.map((n) => counts[n.id]);
    const n = values.length;
    const total = values.reduce((a, b) => a + b, 0);
    const mean = n > 0 ? total / n : 0;
    let variance = 0;
    for (const v of values) variance += (v - mean) * (v - mean);
    const stddev = n > 0 ? Math.sqrt(variance / n) : 0;
    const cv = mean > 0 ? stddev / mean : 0;
    const max = n > 0 ? Math.max(...values) : 0;
    const min = n > 0 ? Math.min(...values) : 0;
    return {
      counts,
      total,
      unassigned,
      mean,
      stddev,
      cv,               // 变异系数：0 最均衡
      max,
      min,
      maxMinRatio: min > 0 ? max / min : (max > 0 ? Infinity : 1),
      ideal: mean,      // 理想均衡时每节点键数
    };
  }

  /**
   * 对比新旧归属，返回迁移的键列表。
   */
  function diffAssignments(oldAssign, newAssign, keys) {
    const migrated = [];
    for (const key of keys) {
      const from = oldAssign ? oldAssign[key] : undefined;
      const to = newAssign[key];
      if (from !== to && from !== undefined) {
        migrated.push({ key, from, to });
      } else if (from === undefined && to !== null && to !== undefined && oldAssign) {
        // 新增的键不算迁移
      }
    }
    return migrated;
  }

  /**
   * 传统取模哈希（pos % nodeCount）的归属，用于对比迁移量。
   * 返回 {key: nodeId}，nodeIds 为空时全部为 null。
   */
  function modAssignments(keys, keyPositions, nodeIds) {
    const out = {};
    for (const key of keys) {
      out[key] = nodeIds.length > 0 ? nodeIds[keyPositions[key] % nodeIds.length] : null;
    }
    return out;
  }

  /**
   * 一次性计算两种模式（无虚拟节点 / 有虚拟节点）的完整状态。
   */
  async function computeAll({ nodes, keys, vnodeCount }) {
    const keyPosArr = await hashMany(keys);
    const keyPositions = {};
    keys.forEach((k, i) => { keyPositions[k] = keyPosArr[i]; });

    const modes = {};
    for (const [name, v] of [['plain', 1], ['vnode', Math.max(1, vnodeCount)]]) {
      const { points, collisions } = await buildRing(nodes, v);
      const assignments = assignKeys(points, keys, keyPositions);
      modes[name] = {
        vnodeCount: v,
        points,
        collisions,
        assignments,
        stats: balanceStats(nodes, keys, assignments),
      };
    }
    return { keyPositions, modes };
  }

  const api = {
    RING_SIZE,
    sha256u32,
    hashMany,
    buildRing,
    successor,
    placePoints,
    assignKeys,
    balanceStats,
    diffAssignments,
    modAssignments,
    computeAll,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.HashRing = api;
})(typeof self !== 'undefined' ? self : globalThis);
