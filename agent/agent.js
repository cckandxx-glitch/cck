'use strict';
// 命令行版。日常用网页版（node server.js），这个留着调试和无界面自测。
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { createCore } = require('./core');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
if (opt('--workspace')) cfg.workspace = opt('--workspace');
if (flag('--online')) cfg.online = true;
if (opt('--proxy')) cfg.proxy = opt('--proxy');
const AUTO_YES = flag('--yes'); // 仅供自测，配合临时工作文件夹使用

let rl;
const core = createCore(cfg, {
  ask: (q) => {
    if (AUTO_YES) { console.log('  [自测自动同意] ' + q); return Promise.resolve(true); }
    return new Promise((res) => rl.question('  ⚠ ' + q + ' (y=同意 / 其他=拒绝) ', (a) => res(/^y/i.test(a.trim()))));
  },
  emit: (type, d) => {
    if (type === 'token') process.stdout.write(d.text);
    else if (type === 'thinking') process.stdout.write('（思考中…）');
    else if (type === 'tool') console.log(`\n  → ${d.name} ${JSON.stringify(d.args).slice(0, 160)}`);
    else if (type === 'toolresult') console.log('    ' + d.text.split('\n')[0].slice(0, 120));
    else if (type === 'done') console.log(d.stats ? `\n  （${d.stats.n} 字，${d.stats.tps.toFixed(0)} 字/秒）` : '');
    else if (type === 'stopped') console.log('\n  已打断。');
    else if (type === 'notice') console.log('  ' + d.text);
  },
});

console.log(`REIZE助手(命令行)  模型 ${cfg.model}  ${cfg.online ? '【联网】' : '【不联网】'}\n工作文件夹: ${core.WS}\n命令: /联网 on|off  /思考 on|off  /清空  /退出    Ctrl+C 可随时打断\n`);
const once = opt('--once');
if (once) core.turn(once).catch((e) => console.log('出错: ' + e.message));
else {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  process.on('SIGINT', () => { core.stop(); });
  const prompt = () => rl.question('你> ', async (line) => {
    const s = line.trim();
    try {
      if (s === '/退出') { rl.close(); return; }
      else if (s === '/清空') { core.clear(); console.log('  已清空对话。'); }
      else if (/^\/联网/.test(s)) { cfg.online = /on/i.test(s); console.log('  ' + (cfg.online ? '联网已打开' : '联网已关闭')); }
      else if (/^\/思考/.test(s)) { cfg.think = /on/i.test(s); console.log('  思考模式 ' + (cfg.think ? '开（更准，更慢）' : '关')); }
      else if (s) await core.turn(s);
    } catch (e) { console.log('出错: ' + e.message); }
    prompt();
  });
  prompt();
}
