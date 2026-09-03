// 地圖上那台載著大頭的小車。**取代了原本自己畫的 canvas 小車**（更早之前是飛碟）。
//
// 現在車身是使用者給的兩張去背插畫（`public/car-solo.webp`／`car-family.webp`），
// 圖上原本有綠色定位點標著「頭要放這裡」—— 打包時已經把點補掉，脖子的位置量進
// 下面那張 `SPRITES` 表裡。造型是刻意誇張的比例：車子一台、頭大得離譜。
// ⚠️ **兩張是不同的畫**（長寬比、座位、影子都不一樣），所以那張表是逐張存的。
//
// ── 這裡分成兩種圖 ────────────────────────────────────────────────
//   車   `createCarImage()`    貼上去的插畫 ＋ 整台輕輕上下浮動 ＋ 地上一塊影子。
//                              maplibre 的 StyleImageInterface：每畫一幀呼叫一次 render()。
//   頭   `buildAvatarHead()`   從使用者的去背頭像現做（一圈白邊 ＋ 一點陰影，
//        `createAlienHead()`   **沒有顏色的外框**）。**GIF 會動**（見 lib/gifDecode.ts）。
//                              沒設頭像的人是會眨眼的外星人。
//
// 車與頭是**兩層**、每一幀各自定位（見 FootprintMap 的 project／unproject 那段），
// 不合成一張圖：不然「三個人同車」得為每一種人數×每一組頭像各做一張貼圖。

import { decodeGif, looksLikeGif } from './gifDecode';

/** maplibre 的 addImage 只認得這個形狀。宣告在這裡免得為了型別把整包 maplibre 拉進來 */
export interface AnimatedImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
  onAdd?(): void;
  render(): boolean;
}

/** 靜態圖。addImage 也吃這個形狀（就是少了 render） */
export interface StaticImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/* ────────────────────────── 車 ────────────────────────── */

/** 兩張插畫。一個人出門用 solo，合體（兩個人以上）用 family */
export type CarSprite = 'solo' | 'family';

/** 座位。命名是「這台車上的位置」，誰坐哪裡由 FootprintMap 決定 */
export type Seat = 'passenger' | 'driver' | 'rear';

/**
 * 車的貼圖解析度倍率。pixelRatio 3 → 一個人的車在畫面上是 150×103 CSS px。
 *
 * ⚠️⚠️ **這個數字要跟 HEAD_SIZE 一起看** —— 使用者要的視覺是「大頭狗開車」，
 * 也就是頭大到不成比例。所以車刻意畫小（一顆頭 116 CSS px 對上 150 CSS px 寬的
 * 車身），**車變小比頭變大有效**：頭再放大會糊（來源頭像只有 256px），
 * 而且座位間距是跟著車寬等比縮的，頭一放大就整團疊死。
 *
 * **要改顯示大小請改這個數字，不要改 `SPRITES` 裡的 w／h** —— 後者是插畫本身的
 * 長寬比，一動就得整組重算。
 */
export const CAR_PIXEL_RATIO = 3;
/** 整台車上下浮動的幅度（裝置像素，±）。引擎在抖，不是在跳 */
const BOB = 6;
/** 插畫底下留給影子的空間 */
const GROUND = 15;

/**
 * 兩張插畫各自的尺寸、座位與影子。
 *
 * ⚠️⚠️ **兩張是不同的畫，不是同一台車的兩個版本**（2026-09-03 換圖之後）：
 * 長寬比不一樣（solo 1.56／family 2.14 —— 合體那張後面拖著一台娃娃車），
 * 所以尺寸、座位、影子**通通得分開存**，不可以再共用一份 `SEATS`。
 * 兩張的**車身**在畫面上大小差不多，family 多出來的寬度全是那台拖車。
 *
 * `seats` 是三個座位**脖子的位置**，正規化成插畫寬高的比例（插畫**車頭朝左**）。
 * ⚠️⚠️ 標的是「**下巴要落在哪裡**」，不是頭的中心。插畫上那幾個人是沒有頭的
 * 身體，領口上留著一截脖子 —— 這裡存的就是那截脖子的**上緣**。所以頭那一層是
 * `icon-anchor: 'bottom'`，下巴壓在這一點上、再往下蓋一點點（見 FootprintMap
 * 的 `NECK_OVERLAP`）。**頭的大小會一直被調，脖子不會**，所以錨在脖子上；
 * 換一張同構圖的插畫只要重量這幾個小數。
 *
 * `shadow` 是地上那塊影子的中心與半徑（同樣是寬度的比例）——
 * ⚠️ family 的中心**不在圖片正中央**：影子只鋪在車身底下，鋪到拖車那邊
 * 看起來會像整台車陷進地裡。
 */
