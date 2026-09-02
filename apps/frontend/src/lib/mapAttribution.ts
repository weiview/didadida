import type { MapLibreMap } from 'maplibre-gl';

/**
 * 讓地圖右下角那塊圖資出處**一進來就是收起來的一顆圓點**（點一下才攤開）。
 *
 * ⚠️⚠️ maplibre 的 `attributionControl: { compact: true }` **只保證有那顆按鈕，
 * 不保證一開始是收著的**。它的 `_updateCompact()` 在第一次拿到出處文字時，
 * 一口氣掛上 `maplibregl-compact` **和** `maplibregl-compact-show` 兩個 class ——
 * 後者就是「攤開」。要等使用者拖一下地圖（`drag` → `_updateCompactMinimize`）
 * 才會收起來。所以地圖一開，右下角就被一長串 © OpenStreetMap … 佔著。
 *
 * 這裡做的事就是 maplibre 自己收合時做的那兩下：拔掉 `-show`、把 `<details>`
 * 的 `open` 補回去（⚠️ 它的約定是**反的** —— 收著的時候才有 `open`，
 * 攤開時反而沒有；內容的顯示與否由那兩個 class 的 CSS 決定，不是靠 `open`）。
 *
 * ⚠️ 收完不會再被攤開：`_updateCompact()`（resize 時會跑）只在**還沒有**
 * `maplibregl-compact` 那個 class 時才補上 `-show`。
 * ⚠️ 出處文字是圖磚來源載進來之後才填的，填完那一下會再攤開一次 ——
 * 所以 `load` 與第一次 `idle` 各補收一次，當場那一次擋不住。
 */
export function collapseAttribution(map: MapLibreMap): void {
  const shrink = () => {
    map.getContainer()
      .querySelectorAll('.maplibregl-ctrl-attrib.maplibregl-compact-show')
      .forEach(el => {
        el.classList.remove('maplibregl-compact-show');
        el.setAttribute('open', '');
      });
  };
  shrink();
  map.on('load', shrink);
  map.once('idle', shrink);
}
