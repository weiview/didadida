"use client";

import { useEffect, useState, useRef, Suspense } from "react";
import styles from "./album.module.css";
import Link from "next/link";
import { Photo, Tag, fetchPhotos, uploadPhoto, fetchAlbums, deletePhoto, verifyLogin, reorderPhotos, fetchTags } from "@/lib/api";
import { resizeImageFile } from "@/lib/imageUtils";
import { useSearchParams } from "next/navigation";
import PhotoLightbox from "./PhotoLightbox";

function AlbumContent() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  
  const [albumName, setAlbumName] = useState("相簿");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [uploadProgress, setUploadProgress] = useState<{current: number, total: number, fileName: string} | null>(null);

  // 篩選與排序 State
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState<number | "all">("all");
  const [sortBy, setSortBy] = useState<"custom" | "upload_date" | "taken_date">("custom");
  
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
    
    const tags = await fetchTags();
    setAvailableTags(tags);
    
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

  // 計算經過篩選與排序的照片
  const displayPhotos = photos.filter(photo => {
    // 關鍵字篩選
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchTitle = photo.title.toLowerCase().includes(q);
      const matchDesc = photo.description?.toLowerCase().includes(q);
      if (!matchTitle && !matchDesc) return false;
    }
    // 標籤篩選
    if (selectedTag !== "all") {
      if (!photo.tags || !photo.tags.find(t => t.id === selectedTag)) return false;
    }
    return true;
  }).sort((a, b) => {
    if (sortBy === "custom") return a.sort_order - b.sort_order;
    if (sortBy === "upload_date") return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    if (sortBy === "taken_date") {
      const getRealDate = (p: Photo) => p.taken_at ? new Date(p.taken_at).getTime() : new Date(p.created_at).getTime();
      return getRealDate(b) - getRealDate(a);
    }
    return 0;
  });

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!id) return;
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    let allSuccess = true;
    const total = files.length;

    for (let i = 0; i < total; i++) {
      const rawFile = files[i];
      setUploadProgress({ current: i + 1, total, fileName: rawFile.name });
      try {
        // 縮圖處理 (長邊不超過 2000px)
        const { file, exifData, takenAt } = await resizeImageFile(rawFile, 2000);
        const success = await uploadPhoto(id, file, exifData, takenAt || undefined);
        if (!success) {
          allSuccess = false;
        }
      } catch (err) {
        console.error(err);
        allSuccess = false;
      }
    }

    if (!allSuccess) {
      alert("部分或全部照片上傳失敗，請稍後再試。");
    }
    
    loadData(); // 重新整理照片
    setUploading(false);
    setUploadProgress(null);
    
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
        <div className={styles.controls}>
          <div className={styles.filters}>
            <input 
              type="text" 
              placeholder="搜尋說明或標題..." 
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className={styles.searchInput}
            />
            <select value={selectedTag} onChange={e => setSelectedTag(e.target.value === "all" ? "all" : Number(e.target.value))} className={styles.select}>
              <option value="all">所有標籤</option>
              {availableTags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <select value={sortBy} onChange={e => setSortBy(e.target.value as any)} className={styles.select}>
              <option value="custom">自訂排序 (可拖曳)</option>
              <option value="upload_date">依上傳日期 (新到舊)</option>
              <option value="taken_date">依拍攝日期 (新到舊)</option>
            </select>
          </div>
          {isAdmin && (
            <div>
              <input 
                type="file" 
                ref={fileInputRef} 
                style={{ display: 'none' }} 
                accept="image/jpeg, image/png, image/webp, image/heic, image/heif"
                multiple
                onChange={handleFileChange}
              />
              <button 
                className={styles.uploadButton} 
                onClick={handleUploadClick}
                disabled={uploading}
              >
                {uploading ? (uploadProgress ? `上傳中... (${uploadProgress.current}/${uploadProgress.total})` : "上傳中...") : "上傳照片"}
              </button>
            </div>
          )}
        </div>
      </div>
      
      {uploadProgress && (
        <div className={styles.progressContainer}>
          <div className={styles.progressBar}>
            <div 
              className={styles.progressFill} 
              style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }}
            />
          </div>
          <p className={styles.progressText}>正在處理: {uploadProgress.fileName} ({uploadProgress.current} / {uploadProgress.total})</p>
        </div>
      )}

      {loading ? (
        <div className={styles.loading}>載入照片中...</div>
      ) : (
        <div className={styles.photoGrid}>
          {displayPhotos.map((photo, index) => (
            <div 
              key={photo.id} 
              className={`${styles.photoCard} ${draggingIndex === index ? styles.dragging : ""} ${longPressIndex === index ? styles.readyToDrag : ""}`}
              draggable={isAdmin && longPressIndex === index && sortBy === "custom"}
              onPointerDown={() => sortBy === "custom" && handlePointerDown(index)}
              onPointerUp={handlePointerUpOrLeave}
              onPointerLeave={handlePointerUpOrLeave}
              onClick={(e) => {
                if (longPressIndex !== null || draggingIndex !== null) {
                  e.preventDefault();
                  return;
                }
                setSelectedPhoto(photo);
              }}
              onDragStart={() => isAdmin && sortBy === "custom" && handleDragStart(index)}
              onDragEnter={() => isAdmin && sortBy === "custom" && handleDragEnter(index)}
              onDragEnd={isAdmin && sortBy === "custom" ? handleDragEnd : undefined}
              onDragOver={(e) => isAdmin && sortBy === "custom" && e.preventDefault()}
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
                <p className={styles.photoDate}>{photo.taken_at ? new Date(photo.taken_at).toLocaleDateString() : new Date(photo.created_at).toLocaleDateString()}</p>
                {photo.tags && photo.tags.length > 0 && (
                   <div className={styles.cardTags}>
                     {photo.tags.slice(0,3).map(t => <span key={t.id} className={styles.cardTag}>{t.name}</span>)}
                     {photo.tags.length > 3 && <span className={styles.cardTag}>+{photo.tags.length - 3}</span>}
                   </div>
                )}
              </div>
            </div>
          ))}
          {displayPhotos.length === 0 && (
            <div className={styles.emptyState}>
              <p>找不到符合條件的照片，或是相簿空空如也！</p>
            </div>
          )}
        </div>
      )}

      {/* Lightbox / 大圖檢視 */}
      {selectedPhoto && (
        <PhotoLightbox 
          photo={photos.find(p => p.id === selectedPhoto.id) || selectedPhoto} 
          isAdmin={isAdmin} 
          availableTags={availableTags}
          onClose={() => setSelectedPhoto(null)} 
          onUpdate={loadData}
        />
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
