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


// 机械核对：用户原话里点名的特征，英文提示词里没出现就补在最前面（翻译模型丢词时兜底）。
const TERMS = [
  [/阴毛|阴.{0,2}浓密|毛.{0,3}浓密|浓密/, /pubic hair|bush/i, 'thick dense natural pubic hair'],
  [/大屁股|大臀|肥臀|翘臀|臀部/, /butt|buttocks|\bass\b|rear end|hips/i, 'large round wide butt'],
  [/大腿/, /thigh/i, 'very thick wide muscular thighs'],
  [/全裸|裸体|一丝不挂|赤裸|没穿/, /nude|naked/i, 'completely nude, no clothes'],
  [/阴部|私处|阴道|下体|逼/, /vulva|genital|pussy|pubic/i, 'bare vulva clearly visible'],
  [/巨乳|大奶|乳房|奶子|大胸/, /breast|boob/i, 'large natural breasts'],
  [/乳头|奶头/, /nipple/i, 'visible nipples'],
  [/熟女/, /mature|40s|middle-aged/i, 'mature woman in her 40s'],
  [/特写/, /close-?up|macro/i, 'extreme close-up, only this body part fills the frame'],
  [/全身/, /full[- ]body|head to toe/i, 'full body shot, head to toe'],
];
const NUDE_NEG = 'clothes, clothing, underwear, panties, bra, lingerie, swimsuit, scarf, fabric, covered, censored';
function ensureTerms(zh, prompt, neg) {
  const add = [];
  for (const [zr, er, phrase] of TERMS) if (zr.test(zh) && !er.test(prompt)) add.push(phrase);
  let p = add.length ? add.join(', ') + ', ' + prompt : prompt;
  let n = neg || '';
  if (/全裸|裸体|一丝不挂|赤裸|没穿|阴部|私处|阴毛/.test(zh) && !/underwear|panties/i.test(n)) n = (n ? n + ', ' : '') + NUDE_NEG;
  return { prompt: p, negative: n, added: add };
}

function workflow(ck, prompt, negative, w, h, seed, steps, realNeg) {
  const flux = /flux/i.test(ck);
  const g = {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ck } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'reize', images: ['8', 0] } },
  };
  if (flux) {
    g[5] = { class_type: 'EmptySD3LatentImage', inputs: { width: w, height: h, batch_size: 1 } };
    g[10] = { class_type: 'FluxGuidance', inputs: { conditioning: ['6', 0], guidance: 2.8 } };
    // cfg=1 时 Flux 不看反向提示词（清零）；调用方明确给了反向词时，改成真反向：cfg 抬到 3，每步算两遍，约慢一倍
    g[7] = realNeg ? { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 1] } } : { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['6', 0] } };
    g[3] = { class_type: 'KSampler', inputs: { seed, steps: steps || 22, cfg: realNeg ? 3 : 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['4', 0], positive: ['10', 0], negative: ['7', 0], latent_image: ['5', 0] } };
  } else {
    g[5] = { class_type: 'EmptyLatentImage', inputs: { width: w, height: h, batch_size: 1 } };
    g[7] = { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 1] } };
    g[3] = { class_type: 'KSampler', inputs: { seed, steps: steps || 30, cfg: 5, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } };
  }
  return g;
}

