'use strict';
// 桌面控制：看屏幕 + 鼠标键盘。默认关闭，界面上「桌面」开关打开后才给模型这些工具。
// 保护：每次任务第一次操作前要用户确认；急停（按钮 / Ctrl+Alt+End / 鼠标甩到左上角）；
//       前台窗口标题含银行、支付、密码等字样时拒绝操作；无人值守的任务队列里不可用。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SENSITIVE = /银行|支付|付款|转账|收银|密码|口令|验证码|网银|证券|钱包|bank|paypal|alipay|wechat ?pay|password|credential|wallet|checkout|payment|sign in|log in|登录/i;

function install(core, cfg) {
  const DESK = path.join(__dirname, 'desk.ps1');
  const WATCH = path.join(__dirname, 'deskwatch.ps1');
  const ACTIVE = path.join(core.BASE, 'desk.active');
  const STOPF = path.join(core.BASE, 'STOP');
  const st = { enabled: false, consentTurn: -1, w: 2560, h: 1440, lastTitle: '' };
  let helper = null, watcher = null, buf = '', waiting = [], chain = Promise.resolve();

  function startHelper() {
    if (helper) return;
    helper = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DESK, 'serve'], { windowsHide: true });
    helper.stdout.setEncoding('utf8');
    helper.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); const w = waiting.shift(); if (w && l) { try { w.res(JSON.parse(l)); } catch (e) { w.rej(new Error('桌面助手返回无法解析: ' + l.slice(0, 120))); } } } });
    helper.on('exit', () => { helper = null; while (waiting.length) waiting.shift().rej(new Error('桌面助手已退出')); });
  }
  function startWatch() {
    if (watcher) return;
    watcher = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WATCH, '-ActiveFile', ACTIVE, '-StopFile', STOPF], { windowsHide: true });
    watcher.on('exit', () => { watcher = null; });
  }
  function stopAll() {
    try { fs.unlinkSync(ACTIVE); } catch (e) {}
    if (helper) { try { helper.stdin.end(); helper.kill(); } catch (e) {} helper = null; }
    if (watcher) { try { watcher.kill(); } catch (e) {} watcher = null; }
  }
  function call(...args) {
    startHelper();
    const p = chain.then(() => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('桌面操作超时')), 30000);
      waiting.push({ res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      helper.stdin.write(args.map((a) => String(a === undefined ? '' : a)).join('\t') + '\n');
    }));
    chain = p.catch(() => {});
    return p.then((r) => { if (r.error) throw new Error(r.error); return r; });
  }

  async function shot(region) {   // region: 物理像素 {x,y,w,h}
    const f = path.join(os.tmpdir(), `reize-shot-${process.pid}.png`);
    const r = await call('shot', f, 1280, region ? `${region.x},${region.y},${region.w},${region.h}` : '');
    st.w = r.w; st.h = r.h; st.lastTitle = r.title || '';
    const b64 = fs.readFileSync(f).toString('base64'); try { fs.unlinkSync(f); } catch (e) {}
    return { b64, sw: r.sw, sh: r.sh, title: r.title };
  }

  // 模型的坐标是 0-1000 相对坐标；region 是「上一张局部截图」对应的全屏 0-1000 区域，坐标则相对那张局部图
  function toPx(x, y, region) {
    x = Math.min(1000, Math.max(0, Number(x))); y = Math.min(1000, Math.max(0, Number(y)));
    if (!(x >= 0 && y >= 0)) throw new Error('坐标不是数字');
    let gx = x, gy = y;
    if (Array.isArray(region) && region.length === 4) { const [x1, y1, x2, y2] = region.map(Number); gx = x1 + (x2 - x1) * x / 1000; gy = y1 + (y2 - y1) * y / 1000; }
    return { px: Math.round(gx / 1000 * st.w), py: Math.round(gy / 1000 * st.h) };
  }

  async function guard(what) {
    core.checkStop();
    if (!st.enabled) throw new Error('桌面开关是关的');
    const t = (await call('title')).title || '';
    if (SENSITIVE.test(t)) throw new Error(`当前窗口「${t}」看起来是登录/银行/支付/密码页面，为安全起见不操作。请你自己处理。`);
    if (st.consentTurn !== core.turnId()) {
      const ok = await core.ask(`AI 要开始操作你的鼠标和键盘（第一步：${what}）。同意后这次任务里不再逐步确认。随时可以点右上角「急停」、按 Ctrl+Alt+End，或把鼠标甩到屏幕左上角打断。`, { kind: 'desktop' });
      if (!ok) throw new Error('用户没有同意桌面操作，已停止。');
      st.consentTurn = core.turnId();
    }
    fs.writeFileSync(ACTIVE, String(Date.now()));    // 打开看门狗
    startWatch();
  }
  const after = async (text, delay = 700) => {   // 动作之后等一下界面反应，再自动附一张最新截图
    await new Promise((r) => setTimeout(r, delay)); core.checkStop();
    const s = await shot();
    return { text: text + ` 当前窗口：「${s.title}」。已附上最新屏幕截图。`, images: [s.b64] };
  };
  const nearCorner = (px, py) => px < 12 && py < 12;

  const T = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
  const N = { type: 'number' }, S = { type: 'string' };
  const REG = { type: 'array', items: N, description: '可选。上一次 screen_zoom 用的区域 [x1,y1,x2,y2]；给了的话，x/y 是相对那张放大图的 0-1000 坐标' };
  const on = () => st.enabled;
  const tools = [
    [T('screen_look', '看一眼当前整个屏幕（主显示器），返回截图', {}, []), async () => {
      core.checkStop(); if (!st.enabled) throw new Error('桌面开关是关的');
      const s = await shot(); return { text: `屏幕截图（${s.sw}x${s.sh}，坐标用 0-1000 相对坐标）。当前窗口：「${s.title}」。`, images: [s.b64] };
    }],
    [T('screen_zoom', '放大看屏幕上的一块区域（全屏 0-1000 相对坐标），用于看清小字、小图标，再用 mouse_click 的 region 参数精确点击', { x1: N, y1: N, x2: N, y2: N }, ['x1', 'y1', 'x2', 'y2']), async (a) => {
      core.checkStop(); if (!st.enabled) throw new Error('桌面开关是关的');
      const p1 = toPx(a.x1, a.y1), p2 = toPx(a.x2, a.y2); const w = Math.max(40, p2.px - p1.px), h = Math.max(40, p2.py - p1.py);
      const s = await shot({ x: p1.px, y: p1.py, w, h });
      return { text: `局部放大图，对应全屏区域 [${a.x1},${a.y1},${a.x2},${a.y2}]。在这张图上指坐标时，调用 mouse_click 请带上 region=[${a.x1},${a.y1},${a.x2},${a.y2}]。`, images: [s.b64] };
    }],
    [T('mouse_click', '点击屏幕上某个位置', { x: N, y: N, button: { type: 'string', enum: ['left', 'right'] }, double: { type: 'boolean' }, region: REG }, ['x', 'y']), async (a) => {
      const { px, py } = toPx(a.x, a.y, a.region);
      if (nearCorner(px, py)) throw new Error('位置太靠近屏幕左上角（那是急停区），不点。');
      await guard(`点击 (${a.x},${a.y})`);
      const r = await call('click', px, py, a.button === 'right' ? 'right' : 'left', a.double ? 2 : 1);
      core.log('desktop', { act: 'click', px, py, title: r.title });
      return after(`已${a.double ? '双击' : a.button === 'right' ? '右键点击' : '点击'}像素位置 (${px},${py})。`);
    }],
    [T('mouse_drag', '按住左键从一个位置拖到另一个位置', { x1: N, y1: N, x2: N, y2: N, region: REG }, ['x1', 'y1', 'x2', 'y2']), async (a) => {
      const p = toPx(a.x1, a.y1, a.region), q = toPx(a.x2, a.y2, a.region);
      if (nearCorner(p.px, p.py) || nearCorner(q.px, q.py)) throw new Error('位置太靠近屏幕左上角（急停区）。');
      await guard('拖拽');
      const r = await call('drag', p.px, p.py, q.px, q.py); core.log('desktop', { act: 'drag', p, q, title: r.title });
      return after(`已拖拽 (${p.px},${p.py}) → (${q.px},${q.py})。`);
    }],
    [T('mouse_scroll', '在某个位置滚动鼠标滚轮，amount 正数向上、负数向下，一格约一屏的十分之一', { x: N, y: N, amount: N }, ['x', 'y', 'amount']), async (a) => {
      const { px, py } = toPx(a.x, a.y); await guard('滚动');
      const n = Math.max(-20, Math.min(20, Math.round(Number(a.amount) || 0)));
      await call('scroll', px, py, n * 120); return after(`已滚动 ${n} 格。`);
    }],
    [T('type_text', '在当前光标位置输入文字（支持中文）。输入前先用 mouse_click 点到输入框', { text: S }, ['text']), async (a) => {
      const t = String(a.text || ''); if (!t || t.length > 2000) throw new Error('文字为空或超过 2000 字');
      await guard(`输入文字（${t.length} 字）`);
      await call('type', Buffer.from(t, 'utf8').toString('base64')); core.log('desktop', { act: 'type', chars: t.length });
      return after(`已输入 ${t.length} 个字。`, 500);
    }],
    [T('press_key', '按一个键或组合键，如 enter、tab、esc、ctrl+c、ctrl+v、alt+f4、win+d、f5、pagedown', { keys: S }, ['keys']), async (a) => {
      const k = String(a.keys || '').trim(); if (!/^[a-z0-9+_ -]{1,30}$/i.test(k)) throw new Error('按键格式不对');
      if (/alt\+f4|ctrl\+alt\+del|win\+l|win\+r/i.test(k)) throw new Error('这个组合键不允许 AI 按（关窗口/锁屏/运行）。');
      await guard('按键 ' + k); await call('key', k.replace(/\s+/g, '')); core.log('desktop', { act: 'key', k });
      return after(`已按 ${k}。`, 500);
    }],
    [T('wait_seconds', '等几秒再看（网页加载、程序启动时用），最多 10 秒', { seconds: N }, ['seconds']), async (a) => {
      if (!st.enabled) throw new Error('桌面开关是关的');
      const s = Math.max(1, Math.min(10, Number(a.seconds) || 2)); await new Promise((r) => setTimeout(r, s * 1000)); core.checkStop();
      const sh = await shot(); return { text: `等了 ${s} 秒。当前窗口：「${sh.title}」。`, images: [sh.b64] };
    }],
  ];
  for (const [def, run] of tools) core.extraTools.push({ def, run, enabled: on });

  core.onTurnEnd(() => { try { fs.unlinkSync(ACTIVE); } catch (e) {} });
  return {
    set(v) { st.enabled = !!v; if (st.enabled) { startHelper(); startWatch(); } else stopAll(); },
    get: () => st.enabled,
    close: stopAll,
  };
}
module.exports = { install };
