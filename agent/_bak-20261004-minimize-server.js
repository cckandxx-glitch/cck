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
let busy = null;               // null | '对话' | '任务队列' | '线索挖掘' | 'AI 上线/下线'
const busyDoing = () => ({ '对话': 'AI 正在回复或画图', '任务队列': 'AI 正在跑任务队列', '线索挖掘': 'AI 正在挖掘线索', 'AI 上线/下线': 'AI 正在上线或下线' })[busy] || 'AI 正在工作';
const busyMsg = (what) => busyDoing() + '，现在不能' + what + '。等它做完，或点「急停」后再试。';
let unattended = false;
const queue = { items: [], cancel: false };
const pending = new Map(); let cid = 0;

const bc = (type, data) => { const s = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) { try { c.write(s); } catch (e) {} } };
let mseq = Date.now(), droppedUsers = 0;   // droppedUsers：被 400 条上限挤掉的用户消息数，用来对齐 tr 和模型上下文
const push = (it) => { it.mid = 'm' + (++mseq); tr.push(it); if (tr.length > 400) { const o = tr.shift(); if (o.role === 'user') droppedUsers++; } dirty = true; return it; };

// ---------- 多个对话：每个存成 对话/cXXXX.json，侧栏列出，可切换、可删除 ----------
const CONVDIR = path.join(__dirname, '..', '对话'); fs.mkdirSync(CONVDIR, { recursive: true });
const convs = new Map();       // id -> { id, title, updated }
let cur = null, dirty = false; // 当前对话 { id, title, created }
const cfile = (id) => path.join(CONVDIR, id + '.json');
const hasUser = () => tr.some((x) => x.role === 'user');
for (const n of fs.readdirSync(CONVDIR)) if (/^c\d+\.json$/.test(n)) { try { const j = JSON.parse(fs.readFileSync(path.join(CONVDIR, n), 'utf8')); convs.set(j.id, { id: j.id, title: j.title, updated: j.updated }); } catch (e) {} }
function persist() {
  if (!cur || !dirty || !hasUser()) return;
  const messages = core.getHistory().map((m) => { const c = { ...m }; delete c.images; return c; });
  const rec = { id: cur.id, title: cur.title, created: cur.created, updated: Date.now(), droppedUsers, tr, messages };
  const f = cfile(cur.id); fs.writeFileSync(f + '.tmp', JSON.stringify(rec)); fs.renameSync(f + '.tmp', f);
  convs.set(cur.id, { id: cur.id, title: cur.title, updated: rec.updated }); dirty = false;
}
function newConv() { cur = { id: 'c' + Date.now(), title: '新对话', created: Date.now() }; tr.length = 0; droppedUsers = 0; core.clear(); dirty = false; }
function openConv(id) {
  const j = JSON.parse(fs.readFileSync(cfile(id), 'utf8'));
  persist(); cur = { id: j.id, title: j.title, created: j.created };
  tr.length = 0; droppedUsers = j.droppedUsers || 0; for (const it of j.tr || []) { if (it.role === 'confirm' && !it.answered) it.answered = '已过期'; tr.push(it); }
  core.setMessages(j.messages || []); dirty = false;
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
const stopAndWait = async () => { core.stop(); for (const [id, p] of pending) { pending.delete(id); p.resolve(false); bc('confirm_done', { id, answered: '已拒绝' }); } for (let i = 0; i < 100 && busy; i++) await new Promise((r) => setTimeout(r, 100)); };
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
// 「正在自动上线」这行：模型真正上线后，原地改成「AI 已上线」（界面和历史记录都改）
function bootNotice() {
  const afterImg = core.imgUnloaded; core.imgUnloaded = false;
  const it = push({ role: 'notice', text: afterImg ? '刚才画图时聊天模型让出了显存，正在重新载入，约需 7 秒…' : userOffline ? 'AI 当前下线，正在自动上线，约需 7 秒…' : '聊天模型正在载入，约需 7 秒…' }); bc('notice', { text: it.text });
  const t0 = Date.now();
  (async () => {
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const st = await pw.status();
      if (st.state === 'down') return;
      if (st.state === 'on') { it.text = 'AI 已上线（用了 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒），开始回答。'; dirty = true; bc('noticeupd', { mid: it.mid, text: it.text }); return; }
    }
  })().catch(() => {});
}

