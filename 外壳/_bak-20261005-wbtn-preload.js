// 只告诉页面「我在独立窗口里」，页面据此换成透明磨砂底、给右上角的窗口按钮让位。
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('reizeShell', true);
