const fs = require('fs');
const p = 'D:/ai网站/本地AI/agent/core.js';
let c = fs.readFileSync(p, 'utf8');
const oldStr = "emit('notice', { text: `已达到单次任务最大步数（${cfg.maxSteps}），停下来等你指示。` });";
const newStr = "emit('notice', { text: `已达到单次任务最大步数（${cfg.maxSteps}），本轮结束${opts.sub ? '，自动进入下一轮' : '，停下来等你指示'}。` });";
if (!c.includes(oldStr)) { console.log('NOT FOUND'); process.exit(1); }
c = c.replace(oldStr, newStr);
fs.writeFileSync(p, c);
console.log('core.js patched OK');
