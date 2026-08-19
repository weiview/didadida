// 地圖上那台載著大頭的小車。**取代了原本的飛碟**（lib/ufo.ts 已刪）。
//
// 造型是刻意誇張的比例：車子小小、頭大大。一個人出門就是一顆頭一台車，
// 全家合體就是同一台車上冒出好幾顆頭 —— 「今天誰跟誰在一起」一眼就看得出來，
// 不必去讀底下那幾條線的顏色。
//
// 為什麼是自己畫的 canvas：emoji 借的是作業系統的字型，每台電腦長得不一樣、
// 大小固定、而且不會動。輪子要轉、車身要彈、頭要跟著晃，那些只能自己畫。
//
// ── 這裡分成兩種圖 ────────────────────────────────────────────────
//   車   `createCarImage()`    會動（輪子、彈跳、排氣），maplibre 的
//                              StyleImageInterface：每畫一幀呼叫一次 render()。
//   頭   `buildAvatarHead()`   靜態點陣圖，從使用者的去背頭像現做（白色貼紙外框
//        `createAlienHead()`   ＋自己顏色的小身體）。沒設頭像的人是會眨眼的外星人
//                              —— 那顆頭是從退休的飛碟座艙裡撿回來的。
//
// 車與頭是**兩層**、每一幀各自定位（見 FootprintMap 的 project／unproject 那段），
// 不合成一張圖：不然「三個人同車」得為每一種人數×每一組頭像各做一張貼圖。

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

/** 車的貼圖尺寸（裝置像素）。配合 pixelRatio 2 → 畫面上 100×60 CSS px */
export const CAR_W = 200;
export const CAR_H = 120;
export const CAR_PIXEL_RATIO = 2;

/** 車身底盤離地多高（CSS px，給 FootprintMap 擺頭用）—— 大約就是「座位」的高度 */
export const CAR_SEAT_Y = -34;