const SPRITES: Record<CarSprite, {
  src: string;
  /** 插畫本身的寬高（裝置像素） */
  w: number;
  h: number;
  seats: Record<Seat, { x: number; y: number }>;
  shadow: { cx: number; rx: number };
}> = {
  solo: {
    src: '/car-solo.webp',
    w: 450, h: 289, // 840×540 等比縮下來
    seats: {
      passenger: { x: 0.40357, y: 0.09630 },
      driver:    { x: 0.69762, y: 0.18704 }, // 握方向盤的那位（solo 只畫了他）
      rear:      { x: 0.82798, y: 0.15926 },
    },
    shadow: { cx: 0.5, rx: 0.3 },
  },
  family: {
    src: '/car-family.webp',
    w: 585, h: 273, // 2911×1359 等比縮下來；車身寬度跟 solo 對齊，其餘是拖車
    seats: {
      passenger: { x: 0.29096, y: 0.10817 }, // 粉衣服拿相機的＝副駕
      driver:    { x: 0.50601, y: 0.18764 }, // 黃衣服握方向盤的＝駕駛
      rear:      { x: 0.88990, y: 0.15453 }, // ⚠️ 後面那台娃娃車裡的寶寶，不是車內的兒童座椅
    },
    shadow: { cx: 0.36, rx: 0.22 },
  },
};

/** 那張插畫烤成貼圖之後的完整尺寸（裝置像素，含浮動與影子留的空間） */
export function carSize(sprite: CarSprite): { w: number; h: number } {
  const s = SPRITES[sprite];
  return { w: s.w, h: s.h + BOB + GROUND };
}

/** 那張插畫上三個座位的脖子（正規化座標，車頭朝左） */
export function seatsOf(sprite: CarSprite): Record<Seat, { x: number; y: number }> {
  return SPRITES[sprite].seats;
}

/**
 * 這一瞬間整台車浮多高（裝置像素，往上是負的）。
 *
 * ⚠️ **車身與頭共用這一支**：車在 car.ts 裡畫、頭在 FootprintMap 裡定位，
 * 兩邊各自呼叫一次 `performance.now()` 會差幾毫秒 —— 換算下來不到 0.1px，
 * 但函式一定要是同一支，不然節奏對不起來，頭會在車上抖。
 */
export function carBob(t: number): number {
  return Math.sin(t * 5.5) * BOB;
}

/**
 * 某個座位的**脖子**相對於「圖片底部中央」（icon-anchor: 'bottom' 的錨點）的位移，
 * 單位是 **CSS px**。呼叫端把它加到 `map.project()` 的結果上，頭那一層也錨在底部，
 * 於是下巴就落在脖子上（頭再怎麼縮放，下巴都還在同一個點）。
 *
 * `flip` 跟 `createCarImage` 同一個意思：true ＝ 車頭朝左（插畫原本的方向），
 * false ＝ 鏡射成朝右，這時候 x 要換成 `1 - x`。
 */
export function seatOffset(sprite: CarSprite, seat: Seat, flip: boolean, t: number): { dx: number; dy: number } {
  const def = SPRITES[sprite];
  const { w, h } = carSize(sprite);
  const s = def.seats[seat];
  const nx = flip ? s.x : 1 - s.x;
  const px = nx * w;
  const py = (h - GROUND - def.h) + carBob(t) + s.y * def.h;
  return {
    dx: (px - w / 2) / CAR_PIXEL_RATIO,
    dy: (py - h) / CAR_PIXEL_RATIO, // 負的（錨點在圖片底部）
  };
}

