'use strict';
// AI 上线 / 下线：把模型装进显存 / 从显存里完全退出（等同 ollama stop），下线后必须核对 ollama ps 为空。
// 说明：这里的「下线」只指模型占用显存，和界面上「联网」开关是两回事。

function make(cfg) {
  const j = async (path, body) => {
    const r = await fetch(cfg.ollama + path, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error('Ollama 返回 ' + r.status);
    return r.json();
  };
  // 返回 'on' | 'off' | 'down'（down = Ollama 服务本身没起来）
  async function status() {
    try {
      const ps = await j('/api/ps');
      const m = (ps.models || []).find((x) => x.name === cfg.model || x.name === cfg.model + ':latest' || x.model === cfg.model + ':latest');
      return { state: m ? 'on' : 'off', vramGB: m ? +(m.size_vram / 1e9).toFixed(1) : 0, others: (ps.models || []).length - (m ? 1 : 0) };
    } catch (e) { return { state: 'down', vramGB: 0, others: 0 }; }
  }
  async function off() {
    const before = await status();
    if (before.state === 'down') return { ok: false, text: 'Ollama 服务没有运行，没有东西占着显存。' };
    await j('/api/generate', { model: cfg.model, keep_alive: 0 }).catch(() => {});
    for (let i = 0; i < 20; i++) {                        // 最多等 20 秒，反复核对
      const s = await status();
      if (s.state === 'off' && s.others === 0) return { ok: true, text: `AI 已下线：显存已释放（核对 ollama ps 为空，原先占用 ${before.vramGB}GB）。需要时点「AI上线」，或直接发消息会自动上线，约需 7 秒。` };
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { ok: false, text: '已发出下线指令，但 20 秒后核对 ollama ps 仍有模型占用，没有真正释放。' };
  }
  async function on() {
    const before = await status();
    if (before.state === 'on') return { ok: true, text: 'AI 已经在线。' };
    if (before.state === 'down') return { ok: false, text: 'Ollama 服务没有运行，请先打开 Ollama。' };
    const t0 = Date.now();
    await j('/api/generate', { model: cfg.model, prompt: '', stream: false, keep_alive: -1 });   // 空请求只加载，keep_alive=-1：上线后一直在线，不因空闲而下线
    const s = await status();
    return s.state === 'on'
      ? { ok: true, text: `AI 已上线（加载用了 ${((Date.now() - t0) / 1000).toFixed(1)} 秒，占显存 ${s.vramGB}GB）。` }
      : { ok: false, text: '已发出上线指令，但核对 ollama ps 没有看到模型。' };
  }
  // 对话里的口语：只认比较短、明确提到 AI/模型 的句子，避免把正常内容当成命令
  function detect(text) {
    const t = String(text).trim().replace(/[。.!！\s]+$/g, '');
    if (t.length > 14) return null;
    const hasAI = /ai|模型|助手/i.test(t);
    if (/^(ai|模型)?\s*(下线|离线|下限)(吧)?$/i.test(t) || (hasAI && /(下线|离线|下限|关了|关掉|关闭|关机|退出显存)/.test(t))) return 'off';
    if (/^(ai|模型)?\s*(上线|上限)(吧)?$/i.test(t) || (hasAI && /(上线|上限|开机|启动|加载|打开)/.test(t))) return 'on';
    return null;
  }
  return { status, on, off, detect };
}
module.exports = { make };