function onEvent(type, d) {
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
  else if (type === 'stopped') push({ role: 'notice', text: '已急停。' });
  else if (type === 'lead') { leadLog.push(d); if (leadLog.length > 400) leadLog.shift(); }
  if (type === 'done' || type === 'stopped' || type === 'error') persist();
  bc(type, d);
}

function ask(q, detail) {
  if (unattended) {          // 无人值守：只允许往 任务结果/草稿/线索 写文件，其余一律拒绝
    const ok = detail.kind === 'write' && ['任务结果', '草稿', '线索'].some((d) => path.resolve(detail.path).startsWith(path.join(core.WS, d) + path.sep));
    notice((ok ? '无人值守，自动允许: ' : '无人值守，已拒绝: ') + q);
    return Promise.resolve(ok);
  }
  const id = ++cid;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { if (pending.delete(id)) { notice('确认超时(15 分钟)，已按拒绝处理: ' + q); bc('confirm_done', { id }); resolve(false); } }, 15 * 60 * 1000);
    pending.set(id, { q, detail, resolve: (ok) => { clearTimeout(timer); resolve(ok); } });
    push({ role: 'confirm', id, q, detail }); bc('confirm', { id, q, detail });
  });
}

const core = createCore(cfg, { ask, emit: onEvent });
newConv();
const pw = power.make(cfg);
// 记「有人让 AI 下线过」：点按钮、对话里说下线、自动模式因游戏让出，都走 pw.off；上线或模型重新在显存里就清掉。界面显示据此只分在线 / 下线两种
let userOffline = false;
{ const _off = pw.off, _on = pw.on;
  pw.off = async (...a) => { const r = await _off(...a); if (r && r.ok) userOffline = true; return r; };
  pw.on = async (...a) => { const r = await _on(...a); if (r && r.ok) userOffline = false; return r; }; }
const desk = desktop.install(core, cfg);
const imggen = require('./imagegen').install(core, cfg);
const auto = require('./auto').create({ cfg, pw, getBusy: () => busy, setBusy: (v) => { busy = v; bc('state', {}); }, notify: (t) => notice(t),
  notGameUrl: (name) => `http://127.0.0.1:${PORT}/api/notgame?name=${encodeURIComponent(name)}&t=${TOKEN}`,
  onEvent: (type, d) => {
    if (type === 'autooff') { bar = { id: ++cid, kind: 'autooff', name: d.name, text: `检测到 ${d.title ? `「${d.title}」(${d.name})` : d.name} 在运行，AI 已自动下线。` }; bc('bar', {}); }
    else if (type === 'autoon') { bar = null; bc('bar', {}); }
    bc('state', {});
  } });
