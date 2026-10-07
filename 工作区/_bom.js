const fs = require('fs');
const src = fs.readFileSync('D:/ai网站/本地AI/工作区/_restart.ps1', 'utf8');
fs.writeFileSync('D:/ai网站/本地AI/工作区/_restart.ps1', '\uFEFF' + src.replace(/^\uFEFF/, ''));
console.log('BOM added');
