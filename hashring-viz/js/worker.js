// Web Worker：使用 Web Crypto (SHA-256) 批量计算哈希
// 输入: { id, items: [string] }
// 输出: { id, results: [{ input, hash, position }] }
// position 取 SHA-256 摘要前 4 字节（大端）作为 uint32 环上位置
self.onmessage = async (e) => {
  const { id, items } = e.data;
  const encoder = new TextEncoder();
  const results = [];
  for (const input of items) {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
    const bytes = new Uint8Array(digest);
    const view = new DataView(digest);
    const position = view.getUint32(0, false);
    const hash = Array.from(bytes.slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
    results.push({ input, hash, position });
  }
  self.postMessage({ id, results });
};
