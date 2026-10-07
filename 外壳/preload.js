// 只告诉页面「我在独立窗口里」，页面据此换成透明磨砂底、给右上角的窗口按钮让位。
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('reizeShell', true);
// 10-05 右上角三个窗口按钮由页面自己画
contextBridge.exposeInMainWorld('reizeWin', { act: (a) => ipcRenderer.send('win', a), onMax: (f) => ipcRenderer.on('win-max', (e, m) => f(!!m)) });
