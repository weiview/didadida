'use client';

import { useEffect, useRef } from 'react';
import { MapLibreMap, Marker, NavigationControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { collapseAttribution } from '@/lib/mapAttribution';

// 跟足跡地圖同一套圖磚（見 FootprintMap 的 DEFAULT_STYLE）：
// 免費、免 API key，而且兩張地圖長得一樣，點下去的位置才對得起來
const STYLE = 'https://tiles.openfreemap.org/styles/positron';

/** 沒有任何線索可以定位時的落點。整個台灣都看得到，使用者自己拖到目的地 */
const FALLBACK: [number, number] = [120.98, 23.7];

interface Props {
  /** 開圖時要看哪裡。非同步拿到也沒關係，第一個非 null 的值會被套用 */
  center: { lat: number; lng: number } | null;
  /** 目前釘在哪。null = 還沒選 */
  value: { lat: number; lng: number } | null;
  onPick: (lat: number, lng: number) => void;
  height?: number;
  /** 給了就用 class 決定高度（需要 media query 的場合），height 會被忽略 */
  className?: string;
}

/**
 * 在地圖上點一下決定座標。
 *
 * 存在的理由：地名搜尋走的是 OSM，巷口那家麵店不會在裡面，而免費的地理編碼
 * 服務底下全是同一份 OSM 資料，換一家也一樣找不到。真正找得到店家的
 * （Google Places、Foursquare）都要綁信用卡，還限制座標不能永久存進資料庫。
 * 所以「搜不到就自己點」才是這個專案負擔得起的解法。
 */
export default function PlacePickerMap({ center, value, onPick, height = 240, className }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  // 地圖只建立一次，但 onPick 每次 render 都是新的函式。
  // 存進 ref 才不用為了它重建整張地圖
  const onPickRef = useRef(onPick);
  // center 是非同步來的（要先去問這本相簿既有的足跡點）。
  // 只認第一次，否則使用者自己拖過之後會被拉回去
  const centeredRef = useRef(false);

  useEffect(() => { onPickRef.current = onPick; }, [onPick]);

  useEffect(() => {
    if (!boxRef.current || mapRef.current) return;

    const map = new MapLibreMap({
      container: boxRef.current,
      style: STYLE,
      center: center ? [center.lng, center.lat] : FALLBACK,
      zoom: center ? 16 : 7,
      attributionControl: { compact: true },
    });
    if (center) centeredRef.current = true;

    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    // 右下角那塊出處預設收成一顆圓點（compact: true 自己做不到，理由見那一檔）
    collapseAttribution(map);
    map.on('click', (e) => onPickRef.current(e.lngLat.lat, e.lngLat.lng));
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      centeredRef.current = false;
    };
    // 只在掛載時建立一次；center/value 由底下各自的 effect 負責
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !center || centeredRef.current) return;
    centeredRef.current = true;
    map.jumpTo({ center: [center.lng, center.lat], zoom: 16 });
  }, [center]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!value) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    if (markerRef.current) {
      markerRef.current.setLngLat([value.lng, value.lat]);
    } else {
      markerRef.current = new Marker({ color: '#dc2626' })
        .setLngLat([value.lng, value.lat])
        .addTo(map);
    }

    // 只有落在畫面外才移動。點在圖上的位置本來就看得到，跟著飛會很暈；
    // 但從搜尋選到的地點可能在幾百公里外，不移動的話圖上什麼都沒有
    if (!map.getBounds().contains([value.lng, value.lat])) {
      map.easeTo({ center: [value.lng, value.lat], zoom: 16, duration: 600 });
    }
  }, [value]);

  return (
    <div
      ref={boxRef}
      className={className}
      style={{
        height: className ? undefined : height,
        borderRadius: 8,
        overflow: 'hidden',
        border: '1px solid #e2e8f0',
        cursor: 'crosshair',
      }}
    />
  );
}
