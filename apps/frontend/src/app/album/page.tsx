"use client";

import { useEffect, useState, useRef, Suspense } from "react";
import styles from "./album.module.css";
import pageStyles from "../page.module.css";
import Link from "next/link";
import { Photo, Tag, fetchPhotos, uploadPhoto, fetchAlbums, deletePhoto, verifyLogin, reorderPhotos, fetchTags, updateAlbum, Album, createGooglePickerSession, fetchGooglePickerPhotos, syncGooglePhoto, resolveGooglePhotoConflict } from "@/lib/api";
import SlideConfirmModal from "@/components/SlideConfirmModal";
import GoogleSyncConflictModal from "@/components/GoogleSyncConflictModal";
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
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState<number | null>(null);
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [uploadProgress, setUploadProgress] = useState<{current: number, total: number, fileName: string} | null>(null);
  const [hasGoogleToken, setHasGoogleToken] = useState(false);

  // 批次刪除 State
  const [selectedPhotos, setSelectedPhotos] = useState<number[]>([]);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  const [isEditingPhotos, setIsEditingPhotos] = useState(false);
  const [showUploadMenu, setShowUploadMenu] = useState(false);
  const uploadMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (uploadMenuRef.current && !uploadMenuRef.current.contains(event.target as Node)) {
        setShowUploadMenu(false);
      }
    };
    if (showUploadMenu) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showUploadMenu]);

  // Google Sync State
  const [syncingGoogle, setSyncingGoogle] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{current: number, total: number} | null>(null);
  const [googleSession, setGoogleSession] = useState<any | null>(null);
  const [currentConflict, setCurrentConflict] = useState<{
    tempPhoto: any;
    existingPhotos: any[];
    resolveFn: (decision: string, replaceIds?: number[]) => void;
  } | null>(null);

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
        setIsAdmin(valid.success);
        if (!valid.success) localStorage.removeItem("admin_password");
      }
      
      const gToken = searchParams?.get("googleToken");
      if (gToken) {
        localStorage.setItem("google_access_token", gToken);
        // 清除網址上的 token
        window.history.replaceState({}, document.title, window.location.pathname + "?id=" + id);
        setHasGoogleToken(true);
      } else if (localStorage.getItem("google_access_token")) {
        setHasGoogleToken(true);
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

  const handleGoogleSync = async (session: any, popup: Window | null) => {
    try {
      if (!hasGoogleToken) {
        const loginUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787/api';
        window.location.href = `${loginUrl}/auth/google/login?state=${id}`;
        return;
      }
      
      let session = googleSession;
      if (!session) {
        session = await createGooglePickerSession();
      }
      
      if (!session || session.error || !session.pickerUri) {
        alert("無法建立 Google Picker (可能登入已過期)，請重新連結 Google 相簿。");
        setHasGoogleToken(false);
        setSyncingGoogle(false);
        popup?.close();
        return;
      }
      
      // 非同步取得連結後，透過 a 標籤導向已經開啟的視窗
      if (popup) {
        const a = document.createElement("a");
        a.href = session.pickerUri;
        a.target = "GooglePicker";
        a.click();
      }
      
      setSyncingGoogle(true);
      setSyncProgress(null);
      
      const startTime = Date.now();
      const pollTimer = setInterval(async () => {
        // 如果超過 10 分鐘，自動中斷 (避免 COOP 導致無法偵測視窗關閉)
        if (Date.now() - startTime > 10 * 60 * 1000) {
          clearInterval(pollTimer);
          setSyncingGoogle(false);
          alert("同步逾時，已自動取消。");
          return;
        }

        const res = await fetchGooglePickerPhotos(session!.id!);
        if (res.ready) {
          console.log("Picker ready! MediaItems:", res.mediaItems);
        }
        if (res.ready && res.mediaItems) {
          clearInterval(pollTimer);
          console.log("Attempting to close popup...", popup, popup?.closed);
          try {
            popup?.close();
            console.log("popup.close() executed. Is it closed?", popup?.closed);
            // 備用方案，萬一 popup 遺失
            const finalPopup = popup || window.open("", "GooglePicker");
            finalPopup?.close();
          } catch(e) {
            console.error("Error closing popup:", e);
          }
          
          if (res.mediaItems.length === 0) {
            setSyncingGoogle(false);
            return; // No photos selected
          }

          setSyncProgress({ current: 0, total: res.mediaItems.length });
          let successCount = 0;

          for (let i = 0; i < res.mediaItems.length; i++) {
            const item = res.mediaItems[i];
            setSyncProgress({ current: i + 1, total: res.mediaItems.length });
            
            const baseUrl = item.mediaFile?.baseUrl || item.baseUrl;
            const filename = item.mediaFile?.filename || item.filename || item.id + ".jpg";
            
            if (!baseUrl) {
              console.error("無法取得照片下載連結:", item);
              continue;
            }

            const result = await syncGooglePhoto(id as string, baseUrl, filename, item.mediaMetadata?.creationTime);
            
            if (result && result.conflict) {
              const decision = await new Promise<{action: string, replaceIds?: number[]}>((resolve) => {
                setCurrentConflict({
                  tempPhoto: result.tempPhoto,
                  existingPhotos: result.existingPhotos,
                  resolveFn: (action, replaceIds) => resolve({ action, replaceIds })
                });
              });
              
              setCurrentConflict(null);
              
              if (decision) {
                const resolved = await resolveGooglePhotoConflict(decision.action, result.existingPhotos, result.tempPhoto, decision.replaceIds);
                if (resolved) successCount++;
              }
            } else if (result) {
              successCount++;
            }
          }
          
          setSyncingGoogle(false);
          setSyncProgress(null);
          loadData();
        }
      }, 2000);
    } catch (err) {
      console.error(err);
      setSyncingGoogle(false);
    }
  };

  const handleBatchDeletePhotos = async () => {
    setIsBatchDeleting(true);
    let successCount = 0;
    for (const photoId of selectedPhotos) {
      const success = await deletePhoto(photoId);
      if (success) successCount++;
    }
    setIsBatchDeleting(false);
    setShowDeleteConfirm(false);
    setSelectedPhotos([]);
    setIsEditingPhotos(false);
    loadData();
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
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                className={`${styles.uploadButton} ${isEditingPhotos ? styles.primary : ''}`}
                onClick={() => {
                  if (isEditingPhotos) {
                    setIsEditingPhotos(false);
                    setSelectedPhotos([]);
                  } else {
                    setIsEditingPhotos(true);
                  }
                }}
              >
                {isEditingPhotos ? '完成' : '編輯'}
              </button>

              {!isEditingPhotos && (
                <div style={{ position: 'relative' }}>
                  <input 
                    type="file" 
                    ref={fileInputRef} 
                    style={{ display: 'none' }} 
                    accept="image/jpeg, image/png, image/webp, image/heic, image/heif"
                    multiple
                    onChange={handleFileChange}
                  />
                  
                  {syncingGoogle || uploading ? (
                    <button 
                      className={pageStyles.createButton || styles.uploadButton} 
                      disabled
                    >
                      {syncingGoogle 
                        ? (syncProgress ? `匯入中... (${syncProgress.current}/${syncProgress.total})` : "準備 Google 相簿...") 
                        : (uploadProgress ? `上傳中... (${uploadProgress.current}/${uploadProgress.total})` : "上傳中...")}
                    </button>
                  ) : (
                    <>
                        <button 
                          className={pageStyles.createButton || styles.uploadButton} 
                          onClick={() => setShowUploadMenu(!showUploadMenu)}
                        >
                          上傳照片
                        </button>

                      {showUploadMenu && (
                        <div 
                          ref={uploadMenuRef}
                          className={styles.dropdownMenu}
                          style={{
                            position: 'absolute',
                            top: 'calc(100% + 5px)',
                            right: 0,
                            background: 'var(--card-bg)',
                            border: '1px solid var(--border-color)',
                            borderRadius: '10px',
                            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                            backdropFilter: 'blur(10px)',
                            overflow: 'hidden',
                            display: 'flex',
                            flexDirection: 'column',
                            zIndex: 100,
                            minWidth: '180px'
                          }}>
                          <button 
                            style={{ padding: '12px 16px', border: 'none', background: 'transparent', color: 'var(--text-color)', cursor: 'pointer', textAlign: 'left', fontSize: '0.95rem', whiteSpace: 'nowrap' }}
                            onClick={() => { setShowUploadMenu(false); fileInputRef.current?.click(); }}
                            onMouseOver={(e) => e.currentTarget.style.background = 'var(--bg-color)'}
                            onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
                          >
                            選擇本地照片
                          </button>
                          <div style={{ height: '1px', background: 'var(--border-color)' }}></div>
                          <button 
                            style={{ 
                              padding: '12px 16px', border: 'none', background: 'transparent', 
                              color: 'var(--text-color)', cursor: 'pointer', 
                              textAlign: 'left', fontSize: '0.95rem', whiteSpace: 'nowrap' 
                            }}
                            onClick={() => { 
                              setShowUploadMenu(false); 
                              
                              let popup: Window | null = null;
                              if (hasGoogleToken) {
                                // 絕對同步開啟空視窗取得權限，突破任何阻擋器
                                popup = window.open("", "GooglePicker", "width=1000,height=800,menubar=no,toolbar=no,location=no,status=no");
                                if (popup) popup.document.write("<html><body style='font-family:sans-serif;text-align:center;margin-top:20%;'>載入 Google 相簿中...</body></html>");
                              }
                              handleGoogleSync(null, popup);
                            }}
                            onMouseOver={(e) => { e.currentTarget.style.background = 'var(--bg-color)'; }}
                            onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; }}
                          >
                            {!hasGoogleToken ? "連結 Google 相簿" : "從 Google 相簿匯入"}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
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
              onClick={() => {
                if (longPressIndex !== null || draggingIndex !== null) return;
                setSelectedPhotoIndex(index);
              }}
              onPointerDown={() => sortBy === "custom" && handlePointerDown(index)}
              onPointerUp={handlePointerUpOrLeave}
              onPointerLeave={handlePointerUpOrLeave}
              onDragStart={(e) => {
                if ((e.target as HTMLElement).tagName === 'INPUT') {
                  e.preventDefault();
                  return;
                }
                if (isAdmin && sortBy === "custom") handleDragStart(index);
              }}
              onDragEnter={() => isAdmin && sortBy === "custom" && handleDragEnter(index)}
              onDragEnd={isAdmin && sortBy === "custom" ? handleDragEnd : undefined}
              onDragOver={(e) => isAdmin && sortBy === "custom" && e.preventDefault()}
            >
              {isAdmin && isEditingPhotos && (
                <input 
                  type="checkbox"
                  checked={selectedPhotos.includes(photo.id)}
                  onChange={(e) => {
                    e.stopPropagation();
                    if (e.target.checked) setSelectedPhotos(prev => [...prev, photo.id]);
                    else setSelectedPhotos(prev => prev.filter(id => id !== photo.id));
                  }}
                  onClick={e => e.stopPropagation()}
                  style={{ position: 'absolute', top: '10px', left: '10px', width: '20px', height: '20px', zIndex: 10, cursor: 'pointer' }}
                />
              )}
              <img src={photo.url} alt={photo.title} className={styles.photoImage} />
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
      {selectedPhotoIndex !== null && (
        <PhotoLightbox 
          photo={displayPhotos[selectedPhotoIndex]}
          isAdmin={isAdmin} 
          availableTags={availableTags}
          onClose={() => setSelectedPhotoIndex(null)} 
          onUpdate={loadData}
          onPrev={() => {
            if (selectedPhotoIndex > 0) setSelectedPhotoIndex(selectedPhotoIndex - 1);
          }}
          onNext={() => {
            if (selectedPhotoIndex < displayPhotos.length - 1) setSelectedPhotoIndex(selectedPhotoIndex + 1);
          }}
          hasPrev={selectedPhotoIndex > 0}
          hasNext={selectedPhotoIndex < displayPhotos.length - 1}
        />
      )}

      {/* 底部動作列 (編輯模式) */}
      {isEditingPhotos && (
        <div className={pageStyles.actionBar}>
          <button
            className={pageStyles.actionButton}
            onClick={() => {
              if (selectedPhotos.length === displayPhotos.length) {
                setSelectedPhotos([]);
              } else {
                setSelectedPhotos(displayPhotos.map((p: any) => p.id));
              }
            }}
          >
            {selectedPhotos.length === displayPhotos.length ? '取消全選' : '全選'}
          </button>
          
          <button
            className={`${pageStyles.actionButton} ${selectedPhotos.length > 0 ? pageStyles.danger : ''}`}
            onClick={() => setShowDeleteConfirm(true)}
            disabled={selectedPhotos.length === 0 || isBatchDeleting}
            style={{ opacity: selectedPhotos.length === 0 ? 0.5 : 1 }}
          >
            {isBatchDeleting ? '刪除中...' : `刪除 ${selectedPhotos.length} 個項目`}
          </button>
        </div>
      )}

      {/* Slide Confirm Modal */}
      <SlideConfirmModal 
        isOpen={showDeleteConfirm}
        title="確認刪除"
        message={`確定要刪除選取的 ${selectedPhotos.length} 張照片嗎？此動作無法復原。`}
        onConfirm={handleBatchDeletePhotos}
        onCancel={() => setShowDeleteConfirm(false)}
      />

      <GoogleSyncConflictModal
        isOpen={!!currentConflict}
        tempPhoto={currentConflict?.tempPhoto}
        existingPhotos={currentConflict?.existingPhotos || []}
        onResolve={(decision, replaceIds) => {
          if (currentConflict?.resolveFn) {
            currentConflict.resolveFn(decision, replaceIds);
          }
        }}
      />
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
