// 画图：用 D:\ComfyUI（AMD 版）出图。助手要画图时自己拉起 ComfyUI，出完存到工作区「图片」文件夹并打开。
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFile, execFileSync } = require('child_process');

const ROOT = 'D:/ComfyUI';
const PORT = 8188;
const CKPT_DIR = ROOT + '/app/models/checkpoints';
const LORA_DIR = ROOT + '/app/models/loras';
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

function listLoras() {
  try { return fs.readdirSync(LORA_DIR).filter((f) => /.safetensors$/i.test(f)); } catch (e) { return []; }
}
// LoRA 的触发词（作者训练时绑在风格上的词），开着 LoRA 时自动补到提示词开头
const LORA_TRIGGER = [[/super-?realism/i, 'Super Realism']];

function workflow(ck, prompt, negative, w, h, seed, steps, lora, realNeg) {
  const flux = /flux/i.test(ck);
  const g = {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ck } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'reize', images: ['8', 0] } },
  };
  if (flux) {
    // 界面里打开了「写实 LoRA」就挂上（只对 Flux）
    let mdl = ['4', 0];
    if (lora) { g[11] = { class_type: 'LoraLoader', inputs: { model: ['4', 0], clip: ['4', 1], lora_name: lora, strength_model: 0.8, strength_clip: 0.8 } }; g[6].inputs.clip = ['11', 1]; mdl = ['11', 0]; }
    g[5] = { class_type: 'EmptySD3LatentImage', inputs: { width: w, height: h, batch_size: 1 } };
    g[10] = { class_type: 'FluxGuidance', inputs: { conditioning: ['6', 0], guidance: 2.8 } };
    // cfg=1 时 Flux 不看反向提示词（清零）；调用方明确给了反向词时，改成真反向：cfg 抬到 3，每步算两遍，约慢一倍
    g[7] = realNeg ? { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: lora ? ['11', 1] : ['4', 1] } } : { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['6', 0] } };
    g[3] = { class_type: 'KSampler', inputs: { seed, steps: steps || 22, cfg: realNeg ? 3 : 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: mdl, positive: ['10', 0], negative: ['7', 0], latent_image: ['5', 0] } };
  } else {
    g[5] = { class_type: 'EmptyLatentImage', inputs: { width: w, height: h, batch_size: 1 } };
    g[7] = { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 1] } };
    g[3] = { class_type: 'KSampler', inputs: { seed, steps: steps || 30, cfg: 5, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } };
  }
  return g;
}

