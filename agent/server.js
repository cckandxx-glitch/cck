'use strict';
// REIZE助手 · 网页界面服务。只监听 127.0.0.1，需要口令 cookie；打开方式：node server.js（会自动打开浏览器）。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createCore } = require('./core');
const leads = require('./leads');
const power = require('./power');
const desktop = require('./desktop');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
if (process.argv.includes('--online')) cfg.online = true;
const PORT = cfg.port || 5200;

// ---------- 口令（重启后保持不变，浏览器不用重新登录） ----------
const TOKENF = path.join(__dirname, '.token');
let TOKEN = ''; try { TOKEN = fs.readFileSync(TOKENF, 'utf8').trim(); } catch (e) {}
if (TOKEN.length < 20) { TOKEN = crypto.randomBytes(24).toString('hex'); fs.writeFileSync(TOKENF, TOKEN); }

// ---------- 状态 ----------
const clients = new Set();
const tr = [];                 // 对话记录，给刷新页面后回放
const leadLog = [];
let busyKind = null, busySince = 0;
setInterval(() => { if (busy !== busyKind) { busyKind = busy; busySince = busy ? Date.now() : 0; } }, 300).unref();   // 页面刷新后计时不归零：开始时刻由服务端记
let busy = null;               // null | '对话' | '任务队列' | '线索挖掘' | 'AI 上线/下线' | '学习循环'
const busyDoing = () => ({ '对话': 'AI 正在回复或画图', '任务队列': 'AI 正在跑任务队列', '线索挖掘': 'AI 正在挖掘线索', '学习循环': 'AI 正在学习循环', 'AI 上线/下线': 'AI 正在上线或下线' })[busy] || 'AI 正在工作';
const busyMsg = (what) => busyDoing() + '，现在不能' + what + '。等它做完，或点「急停」后再试。';
let unattended = false;
let allowAll = false;   // 用户点了「本次任务全部同意」：这一轮里不再逐条问（删除和危险命令除外）
// 前后不能紧挨字母或「-」：否则 Format-Table、Get-Date -Format 这类只读命令会被当成 format 弹确认（10-07）
const DANGER = /(?<![\w-])(Remove-Item|rm|rmdir|del|erase|format|diskpart|shutdown|Restart-Computer|Stop-Computer|reg(\.exe)?\s+(add|delete)|Set-ExecutionPolicy|net\s+user|schtasks|taskkill|Stop-Process|bcdedit|cipher)(?![\w-])/i;
const isRisky = (d) => !!d && (d.kind === 'batch' ? (d.items || []).some((x) => isRisky(x.detail)) : d.kind === 'delete' || (d.kind === 'command' && DANGER.test(String(d.command || ''))));
const queue = { items: [], cancel: false };
// ---------- 学习循环（2026-10-06 用户设定）：说"请学习/继续学"就一直跑，每轮学完自动开下一轮，只在聊天框汇报，不弹确认；说"停止学习"或点急停才停 ----------
const learn = { on: false, round: 0, stopped: false, inbox: [], yielding: false, since: 0, resumable: false };   // resumable：刚急停/停止了学习，这时只说「继续」也算继续学习
// 10-07 用户：开着助手时 24 小时不停学，直到说"停止学习"；但关掉助手后不自动接着学，要用户再说一次"继续学习"。
// learn.json 只是「正在学」的标记，给外壳用（学习中不让电脑睡眠、关窗先问一句）；后台一启动、一退出都删掉
const LEARNF = path.join(__dirname, 'learn.json');
const saveLearn = (on) => { try { if (on) fs.writeFileSync(LEARNF, JSON.stringify({ on: true, round: learn.round, since: learn.since || Date.now() })); else if (fs.existsSync(LEARNF)) fs.unlinkSync(LEARNF); } catch (e) {} };
saveLearn(false); process.on('exit', () => saveLearn(false));
// 10-07：「刚才在学习」要记到文件里，关掉助手重开后只说「继续」也接着学习循环（17:31 重开发「继续」被当成普通聊天，跑完一轮就停了，一直停到 18:14）
const RESUMEF = path.join(__dirname, 'learn-resume.json');
const setResumable = (v) => { learn.resumable = !!v; try { if (v) fs.writeFileSync(RESUMEF, '{"resumable":true}'); else if (fs.existsSync(RESUMEF)) fs.unlinkSync(RESUMEF); } catch (e) {} };
learn.resumable = fs.existsSync(RESUMEF);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEARN_PROMPT = () => '（学习第 ' + learn.round + ' 轮：按系统提示里这一轮的任务查资料，存进知识库。最后只写一行（不超过 60 字），格式：学了 XX；存进 XX；下一轮 XX。）';
function stopLearn(reason) {
  if (!learn.on) return;
  bbS('停止学习：', reason, '第', learn.round, '轮');
  learn.on = false; learn.stopped = true; setResumable(true); learn.inbox = []; saveLearn(false);
  core.stop(); skipAsks();
  for (const [id, p] of pending) { pending.delete(id); p.resolve(false); bc('confirm_done', { id, answered: '已拒绝' }); }
  notice('已停止学习。');
  bc('state', {});
}
const isLearnCmd = (t) => /^(请|帮我|你|开始)?(继续)?(学习|自学|学)(吧|一下|一会|一会儿)?$/.test(String(t || '').trim());
const isStopLearnCmd = (t) => /^(停止|停|结束)(一下)?(学习|自学|学习循环|自学循环)?$/.test(String(t || '').trim());
const pending = new Map(); let cid = 0;
const asks = new Map();   // AI 提的选择题，等用户点：id → { questions, resolve }
function askDone(id, ans, shown) { const a = asks.get(id); if (!a) return false; asks.delete(id); for (const it of tr) if (it.role === 'ask' && it.id === id) it.answered = shown; bc('ask_done', { id, answered: shown }); a.resolve(ans); return true; }
const skipAsks = () => { for (const id of [...asks.keys()]) askDone(id, null, null); };

const bc = (type, data) => { const s = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) { try { c.write(s); } catch (e) {} } };
let mseq = Date.now(), droppedUsers = 0;   // droppedUsers：被 400 条上限挤掉的用户消息数，用来对齐 tr 和模型上下文
const push = (it) => { it.mid = 'm' + (++mseq); tr.push(it); if (tr.length > 400) { const o = tr.shift(); if (o.role === 'user') droppedUsers++; } dirty = true; return it; };

