// 千葉県の新規開店情報（予約業態）を Google ニュース検索RSS から収集し、
// data/stores.json を更新するスクリプト。GitHub Actions から毎朝実行される想定。
//
// 依存パッケージなし（Node 20+ の組み込み fetch のみ使用）。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, '..', 'data', 'stores.json');

// ── 収集対象ジャンル（予約ニーズの高い飲食業態。チェーンは後段で除外） ──
const GENRE_GROUPS = [
  { label: '居酒屋・ダイニング系', keywords: ['居酒屋', 'ダイニング', 'バル', 'レストラン', 'ビストロ'] },
  { label: '専門料理系',           keywords: ['焼肉', '寿司', '割烹', '懐石', '会席', '中華', '韓国料理', 'イタリアン', 'フレンチ'] },
  { label: 'カフェ・バー系',       keywords: ['カフェ', 'バー', 'スナック', '創作料理'] },
];

const OPEN_SIGNAL = ['オープン', '新規開店', 'グランドオープン', 'プレオープン'];

// ── 大手チェーン（既にネット予約導入済み・優先度が低いため除外） ──
const CHAIN_BLOCKLIST = [
  'マクドナルド', 'モスバーガー', 'バーガーキング', 'ロッテリア', 'ケンタッキー', 'KFC',
  'ミスタードーナツ', 'スターバックス', 'スタバ', 'ドトール', 'タリーズ', 'エクセルシオール',
  'サンマルクカフェ', 'コメダ珈琲', '星乃珈琲', '上島珈琲',
  'すき家', '吉野家', '松屋', 'なか卯', '餃子の王将', '日高屋', '丸亀製麺', 'はなまるうどん',
  '富士そば', 'てんや', 'かっぱ寿司', 'スシロー', 'くら寿司', 'はま寿司', 'がってん寿司',
  'ペッパーランチ', 'ステーキのどん', 'いきなりステーキ',
  'サイゼリヤ', 'ガスト', 'バーミヤン', 'ジョナサン', 'デニーズ', 'ロイヤルホスト', 'ジョイフル', 'ココス',
  'すかいらーく', 'ペルティカ',
  'びっくりドンキー', '鳥貴族', '磯丸水産', '白木屋', '笑笑', '魚民', '土間土間', '千年の宴',
  '塚田農場', 'わたみん家', '和民', '庄や', 'つぼ八', '日本海庄や',
  'セブンイレブン', 'ファミリーマート', 'ローソン', 'ユニクロ', '無印良品', 'イオン', 'ドン・キホーテ',
];

// ── エリアタグ付け用の市区町村（長い名称を優先してマッチ） ──
const CHIBA_AREAS = [
  '千葉市中央区', '千葉市稲毛区', '千葉市美浜区', '千葉市若葉区', '千葉市緑区', '千葉市花見川区',
  '銚子市', '市川市', '船橋市', '館山市', '木更津市', '松戸市', '野田市', '茂原市', '成田市', '佐倉市',
  '東金市', '旭市', '習志野市', '柏市', '勝浦市', '市原市', '流山市', '八千代市', '我孫子市', '鴨川市',
  '鎌ケ谷市', '君津市', '富津市', '浦安市', '四街道市', '袖ケ浦市', '八街市', '印西市', '白井市', '富里市',
  '南房総市', '匝瑳市', '香取市', '山武市', 'いすみ市', '大網白里市',
  '酒々井町', '栄町', '神崎町', '多古町', '東庄町', '九十九里町', '芝山町', '横芝光町',
  '一宮町', '睦沢町', '長生村', '白子町', '長柄町', '長南町', '大多喜町', '御宿町', '鋸南町',
];

const FEED_TTL_DAYS = 60; // 何日分の情報を一覧に残すか
const FETCH_TIMEOUT_MS = 15000;

function buildQueries() {
  const openPart = `(${OPEN_SIGNAL.join(' OR ')})`;
  return GENRE_GROUPS.map(g => ({
    label: g.label,
    query: `千葉県 ${openPart} (${g.keywords.join(' OR ')})`,
  }));
}

function decodeEntities(str) {
  return str
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function stripTags(str) {
  return decodeEntities(str.replace(/<[^>]*>/g, '')).trim();
}

function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1];
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
    const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1];
    if (!title || !link) continue;
    items.push({
      rawTitle: stripTags(title),
      link: stripTags(link),
      pubDate: pubDate ? stripTags(pubDate) : null,
      source: source ? stripTags(source) : null,
    });
  }
  return items;
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ChibaShintenBot/1.0)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function detectArea(title) {
  for (const area of CHIBA_AREAS) {
    if (title.includes(area)) return area;
  }
  return '';
}

