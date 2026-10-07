// REIZE助手 独立窗口版：自己起 ../agent/server.js，在无边框磨砂窗口里打开，不走浏览器。窗口关掉，服务一起停。
// Electron 用 CRM 桌面版那份（启动脚本里指过去），这里不再重复装。
const { app, BrowserWindow, Menu, shell, screen } = require('electron');
const path = require('path'), fs = require('fs'), http = require('http'), { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const AGENT = path.join(ROOT, 'agent');
const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(AGENT, 'config.json'), 'utf8')); } catch { return {}; } })();
const PORT = cfg.port || 5200, BASE = `http://127.0.0.1:${PORT}`;
const STATE = path.join(__dirname, 'state.json');
let server = null, win = null;

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const ping = () => new Promise((ok) => { const r = http.get(BASE + '/', (res) => { res.resume(); ok(true); }); r.on('error', () => ok(false)); r.setTimeout(1500, () => { r.destroy(); ok(false); }); });
const token = () => { try { return fs.readFileSync(path.join(AGENT, '.token'), 'utf8').trim(); } catch { return ''; } };

async function startServer() {
  if (await ping()) return;                      // 助手已经开着（别的窗口），直接用，关窗时不去停它
  server = spawn('node', ['server.js', '--no-open'], { cwd: AGENT, windowsHide: true, stdio: 'ignore', shell: true });
  server.on('exit', () => { server = null; });
  for (let i = 0; i < 60; i++) { if (await ping() && token()) return; await new Promise((r) => setTimeout(r, 500)); }
  throw new Error('助手 30 秒内没起来');
}
function stopServer() {
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
    title: 'REIZE助手', icon: path.join(ROOT, '助手图标-v6.ico'), autoHideMenuBar: true,
    backgroundColor: '#00000000', backgroundMaterial: 'acrylic', roundedCorners: true,
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#ffffff', height: 48 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  });
  if (st.max) win.maximize();
  win.webContents.setWindowOpenHandler(({ url }) => { if (!url.startsWith(BASE)) { shell.openExternal(url); return { action: 'deny' }; } return { action: 'allow' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(BASE)) { e.preventDefault(); shell.openExternal(url); } });
  win.webContents.on('context-menu', (e, p) => {
    const f = p.editFlags, items = [];
    if (p.isEditable) items.push({ label: '剪切', role: 'cut', enabled: f.canCut }, { label: '复制', role: 'copy', enabled: f.canCopy }, { label: '粘贴', role: 'paste', enabled: f.canPaste }, { type: 'separator' }, { label: '全选', role: 'selectAll', enabled: f.canSelectAll });
    else if (p.selectionText) items.push({ label: '复制', role: 'copy' }, { label: '全选', role: 'selectAll' });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
  const save = () => { if (win.isDestroyed()) return; const b = win.getNormalBounds(); try { fs.writeFileSync(STATE, JSON.stringify({ ...b, max: win.isMaximized() })); } catch {} };
  win.on('close', save);
  win.on('closed', () => { win = null; });
  await win.loadURL(`${BASE}/?t=${token()}`);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    app.setAppUserModelId('com.reize.assistant');
    try { await startServer(); await createWindow(); }
    catch (e) { require('electron').dialog.showErrorBox('REIZE助手 起不来', String(e.message || e)); stopServer(); app.quit(); }
  });
  app.on('window-all-closed', () => { stopServer(); app.quit(); });
  app.on('before-quit', stopServer);
}
