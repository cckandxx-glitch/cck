const fs = require('fs');
const dir = 'D:/ai网站/本地AI/agent';
const NL = String.fromCharCode(10);
const pats = ['maxSteps', 'max_steps', '最大步数'];
for (const f of fs.readdirSync(dir)) {
  if (!/\.(js|json)$/.test(f) || f.startsWith('_bak')) continue;
  const c = fs.readFileSync(dir + '/' + f, 'utf8');
  const hits = pats.filter(p => c.includes(p));
  if (hits.length) {
    for (const p of hits) {
      let idx = 0;
      while ((idx = c.indexOf(p, idx)) !== -1) {
        const s = Math.max(0, idx - 60), e = Math.min(c.length, idx + 60);
        let frag = c.slice(s, e).split(NL).join(' ');
        console.log(f + ' :: ...' + frag + '...');
        idx += p.length;
      }
    }
  }
}
