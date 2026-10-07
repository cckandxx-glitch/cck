// REIZE助手 独立窗口版：自己起 ../agent/server.js，在无边框磨砂窗口里打开，不走浏览器。窗口关掉，服务一起停。
// Electron 用 CRM 桌面版那份（启动脚本里指过去），这里不再重复装。
const { app, BrowserWindow, Menu, shell, screen, ipcMain } = require('electron');
const path = require('path'), fs = require('fs'), http = require('http'), { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const AGENT = path.join(ROOT, 'agent');
const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(AGENT, 'config.json'), 'utf8')); } catch { return {}; } })();
const PORT = cfg.port || 5200, BASE = `http://127.0.0.1:${PORT}`;
const STATE = path.join(__dirname, 'state.json');
let server = null, win = null;
// 10-05 黑匣子：窗口莫名关掉/重开查不到原因，开关窗的每一步都记一行
const BB = path.join(ROOT, 'logs', 'blackbox.log');
const bb = (...a) => { try { fs.appendFileSync(BB, new Date().toLocaleString('zh-CN', { hour12: false }) + ' [外壳 ' + process.pid + '] ' + a.join(' ') + '\n'); } catch {} };
bb('启动 父进程', process.ppid, '参数', JSON.stringify(process.argv.slice(1)));
try { const { execFile } = require('child_process'); execFile('powershell.exe', ['-NoProfile', '-Command', '$p=Get-CimInstance Win32_Process -Filter "ProcessId=' + process.ppid + '"; if($p){$g=Get-CimInstance Win32_Process -Filter ("ProcessId="+$p.ParentProcessId); $p.Name+" | "+$p.CommandLine+" || 祖父: "+$(if($g){$g.Name+" | "+$g.CommandLine}else{"已退出"})}else{"父进程已退出"}'], { windowsHide: true, timeout: 15000 }, (e, out) => bb('父进程是', String(out || (e && e.message) || '').trim())); } catch {}
process.on('uncaughtException', (e) => bb('外壳出错', e && e.stack || e));

