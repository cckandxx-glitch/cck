// R 开关（急停钮 + 转环）换掉顶栏的「● AI ON」和 STOP，齿轮菜单去掉 AI ON/OFF。
// node _pwr-r-patch.js preview → 生成 agent/_ui-pwr-preview.html（假数据，可拖尺寸）
// node _pwr-r-patch.js prod    → 先备份，再改 agent/ui.html
const fs = require('fs'), path = require('path');
const mode = process.argv[2];
if (!['preview', 'prod'].includes(mode)) throw new Error('用法：node _pwr-r-patch.js preview|prod');
const SRC = path.join(__dirname, 'agent', 'ui.html');
let s = fs.readFileSync(SRC, 'utf8');
const rep = (a, b) => { const n = s.split(a).length - 1; if (n !== 1) throw new Error('应命中 1 处，实际 ' + n + '：' + a.slice(0, 70)); s = s.replace(a, () => b); };
const H = process.argv[3] ? +process.argv[3] : 32;   // 高度（px），按 32 画、--pk 缩放

// ---- 1. 样式 ----
const CSS = `<style id="pwrCss">
/* 10-05 R 开关：中间红钮＝急停（一直红），外圈转环指左＝关、指右＝开；按 32px 高画，--pk 缩放 */
#pwr{--pk:${H / 32};--u:calc(var(--pk)*1px);--on:#8bd5a8;--off:#ff7b72;--dur:170ms;--ease:cubic-bezier(.4,0,.2,1);
  position:relative;flex:none;display:inline-block;box-sizing:border-box;width:calc(84*var(--u));height:calc(32*var(--u));margin-left:4px;border-radius:calc(9*var(--u));
  background:#232323;box-shadow:inset 0 0 0 1px rgba(255,255,255,.10);cursor:pointer;user-select:none;-webkit-app-region:no-drag}
#pwr .ring{position:absolute;top:calc(2*var(--u));left:calc(28*var(--u));width:calc(28*var(--u));height:calc(28*var(--u));border-radius:50%;
  background:#4b4b4b;box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 1px 2px rgba(0,0,0,.45);transform:rotate(-90deg);transition:transform var(--dur) var(--ease)}
#pwr .ring::after{content:"";position:absolute;left:50%;top:calc(.5*var(--u));width:calc(3*var(--u));height:calc(4*var(--u));margin-left:calc(-1.5*var(--u));border-radius:var(--u);background:#fff}
#pwr[data-p="1"] .ring{transform:rotate(90deg)}
#pwr .stp{position:absolute;top:calc(7*var(--u));left:calc(33*var(--u));width:calc(18*var(--u));height:calc(18*var(--u));padding:0;border:0;border-radius:50%;cursor:pointer;
  background:#c8372d;box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 1px 1px rgba(0,0,0,.4);transition:background-color var(--dur) var(--ease),transform var(--dur) var(--ease),box-shadow var(--dur) var(--ease)}
#pwr .stp:active,#pwr .stp.stopping{background:#9e2b23;transform:scale(.9);box-shadow:inset 0 calc(2*var(--u)) calc(3*var(--u)) rgba(0,0,0,.45)}
#pwr .stp.stopping{animation:pwrSink 1s ease-in-out infinite}
#pwr .stp.stopping.slow{animation-duration:.7s}
@keyframes pwrSink{50%{background:#c8372d}}
#pwr .stp:focus-visible{outline:2px solid #8ab4ff;outline-offset:2px}
#pwr .gO,#pwr .gI{position:absolute;top:50%;transform:translate(-50%,-50%);color:#7d7d84;transition:color var(--dur) var(--ease)}
#pwr .gO{left:calc(13*var(--u));width:calc(11.2*var(--u));height:calc(11.2*var(--u));border-radius:50%;box-sizing:border-box;border:calc(3.2*var(--u)) solid currentColor}
#pwr .gI{left:calc(71*var(--u));width:calc(3.2*var(--u));height:calc(11.2*var(--u));border-radius:calc(1.6*var(--u));background:currentColor}
#pwr[data-p="0"] .gO{color:var(--off)}
#pwr[data-p="1"] .gI{color:var(--on)}
#pwr.boot .gI{animation:pwrBlink 1s ease-in-out infinite}
@keyframes pwrBlink{50%{opacity:.35}}
#pwr.down{cursor:not-allowed}
#pwr.down .ring,#pwr.down .gO,#pwr.down .gI{opacity:.38}
@media (prefers-reduced-motion:reduce){#pwr.boot .gI,#pwr .stp.stopping{animation:none}}
</style>
</head>`;
rep('</head>', CSS);

