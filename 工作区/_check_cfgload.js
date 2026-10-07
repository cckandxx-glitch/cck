const fs = require('fs');
const c = fs.readFileSync('D:/ai网站/本地AI/agent/server.js', 'utf8');
const NL = String.fromCharCode(10);
// 看 config 是怎么加载的：启动时读一次，还是每次读
let idx = 0, n = 0;
while ((idx = c.indexOf('config.json', idx)) !== -1 && n < 10) {
  const s = Math.max(0, idx - 100), e = Math.min(c.length, idx + 100);
  console.log('--- ' + c.slice(s, e).split(NL).join(' ') + ' ---');
  idx += 11; n++;
}