const { execFileSync } = require('child_process');
// 游戏运行时用户想上线：不直接上线，页面上方出现「强制上线 / 取消」条
let bar = null;   // 页面上方的选择条：{ id, kind: 'force' | 'autooff', name, text, pendingText }
function offerForce(g, pendingText) {
  const shown = g.title ? `「${g.title}」(${g.name})` : g.name;
  const text = `检测到 ${shown} 在运行，上线会占用约 19GB 显存，可能影响游戏。`;
  bar = { id: ++cid, kind: 'force', name: g.name, text, pendingText: pendingText || '' };
  auto.keepOffline();
  notice(text + 'AI 暂时没有上线。请点页面上方的「强制上线」「这不是游戏」或「取消」；不点的话，游戏关闭后会自动上线。' + (pendingText ? '你刚才那句话会在强制上线后接着处理。' : ''));
  bc('bar', {}); bc('state', {});
}
// 助手关掉时让模型一起下线（模型是「一直在线」的，不然助手关了显存还被占着）
const OLLAMA_EXE = path.join(__dirname, '..', 'Ollama', 'ollama app.exe');   // 托盘版：只在任务栏托盘出图标，让用户看得出它开着；它自己会拉起 serve
const killOllama = () => { try { execFileSync('taskkill', ['/f', '/im', 'ollama app.exe', '/im', 'ollama.exe'], { stdio: 'ignore' }); } catch (e) {} };
const ollamaUp = () => new Promise((ok) => { const r = require('http').get(cfg.ollama + '/api/version', (res) => { res.resume(); ok(true); }); r.on('error', () => ok(false)); r.setTimeout(1500, () => { r.destroy(); ok(false); }); });
async function ensureOllama() {   // 助手开 Ollama 跟着开，助手关 Ollama 跟着关
  if (await ollamaUp()) return;
  try { spawn(OLLAMA_EXE, [], { stdio: 'ignore', windowsHide: true }).unref(); } catch (e) {}
  for (let i = 0; i < 40; i++) { if (await ollamaUp()) return; await new Promise((r) => setTimeout(r, 500)); }
}
process.on('exit', () => { desk.close(); imggen.close(); auto.close(); try { execFileSync('curl.exe', ['--noproxy', '*', '-s', '-m', '5', '-d', '@-', cfg.ollama + '/api/generate'], { input: JSON.stringify({ model: cfg.model, keep_alive: 0 }), stdio: ['pipe', 'ignore', 'ignore'] }); } catch (e) {} killOllama(); });
for (const sg of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sg, () => process.exit(0));

// ---------- 动作 ----------
async function doSend(text, quote, att = {}) {
  // 附件：存到 工作区/收件/，路径告诉 AI；图片（已在浏览器里缩小）直接附给模型看
  const inbox = path.join(core.WS, '收件'), paths = [...(att.reuse || [])];   // reuse：重新回答时沿用上一次已经存好的附件，不再重存
  (att.files || []).forEach((f, i) => { try { fs.mkdirSync(inbox, { recursive: true }); const p = path.join(inbox, `${Date.now()}-${i}-${String(f.name || 'file').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(-120)}`); fs.writeFileSync(p, Buffer.from(String(f.b64 || ''), 'base64')); paths.push(p); } catch (e) {} });
  const imgs = [...(att.imgs || [])];
  for (const p of att.reuse || []) { try { if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(p) && fs.statSync(p).size < 4e6) imgs.push(fs.readFileSync(p).toString('base64')); } catch (e) {} }
  const shownText = text + (paths.length ? '\n📎 ' + paths.map((p) => path.basename(p).replace(/^\d+-\d+-/, '')).join('、') : '');
  const um = push({ role: 'user', text: shownText, raw: text, ...(paths.length ? { paths } : {}), ...(quote ? { quote } : {}) }); bc('user', { text: shownText, quote, mid: um.mid });
  let mtext = quote ? `（我引用了${quote.who === 'ai' ? '你（AI）' : '我'}之前说的这段话：“${quote.text}”）
${text}` : text;
  if (paths.length) {
    const unread = paths.filter((p) => !/\.(png|jpe?g|webp|gif|bmp)$/i.test(p));
    mtext += `\n（我附了 ${paths.length} 个文件，保存在：${paths.join('；')}。${imgs.length ? `其中 ${imgs.length} 张图片已经直接附在这条消息里，你可以直接看。` : ''}${unread.length ? `其余文件你还没有读过，回答前必须先用 read_file 读它们（${unread.join('；')}），不要凭文件名猜内容。` : ''}）`;
  }
  if (cur.title === '新对话') { cur.title = text.replace(/\s+/g, ' ').slice(0, 30); bc('state', {}); }
  const am = auto.detect(text);
  if (am) { auto.set(am === 'on'); notice(am === 'on' ? '自动模式已打开：检测到游戏时 AI 自动下线，游戏关闭后自动上线。' : '自动模式已关闭：AI 不会再自动上线/下线，需要时请自己点按钮。'); bc('state', {}); return; }
  const act = pw.detect(text);
  busy = act ? 'AI 上线/下线' : '对话'; bc('state', {});
  try {
    if (act === 'on') { const g = auto.blocking(); if (g && (await pw.status()).state === 'off') { offerForce(g); return; } }
    if (act) { const r = act === 'off' ? await pw.off() : await pw.on(); notice(r.text); if (r.ok) auto.manual(act); return; }
    unattended = false; core.resetStop();
    if ((await pw.status()).state === 'off') {
      const g = auto.blocking(); if (g) { offerForce(g, mtext); return; }
      bootNotice();
    }
    await core.turn(mtext, imgs.length ? { images: imgs } : {});
  } catch (e) { /* 错误已通过事件通知界面 */ }
  finally { busy = null; persist(); bc('state', {}); }
}

