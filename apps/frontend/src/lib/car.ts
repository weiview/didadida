// 地圖上那台載著大頭的小車。**取代了原本自己畫的 canvas 小車**（更早之前是飛碟）。
//
// 現在車身是使用者給的去背插畫（`public/car-solo.webp`／`car-family.webp`），
// 圖上原本有三顆綠色定位點標著「頭要放這裡」—— 打包時已經把點補掉，
// 位置留在下面那張 `SEATS` 表裡。造型是刻意誇張的比例：車子一台、頭大得離譜。
//
// ── 這裡分成兩種圖 ────────────────────────────────────────────────
//   車   `createCarImage()`    貼上去的插畫 ＋ 整台輕輕上下浮動 ＋ 地上一塊影子。
//                              maplibre 的 StyleImageInterface：每畫一幀呼叫一次 render()。
//   頭   `buildAvatarHead()`   從使用者的去背頭像現做（自己軌跡色的一圈外框 ＋
//        `createAlienHead()`   外面再一圈白邊）。**GIF 會動**（見 lib/gifDecode.ts）。
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

const SPRITE_SRC: Record<CarSprite, string> = {
  solo: '/car-solo.webp',
  family: '/car-family.webp',
};

/**
 * 車的貼圖尺寸（裝置像素）。pixelRatio 2 → 畫面上 260×179 CSS px。
 *
 * ⚠️ **兩張插畫在畫面上一樣大**（同一個裁切框做出來的，座位座標逐點對得上）——
 * 一個人的車不該因為他落單就縮小，而且合體／散開的那一瞬間頭才不會跳。
 */
export const CAR_PIXEL_RATIO = 2;
export const CAR_W = 520;
/** 插畫本身的高度（840×540 等比縮到 CAR_W） */
const SPRITE_H = 334;
/** 整台車上下浮動的幅度（裝置像素，±）。引擎在抖，不是在跳 */
const BOB = 6;
/** 插畫底下留給影子的空間 */
const GROUND = 18;
export const CAR_H = SPRITE_H + BOB + GROUND;
/** 沒有浮動時插畫左上角的 y */
const SPRITE_TOP = CAR_H - GROUND - SPRITE_H;

/** 座位。命名是「這台車上的位置」，誰坐哪裡由 FootprintMap 決定 */
export type Seat = 'passenger' | 'driver' | 'rear';

/**
 * 三顆綠點的位置，正規化成插畫寬高的比例（插畫**車頭朝左**）。
 *
 * 由使用者給的三張原圖量出來的：同一個裁切框 (0, 618, 2123, 1984)，
 * 駕駛與副駕那兩點在 solo／family 上是**同一個像素**，所以換圖時頭不會位移。
 */
export const SEATS: Record<Seat, { x: number; y: number }> = {
  passenger: { x: 0.39945, y: 0.03727 }, // 最左邊那位（粉衣服拿相機）＝副駕
  driver:    { x: 0.70100, y: 0.13414 }, // 中間握方向盤的＝駕駛
  rear:      { x: 0.83552, y: 0.10157 }, // 最右邊的兒童座椅＝後座
};

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
 * 某個座位相對於「圖片底部中央」（icon-anchor: 'bottom' 的錨點）的位移，單位是
 * **CSS px、還沒乘上 icon-size**。呼叫端自己乘 scale 再加到 `map.project()` 的結果上。
 *
 * `flip` 跟 `createCarImage` 同一個意思：true ＝ 車頭朝左（插畫原本的方向），
 * false ＝ 鏡射成朝右，這時候 x 要換成 `1 - x`。
 */
