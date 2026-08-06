// 地圖上那台飛碟。
//
// 為什麼是自己畫的 canvas 而不是 emoji：emoji 借的是作業系統的字型，
// 每台電腦長得不一樣、大小固定、而且**不會動**。動畫的主角需要會呼吸、
// 燈會轉、下面拖著一道光束 —— 那些只能自己畫。
//
// 實作成 maplibre 的 StyleImageInterface：地圖每畫一幀就呼叫一次 render()，
// 我們重畫 canvas、把像素塞回 data、回傳 true 叫它重新上傳貼圖。
// 要讓下一幀繼續來，得自己 triggerRepaint —— 所以「有沒有在播」由外面決定，
// 沒在播就不要求重畫，地圖閒置時不該一直燒 GPU。

/** 圖片邊長（裝置像素）。配合 pixelRatio 2 之後在畫面上約 80 CSS px —— 刻意浮誇 */
export const UFO_SIZE = 160;
export const UFO_PIXEL_RATIO = 2;

/** 碟身的燈。彩虹色輪流亮，一圈跑完再從頭 */
const LIGHT_COLORS = ['#fb7185', '#fbbf24', '#4ade80', '#38bdf8', '#c084fc', '#f472b6', '#fde047'];

/**
 * 畫一幀飛碟。
 *
 * 座標一律用邊長 S 的比例算，改 UFO_SIZE 不用重調任何數字。
 * 圖片底部中央 = 光束落地點，配合圖層的 icon-anchor: 'bottom'，
 * 碟身就會浮在軌跡上方、光束正好打在軌跡點上。
 */