/**
 * 插畫只載一次，全站共用。
 *
 * ⚠️ 載完要叫一次 `triggerRepaint()` —— 在那之前 render() 只畫得出影子，
 * 地圖沒有理由自己再畫一幀，車會一直不出現。
 */
const spriteCache = new Map<string, HTMLImageElement>();
function loadSprite(sprite: CarSprite, onReady: () => void): HTMLImageElement {
  const src = SPRITES[sprite].src;
  const hit = spriteCache.get(src);
  if (hit) {
    if (!hit.complete) hit.addEventListener('load', onReady, { once: true });
    return hit;
  }
  const img = new Image();
  img.decoding = 'async';
  img.addEventListener('load', onReady, { once: true });
  img.src = src;
  spriteCache.set(src, img);
  return img;
}

/**
 * 造一台會動的車給 map.addImage 用。
 *
 * @param triggerRepaint 地圖的 triggerRepaint —— 不呼叫它就只會畫一幀
 * @param isAnimating    現在該不該動。暫停時回 false，地圖停在最後一幀不再重畫
 * @param sprite         一個人 'solo'／合體 'family'
 * @param flip           車頭朝左（插畫原本的方向）
 */
export function createCarImage(
  triggerRepaint: () => void,
  isAnimating: () => boolean,
  sprite: CarSprite,
  flip: boolean,
): AnimatedImage {
  const settle = makeSettler(triggerRepaint, isAnimating);
  const def = SPRITES[sprite];
  const { w: W, h: H } = carSize(sprite);
  /** 沒有浮動時插畫左上角的 y */
  const spriteTop = H - GROUND - def.h;
  let ctx: CanvasRenderingContext2D | null = null;
  let img: HTMLImageElement | null = null;

  return {
    width: W,
    height: H,
    data: new Uint8Array(W * H * 4),
    onAdd() {
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      img = loadSprite(sprite, triggerRepaint);
    },
    render() {
      if (!ctx) return false;
      const c = ctx;
      // 用絕對時間而不是「從 onAdd 起算」：好幾台車各自算會各浮各的，
      // 同一幀裡兩台車的相位不同看起來很怪
      const t = performance.now() / 1000;
      c.clearRect(0, 0, W, H);

      // 地上的影子。**不跟著浮動**，車彈起來影子才會「留在地上」。
      // ⚠️ 鏡射的時候影子也要跟著換邊（family 的影子不在正中央）
      const scx = (flip ? def.shadow.cx : 1 - def.shadow.cx) * W;
      c.fillStyle = 'rgba(15,23,42,0.22)';
      c.beginPath();
      c.ellipse(scx, H - GROUND * 0.55, W * def.shadow.rx, GROUND * 0.36, 0, 0, Math.PI * 2);
      c.fill();

      if (img && img.complete && img.naturalWidth > 0) {
        c.save();
        if (!flip) {
          // 插畫本來就朝左，朝右那一版靠鏡射（maplibre 沒辦法逐 feature 鏡射，
          // 所以左右各做一張圖）
          c.translate(W, 0);
          c.scale(-1, 1);
        }
        c.drawImage(img, 0, spriteTop + carBob(t), W, def.h);
        c.restore();
      }

      this.data = c.getImageData(0, 0, W, H).data;
      settle();
      return true;
    },
  };
}

/**
 * 停著的時候也要**再要一次重繪**。
 *
 * ⚠️⚠️ maplibre 這一輪拿到的還是上一次的貼圖 —— `render()` 寫進 `this.data` 的
 * 內容要等**下一次**重繪才會真的畫到畫面上。動畫在跑的時候每一格都有下一次，
 * 所以看不出來；停著的時候沒有下一次，於是頭永遠停在 `data` 的初始值
 * （外星人那顆是全透明的空陣列＝**畫面上只有車、沒有頭**）。
 *
 * 所以「不在播動畫」時，畫完要補一次 `triggerRepaint()`，而且**只補一次** ——
 * 每次都補就變成常駐 rAF，整張地圖會一直重繪。`settled` 就是那個一次性的旗標，
 * 動畫一開始跑就放掉（那時每一格本來就會排下一次）。
 */
