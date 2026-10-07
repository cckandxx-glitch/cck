// 画图：用 D:\ComfyUI（AMD 版）出图。助手要画图时自己拉起 ComfyUI，出完存到工作区「图片」文件夹并打开。
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFile, execFileSync } = require('child_process');

const ROOT = 'D:/ComfyUI';
const PORT = 8188;
const CKPT_DIR = ROOT + '/app/models/checkpoints';
const OUT_DIR = ROOT + '/app/output';

function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout: 8000, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (res) => {
      let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => { try { resolve({ code: res.statusCode, json: s ? JSON.parse(s) : null }); } catch (e) { resolve({ code: res.statusCode, json: null, raw: s }); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data); req.end();
  });
}
const up = async () => { try { return (await api('GET', '/system_stats')).code === 200; } catch (e) { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listCkpts() {
  try { return fs.readdirSync(CKPT_DIR).filter((f) => /\.safetensors$/i.test(f) && !/\.part$/i.test(f)); } catch (e) { return []; }
}

function workflow(ck, prompt, negative, w, h, seed, steps) {
  const flux = /flux/i.test(ck);
  const g = {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ck } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'reize', images: ['8', 0] } },
  };
  if (flux) {
    g[5] = { class_type: 'EmptySD3LatentImage', inputs: { width: w, height: h, batch_size: 1 } };
    g[10] = { class_type: 'FluxGuidance', inputs: { conditioning: ['6', 0], guidance: 3.5 } };
    g[7] = { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['6', 0] } };
    g[3] = { class_type: 'KSampler', inputs: { seed, steps: steps || 22, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['4', 0], positive: ['10', 0], negative: ['7', 0], latent_image: ['5', 0] } };
  } else {
    g[5] = { class_type: 'EmptyLatentImage', inputs: { width: w, height: h, batch_size: 1 } };
    g[7] = { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 1] } };
    g[3] = { class_type: 'KSampler', inputs: { seed, steps: steps || 30, cfg: 5, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } };
  }
  return g;
}

function install(core, cfg) {
  let child = null; // 只有我们自己拉起的才由我们关
  const outDir = path.join(cfg.workspace || 'D:/ai网站/本地AI/工作区', '图片');

  async function ensureUp() {
    if (await up()) return;
    if (!fs.existsSync(ROOT + '/venv/Scripts/python.exe')) throw new Error('没找到 ComfyUI（应在 D:\\ComfyUI）');
    child = spawn(ROOT + '/venv/Scripts/python.exe', ['main.py', '--listen', '127.0.0.1', '--port', String(PORT)], { cwd: ROOT + '/app', windowsHide: true, stdio: 'ignore' });
    child.on('exit', () => { child = null; });
    for (let i = 0; i < 90; i++) { core.checkStop(); await sleep(2000); if (await up()) return; }
    throw new Error('ComfyUI 3 分钟还没起来');
  }

  // 聊天模型和画图模型共用一张显卡，画图前先把聊天模型从显存里卸掉，下次对话会自动重新载入
  function unloadChat() {
    return new Promise((res) => execFile('curl.exe', ['--noproxy', '*', '-s', '-m', '5', '-d', JSON.stringify({ model: cfg.model, keep_alive: 0 }), cfg.ollama + '/api/generate'], () => res()));
  }

  const T = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
  const def = T('generate_image',
    '用本机显卡画一张图（本地 ComfyUI，不联网）。prompt 必须写英文，像描述一张照片：主体、姿态、场景、镜头与光线，例如 "candid portrait of a woman in a cafe, soft natural window light, shot on 85mm f/1.8, natural skin texture, visible pores"。要写实就别写 masterpiece / 8k / perfect skin 这类词（会像塑料）。出图要几十秒，图存进工作区「图片」文件夹并自动打开。',
    { prompt: { type: 'string', description: '英文画面描述' }, negative: { type: 'string', description: '不想要的东西（英文，可省略）' }, width: { type: 'number', description: '宽，默认 1024；竖版人像用 832 配高 1216' }, height: { type: 'number', description: '高，默认 1024' }, seed: { type: 'number', description: '随机种子，想复现同一张图时给' }, model: { type: 'string', description: '模型文件名，省略则自动选最好的（有 FLUX 用 FLUX）' } },
    ['prompt']);

  const run = async (a) => {
    const prompt = String(a.prompt || '').trim(); if (!prompt) throw new Error('prompt 是空的');
    const cks = listCkpts(); if (!cks.length) throw new Error('D:\\ComfyUI 里还没有画图模型');
    let ck = a.model && cks.find((f) => f.toLowerCase() === String(a.model).toLowerCase());
    if (!ck) ck = cks.find((f) => /flux/i.test(f)) || cks[0];
    const snap = (n) => Math.max(512, Math.min(1536, Math.round((+n || 1024) / 64) * 64));
    const w = snap(a.width), h = snap(a.height);
    const seed = Number.isFinite(+a.seed) && a.seed !== undefined ? Math.floor(+a.seed) : Math.floor(Math.random() * 2 ** 31);
    const neg = String(a.negative || 'blurry, lowres, deformed hands, extra fingers, plastic skin, cartoon, watermark, text');

    await unloadChat();
    await ensureUp();
    const q = await api('POST', '/prompt', { prompt: workflow(ck, prompt, neg, w, h, seed) });
    if (q.code !== 200 || !q.json || !q.json.prompt_id) throw new Error('ComfyUI 拒绝了任务: ' + JSON.stringify(q.json || q.raw || '').slice(0, 400));
    const id = q.json.prompt_id;
    for (let i = 0; i < 600; i++) { // 最多等 10 分钟（FLUX 第一次要载入模型）
      core.checkStop(); await sleep(1000);
      const hs = await api('GET', '/history/' + id);
      const e = hs.json && hs.json[id]; if (!e) continue;
      if (e.status && e.status.status_str === 'error') throw new Error('ComfyUI 出图失败: ' + JSON.stringify(e.status.messages || '').slice(0, 400));
      const im = e.outputs && e.outputs['9'] && e.outputs['9'].images && e.outputs['9'].images[0];
      if (!im) continue;
      const src = path.join(OUT_DIR, im.subfolder || '', im.filename);
      fs.mkdirSync(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const dst = path.join(outDir, `${stamp}-${seed}.png`);
      fs.copyFileSync(src, dst);
      core.log('imagegen', { ck, w, h, seed, dst });
      try { spawn('explorer.exe', [dst], { detached: true, stdio: 'ignore' }).unref(); } catch (x) {}
      return `已画好并打开：${dst}\n（模型 ${ck}，${w}×${h}，种子 ${seed}。想微调就改提示词重画；想复现这张就带同一个种子。）`;
    }
    throw new Error('等了 10 分钟还没出图');
  };

  core.extraTools.push({ def, run });
  return { close() { if (child) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {} child = null; } } };
}
module.exports = { install, workflow };