async function runQueue(items) {
  busy = '任务队列'; unattended = true; queue.cancel = false; core.resetStop();
  const keep = core.getHistory();   // 队列每项从空白开始，跑完把当前对话的上下文还回去
  queue.items = items.map((t, i) => ({ id: i + 1, text: t, status: '等待' })); bc('queue', queue);
  const dir = path.join(core.WS, '任务结果'); fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  notice('任务队列开始，共 ' + items.length + ' 项。无人值守：只允许写入「任务结果 / 草稿 / 线索」文件夹，不运行命令、不删除。');
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
  } finally { core.setMessages(keep); unattended = false; busy = null; notice('任务队列结束。结果在「文件」页的「任务结果」里。'); bc('state', {}); bc('queue', queue); }
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

const DIRS = ['线索', '草稿', '任务结果'];
function listFiles() {
  const out = {};
  for (const d of DIRS) {
    const p = path.join(core.WS, d);
    out[d] = fs.existsSync(p) ? fs.readdirSync(p).filter((n) => fs.statSync(path.join(p, n)).isFile()).map((n) => { const s = fs.statSync(path.join(p, n)); return { name: n, size: s.size, mtime: s.mtimeMs }; }).sort((a, b) => b.mtime - a.mtime).slice(0, 200) : [];
  }
  return out;
}