function makeSettler(triggerRepaint: () => void, isAnimating: () => boolean) {
  let settled = false;
  return () => {
    if (isAnimating()) {
      settled = false;
      triggerRepaint();
    } else if (!settled) {
      settled = true;
      triggerRepaint();
    }
  };
}

/* ────────────────────────── 頭 ────────────────────────── */

/**
 * 頭的貼圖尺寸（裝置像素）。pixelRatio 2 → 畫面上 116 CSS px，而整台車才 180 CSS px 寬
 * —— 比座位大得離譜，就是要誇張（使用者的原話是「大頭狗開車」）。
 *
 * ⚠️ **上限是來源頭像的 256px**：`HEAD_BOX` 超過它就是把小圖放大，邊緣會糊。
 * 還要更誇張的話請去縮 `CAR_PIXEL_RATIO`（車變小），不要再往上加這個數字。
 */
export const HEAD_SIZE = 232;
export const HEAD_PIXEL_RATIO = 2;

/**
 * 頭外面那一圈白邊的粗細（裝置像素）。
 *
 * ⚠️⚠️ **這一圈只能是白的，不要再加軌跡色**（2026-09-02 使用者要求拿掉：
 * 「大頭不要有顏色的框框」）。白邊留著是因為底圖（positron）幾乎是白的，
 * 深色頭髮的頭不描一圈就會糊進路網 —— 它是可讀性，不是「誰是誰」。
 * 代價是**合體時頭上看不出誰是誰了**，那件事線的顏色與圖例本來就在講。
 */
const HALO = 6;
/** 白邊外面那點陰影的擴散半徑 */
const SHADOW = 8;
/**
 * 頭像本體的範圍：四周留給白邊與陰影。
 * ⚠️ `HEAD_PAD` 這個數字**不要順手改小**（拿掉顏色圈時也刻意維持 18）——
 * `HEAD_BOX` 一變頭就跟著變大，而 FootprintMap 的 `HEAD_BOTTOM_PAD`
 * （下巴要往下推多少才碰得到脖子）是照這個值算出來的。
 */
const HEAD_PAD = 18;
const HEAD_BOX = HEAD_SIZE - HEAD_PAD * 2;

/** 一格頭（已經加好外框的 RGBA）＋ 它要停留多久 */
interface BakedFrame { data: Uint8ClampedArray; delayMs: number; }

/**
 * 把頭像左右翻過來，翻完的那一張才交給 bakeHead 當來源。
 *
 * ⚠️⚠️ **maplibre 沒有辦法把一張 icon 鏡射**（沒有負的 icon-size、也沒有
 * mirror 屬性），所以朝右的那一版是**另外烤一張圖**、掛在另一個 image id 上
 * （見 FootprintMap 的 `ensureHead`）。一個人最多兩張，貼圖快取扛得住。
 *
 * 尺寸直接壓成 HEAD_BOX：來源可能是 256px 的頭像，也可能是一格 GIF，
 * 統一成同一個大小之後底下那一整套（描邊、陰影）一個字都不用改。
 */
function mirrorSource(src: CanvasImageSource): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = HEAD_BOX;
  c.height = HEAD_BOX;
  const x = c.getContext('2d')!;
  x.imageSmoothingQuality = 'high';
  x.translate(HEAD_BOX, 0);
  x.scale(-1, 1);
  x.drawImage(src, 0, 0, HEAD_BOX, HEAD_BOX);
  return c;
}

