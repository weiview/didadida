import React, { useEffect, useState } from "react";
import styles from "./lightbox.module.css";
import { Photo, Tag, updatePhoto, addPhotoTag, removePhotoTag, photoFullSrc } from "@/lib/api";
import { DEFAULT_TZ_OFFSET_MINUTES, formatWallClock, parseExifDateTime, wallClockFromInstant } from "@/lib/geo";
import { formatTzOffset } from "@/lib/tz";

// 只有顯示用的中文說明，值域本身定義在 geo.ts
const TIME_SOURCE_LABEL: Record<string, string> = {
  manual: '手動修正',
  offset_tag: '相機寫入的時區',
  gps_utc: 'GPS 時間推算',
  file_time: '檔案時間',
  assumed: `假設為 ${formatTzOffset(DEFAULT_TZ_OFFSET_MINUTES)}（未經確認）`,
};

interface PhotoLightboxProps {
  photo: Photo;
  isAdmin: boolean;
  availableTags: Tag[];
  onClose: () => void;
  onUpdate: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
}

export default function PhotoLightbox({ photo, isAdmin, availableTags, onClose, onUpdate, onPrev, onNext, hasPrev, hasNext }: PhotoLightboxProps) {
  const [showExif, setShowExif] = useState(false);
  
  const [descValue, setDescValue] = useState(photo.description || "");
  const [isSavingDesc, setIsSavingDesc] = useState(false);
  const [isEditingDesc, setIsEditingDesc] = useState(false);
  
  const [newTagName, setNewTagName] = useState("");
  const [isAddingTag, setIsAddingTag] = useState(false);

  useEffect(() => {
    setDescValue(photo.description || "");
    setIsEditingDesc(false);
  }, [photo.id, photo.description]);

  // Swipe State
  const [touchStart, setTouchStart] = useState<number | null>(null);
  const [touchEnd, setTouchEnd] = useState<number | null>(null);
  const minSwipeDistance = 50;

  const onTouchStartEvent = (e: React.TouchEvent) => {
    setTouchEnd(null);
    setTouchStart(e.targetTouches[0].clientX);
  };

  const onTouchMoveEvent = (e: React.TouchEvent) => {
    setTouchEnd(e.targetTouches[0].clientX);
  };

  const onTouchEndEvent = () => {
    if (!touchStart || !touchEnd) return;
    const distance = touchStart - touchEnd;
    const isLeftSwipe = distance > minSwipeDistance;
    const isRightSwipe = distance < -minSwipeDistance;
    if (isLeftSwipe && onNext && hasNext) {
      onNext();
    }
    if (isRightSwipe && onPrev && hasPrev) {
      onPrev();
    }
  };

  // 燈箱開啟時鎖定背景 body 滾動，並支援鍵盤 (Left/Right/Esc) 與 滾輪切換照片
  React.useEffect(() => {
    const originalStyle = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && hasPrev && onPrev) onPrev();
      else if (e.key === "ArrowRight" && hasNext && onNext) onNext();
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = originalStyle;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [hasPrev, hasNext, onPrev, onNext, onClose]);

  // 支援滑鼠滾輪切換照片 (滾輪往下: 下一張; 滾輪往上: 上一張)
  const handleWheel = (e: React.WheelEvent) => {
    // 若在編輯框或輸入框內滾動則不觸發切換
    if ((e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'INPUT') {
      return;
    }
    if (e.deltaY > 30 && hasNext && onNext) {
      onNext();
    } else if (e.deltaY < -30 && hasPrev && onPrev) {
      onPrev();
    }
  };

  const parsedExif = photo.exif ? JSON.parse(photo.exif) : null;

  // 拍攝時間一律顯示照片自己的牆上時間加上時區標籤。
  // 不用 new Date(taken_at).toLocaleString() —— 那會換算成「看照片的人所在的時區」，
  // 在日本拍的照片用台灣的瀏覽器打開會少三小時，看起來像資料壞了。
  //
  // 沒有 taken_at_local 的舊資料要走退路，三層由可信到最不可信：
  //   1. exif.DateTimeOriginal 是不帶時區的牆上時間（'2026:06:18 16:11:00'）→ 直接用
  //   2. taken_at 是真正的 UTC 瞬間，配上這張照片自己的時區 → 換算得到牆上時間
  //   3. 舊 exif blob 裡序列化過的 '2026-06-18T08:11:00.000Z' → 最後手段
  //
  // 第 3 層要擺最後，是因為那個字串其實不是可靠的瞬間：exifr 會用「解析當下的
  // 執行環境時區」把 EXIF 時間 revive 成 Date（同一張照片在瀏覽器得 08:11Z、
  // 在 Worker 得 16:11Z），JSON.stringify 之後就把那個時區烤了進去。要還原只能
  // 賭當初上傳的瀏覽器時區，所以只有在 taken_at 也沒有時才用它。
  // 硬把它當第 1 層那種字串讀的話，台灣的照片會顯示成早上 8 點（少 8 小時）。
  // 時區未知時退回站台預設值，但 displayDate 不會為此加上時區標籤 —— 那是猜的。
  const tzForFallback = photo.tz_offset_minutes ?? DEFAULT_TZ_OFFSET_MINUTES;
  const exifWall =
    parseExifDateTime(parsedExif?.DateTimeOriginal)
    ?? wallClockFromInstant(photo.taken_at, tzForFallback)
    ?? wallClockFromInstant(parsedExif?.DateTimeOriginal, tzForFallback);
  const wallClock = photo.taken_at_local || (exifWall ? formatWallClock(exifWall) : null);
  const displayDate = wallClock
    ? (photo.tz_offset_minutes != null
        ? `${wallClock}　${formatTzOffset(photo.tz_offset_minutes)}`
        : wallClock)
    : null;

  const handleSaveDesc = async () => {
    setIsSavingDesc(true);
    const success = await updatePhoto(photo.id, { description: descValue });
    if (success) {
      onUpdate();
      setIsEditingDesc(false);
    }
    setIsSavingDesc(false);
  };

  const handleAddTag = async () => {
    if (!newTagName.trim()) return;
    setIsAddingTag(true);
    const tag = await addPhotoTag(photo.id, newTagName.trim());
    if (tag) {
      setNewTagName("");
      onUpdate();
    }
    setIsAddingTag(false);
  };

  const handleRemoveTag = async (tagId: number) => {
    const success = await removePhotoTag(photo.id, tagId);
    if (success) onUpdate();
  };

  const formatExposureTime = (time: number | string | undefined) => {
    if (!time) return null;
    const t = Number(time);
    if (isNaN(t) || t === 0) return time;
    if (t >= 1) return `${t}s`;
    return `1/${Math.round(1 / t)}s`;
  };

  const exifItems = [
    { label: '相機', value: parsedExif?.Make },
    { label: '型號', value: parsedExif?.Model },
    { label: '鏡頭', value: parsedExif?.LensModel },
    { label: '光圈', value: parsedExif?.FNumber ? `f/${parsedExif.FNumber}` : null },
    { label: '快門', value: formatExposureTime(parsedExif?.ExposureTime) },
    { label: 'ISO', value: parsedExif?.ISO },
    { label: '焦距', value: parsedExif?.FocalLength ? `${parsedExif.FocalLength}mm` : null },
  ].filter(item => item.value);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <button className={styles.closeBtn} onClick={(e) => { e.stopPropagation(); onClose(); }} title="關閉">×</button>
      
      <div className={styles.content} onClick={e => e.stopPropagation()}>
        
        <div 
          className={styles.imageContainer}
          onTouchStart={onTouchStartEvent}
          onTouchMove={onTouchMoveEvent}
          onTouchEnd={onTouchEndEvent}
        >
          {/* 走 Worker 代理拿 Drive 的 4K；沒有 Drive 版本會自動退回 R2 的 2000px */}
          <img src={photoFullSrc(photo)} alt={photo.title} className={styles.image} />
          {hasPrev && (
            <button className={`${styles.navButton} ${styles.prevButton}`} onClick={(e) => { e.stopPropagation(); onPrev?.(); }}>
              &#10094;
            </button>
          )}
          {hasNext && (
            <button className={`${styles.navButton} ${styles.nextButton}`} onClick={(e) => { e.stopPropagation(); onNext?.(); }}>
              &#10095;
            </button>
          )}
        </div>
        
        <div className={styles.detailsContainer}>
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <h3>Story</h3>
              {isAdmin && (
                <div className={styles.switchWrapper}>
                  <span>編輯</span>
                  <label className={styles.switch}>
                    <input type="checkbox" checked={isEditingDesc} onChange={(e) => setIsEditingDesc(e.target.checked)} />
                    <span className={styles.slider}></span>
                  </label>
                </div>
              )}
            </div>
            {isAdmin && isEditingDesc ? (
              <div className={styles.editGroup}>
                <textarea 
                  value={descValue} 
                  onChange={e => setDescValue(e.target.value)} 
                  className={styles.textarea}
                  placeholder="輸入 Story (上限 200 字)..."
                  maxLength={200}
                />
                <button className={styles.btn} onClick={handleSaveDesc} disabled={isSavingDesc || descValue === (photo.description || "")}>
                  儲存
                </button>
              </div>
            ) : (
              photo.description ? <p style={{ margin: 0, color: '#ccc', lineHeight: '1.5', fontSize: '0.85rem' }}>{photo.description}</p> : null
            )}
          </div>

          <div className={styles.section}>
            <h3>標籤</h3>
            <div className={styles.tagsArea} onClick={() => { if(isAdmin && (photo.tags?.length || 0) < 10) document.getElementById('tag-input')?.focus() }}>
              {photo.tags?.map(tag => (
                <span key={tag.id} className={styles.tag}>
                  {tag.name}
                  {isAdmin && (
                    <span className={styles.removeTag} onClick={(e) => { e.stopPropagation(); handleRemoveTag(tag.id); }}>×</span>
                  )}
                </span>
              ))}
              {isAdmin && (photo.tags?.length || 0) < 10 && (
                <>
                  <input 
                    id="tag-input"
                    type="text" 
                    value={newTagName} 
                    onChange={e => setNewTagName(e.target.value)} 
                    onBlur={() => { if(newTagName.trim()) handleAddTag() }}
                    onKeyDown={e => { if(e.key === 'Enter') handleAddTag() }}
                    placeholder="新增標籤..."
                    className={styles.framelessInput}
                    list="available-tags"
                  />
                  <datalist id="available-tags">
                    {availableTags.map(t => <option key={t.id} value={t.name} />)}
                  </datalist>
                </>
              )}
              {!photo.tags?.length && !isAdmin && <span style={{ color: '#777' }}>無標籤</span>}
            </div>

            {/* 管理員新增標籤時：快捷選取既有標籤膠囊按鈕 */}
            {isAdmin && (photo.tags?.length || 0) < 10 && availableTags.filter(t => !photo.tags?.some(pt => pt.name === t.name)).length > 0 && (
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px', alignItems: 'center' }}>
                <span style={{ fontSize: '0.75rem', color: '#888' }}>快速加入既有標籤：</span>
                {availableTags
                  .filter(t => !photo.tags?.some(pt => pt.name === t.name))
                  .map(t => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={async (e) => {
                        e.stopPropagation();
                        setIsAddingTag(true);
                        const tag = await addPhotoTag(photo.id, t.name);
                        if (tag) onUpdate();
                        setIsAddingTag(false);
                      }}
                      style={{
                        background: 'rgba(255, 255, 255, 0.08)',
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        color: 'rgba(255, 255, 255, 0.9)',
                        padding: '2px 8px',
                        borderRadius: '12px',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                        transition: 'all 0.2s ease'
                      }}
                      onMouseOver={(e) => { e.currentTarget.style.background = 'var(--accent-color)'; e.currentTarget.style.color = '#fff'; }}
                      onMouseOut={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)'; e.currentTarget.style.color = 'rgba(255, 255, 255, 0.9)'; }}
                    >
                      + {t.name}
                    </button>
                  ))}
              </div>
            )}
          </div>

          {/* 位置與時間的編輯已移到「上傳後的補件視窗」與相簿頁的批次操作 ——
              燈箱是看照片的地方，這裡只留唯讀的地點 */}
          {isAdmin && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h3>地點</h3>
              </div>
              <span className={styles.exifValue}>{photo.place_name || '尚未指定地點'}</span>
            </div>
          )}

          <div className={styles.exifToggleRow}>
            <div className={styles.switchWrapper}>
              <span>顯示照片資訊 (EXIF)</span>
              <label className={styles.switch}>
                <input type="checkbox" checked={showExif} onChange={(e) => setShowExif(e.target.checked)} />
                <span className={styles.slider}></span>
              </label>
            </div>
          </div>

          {showExif && (
            <div className={styles.exifContainer}>
              <div className={styles.exifGrid}>
                {/* 拍攝時間整合至 EXIF 區域首位。要改時間請在相簿頁選取照片後用「修正時間」，
                    那裡才會一起維護牆上時間與時區的對應關係 */}
                <div className={styles.exifItem}>
                  <span className={styles.exifLabel}>拍攝時間</span>
                  <span className={styles.exifValue}>{displayDate || "未知"}</span>
                </div>

                {/* 時間來源決定這張照片的時間可不可信 —— assumed 的照片不該拿去比對 GPS 軌跡 */}
                <div className={styles.exifItem}>
                  <span className={styles.exifLabel}>時間來源</span>
                  <span className={styles.exifValue}>
                    {(photo.time_source && TIME_SOURCE_LABEL[photo.time_source]) || '—'}
                  </span>
                </div>

                {exifItems.length > 0 ? (
                  exifItems.map(item => (
                    <div className={styles.exifItem} key={item.label}>
                      <span className={styles.exifLabel}>{item.label}</span>
                      <span className={styles.exifValue}>{item.value}</span>
                    </div>
                  ))
                ) : (
                  !displayDate && <div className={styles.exifItem}><span className={styles.exifValue} style={{ color: '#888' }}>此照片無其他 EXIF 參數</span></div>
                )}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