// 10-05 用户要求：网页链接一律用火狐打开（Chrome 过不了领英的验证）；火狐不在就退回系统默认浏览器
const FIREFOX = ['C:\\Program Files\\Mozilla Firefox\\firefox.exe', 'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe'].find((p) => fs.existsSync(p));
const openOut = (url) => {
  if (FIREFOX && /^https?:\/\//i.test(url)) { try { spawn(FIREFOX, ['-new-tab', url], { detached: true, stdio: 'ignore' }).unref(); return; } catch {} }
  shell.openExternal(url);
};
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const ping = () => new Promise((ok) => { const r = http.get(BASE + '/', (res) => { res.resume(); ok(true); }); r.on('error', () => ok(false)); r.setTimeout(1500, () => { r.destroy(); ok(false); }); });
const token = () => { try { return fs.readFileSync(path.join(AGENT, '.token'), 'utf8').trim(); } catch { return ''; } };

async function startServer() {
  if (await ping()) { bb('后台已经开着，直接用'); return; }                      // 助手已经开着（别的窗口），直接用，关窗时不去停它
  server = spawn('node', ['server.js', '--no-open'], { cwd: AGENT, windowsHide: true, stdio: 'ignore', shell: true });
  bb('起后台 pid', server.pid);
  server.on('exit', (code, sig) => { bb('后台退出 code', code, 'signal', sig); server = null; });
  for (let i = 0; i < 60; i++) { if (await ping() && token()) return; await new Promise((r) => setTimeout(r, 500)); }
  throw new Error('助手 30 秒内没起来');
}
function stopServer() {
  bb('stopServer 调用', server ? '后台 pid ' + server.pid : '(后台不归我管/已没了)', new Error().stack.split('\n').slice(2, 4).join(' <- ').trim());
  if (!server) return;
  try { spawn('taskkill', ['/pid', String(server.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  try { spawn('taskkill', ['/f', '/im', 'ollama app.exe', '/im', 'ollama.exe'], { windowsHide: true, stdio: 'ignore' }); } catch {}   // Ollama 跟着一起关
  server = null;
}

async function createWindow() {
  const st = readState();
  // 上次的位置落在屏幕外（换过显示器/缩放）就居中，别让窗口跑出去
  const wa = screen.getPrimaryDisplay().workArea;
  const w = Math.min(st.width || 1100, wa.width), hh = Math.min(st.height || 760, wa.height);
  let pos = {};
  if (st.x != null && st.y != null) { const d = screen.getDisplayMatching({ x: st.x, y: st.y, width: w, height: hh }).workArea; if (st.x >= d.x && st.y >= d.y && st.x + w <= d.x + d.width && st.y + hh <= d.y + d.height) pos = { x: st.x, y: st.y }; }
  win = new BrowserWindow({
    width: w, height: hh, ...pos, minWidth: 640, minHeight: 480,
    title: 'REIZE助手', icon: path.join(ROOT, '助手图标-v7.ico'), autoHideMenuBar: true,
    backgroundColor: '#00000000', backgroundMaterial: 'acrylic', roundedCorners: true,
    titleBarStyle: 'hidden',   // 10-05 最小化/最大化/关闭改由页面自己画（系统那套悬停灰底太淡）
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  if (st.max) win.maximize();
  win.webContents.setWindowOpenHandler(({ url }) => { if (!url.startsWith(BASE)) { openOut(url); return { action: 'deny' }; } return { action: 'allow' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(BASE)) { e.preventDefault(); openOut(url); } });
  win.webContents.on('context-menu', (e, p) => {
    const f = p.editFlags, items = [];
    if (p.isEditable) items.push({ label: '剪切', role: 'cut', enabled: f.canCut }, { label: '复制', role: 'copy', enabled: f.canCopy }, { label: '粘贴', role: 'paste', enabled: f.canPaste }, { type: 'separator' }, { label: '全选', role: 'selectAll', enabled: f.canSelectAll });
    else if (p.selectionText) items.push({ label: '复制', role: 'copy' }, { label: '全选', role: 'selectAll' });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
  const save = () => { if (win.isDestroyed()) return; const b = win.getNormalBounds(); try { fs.writeFileSync(STATE, JSON.stringify({ ...b, max: win.isMaximized() })); } catch {} };
  const sendMax = () => { if (!win.isDestroyed()) win.webContents.send('win-max', win.isMaximized()); };
  win.on('maximize', sendMax); win.on('unmaximize', sendMax); win.webContents.on('did-finish-load', sendMax);
  win.on('close', save); win.on('close', () => bb('窗口 close 事件'));
  win.webContents.on('render-process-gone', (e, d) => bb('页面进程没了', JSON.stringify(d)));
  win.webContents.on('unresponsive', () => bb('页面无响应')); win.webContents.on('responsive', () => bb('页面恢复响应'));
  win.webContents.on('did-fail-load', (e, c, d) => bb('页面加载失败', c, d));
  win.webContents.on('did-start-loading', () => bb('页面开始加载(刷新)'));
  app.on('session-end', () => bb('Windows 注销/关机'));
  win.on('closed', () => { win = null; });
  await win.loadURL(`${BASE}/?t=${token()}`);
}

if (!app.requestSingleInstanceLock()) { bb('已有一个在运行，这个退出'); app.quit(); }
else {
  app.on('second-instance', (ev, argv) => { bb('又被启动了一次(第二实例)', JSON.stringify(argv.slice(1))); if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  ipcMain.on('win', (e, a) => { const w = BrowserWindow.fromWebContents(e.sender); if (!w) return; bb('窗口按钮', a); if (a === 'min') w.minimize(); else if (a === 'max') w.isMaximized() ? w.unmaximize() : w.maximize(); else if (a === 'close') w.close(); });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    app.setAppUserModelId('com.reize.assistant');
    try { await startServer(); await createWindow(); }
    catch (e) { bb('起不来', e && e.message); require('electron').dialog.showErrorBox('REIZE助手 起不来', String(e.message || e)); stopServer(); app.quit(); }
  });
  app.on('window-all-closed', () => { bb('所有窗口已关，退出'); stopServer(); app.quit(); });
  app.on('before-quit', () => { bb('before-quit'); stopServer(); });
  app.on('child-process-gone', (e, d) => bb('子进程没了', JSON.stringify(d)));
  process.on('exit', (c) => bb('外壳进程结束 code', c));
}
