'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  previewGeoBatch, assignGeoBatch, searchPlace, reverseGeocode, fetchFootprint,
  type GeoPreview,
} from '@/lib/api';
import PlacePickerMap from './PlacePickerMap';
import styles from './assignPlace.module.css';

/**
 * 從搜尋框認出 GPS 座標。Google 地圖右鍵「複製座標」給的就是
 * `25.033964, 121.564468` 這個格式，貼進來就該直接用。
 *
 * 不接的話會拿去打地名搜尋，Photon 收到一串數字只會回一堆不相干的東西。
 */
function parseLatLng(text: string): { lat: number; lng: number } | null {
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  // 超出範圍表示貼錯了（或根本不是座標），退回去當一般文字搜尋
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

interface Props {
  isOpen: boolean;
  photoIds: number[];
  albumId?: number;
  /** 使用者按取消、或想收掉這個視窗時呼叫。成功送出走的是 onDone，不會經過這裡 */
  onClose: () => void;
  /**
   * 寫入成功。**收掉視窗是呼叫端的責任** —— 這裡不自己 onClose()，
   * 因為指定完之後要不要跳回上一個畫面，得看重抓的資料還剩多少沒處理，
   * 那件事只有呼叫端知道，而且要等 await 才問得出答案。
   */
  onDone: (result: { updated: number; skippedExif: number }) => void;
}

interface PlaceHit { name: string; lat: number; lng: number; }

export default function AssignPlaceModal({ isOpen, photoIds, albumId, onClose, onDone }: Props) {
  const [preview, setPreview] = useState<GeoPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [searching, setSearching] = useState(false);

  // 地圖點選：搜不到的地方（巷口的小店）走這條
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [pinName, setPinName] = useState('');
  /** 這本相簿已定位照片的位置，開圖時直接跳過去，省得從整個台灣拖起 */
  const [anchor, setAnchor] = useState<{ lat: number; lng: number } | null>(null);

  const [createSegment, setCreateSegment] = useState(true);
  const [includeAlsoInRange, setIncludeAlsoInRange] = useState(false);
  const [overwriteExif, setOverwriteExif] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 使用者自己打過名字之後，反查回來的建議就不該再蓋掉他
  const nameTouchedRef = useRef(false);

  useEffect(() => {
    if (!isOpen) return;
    setPreview(null);
    setQuery(''); setHits([]); setError('');
    setPin(null); setPinName(''); setAnchor(null);
    nameTouchedRef.current = false;
    setCreateSegment(true); setIncludeAlsoInRange(false); setOverwriteExif(false);

    setLoadingPreview(true);
    previewGeoBatch(photoIds)
      .then(setPreview)
      .finally(() => setLoadingPreview(false));
  }, [isOpen, photoIds]);

  // 問這本相簿的既有足跡，拿來當開圖的落點
  useEffect(() => {
    if (!isOpen || anchor || albumId === undefined) return;
    fetchFootprint({ albumId }).then((pts) => {
      // 取最後一筆：同一批照片通常拍在一起，時間上最接近的那個點最可能是對的區域
      const last = pts[pts.length - 1];
      if (last) setAnchor({ lat: last.lat, lng: last.lng });
    });
  }, [isOpen, anchor, albumId]);

  const handlePick = useCallback((lat: number, lng: number) => {
    setPin({ lat, lng });
    // 反查只是給個名字建議。查不到（OSM 沒收錄）也無所謂，自己打就是了
    reverseGeocode(lat, lng).then((name) => {
      if (name && !nameTouchedRef.current) setPinName(name);
    });
  }, []);

  /**
   * 要送出去的地點：圖上那根釘子就是答案，不另外存一份 state。
   *
   * 原本中間卡了一顆「使用這個位置」要按，釘好了卻發現「套用地點」還是灰的，
   * 而灰掉的按鈕按下去就是完全沒反應 —— 沒人看得出自己少按了哪一步。
   * 釘子本身就是選擇，不需要再確認一次。
   */
  const place = useMemo<PlaceHit | null>(() => {
    if (!pin) return null;
    // 沒取名字就用座標當名字，總比留白好認
    const name = pinName.trim() || `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`;
    return { name, lat: pin.lat, lng: pin.lng };
  }, [pin, pinName]);

  /** 搜尋框裡打的是座標而不是地名時，就是這個值 */
  const typedCoords = useMemo(() => parseLatLng(query), [query]);

  // 地名搜尋做防抖，避免每打一個字就打一次外部 API
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!query.trim() || typedCoords) { setHits([]); return; }
    searchTimer.current = setTimeout(() => {
      setSearching(true);
      searchPlace(query).then(setHits).finally(() => setSearching(false));
    }, 400);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [query, typedCoords]);

  // 貼上座標就直接釘到圖上（地圖會自己飛過去），不用再多按一次
  useEffect(() => {
    if (!typedCoords) return;
    handlePick(typedCoords.lat, typedCoords.lng);
  }, [typedCoords, handlePick]);

  const handleSubmit = useCallback(async () => {
    if (!place) return;
    setSubmitting(true);
    setError('');
    const ids = includeAlsoInRange && preview
      ? Array.from(new Set([...photoIds, ...preview.alsoInRange.map(p => p.id)]))
      : photoIds;

    const res = await assignGeoBatch({
      photoIds: ids,
      lat: place.lat,
      lng: place.lng,
      placeName: place.name,
      label: place.name,
      createSegment,
      albumId,
      overwriteExif,
    });
    setSubmitting(false);
    if (res.success) {
      onDone({ updated: res.updated, skippedExif: res.skippedExif });
    } else {
      setError(res.error);
    }
  }, [place, includeAlsoInRange, preview, photoIds, createSegment, albumId, overwriteExif, onDone]);

  if (!isOpen) return null;

  const hasRangeWarning = !!preview && preview.alsoInRange.length > 0;
  const noTimeRange = !!preview && (!preview.startLocal || !preview.endLocal);

  return (
    // 刻意不做「點背景關閉」：地圖佔了大半個視窗，拖曳、縮放的手很容易滑出
    // 邊界落在背景上，一個誤觸就把填到一半的地點與名稱全部丟掉。只認取消鈕
    <div className={styles.overlay}>
      <div className={styles.card}>
        <div className={styles.head}>
          <h3 style={{ margin: 0, fontSize: 18 }}>指定地點</h3>
        </div>

        <div className={styles.body}>
          {loadingPreview && <p style={{ fontSize: 14, color: '#64748b' }}>正在計算時間範圍…</p>}

          {preview && (
            <div style={{
              background: '#f8fafc', borderRadius: 10, padding: '12px 14px',
              fontSize: 13.5, lineHeight: 1.8, marginBottom: 14,
            }}>
              <div>已選取 <strong>{preview.selectedCount}</strong> 張</div>
              {preview.startLocal && preview.endLocal ? (
                <div>時間範圍：{preview.startLocal} ~ {preview.endLocal}</div>
              ) : (
                <div style={{ color: '#b45309' }}>選取的照片沒有拍攝時間，無法建立時間區段</div>
              )}
              {preview.missingTimeCount > 0 && (
                <div style={{ color: '#b45309' }}>
                  其中 {preview.missingTimeCount} 張缺少拍攝時間，不會納入區段
                </div>
              )}
              {preview.existingExifCount > 0 && (
                <div style={{ color: '#b45309' }}>
                  其中 {preview.existingExifCount} 張已有 GPS 座標
                </div>
              )}
            </div>
          )}

          {/* 顯示順序與時間順序不一致時，選取範圍會意外涵蓋其他照片 —— 攤開來讓使用者決定 */}
          {hasRangeWarning && (
            <div style={{
              background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 10,
              padding: '12px 14px', fontSize: 13.5, lineHeight: 1.7, marginBottom: 14,
            }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                另有 {preview!.alsoInRange.length} 張照片也落在此時間範圍內，但未被選取
              </div>
              <div style={{ color: '#78350f', marginBottom: 8 }}>
                相簿的顯示順序不一定等於拍攝時間順序，若曾手動排序過就會出現這種情況。
              </div>
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={includeAlsoInRange}
                  onChange={(e) => setIncludeAlsoInRange(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>連同這 {preview!.alsoInRange.length} 張一起套用</span>
              </label>
            </div>
          )}

          <label style={{ display: 'block', fontSize: 13.5, marginBottom: 6, fontWeight: 600 }}>
            搜尋地點或貼上座標
          </label>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="難波、台北101，或 25.033964, 121.564468"
            style={{
              width: '100%', padding: '9px 12px', borderRadius: 8,
              border: '1px solid #cbd5e1', fontSize: 14, marginBottom: 8,
            }}
          />
          {searching && <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0' }}>搜尋中…</p>}
          {typedCoords && (
            <p style={{ fontSize: 13, color: '#2563eb', margin: '4px 0 8px' }}>
              認得是座標，已直接釘在地圖上
            </p>
          )}

          {hits.length > 0 && (
            <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, marginBottom: 12, overflow: 'hidden' }}>
              {hits.map((h, i) => (
                <button
                  key={`${h.lat},${h.lng},${i}`}
                  onClick={() => {
                    setHits([]);
                    // 釘到地圖上就等於選好了（place 是從 pin 算出來的）。
                    // 名字視為使用者自己給的，不讓反查蓋掉
                    setPin({ lat: h.lat, lng: h.lng });
                    setPinName(h.name);
                    nameTouchedRef.current = true;
                  }}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px',
                    border: 'none', borderTop: i === 0 ? 'none' : '1px solid #f1f5f9',
                    background: '#fff', cursor: 'pointer', fontSize: 13.5,
                  }}
                >
                  {h.name}
                  <span style={{ color: '#94a3b8', fontSize: 12 }}>
                    {'  '}{h.lat.toFixed(4)}, {h.lng.toFixed(4)}
                  </span>
                </button>
              ))}
            </div>
          )}

          <div style={{
            border: '1px solid #e2e8f0', borderRadius: 10,
            padding: 12, marginBottom: 12,
          }}>
            <div style={{ fontSize: 12.5, color: '#64748b', marginBottom: 8, lineHeight: 1.6 }}>
              在地圖上點一下就是打卡位置。地名搜尋用的是 OpenStreetMap，
              小店家常常沒收錄，這時候自己點、或從 Google 地圖複製座標貼到上面最快。
            </div>

            <PlacePickerMap
              center={pin ?? anchor}
              value={pin}
              onPick={handlePick}
              className={styles.map}
            />

            <label style={{ display: 'block', fontSize: 13.5, fontWeight: 600, margin: '12px 0 6px' }}>
              打卡地點名稱
            </label>
            <input
              value={pinName}
              onChange={(e) => { nameTouchedRef.current = true; setPinName(e.target.value); }}
              placeholder="例如：阿婆麵店"
              style={{
                width: '100%', padding: '9px 12px', borderRadius: 8,
                border: '1px solid #cbd5e1', fontSize: 14,
              }}
            />

            <div style={{ fontSize: 12.5, marginTop: 10, color: pin ? '#64748b' : '#b45309' }}>
              {!pin
                ? '尚未選定位置 —— 在地圖上點一下、或貼上座標'
                // 沒取名字時 place.name 本來就是座標，印兩次很蠢
                : pinName.trim()
                  ? `已選：${pinName.trim()}（${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}）`
                  : `已選：${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`}
            </div>
          </div>

          {error && (
            <div style={{
              background: '#fef2f2', border: '1px solid #fca5a5', color: '#b91c1c',
              borderRadius: 8, padding: '10px 12px', fontSize: 13.5, marginBottom: 14,
              lineHeight: 1.6,
            }}>
              套用失敗：{error}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13.5 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: noTimeRange ? 'not-allowed' : 'pointer', opacity: noTimeRange ? 0.5 : 1 }}>
              <input
                type="checkbox"
                checked={createSegment && !noTimeRange}
                disabled={noTimeRange}
                onChange={(e) => setCreateSegment(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                同時建立行程段
                <span style={{ color: '#64748b', display: 'block', fontSize: 12.5 }}>
                  之後加進來的照片，只要落在這個時間範圍就會自動套用同一地點
                </span>
              </span>
            </label>

            {preview && preview.existingExifCount > 0 && (
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={overwriteExif}
                  onChange={(e) => setOverwriteExif(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>
                  覆蓋已有 GPS 的照片
                  <span style={{ color: '#64748b', display: 'block', fontSize: 12.5 }}>
                    預設不覆蓋 —— 照片自帶的 GPS 比手動指定精確
                  </span>
                </span>
              </label>
            )}
          </div>
        </div>

        <div className={styles.foot}>
          <button
            onClick={onClose}
            style={{
              padding: '9px 18px', borderRadius: 8, border: '1px solid #cbd5e1',
              background: '#fff', cursor: 'pointer', fontSize: 14,
            }}
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={!place || submitting}
            style={{
              padding: '9px 18px', borderRadius: 8, border: 'none',
              background: place ? '#2563eb' : '#cbd5e1', color: '#fff',
              cursor: place && !submitting ? 'pointer' : 'not-allowed', fontSize: 14,
            }}
          >
            {submitting ? '套用中…' : '套用地點'}
          </button>
        </div>
      </div>
    </div>
  );
}