// ---- 2. 顶栏：拿掉「● AI」和 STOP，换成 R；STOP 的 id 留给红钮，Esc / 发送键急停照旧 ----
rep('<span class="model"><span class="dot" id="aiDot"></span><span id="aiText">AI：…</span></span>', '');
rep('<button class="stop" id="stopBtn">STOP</button>', '<span id="pwr" data-p="0"><span class="ring"></span><button class="stp" id="stopBtn" title="急停（Esc）" aria-label="急停"></button><i class="gO"></i><i class="gI"></i></span>');
// ---- 3. 齿轮菜单去掉 AI ON/OFF ----
rep('<button class="btn" id="aiBtn" disabled>AI OFF</button>', '');

// ---- 4. 状态绘制 ----
rep(`  const booting = pwrOn === 'on' && st !== 'on';
  $('#aiDot').className = 'dot' + (booting ? ' boot' : st === 'on' ? ' on' : '');
  $('#aiText').className = booting ? 'boot' : '';
  $('#aiText').textContent = booting ? 'AI 上线中' : 'AI ' + (st === 'on' ? 'ON' : st === 'off' ? 'OFF' : 'Ollama 未启动');
  const b = $('#aiBtn'); b.textContent = st === 'on' ? 'AI OFF' : 'AI ON'; b.disabled = st === 'down' || !!S.busy;
`, `  const booting = pwrOn === 'on' && st !== 'on';
  const pw = $('#pwr'); pw.dataset.p = pwrOn === 'off' ? 0 : (booting || st === 'on') ? 1 : 0;
  pw.classList.toggle('boot', booting); pw.classList.toggle('down', st === 'down' && !booting);
  pw.title = booting ? 'AI 上线中…' : pwrOn === 'off' ? 'AI 下线中…' : st === 'on' ? 'AI 已上线 · 点左边 O 下线' : st === 'off' ? 'AI 已下线 · 点右边 I 上线' : 'Ollama 未启动';
`);
rep(`if (au.active) $('#aiText').append(' · 检测到 ' + au.game);`, `if (au.active) pw.title += ' · 检测到 ' + au.game;`);

