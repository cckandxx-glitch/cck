'use strict';
// 自动上线/下线：检测到「正在吃显卡的软件」（游戏、3D 软件等）→ AI 自动下线；它关掉 → AI 自动上线。
// 判断完全按行为，不看文件名：进程持续占用 3D/计算引擎、全屏铺满且在用显卡、或专用显存很大且在用显卡。
// 文件名只出现在「不是游戏」排除名单里（只用来排除）。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = path.join(__dirname, '..');
const EXCL = path.join(BASE, '不是游戏的程序.txt');
const STATEF = path.join(__dirname, 'state.json');

// 写死的、永远不当游戏的：系统进程、Ollama 自己、这个助手自己、外壳
const HARD = new Set(['system', 'registry', 'csrss.exe', 'dwm.exe', 'explorer.exe', 'winlogon.exe', 'svchost.exe', 'lsass.exe', 'services.exe', 'wininit.exe', 'smss.exe', 'fontdrvhost.exe', 'audiodg.exe', 'sihost.exe', 'taskhostw.exe', 'runtimebroker.exe', 'ctfmon.exe',
  'searchhost.exe', 'textinputhost.exe', 'shellexperiencehost.exe', 'startmenuexperiencehost.exe', 'widgets.exe', 'lockapp.exe', 'applicationframehost.exe',
  'ollama.exe', 'ollama app.exe', 'llama-server.exe', 'node.exe', 'powershell.exe', 'pwsh.exe', 'conhost.exe', 'cmd.exe', 'windowsterminal.exe']);

