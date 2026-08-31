'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  previewGeoBatch, assignGeoBatch, searchPlace, reverseGeocode, fetchFootprint,
  fetchPlaces, deletePlace,
  type GeoPreview, type SavedPlace,
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

/**
 * 名稱欄那個下拉一次最多畫幾列。地點簿上限 300 筆，全部塞進 DOM 沒必要 ——
 * 真的多到列不完的時候，打兩個字比捲三百列快。
 */
const PLACE_MENU_MAX = 50;

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

  /**
   * 地點簿：以前套用過的地點（全站共用一份，見 migrations/0023）。
   * 同一家店不必每一本相簿都重新搜尋、重新在地圖上找一次。
   */
  const [places, setPlaces] = useState<SavedPlace[]>([]);
  /** 名稱欄底下那個下拉開著沒 */
  const [placeMenuOpen, setPlaceMenuOpen] = useState(false);

  const [createSegment, setCreateSegment] = useState(true);
  const [includeAlsoInRange, setIncludeAlsoInRange] = useState(false);
  const [overwriteExif, setOverwriteExif] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 使用者自己打過名字之後，反查回來的建議就不該再蓋掉他
  const nameTouchedRef = useRef(false);
  /** 名稱欄那一整塊（輸入框＋下拉），用來判斷「點到外面了沒」 */
  const placeBoxRef = useRef<HTMLDivElement | null>(null);
  /** 搜尋欄那一整塊。兩格並排之後地名搜尋結果也變成絕對定位的下拉，同樣要收 */
  const searchBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setPreview(null);
    setQuery(''); setHits([]); setError('');
    setPin(null); setPinName(''); setAnchor(null);
    nameTouchedRef.current = false;
    setCreateSegment(true); setIncludeAlsoInRange(false); setOverwriteExif(false);

    setPlaceMenuOpen(false);

    setLoadingPreview(true);
    previewGeoBatch(photoIds)
      .then(setPreview)
      .finally(() => setLoadingPreview(false));

    // 每次開都重讀：上一次套用可能剛好新增了一個地點，別人在別的分頁存的也會進來
    fetchPlaces().then(setPlaces);
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
    // 已經有自己給的名字（打的、或從地點簿挑的）就連問都不用問 ——
    // 反查回來的東西反正會被丟掉，而那是一次外部 API 請求
    if (nameTouchedRef.current) return;
    // 反查只是給個名字建議。查不到（OSM 沒收錄）也無所謂，自己打就是了
    reverseGeocode(lat, lng).then((name) => {
      if (name && !nameTouchedRef.current) setPinName(name);
    });
  }, []);

  /**
   * 要送出去的地點：圖上那根釘子就是位置，不另外存一份 state。
   *
   * ⚠️ **座標與名稱兩個都要有**才算數。以前沒取名字就拿座標當名字頂上，
   *    於是相簿裡會留下一串 `25.03396, 121.56447` 認不出是哪裡；而地點簿
   *    （0023）是**照名字認人**的，沒有名字就存不進去給別本相簿選。
   *    後端 `/api/photos/geo/batch` 也擋著，那一道才是真的關。
   * ⚠️ 缺什麼一定要**寫在按鈕旁邊**（見底下的 blockReason）——
   *    灰掉的按鈕按下去完全沒反應，沒人看得出自己少做了哪一步。
   *    這支元件以前就踩過一次（那顆多餘的「使用這個位置」）。
   */
  const trimmedName = pinName.trim();
  const place = useMemo<PlaceHit | null>(() => {
    if (!pin || !trimmedName) return null;
    return { name: trimmedName, lat: pin.lat, lng: pin.lng };
  }, [pin, trimmedName]);

  /** 還差什麼才套得下去。null＝可以套了 */
  const blockReason = !pin
    ? '還沒選位置 —— 在地圖上點一下、或貼上座標'
    : !trimmedName
      ? '還沒填打卡地點名稱'
      : null;

  /** 搜尋框裡打的是座標而不是地名時，就是這個值 */
  const typedCoords = useMemo(() => parseLatLng(query), [query]);

  /**
   * 地點簿裡符合目前**名稱欄**輸入的那幾筆。這份清單掛在「打卡地點名稱」
   * 底下（可以自己打，也可以從下拉挑），**不是**掛在地名搜尋那一格。
   *
   * 為什麼在這一格：地點簿認的就是名字（`Place.name` UNIQUE），而挑一個
   * 存過的地點等於「名稱與座標一次填好」，本來就是名稱欄要回答的事；
   * 掛在搜尋框那邊等於同一件事有兩個入口。
   * 純記憶體過濾，不打任何一次 API（開視窗時就整份拿回來了）。
   */
  const placeHits = useMemo(() => {
    const q = trimmedName.toLowerCase();
    if (!q) return places.slice(0, PLACE_MENU_MAX);
    return places.filter((pl) => pl.name.toLowerCase().includes(q)).slice(0, PLACE_MENU_MAX);
  }, [places, trimmedName]);

  /**
   * 名稱欄現在打的字剛好就是地點簿裡的某一筆。
   * ⚠️ 比對要**一模一樣**（含大小寫）—— `Place.name` 那個 UNIQUE 索引沒有
   *    COLLATE NOCASE，後端 upsert 認的是同一個字串。這裡放寬會講出一句
   *    「座標會被更新」然後實際上多存一筆，比不講還糟。
   */
  const namedPlace = useMemo(
    () => (trimmedName ? places.find((pl) => pl.name === trimmedName) ?? null : null),
    [places, trimmedName],
  );

  /**
   * 名字對得上、但釘子被移到別的地方了。套用下去地點簿裡那一筆的座標就會
   * 更新成現在這一點（使用者拍板：名字是身分，座標以最新那一次為準）。
   * 這件事要先講出來 —— 那份清單是全站共用的，只是想借名字的人會安靜地
   * 把別人標好的位置改掉。
   */
  const movesPlace = !!(
    namedPlace && pin &&
    (Math.abs(namedPlace.lat - pin.lat) > 1e-6 || Math.abs(namedPlace.lng - pin.lng) > 1e-6)
  );

  /**
   * 選一個存過的地點：**座標與名字一起帶進來**，一步到位。
   *
   * 座標同時寫回旁邊那個「搜尋地點或貼上座標」欄 —— 那一格就是這個站
   * 拿來改座標的地方，帶進去之後想微調位置直接改那串數字（或在地圖上
   * 重點一下）就好，套用之後地點簿裡的座標跟著更新。
   * ⚠️ 寫回去的是**原值不是 toFixed** —— 四捨五入再解析回來，會讓每一次
   *    「只是選了一下又套用」都把地點簿裡的座標推移幾公分。
   */
  const usePlace = useCallback((pl: SavedPlace) => {
    setHits([]);
    setPlaceMenuOpen(false);
    setQuery(`${pl.lat}, ${pl.lng}`);
    setPin({ lat: pl.lat, lng: pl.lng });
    setPinName(pl.name);
    // 這是使用者自己挑的名字，不讓反查蓋掉
    nameTouchedRef.current = true;
  }, []);

  /**
   * 從地點簿移除。清單是每套用一次就自己長一列的，打錯字的那筆得有人收得掉。
   * ⚠️ 話要講清楚：刪的只是捷徑，已經標好的照片完全不受影響。
   */
  const removePlace = useCallback(async (pl: SavedPlace) => {
    const yes = window.confirm(
      `把「${pl.name}」從地點簿移除？\n\n只是收掉這個捷徑，已經標好的照片座標與地名都不會動。`
    );
    if (!yes) return;
    if (await deletePlace(pl.id)) {
      setPlaces((cur) => cur.filter((x) => x.id !== pl.id));
    } else {
      window.alert('移除失敗，請稍後再試');
    }
  }, []);

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

  /**
   * 點到外面就把下拉收起來。
   * ⚠️ 聽的是 `mousedown` 不是 `click`：清單那幾列自己吃 click，
   *    等到 click 才收會先把清單收掉，於是點下去什麼都沒選到。
   */
  useEffect(() => {
    if (!placeMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (placeBoxRef.current && !placeBoxRef.current.contains(e.target as Node)) {
        setPlaceMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [placeMenuOpen]);

  /**
   * 地名搜尋結果同上。它以前是接在輸入框底下、把整頁往下推的一塊，
   * 兩格並排之後改成絕對定位的下拉（不然一行兩格會被搜尋結果撐開），
   * 於是也需要一條「點到外面就收起來」。
   * ⚠️ 同樣聽 `mousedown` 不是 `click`，理由見上面那一段。
   */
  useEffect(() => {
    if (hits.length === 0) return;
    const onDown = (e: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
        setHits([]);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [hits.length]);

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

          <div style={{
            border: '1px solid #e2e8f0', borderRadius: 10,
            padding: 12, marginBottom: 12,
          }}>
            <div style={{ fontSize: 12.5, color: '#64748b', marginBottom: 8, lineHeight: 1.6 }}>
              在地圖上點一下就是打卡位置。地名搜尋用的是 OpenStreetMap，
              小店家常常沒收錄，這時候自己點、或從 Google 地圖複製座標貼到底下
              「搜尋地點或貼上座標」那一格最快。
            </div>

            <PlacePickerMap
              center={pin ?? anchor}
              value={pin}
              onPick={handlePick}
              className={styles.map}
            />

            {/*
              * 地圖底下那一行：**打卡地點名稱 ＋ 搜尋地點或貼上座標並排**。
              * 兩格都塞不滿整行，各自佔一整行只會把地圖與底下的「套用地點」
              * 一路往下推；手機上放不下就靠 flex-wrap 自己折成上下兩排
              * （見 assignPlace.module.css 的 .fieldRow，刻意不多寫一個斷點）。
              *
              * ⚠️ 名稱擺左邊：它是必填的那一格，而且「從用過的挑一個」是最短的
              *    那條路（名稱與座標一次填好）。手機折行之後它也就排在前面。
              * ⚠️ 兩格的說明都改成輸入框**底下**的小字 —— 掛在 label 上會讓其中
              *    一邊變兩行，兩格的輸入框上緣就對不齊了。
              */}
            <div className={styles.fieldRow}>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>
                  打卡地點名稱
                  <span style={{ color: '#b91c1c', marginLeft: 4 }}>*</span>
                </label>

                {/*
                  * 名稱欄 ＝ 輸入框 ＋ 地點簿下拉。地點簿認的就是名字，所以「挑一個
                  * 用過的地點」掛在這一格，不另外做一塊清單（同一件事不要兩套 UI）。
                  * ⚠️ 外層一定要 position: relative —— 下拉是絕對定位，蓋在底下那幾行上。
                  */}
                <div ref={placeBoxRef} className={styles.fieldAnchor}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      value={pinName}
                      onChange={(e) => {
                        nameTouchedRef.current = true;
                        setPinName(e.target.value);
                        if (places.length > 0) setPlaceMenuOpen(true);
                      }}
                      onFocus={() => { if (places.length > 0) setPlaceMenuOpen(true); }}
                      onKeyDown={(e) => { if (e.key === 'Escape') setPlaceMenuOpen(false); }}
                      placeholder="例如：阿婆麵店"
                      style={{
                        flex: '1 1 auto', minWidth: 0, padding: '9px 12px', borderRadius: 8,
                        border: '1px solid #cbd5e1', fontSize: 14,
                      }}
                    />
                    {/* 一個字都還沒打的時候，這顆是「地點簿在哪裡」唯一的線索 */}
                    {places.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setPlaceMenuOpen((o) => !o)}
                        title="從用過的地點挑一個"
                        style={{
                          flex: 'none', padding: '9px 12px', borderRadius: 8,
                          border: '1px solid #cbd5e1', background: '#fff', color: '#334155',
                          cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap',
                        }}
                      >
                        用過的 {placeMenuOpen ? '▲' : '▼'}
                      </button>
                    )}
                  </div>

                  {placeMenuOpen && places.length > 0 && (
                    <div style={{
                      position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30,
                      background: '#fff', border: '1px solid #cbd5e1', borderRadius: 8,
                      boxShadow: '0 8px 24px rgba(15,23,42,.14)', maxHeight: 240, overflowY: 'auto',
                    }}>
                      {placeHits.length === 0 ? (
                        <div style={{ padding: '10px 12px', fontSize: 13, color: '#94a3b8' }}>
                          地點簿裡還沒有這個名字 —— 直接打完套用，它就會存進去。
                        </div>
                      ) : (
                        placeHits.map((pl, i) => (
                          /*
                            * ⚠️ 一列是 div 包兩顆 button —— button 裡面不能再放 button。
                            *    一列有兩個各自獨立的目標：選它，或把它從地點簿收掉。
                            */
                          <div
                            key={pl.id}
                            style={{
                              display: 'flex', alignItems: 'center',
                              borderTop: i === 0 ? 'none' : '1px solid #f1f5f9',
                            }}
                          >
                            <button
                              type="button"
                              onClick={() => usePlace(pl)}
                              style={{
                                flex: '1 1 auto', minWidth: 0, textAlign: 'left', padding: '9px 12px',
                                border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 13.5,
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              }}
                            >
                              {pl.name}
                              <span style={{ color: '#94a3b8', fontSize: 12 }}>
                                {'  '}{pl.lat.toFixed(4)}, {pl.lng.toFixed(4)}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => removePlace(pl)}
                              title="從地點簿移除（不會動到已經標好的照片）"
                              style={{
                                flex: 'none', border: 'none', background: 'transparent',
                                color: '#94a3b8', cursor: 'pointer', fontSize: 15, padding: '9px 12px',
                              }}
                            >
                              ✕
                            </button>
                          </div>
                        ))
                      )}

                      {placeHits.length === PLACE_MENU_MAX && (
                        <div style={{
                          padding: '6px 12px', fontSize: 12, color: '#94a3b8',
                          borderTop: '1px solid #f1f5f9',
                        }}>
                          只列出前 {PLACE_MENU_MAX} 個，打幾個字縮小範圍
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <p className={styles.fieldNote}>
                  自己打，或從「用過的」挑一個 —— 座標會一起帶進來。套用之後就存進地點簿
                </p>
              </div>

              <div className={styles.field}>
                <label className={styles.fieldLabel}>搜尋地點或貼上座標</label>

                {/*
                  * ⚠️ 搜尋結果改成**絕對定位的下拉**（以前是接在輸入框底下、把整頁
                  *    往下推的一塊）—— 並排之後那一塊會把這一格撐高、旁邊的名稱格
                  *    跟著被拉開。收起來的規則見上面那條 mousedown 的 effect。
                  */}
                <div ref={searchBoxRef} className={styles.fieldAnchor}>
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="難波、台北101，或 25.033964, 121.564468"
                    className={styles.fieldInput}
                  />

                  {hits.length > 0 && (
                    <div className={styles.menu}>
                      {hits.map((h, i) => (
                        <button
                          key={`${h.lat},${h.lng},${i}`}
                          type="button"
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
                </div>

                {searching ? (
                  <p className={styles.fieldNote}>搜尋中…</p>
                ) : typedCoords ? (
                  <p className={styles.fieldNote} style={{ color: '#2563eb' }}>
                    認得是座標，已直接釘在地圖上
                  </p>
                ) : (
                  <p className={styles.fieldNote}>
                    找不到就在地圖上自己點一下，或貼 Google 地圖的座標
                  </p>
                )}
              </div>
            </div>

            {/* 座標與名稱兩格都齊了才是「已選」，缺哪一格就直說缺哪一格 */}
            <div style={{ fontSize: 12.5, marginTop: 10, color: blockReason ? '#b45309' : '#64748b' }}>
              {blockReason ?? `已選：${trimmedName}（${pin!.lat.toFixed(5)}, ${pin!.lng.toFixed(5)}）`}
            </div>

            {/*
              * 名字對得上、位置卻換了 —— 這一次套用會把地點簿裡那一筆搬過來。
              * 全站共用一份清單，所以這件事不能安靜地發生。
              */}
            {movesPlace && (
              <div style={{ fontSize: 12.5, marginTop: 6, color: '#b45309', lineHeight: 1.6 }}>
                「{trimmedName}」在地點簿裡本來是 {namedPlace!.lat.toFixed(5)}, {namedPlace!.lng.toFixed(5)}
                　—— 套用之後會更新成現在這一點。想留著舊的請換一個名字。
              </div>
            )}
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
          {/*
            * 缺什麼要講在按鈕旁邊 —— 「套用地點」灰著的時候按下去完全沒反應，
            * 使用者看不出自己少填了名稱還是少點了位置。
            */}
          {blockReason && (
            <span style={{
              marginRight: 'auto', alignSelf: 'center', fontSize: 13,
              color: '#b45309', lineHeight: 1.4,
            }}>
              {blockReason}
            </span>
          )}
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
