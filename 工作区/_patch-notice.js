const fs = require('fs');
const p = 'D:/ai网站/本地AI/agent/server.js';
let c = fs.readFileSync(p, 'utf8');
let n = 0;
function rep(oldStr, newStr) {
  if (!c.includes(oldStr)) { console.log('NOT FOUND:', JSON.stringify(oldStr.slice(0, 80))); process.exit(1); }
  c = c.replace(oldStr, newStr); n++;
}
// 1) 学习循环：自动同意不再提示，危险操作跳过仍提示
rep("if (isRisky(detail)) { notice('学习循环中，跳过危险操作: ' + q.split('\\n')[0]); return Promise.resolve(false); }\n    notice('学习循环自动同意: ' + q.split('\\n')[0]);",
    "if (isRisky(detail)) { notice('学习循环中，跳过危险操作: ' + q.split('\\n')[0]); return Promise.resolve(false); }   // 自动同意不打扰（2026-10-07 用户要求）");
// 2) 无人值守：自动允许不再提示，拒绝仍提示
rep("const ok = detail.kind === 'write' && ['任务结果', '草稿', '线索'].some((d) => path.resolve(detail.path).startsWith(path.join(core.WS, d) + path.sep));\n    notice((ok ? '无人值守，自动允许: ' : '无人值守，已拒绝: ') + q);",
    "const ok = detail.kind === 'write' && ['任务结果', '草稿', '线索'].some((d) => path.resolve(detail.path).startsWith(path.join(core.WS, d) + path.sep));\n    if (!ok) notice('无人值守，已拒绝: ' + q);");
// 3) 全部同意：不再提示
rep("if (allowAll && !isRisky(detail)) { notice('已自动同意: ' + q.split('\\n')[0]); return Promise.resolve(true); }",
    "if (allowAll && !isRisky(detail)) return Promise.resolve(true);   // 自动同意不打扰（2026-10-07 用户要求）");
// 4) doSend 开头加重启守卫，防止重启期间又进新任务
rep("  const act = pw.detect(text);\n  busy = act ? 'AI 上线/下线' : '对话'; bc('state', {});",
    "  if (busy === '重启中') { notice('正在重启，稍后再发。'); return; }\n  const act = pw.detect(text);\n  busy = act ? 'AI 上线/下线' : '对话'; bc('state', {});");
// 5) 加 /api/restart 接口（外壳检测到后台退出会自动重新拉起）
rep("      if (url.pathname === '/api/stop') {",
    "      if (url.pathname === '/api/restart') {\n        if (busy) return json(res, 409, { error: busyMsg('重启') });\n        busy = '重启中'; bc('state', {});\n        notice('正在重启服务，马上回来。');\n        setTimeout(() => process.exit(0), 1500);\n        return json(res, 200, { ok: true });\n      }\n      if (url.pathname === '/api/stop') {");
fs.writeFileSync(p, c);
console.log('patched OK,', n, '处');
