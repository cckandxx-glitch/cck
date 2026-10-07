const fs = require('fs');
const p = 'D:/ai网站/本地AI/agent/config.json';
let c = fs.readFileSync(p, 'utf8');
if (!c.includes('"maxSteps": 60')) { console.log('maxSteps 60 not found:', c.match(/maxSteps.*/)); process.exit(1); }
c = c.replace('"maxSteps": 60', '"maxSteps": 400');
fs.writeFileSync(p, c);
console.log('config patched:', c.match(/"maxSteps".*/)[0]);
