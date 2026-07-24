'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MapLibreMap, NavigationControl, LngLatBounds,
  type GeoJSONSource, type MapLayerMouseEvent,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FootprintPoint } from '@/lib/api';

// OpenFreeMap：免費、免 API key、無流量上限的向量圖磚。
// 不用 Google Maps 是因為它強制要求綁定信用卡的帳單帳戶。
const DEFAULT_STYLE = 'https://tiles.openfreemap.org/styles/positron';

interface Props {
  points: FootprintPoint[];
  height?: number | string;
  styleUrl?: string;
  onSelectPhoto?: (point: FootprintPoint) => void;
}

/** 'YYYY-MM-DD HH:MM:SS' → 顯示用的短字串 */
function shortTime(local: string): string {
  if (!local) return '';
  const [d, t] = local.split(' ');
  return t ? `${d} ${t.slice(0, 5)}` : d;
}

export default function FootprintMap({ points, height = 520, styleUrl, onSelectPhoto }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastCameraIndex = useRef<number>(-1);

  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  // 走到第幾個點（浮點數，小數部分用來內插線段的最後一小截）
  const [head, setHead] = useState(0);
  const [speed, setSpeed] = useState(1);

  // 依當地時間排序；後端已排過，這裡再保險一次
  const sorted = useMemo(
    () => [...points].sort((a, b) => (a.local_time || '').localeCompare(b.local_time || '')),
    [points],
  );
  const coords = useMemo(() => sorted.map((p) => [p.lng, p.lat] as [number, number]), [sorted]);

  const headIndex = Math.min(Math.floor(head), Math.max(sorted.length - 1, 0));
  const current = sorted[headIndex];

  // --- 建立地圖 ---
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new MapLibreMap({
      container: containerRef.current,
      style: styleUrl || DEFAULT_STYLE,
      center: coords[0] || [121.5, 25.04],
      zoom: coords.length ? 9 : 6,
      attributionControl: { compact: true },
    });
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;
    // 底圖或圖磚載入失敗時要留下線索 —— 沒有這個 handler 時地圖只會靜靜地一片空白
    map.on('error', (e: any) => console.error('[FootprintMap] 地圖錯誤:', e?.error?.message || e));

    map.on('load', () => {
      map.addSource('route', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } },
      });
      // 路線畫兩層：底下較寬的淡色當光暈，上面實線當主體
      map.addLayer({
        id: 'route-glow',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2563eb', 'line-width': 10, 'line-opacity': 0.18, 'line-blur': 6 },
      });
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2563eb', 'line-width': 3 },
      });

      map.addSource('photos', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        cluster: true,
        clusterRadius: 45,
        clusterMaxZoom: 15,
      });

      // 同一景點常常拍幾十張，不聚合會疊成一坨
      map.addLayer({
        id: 'photo-clusters',
        type: 'circle',
        source: 'photos',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#2563eb',
          'circle-opacity': 0.85,
          'circle-radius': ['step', ['get', 'point_count'], 16, 10, 22, 50, 30],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });
      map.addLayer({
        id: 'photo-cluster-count',
        type: 'symbol',
        source: 'photos',
        filter: ['has', 'point_count'],
        // 必須指定 OpenFreeMap 實際提供的字型；用 maplibre 預設的
        // "Open Sans Regular,Arial Unicode MS Regular" 會 404 而退化成本地字型
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 12,
        },
        paint: { 'text-color': '#ffffff' },
      });

      // 單點樣式依座標來源區分，讓人一眼看出哪些足跡是推論出來的：
      //   exif=實心不透明、manual=空心、interpolated=半透明
      map.addLayer({
        id: 'photo-points',
        type: 'circle',
        source: 'photos',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-radius': 7,
          'circle-color': [
            'match', ['get', 'geo_source'],
            'exif', '#2563eb',
            'interpolated', '#2563eb',
            'manual', '#ffffff',
            '#94a3b8',
          ],
          'circle-opacity': [
            'match', ['get', 'geo_source'],
            'exif', 1,
            'interpolated', 0.45,
            'manual', 1,
            0.6,
          ],
          'circle-stroke-width': 2,
          'circle-stroke-color': [
            'match', ['get', 'geo_source'],
            'manual', '#2563eb',
            '#ffffff',
          ],
        },
      });

      map.on('click', 'photo-clusters', (e: MapLayerMouseEvent) => {
        const f = map.queryRenderedFeatures(e.point, { layers: ['photo-clusters'] })[0];
        const clusterId = f?.properties?.cluster_id;
        const src = map.getSource('photos') as GeoJSONSource;
        if (clusterId == null || !src) return;
        src.getClusterExpansionZoom(clusterId).then((zoom: number) => {
          map.easeTo({ center: (f.geometry as any).coordinates, zoom });
        }).catch(() => { /* 叢集已不存在，忽略 */ });
      });

      map.on('click', 'photo-points', (e: MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f) return;
        const id = Number(f.properties?.id);
        const point = sorted.find((p) => p.id === id);
        if (point) {
          setHead(sorted.indexOf(point));
          onSelectPhoto?.(point);
        }
      });

      for (const layer of ['photo-points', 'photo-clusters']) {
        map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
      }

      setReady(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // 只建立一次；資料變動由下面的 effect 更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleUrl]);

  // --- 資料變動時重設並套用 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    setHead(sorted.length ? sorted.length - 1 : 0);
    setPlaying(false);
    lastCameraIndex.current = -1;

    const src = map.getSource('photos') as GeoJSONSource | undefined;
    src?.setData({
      type: 'FeatureCollection',
      features: sorted.map((p) => ({
        type: 'Feature',
        properties: { id: p.id, geo_source: p.geo_source, title: p.title },
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      })),
    });

    if (coords.length > 0) {
      const bounds = coords.reduce(
        (b, c) => b.extend(c),
        new LngLatBounds(coords[0], coords[0]),
      );
      map.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: 600 });
    }
  }, [sorted, coords, ready]);

  // --- 路線隨 head 生長 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('route') as GeoJSONSource | undefined;
    if (!src) return;

    const whole = Math.floor(head);
    const frac = head - whole;
    const line = coords.slice(0, whole + 1);
    // 內插出最後一小段，線條才會平滑前進而不是一格一格跳
    if (frac > 0 && coords[whole] && coords[whole + 1]) {
      const [x1, y1] = coords[whole];
      const [x2, y2] = coords[whole + 1];
      line.push([x1 + (x2 - x1) * frac, y1 + (y2 - y1) * frac]);
    }
    src.setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: line },
    });

    // 相機只在「抵達新的一張照片」時才移動；每幀都移會很暈
    if (playing && whole !== lastCameraIndex.current && coords[whole]) {
      lastCameraIndex.current = whole;
      map.easeTo({ center: coords[whole], duration: 600, essential: true });
    }
  }, [head, coords, ready, playing]);

  // --- 播放迴圈 ---
  useEffect(() => {
    if (!playing) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setHead((h) => {
        const next = h + dt * speed; // speed = 每秒前進幾張照片
        if (next >= coords.length - 1) {
          setPlaying(false);
          return Math.max(coords.length - 1, 0);
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing, speed, coords.length]);

  const replay = useCallback(() => {
    lastCameraIndex.current = -1;
    setHead(0);
    setPlaying(true);
  }, []);

  const maxIndex = Math.max(sorted.length - 1, 0);

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <div ref={containerRef} style={{ width: '100%', height, borderRadius: 12, overflow: 'hidden' }} />

      {sorted.length === 0 && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'center', background: 'rgba(255,255,255,.75)', borderRadius: 12,
          textAlign: 'center', padding: 24, fontSize: 14, color: '#475569',
        }}>
          這個範圍內還沒有帶座標的照片。<br />
          可以先用批次指定地點，或對有 GPS 的照片執行內插補點。
        </div>
      )}

      {sorted.length > 0 && (
        <div style={{
          position: 'absolute', left: 12, right: 12, bottom: 12, padding: '10px 14px',
          background: 'rgba(255,255,255,.94)', borderRadius: 10,
          boxShadow: '0 2px 12px rgba(0,0,0,.15)', display: 'flex',
          alignItems: 'center', gap: 12, flexWrap: 'wrap',
        }}>
          <button
            onClick={() => (head >= maxIndex ? replay() : setPlaying((p) => !p))}
            style={{
              border: 'none', borderRadius: 8, padding: '6px 14px', cursor: 'pointer',
              background: '#2563eb', color: '#fff', fontSize: 14, flexShrink: 0,
            }}
          >
            {head >= maxIndex ? '重播' : playing ? '暫停' : '播放'}
          </button>

          <input
            type="range"
            min={0}
            max={maxIndex}
            step="any"
            value={head}
            onChange={(e) => { setPlaying(false); setHead(Number(e.target.value)); }}
            style={{ flex: '1 1 180px', minWidth: 140 }}
            aria-label="時間軸"
          />

          <select
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            style={{ fontSize: 13, padding: '4px 6px', borderRadius: 6, flexShrink: 0 }}
            aria-label="播放速度"
          >
            <option value={0.5}>0.5x</option>
            <option value={1}>1x</option>
            <option value={3}>3x</option>
            <option value={8}>8x</option>
          </select>

          {current && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: '1 1 200px' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={current.url}
                alt={current.title}
                style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }}
              />
              <div style={{ fontSize: 12, lineHeight: 1.4, minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {current.place_name || current.title}
                </div>
                <div style={{ color: '#64748b' }}>
                  {shortTime(current.local_time)}
                  {current.geo_source === 'interpolated' && '（推估位置）'}
                  {current.geo_source === 'manual' && '（手動指定）'}
                </div>
              </div>
            </div>
          )}

          <div style={{ fontSize: 12, color: '#64748b', flexShrink: 0 }}>
            {headIndex + 1} / {sorted.length}
          </div>
        </div>
      )}
    </div>
  );
}
