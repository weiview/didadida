/**
 * 一次性把既有照片灌進 PhotoFts。
 *
 * 平常的維護不走這裡 —— Worker 的 POST /api/admin/rebuild-fts 才是正規路徑，
 * 它帶 cursor 分批、會受身分驗證保護。這支腳本存在的理由只有一個：本機
 * miniflare 的資料庫沒有辦法方便地取得 admin token，而 Phase 0 的 backfill
 * 必須在本機先驗過。
 *
 * 切分邏輯是從 src/fts.ts 直接 import 的，不在這裡重寫 —— 兩邊如果分岔，
 * 索引裡的 token 會跟查詢時產生的 token 對不上，而且不會報錯，只會安靜地
 * 搜不到東西。
 *
 * 用法（在 apps/backend 底下）：
 *   node --experimental-strip-types scripts/backfill-fts.mjs
 *   node --experimental-strip-types scripts/backfill-fts.mjs --remote --env dev
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ftsColumns } from '../src/fts.ts';

const DB = 'didadida-db';
const backendRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// 直接叫 wrangler 的 JS 進入點，不透過 npx。npx 在 Windows 上是 .cmd，
// execFileSync 要嘛得開 shell（多行 SQL 與含空白的路徑會被重新解析而爛掉），
// 要嘛會因為 Node 對 .bat/.cmd 的防護直接 EINVAL。走 node 就沒有這些問題。
const WRANGLER = createRequire(import.meta.url).resolve('wrangler/bin/wrangler.js');

const passthrough = process.argv.slice(2);
const isRemote = passthrough.includes('--remote');
// --remote 與 --local 是互斥的，沒指定就預設打本機
const target = isRemote ? [] : ['--local'];

function wrangler(args, opts = {}) {
  return execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', DB, ...target, ...passthrough, ...args], {
    cwd: backendRoot,
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  });
}

function d1(sql) {
  const out = wrangler(['--json', '--command', sql], { encoding: 'utf8' });
  // wrangler 會在 JSON 前面印一堆橫幅與更新提醒，從第一個 '[' 開始取
  const rows = JSON.parse(out.slice(out.indexOf('[')))[0].results;
  return rows.map(unnull);
}

/**
 * wrangler d1 execute --json 會把 SQL 的 NULL 序列化成**字串** `"null"`，不是
 * JSON 的 null。不還原的話 bigram('null') 會產生 token「null」，每張沒填地點或
 * 描述的照片都會被索引成含有「null」這個字 —— 搜 null 就會撈出一堆不相干的
 * 照片，而 Worker 走 D1 binding（拿到的是真正的 null）存的是空字串，兩邊的
 * 索引內容還會不一致。
 *
 * 代價：標題真的就叫「null」的照片會被當成沒有標題。這裡選擇接受。
 */
function unnull(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = v === 'null' ? null : v;
  return out;
}

/** SQL 字面值。bigram() 的輸出只含中日韓字元、英數字與空白，理論上不會有引號，還是照規矩跳脫 */
const lit = (s) => `'${String(s ?? '').replace(/'/g, "''")}'`;

// 相簿名不進 FTS（見 migration 0004），所以這裡不必 join Album
const photos = d1(`SELECT id, title, description, place_name FROM Photo ORDER BY id`);
const tagRows = d1(`SELECT pt.photo_id, t.name FROM PhotoTag pt JOIN Tag t ON t.id = pt.tag_id`);

const tagsByPhoto = new Map();
for (const row of tagRows) {
  const list = tagsByPhoto.get(row.photo_id) ?? [];
  list.push(row.name);
  tagsByPhoto.set(row.photo_id, list);
}

const lines = ['DELETE FROM PhotoFts;'];
for (const p of photos) {
  const cols = ftsColumns({
    title: p.title,
    description: p.description,
    tags: tagsByPhoto.get(p.id) ?? [],
    place: p.place_name,
  });
  lines.push(
    `INSERT INTO PhotoFts(rowid, title, description, tags, place) VALUES (${p.id}, ${cols.map(lit).join(', ')});`
  );
}

const file = join(mkdtempSync(join(tmpdir(), 'didadida-fts-')), 'backfill.sql');
writeFileSync(file, lines.join('\n'), 'utf8');

// D1 每天只能寫 100K 列，一張照片約 5 列。真的要灌幾萬張時應該改走
// /api/admin/rebuild-fts 的分批路徑，而不是在這裡一次送完。
console.log(`照片 ${photos.length} 張，準備寫入 ${lines.length - 1} 筆 FTS 文件`);
if (photos.length > 15000) {
  console.error('超過 15000 張，一次寫完會撞到 D1 每日寫入額度，請改用 /api/admin/rebuild-fts 分批跑');
  process.exit(1);
}

wrangler(['--file', file], { stdio: 'inherit' });