/**
 * 把一張去背頭像烤成地圖上的一顆大頭：外面一圈白邊 ＋ 一點陰影。
 *
 * canvas 沒有「描 alpha 邊」這種功能，只能把剪影往十六個方向各畫一次再把原圖
 * 蓋上去。十六個夠密了，再多只是拖慢，再少邊緣會出現扇形缺口。
 *
 * `mirror` ＝ 這張臉朝的方向跟車頭相反，要先左右翻過來（見 mirrorSource）。
 */
function bakeHead(src: CanvasImageSource, mirror = false): Uint8ClampedArray {
  if (mirror) src = mirrorSource(src);
  const mask = (fill: string) => {
    const c = document.createElement('canvas');
    c.width = HEAD_SIZE;
    c.height = HEAD_SIZE;
    const x = c.getContext('2d')!;
    x.drawImage(src, HEAD_PAD, HEAD_PAD, HEAD_BOX, HEAD_BOX);
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = fill;
    x.fillRect(0, 0, HEAD_SIZE, HEAD_SIZE);
    return c;
  };
  const white = mask('#ffffff');

  const out = document.createElement('canvas');
  out.width = HEAD_SIZE;
  out.height = HEAD_SIZE;
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';

  const stamp = (layer: HTMLCanvasElement, r: number) => {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      ctx.drawImage(layer, Math.cos(a) * r, Math.sin(a) * r);
    }
  };

  ctx.save();
  ctx.shadowColor = 'rgba(15,23,42,0.35)';
  ctx.shadowBlur = SHADOW;
  ctx.shadowOffsetY = SHADOW * 0.4;
  stamp(white, HALO);
  ctx.restore();
  ctx.drawImage(src, HEAD_PAD, HEAD_PAD, HEAD_BOX, HEAD_BOX);

  return ctx.getImageData(0, 0, HEAD_SIZE, HEAD_SIZE).data;
}

/** 把一格 GIF（RGBA）塞進一張 canvas，好交給 bakeHead 當來源 */
function frameToCanvas(data: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  // 走 createImageData ＋ set 而不是 new ImageData(data, …)：後者的型別要求
  // 底層 buffer 剛好是 ArrayBuffer，而解 GIF 出來的那個是 ArrayBufferLike
  const img = ctx.createImageData(w, h);
  img.data.set(data);
  ctx.putImageData(img, 0, 0);
  return c;
}

/** 把烤好的那幾格接成一張會動的 maplibre 圖 */
function framesToImage(
  frames: BakedFrame[],
  triggerRepaint: () => void,
  isAnimating: () => boolean,
): AnimatedImage {
  const settle = makeSettler(triggerRepaint, isAnimating);
  const total = frames.reduce((s, f) => s + f.delayMs, 0) || 100;
  const t0 = performance.now();
  let shown = -1;
  return {
    width: HEAD_SIZE,
    height: HEAD_SIZE,
    data: frames[0].data,
    render() {
      let at = (performance.now() - t0) % total;
      let i = 0;
      while (i < frames.length - 1 && at >= frames[i].delayMs) { at -= frames[i].delayMs; i++; }
      settle();
      // 同一格就回 false —— maplibre 才不會白白重上傳一次貼圖
      if (i === shown) return false;
      shown = i;
      this.data = frames[i].data;
      return true;
    },
  };
}

/**
 * 把去背頭像做成地圖上的一顆大頭。**GIF 會動**。
 *
 * 位元組是自己 `fetch` 回來的，不是丟給 `<img src>` —— 兩個理由：
 * ① 要先看得出這是不是 GIF（canvas 畫 GIF 只畫得到第一格）；
 * ② 順便閃掉跨網域畫布污染（API 在另一個 origin，後端有回
 *    `Access-Control-Allow-Origin: *`，而 fetch 出來的位元組本來就不會污染畫布）。
 *
 * 動圖是**先把每一格都烤好**（外框那十六次描邊很貴），之後 render() 只是照時間
 * 換一塊 data。格數有上限（見 gifDecode 的 maxFrames）—— 一格 176²×4 ≈ 124KB。
 */
