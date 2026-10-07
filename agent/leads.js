'use strict';
// 线索挖掘流水线：搜索 → 读官网 → 本地模型判断 → 提取联系方式 → 存 CSV → 起草开发信（只起草，不发送）
const fs = require('fs');
const path = require('path');

const COUNTRIES = {
  哈萨克斯坦: ['Kazakhstan', 'Казахстан', 'ru'], 乌兹别克斯坦: ['Uzbekistan', 'Узбекистан', 'ru'], 吉尔吉斯斯坦: ['Kyrgyzstan', 'Киргизия', 'ru'],
  塔吉克斯坦: ['Tajikistan', 'Таджикистан', 'ru'], 土库曼斯坦: ['Turkmenistan', 'Туркменистан', 'ru'], 俄罗斯: ['Russia', 'Россия', 'ru'],
  墨西哥: ['Mexico', 'México', 'es'], 巴西: ['Brazil', 'Brasil', 'pt'], 阿根廷: ['Argentina', 'Argentina', 'es'], 哥伦比亚: ['Colombia', 'Colombia', 'es'],
  智利: ['Chile', 'Chile', 'es'], 秘鲁: ['Peru', 'Perú', 'es'], 土耳其: ['Turkey', 'Türkiye', 'en'], 埃及: ['Egypt', 'Egypt', 'en'], 尼日利亚: ['Nigeria', 'Nigeria', 'en'],
};
const CENTRAL_ASIA = ['哈萨克斯坦', '乌兹别克斯坦', '吉尔吉斯斯坦', '塔吉克斯坦', '土库曼斯坦'];
const LANG_NAME = { ru: 'Russian', en: 'English', es: 'Spanish', pt: 'Portuguese' };

const SKIP = /(wikipedia|alibaba|aliexpress|made-in-china|indiamart|tradeindia|linkedin|facebook|instagram|youtube|amazon\.|ebay|volza|exportgenius|yellowpages|kompass|europages|ec21|globalsources|thomasnet|zoominfo|dnb\.com|crunchbase|pinterest|reddit|quora|researchgate|tiktok|twitter|x\.com|2gis|yandex|google\.|bing\.|baidu|zhihu|slideshare|scribd|statista|tradekey|exporthub|alibaba|1688|dhgate|lusha|rocketreach|yelp|trustpilot)/i;

const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';

function queries(product, en, ru, lang) {
  const out = [];
  if (product !== 'bag') {
    out.push(`blown film extrusion machine importer ${en}`, `plastic film manufacturer ${en}`, `polyethylene film production company ${en}`, `packaging film factory ${en}`, `stretch film manufacturer ${en}`);
    if (lang === 'ru') out.push(`производство полиэтиленовой плёнки ${ru}`, `производитель плёнки ПВД ПНД ${ru}`, `купить экструдер для выдувной плёнки ${ru}`);
    if (lang === 'es') out.push(`fabricante de película plástica polietileno ${en}`);
    if (lang === 'pt') out.push(`fabricante de filme plástico polietileno ${en}`);
  }
  if (product !== 'blown') {
    out.push(`plastic bag manufacturer ${en}`, `packaging bag factory ${en}`, `polythene bag production company ${en}`);
    if (lang === 'ru') out.push(`производство полиэтиленовых пакетов ${ru}`, `изготовление пакетов ПВД ${ru}`, `производство упаковки пакеты ${ru}`);
    if (lang === 'es') out.push(`fabricante de bolsas plásticas ${en}`);
    if (lang === 'pt') out.push(`fabricante de sacos plásticos ${en}`);
  }
  return out;
}

const PRESET = ['both', 'blown', 'bag'];
async function customQueries(core, product, en, ru, lang) {
  const loc = lang === 'ru' ? '，另外 2 条用俄语（国家名写 ' + ru + '）' : lang === 'es' ? '，另外 2 条用西班牙语' : lang === 'pt' ? '，另外 2 条用葡萄牙语' : '';
  try {
    const r = await core.oneShot(`我要在网上搜索这类客户：「${product}」，国家：${en}。写 6 条搜索引擎用的搜索词，4 条英语（带国家名）${loc}，其余补英语。只要能找到这类公司官网的词，不要写成句子。输出 JSON：{"queries":["..."]}`, { json: true, maxTokens: 400 });
    const a = JSON.parse(r).queries;
    if (Array.isArray(a) && a.length) return a.map(String).slice(0, 8);
  } catch (e) {}
  return [`${product} company ${en}`, `${product} manufacturer ${en}`, `${product} supplier ${en}`];
}

