/**
 * 全文檢索（PhotoFts）的共用邏輯。
 *
 * 為什麼要有這個檔：FTS5 內建的斷詞器沒有一個能處理中文。unicode61 會把
 * 「京都之旅」整句當成一個 token，搜「京都」完全比不到；trigram 雖然支援任意
 * 語言的子字串比對，但查詢字串至少要 3 個字元，「京都」「東京」這種兩字詞就
 * 廢了，中文相簿等於不能用。
 *
 * 所以斷詞在寫入前用 JS 做：中文一律切成 bigram（兩字一組），
 * 「京都之旅」存成「京都 都之 之旅」，查詢字串跑同一個函式，unicode61 只負責
 * 照空白切開。代價是 FTS 表大約變成原文的兩倍大，但 title/description 都很短。
 *
 * 直接的後果是**不能用 SQL trigger 同步**（切分邏輯在 JS 裡），每一條會動到
 * 標題、描述、標籤、地點、相簿名的寫入路徑都要自己呼叫 ftsUpsert / ftsDelete。
 */

/** 需要 bigram 切分的文字：中日韓漢字、假名、諺文 */
const CJK_RANGES = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af';
const CJK_CHAR = new RegExp(`[${CJK_RANGES}]`);
/** 把輸入切成「連續 CJK」或「連續英數」的區段，其餘（標點、空白）直接丟掉 */
const RUN_PATTERN = new RegExp(`[${CJK_RANGES}]+|[A-Za-z0-9]+`, 'g');

/**
 * 把任意文字轉成 PhotoFts 收得下的 token 串。
 *
 * 「京都之旅 2024」→ 「京都 都之 之旅 2024」
 *
 * 單獨一個中文字（例如「京」或整段只有一個字）會原樣保留，查詢端會另外把它
 * 轉成前綴比對，否則它永遠比不到任何 bigram。
 */
export function bigram(input: string | null | undefined): string {
  if (!input) return '';
  const out: string[] = [];
  for (const run of input.match(RUN_PATTERN) ?? []) {
    if (!CJK_CHAR.test(run[0])) {
      out.push(run.toLowerCase());
    } else if (run.length === 1) {
      out.push(run);
    } else {
      for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    }
  }
  return out.join(' ');
}

/**
 * 一張照片在 FTS 裡的文件。**只放這張照片自己擁有的文字。**
 *
 * tags 併進來是為了讓打字搜尋一次命中標籤，不必碰 PhotoTag；加減標籤只影響
 * 那一張照片的 FTS 列，成本可以接受。
 *
 * 相簿名刻意不在這裡（見 migration 0004）：改一次相簿名就得重寫整本相簿每一張
 * 照片的 FTS 列。相簿名改成搜尋時直接比對 Album 表，那張表頂多幾百列。
 */
export interface FtsDoc {
  title?: string | null;
  description?: string | null;
  /** 該照片所有 Tag.name */
  tags?: string[] | null;
  place?: string | null;
}

/**
 * 把使用者輸入的關鍵字轉成 FTS5 的 MATCH 運算式。查不出東西時回 null
 * （例如只打了標點符號），呼叫端應該當成「沒有結果」而不是「沒有條件」。
 *
 * 每個 token 都用雙引號包成字面片語，這樣使用者打 `AND`、`*`、`(` 之類的
 * FTS5 語法字元不會變成運算式的一部分 —— bigram() 的輸出只含中日韓字元與
 * 英數字，包起來之後不可能跳脫。
 *
 * 兩個地方刻意用前綴比對（`*`）：
 *   - 單一中文字：它比不到任何 bigram token，只能靠前綴
 *   - 最後一個 token：邊打邊搜時「京都之」的「之」還沒打完，不該讓結果消失
 */
export function ftsMatchExpr(raw: string | null | undefined): string | null {
  const tokens = bigram(raw).split(' ').filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens
    .map((t, i) => {
      const prefix = i === tokens.length - 1 || (t.length === 1 && CJK_CHAR.test(t));
      return `"${t}"${prefix ? '*' : ''}`;
    })
    .join(' AND ');
}