// ---------- 多个对话：每个存成 对话/cXXXX.json，侧栏列出，可切换、可删除 ----------
const CONVDIR = path.join(__dirname, '..', '对话'); fs.mkdirSync(CONVDIR, { recursive: true });
const CONVLOGDIR = path.join(cfg.workspace, '对话日志'); fs.mkdirSync(CONVLOGDIR, { recursive: true });
const convs = new Map();       // id -> { id, title, updated }
let cur = null, dirty = false; // 当前对话 { id, title, created }
const cfile = (id) => path.join(CONVDIR, id + '.json');
const hasUser = () => tr.some((x) => x.role === 'user');
for (const n of fs.readdirSync(CONVDIR)) if (/^c\d+\.json$/.test(n)) { try { const j = JSON.parse(fs.readFileSync(path.join(CONVDIR, n), 'utf8')); convs.set(j.id, { id: j.id, title: j.title, updated: j.updated }); } catch (e) {} }
function persist() {
  if (!cur || !dirty || !hasUser()) return;
  const messages = core.getHistory().map((m) => { const c = { ...m }; delete c.images; return c; });
  const rec = { id: cur.id, title: cur.title, created: cur.created, updated: Date.now(), droppedUsers, tr, messages };
  const f = cfile(cur.id);
  try { fs.writeFileSync(f + '.tmp', JSON.stringify(rec)); fs.renameSync(f + '.tmp', f); } catch (e) { bbS('保存对话失败（下次再存）', e.message); return; }   // Windows 上杀毒/索引偶尔锁住文件，存不上就下次再存，不能让学习循环因此出错或后台崩掉
  try { const lf = path.join(CONVLOGDIR, cur.id + '.json'); fs.writeFileSync(lf + '.tmp', JSON.stringify(rec)); fs.renameSync(lf + '.tmp', lf); } catch (e) {}
  convs.set(cur.id, { id: cur.id, title: cur.title, updated: rec.updated }); dirty = false;
}
function newConv() { cur = { id: 'c' + Date.now(), title: '新对话', created: Date.now() }; tr.length = 0; droppedUsers = 0; core.clear(); dirty = false; }
function openConv(id) {
  const j = JSON.parse(fs.readFileSync(cfile(id), 'utf8'));
  persist(); cur = { id: j.id, title: j.title, created: j.created };
  tr.length = 0; droppedUsers = j.droppedUsers || 0; for (const it of j.tr || []) { if (it.role === 'confirm' && !it.answered) it.answered = '已过期'; tr.push(it); }
  core.setMessages(j.messages || []); dirty = false;
  // 10-05 链接纠正以前只管新回复：打开旧对话时把历史回复里写反的链接也按工具结果的原地址改回去
  const fix = (s) => { for (const [a, b] of core.linkFixes(s || '')) { s = s.split(a).join(b); dirty = true; } return s; };
  for (const it of tr) if (it.role === 'ai' && it.text) it.text = fix(it.text);
  for (const m of core.getMessages()) if (m.role === 'assistant' && typeof m.content === 'string') m.content = fix(m.content);
}
const isRealUser = (m) => m.role === 'user' && !String(m.content).startsWith('（这是刚才操作后的屏幕截图');
function turnRange(h, k) { let a = -1, n = 0; for (let i = 0; i < h.length; i++) if (isRealUser(h[i])) { if (a >= 0) return [a, i]; if (n === k) a = i; n++; } return a < 0 ? null : [a, h.length]; }
// 撤回：界面上换成一行提示，模型的记忆里也删掉。用户消息 = 连同它引出的整轮；AI 消息 = 只删那一条回复
function recallMsg(mid, silent) {
  const ti = tr.findIndex((x) => x.mid === mid); if (ti < 0) return false;
  const back = tr[ti].role === 'user' ? { text: tr[ti].raw != null ? tr[ti].raw : tr[ti].text, quote: tr[ti].quote || null, paths: tr[ti].paths || [] } : null;
  const it = tr[ti], h = core.getHistory();
  const k = droppedUsers + tr.slice(0, ti + (it.role === 'user' ? 0 : 1)).filter((x) => x.role === 'user').length - (it.role === 'user' ? 0 : 1);
  const r = turnRange(h, k);
  if (it.role === 'user') {
    if (r) h.splice(r[0], r[1] - r[0]);
    let e = ti + 1; while (e < tr.length && tr[e].role !== 'user') e++;
    tr.splice(ti, e - ti, ...(silent ? [] : [{ role: 'notice', text: '你撤回了一条消息', mid: 'm' + (++mseq) }]));   // silent：重新回答用，不留「撤回」那行
  } else if (it.role === 'ai') {
    if (r) { for (let i = r[1] - 1; i >= r[0]; i--) if (h[i].role === 'assistant' && String(h[i].content).trim() === String(it.text).trim()) { if (h[i].tool_calls) h[i].content = ''; else h.splice(i, 1); break; } }
    tr.splice(ti, 1, { role: 'notice', text: 'AI 的一条回复已撤回', mid: 'm' + (++mseq) });
  } else return false;
  core.setMessages(h); dirty = true; persist(); return back || true;
}
function deleteConv(id) {
  convs.delete(id); try { fs.unlinkSync(cfile(id)); } catch (e) {}
  if (cur && cur.id === id) newConv();
}
const stopAndWait = async () => { core.stop(); skipAsks(); for (const [id, p] of pending) { pending.delete(id); p.resolve(false); bc('confirm_done', { id, answered: '已拒绝' }); } for (let i = 0; i < 100 && busy; i++) await new Promise((r) => setTimeout(r, 100)); };
// 显卡实时状态：有界面连着才采样（gpumon.ps1 每 2 秒一行 JSON），界面都关了就停
let gpuProc = null, gpuBuf = '';
function gpuStart() {
  if (gpuProc) return;
  try {
    gpuProc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'gpumon.ps1')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    gpuProc.stdout.on('data', (d) => { gpuBuf += d; let i; while ((i = gpuBuf.indexOf('\n')) >= 0) { const l = gpuBuf.slice(0, i).trim(); gpuBuf = gpuBuf.slice(i + 1); try { bc('gpu', JSON.parse(l)); } catch (e) {} } });
    gpuProc.on('exit', () => { gpuProc = null; gpuBuf = ''; });
  } catch (e) { gpuProc = null; }
}
function gpuStop() { if (gpuProc) { try { gpuProc.kill(); } catch (e) {} gpuProc = null; } }
process.on('exit', gpuStop);
const notice = (text) => { push({ role: 'notice', text }); bc('notice', { text }); };
// 自动上线：不在聊天里留话，只在底部状态行显示「上线中…」，上线后自动消失（2026-10-07 用户：能不说的就不说）
function bootNotice() {
  core.imgUnloaded = false;
  const t = '上线中…'; wkLabel = t; bc('state', {});
  (async () => {
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const st = await pw.status();
      if (st.state === 'down' || st.state === 'on') break;
    }
  })().catch(() => {}).finally(() => { if (wkLabel === t) { wkLabel = ''; bc('state', {}); } });
}

let wkLabel = '';   // 界面底部「正在干什么」那行字：记在服务端，页面刷新后还能接上
function onEvent(type, d) {
  if (type === 'imgprogress') wkLabel = d.max ? `正在画图 第 ${d.value} / ${d.max} 步（${Math.round(d.value / d.max * 100)}%）` : (d.stage || '');
  else if (type === 'thinking') wkLabel = '正在思考';
  else if (type === 'tool') wkLabel = '正在执行：' + (d.name || '');
  else if (type === 'toolresult') wkLabel = d.name === 'generate_image' ? '图已画好，AI 正在写回复' : '正在读取结果并继续想';
  else if (type === 'token' || type === 'done' || type === 'stopped' || type === 'error') wkLabel = '';
  // 学习时中间步骤的字不上屏：用「第几轮 第几步 · 模型在写多少字」告诉界面它还在动，不是卡住（10-07 用户：学了 500 多秒看着卡在那）
  if (type === 'step' || type === 'quiet') {
    if (type === 'step') learn.step = d.step;
    wkLabel = `学习第 ${learn.round} 轮 · 第 ${learn.step || 1} 步 · ` + (type === 'quiet' ? `模型在写（${d.n} 字）` : '等模型回答');
    bc('wk', { label: wkLabel }); return;
  }
  // 学习时记下这一轮查了什么、存了什么：模型没写出汇报（超时 / 出错）时，用它替模型交代一句（10-07 用户：每轮要知道学了什么）
  if (type === 'tool' && learn.on && busy === '学习循环' && learn.did) {
    let a = d.args; if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { a = {}; } } a = a || {};
    if (d.name === 'web_search' && a.query) learn.did.q.add(String(a.query).slice(0, 30));
    if ((d.name === 'write_file' || d.name === 'edit_file') && a.path) learn.did.f.add(path.basename(String(a.path)));
  }
  // 10-08：记下这一轮联网查资料成没成，断网时不让一轮轮空转、也不把主题误判成「查不出新东西」
  if (type === 'toolresult' && learn.on && busy === '学习循环' && learn.did && (d.name === 'web_search' || d.name === 'fetch_url')) { if (/^错误/.test(String(d.text || ''))) learn.did.netErr++; else learn.did.netOk++; }
  if (type === 'fixlinks') { const ai = [...tr].reverse().find((x) => x.role === 'ai'); if (ai) for (const [a, b] of d.pairs || []) ai.text = ai.text.split(a).join(b); return; }
  if (type === 'dropped') { droppedUsers -= d.users || 0; return; }   // 核心为腾上下文丢掉了模型记忆里最早的几轮：界面第 i 条用户消息对应模型里第 i-N 条，所以减
  if (type === 'token') {
    let last = tr[tr.length - 1];
    if (!last || last.role !== 'ai' || last.done) { last = { role: 'ai', text: '' }; push(last); }
    last.text += d.text; bc('token', { ...d, mid: last.mid }); return;
  }
  const last = tr[tr.length - 1]; if (last && last.role === 'ai') last.done = true;
  if (type === 'tool') push({ role: 'tool', name: d.name, args: d.args });
  else if (type === 'toolresult') push({ role: 'result', name: d.name, text: d.text });
  else if (type === 'notice') push({ role: 'notice', text: d.text });
  else if (type === 'error') push({ role: 'notice', text: '出错: ' + d.text });
  else if (type === 'stopped') { if (learn.yielding) { learn.yielding = false; bc('done', {}); return; } push({ role: 'notice', text: '已急停。' }); }   // 学习让路（插话 / 游戏）：静默收尾，不留话
  else if (type === 'lead') { leadLog.push(d); if (leadLog.length > 400) leadLog.shift(); }
  if (type === 'done' || type === 'stopped' || type === 'error') persist();
  bc(type, d);
}