/** 沒有指定顏色時的車身色。合體時用它 —— 那台車不屬於任何一個人 */
export const CAR_NEUTRAL = '#e8574a';

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** 把 '#rrggbb' 調暗（k<1）或調亮（k>1）。車身要有上下漸層才不像一塊色紙 */
function shade(hex: string, k: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

/**
 * 畫一幀車。
 *
 * 圖片**底部中央＝輪子接地點**，配合圖層的 icon-anchor: 'bottom'，
 * 車子就會正好停在軌跡上。預設車頭朝右，`flip` 是朝左那一版
 * （maplibre 沒辦法逐 feature 鏡射，所以左右各做一張圖）。
 */
function drawCar(ctx: CanvasRenderingContext2D, t: number, color: string, flip: boolean) {
  const W = CAR_W;
  const H = CAR_H;
  ctx.clearRect(0, 0, W, H);

  ctx.save();
  if (flip) {
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
  }

  const groundY = H - H * 0.05;
  // 引擎在抖。幅度只有一點點 —— 大了會變成在跳，不是在開
  const bob = Math.sin(t * 11) * H * 0.011;

  const wheelR = H * 0.185;
  const wheelY = groundY - wheelR;
  const bodyL = W * 0.07;
  const bodyR = W * 0.93;
  const bodyBottom = wheelY + wheelR * 0.1 + bob;
  const bodyTop = bodyBottom - H * 0.3;

  // --- 地上的影子。不跟著 bob 動，車彈起來影子才會「留在地上」---
  ctx.fillStyle = 'rgba(15,23,42,0.22)';
  ctx.beginPath();
  ctx.ellipse((bodyL + bodyR) / 2, groundY + H * 0.02, W * 0.4, H * 0.045, 0, 0, Math.PI * 2);
  ctx.fill();

  // --- 排氣。從車尾（左）往後飄，越飄越淡越大 ---
  for (let i = 0; i < 3; i++) {
    const p = ((t * 1.6 + i / 3) % 1);
    const px = bodyL - W * 0.02 - p * W * 0.14;
    const py = bodyBottom - H * 0.02 - p * H * 0.12;
    ctx.globalAlpha = 0.32 * (1 - p);
    ctx.fillStyle = '#94a3b8';
    ctx.beginPath();
    ctx.arc(px, py, H * 0.035 + p * H * 0.05, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // --- 車身 ---
  const grad = ctx.createLinearGradient(0, bodyTop, 0, bodyBottom);
  grad.addColorStop(0, shade(color, 1.22));
  grad.addColorStop(0.55, color);
  grad.addColorStop(1, shade(color, 0.72));
  ctx.fillStyle = grad;
  // 描一圈深邊：底圖（positron）幾乎是白的，淺色車身不描邊會糊在路網上
  ctx.strokeStyle = 'rgba(15,23,42,0.55)';
  ctx.lineWidth = H * 0.028;
  ctx.lineJoin = 'round';

  // 底盤。前緣（右）比後緣（左）低一點，看起來像在往前衝
  ctx.beginPath();
  ctx.moveTo(bodyL + W * 0.02, bodyTop + H * 0.02);
  ctx.lineTo(bodyR - W * 0.12, bodyTop);
  // 引擎蓋斜下去
  ctx.quadraticCurveTo(bodyR, bodyTop + H * 0.02, bodyR, bodyTop + H * 0.12);
  ctx.lineTo(bodyR, bodyBottom - H * 0.05);
  ctx.quadraticCurveTo(bodyR, bodyBottom, bodyR - H * 0.05, bodyBottom);
  ctx.lineTo(bodyL + H * 0.05, bodyBottom);
  ctx.quadraticCurveTo(bodyL, bodyBottom, bodyL, bodyBottom - H * 0.05);
  ctx.lineTo(bodyL, bodyTop + H * 0.08);
  ctx.quadraticCurveTo(bodyL, bodyTop + H * 0.02, bodyL + W * 0.02, bodyTop + H * 0.02);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // 椅背。頭要坐在它前面，所以畫在車身上、頭之下（頭是另一層，在這張圖外面）
  ctx.fillStyle = shade(color, 0.82);
  roundRect(ctx, bodyL + W * 0.06, bodyTop - H * 0.13, W * 0.26, H * 0.2, H * 0.05);
  ctx.fill();
  ctx.stroke();

  // 擋風玻璃。只是一片斜著的亮面，不畫車頂 —— 有車頂就看不到頭了
  ctx.fillStyle = 'rgba(226,244,255,0.85)';
  ctx.beginPath();
  ctx.moveTo(bodyL + W * 0.36, bodyTop + H * 0.01);
  ctx.lineTo(bodyR - W * 0.2, bodyTop + H * 0.02);
  ctx.lineTo(bodyR - W * 0.17, bodyTop + H * 0.13);
  ctx.lineTo(bodyL + W * 0.36, bodyTop + H * 0.13);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(15,23,42,0.4)';
  ctx.lineWidth = H * 0.018;
  ctx.stroke();

  // 車身側面的反光帶
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  roundRect(ctx, bodyL + W * 0.06, bodyTop + H * 0.17, W * 0.7, H * 0.05, H * 0.025);
  ctx.fill();

  // 車頭燈
  const lampX = bodyR - W * 0.035;
  const lampY = bodyTop + H * 0.19;
  const lamp = ctx.createRadialGradient(lampX, lampY, 0, lampX, lampY, H * 0.075);
  lamp.addColorStop(0, '#fffbe8');
  lamp.addColorStop(0.45, '#fde68a');
  lamp.addColorStop(1, 'rgba(253,230,138,0)');
  ctx.fillStyle = lamp;
  ctx.beginPath();
  ctx.arc(lampX, lampY, H * 0.075, 0, Math.PI * 2);
  ctx.fill();

  // --- 輪子。轉速跟車身彈跳同一個節拍，看起來才是同一台車 ---
  const spin = t * 7;
  for (const wx of [bodyL + W * 0.16, bodyR - W * 0.16]) {
    ctx.fillStyle = '#1f2937';
    ctx.beginPath();
    ctx.arc(wx, wheelY + bob * 0.25, wheelR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.arc(wx, wheelY + bob * 0.25, wheelR * 0.44, 0, Math.PI * 2);
    ctx.fill();
    // 三根輻條 —— 沒有它看不出輪子在轉
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = H * 0.022;
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const a = spin + (i * Math.PI * 2) / 3;
      ctx.beginPath();
      ctx.moveTo(wx, wheelY + bob * 0.25);
      ctx.lineTo(
        wx + Math.cos(a) * wheelR * 0.38,
        wheelY + bob * 0.25 + Math.sin(a) * wheelR * 0.38,
      );
      ctx.stroke();
    }
  }

  ctx.restore();
}

/**
 * 造一台會動的車給 map.addImage 用。
 *
 * @param triggerRepaint 地圖的 triggerRepaint —— 不呼叫它就只會畫一幀
 * @param isAnimating    現在該不該動。暫停時回 false，地圖停在最後一幀不再重畫
 * @param color          車身色（獨行時是那個人的軌跡色，合體時是 CAR_NEUTRAL）
 * @param flip           車頭朝左
 */
export function createCarImage(
  triggerRepaint: () => void,
  isAnimating: () => boolean,
  color: string,
  flip: boolean,
): AnimatedImage {
  let ctx: CanvasRenderingContext2D | null = null;

  return {
    width: CAR_W,
    height: CAR_H,
    data: new Uint8Array(CAR_W * CAR_H * 4),
    onAdd() {
      const canvas = document.createElement('canvas');
      canvas.width = CAR_W;
      canvas.height = CAR_H;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    },
    render() {
      if (!ctx) return false;
      // 用絕對時間而不是「從 onAdd 起算」：好幾台車各自算會各轉各的，
      // 同一幀裡兩台車的輪子相位不同看起來很怪
      drawCar(ctx, performance.now() / 1000, color, flip);
      this.data = ctx.getImageData(0, 0, CAR_W, CAR_H).data;
      if (isAnimating()) triggerRepaint();
      return true;
    },
  };
}

/* ────────────────────────── 頭 ────────────────────────── */

/** 頭的貼圖尺寸（裝置像素）。pixelRatio 2 → 畫面上 72 CSS px，比車還大，就是要誇張 */
export const HEAD_SIZE = 144;
export const HEAD_PIXEL_RATIO = 2;

/** 白色貼紙外框的粗細（裝置像素） */
const OUTLINE = 6;
/** 頭像本體的範圍：四周留給外框，底下留給小身體 */
const HEAD_PAD = OUTLINE + 4;
const HEAD_BOTTOM = HEAD_SIZE * 0.84;

/** 小身體（肩膀）。顏色是那個人的軌跡色 —— 這是「誰是誰」唯一的辨識 */
function drawShoulders(ctx: CanvasRenderingContext2D, color: string) {
  const cx = HEAD_SIZE / 2;
  const cy = HEAD_SIZE * 0.9;
  ctx.fillStyle = color;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = OUTLINE * 0.8;
  ctx.beginPath();
  ctx.ellipse(cx, cy, HEAD_SIZE * 0.3, HEAD_SIZE * 0.13, 0, Math.PI, 0);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
}

/** 地上的一小塊影子。頭浮在車上，沒有影子會像貼紙飄著 */
function drawHeadShadow(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = 'rgba(15,23,42,0.18)';
  ctx.beginPath();
  ctx.ellipse(HEAD_SIZE / 2, HEAD_SIZE * 0.965, HEAD_SIZE * 0.22, HEAD_SIZE * 0.035, 0, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * 把去背頭像做成地圖上的一顆大頭。
 *
 * 外框是「貼紙」那種一圈白邊：去背 PNG 直接放到地圖上，深色頭髮會整個溶進
 * 底圖的路網裡。作法是把剪影往十六個方向各畫一次白色，再把原圖蓋上去 ——
 * canvas 沒有 stroke alpha 的功能，只能這樣堆。
 *
 * 圖是跨網域的（API worker 不同 origin），所以要 crossOrigin ＋ 後端回
 * `Access-Control-Allow-Origin: *`，否則 getImageData 會因為畫布被污染而丟例外。
 */
export async function buildAvatarHead(url: string, color: string): Promise<StaticImage> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.crossOrigin = 'anonymous';
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('頭像載不下來'));
    el.src = url;
  });

  const box = HEAD_BOTTOM - HEAD_PAD;
  // 頭像本身是正方形的（見 lib/avatar.ts），等比放進 box 就好
  const dw = box;
  const dh = box;
  const dx = (HEAD_SIZE - dw) / 2;
  const dy = HEAD_PAD;

  // 剪影：先畫圖，再用 source-in 整片刷白 —— 留下的就是「有東西的地方是白的」
  const sil = document.createElement('canvas');
  sil.width = HEAD_SIZE;
  sil.height = HEAD_SIZE;
  const sctx = sil.getContext('2d')!;
  sctx.drawImage(img, dx, dy, dw, dh);
  sctx.globalCompositeOperation = 'source-in';
  sctx.fillStyle = '#ffffff';
  sctx.fillRect(0, 0, HEAD_SIZE, HEAD_SIZE);

  const out = document.createElement('canvas');
  out.width = HEAD_SIZE;
  out.height = HEAD_SIZE;
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';

  drawHeadShadow(ctx);
  drawShoulders(ctx, color);

  // 外框。十六個方向夠密了，再多只是拖慢，再少邊緣會出現扇形缺口
  ctx.save();
  ctx.shadowColor = 'rgba(15,23,42,0.35)';
  ctx.shadowBlur = OUTLINE;
  ctx.shadowOffsetY = OUTLINE * 0.4;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    ctx.drawImage(sil, Math.cos(a) * OUTLINE, Math.sin(a) * OUTLINE);
  }
  ctx.restore();

  ctx.drawImage(img, dx, dy, dw, dh);

  return { width: HEAD_SIZE, height: HEAD_SIZE, data: ctx.getImageData(0, 0, HEAD_SIZE, HEAD_SIZE).data };
}

