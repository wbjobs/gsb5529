// 一致性哈希环核心逻辑（纯函数，无浏览器依赖，可在 Node 中测试）
// 环空间为 uint32: 0 .. 2^32 - 1

export const RING_SIZE = 0x100000000; // 2^32

// 生成环上所有点的标签：vnodeCount <= 1 时物理节点直接上环，否则生成 "nodeId#i" 虚拟节点
export function pointLabel(nodeId, vnodeIndex) {
  return vnodeIndex < 0 ? String(nodeId) : `${nodeId}#${vnodeIndex}`;
}

// 根据节点列表和哈希函数构建环
// nodes: [{id}], vnodeCount: 每节点虚拟节点数（1 表示无虚拟节点模式）
// hashOf: (label) => { position, hash } | null
// 返回 { points: 按 position 升序的点数组, collisions: 冲突组 }
export function buildRing(nodes, vnodeCount, hashOf) {
  const points = [];
  for (const node of nodes) {
    if (vnodeCount <= 1) {
      const h = hashOf(pointLabel(node.id, -1));
      if (h) points.push({ position: h.position, hash: h.hash, nodeId: node.id, vnodeIndex: -1, label: pointLabel(node.id, -1) });
    } else {
      for (let i = 0; i < vnodeCount; i++) {
        const h = hashOf(pointLabel(node.id, i));
        if (h) points.push({ position: h.position, hash: h.hash, nodeId: node.id, vnodeIndex: i, label: pointLabel(node.id, i) });
      }
    }
  }
  points.sort((a, b) => a.position - b.position);

  // 哈希冲突检测：不同标签映射到同一 position
  const collisions = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i].position === points[i - 1].position) {
      let group = collisions[collisions.length - 1];
      if (!group || group.position !== points[i].position) {
        group = { position: points[i].position, labels: [points[i - 1].label] };
        collisions.push(group);
      }
      group.labels.push(points[i].label);
    }
  }
  return { points, collisions };
}

// 二分查找：环上第一个 position >= keyPosition 的点，环绕到头部；空环返回 null
export function locatePoint(points, keyPosition) {
  if (points.length === 0) return null;
  let lo = 0, hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].position < keyPosition) lo = mid + 1;
    else hi = mid;
  }
  return points[lo % points.length];
}

// 计算所有键的归属：keys: [{id, position}] -> Map(keyId -> nodeId)
export function computeAssignment(points, keys) {
  const assignment = new Map();
  for (const key of keys) {
    const p = locatePoint(points, key.position);
    assignment.set(key.id, p ? p.nodeId : null);
  }
  return assignment;
}

// 对比新旧归属，返回迁移的键列表 [{keyId, from, to}]
export function diffAssignments(oldA, newA) {
  const migrated = [];
  for (const [keyId, to] of newA) {
    const from = oldA.get(keyId);
    if (from !== undefined && from !== to) migrated.push({ keyId, from, to });
  }
  return migrated;
}

// 均衡度统计：counts: Map(nodeId -> count)，nodeIds 为全部节点（含 0 键节点）
export function balanceStats(assignment, nodeIds) {
  const counts = new Map(nodeIds.map(id => [id, 0]));
  for (const nodeId of assignment.values()) {
    if (nodeId !== null && counts.has(nodeId)) counts.set(nodeId, counts.get(nodeId) + 1);
  }
  const values = [...counts.values()];
  const total = values.reduce((a, b) => a + b, 0);
  const n = values.length;
  if (n === 0) return { counts, total: 0, mean: 0, stddev: 0, cv: null, max: 0, min: 0, maxMinRatio: null };
  const mean = total / n;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  const max = Math.max(...values);
  const min = Math.min(...values);
  return {
    counts, total, mean, stddev,
    cv: mean > 0 ? stddev / mean : null,          // 变异系数，越小越均衡
    max, min,
    maxMinRatio: min > 0 ? max / min : (max > 0 ? Infinity : null),
  };
}

// 理论最小迁移比例：新增 1 节点时期望迁移 1/(n+1)，删除 1 节点时期望迁移 1/n
export function expectedMigrationRatio(nodeCountBefore, nodeCountAfter) {
  if (nodeCountAfter > nodeCountBefore) return 1 / nodeCountAfter;
  if (nodeCountAfter < nodeCountBefore && nodeCountBefore > 0) return 1 / nodeCountBefore;
  return 0;
}