function ask(q, detail) {
  if (learn.on) {            // 学习循环：不弹确认，直接自动同意（用户 2026-10-06：学习时不要让我点任何确认）
    if (isRisky(detail)) { return Promise.resolve(false); }   // 自动同意不打扰（2026-10-07 用户要求）
    return Promise.resolve(true);
  }
  if (unattended) {          // 无人值守：只允许往 任务结果/草稿/线索 写文件，其余一律拒绝
    const okOne = (dt) => dt.kind === 'write' && ['任务结果', '草稿', '线索'].some((d) => path.resolve(dt.path).startsWith(path.join(core.WS, d) + path.sep));
    const ok = detail.kind === 'batch' ? (detail.items || []).every((x) => okOne(x.detail)) : okOne(detail);
    if (!ok) notice('已拒绝：' + q.split('\n')[0]);
    return Promise.resolve(ok);
  }
  if (!isRisky(detail)) return Promise.resolve(true);   // 10-07 用户定：只有删除和危险命令才弹确认，其余读写、改文件、普通命令、打开程序一律直接执行
  const id = ++cid;
  return new Promise((resolve) => {
    pending.set(id, { q, detail, resolve: (ok) => { resolve(ok); } });   // 2026-10-06 用户规则：确认不设超时，一直等
    push({ role: 'confirm', id, q, detail }); bc('confirm', { id, q, detail });
  });
}

function choose(questions) {
  if (learn.on || unattended) return Promise.resolve(null);   // 学习 / 无人值守时 AI 的提问直接跳过，不提示
  const id = ++cid;
  return new Promise((resolve) => {
    asks.set(id, { questions, resolve: (a) => { resolve(a); } });   // 2026-10-06 用户规则：提问不设超时，一直等
    push({ role: 'ask', id, questions }); bc('ask', { id, questions });
  });
}

const core = createCore(cfg, { ask, choose, emit: onEvent, revive: async () => { await ensureOllama(); } });
newConv();
const pw = power.make(cfg);
// 记「有人让 AI 下线过」：点按钮、对话里说下线、自动模式因游戏让出，都走 pw.off；上线或模型重新在显存里就清掉。界面显示据此只分在线 / 下线两种
let userOffline = false;
{ const _off = pw.off, _on = pw.on;
  // 底部「正在干什么」只写当前方向：上线时只显示「AI 上线中」，下线时才显示「AI 下线中」
  const lab = async (t, f) => { wkLabel = t; bc('state', {}); try { return await f(); } finally { if (wkLabel === t) wkLabel = ''; bc('state', {}); } };
  pw.off = (...a) => lab('AI 下线中…', async () => { const r = await _off(...a); if (r && r.ok) userOffline = true; return r; });
  pw.on = (...a) => lab('AI 上线中…', async () => { const r = await _on(...a); if (r && r.ok) userOffline = false; return r; }); }
const desk = desktop.install(core, cfg);
const imggen = require('./imagegen').install(core, cfg);
const auto = require('./auto').create({ cfg, pw, getBusy: () => busy, setBusy: (v) => { busy = v; bc('state', {}); }, notify: (t) => notice(t),
  notGameUrl: (name) => `http://127.0.0.1:${PORT}/api/notgame?name=${encodeURIComponent(name)}&t=${TOKEN}`,
  onEvent: (type, d) => {
    if (type === 'autooff') { bar = { id: ++cid, kind: 'autooff', name: d.name, text: `检测到 ${d.title ? `「${d.title}」(${d.name})` : d.name} 在运行，AI 已自动下线。` }; bc('bar', {}); }
    else if (type === 'autoon') { bar = null; bc('bar', {}); }
    bc('state', {});
  } });