export function seatOffset(seat: Seat, flip: boolean, t: number): { dx: number; dy: number } {
  const s = SEATS[seat];
  const nx = flip ? s.x : 1 - s.x;
  const px = nx * CAR_W;
  const py = SPRITE_TOP + carBob(t) + s.y * SPRITE_H;
  return {
    dx: (px - CAR_W / 2) / CAR_PIXEL_RATIO,
    dy: (py - CAR_H) / CAR_PIXEL_RATIO, // 負的（錨點在圖片底部）
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
  const src = SPRITE_SRC[sprite];
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
  let ctx: CanvasRenderingContext2D | null = null;
  let img: HTMLImageElement | null = null;

  return {
    width: CAR_W,
    height: CAR_H,
    data: new Uint8Array(CAR_W * CAR_H * 4),
    onAdd() {
      const canvas = document.createElement('canvas');
      canvas.width = CAR_W;
      canvas.height = CAR_H;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      img = loadSprite(sprite, triggerRepaint);
    },
    render() {
      if (!ctx) return false;
      const c = ctx;
      // 用絕對時間而不是「從 onAdd 起算」：好幾台車各自算會各浮各的，
      // 同一幀裡兩台車的相位不同看起來很怪
      const t = performance.now() / 1000;
      c.clearRect(0, 0, CAR_W, CAR_H);

      // 地上的影子。**不跟著浮動**，車彈起來影子才會「留在地上」
      c.fillStyle = 'rgba(15,23,42,0.22)';
      c.beginPath();
      c.ellipse(CAR_W / 2, CAR_H - GROUND * 0.55, CAR_W * 0.3, GROUND * 0.36, 0, 0, Math.PI * 2);
      c.fill();

      if (img && img.complete && img.naturalWidth > 0) {
        c.save();
        if (!flip) {
          // 插畫本來就朝左，朝右那一版靠鏡射（maplibre 沒辦法逐 feature 鏡射，
          // 所以左右各做一張圖）
          c.translate(CAR_W, 0);
          c.scale(-1, 1);
        }
        c.drawImage(img, 0, SPRITE_TOP + carBob(t), CAR_W, SPRITE_H);
        c.restore();
      }

      this.data = c.getImageData(0, 0, CAR_W, CAR_H).data;
      if (isAnimating()) triggerRepaint();
      return true;
    },
  };
}

/* ────────────────────────── 頭 ────────────────────────── */

/** 頭的貼圖尺寸（裝置像素）。pixelRatio 2 → 畫面上 88 CSS px，比座位大得離譜，就是要誇張 */
export const HEAD_SIZE = 176;
export const HEAD_PIXEL_RATIO = 2;

/**
 * 沒有自己軌跡的人用的外框色 —— 目前只有後座那個寶寶（他不是 `User`，
 * 沒有 `track_color`）。車身以前會依人染色，現在是固定的插畫，這個值只剩這個用途。
 */
export const NEUTRAL_RING = '#e8574a';

/** 自己軌跡色那一圈的粗細（裝置像素）。這是「誰是誰」唯一的辨識 —— 車身現在是固定的插畫 */
const RING = 8;
/** 顏色圈外面再一圈白的。底圖（positron）幾乎是白的，深色軌跡色不加白邊會糊進路網 */
const HALO = 4;
/** 頭像本體的範圍：四周留給兩圈外框 */
const HEAD_PAD = RING + HALO + 3;
const HEAD_BOX = HEAD_SIZE - HEAD_PAD * 2;

/** 一格頭（已經加好外框的 RGBA）＋ 它要停留多久 */
interface BakedFrame { data: Uint8ClampedArray; delayMs: number; }

/**
 * 把一張去背頭像烤成地圖上的一顆大頭：軌跡色一圈、外面再一圈白。
 *
 * canvas 沒有「描 alpha 邊」這種功能，只能把剪影往十六個方向各畫一次再把原圖
 * 蓋上去。十六個夠密了，再多只是拖慢，再少邊緣會出現扇形缺口。
 */
function bakeHead(src: CanvasImageSource, color: string): Uint8ClampedArray {
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
  const tint = mask(color);

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
  ctx.shadowBlur = RING;
  ctx.shadowOffsetY = RING * 0.4;
  stamp(white, RING + HALO);
  ctx.restore();
  stamp(tint, RING);
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
      if (isAnimating()) triggerRepaint();
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
  color: string,
  hooks?: { triggerRepaint: () => void; isAnimating: () => boolean },
): Promise<StaticImage | AnimatedImage> {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`頭像載不下來 ${res.status}`);
  const buf = await res.arrayBuffer();

  if (hooks && looksLikeGif(buf)) {
    const gif = decodeGif(buf);
    if (gif && gif.frames.length > 1) {
      const baked = gif.frames.map((f) => ({
        data: bakeHead(frameToCanvas(f.data, gif.width, gif.height), color),
        delayMs: f.delayMs,
      }));
      return framesToImage(baked, hooks.triggerRepaint, hooks.isAnimating);
    }
    // 解不開／只有一格：照樣走下面那條靜態路，瀏覽器自己解得了第一格
  }

  const bitmap = await createImageBitmap(new Blob([buf]));
  const data = bakeHead(bitmap, color);
  bitmap.close?.();
  return { width: HEAD_SIZE, height: HEAD_SIZE, data };
}

/**
 * 沒設頭像的人坐的是外星人 —— 從退休的飛碟座艙裡撿回來的那一顆綠頭，
 * 連每 3.4 秒眨一次眼都留著。
 *
 * 這顆是**會動的**（要眨眼），所以走 StyleImageInterface 而不是靜態點陣圖。
 * 每個顏色一張（外框顏色不同），但 maplibre 只會對「這一幀真的用到」的圖
 * 呼叫 render，沒人在場的那幾張不花錢。
 */
export function createAlienHead(
  triggerRepaint: () => void,
  isAnimating: () => boolean,
  color: string,
): AnimatedImage {
  let ctx: CanvasRenderingContext2D | null = null;

  const draw = (c: CanvasRenderingContext2D, t: number) => {
    c.clearRect(0, 0, HEAD_SIZE, HEAD_SIZE);

    const cx = HEAD_SIZE / 2;
    const cy = HEAD_SIZE * 0.5;
    const headR = HEAD_SIZE * 0.34;

    // 頭。形狀已知，白邊與顏色圈直接用兩次 stroke 就好 ——
    // 不必像頭像那樣堆十六層剪影
    c.save();
    c.shadowColor = 'rgba(15,23,42,0.35)';
    c.shadowBlur = RING;
    c.shadowOffsetY = RING * 0.4;
    c.strokeStyle = '#ffffff';
    c.lineWidth = (RING + HALO) * 2;
    c.beginPath();
    c.ellipse(cx, cy, headR, headR * 1.14, 0, 0, Math.PI * 2);
    c.stroke();
    c.restore();
    // 路徑不在 save/restore 的狀態堆裡，restore 之後還是同一個橢圓
    c.strokeStyle = color;
    c.lineWidth = RING * 2;
    c.stroke();
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
      if (isAnimating()) triggerRepaint();
      return true;
    },
  };
}