async function state() {
  let st = await pw.status();
  // 画图时聊天模型让出显存只是 AI 内部换模型（画图模型和聊天模型同属一个 AI），界面不能因此显示「下线」；
  // 界面的在线只有两种：在线（AI 没被手动下线——不管此刻是聊天模型还是画图模型占着显存）和下线（手动下线 / 自动模式因游戏让出）。
  // 模型在显存里就是在线；不在显存里但没人下线过（画图换模型、Ollama 自己卸载），界面照样显示在线，真要用时自动载入
  if (st.state === 'on') userOffline = false;
  else if (st.state === 'off' && !userOffline) st = Object.assign({}, st, { state: 'on', swapped: true });
  return { cur: cur.id, curTitle: cur.title, convs: [...convs.values()].filter((c) => c.id !== cur.id || hasUser()).sort((a, b) => b.updated - a.updated), online: cfg.online, think: cfg.think, desktop: desk.get(), auto: auto.get(), bar: bar ? { id: bar.id, kind: bar.kind, name: bar.name, text: bar.text } : null, ai: st, busy, busySince: busy === busyKind ? busySince : Date.now(), ws: core.WS, kbDir: cfg.kbDir, queue, pending: [...pending.entries()].map(([id, p]) => ({ id, q: p.q, detail: p.detail })), tr: tr.slice(-200), leadLog: leadLog.slice(-200) };
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
      const r = await auto.notGame(url.searchParams.get('name')); notice(r.text); if (bar && bar.name && bar.name.toLowerCase() === String(url.searchParams.get('name')).toLowerCase()) { bar = null; bc('bar', {}); }
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
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': ok\n\n'); clients.add(res); gpuStart(); req.on('close', () => { clients.delete(res); if (!clients.size) gpuStop(); }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/files') return json(res, 200, listFiles());
    if (req.method === 'GET' && url.pathname === '/api/imgmodels') return json(res, 200, imggen.models());
    if (req.method === 'GET' && url.pathname === '/api/file') {
      const d = url.searchParams.get('dir'), n = path.basename(url.searchParams.get('name') || '');
      if (!DIRS.includes(d) || !n) return json(res, 400, { error: 'bad' });
      const f = path.join(core.WS, d, n); if (!fs.existsSync(f)) return json(res, 404, { error: 'no' });
      return json(res, 200, { name: n, text: fs.readFileSync(f, 'utf8').slice(0, 200000) });
    }

    if (req.method === 'POST') {
      const b = await readBody(req);
      if (url.pathname === '/api/send') {
        if (busy === '对话') await stopAndWait();   // AI 还在回上一句：先打断它，再发这一句
        if (busy) return json(res, 409, { error: busyMsg('发送新消息') });
        const files = Array.isArray(b.files) ? b.files.slice(0, 8).filter((f) => f && typeof f.b64 === 'string') : [];
        const imgs = Array.isArray(b.imgs) ? b.imgs.slice(0, 4).filter((x) => typeof x === 'string' && x.length < 12e6) : [];
        const text = String(b.text || '').trim() || (files.length ? '请看我附上的文件。' : ''); if (!text) return json(res, 400, { error: '空消息' });
        const q = b.quote && typeof b.quote.text === 'string' && b.quote.text.trim() ? { who: b.quote.who === 'ai' ? 'ai' : 'user', text: b.quote.text.trim().slice(0, 500) } : null;
        const inboxDir = path.join(core.WS, '收件') + path.sep;
        const reuse = Array.isArray(b.reuse) ? b.reuse.filter((p) => typeof p === 'string' && path.resolve(p).startsWith(inboxDir) && fs.existsSync(p)).slice(0, 8) : [];
        doSend(text, q, { files, imgs, reuse }); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/confirm') {
        const p = pending.get(Number(b.id)); if (!p) return json(res, 404, { error: '已过期' });
        pending.delete(Number(b.id)); p.resolve(!!b.ok);
        for (const it of tr) if (it.role === 'confirm' && it.id === Number(b.id)) it.answered = b.ok ? '已同意' : '已拒绝';
        bc('confirm_done', { id: Number(b.id), answered: b.ok ? '已同意' : '已拒绝' }); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/stop') {
        queue.cancel = true; core.stop();
        for (const [id, p] of pending) { pending.delete(id); p.resolve(false); bc('confirm_done', { id, answered: '已拒绝' }); }
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/imgmodel') { imggen.setModel(b); return json(res, 200, imggen.models()); }
      if (url.pathname === '/api/settings') {
        if (typeof b.online === 'boolean') cfg.online = b.online;
        if (typeof b.think === 'boolean') cfg.think = b.think;
        if (typeof b.auto === 'boolean') { auto.set(b.auto); notice(b.auto ? '自动模式已打开：检测到游戏时 AI 自动下线，游戏关闭后自动上线。' : '自动模式已关闭：AI 不会再自动上线/下线，需要时请自己点按钮。'); }
        if (typeof b.desktop === 'boolean') desk.set(b.desktop);   // 开关本身在界面上看得到，不再往对话里插提示
        bc('state', {}); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/conv/new' || url.pathname === '/api/conv/open' || url.pathname === '/api/conv/delete') {
        const act = url.pathname.split('/').pop(), id = String(b.id || '');
        // 删的是别的对话（不是正在干活的这个）只动磁盘文件，不碰当前会话，忙的时候也放行
        if (busy && !(act === 'delete' && cur && cur.id !== id)) return json(res, 409, { error: busyMsg(act === 'delete' ? '删除这个对话' : act === 'new' ? '新建对话' : '切换到别的对话') });
        if (act === 'new') { persist(); newConv(); }
        else if (!/^c\d+$/.test(id) || (!convs.has(id) && !(cur && cur.id === id))) return json(res, 404, { error: '没有这个对话' });
        else if (act === 'open') { if (cur.id !== id) openConv(id); }
        else deleteConv(id);
        bc('conv', {}); bc('state', {}); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/msg/recall' || url.pathname === '/api/msg/delete') {
        if (busy === '对话') await stopAndWait();
        if (busy) return json(res, 409, { error: busyMsg('撤回或删除消息') });
        const mid = String(b.mid || '');
        let back = null; if (url.pathname.endsWith('recall')) { back = recallMsg(mid, !!b.silent); if (!back) return json(res, 404, { error: '这条消息不能撤回' }); }
        else { const it = tr.find((x) => x.mid === mid); if (!it) return json(res, 404, { error: '没有这条消息' }); it.hidden = true; dirty = true; persist(); }
        bc('conv', {}); return json(res, 200, back && back.text != null ? { ok: true, back } : { ok: true });
      }
      if (url.pathname === '/api/clear') { if (busy) return json(res, 409, { error: busyMsg('清空对话') }); core.clear(); tr.length = 0; bc('cleared', {}); return json(res, 200, { ok: true }); }
      if (url.pathname === '/api/power') {
        if (busy) return json(res, 409, { error: busyMsg('切换上线/下线') });
        if (b.action !== 'off') { const g = auto.blocking(); if (g && (await pw.status()).state === 'off') { offerForce(g); return json(res, 200, { ok: false, blocked: true, text: `检测到 ${g.title || g.name} 在运行，AI 暂不上线（请选择强制上线、这不是游戏或取消）。` }); } }
        busy = 'AI 上线/下线'; bc('state', {});
        try { const r = b.action === 'off' ? await pw.off() : await pw.on(); notice(r.text); if (r.ok) auto.manual(b.action === 'off' ? 'off' : 'on'); return json(res, 200, r); }
        finally { busy = null; bc('state', {}); }
      }
      if (url.pathname === '/api/choice') {
        if (!bar || bar.id !== Number(b.id)) return json(res, 404, { error: '这个选择已过期' });
        const c = bar; bar = null; bc('bar', {}); bc('state', {});
        if (b.key === 'notgame') { const r = await auto.notGame(c.name); notice(r.text); return json(res, 200, r); }
        if (b.key === 'ack') return json(res, 200, { ok: true });
        if (b.key !== 'force') { notice('已取消，AI 保持下线。游戏关闭后会自动上线。'); return json(res, 200, { ok: true }); }
        if (busy) { notice(busyDoing() + '，请稍后再点强制上线。'); return json(res, 409, { error: busyMsg('强制上线') }); }
        busy = 'AI 上线/下线'; bc('state', {});
        let r; try { r = await pw.on(); notice(r.ok ? '已强制上线（游戏期间不再自动下线，游戏关闭后恢复自动模式）。' + r.text : r.text); if (r.ok) auto.forceOn(); } finally { busy = null; bc('state', {}); }
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
        runLeads({ country, product: ['blown', 'bag', 'both'].includes(b.product) ? b.product : 'both', max: Math.min(Math.max(parseInt(b.max, 10) || 20, 1), 200), draft: b.draft !== false });
        return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/openfile') {
        const p = path.resolve(String(b.path || ''));
        if (!/^[A-Za-z]:\\/.test(p) || !fs.existsSync(p)) return json(res, 404, { error: '找不到这个文件' });
        const risky = /\.(exe|bat|cmd|com|scr|msi|ps1|vbs|vbe|js|jse|wsf|lnk|reg|hta|jar)$/i.test(p);
        spawn('explorer.exe', risky ? ['/select,' + p] : [p], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true, selected: risky });
      }
      if (url.pathname === '/api/open') {
        if (!DIRS.includes(b.dir)) return json(res, 400, { error: 'bad' });
        const p = path.join(core.WS, b.dir); fs.mkdirSync(p, { recursive: true });
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
