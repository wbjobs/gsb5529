/*
 * worker.js — 在 Web Worker 中执行 SHA-256 哈希与环计算，避免阻塞 UI。
 */
importScripts('hashring.js');

self.onmessage = async (event) => {
  const { id, cmd, payload } = event.data;
  try {
    if (cmd === 'compute') {
      const result = await HashRing.computeAll(payload);
      self.postMessage({ id, cmd: 'result', payload: result });
    } else {
      throw new Error('未知命令: ' + cmd);
    }
  } catch (err) {
    self.postMessage({ id, cmd: 'error', payload: { message: String(err && err.message || err) } });
  }
};