function drawUfo(ctx: CanvasRenderingContext2D, S: number, t: number) {
  ctx.clearRect(0, 0, S, S);

  const cx = S / 2;
  // 上下浮沉。飛碟是「懸浮」的，完全不動看起來像貼紙
  const bob = Math.sin(t * 2.4) * S * 0.018;
  const craftY = S * 0.3 + bob;
  const bodyW = S * 0.78;
  const bodyH = S * 0.2;
  const beamTop = craftY + bodyH * 0.3;
  const groundY = S * 0.965;

  // --- 光束（畫在碟身之前，碟身要蓋住它的頭）---
  const pulse = 0.5 + 0.5 * Math.sin(t * 3);
  const topHalf = bodyW * 0.15;
  const botHalf = S * 0.29;
  const beam = new Path2D();
  beam.moveTo(cx - topHalf, beamTop);
  beam.lineTo(cx + topHalf, beamTop);
  beam.lineTo(cx + botHalf, groundY);
  beam.lineTo(cx - botHalf, groundY);
  beam.closePath();

  // 顏色比直覺該有的更飽和：底圖（positron）幾乎是白的，淡青色打上去會整個消失
  const beamGrad = ctx.createLinearGradient(0, beamTop, 0, groundY);
  beamGrad.addColorStop(0, `rgba(56,205,244,${(0.62 + 0.18 * pulse).toFixed(3)})`);
  beamGrad.addColorStop(0.6, 'rgba(56,205,244,0.3)');
  beamGrad.addColorStop(1, 'rgba(56,205,244,0)');
  ctx.fillStyle = beamGrad;
  ctx.fill(beam);

  // 光束裡往下掃的三道環。有它才看得出光束是「正在打下來」而不是一片色塊
  ctx.save();
  ctx.clip(beam);
  for (let i = 0; i < 3; i++) {
    const p = (t * 0.55 + i / 3) % 1;
    const y = beamTop + (groundY - beamTop) * p;
    const half = topHalf + (botHalf - topHalf) * p;
    ctx.globalAlpha = 0.34 * (1 - p);
    ctx.fillStyle = '#e0fbff';
    ctx.beginPath();
    ctx.ellipse(cx, y, half, S * 0.016, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // 落地的光池
  const pool = ctx.createRadialGradient(cx, groundY, 0, cx, groundY, botHalf);
  pool.addColorStop(0, `rgba(103,222,252,${(0.72 + 0.2 * pulse).toFixed(3)})`);
  pool.addColorStop(1, 'rgba(103,222,252,0)');
  ctx.fillStyle = pool;
  ctx.beginPath();
  ctx.ellipse(cx, groundY, botHalf, S * 0.045, 0, 0, Math.PI * 2);
  ctx.fill();

  // --- 碟身。以下都在「碟心為原點」的座標系裡畫 ---
  ctx.save();
  ctx.translate(cx, craftY);
  ctx.rotate(Math.sin(t * 1.5) * 0.07); // 左右晃一點，才像在飛不像在停

  // 整台的暈光
  const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, bodyW * 0.72);
  halo.addColorStop(0, 'rgba(150,240,255,0.34)');
  halo.addColorStop(1, 'rgba(150,240,255,0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.ellipse(0, 0, bodyW * 0.72, bodyH * 1.9, 0, 0, Math.PI * 2);
  ctx.fill();

  // 下腹（先畫，被上面的碟盤壓住一半，才有厚度）
  ctx.fillStyle = '#3f4c60';
  ctx.beginPath();
  ctx.ellipse(0, bodyH * 0.2, bodyW * 0.4, bodyH * 0.46, 0, 0, Math.PI * 2);
  ctx.fill();

  // 碟盤本體。描一圈深色邊 —— 底圖是接近白色的 positron，
  // 沒有邊的話銀色碟身會糊在路網跟建物色塊上
  const hull = ctx.createLinearGradient(0, -bodyH * 0.62, 0, bodyH * 0.7);
  hull.addColorStop(0, '#ffffff');
  hull.addColorStop(0.32, '#d3deec');
  hull.addColorStop(0.66, '#8496ae');
  hull.addColorStop(1, '#3d4a5f');
  ctx.beginPath();
  ctx.ellipse(0, 0, bodyW / 2, bodyH / 2, 0, 0, Math.PI * 2);
  ctx.fillStyle = hull;
  ctx.fill();
  ctx.strokeStyle = 'rgba(30,41,59,0.5)';
  ctx.lineWidth = S * 0.008;
  ctx.stroke();

  // 盤面上的反光
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.ellipse(-bodyW * 0.13, -bodyH * 0.16, bodyW * 0.2, bodyH * 0.12, -0.22, 0, Math.PI * 2);
  ctx.fill();

  // 邊緣的燈。只排在前緣（下半圈），後緣本來就被盤面擋住
  const n = LIGHT_COLORS.length;
  for (let i = 0; i < n; i++) {
    const a = Math.PI * ((i + 0.5) / n);
    const lx = -Math.cos(a) * bodyW * 0.405;
    const ly = Math.sin(a) * bodyH * 0.36 + bodyH * 0.1;
    // 亮度依序輪轉，看起來就是一圈燈在跑
    const wave = 0.5 + 0.5 * Math.cos(2 * Math.PI * (t * 1.2 - i / n));
    const k = 0.3 + 0.7 * wave * wave;
    const r = S * 0.019 * (0.75 + 0.45 * k);
    const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, r * 3.2);
    g.addColorStop(0, LIGHT_COLORS[i]);
    g.addColorStop(0.32, LIGHT_COLORS[i]);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalAlpha = k;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(lx, ly, r * 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(lx, ly, r * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // 腹部的發射口 —— 光束是從這裡打出去的，得有個亮點交代
  const emitR = bodyW * 0.16;
  const emit = ctx.createRadialGradient(0, bodyH * 0.3, 0, 0, bodyH * 0.3, emitR);
  emit.addColorStop(0, '#ffffff');
  emit.addColorStop(0.5, `rgba(160,245,255,${(0.85 * (0.6 + 0.4 * pulse)).toFixed(3)})`);
  emit.addColorStop(1, 'rgba(160,245,255,0)');
  ctx.fillStyle = emit;
  ctx.beginPath();
  ctx.ellipse(0, bodyH * 0.3, emitR, emitR * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();

  // --- 玻璃罩 ---
  const domeW = bodyW * 0.27;
  const domeH = bodyH * 1.15;
  const domeY = -bodyH * 0.12;
  ctx.beginPath();
  ctx.ellipse(0, domeY, domeW, domeH, 0, Math.PI, 0);
  ctx.closePath();
  const dome = ctx.createLinearGradient(0, domeY - domeH, 0, domeY);
  dome.addColorStop(0, 'rgba(214,250,255,0.95)');
  dome.addColorStop(0.55, 'rgba(125,225,250,0.8)');
  dome.addColorStop(1, 'rgba(56,160,200,0.85)');
  ctx.fillStyle = dome;
  ctx.fill();
  ctx.strokeStyle = 'rgba(30,41,59,0.4)';
  ctx.lineWidth = S * 0.007;
  ctx.stroke();

  // 罩子裡的小外星人。只有一顆頭跟兩隻眼睛 —— 這個尺寸畫更多只會糊掉
  const headY = domeY - domeH * 0.34;
  const headR = domeW * 0.46;
  ctx.fillStyle = '#6ee7a5';
  ctx.beginPath();
  ctx.ellipse(0, headY, headR, headR * 1.12, 0, 0, Math.PI * 2);
  ctx.fill();
  // 每 3.4 秒眨一次
  const blinking = t % 3.4 < 0.13;
  const eyeDx = headR * 0.42;
  const eyeR = headR * 0.3;
  for (const dx of [-eyeDx, eyeDx]) {
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    if (blinking) {
      ctx.ellipse(dx, headY, eyeR, eyeR * 0.16, 0, 0, Math.PI * 2);
    } else {
      ctx.ellipse(dx, headY, eyeR, eyeR * 1.2, 0, 0, Math.PI * 2);
    }
    ctx.fill();
    if (!blinking) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(dx - eyeR * 0.28, headY - eyeR * 0.4, eyeR * 0.34, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 罩子的高光。畫在外星人之後，才像隔著一層玻璃看他
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.beginPath();
  ctx.ellipse(-domeW * 0.36, domeY - domeH * 0.5, domeW * 0.22, domeH * 0.3, -0.4, 0, Math.PI * 2);
  ctx.fill();

  // --- 頂端天線，燈一閃一閃 ---
  const antTop = domeY - domeH - S * 0.052;
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = S * 0.011;
  ctx.beginPath();
  ctx.moveTo(0, domeY - domeH * 0.98);
  ctx.lineTo(0, antTop);
  ctx.stroke();
  const blip = 0.35 + 0.65 * Math.abs(Math.sin(t * 4.2));
  const tip = ctx.createRadialGradient(0, antTop, 0, 0, antTop, S * 0.042);
  tip.addColorStop(0, '#fff1f2');
  tip.addColorStop(0.3, '#fb7185');
  tip.addColorStop(1, 'rgba(251,113,133,0)');
  ctx.globalAlpha = blip;
  ctx.fillStyle = tip;
  ctx.beginPath();
  ctx.arc(0, antTop, S * 0.042, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.restore();
}

/** maplibre 的 addImage 只認得這個形狀。宣告在這裡免得為了型別把整包 maplibre 拉進來 */
export interface AnimatedImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
  onAdd?(): void;
  render(): boolean;
}

/**
 * 造一台會動的飛碟給 map.addImage 用。
 *
 * @param triggerRepaint 地圖的 triggerRepaint —— 不呼叫它就只會畫一幀
 * @param isAnimating    現在該不該動。暫停時回 false，地圖就停在最後一幀不再重畫
 */
export function createUfoImage(triggerRepaint: () => void, isAnimating: () => boolean): AnimatedImage {
  const S = UFO_SIZE;
  let ctx: CanvasRenderingContext2D | null = null;
  let t0 = 0;

  return {
    width: S,
    height: S,
    data: new Uint8Array(S * S * 4),
    onAdd() {
      const canvas = document.createElement('canvas');
      canvas.width = S;
      canvas.height = S;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      t0 = performance.now();
    },
    render() {
      if (!ctx) return false;
      drawUfo(ctx, S, (performance.now() - t0) / 1000);
      this.data = ctx.getImageData(0, 0, S, S).data;
      if (isAnimating()) triggerRepaint();
      return true;
    },
  };
}