function detectGenres(title) {
  const all = GENRE_GROUPS.flatMap(g => g.keywords);
  return [...new Set(all.filter(k => title.includes(k)))];
}

function isChain(title) {
  return CHAIN_BLOCKLIST.some(name => title.includes(name));
}

// Googleニュースのタイトルは「見出し - 出典サイト名」形式のことが多い
function splitTitleSource(rawTitle, sourceField) {
  if (sourceField) return { title: rawTitle.replace(new RegExp(`\\s*-\\s*${escapeRe(sourceField)}$`), '').trim(), source: sourceField };
  const m = rawTitle.match(/^(.*)\s-\s([^-]+)$/);
  if (m) return { title: m[1].trim(), source: m[2].trim() };
  return { title: rawTitle, source: '' };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function collect() {
  const queries = buildQueries();
  const collected = [];
  const runLog = [];

  for (const { label, query } of queries) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`;
    try {
      const xml = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      const items = parseRssItems(xml);
      runLog.push({ label, query, ok: true, count: items.length });
      for (const it of items) {
        const { title, source } = splitTitleSource(it.rawTitle, it.source);
        collected.push({ title, source, link: it.link, pubDate: it.pubDate, genreGroup: label });
      }
    } catch (err) {
      runLog.push({ label, query, ok: false, error: String(err && err.message || err) });
      console.warn(`[warn] query failed: ${label} — ${err}`);
    }
  }
  return { collected, runLog };
}

function normalizeForDedupe(title) {
  return title.replace(/\s+/g, '').replace(/[！!？?「」『』【】\[\]（）()]/g, '');
}

async function loadExisting() {
  try {
    const raw = await readFile(OUT_PATH, 'utf-8');
    const json = JSON.parse(raw);
    return Array.isArray(json.items) ? json.items : [];
  } catch {
    return [];
  }
}

async function main() {
  const { collected, runLog } = await collect();

  const filtered = [];
  const seenLinks = new Set();
  const seenTitles = new Set();
  for (const it of collected) {
    if (!it.title) continue;
    if (isChain(it.title)) continue;
    if (seenLinks.has(it.link)) continue;
    const norm = normalizeForDedupe(it.title);
    if (seenTitles.has(norm)) continue;
    seenLinks.add(it.link);
    seenTitles.add(norm);
    filtered.push({
      title: it.title,
      link: it.link,
      source: it.source || '',
      pubDate: it.pubDate,
      area: detectArea(it.title),
      genres: detectGenres(it.title),
      firstSeenAt: new Date().toISOString(),
    });
  }

  const existing = (await loadExisting()).filter(it => !isChain(it.title));
  const merged = new Map();
  for (const it of existing) merged.set(it.link, it);
  for (const it of filtered) {
    if (merged.has(it.link)) {
      // 既存分は firstSeenAt を保持
      merged.set(it.link, { ...it, firstSeenAt: merged.get(it.link).firstSeenAt });
    } else {
      merged.set(it.link, it);
    }
  }

  const cutoff = Date.now() - FEED_TTL_DAYS * 24 * 60 * 60 * 1000;
  let items = [...merged.values()].filter(it => {
    const d = it.pubDate ? Date.parse(it.pubDate) : Date.parse(it.firstSeenAt);
    return Number.isFinite(d) ? d >= cutoff : true;
  });
  items.sort((a, b) => {
    const da = Date.parse(a.pubDate || a.firstSeenAt) || 0;
    const db = Date.parse(b.pubDate || b.firstSeenAt) || 0;
    return db - da;
  });
  items = items.slice(0, 300);

  // 全クエリが失敗し、かつ既存データがあった場合は上書きせず既存を維持する
  const anyOk = runLog.some(r => r.ok);
  if (!anyOk && existing.length > 0) {
    console.warn('[warn] all queries failed; keeping existing data/stores.json unchanged');
    return;
  }

  const out = {
    generatedAt: new Date().toISOString(),
    ttlDays: FEED_TTL_DAYS,
    runLog,
    itemCount: items.length,
    items,
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  console.log(`Wrote ${items.length} items to ${OUT_PATH}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