export async function buildAvatarHead(
  url: string,
  mirror = false,
  hooks?: { triggerRepaint: () => void; isAnimating: () => boolean },
): Promise<StaticImage | AnimatedImage> {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`頭像載不下來 ${res.status}`);
  const buf = await res.arrayBuffer();

  if (hooks && looksLikeGif(buf)) {
    const gif = decodeGif(buf);
    if (gif && gif.frames.length > 1) {
      const baked = gif.frames.map((f) => ({
        data: bakeHead(frameToCanvas(f.data, gif.width, gif.height), mirror),
        delayMs: f.delayMs,
      }));
      return framesToImage(baked, hooks.triggerRepaint, hooks.isAnimating);
    }
    // 解不開／只有一格：照樣走下面那條靜態路，瀏覽器自己解得了第一格
  }

  const bitmap = await createImageBitmap(new Blob([buf]));
  const data = bakeHead(bitmap, mirror);
  bitmap.close?.();
  return { width: HEAD_SIZE, height: HEAD_SIZE, data };
}

/**
 * 沒設頭像的人坐的是外星人 —— 從退休的飛碟座艙裡撿回來的那一顆綠頭，
 * 連每 3.4 秒眨一次眼都留著。
 *
 * 這顆是**會動的**（要眨眼），所以走 StyleImageInterface 而不是靜態點陣圖。
 * 拿掉顏色外框之後**全站只有一張**（以前是每個軌跡色各一張）。
 */
export function createAlienHead(
  triggerRepaint: () => void,
  isAnimating: () => boolean,
): AnimatedImage {
  const settle = makeSettler(triggerRepaint, isAnimating);
  let ctx: CanvasRenderingContext2D | null = null;

  const draw = (c: CanvasRenderingContext2D, t: number) => {
    c.clearRect(0, 0, HEAD_SIZE, HEAD_SIZE);

    const cx = HEAD_SIZE / 2;
    const cy = HEAD_SIZE * 0.5;
    const headR = HEAD_SIZE * 0.34;

    // 頭。形狀已知，白邊直接一次 stroke 就好 —— 不必像頭像那樣堆十六層剪影
    c.save();
    c.shadowColor = 'rgba(15,23,42,0.35)';
    c.shadowBlur = SHADOW;
    c.shadowOffsetY = SHADOW * 0.4;
    c.strokeStyle = '#ffffff';
    c.lineWidth = HALO * 2;
    c.beginPath();
    c.ellipse(cx, cy, headR, headR * 1.14, 0, 0, Math.PI * 2);
    c.stroke();
    c.restore();
    // 路徑不在 save/restore 的狀態堆裡，restore 之後還是同一個橢圓
    c.fillStyle = '#6ee7a5';
    c.fill();

    // 每 3.4 秒眨一次
    const blinking = t % 3.4 < 0.13;
    const eyeDx = headR * 0.42;
    const eyeR = headR * 0.3;
    for (const dx of [-eyeDx, eyeDx]) {
      c.fillStyle = '#0f172a';
      c.beginPath();
      if (blinking) c.ellipse(cx + dx, cy, eyeR, eyeR * 0.16, 0, 0, Math.PI * 2);
      else c.ellipse(cx + dx, cy, eyeR, eyeR * 1.2, 0, 0, Math.PI * 2);
      c.fill();
      if (!blinking) {
        c.fillStyle = '#ffffff';
        c.beginPath();
        c.arc(cx + dx - eyeR * 0.28, cy - eyeR * 0.4, eyeR * 0.34, 0, Math.PI * 2);
        c.fill();
      }
    }
  };

  return {
    width: HEAD_SIZE,
    height: HEAD_SIZE,
    data: new Uint8Array(HEAD_SIZE * HEAD_SIZE * 4),
    onAdd() {
      const canvas = document.createElement('canvas');
      canvas.width = HEAD_SIZE;
      canvas.height = HEAD_SIZE;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    },
    render() {
      if (!ctx) return false;
      draw(ctx, performance.now() / 1000);
      this.data = ctx.getImageData(0, 0, HEAD_SIZE, HEAD_SIZE).data;
      settle();
      return true;
    },
  };
}
