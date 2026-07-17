import React, { useState, useEffect } from "react";
import styles from "./lightbox.module.css";
import { Photo, Tag, updatePhoto, addPhotoTag, removePhotoTag } from "@/lib/api";

interface PhotoLightboxProps {
  photo: Photo;
  isAdmin: boolean;
  availableTags: Tag[];
  onClose: () => void;
  onUpdate: () => void;
}

export default function PhotoLightbox({ photo, isAdmin, availableTags, onClose, onUpdate }: PhotoLightboxProps) {
  const [showExif, setShowExif] = useState(false);
  
  const [descValue, setDescValue] = useState(photo.description || "");
  const [isSavingDesc, setIsSavingDesc] = useState(false);
  
  const [dateValue, setDateValue] = useState(photo.taken_at ? photo.taken_at.split('T')[0] : "");
  const [isSavingDate, setIsSavingDate] = useState(false);
  
  const [newTagName, setNewTagName] = useState("");
  const [isAddingTag, setIsAddingTag] = useState(false);

  const hasExifDate = !!(photo.exif && JSON.parse(photo.exif).DateTimeOriginal);
  const parsedExif = photo.exif ? JSON.parse(photo.exif) : null;

  const handleSaveDesc = async () => {
    setIsSavingDesc(true);
    const success = await updatePhoto(photo.id, { description: descValue });
    if (success) onUpdate();
    setIsSavingDesc(false);
  };

  const handleSaveDate = async () => {
    setIsSavingDate(true);
    const success = await updatePhoto(photo.id, { taken_at: dateValue ? new Date(dateValue).toISOString() : undefined });
    if (success) onUpdate();
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

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.content} onClick={e => e.stopPropagation()}>
        <button className={styles.closeBtn} onClick={onClose}>×</button>
        
        <div className={styles.imageContainer}>
          <img src={photo.url} alt={photo.title} className={styles.image} />
        </div>
        
        <div className={styles.detailsContainer}>
          <h2 className={styles.title}>{photo.title}</h2>
          
          <div className={styles.section}>
            <h3>說明</h3>
            {isAdmin ? (
              <div className={styles.editGroup}>
                <textarea 
                  value={descValue} 
                  onChange={e => setDescValue(e.target.value)} 
                  className={styles.textarea}
                  placeholder="新增相片說明..."
                />
                <button onClick={handleSaveDesc} disabled={isSavingDesc || descValue === photo.description}>
                  儲存說明
                </button>
              </div>
            ) : (
              <p>{photo.description || "無說明"}</p>
            )}
          </div>

          <div className={styles.section}>
            <h3>拍攝日期</h3>
            {isAdmin && !hasExifDate ? (
              <div className={styles.editGroup}>
                <input 
                  type="date" 
                  value={dateValue} 
                  onChange={e => setDateValue(e.target.value)} 
                  className={styles.input}
                />
                <button onClick={handleSaveDate} disabled={isSavingDate}>儲存日期</button>
              </div>
            ) : (
              <p>{photo.taken_at ? new Date(photo.taken_at).toLocaleDateString() : (parsedExif?.DateTimeOriginal ? new Date(parsedExif.DateTimeOriginal).toLocaleDateString() : "未知")}</p>
            )}
            {hasExifDate && <small className={styles.hint}>(來源: EXIF 無法修改)</small>}
          </div>

          <div className={styles.section}>
            <h3>標籤</h3>
            <div className={styles.tags}>
              {photo.tags?.map(tag => (
                <span key={tag.id} className={styles.tag}>
                  {tag.name}
                  {isAdmin && (
                    <span className={styles.removeTag} onClick={() => handleRemoveTag(tag.id)}> ×</span>
                  )}
                </span>
              ))}
            </div>
            {isAdmin && (
              <div className={styles.addTagGroup}>
                <input 
                  type="text" 
                  value={newTagName} 
                  onChange={e => setNewTagName(e.target.value)} 
                  placeholder="輸入新標籤..."
                  className={styles.input}
                  list="available-tags"
                />
                <datalist id="available-tags">
                  {availableTags.map(t => <option key={t.id} value={t.name} />)}
                </datalist>
                <button onClick={handleAddTag} disabled={isAddingTag || !newTagName.trim()}>新增</button>
              </div>
            )}
          </div>

          <div className={styles.section}>
            <button className={styles.toggleExifBtn} onClick={() => setShowExif(!showExif)}>
              {showExif ? "隱藏 EXIF 資訊" : "顯示 EXIF 資訊"}
            </button>
            {showExif && (
              <div className={styles.exifData}>
                {parsedExif ? (
                  <pre>{JSON.stringify(parsedExif, null, 2)}</pre>
                ) : (
                  <p>此照片無 EXIF 資訊</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
