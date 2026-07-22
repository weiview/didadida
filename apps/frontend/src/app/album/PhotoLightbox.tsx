import React, { useState } from "react";
import styles from "./lightbox.module.css";
import { Photo, Tag, updatePhoto, addPhotoTag, removePhotoTag, updateAlbum } from "@/lib/api";

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
  
  const [dateValue, setDateValue] = useState(photo.taken_at ? photo.taken_at.split('T')[0] : "");
  const [isSavingDate, setIsSavingDate] = useState(false);
  
  const [newTagName, setNewTagName] = useState("");
  const [isAddingTag, setIsAddingTag] = useState(false);

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
  const hasExifDate = !!(parsedExif?.DateTimeOriginal);
  
  // 決定要顯示的日期：優先用手動設定的 taken_at，再來用 EXIF 的時間
  let displayDate = null;
  if (photo.taken_at) {
    displayDate = new Date(photo.taken_at).toLocaleString();
  } else if (parsedExif?.DateTimeOriginal) {
    displayDate = new Date(parsedExif.DateTimeOriginal).toLocaleString();
  }

  const handleSaveDesc = async () => {
    setIsSavingDesc(true);
    const success = await updatePhoto(photo.id, { description: descValue });
    if (success) {
      onUpdate();
      setIsEditingDesc(false);
    }
    setIsSavingDesc(false);
  };

  const handleSaveDate = async () => {
    setIsSavingDate(true);
    const success = await updatePhoto(photo.id, { taken_at: dateValue ? new Date(dateValue).toISOString() : undefined });
    if (success) {
      onUpdate();
      // Update local state temporarily for snappy UI
      photo.taken_at = dateValue ? new Date(dateValue).toISOString() : undefined;
    }
    setIsSavingDate(false);
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
          <img src={photo.url} alt={photo.title} className={styles.image} />
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
          </div>

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
                {/* 拍攝時間整合至 EXIF 區域首位 */}
                <div className={styles.exifItem}>
                  <span className={styles.exifLabel}>拍攝時間</span>
                  {isAdmin ? (
                    <div className={styles.exifDateEdit}>
                      <input 
                        type="date" 
                        value={dateValue} 
                        onChange={e => setDateValue(e.target.value)} 
                        className={styles.input}
                      />
                      <button className={styles.btn} onClick={handleSaveDate} disabled={isSavingDate}>儲存</button>
                    </div>
                  ) : (
                    <span className={styles.exifValue}>{displayDate || "未知"}</span>
                  )}
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