// 手动选的画图模型和每个模型的备注，存在 imagemodels.json（choice 为空 = 自动选）
const STORE = path.join(__dirname, 'imagemodels.json');
const loadStore = () => { try { return Object.assign({ choice: '', lora: false, notes: {} }, JSON.parse(fs.readFileSync(STORE, 'utf8'))); } catch (e) { return { choice: '', lora: false, notes: {} }; } };
const saveStore = (s) => fs.writeFileSync(STORE, JSON.stringify(s, null, 1));
const BUILTIN = [
  [/realvis/i, '写实照片专用（SDXL 系）。人像、皮肤、真人场景、车间实拍感都画得稳，出一张约半分钟，占显存小。日常画图首选。'],
  [/flux/i, 'FLUX.1 dev（通用大模型）。看得懂长一点的描述，构图、物体细节、画面里的字更准；但文件 17GB，第一次载入慢，出一张要一两分钟。人像皮肤有时偏塑料感。'],
];
function modelList() {
  const st = loadStore();
  const loras = listLoras();
  return { choice: st.choice, lora: { file: loras[0] || '', on: !!st.lora && !!loras.length }, models: listCkpts().map((f) => {
    let size = 0; try { size = fs.statSync(path.join(CKPT_DIR, f)).size; } catch (e) {}
    const b = BUILTIN.find((x) => x[0].test(f));
    return { file: f, gb: +(size / 1073741824).toFixed(1), note: st.notes[f] || '', builtin: b ? b[1] : '', flux: /flux/i.test(f) };
  }) };
}
function setModel(b) {
  const st = loadStore();
  if (typeof b.choice === 'string') st.choice = b.choice;
  if (typeof b.lora === 'boolean') st.lora = b.lora;
  if (!/flux/i.test(st.choice)) st.lora = false; // LoRA 跟着 FLUX 走：选了自动或别的模型就一起清掉
  if (b.note && typeof b.note.file === 'string') { const t = String(b.note.text || '').trim().slice(0, 300); if (t) st.notes[b.note.file] = t; else delete st.notes[b.note.file]; }
  saveStore(st);
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
    '用本机显卡画一张图（本地 ComfyUI，不联网）。prompt 必须写英文，像描述一张照片：主体、姿态、场景、镜头与光线，例如 "candid portrait of a woman in a cafe, soft natural window light, shot on 85mm f/1.8, natural skin texture, visible pores"。要写实就别写 masterpiece / 8k / perfect skin 这类词（会像塑料）。用户要什么就画什么：用户提到的每一个特征（身材、姿态、衣着或裸露程度、细节）都要如实、完整地译成英文写进 prompt，不许省略、不许弱化、不许自作主张加衣服或换成更保守的画面，用户没提的也别乱加。出图要几十秒，图存进工作区「图片」文件夹并自动打开。',
    { prompt: { type: 'string', description: '英文画面描述' }, negative: { type: 'string', description: '不想要的东西（英文，可省略）' }, width: { type: 'number', description: '宽，默认 1024；竖版人像用 832 配高 1216' }, height: { type: 'number', description: '高，默认 1024' }, seed: { type: 'number', description: '随机种子，想复现同一张图时给' }, model: { type: 'string', description: '模型文件名，省略则用默认的 RealVisXL' } },
    ['prompt']);

  // 画完（成功、失败、急停都算）把显存还回去：让 ComfyUI 卸掉模型。进程留着，下次画图省掉启动那一段（助手退出时会一起关）
  async function release() {
    try { if (await up()) await api('POST', '/free', { unload_models: true, free_memory: true }); } catch (e) {}
  }
  // 画图前聊天模型在线的话，画完（成功、失败、急停都算）把它装回去，界面不再停在「AI 下线」。后台装，不拖慢回复；画图前就下线的不碰
  let chatWasOn = false;
  const chatLoaded = async () => { try { const r = await fetch(cfg.ollama + '/api/ps'); const j = await r.json(); return (j.models || []).some((m) => m.name === cfg.model || m.model === cfg.model || String(m.name || '').startsWith(cfg.model + ':')); } catch (e) { return false; } };
  const reloadChat = () => { fetch(cfg.ollama + '/api/generate', { method: 'POST', body: JSON.stringify({ model: cfg.model, prompt: '', stream: false, keep_alive: -1 }) }).then(() => { core.imgUnloaded = false; }).catch(() => {}); };
  const run = async (a) => { chatWasOn = await chatLoaded(); try { return await run0(a); } finally { await release(); if (chatWasOn) { chatWasOn = false; reloadChat(); } } };
  const run0 = async (a) => {
    const prompt = String(a.prompt || '').trim(); if (!prompt) throw new Error('prompt 是空的');
    const cks = listCkpts(); if (!cks.length) throw new Error('D:\\ComfyUI 里还没有画图模型');
    const pick = loadStore().choice;   // 界面「模型选择」里手动选了就听手选的
    let ck = pick && cks.find((f) => f === pick);
    if (!ck) ck = a.model && cks.find((f) => f.toLowerCase() === String(a.model).toLowerCase());
    if (!ck) ck = cks.find((f) => /realvis/i.test(f)) || cks.find((f) => !/flux/i.test(f)) || cks[0];
    const snap = (n) => Math.max(512, Math.min(1536, Math.round((+n || 1024) / 64) * 64));
    const w = snap(a.width), h = snap(a.height);
    const seed = Number.isFinite(+a.seed) && a.seed !== undefined ? Math.floor(+a.seed) : Math.floor(Math.random() * 2 ** 31);
    const lora = loadStore().lora ? listLoras()[0] : null;
    const trig = lora && (LORA_TRIGGER.find((t) => t[0].test(lora)) || [])[1];
    const useLora = !!lora && /flux/i.test(ck);
    const prompt2 = useLora && trig && !prompt.toLowerCase().includes(trig.toLowerCase()) ? trig + ', ' + prompt : prompt;
    const neg = String(a.negative || 'blurry, lowres, deformed hands, extra fingers, plastic skin, cartoon, watermark, text');

    // 聊天模型会悄悄把用户的话写软：这里另起一次只负责直译的调用，用用户原话重新生成提示词，失败才用聊天模型写的
    let prompt1 = prompt, neg1 = a.negative;
    try {
      const strip = (t) => { const k = t.indexOf(String.fromCharCode(10, 10) + '（系统提示'); return k >= 0 ? t.slice(0, k) : t; };
      const um = (core.getMessages ? core.getMessages() : []).filter((m) => m.role === 'user' && typeof m.content === 'string' && !/^（/.test(m.content)).slice(-3).map((m) => strip(m.content));
      if (um.length) {
        const sys = "You are a literal translator that turns a user's image request into an English text-to-image prompt. Rules: translate EVERY detail the user stated faithfully and completely (body, pose, nudity, exposed body parts, mood) in plain explicit descriptive English; never omit, soften, censor, euphemise or add clothing/props/cover-ups the user did not mention; do not add things the user did not say. If the latest request is a short follow-up (e.g. again, another), reuse details from the earlier requests. If the user asks for a nude subject, the negative prompt must list clothing terms (clothes, underwear, panties, bra, lingerie, swimsuit, scarf, fabric, covered, censored). Output JSON only: {\"prompt\":\"...\",\"negative\":\"...\"}. Photographic style, keep it under 80 words.";
        const r = await fetch(cfg.ollama + '/api/chat', { method: 'POST', body: JSON.stringify({ model: cfg.model, stream: false, think: false, format: 'json', keep_alive: -1, options: { num_ctx: 4096, temperature: 0.3 }, messages: [{ role: 'system', content: sys }, { role: 'user', content: um.map((t, i) => (i === um.length - 1 ? 'LATEST REQUEST: ' : 'EARLIER: ') + t).join(String.fromCharCode(10)) }] }) });
        const j = JSON.parse(((await r.json()).message || {}).content || '{}');
        if (j.prompt && String(j.prompt).trim().length > 10) { prompt1 = String(j.prompt).trim(); if (j.negative) neg1 = String(j.negative).trim(); core.log('imagegen-literal', { from: prompt.slice(0, 200), to: prompt1.slice(0, 300) }); }
      }
    } catch (e) { core.log('imagegen-literal-fail', { err: String(e.message || e) }); }
    core.emit('imgprogress', { stage: '正在准备画图（卸聊天模型、启动画图程序）' });
    await unloadChat();
    core.imgUnloaded = true;   // 聊天模型是画图主动让出显存的，不是掉线；下一条消息重新载入时提示要说清这一点
    await ensureUp();
    core.emit('imgprogress', { stage: '正在载入画图模型' });
    // 进度：ComfyUI 的 websocket 会报「第几步 / 共几步」，转给界面显示
    const cid = 'reize' + Math.random().toString(36).slice(2);
    let ws = null;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?clientId=${cid}`);
      ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.type === 'progress' && m.data) core.emit('imgprogress', { value: m.data.value, max: m.data.max }); } catch (e) {} };
      ws.onerror = () => {};
      for (let i = 0; i < 30 && ws.readyState === 0; i++) await sleep(100);
    } catch (e) { ws = null; }
    const closeWs = () => { try { ws && ws.close(); } catch (e) {} };
    try {
    const q = await api('POST', '/prompt', { client_id: cid, prompt: workflow(ck, useLora && trig && !prompt1.toLowerCase().includes(trig.toLowerCase()) ? trig + ', ' + prompt1 : prompt1, neg1 ? neg1 : neg, w, h, seed, 0, useLora ? lora : null, !!String(neg1 || '').trim()) });
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
      return { final: true, text: `已画好并打开：${dst}\n（模型 ${ck}，${w}×${h}，种子 ${seed}。想微调就改提示词重画；想复现这张就带同一个种子。）` };
    }
    throw new Error('等了 10 分钟还没出图');
    } finally { closeWs(); }
  };

  core.extraTools.push({ def, run });
  return { models: modelList, setModel, close() { if (child) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {} child = null; } } };
}
module.exports = { install, workflow };