function create({ cfg, pw, getBusy, setBusy, notify, onEvent, notGameUrl }) {
  const START_MS = (cfg.autoGameStartSec || 6) * 1000;    // 判定成立后再持续这么久才下线（防启动器一闪而过）
  const END_MS = (cfg.autoGameEndSec || 25) * 1000;       // 持续消失这么久才上线（防游戏崩溃重开来回加载）
  const HIGH_UTIL = cfg.autoHighUtil || 30;               // 3D 占用 ≥ 这个百分比（实测：空闲/看视频 ≤2%，最轻的 3D 程序 ≥50%）
  const FULL_UTIL = cfg.autoFullscreenUtil || 10;         // 前台全屏时，3D 占用 ≥ 这个百分比
  const VRAM_MB = cfg.autoVramMB || 2500;                 // 专用显存 ≥ 这么多 MB ……
  const VRAM_UTIL = cfg.autoVramUtil || 8;                // ……并且 3D 占用 ≥ 这个百分比
  let on = true;
  try { on = JSON.parse(fs.readFileSync(STATEF, 'utf8')).autoMode !== false; } catch (e) {}
  const S = { active: false, game: '', title: '', why: '', detSince: 0, missSince: 0, offByAuto: false, resume: false, userForcedOn: false, forceNext: false, pendingOff: false, pendingOn: false, err: '', lastSample: 0, busyNoted: false, detName: '', detTitle: '' };
  let watcher = null, buf = '', restartTimer = null, closed = false, transitioning = false;
  const hist = new Map();   // pid -> 最近两次 [{u, v}]，两次都达标才算「持续」

  // ---------- 排除名单（用户可编辑；点「这不是游戏」会自动往里加） ----------
  let X = { mtime: -1, names: new Set(), paths: [] };
  function excl() {
    try {
      const m = fs.statSync(EXCL).mtimeMs; if (m === X.mtime) return X;
      const n = { mtime: m, names: new Set(), paths: [] };
      for (const raw of fs.readFileSync(EXCL, 'utf8').split(/\r?\n/)) {
        const t = raw.replace(/\s+#.*$/, '').trim().toLowerCase(); if (!t || t.startsWith('#')) continue;
        if (t.startsWith('path:')) n.paths.push(t.slice(5).trim()); else n.names.add(t);
      }
      X = n;
    } catch (e) { /* 读不到就沿用上一份 */ }
    return X;
  }
  const norm = (p) => String(p || '').toLowerCase().replace(/\//g, '\\');
  const excluded = (p, x) => { const nm = p.name.toLowerCase(); return HARD.has(nm) || x.names.has(nm) || x.paths.some((s) => norm(p.path).includes(s)); };

  // sample = { util:{pid:%}, vram:{pid:MB}, titles:{pid:title}, procs:[[pid,name,path]], fg:{pid,full,title} }
  function evaluate(sample) {
    const x = excl(); const byPid = new Map();
    for (const [pid, name, p] of sample.procs || []) byPid.set(String(pid), { pid: String(pid), name: String(name || ''), path: p });
    const pids = new Set([...Object.keys(sample.util || {}), ...Object.keys(sample.vram || {})]);
    for (const pid of [...hist.keys()]) if (!pids.has(pid)) hist.delete(pid);
    const out = [];
    for (const pid of pids) {
      const h = hist.get(pid) || []; h.push({ u: (sample.util || {})[pid] || 0, v: (sample.vram || {})[pid] || 0 }); while (h.length > 2) h.shift(); hist.set(pid, h);
      const p = byPid.get(pid); if (!p || excluded(p, x) || h.length < 2) continue;
      const u = Math.min(h[0].u, h[1].u), v = Math.min(h[0].v, h[1].v);       // 两次都要达标
      const fg = sample.fg || {}; const isFg = String(fg.pid) === pid;
      let why = '';
      if (u >= HIGH_UTIL) why = `3D 占用 ${u}%`;
      else if (isFg && fg.full && u >= FULL_UTIL) why = `全屏运行，3D 占用 ${u}%`;
      else if (v >= VRAM_MB && u >= VRAM_UTIL) why = `专用显存 ${(v / 1024).toFixed(1)}GB，3D 占用 ${u}%`;
      if (why) {
        // 显示名：窗口标题（前台窗口或该进程的窗口）优先，其次进程名
        let title = (sample.titles || {})[pid] || (isFg ? fg.title : '') || '';
        if (!title) for (const [pp, t] of Object.entries(sample.titles || {})) if (byPid.get(pp) && byPid.get(pp).name === p.name) { title = t; break; }
        out.push({ name: p.name, title, pid, u, why });
      }
    }
    out.sort((a, b) => b.u - a.u);
    return out[0] || null;
  }
  const label = (n, t) => (t ? `「${t}」(${n})` : n);

  // ---------- 通知 ----------
  function toast(text, withButton, name) {
    try {
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'toast.ps1'), '-B64', Buffer.from(text, 'utf8').toString('base64')];
      if (withButton && notGameUrl) args.push('-ActionUrl', notGameUrl(name), '-ActionLabelB64', Buffer.from('这不是游戏', 'utf8').toString('base64'));
      const p = spawn('powershell.exe', args, { windowsHide: true, stdio: 'ignore' }); p.on('error', () => {});
    } catch (e) {}
  }
  const say = (t, btnName) => { notify(t); toast(t, !!btnName, btnName); };

  // ---------- 状态机 ----------
  async function doOff() {
    if (transitioning) return; transitioning = true; setBusy('AI 上线/下线');
    try {
      const r = await pw.off();
      if (r.ok) { S.offByAuto = true; S.pendingOff = false; say(`检测到 ${label(S.game, S.title)} 在运行，AI 已自动下线。`, S.game); onEvent('autooff', { name: S.game, title: S.title }); }
      else notify('自动下线没成功：' + r.text);
    } catch (e) { notify('自动下线出错：' + e.message); }
    finally { setBusy(null); transitioning = false; onEvent('state', {}); }
  }
  async function doOn(text) {
    if (transitioning) return false; transitioning = true; setBusy('AI 上线/下线'); let ok = false;
    try {
      const r = await pw.on();
      if (r.ok) { ok = true; S.pendingOn = false; say(text || '游戏已关闭，AI 已自动上线（约 7 秒）。'); onEvent('autoon', {}); }
      else notify('自动上线没成功：' + r.text);
    } catch (e) { notify('自动上线出错：' + e.message); }
    finally { setBusy(null); transitioning = false; onEvent('state', {}); }
    return ok;
  }
  async function activate(det) {
    S.active = true; S.game = det.name; S.title = det.title; S.why = det.why; S.userForcedOn = false; S.offByAuto = false; S.resume = false; S.pendingOff = false; S.busyNoted = false;
    notify(`检测到 ${label(det.name, det.title)} 在运行（${det.why}）。`); onEvent('state', {});
    if (S.forceNext) { S.userForcedOn = true; S.forceNext = false; return; }     // 用户在游戏刚被检测到时就点了强制上线
    const st = await pw.status();
    if (S.userForcedOn) return;
    if (st.state === 'on') S.pendingOff = true;         // 实际下线在 tick 里做：AI 正忙就等它忙完
    else if (st.state === 'off') S.resume = true;       // 用户已手动下线：游戏结束后也自动上线
  }
  function deactivate() {
    const name = S.game, shown = label(S.game, S.title), need = (S.offByAuto || S.resume) && !S.userForcedOn;
    Object.assign(S, { active: false, game: '', title: '', why: '', missSince: 0, detSince: 0, offByAuto: false, resume: false, userForcedOn: false, pendingOff: false, busyNoted: false });
    if (need) { S.pendingOn = true; S.pendingText = `${shown} 已关闭，AI 已自动上线（约 7 秒）。`; } else notify(`${shown} 已关闭。`);
    onEvent('state', {});
  }

  async function onSample(j) {
    S.lastSample = Date.now(); if (!on) return;
    const det = evaluate(j), now = Date.now();
    if (det) {
      S.missSince = 0; if (!S.detSince) S.detSince = now; S.detName = det.name; S.detTitle = det.title;
      if (!S.active && now - S.detSince >= START_MS) await activate(det);
    } else {
      S.detSince = 0; S.detName = ''; S.detTitle = '';
      if (S.active) { if (!S.missSince) S.missSince = now; if (now - S.missSince >= END_MS) deactivate(); }
    }
    if (S.active && S.pendingOff && !S.userForcedOn) {
      if (getBusy()) { if (!S.busyNoted) { S.busyNoted = true; notify(`检测到 ${label(S.game, S.title)} 在运行，AI 正在${getBusy()}，做完后自动下线。`); } }
      else await doOff();
    }
    if (!S.active && S.pendingOn && !getBusy()) { S.pendingOn = false; const st = await pw.status(); if (st.state === 'off') await doOn(S.pendingText); }
  }

  // ---------- 监测进程 ----------
  function startWatch() {
    if (watcher || closed) return;
    watcher = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'gpuwatch.ps1'), '-Interval', '4'], { windowsHide: true });
    watcher.stdout.setEncoding('utf8');
    watcher.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; let j; try { j = JSON.parse(l); S.err = ''; } catch (e) { S.err = '监测数据读不懂'; continue; } onSample(j).catch((e) => { S.err = e.message; }); } });
    watcher.on('exit', () => { watcher = null; if (on && !closed) { S.err = '监测程序退出，5 秒后重启'; restartTimer = setTimeout(startWatch, 5000); } });
  }
  function stopWatch() { clearTimeout(restartTimer); if (watcher) { try { watcher.kill(); } catch (e) {} watcher = null; } }
  setInterval(() => { if (on && watcher && S.lastSample && Date.now() - S.lastSample > 30000) { S.err = '监测超过 30 秒没有数据，重启'; stopWatch(); startWatch(); } }, 10000).unref();
  function save() { try { fs.writeFileSync(STATEF, JSON.stringify({ autoMode: on })); } catch (e) {} }
  if (on) startWatch();

  return {
    get: () => ({ on, active: S.active, game: S.game, title: S.title, why: S.why, offByAuto: S.offByAuto, err: S.err }),
    set(v) { on = !!v; save(); if (on) startWatch(); else { stopWatch(); hist.clear(); Object.assign(S, { active: false, game: '', title: '', detSince: 0, missSince: 0, offByAuto: false, resume: false, pendingOff: false, pendingOn: false, userForcedOn: false, forceNext: false }); } onEvent('state', {}); },
    manual(action) {          // 用户手动下线：游戏期间 → 游戏结束后自动上线
      if (action !== 'off') return;
      if (S.active) Object.assign(S, { resume: true, pendingOff: false, userForcedOn: false });
      S.pendingOn = false;
    },
    // 现在有游戏在运行吗（含刚判定、还在防抖等待的）：有就返回 {name,title}，没有返回 null；自动模式关着时永远 null
    blocking() { if (!on) return null; if (S.active) return { name: S.game, title: S.title }; if (S.detSince) return { name: S.detName, title: S.detTitle }; return null; },
    keepOffline() { if (S.active) Object.assign(S, { resume: true, pendingOff: false, userForcedOn: false }); },
    forceOn() { if (S.active) Object.assign(S, { userForcedOn: true, pendingOff: false, offByAuto: false, resume: false }); else if (S.detSince) S.forceNext = true; },
    // 「这不是游戏」：记进排除名单，马上让 AI 上线
    async notGame(name) {
      name = String(name || '').trim().toLowerCase(); if (!name || /[\r\n#]/.test(name)) return { ok: false, text: '程序名不对' };
      const x = excl();
      if (!x.names.has(name)) { try { fs.appendFileSync(EXCL, `\n${name}   # 这不是游戏，${new Date().toLocaleString('zh-CN')} 自动添加\n`, 'utf8'); } catch (e) { return { ok: false, text: '写不进排除名单：' + e.message }; } X.mtime = -1; }
      hist.clear();
      if (S.active && S.game.toLowerCase() === name) Object.assign(S, { active: false, game: '', title: '', why: '', missSince: 0, detSince: 0, offByAuto: false, resume: false, userForcedOn: false, pendingOff: false });
      else if (S.detName && S.detName.toLowerCase() === name) { S.detSince = 0; S.detName = ''; }
      const st = await pw.status(); let text = `已记住：${name} 不是游戏，以后不再因为它下线。`;
      if (st.state === 'off' && !S.active) { const ok = await doOn(`已记住：${name} 不是游戏，AI 已上线（约 7 秒）。`); text = ok ? text + 'AI 已上线。' : text + 'AI 上线没成功。'; }
      onEvent('state', {}); return { ok: true, text };
    },
    // 对话口令：「自动模式关 / 关掉自动模式 / 打开自动模式」
    detect(text) {
      const t = String(text).trim().replace(/[。.!！\s]+$/g, ''); if (t.length > 14 || !/自动/.test(t)) return null;
      if (/(关|停|取消|不要|禁用)/.test(t)) return 'off'; if (/(开|启|打开|启用|恢复)/.test(t)) return 'on'; return null;
    },
    evaluate, close() { closed = true; stopWatch(); }, _hist: hist,
  };
}
module.exports = { create };
