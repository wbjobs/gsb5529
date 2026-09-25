// 验收标准自动化测试：node test/ring.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const HR = require('../js/hashring.js');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${extra}`); }
}

const NODES = (n) => Array.from({ length: n }, (_, i) => ({ id: `node-${i}` }));
const KEYS = (n) => Array.from({ length: n }, (_, i) => `key-${i}`);

// 1. 空环不崩
{
  const r = await HR.computeAll({ nodes: [], keys: KEYS(10), vnodeCount: 50 });
  check('空环：所有键未分配', Object.values(r.modes.vnode.assignments).every((v) => v === null));
  check('空环：统计不崩', r.modes.plain.stats.total === 0 && r.modes.plain.stats.cv === 0);
  const r2 = await HR.computeAll({ nodes: [], keys: [], vnodeCount: 1 });
  check('空环+空键：不崩', r2.modes.plain.points.length === 0);
}

// 2. 单节点：所有键归它
{
  const r = await HR.computeAll({ nodes: NODES(1), keys: KEYS(100), vnodeCount: 64 });
  check('单节点：全部键归唯一节点', Object.values(r.modes.vnode.assignments).every((v) => v === 'node-0'));
  check('单节点：CV 为 0', r.modes.vnode.stats.cv === 0);
}

// 3. 虚拟节点编号
{
  const { points } = await HR.buildRing(NODES(3), 10);
  check('虚拟节点总数 = 节点数 × 虚拟节点数', points.length === 30);
  const perNode = {};
  for (const p of points) (perNode[p.nodeId] ||= new Set()).add(p.vnode);
  check('每个节点编号 0..9 齐全',
    Object.values(perNode).every((s) => s.size === 10 && Math.min(...s) === 0 && Math.max(...s) === 9));
  const plain = await HR.buildRing(NODES(3), 1);
  check('无虚拟节点模式：每节点 1 个点，vnode=-1',
    plain.points.length === 3 && plain.points.every((p) => p.vnode === -1));
}

// 4. 最小迁移：增删节点时只有必要键移动
{
  const keys = KEYS(2000);
  const before = await HR.computeAll({ nodes: NODES(5), keys, vnodeCount: 100 });

  // 添加节点：迁移的键必须全部迁入新节点，且数量 ≈ 1/6
  const afterAdd = await HR.computeAll({ nodes: NODES(6), keys, vnodeCount: 100 });
  const migAdd = HR.diffAssignments(before.modes.vnode.assignments, afterAdd.modes.vnode.assignments, keys);
  check('加节点：迁移键全部迁入新节点', migAdd.every((m) => m.to === 'node-5'));
  check('加节点：迁移量 ≈ 1/6（±60% 容差）',
    migAdd.length > keys.length / 6 * 0.4 && migAdd.length < keys.length / 6 * 1.6,
    `实际 ${migAdd.length}`);

  // 删除节点：迁移的键必须全部来自被删节点
  const afterDel = await HR.computeAll({ nodes: NODES(4), keys, vnodeCount: 100 });
  const migDel = HR.diffAssignments(before.modes.vnode.assignments, afterDel.modes.vnode.assignments, keys);
  check('删节点：迁移键全部来自被删节点', migDel.every((m) => m.from === 'node-4'));
  check('删节点：迁移量 ≈ 1/5（±60% 容差）',
    migDel.length > keys.length / 5 * 0.4 && migDel.length < keys.length / 5 * 1.6,
    `实际 ${migDel.length}`);

  // 对照：传统取模哈希迁移量应显著更大
  const ids5 = NODES(5).map((n) => n.id);
  const ids6 = NODES(6).map((n) => n.id);
  const modBefore = HR.modAssignments(keys, before.keyPositions, ids5);
  const modAfter = HR.modAssignments(keys, afterAdd.keyPositions, ids6);
  const migMod = HR.diffAssignments(modBefore, modAfter, keys);
  check('对照：取模哈希迁移量远大于一致性哈希', migMod.length > migAdd.length * 2,
    `取模 ${migMod.length} vs 一致性哈希 ${migAdd.length}`);
}

// 5. 虚拟节点越多分布越均衡（CV 单调下降趋势）
{
  const keys = KEYS(3000);
  const nodes = NODES(6);
  const cvs = [];
  for (const v of [1, 10, 100, 400]) {
    const r = await HR.computeAll({ nodes, keys, vnodeCount: v });
    cvs.push(r.modes.vnode.stats.cv);
  }
  check('CV 随虚拟节点数增加而降低', cvs[0] > cvs[1] && cvs[1] > cvs[2] && cvs[2] > cvs[3],
    `CV: ${cvs.map((c) => c.toFixed(3)).join(' → ')}`);
  check('vnodeCount=1 等价于无虚拟节点模式', (await HR.computeAll({ nodes, keys, vnodeCount: 1 }))
    .modes.vnode.stats.cv === (await HR.computeAll({ nodes, keys, vnodeCount: 1 })).modes.plain.stats.cv);
}

// 6. 哈希冲突可检测并自动避让
{
  const metas = [
    { pointId: 'a#0', nodeId: 'a', vnode: 0 },
    { pointId: 'b#0', nodeId: 'b', vnode: 0 },
    { pointId: 'c#0', nodeId: 'c', vnode: 0 },
  ];
  const { points, collisions } = HR.placePoints(metas, [100, 100, 100]); // 强制三点同位置
  // 第 2 点撞 1 次（100），第 3 点撞 2 次（100、101），共 3 次冲突记录
  check('冲突被检测并记录', collisions.length === 3, `实际 ${collisions.length}`);
  check('冲突点被线性探测避让', new Set(points.map((p) => p.pos)).size === 3);
  check('避让位置为 100/101/102',
    [100, 101, 102].every((p) => points.some((pt) => pt.pos === p)));
  // 同一 pointId 重复放置不算冲突（幂等）
  const dup = HR.placePoints([metas[0], metas[0]], [7, 7]);
  check('相同 pointId 同位置不算冲突', dup.collisions.length === 0 && dup.points.length === 2);
}

// 7. 归属一致性：键的 owner 与环上后继点一致
{
  const r = await HR.computeAll({ nodes: NODES(4), keys: KEYS(500), vnodeCount: 32 });
  const pts = r.modes.vnode.points;
  const ok = Object.entries(r.modes.vnode.assignments).every(([k, owner]) =>
    HR.successor(pts, r.keyPositions[k]).nodeId === owner);
  check('键归属 = 环上顺时针后继点', ok);
  check('所有键都被分配', Object.values(r.modes.vnode.assignments).every((v) => v !== null));
}

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