async function run(core, { country, product = 'both', max = 20, draft = true }) {
  const custom = !PRESET.includes(product);
  const emit = (type, d) => core.emit('lead', { type, ...d });
  const names = country === '中亚' ? CENTRAL_ASIA : [country];
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const dir = path.join(core.WS, '线索');
  const draftDir = path.join(core.WS, '草稿');
  fs.mkdirSync(dir, { recursive: true });
  if (draft) fs.mkdirSync(draftDir, { recursive: true });

  // 1. 搜索
  const perQ = []; // 每个搜索词一个候选数组，之后轮流取，保证前面的名额覆盖所有搜索词
  for (const nm of names) {
    const [en, ru, lang] = COUNTRIES[nm] || [nm, nm, 'en'];
    for (const query of (custom ? await customQueries(core, product, en, ru, lang) : queries(product, en, ru, lang))) {
      core.checkStop();
      emit('log', { text: `搜索: ${query}` });
      const { rows, errs } = await core.searchRows(query, 10);
      if (!rows.length) emit('log', { text: '  没搜到' + (errs && errs.length ? '（' + errs.join('；') + '）' : '') });
      const arr = [];
      for (const [title, url, snippet] of rows) {
        let u; try { u = new URL(url); } catch (e) { continue; }
        if (SKIP.test(u.hostname) || /\.pdf$/i.test(u.pathname)) continue;
        arr.push({ dom: u.hostname.replace(/^www\./, ''), url: u.origin + '/', title, snippet, q: query, country: nm, lang });
      }
      perQ.push(arr);
    }
  }
  const cand = new Map();
  for (let i = 0; perQ.some((a) => i < a.length); i++) for (const a of perQ) if (a[i] && !cand.has(a[i].dom)) cand.set(a[i].dom, a[i]);
  const list = [...cand.values()].slice(0, max);
  emit('log', { text: `去重后共 ${cand.size} 个网站，本次检查前 ${list.length} 个。` });

  // 2. 逐个读官网并判断
  const cr = (() => { try { return JSON.parse(fs.readFileSync(path.join(core.cfg.crmDir, 'data', 'db.json'), 'utf8')).settings.company || {}; } catch (e) { return {}; } })();
  const results = [];
  let n = 0;
  for (const c of list) {
    core.checkStop();
    n++;
    emit('progress', { n, total: list.length, name: c.dom });
    try {
      const home = await core.curl(c.url, [], { timeout: 20 }).catch(() => '');
      if (!home || home.length < 200) { emit('log', { text: `${c.dom}: 打不开，跳过` }); continue; }
      const links = [...home.matchAll(/href=["']([^"'#]+)["']/gi)].map((m) => m[1]).filter((h) => /contact|about|kontakt|контакт|о-компан|o-kompan|about-us|contacto|sobre|empresa|company/i.test(h));
      const extra = [];
      for (const l of [...new Set(links)].slice(0, 2)) {
        try { const u = new URL(l, c.url); if (u.hostname.replace(/^www\./, '') === c.dom) extra.push(await core.curl(u.href, [], { timeout: 15 }).catch(() => '')); } catch (e) {}
      }
      const html = [home, ...extra].join('\n');
      const text = core.html2text(html).slice(0, 5500);
      const emails = [...new Set((html.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map((x) => x.toLowerCase()).filter((x) => !/\.(png|jpe?g|gif|webp|svg)$|sentry|example|wixpress|your-?email|domain\.com/.test(x)))]
        .sort((a, b) => (b.endsWith(c.dom) ? 1 : 0) - (a.endsWith(c.dom) ? 1 : 0)).slice(0, 4);
      const phones = [...new Set((core.html2text(html).match(/\+\d[\d\s().-]{7,17}\d/g) || []).map((x) => x.replace(/\s+/g, ' ').trim()))].slice(0, 3);
      const verdict = await core.oneShot(
        `下面是一家公司网站首页和联系页的文字。请判断它。只根据这些文字，不知道就写 unknown，不要编造。
输出 JSON：{"type":"producer|dealer|machine_maker|other","business":"一句话中文，这家公司做什么","scale":"small|medium|large|unknown","language":"ru|en|es|pt|other","fit":"high|medium|low","evidence":"从文字里原样摘一句最能说明它业务的话(不超过25词)"}
${custom ? `本次要找的客户是：「${product}」。type 含义：producer=这家公司本身就是这类客户；dealer=经销、进口或大量采购这类产品/设备的公司；machine_maker=制造塑料机械的厂家（是我们的同行，不是客户）；other=其他。
fit：按文字里的事实与「${product}」的贴合度判断。明确符合=high；沾边但看不出=medium；基本无关=low。` : `type 含义：producer=自己生产塑料薄膜或塑料袋/包装袋的工厂；dealer=经销或进口塑料机械/包装机械的公司；machine_maker=制造塑料机械的厂家（是我们的同行，不是客户）；other=其他。
fit：按业务贴合度判断，不要猜对方是不是已经有设备。文字里明确提到自己生产薄膜、吹膜、塑料袋/包装袋，或经销塑料机械=high；用到塑料包装但看不出自己生产=medium；基本无关=low。`}

网站: ${c.dom}
文字:
${text}`, { json: true, maxTokens: 400 });
      let v; try { v = JSON.parse(verdict); } catch (e) { emit('log', { text: `${c.dom}: 判断结果读不懂，跳过` }); continue; }
      const target = (v.type === 'producer' || v.type === 'dealer') && v.fit !== 'low';
      const row = { ...c, ...v, emails, phones, target };
      results.push(row);
      emit('row', { dom: c.dom, cls: v.type, fit: v.fit, business: v.business, emails, target });
      core.log('lead', { dom: c.dom, type: v.type, fit: v.fit, emails });

      // 3. 起草开发信（只存草稿）
      if (draft && target && emails.length) {
        const lang = ['ru', 'en', 'es', 'pt'].includes(v.language) ? v.language : c.lang;
        const sig = [cr.name || 'Ken', 'Owner & General Manager', cr.company || 'REIZE', cr.website || 'reizemachinery.com', cr.email, cr.phone].filter(Boolean).join('\n');
        const d = await core.oneShot(
          `写一封首次联系的开发信草稿，用${LANG_NAME[lang]}写。
发件人：Ken，REIZE（reizemachinery.com），中国的塑料薄膜吹膜机和制袋机制造商。
收件公司：${c.dom}。他们做：${v.business}。官网上的一句原话：${v.evidence}
要求：
- 90 到 130 个词，像一个在工厂干了多年的老板亲手写的，口气平实，不夸奖对方，不用感叹号。
- 不用"希望这封邮件找到您时一切安好"之类的套话，不堆形容词。
- 第一句提到他们官网上一个具体的事实，证明你真的看过。
- 中间用一句话说我们是谁、做什么。不提具体机型，不提价格。
- 结尾问一个简单的问题：他们现在是自己生产还是外购，有没有扩产的打算。
- 署名放在最后，用下面这段原样：
${sig}
输出 JSON：{"subject":"邮件主题","body":"正文含署名"}`, { json: true, maxTokens: 700 });
        try {
          const j = JSON.parse(d);
          const f = path.join(draftDir, `${stamp}-${c.dom.replace(/[^a-z0-9.-]/gi, '_')}.md`);
          fs.writeFileSync(f, `# 草稿 · 未发送\n\n收件: ${emails.join(', ')}\n公司网站: ${c.url}\n语言: ${lang}\n判断: ${v.business}（${v.type}，匹配度 ${v.fit}）\n依据: ${v.evidence}\n\n---\n\n主题: ${j.subject}\n\n${j.body}\n`, 'utf8');
          row.draft = path.basename(f);
        } catch (e) { emit('log', { text: `${c.dom}: 开发信没写成` }); }
      }
    } catch (e) {
      if (e.name === 'StopError') throw e;
      emit('log', { text: `${c.dom}: 出错 ${e.message.slice(0, 80)}` });
    }
  }

  // 4. 存 CSV（带 BOM，Excel 直接打开不乱码）
  const head = ['网站', '国家', '判断类型', '匹配度', '规模', '业务', '依据', '邮箱', '电话', '是否目标', '开发信草稿', '搜索词'];
  const lines = [head.map(q).join(',')].concat(results.map((r) => [r.dom, r.country, r.type, r.fit, r.scale, r.business, r.evidence, (r.emails || []).join(' / '), (r.phones || []).join(' / '), r.target ? '是' : '否', r.draft || '', r.q].map(q).join(',')));
  const csv = path.join(dir, `${country}-${product.replace(/[^w一-龥-]+/g, '_').slice(0, 30)}-${stamp}.csv`);
  fs.writeFileSync(csv, '﻿' + lines.join('\r\n'), 'utf8');
  const tgt = results.filter((r) => r.target);
  const summary = { csv, checked: results.length, targets: tgt.length, withEmail: tgt.filter((r) => r.emails.length).length, drafts: results.filter((r) => r.draft).length };
  emit('done', summary);
  return summary;
}

module.exports = { run, COUNTRIES };
