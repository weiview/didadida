"use client";

import { useEffect, useState, useRef, Suspense } from "react";
import styles from "./album.module.css";
import Link from "next/link";
import { Photo, fetchPhotos, uploadPhoto, fetchAlbums, deletePhoto, verifyLogin, reorderPhotos } from "@/lib/api";
import { resizeImageFile } from "@/lib/imageUtils";
import { useSearchParams } from "next/navigation";

function AlbumContent() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  
  const [albumName, setAlbumName] = useState("相簿");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Drag and drop state
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [longPressIndex, setLongPressIndex] = useState<number | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const loadData = async () => {
    if (!id) return;
    setLoading(true);
    const allAlbums = await fetchAlbums();
    const current = allAlbums.find(a => String(a.id) === id);
    if (current) setAlbumName(current.name);
    
    const photoData = await fetchPhotos(id);
    setPhotos(photoData || []);
    setLoading(false);

    // Check auth
    if (typeof window !== "undefined") {
      const pwd = localStorage.getItem("admin_password");
      if (pwd) {
        const valid = await verifyLogin(pwd);
        setIsAdmin(valid);
        if (!valid) localStorage.removeItem("admin_password");
      }
    }
  };

  useEffect(() => {
    if (id) {
      loadData();
    }
  }, [id]);

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!id) return;
    const rawFile = e.target.files?.[0];
    if (!rawFile) return;

    setUploading(true);
    try {
      // 縮圖處理 (長邊不超過 2000px)
      const file = await resizeImageFile(rawFile, 2000);
      const success = await uploadPhoto(id, file);
      if (success) {
        loadData(); // 重新整理照片
      } else {
        alert("上傳失敗，請稍後再試。");
      }
    } catch (err) {
      console.error(err);
      alert("縮圖或上傳過程中發生錯誤");
    }
    setUploading(false);
    
    // reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleDeletePhoto = async (photoId: number) => {
    if (!window.confirm("確定要刪除這張照片嗎？")) return;
    const success = await deletePhoto(photoId);
    if (success) {
      loadData();
    } else {
      alert("刪除失敗，請稍後再試。");
    }
  };

  // Drag and Drop handlers
  const handlePointerDown = (index: number) => {
    if (!isAdmin) return;
    timerRef.current = setTimeout(() => {
      setLongPressIndex(index);
    }, 1000);
  };

  const handlePointerUpOrLeave = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const handleDragStart = (index: number) => {
    dragItem.current = index;
    setDraggingIndex(index);
  };

  const handleDragEnter = (index: number) => {
    if (dragItem.current !== null && dragItem.current !== index) {
      dragOverItem.current = index;
      
      const newPhotos = [...photos];
      const draggedItemContent = newPhotos.splice(dragItem.current, 1)[0];
      newPhotos.splice(index, 0, draggedItemContent);
      setPhotos(newPhotos); // 立即樂觀更新 UI
      
      dragItem.current = index;
      setDraggingIndex(index);
    }
  };

  const handleDragEnd = async () => {
    if (dragItem.current !== null) {
      // 呼叫 API 儲存新的排序順序
      const updates = photos.map((photo, index) => ({
        id: photo.id,
        sort_order: index,
      }));
      const success = await reorderPhotos(updates);
      if (!success) {
        alert("儲存排序失敗");
        loadData(); // 恢復原狀
      }
    }
    dragItem.current = null;
    dragOverItem.current = null;
    setDraggingIndex(null);
    setLongPressIndex(null);
  };

  return (
    <div className={styles.container}>
      <Link href="/" className={styles.backButton}>
        ← 返回相簿列表
      </Link>

      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>{albumName}</h1>
          <p className={styles.meta}>共 {photos.length} 張照片</p>
        </div>
        {isAdmin && (
          <div>
            <input 
              type="file" 
              ref={fileInputRef} 
              style={{ display: 'none' }} 
              accept="image/*"
              onChange={handleFileChange}
            />
            <button 
              className={styles.uploadButton} 
              onClick={handleUploadClick}
              disabled={uploading}
            >
              {uploading ? "上傳中..." : "上傳照片"}
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <div className={styles.loading}>載入照片中...</div>
      ) : (
        <div className={styles.photoGrid}>
          {photos.map((photo, index) => (
            <div 
              key={photo.id} 
              className={`${styles.photoCard} ${draggingIndex === index ? styles.dragging : ""} ${longPressIndex === index ? styles.readyToDrag : ""}`}
              draggable={isAdmin && longPressIndex === index}
              onPointerDown={() => handlePointerDown(index)}
              onPointerUp={handlePointerUpOrLeave}
              onPointerLeave={handlePointerUpOrLeave}
              onClick={(e) => {
                if (longPressIndex !== null || draggingIndex !== null) {
                  e.preventDefault();
                  return;
                }
                setSelectedPhoto(photo);
              }}
              onDragStart={() => isAdmin && handleDragStart(index)}
              onDragEnter={() => isAdmin && handleDragEnter(index)}
              onDragEnd={isAdmin ? handleDragEnd : undefined}
              onDragOver={(e) => isAdmin && e.preventDefault()}
            >
              <img src={photo.url} alt={photo.title} className={styles.photoImage} />
              {isAdmin && (
                <button 
                  className={styles.deleteButton} 
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeletePhoto(photo.id);
                  }}
                  title="刪除照片"
                >
                  ×
                </button>
              )}
              <div className={styles.photoOverlay}>
                <h3 className={styles.photoTitle}>{photo.title}</h3>
                <p className={styles.photoDate}>{new Date(photo.created_at).toLocaleDateString()}</p>
              </div>
            </div>
          ))}
          {photos.length === 0 && (
            <div className={styles.emptyState}>
              <p>相簿空空如也，趕快點擊右上角上傳照片吧！</p>
            </div>
          )}
        </div>
      )}

      {/* Lightbox / 大圖檢視 */}
      {selectedPhoto && (
        <div className={styles.lightboxOverlay} onClick={() => setSelectedPhoto(null)}>
          <div className={styles.lightboxContent} onClick={e => e.stopPropagation()}>
            <img src={selectedPhoto.url} alt={selectedPhoto.title} className={styles.lightboxImage} />
            <button className={styles.lightboxClose} onClick={() => setSelectedPhoto(null)}>×</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AlbumPage() {
  return (
    <Suspense fallback={<div className={styles.loading}>載入中...</div>}>
      <AlbumContent />
    </Suspense>
  );
}