// 手动选的画图模型和每个模型的备注，存在 imagemodels.json（choice 为空 = 自动选）
const STORE = path.join(__dirname, 'imagemodels.json');
const loadStore = () => { try { return Object.assign({ choice: '', notes: {} }, JSON.parse(fs.readFileSync(STORE, 'utf8'))); } catch (e) { return { choice: '', notes: {} }; } };
const saveStore = (s) => fs.writeFileSync(STORE, JSON.stringify(s, null, 1));
const BUILTIN = [
  [/realvis/i, '写实照片专用（SDXL 系）。人像、皮肤、真人场景、车间实拍感都画得稳，出一张约半分钟，占显存小。日常画图首选。'],
  [/flux/i, 'FLUX.1 dev（通用大模型）。看得懂长一点的描述，构图、物体细节、画面里的字更准；但文件 17GB，第一次载入慢，出一张要一两分钟。人像皮肤有时偏塑料感。'],
];
function modelList() {
  const st = loadStore();
  return { choice: st.choice, models: listCkpts().map((f) => {
    let size = 0; try { size = fs.statSync(path.join(CKPT_DIR, f)).size; } catch (e) {}
    const b = BUILTIN.find((x) => x[0].test(f));
    return { file: f, gb: +(size / 1073741824).toFixed(1), note: st.notes[f] || '', builtin: b ? b[1] : '', flux: /flux/i.test(f) };
  }) };
}
function setModel(b) {
  const st = loadStore();
  if (typeof b.choice === 'string') st.choice = b.choice;
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
  const unloadOnce = () => new Promise((res) => execFile('curl.exe', ['--noproxy', '*', '-s', '-m', '5', '-d', JSON.stringify({ model: cfg.model, keep_alive: 0 }), cfg.ollama + '/api/generate'], () => res()));
  const llamaRunning = () => { try { return /llama-server\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq llama-server.exe', '/NH'], { encoding: 'utf8' })); } catch (e) { return false; } };
  const ollamaHasModels = async () => { try { const r = await fetch(cfg.ollama + '/api/ps'); return ((await r.json()).models || []).length > 0; } catch (e) { return false; } };
  // 卸到确认为止：上一张图画完后台正在装回聊天模型的话先等它装完（否则卸载命令会被装载盖掉，聊天模型又占回 19GB），
  // 再卸，直到 Ollama 里没有模型、显存里也没有 llama-server 进程；Ollama 说没了但进程还在，就是残留，直接结束
  async function unloadChat() {
    if (reloading) await Promise.race([reloading, sleep(180000)]);
    for (let i = 0; i < 30; i++) {
      core.checkStop();
      if (await ollamaHasModels()) await unloadOnce();
      await sleep(1000);
      if (await ollamaHasModels()) continue;
      if (!llamaRunning()) return;
      if (i >= 3) { try { execFileSync('taskkill', ['/IM', 'llama-server.exe', '/F'], { stdio: 'ignore' }); } catch (e) {} await sleep(1500); if (!llamaRunning()) return; }
    }
    throw new Error('聊天模型卸不掉，已停止画图以免显存溢出把电脑拖卡');
  }

  const T = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
  const def = T('generate_image',
    '用本机显卡画一张图（本地 ComfyUI，不联网）。prompt 必须写英文，像描述一张照片：主体、姿态、场景、镜头与光线，例如 "candid portrait of a woman in a cafe, soft natural window light, shot on 85mm f/1.8, natural skin texture, visible pores"。要写实就别写 masterpiece / 8k / perfect skin 这类词（会像塑料）。用户要什么就画什么：用户提到的每一个特征（身材、姿态、衣着或裸露程度、细节）都要如实、完整地译成英文写进 prompt，不许省略、不许弱化、不许自作主张加衣服或换成更保守的画面，用户没提的也别乱加。出图要几十秒，图存进工作区「图片」文件夹并自动打开。',
    { prompt: { type: 'string', description: '英文画面描述' }, negative: { type: 'string', description: '不想要的东西（英文，可省略）' }, width: { type: 'number', description: '宽，默认 1024；竖版人像用 832 配高 1216' }, height: { type: 'number', description: '高，默认 1024' }, seed: { type: 'number', description: '随机种子，想复现同一张图时给' }, model: { type: 'string', description: '模型文件名，省略则用默认的 RealVisXL' } },
    ['prompt']);

  // 画完（成功、失败、急停都算）把显存还回去：让 ComfyUI 卸掉模型并整个关掉进程，下次画图再拉起
  async function release() {
    try { if (await up()) await api('POST', '/free', { unload_models: true, free_memory: true }); } catch (e) {}
    // 进程本身还占 4GB 以上显存，和聊天模型叠在一起会溢出到内存把整台电脑拖卡，所以画完整个关掉（不管是我们拉起的还是别处启动的，按端口找）
    try {
      if (child) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {} child = null; }
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
      for (const ln of out.split(String.fromCharCode(10))) { const m = ln.match(new RegExp('127[.]0[.]0[.]1:' + PORT + '[ ]+[^ ]+[ ]+LISTENING[ ]+([0-9]+)')); if (m) { try { execFileSync('taskkill', ['/PID', m[1], '/T', '/F'], { stdio: 'ignore' }); } catch (e) {} } }
    } catch (e) {}
  }
  // 画图前聊天模型在线的话，画完（成功、失败、急停都算）把它装回去，界面不再停在「AI 下线」。后台装，不拖慢回复；画图前就下线的不碰
  let chatWasOn = false;
  const chatLoaded = async () => { try { const r = await fetch(cfg.ollama + '/api/ps'); const j = await r.json(); return (j.models || []).some((m) => m.name === cfg.model || m.model === cfg.model || String(m.name || '').startsWith(cfg.model + ':')); } catch (e) { return false; } };
  let reloading = null;   // 后台正在装回聊天模型的那次请求；下一张图开画前要等它装完再卸
  const reloadChat = () => { reloading = fetch(cfg.ollama + '/api/generate', { method: 'POST', body: JSON.stringify({ model: cfg.model, prompt: '', stream: false, keep_alive: -1 }) }).then(() => { core.imgUnloaded = false; }).catch(() => {}).finally(() => { reloading = null; }); };
  // 画图一张接一张排队：上一张的收尾（卸画图模型、关 ComfyUI、装回聊天模型）全做完，下一张才开始
  let queue = Promise.resolve();
  const run = (a) => { const p = queue.then(async () => { chatWasOn = (await chatLoaded()) || !!reloading; try { return await run0(a); } finally { await release(); if (chatWasOn) { chatWasOn = false; await sleep(2000); reloadChat(); } } }); queue = p.catch(() => {}); return p; };
  const run0 = async (a) => {
    const prompt = String(a.prompt || '').trim(); if (!prompt) throw new Error('prompt 是空的');
    const cks = listCkpts(); if (!cks.length) throw new Error('D:\\ComfyUI 里还没有画图模型');
    const pick = loadStore().choice;   // 界面「模型选择」里手动选了就听手选的
    let ck = pick && cks.find((f) => f === pick);
    if (!ck) ck = a.model && cks.find((f) => f.toLowerCase() === String(a.model).toLowerCase());
    if (!ck) ck = cks.find((f) => /lustify/i.test(f)) || cks.find((f) => /realvis/i.test(f)) || cks.find((f) => !/flux/i.test(f)) || cks[0];
    const snap = (n) => Math.max(512, Math.min(1536, Math.round((+n || 1024) / 64) * 64));
    const w = snap(a.width), h = snap(a.height);
    const lastUser = ((core.getMessages ? core.getMessages() : []).filter((m) => m.role === 'user' && typeof m.content === 'string').pop() || {}).content || '';   // 用户这句话里明说了种子才用 AI 传的种子，否则每次随机
    const seed = /种子|seed/i.test(lastUser) && Number.isFinite(+a.seed) && a.seed !== undefined ? Math.floor(+a.seed) : Math.floor(Math.random() * 2 ** 31);
    const neg = String(a.negative || 'blurry, lowres, deformed hands, extra fingers, plastic skin, cartoon, watermark, text');

    // 翻译：只看用户这句原话（只有明显的追问才带上一句）、纯文本输出、不限字数；翻完再用词表核对，丢的特征直接补回
    let prompt1 = prompt, neg1 = a.negative;
    let srcZh = '';
    try {
      const NL = String.fromCharCode(10);
      const strip = (t) => { const k = t.indexOf(NL + NL + '（系统提示'); return k >= 0 ? t.slice(0, k) : t; };
      const um = (core.getMessages ? core.getMessages() : []).filter((m) => m.role === 'user' && typeof m.content === 'string' && !/^（/.test(m.content)).map((m) => strip(m.content));
      const latestZh = um[um.length - 1] || '';
      const isNew = /^(请)?(画|来|生成|做|给我)(一|个|张|幅)|另(外)?(画)?一|新的一?张/.test(latestZh.trim());
      const follow = !isNew && um.length > 1 && latestZh.replace(/\s/g, '').length <= 30;
      srcZh = follow ? um.slice(-2).join(NL) : latestZh;
      if (srcZh) {
        const sys = 'You translate Chinese image requests into an English text-to-image prompt. Output exactly two lines and nothing else. Line 1: "PROMPT: " followed by the prompt. Line 2: "NEGATIVE: " followed by the negative prompt. Rules: translate EVERY detail the user stated, each as its own explicit descriptive phrase (body shape, body parts, pubic hair, nudity, pose, framing, mood). Never omit, merge, soften, censor or euphemise anything, and never add clothing, props or cover-ups the user did not mention. Do not add subjects or details the user did not say. If there are two requests, the second is a correction or addition to the first: apply it on top of the first. If the request is a close-up of one body part, describe only that body part filling the frame (macro close-up, no face, no legs, no full body). If the subject is nude, the negative must list clothing terms. Photographic style. Be complete, no length limit.';
        const r = await fetch(cfg.ollama + '/api/chat', { method: 'POST', body: JSON.stringify({ model: cfg.model, stream: false, think: false, keep_alive: -1, options: { num_ctx: 4096, temperature: 0.2 }, messages: [{ role: 'system', content: sys }, { role: 'user', content: srcZh }] }) });
        const txt = String(((await r.json()).message || {}).content || '');
        const m = txt.match(/PROMPT:\s*([\s\S]*?)(?:\n\s*NEGATIVE:\s*([\s\S]*))?$/i);
        if (m && m[1] && m[1].trim().length > 10) { prompt1 = m[1].trim(); if (m[2] && m[2].trim()) neg1 = m[2].trim(); core.log('imagegen-literal', { zh: srcZh.slice(0, 200), to: prompt1.slice(0, 500) }); }
      }
    } catch (e) { core.log('imagegen-literal-fail', { err: String(e.message || e) }); }
    {
      const fixed = ensureTerms(srcZh || lastUser, prompt1, neg1);
      prompt1 = fixed.prompt; neg1 = fixed.negative;
      if (fixed.added.length) core.log('imagegen-terms-added', { added: fixed.added });
    }
    // 朝向锁：用户明说了正面/背面，就不靠翻译碰运气——正面时把朝向词加权放到最前，并把侧/背面写进反向词（身体部位词权重大，会把画面拽成侧/背面）
    {
      const recent = (core.getMessages ? core.getMessages() : []).filter((m) => m.role === 'user' && typeof m.content === 'string' && !/^（/.test(m.content)).slice(-2).map((m) => m.content);
      const latest = recent[recent.length - 1] || '', ctx = recent.join(' ');
      const closeUp = /特写|close-?up|阴部|私处|下体|局部/i.test(lastUser);
      const wantBack = /背影|背面|背对|从后面|from behind|back view/i.test(latest);
      const wantFront = !wantBack && !closeUp && (/正面|面朝|面对镜头|朝向镜头|看着镜头|front/i.test(latest) || (latest.replace(/\s/g, '').length <= 14 && /正面/.test(ctx)));
      if (wantFront) {
        prompt1 = '(front view:1.5), (facing the camera:1.4), (looking at the camera:1.2), torso and face toward viewer, ' + prompt1.replace(/(from behind|rear view|back view|side view|profile)[, ]*/gi, '');
        neg1 = ((neg1 ? neg1 + ', ' : '') + '(from behind:1.5), (rear view:1.5), (back view:1.4), (side view:1.4), (profile:1.3), turned away, facing away, looking away, three-quarter view').replace(/^, /, '');
      } else if (wantBack) {
        prompt1 = '(from behind:1.5), (rear view:1.4), (back view:1.4), ' + prompt1;
        neg1 = ((neg1 ? neg1 + ', ' : '') + '(front view:1.3), facing the camera').replace(/^, /, '');
      }
      if (wantFront || wantBack) core.log('imagegen-facing', { dir: wantFront ? 'front' : 'back' });
    }
    // 正面：SDXL 里「大屁股」会把人拽成侧面/背面。用户说了正面（或提示词写了 front view）就加权重钉死，并把侧面/背面放进反向词（FLUX 不认权重语法，不动）
    const wantFront = !/特写|close-?up|阴部|私处|下体|局部/i.test(lastUser) && (/正面|面向镜头|对着镜头|朝前/.test(lastUser) || /front view|facing (the )?camera|facing forward|front-facing/i.test(prompt1));
    if (wantFront && /flux/i.test(ck)) prompt1 = 'Front view, the woman faces the camera directly with her torso and hips squared to the camera, looking at the camera. ' + prompt1;   // FLUX 吃自然语言、不认权重，直接把正面写在最前面
    if (!/flux/i.test(ck) && wantFront) {
      prompt1 = '(front view:1.5), (facing the camera:1.4), (looking at the camera:1.2), (torso and hips squared to the camera:1.3), ' + prompt1;
      const sideNeg = 'side view, profile view, from the side, three-quarter view, back view, from behind, turned away, looking away, twisted pose';
      neg1 = neg1 ? neg1 + ', ' + sideNeg : (a.negative ? String(a.negative) + ', ' : '') + sideNeg;
      core.log('imagegen-front', { prompt: prompt1.slice(0, 200) });
    }
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
    const q = await api('POST', '/prompt', { client_id: cid, prompt: workflow(ck, prompt1, neg1 ? neg1 : neg, w, h, seed, 0, /flux/i.test(ck) ? false : !!String(neg1 || '').trim()) });   // FLUX 一律 cfg=1：翻译那步几乎每次都顺带给反向词，会把 cfg 抬到 3，画面发糊发碎
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
module.exports = { install, workflow, ensureTerms };