// 每次启动：联网、桌面、思考、自动模式四个开关一律先打开（用户 2026-10-04 要求）
cfg.online = true; cfg.think = true; desk.set(true); auto.set(true);
const { execFileSync } = require('child_process');
// 游戏运行时用户想上线：不直接上线，页面上方出现「强制上线 / 取消」条
let bar = null;   // 页面上方的选择条：{ id, kind: 'force' | 'autooff', name, text, pendingText }
function offerForce(g, pendingText) {
  const shown = g.title ? `「${g.title}」(${g.name})` : g.name;
  const text = `检测到 ${shown} 在运行，上线会占用约 19GB 显存，可能影响游戏。`;
  bar = { id: ++cid, kind: 'force', name: g.name, text, pendingText: pendingText || '' };
  auto.keepOffline();
  notice('游戏运行中，AI 暂不上线，请在上方选择。');
  bc('bar', {}); bc('state', {});
}
// 助手关掉时让模型一起下线（模型是「一直在线」的，不然助手关了显存还被占着）
// 只起后台服务 serve：没有窗口、没有托盘图标，不会跳出来。
// 先找助手目录里自带的 Ollama，没有就用正常安装的那份（10-07 用户电脑上自带的不在，Ollama 一直起不来，只报 fetch failed）
const OLLAMA_EXE = [path.join(__dirname, '..', 'Ollama', 'ollama.exe'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe')].find((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || 'ollama';
const killOllama = () => { try { execFileSync('taskkill', ['/f', '/t', '/im', 'ollama app.exe', '/im', 'ollama.exe', '/im', 'llama-server.exe'], { stdio: 'ignore' }); } catch (e) {} };   // 模型跑在子进程 llama-server 里：只杀 ollama 它会变孤儿占着显存，下次加载挤不进显卡、慢到超时（10-05 实测占 5GB）
const ollamaUp = () => new Promise((ok) => { const r = require('http').get(cfg.ollama + '/api/version', (res) => { res.resume(); ok(true); }); r.on('error', () => ok(false)); r.setTimeout(1500, () => { r.destroy(); ok(false); }); });
async function ensureOllama() {   // 助手开 Ollama 跟着开，助手关 Ollama 跟着关
  if (await ollamaUp()) return;
  try { execFileSync('taskkill', ['/f', '/im', 'llama-server.exe'], { stdio: 'ignore' }); } catch (e) {}   // Ollama 没在跑，这时还在的 llama-server 都是上次留下的孤儿
  // flash attention + 8 位 KV 缓存：同样显存装两倍上下文（10-05 实测 128K 整个在显卡里，160K 放不下）
  // Ollama 自己的日志写到 logs\ollama.log（以前直接丢掉，模型卡住时查不到原因）；超过 20MB 先改名成 .old
  let olog = 'ignore';
  try { const lf = path.join(__dirname, '..', 'logs', 'ollama.log'); fs.mkdirSync(path.dirname(lf), { recursive: true }); try { if (fs.statSync(lf).size > 20e6) fs.renameSync(lf, lf + '.old'); } catch (e) {} olog = fs.openSync(lf, 'a'); } catch (e) {}
  try { spawn(OLLAMA_EXE, ['serve'], { stdio: ['ignore', olog, olog], windowsHide: true, env: { ...process.env, OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: 'q8_0' } }).on('error', (e) => bbS('Ollama 启动失败', e)).unref(); } catch (e) {}
  if (typeof olog === 'number') try { fs.closeSync(olog); } catch (e) {}   // 子进程有自己的一份句柄，这边关掉   // 找不到 exe 时 spawn 会异步报 error，不接住整个后台就崩了
  for (let i = 0; i < 40; i++) { if (await ollamaUp()) return; await new Promise((r) => setTimeout(r, 500)); }
  bbS('Ollama 20 秒内没起来，用的是', OLLAMA_EXE);
  notice('Ollama 启动不了，请手动打开。');
}
process.on('exit', () => { desk.close(); imggen.close(); auto.close(); try { execFileSync('curl.exe', ['--noproxy', '*', '-s', '-m', '5', '-d', '@-', cfg.ollama + '/api/generate'], { input: JSON.stringify({ model: cfg.model, keep_alive: 0 }), stdio: ['pipe', 'ignore', 'ignore'] }); } catch (e) {} killOllama(); });
for (const sg of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sg, () => { bbS('收到信号', sg); process.exit(0); });
// 10-05 黑匣子：后台怎么死的记下来（和外壳写同一个文件）
function bbS(...a) { try { fs.appendFileSync(path.join(__dirname, '..', 'logs', 'blackbox.log'), new Date().toLocaleString('zh-CN', { hour12: false }) + ' [后台 ' + process.pid + '] ' + a.map((x) => (x && x.stack) || x).join(' ') + '\n'); } catch (e) {} }
bbS('启动 父进程', process.ppid);
process.on('exit', (c) => bbS('后台进程结束 code', c));
process.on('uncaughtException', (e) => { bbS('未捕获错误，后台要崩', e); process.exit(1); });
process.on('unhandledRejection', (e) => { bbS('未处理的 Promise 错误，后台要崩', e); process.exit(1); });

// ---------- 动作 ----------
async function doSend(text, quote, att = {}) {
  // 附件：存到 工作区/收件/，路径告诉 AI；图片（已在浏览器里缩小）直接附给模型看
  const inbox = path.join(core.WS, '收件'), paths = [...(att.reuse || [])];   // reuse：重新回答时沿用上一次已经存好的附件，不再重存
  (att.files || []).forEach((f, i) => { try { fs.mkdirSync(inbox, { recursive: true }); const p = path.join(inbox, `${Date.now()}-${i}-${String(f.name || 'file').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(-120)}`); fs.writeFileSync(p, Buffer.from(String(f.b64 || ''), 'base64')); paths.push(p); } catch (e) {} });
  const imgs = [...(att.imgs || [])];
  for (const p of att.reuse || []) { try { if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(p) && fs.statSync(p).size < 4e6) imgs.push(fs.readFileSync(p).toString('base64')); } catch (e) {} }
  const shownText = text + (paths.length ? '\n📎 ' + paths.map((p) => path.basename(p).replace(/^\d+-\d+-/, '')).join('、') : '');
  const um = push({ role: 'user', text: shownText, raw: text, ...(paths.length ? { paths } : {}), ...(quote ? { quote } : {}) }); bc('user', { text: shownText, quote, mid: um.mid, ...(paths.length ? { paths } : {}) });
  let mtext = quote ? `（我引用了${quote.who === 'ai' ? '你（AI）' : '我'}之前说的这段话：“${quote.text}”）
${text}` : text;
  if (paths.length) {
    const unread = paths.filter((p) => !/\.(png|jpe?g|webp|gif|bmp)$/i.test(p));
    mtext += `\n（我附了 ${paths.length} 个文件，保存在：${paths.join('；')}。${imgs.length ? `其中 ${imgs.length} 张图片已经直接附在这条消息里，你可以直接看。` : ''}${unread.length ? `其余文件你还没有读过，回答前必须先用 read_file 读它们（${unread.join('；')}），不要凭文件名猜内容。` : ''}）`;
  }
  if (cur.title === '新对话') { cur.title = text.replace(/\s+/g, ' ').slice(0, 30); bc('state', {}); }
  const am = auto.detect(text);
  if (am) { auto.set(am === 'on'); notice(am === 'on' ? '自动模式已开。' : '自动模式已关。'); bc('state', {}); return; }
  if (busy === '重启中') { notice('重启中，稍后再发。'); return; }
  const act = pw.detect(text);
  busy = act ? 'AI 上线/下线' : '对话'; bc('state', {});
  try {
    if (act === 'on') { const g = auto.blocking(); if (g && (await pw.status()).state === 'off') { offerForce(g); return; } }
    if (act) { const r = act === 'off' ? await pw.off() : await pw.on(); notice(r.ok ? (act === 'off' ? '已下线。' : '已上线。') : r.text); if (r.ok) auto.manual(act); return; }
    unattended = false; allowAll = false; core.resetStop();
    // 学习循环口令：说"请学习/继续学"就一直学，直到说"停止学习"（2026-10-06 用户设定）
    if (isStopLearnCmd(text)) { if (learn.on) { stopLearn('你说"停止学习"'); } else notice('没在学习。'); return; }
    // 10-07：急停学习后只说「继续」，用户的意思是接着学，不是让 AI 接着聊
    const resume = !learn.on && learn.resumable && /^(继续|接着|接着来|继续吧|接着学|继续学)[。!！]?$/.test(String(text).trim());
    if (!learn.on && !isLearnCmd(text) && !resume) setResumable(false);   // 学习中插话不算放弃学习
    // 学习在等游戏关掉时说「继续」：不当成聊天，告诉用户在等什么
    if (learn.on && (isLearnCmd(text) || /^(继续|接着|接着来|继续吧|接着学|继续学)[。!！]?$/.test(String(text).trim()))) { notice(learn.paused ? `学习在等「${learn.paused}」关掉（它在占用显卡），关掉后自动接着学。` : '已在学习中。'); return; }
    if (isLearnCmd(text) || resume) {
      runLearnLoop(resume ? '继续学习' : mtext).catch((e) => { bbS('学习循环异常退出', e); notice('学习出错退出：' + e.message); }); return;   // 不接住的话一个意外错误就会让整个后台崩掉（unhandledRejection → exit）
    }
    const st0 = await pw.status();
    if (st0.state === 'down') await ensureOllama();   // 学习循环里本来就有这一步，普通聊天之前没有，急停后发「继续」就直接 fetch failed
    else if (st0.state === 'off') {
      const g = auto.blocking(); if (g) { offerForce(g, mtext); return; }
      bootNotice();
    }
    await core.turn(mtext, imgs.length ? { images: imgs } : {});
  } catch (e) { /* 错误已通过事件通知界面 */ }
  finally { if (busy === '对话') busy = null; allowAll = false; persist(); bc('state', {}); }
}

async function runLearnLoop(firstText) {
  learn.on = true; learn.stopped = false; learn.inbox = []; learn.yielding = false;
  learn.round = 0; learn.since = Date.now();
  saveLearn(true); setResumable(true);   // 学着学着关了窗口：重开后说「继续」就接着学
  busy = '学习循环'; bc('state', {});
  // 学习要占用 busy；用户插话、游戏让路时会临时让出，拿回来前等别的事做完
  const claim = async () => { while (learn.on && busy && busy !== '学习循环') await sleep(500); if (learn.on) { busy = '学习循环'; bc('state', {}); } };
  // 学到一半检测到游戏：不等这一轮学完，马上打断让出显存
  // 只认确定了的游戏（持续 6 秒以上）：显卡占用一闪而过（开网页、看视频）不再打断这一轮（10-07 第 5 轮查完 CRM 后被打断、之后看着像停了）
  const gameOn = () => { const a = auto.get(); return a.active && !a.forced; };
  const gameWatch = setInterval(() => { if (learn.on && busy === '学习循环' && !learn.yielding && gameOn()) { learn.yielding = '检测到游戏在运行，学习这一轮先停下，让出显存。'; bbS('学习第', learn.round, '轮让路给游戏', auto.get().game); core.stop(); } }, 3000);
  const pause = async (ms) => { for (let i = 0; i < ms / 100 && learn.on && !learn.inbox.length && !learn.yielding; i++) await sleep(100); };
  learn.netFail = 0;
  if (!cfg.online) notice('提醒：「联网」开关关着，学习查不了网上资料，只能整理已有的文件。要学新东西请打开联网。');
  core.setLean(true);   // 学习用小上下文 + 狠压缩，给显卡减负（换上下文大小时 Ollama 会重新载入一次模型，约 7 秒）
  try {
    if (core.ctxUsed() > core.ctxMax() * 0.5) { try { await core.compactNow(); } catch (e) {} }   // 开学前的聊天记录可能比学习用的小上下文还长：先压掉，别让第一轮就被 Ollama 截断
    let first = true, fails = 0, report = '';
    while (learn.on) {
      try {
        // 1. 用户在学习中发了消息：先回答，答完接着学（10-07 用户：不要有任何会打断学习的机制）
        if (learn.inbox.length) {
          const m = learn.inbox.shift(); learn.yielding = false;
          busy = null; bc('state', {});
          core.setLean(false);   // 回答用户用正常的上下文、系统提示和全部工具
          try { await doSend(m.text, m.quote, m.att); } finally { if (learn.on) core.setLean(true); }
          if (!learn.on) break;
          await claim();
          continue;
        }
        // 2. 自动模式检测到游戏：先让出显存（自动下线），游戏关了自动上线后接着学；用户点了「强制上线」就不让
        if (gameOn()) {
          learn.yielding = false; learn.paused = auto.get().title || auto.get().game;
          busy = null; bc('state', {});
          // 让路要说一声，不然界面看着就是学习停了（10-07 用户：跑到第 5 轮又停了）
          notice(`学习暂停：「${learn.paused}」在占用显卡（当成游戏了），它关掉后自动接着学。不是游戏的话，点系统通知里的「这不是游戏」。`);
          while (learn.on && gameOn()) await sleep(3000);
          learn.paused = '';
          bbS('游戏没了，学习接着来');
          if (!learn.on) break;
          await claim();
          continue;
        }
        // 3. Ollama 服务没了（崩了 / 被关了）：重新拉起来再学
        const st = await pw.status();
        if (st.state === 'down') await ensureOllama();
        else if (st.state === 'off') bootNotice();

        learn.round++; learn.step = 0; learn.did = { q: new Set(), f: new Set(), netErr: 0, netOk: 0 }; saveLearn(true);
        core.learnBegin();   // 10-08：这一轮学哪个主题（或复查哪篇笔记）由程序定，写进系统提示
        busySince = Date.now(); bc('state', {});   // 计时按每一轮算，不再从开始学习一直累加
        core.resetStop();
        // 上一轮出错（多半是一次写太长超时）：提醒它分段写，不然下一轮照样写同一大段、照样超时，一直原地重来（10-07 写英文话术那轮）
        const prompt = first ? firstText : LEARN_PROMPT() + (fails ? '（上一轮没做完就出错了：' + String(learn.lastErr || '').slice(0, 40) + '。这轮每次写文件不超过 1500 字，长的分段用 append=true 接着写。）' : '');
        if (!first) {   // 每轮从干净的上下文开始：上一轮的过程全丢掉，只留它最后那段进度汇报（学了什么、存在哪、下一轮学什么）
          const n = core.getHistory().filter(isRealUser).length;
          core.setMessages(report ? [{ role: 'system', summary: true, content: '上一轮学习的进度汇报：\n' + report.slice(0, 1500), archive: [] }] : []);
          if (n) onEvent('dropped', { users: n });
        }
        first = false;
        const before = core.getHistory();
        let failed = false;
        // 一轮最多 15 分钟（config 里 learnRoundMin 可改）：到点就收掉这一轮直接开下一轮，进度都在自学计划和知识库里，不会丢
        let overtime = false;
        const roundT = setTimeout(() => { if (learn.on && busy === '学习循环' && !learn.yielding) { overtime = true; learn.yielding = '本轮超时'; bbS('学习第', learn.round, '轮超过', cfg.learnRoundMin || 15, '分钟，收掉开下一轮'); core.stop(); } }, (cfg.learnRoundMin || 15) * 60000);
        let said = false;   // 10-08：没存笔记的那轮汇报（「下一轮接着学第 N 轮主题」）不带进下一轮，免得一轮轮照抄、原地打转
        try { const r = await core.turn(prompt, { loop: true, round: learn.round }); if (!overtime && r && r.trim()) { said = true; report = [...learn.did.f].some((x) => x !== '行业自学计划.md') ? r.trim() : ''; } fails = 0; } catch (e) { if (e.name !== 'StopError') { failed = true; fails++; learn.lastErr = e.message; } }
        finally { clearTimeout(roundT); }
        if (overtime) learn.yielding = false;
        const netDown = learn.did.netErr > 0 && !learn.did.netOk;   // 这一轮查资料全失败（多半断网 / 搜索挂了）
        learn.netFail = netDown ? (learn.netFail || 0) + 1 : learn.did.netOk ? 0 : (learn.netFail || 0);
        if ((said || overtime) && !netDown) {   // 正常学完的一轮才记进度、判主题学没学完；断网那轮不算（不然会被误判成「查不出新东西」收掉）
          let e = null; try { e = core.learnEnd(); } catch (er) { bbS('记学习进度出错', er); }
          if (e && e.fin) notice(`「${e.key}」学完了：${e.fin}（共 ${e.rounds} 轮${e.outline.n ? `，提纲 ${e.outline.done}/${e.outline.n}` : ''}）。`);
        }
        bbS('学习第', learn.round, '轮结束：', said ? '有汇报' : failed ? '出错 ' + learn.lastErr : overtime ? '超时' : learn.yielding ? '被打断（' + (learn.inbox.length ? '用户插话' : learn.yielding) + '）' : '没写汇报');
        if (!said && !failed && learn.on && !learn.inbox.length && (overtime || !learn.yielding)) {   // 这一轮没写出汇报：替它简短交代一句，让用户知道它在正常干活
          const q = [...learn.did.q].slice(0, 3), f = [...learn.did.f].slice(0, 3);
          notice(`第 ${learn.round} 轮 ${new Date().toTimeString().slice(0, 5)}｜` + (overtime ? '（超时收尾）' : '') + (q.length ? '查了「' + q.join('」「') + '」' : '没查到新资料') + (f.length ? '；存进 ' + f.join('、') : '；没存笔记'));
        }
        if (!learn.on) break;
        if (learn.inbox.length || learn.yielding) { learn.yielding = false; continue; }   // 被用户插话 / 游戏打断的这一轮不算出错，先去处理
        let waitMs = 2000;   // 本轮结束，等 2 秒喘口气再开下一轮（期间说"停止学习"或急停都能打断）
        if (failed) {
          // 出错的这一轮没有回答：把它留下的提示词撤掉，否则每次失败都多压一条，下一轮更慢、更容易再超时（10-06 连挂 21 轮就是这样）
          core.setMessages(before);
          if (fails >= 3) {   // 连续失败多半是上下文太长、模型处理不动：先压缩；压缩也失败就清空学习上下文（进度都在自学计划和知识库文件里，不会丢）
            let ok = false;
            try { ok = (await core.compactNow()) > 0; } catch (e) {}
            if (!ok) core.setMessages([]);
            notice('学习连续 3 次出错（' + learn.lastErr + '），已' + (ok ? '压缩' : '清空') + '上下文，继续学。');   // 只在连续 3 次出错时说一句，单次出错自动重试不提示
            fails = 0;
          }
          waitMs = Math.min(300000, 30000 * Math.max(1, fails));   // 等一会再试，给 Ollama 恢复的时间，别一出错就连环重试
          // 出错重来时界面那行要说清楚，别让人以为卡住了（10-07 用户：学到写英文话术那轮就"停住了"）
          wkLabel = `第 ${learn.round} 轮没做完（${String(learn.lastErr || '出错').slice(0, 30)}），${Math.round(waitMs / 1000)} 秒后重来`; bc('wk', { label: wkLabel });
        }
        else if (learn.netFail >= 3) {   // 连着 3 轮联网查资料全失败：别一轮轮空转，10 分钟后再试
          if (learn.netFail === 3) notice('学习连续 3 轮联网查资料都失败（可能断网了），先每 10 分钟试一次，网好了自动接着学。');
          waitMs = 600000;
          wkLabel = `联网查资料连续 ${learn.netFail} 轮失败，10 分钟后再试`; bc('wk', { label: wkLabel });
        }
        persist();
        await pause(waitMs);
      } catch (e) {   // 任何意外都不让循环结束：记下来，歇 1 分钟接着学
        bbS('学习循环意外出错', e);
        await pause(60000);
        if (learn.on && busy !== '学习循环') await claim();
      }
    }
  } finally {
    clearInterval(gameWatch);
    learn.on = false; learn.yielding = false; saveLearn(false); core.setLean(false);
    if (busy === '学习循环') busy = null;
    persist(); bc('state', {});
  }
}

async function runQueue(items) {
  busy = '任务队列'; unattended = true; queue.cancel = false; core.resetStop();
  const keep = core.getHistory();   // 队列每项从空白开始，跑完把当前对话的上下文还回去
  queue.items = items.map((t, i) => ({ id: i + 1, text: t, status: '等待' })); bc('queue', queue);
  const dir = path.join(core.WS, '任务结果'); fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    try {
    if ((await pw.status()).state === 'off') bootNotice();
    for (const it of queue.items) {
      if (queue.cancel) { it.status = '已取消'; continue; }
      it.status = '运行中'; bc('queue', queue); core.clear(); core.resetStop();
      try {
        const r = await core.turn('（无人值守任务：不能运行命令或删除文件；需要保存结果时写到「任务结果」文件夹里。）\n' + it.text);
        fs.writeFileSync(path.join(dir, `${stamp}-${it.id}.md`), `# 任务 ${it.id}\n\n${it.text}\n\n---\n\n${r || '(没有文字回复)'}\n`, 'utf8');
        it.status = queue.cancel ? '已停止' : '完成';
      } catch (e) { it.status = '出错'; }
      bc('queue', queue);
    }
  } finally { core.setMessages(keep); unattended = false; busy = null; notice('任务队列完成。'); bc('state', {}); bc('queue', queue); }
}

async function runLeads(opt) {
  busy = '线索挖掘'; unattended = false; core.resetStop(); leadLog.length = 0; bc('state', {});
  try {
    if ((await pw.status()).state === 'off') {
      onEvent('lead', { type: 'log', text: 'AI 当前下线，正在自动上线，约需 7 秒…' });
      const t0 = Date.now();
      (async () => {
        for (let i = 0; i < 80; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const st = await pw.status();
          if (st.state === 'down') return;
          if (st.state === 'on') { onEvent('lead', { type: 'log', text: 'AI 已上线（用了 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒），开始挖掘。' }); return; }
        }
      })().catch(() => {});
    }
    await leads.run(core, opt);
  } catch (e) { onEvent('lead', { type: 'log', text: e.name === 'StopError' ? '已急停。' : '出错: ' + e.message }); onEvent('lead', { type: 'end' }); }
  finally { busy = null; bc('state', {}); }
}

const SKIP_DIR = /^(_|\.|node_modules)$/;
function wsDirs() { try { return fs.readdirSync(core.WS, { withFileTypes: true }).filter((e) => e.isDirectory() && !SKIP_DIR.test(e.name)).map((e) => e.name); } catch (e) { return []; } }
function walkFiles(root, rel, depth, acc) {
  let ents; try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    if (e.name.startsWith('_') || e.name.startsWith('.') || e.name === 'node_modules') continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { if (depth > 0) walkFiles(root, r, depth - 1, acc); }
    else if (e.isFile()) { try { const st = fs.statSync(path.join(root, r)); acc.push({ name: r, size: st.size, mtime: st.mtimeMs }); } catch (x) {} }
  }
}
function listFiles() {
  const out = {};
  const names = wsDirs().sort((a, b) => a.localeCompare(b, 'zh'));
  for (const d of names) { const acc = []; walkFiles(path.join(core.WS, d), '', 2, acc); out[d] = acc.sort((a, b) => b.mtime - a.mtime).slice(0, 200); }
  return out;
}
const safeIn = (d, n) => { if (!d || !wsDirs().includes(d)) return null; const base = path.join(core.WS, d); const f = path.resolve(base, n || ''); return f === base || f.startsWith(base + path.sep) ? f : null; };
let fwT = null;
try { fs.watch(core.WS, { recursive: true }, () => { clearTimeout(fwT); fwT = setTimeout(() => bc('files', {}), 400); }); } catch (e) {}