// ---- 5. 点转环：左半＝关，右半＝开；中间红钮是 #stopBtn，走原来的急停 ----
const OLD_BTN = /\$\('#aiBtn'\)\.onclick = async \(\) => \{[^\n]*\n/;
if (!OLD_BTN.test(s)) throw new Error('没找到 aiBtn.onclick');
s = s.replace(OLD_BTN, () => `$('#pwr').onclick = async (e) => {
  if (e.target.closest('#stopBtn')) return;
  const pw = $('#pwr'), r = pw.getBoundingClientRect(), want = e.clientX < r.left + r.width / 2 ? 'off' : 'on';
  if (pwrOn || S.ai.state === 'down' || S.busy || (S.ai.state === 'on') === (want === 'on')) return;
  pwrOn = want; paint();
  try { await api('/api/power', { action: want }); } catch (err) { uiAlert(err.message); }
  pwrOn = ''; refresh();
};
`);
for (const k of ['aiDot', 'aiText', 'aiBtn']) if (s.includes("'#" + k + "'") || s.includes('id="' + k + '"')) throw new Error('还有残留引用：' + k);

if (mode === 'prod') {
  const bak = path.join(__dirname, 'agent', '_bak-20261005-pwr-ui.html');
  if (!fs.existsSync(bak)) fs.copyFileSync(SRC, bak);
  fs.writeFileSync(SRC, s);
  console.log('已改 ui.html，备份 ' + bak);
} else {
  // ---- 预览：假后端 + 窗口按钮 + 尺寸滑杆 ----
  const STUB = `<script>
(function () {
  const st = { ai: { state: 'off' }, busy: null, online: true, think: false, desktop: false, auto: { on: true }, ws: 'D:\\\\ai网站', kbDir: 'D:\\\\ai网站\\\\知识库', ctxUsed: 6200, ctxMax: 32768, convs: [] };
  window.__pv = st;
  const J = (o) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (u, o) => {
    const p = String(u).split('?')[0], b = o && o.body ? JSON.parse(o.body) : {};
    if (p === '/api/power') { if (b.action === 'on') { await new Promise((r) => setTimeout(r, 3000)); st.ai.state = 'on'; } else { await new Promise((r) => setTimeout(r, 400)); st.ai.state = 'off'; } return J({ ok: 1 }); }
    if (p === '/api/stop') { setTimeout(() => { st.busy = null; window.__pvSync && window.__pvSync(); }, 1500); return J({ ok: 1 }); }
    if (p === '/api/state') return J(st);
    return J({});
  };
  window.EventSource = function () { return { addEventListener() {}, close() {} }; };
})();
</script>`;
  rep('<style id="pwrCss">', STUB + '\n<style id="pwrCss">');   // 放在 head 里，比页面脚本先跑
  const PANEL = `
<div id="pvCap"><span>—</span><span>▢</span><span>✕</span></div>
<div id="pvPanel">
  <b>预览</b>
  <label>开关高 <input id="pvH" type="range" min="20" max="48" step="0.8" value="${H}"> <input id="pvN" type="number" min="20" max="48" step="0.8" value="${H}"></label>
  <span id="pvOut"></span>
  <button id="pvBusy">模拟：有任务在跑</button>
  <button id="pvDown">模拟：Ollama 未启动</button>
</div>
<style>
header{padding-right:150px!important;position:relative}
#pvCap{position:fixed;top:0;right:0;height:48px;width:138px;display:flex;z-index:40;pointer-events:none}
#pvCap span{flex:1;display:grid;place-items:center;color:#fff;font:12px var(--font);opacity:.9}
#pvPanel{position:fixed;left:50%;bottom:120px;transform:translateX(-50%);z-index:60;display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:10px 14px;border-radius:12px;background:rgba(20,20,22,.96);box-shadow:0 8px 28px rgba(0,0,0,.6),inset 0 0 0 1px rgba(255,255,255,.12);color:#e2e2e5;font:13px var(--font)}
#pvPanel b{color:#ffd166;font-weight:600}
#pvPanel label{display:inline-flex;align-items:center;gap:8px}
#pvH{width:220px}
#pvN{width:62px;background:#2c2c2c;color:#fff;border:1px solid rgba(255,255,255,.15);border-radius:6px;padding:3px 6px;font:inherit}
#pvOut{color:#97979e}
#pvPanel button{border:0;background:rgba(255,255,255,.09);color:#e2e2e5;font:inherit;height:28px;padding:0 10px;border-radius:7px;cursor:pointer}
#pvPanel button.on{background:rgba(255,255,255,.22);color:#fff}
</style>
<script>
(function () {
  const st = window.__pv, $p = (s) => document.getElementById(s);
  window.__pvSync = () => { $p('pvBusy').classList.toggle('on', !!st.busy); refresh(); };
  function setH(h) {
    h = Math.min(48, Math.max(20, Math.round(h / .8) * .8));
    document.getElementById('pwr').style.setProperty('--pk', h / 32);
    $p('pvH').value = h; $p('pvN').value = +h.toFixed(1);
    $p('pvOut').textContent = '高 ' + +h.toFixed(1) + 'px · 宽 ' + +(h * 84 / 32).toFixed(1) + 'px（125% 缩放下 ' + Math.round(h * 1.25) + ' 设备像素高）';
  }
  $p('pvH').oninput = (e) => setH(+e.target.value);
  $p('pvN').onchange = (e) => setH(+e.target.value);
  $p('pvBusy').onclick = () => { st.busy = st.busy ? null : '对话'; window.__pvSync(); };
  $p('pvDown').onclick = (e) => { st.ai.state = st.ai.state === 'down' ? 'off' : 'down'; e.target.classList.toggle('on', st.ai.state === 'down'); refresh(); };
  setH(${H});
})();
</script>
</body>`;
  const i = s.lastIndexOf('</body>'); if (i < 0) throw new Error('没有 </body>');
  s = s.slice(0, i) + PANEL + s.slice(i + 7);
  const out = path.join(__dirname, 'agent', '_ui-pwr-preview.html');
  fs.writeFileSync(out, s);
  console.log('预览：' + out);
}
