const fs = require('fs');
const F = 'D:/ai网站/本地AI/agent/core.js';
let c = fs.readFileSync(F, 'utf8');
let n = 0;
const rep = (oldS, newS) => {
  const i = c.indexOf(oldS);
  if (i < 0) { console.log('NOT FOUND:', oldS.slice(0, 60)); process.exitCode = 1; return; }
  c = c.slice(0, i) + newS + c.slice(i + oldS.length); n++;
};
// 1) download_file: curl 加 -f，HTTP 错误不再存成文件
rep("await curl(url, ['-o', f], { timeout: 600 });", "await curl(url, ['-f', '-o', f], { timeout: 600 });");
// 2) download_file: 下载后校验图片文件头
rep("return fs.existsSync(f) ? `已下载 ${shown(f)}（${fs.statSync(f).size}B）` : '下载失败，没有生成文件。';",
    "const done = () => (fs.existsSync(f) ? `已下载 ${shown(f)}（${fs.statSync(f).size}B）` : '下载失败，没有生成文件。');\n      if (/\\.(png|jpe?g|gif|webp|bmp)$/i.test(f)) { const h = fs.readFileSync(f).slice(0, 12); if (!isImgBytes(h)) { try { fs.unlinkSync(f); } catch (e) {} return '下载失败：返回的不是图片（HTTP 错误页或文件已失效），已删掉。'; } }\n      return done();");
// 3) read_file: 图片文件头校验，不是真图就报清楚
rep("if (st.size > 8e6) throw new Error('图片超过 8MB，太大了');",
    "if (st.size > 8e6) throw new Error('图片超过 8MB，太大了');\n        const hb = fs.readFileSync(f).slice(0, 12); if (!isImgBytes(hb)) throw new Error(`这个文件不是有效的图片（${ext}，内容对不上，多半是下载到的错误页）`);");
// 4) 工具函数
rep("const abs = (p) => path.resolve(WS, String(p || '.'));",
    "const abs = (p) => path.resolve(WS, String(p || '.'));\n  const isImgBytes = (h) => h[0] === 0x89 && h[1] === 0x50 || h[0] === 0xff && h[1] === 0xd8 || h[0] === 0x47 && h[1] === 0x49 || (h[8] === 0x57 && h[9] === 0x45 && h[10] === 0x42) || h[0] === 0x42 && h[1] === 0x4d;");
fs.writeFileSync(F, c, 'utf8');
console.log('patched', n);