/**
 * 一份文件在 PhotoFts 四個欄位裡實際要存的值，順序與 CREATE VIRTUAL TABLE 一致。
 *
 * 獨立出來是為了讓 Worker 的寫入路徑和一次性的 backfill 腳本共用同一份切分
 * 結果 —— 兩邊如果各自實作，索引裡的 token 就會跟查詢時產生的 token 對不上，
 * 而且不會有任何錯誤訊息，只會安靜地搜不到東西。
 */
export function ftsColumns(doc: FtsDoc): [string, string, string, string] {
  return [
    bigram(doc.title),
    bigram(doc.description),
    bigram((doc.tags ?? []).join(' ')),
    bigram(doc.place),
  ];
}

/**
 * D1 一次最多綁 100 個參數，`IN (?,?,…)` 一定要先切塊。index.ts 有同名的
 * chunkIds，這裡刻意不 import —— index.ts 會 import 這個檔，反過來拿會變成循環相依。
 */
function chunk<T>(items: T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * 把指定照片的 FTS 列改寫成資料庫現況。
 *
 * **這是唯一該被寫入路徑呼叫的函式。** 它自己回去讀 Photo / PhotoTag 的正規
 * 資料，所以呼叫端只要說「這幾張動過了」，不必知道動到的是標題、描述、地點
 * 還是標籤 —— 少了這層判斷，就少了一整類「改了某欄位但忘記同步」的錯誤。
 *
 * 先 DELETE 再 INSERT 而不是 UPDATE：同一組語句在「新增」與「編輯」兩種情境下
 * 都正確，呼叫端不必知道這張照片在 FTS 裡本來有沒有資料。
 */
export async function syncFtsForPhotos(db: D1Database, photoIds: number[]): Promise<void> {
  const ids = [...new Set(photoIds.map(Number))].filter((n) => Number.isFinite(n));
  if (ids.length === 0) return;

  for (const part of chunk(ids)) {
    const holes = part.map(() => '?').join(',');
    const [{ results: photos }, { results: tagRows }] = await db.batch<any>([
      db.prepare(
        `SELECT id, title, description, place_name FROM Photo WHERE id IN (${holes})`
      ).bind(...part),
      db.prepare(
        `SELECT pt.photo_id, t.name FROM PhotoTag pt
         JOIN Tag t ON t.id = pt.tag_id WHERE pt.photo_id IN (${holes})`
      ).bind(...part),
    ]);

    const tagsByPhoto = new Map<number, string[]>();
    for (const row of tagRows) {
      const list = tagsByPhoto.get(Number(row.photo_id)) ?? [];
      list.push(String(row.name));
      tagsByPhoto.set(Number(row.photo_id), list);
    }

    // 這一批裡查不到的 id 代表照片已經被刪掉，只要把 FTS 列清掉就好
    const statements = part.map((id) => db.prepare('DELETE FROM PhotoFts WHERE rowid = ?').bind(id));
    for (const p of photos) {
      statements.push(
        db.prepare(
          'INSERT INTO PhotoFts(rowid, title, description, tags, place) VALUES (?, ?, ?, ?, ?)'
        ).bind(
          Number(p.id),
          ...ftsColumns({
            title: p.title,
            description: p.description,
            tags: tagsByPhoto.get(Number(p.id)) ?? [],
            place: p.place_name,
          })
        )
      );
    }
    await db.batch(statements);
  }
}

/**
 * 把指定照片從 FTS 移除。刪除路徑專用 —— syncFtsForPhotos 也能處理已刪除的
 * 照片，但那要多花一次查詢確認它真的不見了。
 */
export async function deleteFtsForPhotos(db: D1Database, photoIds: number[]): Promise<void> {
  const ids = [...new Set(photoIds.map(Number))].filter((n) => Number.isFinite(n));
  if (ids.length === 0) return;
  for (const part of chunk(ids)) {
    await db.prepare(
      `DELETE FROM PhotoFts WHERE rowid IN (${part.map(() => '?').join(',')})`
    ).bind(...part).run();
  }
}