async function state() {
  let st = await pw.status();
  // 画图时聊天模型让出显存只是 AI 内部换模型（画图模型和聊天模型同属一个 AI），界面不能因此显示「下线」；
  // 界面的在线只有两种：在线（AI 没被手动下线——不管此刻是聊天模型还是画图模型占着显存）和下线（手动下线 / 自动模式因游戏让出）。
  // 模型在显存里就是在线；不在显存里但没人下线过（画图换模型、Ollama 自己卸载），界面照样显示在线，真要用时自动载入
  if (st.state === 'on') userOffline = false;
  else if (st.state === 'off' && !userOffline) st = Object.assign({}, st, { state: 'on', swapped: true });
  return { cur: cur.id, curTitle: cur.title, ctxUsed: core.ctxUsed(), ctxMax: core.ctxMax(), cmp: (() => { const c = core.compacted(); return c ? { rounds: c.archive.filter((m) => m.role === 'user' && !String(m.content).startsWith('（这是刚才操作后的屏幕截图')).length, summary: c.summary } : null; })(), convs: [...convs.values()].filter((c) => c.id !== cur.id || hasUser()).sort((a, b) => b.updated - a.updated), online: cfg.online, think: cfg.think, desktop: desk.get(), auto: auto.get(), learn: { on: learn.on, round: learn.round }, bar: bar ? { id: bar.id, kind: bar.kind, name: bar.name, text: bar.text } : null, ai: st, busy, wkLabel: busy ? wkLabel : '', busySince: busy === busyKind ? busySince : Date.now(), ws: core.WS, kbDir: cfg.kbDir, queue, pending: [...pending.entries()].map(([id, p]) => ({ id, q: p.q, detail: p.detail })), asks: [...asks.entries()].map(([id, a]) => ({ id, questions: a.questions })), tr: tr.slice(-200), leadLog: leadLog.slice(-200) };
}

