const fs = require('fs');
const p = 'D:/ai网站/本地AI/agent/ui.html';
let c = fs.readFileSync(p, 'utf8');
let n = 0;
function rep(oldStr, newStr) {
  if (!c.includes(oldStr)) { console.log('NOT FOUND:', JSON.stringify(oldStr.slice(0, 80))); process.exit(1); }
  c = c.replace(oldStr, newStr); n++;
}
// 1) 排版记录：监测继续跑，但不再往对话里留那行小字（2026-10-07 用户要求不显示）
rep("  const n = document.createElement('div'); n.className = 'notice'; n.style.fontSize = '12px';\n  n.textContent = '排版记录：共 ' + L.length + ' 帧；回答缩回 ' + shrink + ' 次（最大 ' + maxShrink.toFixed(1) + 'px）；滚到底后文字位置跳动 ' + jump + ' 次（最大 ' + maxJump.toFixed(1) + 'px）；输入框位置变 ' + cp + ' 次；聊天区尺寸变 ' + chg + ' 次；红球行无故跳 ' + wkj + ' 次；dpr=' + devicePixelRatio;\n  chat.appendChild(n); jit.log = [];",
    "  jit.log = [];   // 2026-10-07 用户要求：排版记录不再显示，只留监测");
// 2) 确认框：问题文字里已含完整命令，下面只留运行位置，不再重复贴一遍命令
rep("const body = d.kind === 'command' ? `命令：<pre>${esc(d.command)}</pre>在：${esc(d.cwd)}` : d.kind === 'write' ? `文件：${esc(d.path)}<pre>${esc(d.preview || '')}</pre>` : d.path ? esc(d.path) : '';",
    "const body = d.kind === 'command' ? `在：${esc(d.cwd)}` : d.kind === 'write' ? `文件：${esc(d.path)}<pre>${esc(d.preview || '')}</pre>` : d.path ? esc(d.path) : '';");
fs.writeFileSync(p, c);
console.log('ui.html patched OK,', n, '处');