/**
 * 沒設頭像的人坐的是外星人 —— 從退休的飛碟座艙裡撿回來的那一顆綠頭，
 * 連每 3.4 秒眨一次眼都留著。
 *
 * 這顆是**會動的**（要眨眼），所以走 StyleImageInterface 而不是靜態點陣圖。
 * 每個顏色一張（肩膀的顏色不同），但 maplibre 只會對「這一幀真的用到」的圖
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
    drawHeadShadow(c);
    drawShoulders(c, color);

    const cx = HEAD_SIZE / 2;
    const cy = HEAD_SIZE * 0.46;
    const headR = HEAD_SIZE * 0.3;

    // 頭。白邊直接用 stroke 就好 —— 這顆是我們自己畫的，形狀已知，
    // 不必像頭像那樣堆十六層剪影
    c.save();
    c.shadowColor = 'rgba(15,23,42,0.35)';
    c.shadowBlur = OUTLINE;
    c.shadowOffsetY = OUTLINE * 0.4;
    c.strokeStyle = '#ffffff';
    c.lineWidth = OUTLINE;
    c.beginPath();
    c.ellipse(cx, cy, headR, headR * 1.14, 0, 0, Math.PI * 2);
    c.stroke();
    // 路徑不在 save/restore 的狀態堆裡，restore 之後還是同一個橢圓 ——
    // 先描完帶陰影的白邊，再用沒有陰影的綠色把裡面填掉
    c.restore();
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
