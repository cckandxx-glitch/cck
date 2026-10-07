const fs = require('fs');
// 看 10-06 日志 18:30~19:15（=本地 02:30~03:15）之间，另一个对话框在干什么
const p = 'D:/ai网站/本地AI/logs/2026-10-06.jsonl';
const lines = fs.readFileSync(p, 'utf8').split('\n');
for (const l of lines) {
  if (!l.trim()) continue;
  let j; try { j = JSON.parse(l); } catch (e) { continue; }
  const t = j.t || '';
  if (t >= '2026-10-06T18:44:00' && t <= '2026-10-06T19:14:00') {
    const kind = j.kind || '?';
    let s = '';
    if (kind === 'assistant') s = j.text ? '说: ' + j.text.slice(0, 100).replace(/\n/g, ' ') : (j.calls ? '调: ' + j.calls.map(c => c.name).join(',') : '');
    else if (kind === 'tool') s = (j.name || '') + ' ' + String(j.result || '').slice(0, 90).replace(/\n/g, ' ');
    else if (kind === 'user') s = '用户: ' + String(j.text || '').slice(0, 100);
    else if (kind === 'stop') s = '收到STOP';
    console.log(t.slice(11, 19) + ' [' + kind + '] ' + s);
  }
}
