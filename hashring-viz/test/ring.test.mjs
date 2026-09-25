import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import {
  buildRing, locatePoint, computeAssignment, diffAssignments,
  balanceStats, expectedMigrationRatio, pointLabel, RING_SIZE,
} from '../js/ring.js';

// 与浏览器端一致的哈希：SHA-256 前 4 字节大端 uint32
function hashOf(label) {
  const d = createHash('sha256').update(label).digest();
  return { position: d.readUInt32BE(0), hash: d.subarray(0, 8).toString('hex') };
}
const makeKeys = (n) => Array.from({ length: n }, (_, i) => {
  const h = hashOf(`key-${i}`);
  return { id: `key-${i}`, position: h.position };
});
const nodes = (ids) => ids.map((id) => ({ id }));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { console.error(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}

// 1. 查找正确性：键落在顺时针第一个点
test('locatePoint 返回顺时针第一个点并环绕', () => {
  const points = [{ position: 100 }, { position: 200 }, { position: 300 }];
  assert.equal(locatePoint(points, 50).position, 100);
  assert.equal(locatePoint(points, 100).position, 100);
  assert.equal(locatePoint(points, 150).position, 200);
  assert.equal(locatePoint(points, 300).position, 300);
  assert.equal(locatePoint(points, 301).position, 100); // 环绕
  assert.equal(locatePoint([], 1), null);               // 空环
});

// 2. 空环与单节点
test('空环：归属为 null，统计不崩', () => {
  const ring = buildRing([], 100, hashOf);
  assert.equal(ring.points.length, 0);
  const a = computeAssignment(ring.points, makeKeys(10));
  assert.ok([...a.values()].every((v) => v === null));
  const s = balanceStats(a, []);
  assert.equal(s.cv, null);
});

test('单节点：所有键归该节点，CV 为 0', () => {
  const ring = buildRing(nodes(['A']), 50, hashOf);
  assert.equal(ring.points.length, 50);
  const keys = makeKeys(500);
  const a = computeAssignment(ring.points, keys);
  assert.ok([...a.values()].every((v) => v === 'A'));
  const s = balanceStats(a, ['A']);
  assert.equal(s.cv, 0);
  assert.equal(s.total, 500);
});

// 3. 最小迁移：加节点只迁移约 1/(n+1)，且迁移目标只能是新节点
test('添加节点：迁移比例接近理论最小，且全部迁往新节点', () => {
  const keys = makeKeys(20000);
  const before = buildRing(nodes(['A', 'B', 'C']), 100, hashOf);
  const after = buildRing(nodes(['A', 'B', 'C', 'D']), 100, hashOf);
  const a1 = computeAssignment(before.points, keys);
  const a2 = computeAssignment(after.points, keys);
  const migrated = diffAssignments(a1, a2);
  const ratio = migrated.length / keys.length;
  const expected = expectedMigrationRatio(3, 4); // 0.25
  assert.ok(Math.abs(ratio - expected) < 0.02, `迁移比例 ${ratio} 应接近 ${expected}`);
  assert.ok(migrated.every((m) => m.to === 'D'), '所有迁移的键必须迁往新节点');
  assert.ok(migrated.every((m) => m.from !== 'D'), '迁移来源必须是旧节点');
});

test('删除节点：只有被删节点的键迁移', () => {
  const keys = makeKeys(20000);
  const before = buildRing(nodes(['A', 'B', 'C', 'D']), 100, hashOf);
  const after = buildRing(nodes(['A', 'B', 'C']), 100, hashOf);
  const a1 = computeAssignment(before.points, keys);
  const a2 = computeAssignment(after.points, keys);
  const migrated = diffAssignments(a1, a2);
  assert.ok(migrated.every((m) => m.from === 'D'), '只有 D 上的键应迁移');
  const ratio = migrated.length / keys.length;
  assert.ok(Math.abs(ratio - 0.25) < 0.02, `迁移比例 ${ratio} 应接近 0.25`);
});

// 4. 虚拟节点越多分布越均衡（CV 单调下降趋势）
test('虚拟节点越多 CV 越小', () => {
  const keys = makeKeys(20000);
  const nodeList = nodes(['A', 'B', 'C', 'D', 'E']);
  const ids = ['A', 'B', 'C', 'D', 'E'];
  const cvs = [1, 10, 50, 100, 200].map((v) => {
    const ring = buildRing(nodeList, v, hashOf);
    return balanceStats(computeAssignment(ring.points, keys), ids).cv;
  });
  console.log(`    CV: ${cvs.map((c) => c.toFixed(4)).join(' -> ')}`);
  assert.ok(cvs[4] < cvs[0], `vnode=200 的 CV (${cvs[4]}) 应小于 vnode=1 (${cvs[0]})`);
  assert.ok(cvs[4] < 0.1, 'vnode=200 时 CV 应 < 0.1');
});

// 5. 哈希冲突检测
test('哈希冲突可被检测', () => {
  // 构造两个不同标签产生相同 position
  const fakeHash = (label) => (label === 'X#0' || label === 'Y#0'
    ? { position: 42, hash: 'deadbeef' } : hashOf(label));
  const ring = buildRing(nodes(['X', 'Y']), 2, fakeHash);
  assert.equal(ring.collisions.length, 1);
  assert.equal(ring.collisions[0].position, 42);
  assert.deepEqual(ring.collisions[0].labels.sort(), ['X#0', 'Y#0']);
});

// 6. 虚拟节点编号
test('虚拟节点标签编号正确', () => {
  assert.equal(pointLabel('A', -1), 'A');
  assert.equal(pointLabel('A', 0), 'A#0');
  assert.equal(pointLabel('A', 99), 'A#99');
  const ring = buildRing(nodes(['A']), 3, hashOf);
  assert.deepEqual(ring.points.map((p) => p.vnodeIndex).sort(), [0, 1, 2]);
  assert.ok(ring.points.every((p) => p.nodeId === 'A'));
});

// 7. 归属总量守恒
test('键总数守恒且位置在环空间内', () => {
  const keys = makeKeys(1000);
  const ring = buildRing(nodes(['A', 'B', 'C']), 100, hashOf);
  const a = computeAssignment(ring.points, keys);
  const s = balanceStats(a, ['A', 'B', 'C']);
  assert.equal(s.total, 1000);
  assert.ok(ring.points.every((p) => p.position >= 0 && p.position < RING_SIZE));
});

console.log(`\n${passed} 个测试通过`);