// ---------- HTTP ----------
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((res, rej) => { let b = ''; req.on('data', (d) => { b += d; if (b.length > 120e6) { req.destroy(); rej(new Error('too big')); } }); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); } }); });
const cookieOf = (req) => (/(?:^|;\s*)ait=([a-f0-9]+)/.exec(req.headers.cookie || '') || [])[1] || '';

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) { res.writeHead(403); return res.end('forbidden'); }   // 防 DNS 重绑定
    const url = new URL(req.url, 'http://' + host);
    if (req.method === 'GET' && url.pathname === '/api/notgame' && url.searchParams.get('t') === TOKEN) {
      const r = await auto.notGame(url.searchParams.get('name')); if (!r.ok) notice(r.text); if (bar && bar.name && bar.name.toLowerCase() === String(url.searchParams.get('name')).toLowerCase()) { bar = null; bc('bar', {}); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta charset="utf-8"><title>REIZE助手</title><body style="font:16px system-ui,'Microsoft YaHei UI';padding:40px;color:#18181b"><h2>${r.ok ? '已记住' : '没成功'}</h2><p>${String(r.text).replace(/[<>&]/g, '')}</p><p>可以关掉这个页面了。</p></body>`);
    }
    if (url.pathname === '/' && url.searchParams.get('t') === TOKEN) {
      res.writeHead(302, { 'Set-Cookie': `ait=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, Location: '/' }); return res.end();
    }
    if (cookieOf(req) !== TOKEN) { res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('请用启动程序打印出来的地址打开（带 ?t= 口令）。'); }
    if (req.method === 'POST') { const o = req.headers.origin; if (o && o !== 'http://' + host) { res.writeHead(403); return res.end('bad origin'); } }

    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(fs.readFileSync(path.join(__dirname, 'ui.html'))); }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await state());
    if (req.method === 'GET' && url.pathname === '/api/conv/search') {   // 搜历史对话：标题和正文都找
      const q = (url.searchParams.get('q') || '').trim().toLowerCase(); const ids = [];
      if (q) for (const c of convs.values()) { try { const j = cur && c.id === cur.id ? { tr } : JSON.parse(fs.readFileSync(cfile(c.id), 'utf8')); if ((j.tr || []).some((x) => (x.role === 'user' || x.role === 'ai') && String(x.text || '').toLowerCase().includes(q))) ids.push(c.id); } catch (e) {} }
      return json(res, 200, { ids });
    }
    // 10-07 只读查看：AI 忙的时候点历史对话，只把那个对话的记录读给界面看，不切换、不碰正在跑的任务
    if (req.method === 'GET' && url.pathname === '/api/conv/view') {
      const id = url.searchParams.get('id') || '';
      if (!/^c\d+$/.test(id) || !fs.existsSync(cfile(id))) return json(res, 404, { error: '没有这个对话' });
      try { const j = JSON.parse(fs.readFileSync(cfile(id), 'utf8')); return json(res, 200, { id: j.id, title: j.title, tr: (j.tr || []).slice(-400) }); }
      catch (e) { return json(res, 500, { error: '读不了这个对话：' + e.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': ok\n\n'); clients.add(res); gpuStart(); req.on('close', () => { clients.delete(res); if (!clients.size) gpuStop(); }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/img') {   // 只给工作区里的图片（画好的图、收件里的图），其它路径一律不给
      const p = path.resolve(String(url.searchParams.get('path') || '')), wsd = path.resolve(core.WS) + path.sep;
      const mt = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' }[path.extname(p).toLowerCase()];
      if (!mt || !p.toLowerCase().startsWith(wsd.toLowerCase()) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': mt, 'Cache-Control': 'private, max-age=3600' }); return fs.createReadStream(p).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/api/files') return json(res, 200, listFiles());
    if (req.method === 'GET' && url.pathname === '/api/imgmodels') return json(res, 200, imggen.models());
    if (req.method === 'GET' && url.pathname === '/api/file') {
      const d = url.searchParams.get('dir'), n = url.searchParams.get('name') || '';
      const f = n && safeIn(d, n); if (!f) return json(res, 400, { error: 'bad' });
      if (!fs.existsSync(f)) return json(res, 404, { error: 'no' });
      return json(res, 200, { name: n, text: fs.readFileSync(f, 'utf8').slice(0, 200000) });
    }

    if (req.method === 'POST') {
      const b = await readBody(req);
      if (url.pathname === '/api/send') {
        if (asks.size && !(b.files && b.files.length) && !(b.imgs && b.imgs.length) && String(b.text || '').trim()) {   // 有选择题在等：直接打字就当作回答，不打断 AI
          const t = String(b.text).trim().slice(0, 2000), id = [...asks.keys()][0];
          const um = push({ role: 'user', text: t, raw: t }); bc('user', { text: t, mid: um.mid });
          askDone(id, { __free: t }, { __free: t }); return json(res, 200, { ok: true });
        }
        if (busy === '对话') await stopAndWait();   // AI 还在回上一句：先打断它，再发这一句
        if (busy === '学习循环') {
          const t2 = String(b.text || '').trim();
          if (isStopLearnCmd(t2)) { const um = push({ role: 'user', text: t2, raw: t2 }); bc('user', { text: t2, mid: um.mid }); stopLearn('你说"停止学习"'); return json(res, 200, { ok: true }); }
          // 10-07：发别的消息不再停学习——学习循环先暂停这一轮、回答这条消息，答完自动接着学
        }
        if (busy && busy !== '学习循环') return json(res, 409, { error: busyMsg('发送新消息') });
        const files = Array.isArray(b.files) ? b.files.slice(0, 8).filter((f) => f && typeof f.b64 === 'string') : [];
        const imgs = Array.isArray(b.imgs) ? b.imgs.slice(0, 4).filter((x) => typeof x === 'string' && x.length < 12e6) : [];
        const text = String(b.text || '').trim() || (files.length ? '请看我附上的文件。' : ''); if (!text) return json(res, 400, { error: '空消息' });
        const q = b.quote && typeof b.quote.text === 'string' && b.quote.text.trim() ? { who: b.quote.who === 'ai' ? 'ai' : 'user', text: b.quote.text.trim().slice(0, 500) } : null;
        const inboxDir = path.join(core.WS, '收件') + path.sep;
        const reuse = Array.isArray(b.reuse) ? b.reuse.filter((p) => typeof p === 'string' && path.resolve(p).startsWith(inboxDir) && fs.existsSync(p)).slice(0, 8) : [];
        if (busy === '学习循环') {   // 交给学习循环：打断当前这一轮，先回答这条，再接着学
          learn.inbox.push({ text, quote: q, att: { files, imgs, reuse } }); learn.yielding = true;
          core.stop(); skipAsks(); return json(res, 200, { ok: true });
        }
        doSend(text, q, { files, imgs, reuse }); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/answer') {   // 选择题的回答：answers = { 问题: 答案 }；skip = 跳过
        const id = Number(b.id), a = asks.get(id); if (!a) return json(res, 404, { error: '这个问题已经过期了' });
        if (b.skip) { askDone(id, null, null); return json(res, 200, { ok: true }); }
        const ans = {}; for (const q of a.questions) { const v = b.answers && typeof b.answers[q.question] === 'string' ? b.answers[q.question].trim().slice(0, 2000) : ''; if (!v) return json(res, 400, { error: '还有问题没答：' + q.question }); ans[q.question] = v; }
        askDone(id, ans, ans); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/confirm') {
        const p = pending.get(Number(b.id)); if (!p) return json(res, 404, { error: '已过期' });
        pending.delete(Number(b.id)); p.resolve(!!b.ok);
        if (b.ok && b.all && !isRisky(p.detail)) { allowAll = true; for (const [id2, p2] of [...pending]) { if (isRisky(p2.detail)) continue; pending.delete(id2); p2.resolve(true); for (const it of tr) if (it.role === 'confirm' && it.id === id2) it.answered = '已同意'; bc('confirm_done', { id: id2, answered: '已同意' }); } }
        for (const it of tr) if (it.role === 'confirm' && it.id === Number(b.id)) it.answered = b.ok ? '已同意' : '已拒绝';
        bc('confirm_done', { id: Number(b.id), answered: b.ok ? '已同意' : '已拒绝' }); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/learn/stop') {
        if (learn.on) stopLearn('你点了「停止学习」');
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/restart') {
        if (busy) return json(res, 409, { error: busyMsg('重启') });
        busy = '重启中'; bc('state', {});
        notice('重启中…');
        setTimeout(() => process.exit(0), 1500);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/stop') {
        bbS('收到 STOP，当前 busy =', busy);
        if (learn.on) stopLearn('急停');
        queue.cancel = true; core.stop(); skipAsks();
        for (const [id, p] of pending) { pending.delete(id); p.resolve(false); bc('confirm_done', { id, answered: '已拒绝' }); }
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/imgmodel') { imggen.setModel(b); return json(res, 200, imggen.models()); }
      if (url.pathname === '/api/settings') {
        if (typeof b.online === 'boolean') cfg.online = b.online;
        if (typeof b.think === 'boolean') cfg.think = b.think;
        if (typeof b.auto === 'boolean') { auto.set(b.auto); }   // 开关本身看得到状态，不另外提示
        if (typeof b.desktop === 'boolean') desk.set(b.desktop);   // 开关本身在界面上看得到，不再往对话里插提示
        bc('state', {}); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/conv/new' || url.pathname === '/api/conv/open' || url.pathname === '/api/conv/delete') {
        const act = url.pathname.split('/').pop(), id = String(b.id || '');
        // 删的是别的对话（不是正在干活的这个）只动磁盘文件，不碰当前会话，忙的时候也放行；「打开」的就是当前对话等于什么都不做，也放行
        if (busy && !(act === 'delete' && cur && cur.id !== id) && !(act === 'open' && cur && cur.id === id)) return json(res, 409, { error: busyMsg(act === 'delete' ? '删除这个对话' : act === 'new' ? '新建对话' : '切换到别的对话') });
        if (act === 'new') { persist(); newConv(); }
        else if (!/^c\d+$/.test(id) || (!convs.has(id) && !(cur && cur.id === id))) return json(res, 404, { error: '没有这个对话' });
        else if (act === 'open') { if (cur.id !== id) openConv(id); }
        else deleteConv(id);
        bc('conv', {}); bc('state', {}); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/conv/rename') {
        const id = String(b.id || ''), title = String(b.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (!title || !/^c\d+$/.test(id)) return json(res, 400, { error: '标题不能为空' });
        if (cur && cur.id === id) { cur.title = title; dirty = true; persist(); bc('state', {}); return json(res, 200, { ok: true }); }
        const f = cfile(id); if (!fs.existsSync(f)) return json(res, 404, { error: '没有这个对话' });
        const j = JSON.parse(fs.readFileSync(f, 'utf8')); j.title = title; fs.writeFileSync(f + '.tmp', JSON.stringify(j)); fs.renameSync(f + '.tmp', f);
        if (convs.has(id)) convs.get(id).title = title; bc('state', {}); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/msg/recall' || url.pathname === '/api/msg/delete') {
        if (busy === '对话') await stopAndWait();
        if (busy) return json(res, 409, { error: busyMsg('撤回或删除消息') });
        const mid = String(b.mid || '');
        let back = null; if (url.pathname.endsWith('recall')) { back = recallMsg(mid, !!b.silent); if (!back) return json(res, 404, { error: '这条消息不能撤回' }); }
        else { const it = tr.find((x) => x.mid === mid); if (!it) return json(res, 404, { error: '没有这条消息' }); it.hidden = true; dirty = true; persist(); }
        bc('conv', {}); return json(res, 200, back && back.text != null ? { ok: true, back } : { ok: true });
      }
      // 左上角的上下文圈：左键手动压缩；右键菜单里查看 / 复制摘要
      if (url.pathname === '/api/compact') {
        if (busy) return json(res, 409, { error: busyMsg('压缩对话') });
        if (!hasUser()) return json(res, 400, { error: '这个对话还是空的，不用压缩。' });
        busy = '压缩对话'; bc('state', {});
        try { const n = await core.compactNow(); if (!n) return json(res, 400, { error: '只有一轮对话，没有可以压缩的内容。' }); dirty = true; persist(); return json(res, 200, { ok: true, n }); }
        catch (e) { return json(res, 500, { error: '压缩失败：' + e.message }); }
        finally { busy = null; bc('conv', {}); bc('state', {}); }
      }
      if (url.pathname === '/api/compact/view') {   // 开一个新对话：第一条是摘要，后面是被压掉的原话；AI 带着这份摘要，可以接着问
        if (busy) return json(res, 409, { error: busyMsg('打开压缩内容') });
        const c = core.compacted(); if (!c || !c.archive.length) return json(res, 400, { error: '这个对话还没有压缩过。' });
        const src = cur.title; persist(); newConv(); cur.title = '压缩内容：' + src;
        const plain = (s) => String(s || '').replace(/\n\n（系统提示：[\s\S]*$/, '');
        push({ role: 'notice', text: `【压缩内容 · ${src}】` });
        push({ role: 'ai', text: '**【压缩内容 · 摘要】**\n\n' + (c.summary || '（摘要没生成出来）'), done: true });
        push({ role: 'notice', text: '【原话】' });
        let users = 0;
        for (const m of c.archive) {
          if (m.role === 'user' && !String(m.content).startsWith('（这是刚才操作后的屏幕截图')) { const t = plain(m.content); push({ role: 'user', text: t, raw: t }); users++; }
          else if (m.role === 'assistant') { for (const k of m.tool_calls || []) push({ role: 'tool', name: k.function.name, args: k.function.arguments }); if (m.content) push({ role: 'ai', text: m.content, done: true }); }
          else if (m.role === 'tool') push({ role: 'result', name: m.tool_name, text: String(m.full || m.content).slice(0, 600) });
        }
        core.setMessages([{ role: 'system', summary: true, content: c.summary, archive: c.archive }]);
        droppedUsers = -users;   // 界面上的这些原话不在模型的对话里（在摘要的 archive 里），撤回编号要对齐
        push({ role: 'notice', text: '【以下为新对话】' });
        dirty = true; persist(); bc('conv', {}); bc('state', {}); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/clear') { if (busy) return json(res, 409, { error: busyMsg('清空对话') }); core.clear(); tr.length = 0; bc('cleared', {}); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/power') {
        if (busy) return json(res, 409, { error: busyMsg('切换上线/下线') });
        if (b.action !== 'off') { const g = auto.blocking(); if (g && (await pw.status()).state === 'off') { offerForce(g); return json(res, 200, { ok: false, blocked: true, text: `检测到 ${g.title || g.name} 在运行，AI 暂不上线（请选择强制上线、这不是游戏或取消）。` }); } }
        busy = 'AI 上线/下线'; bc('state', {});
        try { const r = b.action === 'off' ? await pw.off() : await pw.on(); if (!r.ok) notice(r.text); if (r.ok) auto.manual(b.action === 'off' ? 'off' : 'on'); return json(res, 200, r); }
        finally { busy = null; bc('state', {}); }
      }
      if (url.pathname === '/api/choice') {
        if (!bar || bar.id !== Number(b.id)) return json(res, 404, { error: '这个选择已过期' });
        const c = bar; bar = null; bc('bar', {}); bc('state', {});
        if (b.key === 'notgame') { const r = await auto.notGame(c.name); if (!r.ok) notice(r.text); return json(res, 200, r); }
        if (b.key === 'ack') return json(res, 200, { ok: true });
        if (b.key !== 'force') { return json(res, 200, { ok: true }); }
        if (busy) { notice(busyDoing() + '，稍后再试。'); return json(res, 409, { error: busyMsg('强制上线') }); }
        busy = 'AI 上线/下线'; bc('state', {});
        let r; try { r = await pw.on(); if (!r.ok) notice(r.text); if (r.ok) auto.forceOn(); } finally { busy = null; bc('state', {}); }
        json(res, 200, { ok: !!(r && r.ok) });
        if (r && r.ok && c.pendingText) { busy = '对话'; bc('state', {}); try { unattended = false; core.resetStop(); await core.turn(c.pendingText); } catch (e) {} finally { busy = null; bc('state', {}); } }
        return;
      }
      if (url.pathname === '/api/queue') {
        if (busy) return json(res, 409, { error: busyMsg('开始任务队列') });
        if ((await pw.status()).state === 'off' && auto.blocking()) return json(res, 409, { error: `检测到 ${auto.blocking().title || auto.blocking().name} 在运行，AI 下线中。先在对话页说「AI上线」并选「强制上线」，或等游戏关闭后再开始。` });
        const items = (b.items || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 50); if (!items.length) return json(res, 400, { error: '没有任务' });
        runQueue(items); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/leads') {
        if (busy) return json(res, 409, { error: busyMsg('开始线索挖掘') });
        if ((await pw.status()).state === 'off' && auto.blocking()) return json(res, 409, { error: `检测到 ${auto.blocking().title || auto.blocking().name} 在运行，AI 下线中。先在对话页说「AI上线」并选「强制上线」，或等游戏关闭后再开始。` });
        if (!cfg.online) return json(res, 400, { error: '线索挖掘需要联网，请先打开「联网」开关' });
        const country = String(b.country || '').trim(); if (!country) return json(res, 400, { error: '请填国家' });
        runLeads({ country, product: ['blown', 'bag', 'both'].includes(b.product) ? b.product : (String(b.product || '').trim().slice(0, 80) || 'both'), max: Math.min(Math.max(parseInt(b.max, 10) || 20, 1), 200), draft: b.draft !== false });
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/openfile') {
        const p = path.resolve(String(b.path || ''));
        if (!/^[A-Za-z]:\\/.test(p) || !fs.existsSync(p)) return json(res, 404, { error: '找不到这个文件' });
        const risky = /\.(exe|bat|cmd|com|scr|msi|ps1|vbs|vbe|js|jse|wsf|lnk|reg|hta|jar)$/i.test(p);
        const sel = risky || b.reveal === true;   // reveal：右键「在文件夹中显示」
        spawn('explorer.exe', sel ? ['/select,' + p] : [p], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true, selected: sel });
      }
      if (url.pathname === '/api/delfile') {   // 只能删工作区子文件夹里的单个文件，且进回收站，删错了能还原
        const names = Array.isArray(b.names) ? b.names : (b.name ? [b.name] : []);
        const fl = names.map((n) => safeIn(b.dir, String(n))).filter((x) => x && fs.existsSync(x) && fs.statSync(x).isFile());
        if (!fl.length) return json(res, 404, { error: '找不到这个文件' });
        const f = fl.join('|');
        try { require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-Command', "Add-Type -AssemblyName Microsoft.VisualBasic; $env:DELF.Split('|') | ForEach-Object { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($_,'OnlyErrorDialogs','SendToRecycleBin') }"], { env: Object.assign({}, process.env, { DELF: f }), stdio: 'ignore', timeout: 120000 }); } catch (e) { const left = fl.filter((x) => fs.existsSync(x)); if (left.length) return json(res, 500, { error: left.length + ' 个文件没删掉（可能正被别的程序占用）：' + left.map((x) => path.basename(x)).slice(0, 3).join('、') }); }
        bc('files', {}); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/open') {
        const p = safeIn(b.dir, ''); if (!p) return json(res, 400, { error: 'bad' });
        spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' }).unref(); return json(res, 200, { ok: true });
      }
    }
    res.writeHead(404); res.end('not found');
  } catch (e) { try { json(res, 500, { error: e.message }); } catch (e2) {} }
});

const openUi = (url) => { const edge = ['ProgramFiles(x86)', 'ProgramFiles'].map((k) => path.join(process.env[k] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find((p) => fs.existsSync(p)); (edge ? spawn(edge, ['--app=' + url], { detached: true, stdio: 'ignore' }) : spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })).unref(); };
setInterval(() => { for (const c of clients) { try { c.write(': hb\n\n'); } catch (e) {} } }, 20000);
server.listen(PORT, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${PORT}/?t=${TOKEN}`;
  await ensureOllama();
  const st = await pw.status();
  if (st.state === 'off') userOffline = true;   // 刚启动时模型不在显存里 = 下线；不记这个，界面会把「没人下线过」当成在线显示 ON
  console.log(`REIZE助手 网页界面已启动\n地址: ${url}\nAI: ${st.state === 'on' ? '在线' : st.state === 'off' ? '下线' : 'Ollama 服务没有运行'}   联网: ${cfg.online ? '开' : '关'}   自动模式: ${auto.get().on ? '开' : '关'}\n关闭这个窗口(模型会一起下线) = 停止助手。`);
  if (!process.argv.includes('--no-open')) openUi(url);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`助手已经在运行了，正在为你打开界面……`);
    if (!process.argv.includes('--no-open')) openUi(`http://127.0.0.1:${PORT}/?t=${TOKEN}`);
    return setTimeout(() => process.exit(0), 1500);
  }
  console.log('启动失败: ' + e.message); process.exit(1);
});
