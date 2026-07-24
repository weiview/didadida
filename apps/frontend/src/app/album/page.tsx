"use client";

import { useEffect, useState, useRef, Suspense, useMemo } from "react";
import styles from "./album.module.css";
import pageStyles from "../page.module.css";
import Link from "next/link";
import { Photo, Tag, fetchPhotos, uploadPhoto, fetchAlbums, deletePhoto, verifyLogin, reorderPhotos, fetchTags, updateAlbum, Album, createGooglePickerSession, fetchGooglePickerPhotos, syncGooglePhoto, resolveGooglePhotoConflict } from "@/lib/api";
import SlideConfirmModal from "@/components/SlideConfirmModal";
import GoogleSyncConflictModal from "@/components/GoogleSyncConflictModal";
import AssignPlaceModal from "@/components/AssignPlaceModal";
import { resizeImageFile } from "@/lib/imageUtils";
import { useSearchParams } from "next/navigation";
import PhotoLightbox from "./PhotoLightbox";
import CustomSelect from "@/components/CustomSelect";
import FilterBottomSheet from "@/components/FilterBottomSheet";

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
  const [visibleCount, setVisibleCount] = useState<number>(24);
  const [uploadProgress, setUploadProgress] = useState<{current: number, total: number, fileName: string} | null>(null);
  const [hasGoogleToken, setHasGoogleToken] = useState(false);

  // 批次刪除 State
  const [selectedPhotos, setSelectedPhotos] = useState<number[]>([]);
  const [showAssignPlace, setShowAssignPlace] = useState(false);
  // Shift 連選的錨點（顯示順序上的 index）
  const lastSelectedIndexRef = useRef<number | null>(null);
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
  const [selectedTags, setSelectedTags] = useState<number[]>([]);
  const [sortBy, setSortBy] = useState<"custom" | "upload_date" | "taken_date">("custom");
  const [isMobileFilterOpen, setIsMobileFilterOpen] = useState(false);
  const [isTagModalOpen, setIsTagModalOpen] = useState(false);

  // 手機版捏合縮放 (Pinch Zoom) 網格欄數控制 (預設 0 代表自動，1~5 欄可縮放)
  const [gridColumns, setGridColumns] = useState<number>(0);
  const touchStartDistRef = useRef<number | null>(null);
  const initialColumnsRef = useRef<number>(0);

  // 時間軸滾動條 State
  const [currentTimelineDate, setCurrentTimelineDate] = useState<string>("");
  const [isScrolling, setIsScrolling] = useState<boolean>(false);
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const photoCardRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Drag and drop state
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [longPressIndex, setLongPressIndex] = useState<number | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // 雙指 Pinch 手勢即時連續縮放照片網格大小 (手機觸控)
  useEffect(() => {
    const getDistance = (touches: TouchList) => {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.hypot(dx, dy);
    };

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        touchStartDistRef.current = getDistance(e.touches);
        // 開始時記錄目前畫面的基準欄數（手機預設 2 欄，平板/電腦預設 4 欄）
        const defaultCols = window.innerWidth <= 768 ? 2 : 4;
        initialColumnsRef.current = gridColumns > 0 ? gridColumns : defaultCols;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        if (e.cancelable) e.preventDefault();
      }

      if (e.touches.length === 2 && touchStartDistRef.current && touchStartDistRef.current > 0) {
        const currentDist = getDistance(e.touches);
        const ratio = currentDist / touchStartDistRef.current;
        const startCols = initialColumnsRef.current;
        let deltaCols = 0;
        
        // 調降靈敏度：使用平緩穩定的 0.22 比例步階（手指移動約 22% 距離切換 1 欄）
        if (ratio < 1) {
          // 兩指靠近（內縮）：欄數漸進增加 (圖片變小，顯示更多張)
          deltaCols = Math.floor((1 - ratio) / 0.22);
        } else {
          // 兩指遠離（拉開）：欄數漸進減少 (圖片變大，放大顯示)
          deltaCols = -Math.floor((ratio - 1) / 0.22);
        }

        const calculatedCols = Math.min(6, Math.max(1, startCols + deltaCols));
        setGridColumns(calculatedCols);
      }
    };

    const handleTouchEnd = () => {
      touchStartDistRef.current = null;
    };

    document.addEventListener("touchstart", handleTouchStart, { passive: false });
    document.addEventListener("touchmove", handleTouchMove, { passive: false });
    document.addEventListener("touchend", handleTouchEnd, { passive: true });

    return () => {
      document.removeEventListener("touchstart", handleTouchStart);
      document.removeEventListener("touchmove", handleTouchMove);
      document.removeEventListener("touchend", handleTouchEnd);
    };
  }, [gridColumns]);

  const [currentCoverPhotoUrl, setCurrentCoverPhotoUrl] = useState<string | null>(null);

  const loadData = async () => {
    if (!id) return;
    setLoading(true);
    
    const [allAlbums, photoData, tags] = await Promise.all([
      fetchAlbums(),
      fetchPhotos(id),
      fetchTags()
    ]);
    
    const current = allAlbums.find(a => String(a.id) === id);
    if (current) {
      setAlbumName(current.name);
      setCurrentCoverPhotoUrl(current.cover_photo_url || null);
    }
    
    setPhotos(photoData || []);
    setAvailableTags(tags);
    
    setLoading(false);
  };

  useEffect(() => {
    if (id) {
      loadData();
    }
    
    // Check auth optimistically
    if (typeof window !== "undefined") {
      const pwd = localStorage.getItem("admin_password");
      if (pwd) {
        setIsAdmin(true); // Optimistic UI
        verifyLogin(pwd).then(valid => {
          setIsAdmin(valid.success);
          if (!valid.success) localStorage.removeItem("admin_password");
        });
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
  }, [id, searchParams]);

  // 計算經過篩選與排序的照片
  const displayPhotos = useMemo(() => {
    return photos.filter(photo => {
      // 關鍵字篩選 (搜尋照片 Story/描述 或 標題)
      if (searchQuery) {
        const q = searchQuery.toLowerCase().trim();
        const matchTitle = photo.title?.toLowerCase().includes(q);
        const matchDesc = photo.description?.toLowerCase().includes(q);
        if (!matchTitle && !matchDesc) return false;
      }
      // 多選標籤篩選 (需包含選取的任一標籤)
      if (selectedTags.length > 0) {
        if (!photo.tags || !photo.tags.some(t => selectedTags.includes(t.id))) return false;
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
  }, [photos, searchQuery, selectedTags, sortBy]);

  // 整理時間軸標籤列表 (依年月或年份分類)
  const timelineGroup = useMemo(() => {
    if (displayPhotos.length === 0) return [];
    const groups: { label: string; index: number }[] = [];
    let lastLabel = "";

    displayPhotos.forEach((photo, index) => {
      const dateStr = photo.taken_at || photo.created_at;
      if (!dateStr) return;
      const dateObj = new Date(dateStr);
      if (isNaN(dateObj.getTime())) return;
      const label = `${dateObj.getFullYear()}/${String(dateObj.getMonth() + 1).padStart(2, '0')}`;
      if (label !== lastLabel) {
        lastLabel = label;
        groups.push({ label, index });
      }
    });

    return groups;
  }, [displayPhotos]);

  // 監聽頁面滾動以動態計算目前畫面上可見照片的時間範圍
  useEffect(() => {
    const handleScroll = () => {
      setIsScrolling(true);
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = setTimeout(() => {
        setIsScrolling(false);
      }, 1200);

      // 收集目前在視窗範圍內 (Viewport) 的所有照片時間
      const visibleDates: Date[] = [];
      const windowHeight = window.innerHeight;

      for (let i = 0; i < displayPhotos.length; i++) {
        const el = photoCardRefs.current.get(i);
        if (el) {
          const rect = el.getBoundingClientRect();
          // 卡片只要出現在螢幕視野內
          if (rect.bottom >= 0 && rect.top <= windowHeight) {
            const dateStr = displayPhotos[i].taken_at || displayPhotos[i].created_at;
            if (dateStr) {
              const d = new Date(dateStr);
              if (!isNaN(d.getTime())) visibleDates.push(d);
            }
          }
        }
      }

      if (visibleDates.length > 0) {
        visibleDates.sort((a, b) => a.getTime() - b.getTime());
        const startDate = visibleDates[0];
        const endDate = visibleDates[visibleDates.length - 1];

        const startStr = `${startDate.getFullYear()}年${startDate.getMonth() + 1}月`;
        const endStr = `${endDate.getFullYear()}年${endDate.getMonth() + 1}月`;

        if (startStr === endStr) {
          setCurrentTimelineDate(startStr);
        } else {
          setCurrentTimelineDate(`${startStr} ~ ${endStr}`);
        }
      }

      // 無限滾動：當滾動距離頁面底部小於 1000px 時自動載入更多
      const scrollHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      const scrollTop = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop;
      const clientHeight = window.innerHeight;

      if (scrollHeight - scrollTop - clientHeight < 1000) {
        setVisibleCount((prev) => {
          if (prev < displayPhotos.length) {
            return prev + 24;
          }
          return prev;
        });
      }
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("touchmove", handleScroll, { passive: true });
    window.addEventListener("resize", handleScroll, { passive: true });

    // 初次載入與照片資料更新時，主動多檢查幾次
    handleScroll();
    const timer = setTimeout(handleScroll, 500);

    return () => {
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("touchmove", handleScroll);
      window.removeEventListener("resize", handleScroll);
      clearTimeout(timer);
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    };
  }, [displayPhotos]);

  const handleScrollToTimelineIndex = (photoIdx: number) => {
    // 若目標超過目前載入量，自動提升可見張數
    if (photoIdx >= visibleCount) {
      setVisibleCount(photoIdx + 24);
    }
    setTimeout(() => {
      const el = photoCardRefs.current.get(photoIdx);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 50);
  };

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

  const handleGoogleSync = async (initialSession: any, popup: Window | null) => {
    try {
      if (!hasGoogleToken) {
        const loginUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787/api';
        window.location.href = `${loginUrl}/auth/google/login?state=${id}`;
        return;
      }

      // 立刻將 UI 設為載入鎖定狀態，避免異步建立 Session 期間 UI 切回
      setSyncingGoogle(true);
      setSyncProgress(null);

      // 每次匯入都必須建立新的 Google Picker Session (舊 Session 無法重複選照片)
      const session = await createGooglePickerSession();

      if (!session || (session as any).error || !session.pickerUri) {
        alert("無法建立 Google Picker (可能登入已過期)，請重新連結 Google 相簿。");
        setHasGoogleToken(false);
        setSyncingGoogle(false);
        popup?.close();
        return;
      }

      // 非同步取得連結後，直接將 popup 的網址更換為支援自動關閉的 pickerUri
      if (popup) {
        popup.location.href = session.pickerUri + "/autoclose";
      }

      const startTime = Date.now();
      let photosProcessingStarted = false;

      const pollTimer = setInterval(async () => {
        if (photosProcessingStarted) {
          return;
        }

        // 如果超過 10 分鐘，自動中斷
        if (Date.now() - startTime > 10 * 60 * 1000) {
          clearInterval(pollTimer);
          setSyncingGoogle(false);
          alert("同步逾時，已自動取消。");
          return;
        }

        const res = await fetchGooglePickerPhotos(session!.id!);
        if (res.ready) {
          console.log("[Google Picker Polling] ready is true, res:", res);
        }
        if (res.ready && res.mediaItems) {
          clearInterval(pollTimer);
          photosProcessingStarted = true;
          setSyncingGoogle(true);

          try {
            if (popup && !popup.closed) {
              popup.close();
            }
          } catch(e) {}
          
          if (res.mediaItems.length === 0) {
            console.log("[Google Picker Polling] mediaItems is empty array");
            setSyncingGoogle(false);
            return;
          }

          setSyncProgress({ current: 0, total: res.mediaItems.length });
          let successCount = 0;

          for (let i = 0; i < res.mediaItems.length; i++) {
            const item = res.mediaItems[i];
            console.log(`[Google Picker Item ${i}]`, item);
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

  // Shift 連選：點第一張，再按住 Shift 點最後一張，中間整段一起選起來。
  // 注意這是「顯示順序」上的連續區間，不一定等於拍攝時間上的連續 ——
  // 指定地點時 AssignPlaceModal 會把推導出的時間範圍攤開來讓使用者確認。
  const handlePhotoSelectClick = (index: number, photoId: number, shiftKey: boolean) => {
    if (shiftKey && lastSelectedIndexRef.current !== null) {
      const start = Math.min(lastSelectedIndexRef.current, index);
      const end = Math.max(lastSelectedIndexRef.current, index);
      const rangeIds = displayPhotos.slice(start, end + 1).map((p: any) => p.id);
      setSelectedPhotos(prev => Array.from(new Set([...prev, ...rangeIds])));
    } else {
      setSelectedPhotos(prev =>
        prev.includes(photoId) ? prev.filter(id => id !== photoId) : [...prev, photoId]
      );
    }
    lastSelectedIndexRef.current = index;
  };

  const handleBatchDeletePhotos = async () => {
    const idsToDelete = [...selectedPhotos];

    // 1. 立即關閉確認視窗並結束編輯模式 (不阻塞使用者畫面)
    setShowDeleteConfirm(false);
    setSelectedPhotos([]);
    setIsEditingPhotos(false);

    // 2. 樂觀更新 (Optimistic UI): 立即從畫面上的 photos 列表中移除已刪除的照片
    setPhotos(prevPhotos => prevPhotos.filter(photo => !idsToDelete.includes(photo.id)));

    // 3. 在背景中默默執行刪除 API
    (async () => {
      let failCount = 0;
      for (const photoId of idsToDelete) {
        const success = await deletePhoto(photoId);
        if (!success) failCount++;
      }
      // 如果極少數情況背景刪除失敗，默默補補同步最新數據
      if (failCount > 0) {
        loadData();
      }
    })();
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

  const [isEditingName, setIsEditingName] = useState(false);
  const [editingNameInput, setEditingNameInput] = useState("");

  const handleSaveAlbumName = async () => {
    if (!editingNameInput.trim() || !id) return;
    const newName = editingNameInput.trim();
    setAlbumName(newName);
    setIsEditingName(false);
    await updateAlbum(Number(id), { name: newName });
  };

  return (
    <div className={styles.container}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '15px', marginBottom: '20px' }}>
        <Link href="/" className={styles.backButton} style={{ marginBottom: 0 }}>
          ← 返回相簿列表
        </Link>
      </div>

      <div className={styles.header}>
        <div>
          {isEditingName ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
              <input
                type="text"
                value={editingNameInput}
                onChange={e => setEditingNameInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSaveAlbumName(); if (e.key === 'Escape') setIsEditingName(false); }}
                autoFocus
                style={{
                  fontSize: '1.6rem',
                  fontWeight: '600',
                  padding: '4px 10px',
                  borderRadius: '8px',
                  border: '1px solid var(--accent-color, #d1bfae)',
                  background: 'var(--card-bg, #fff)',
                  color: 'var(--text-color, #333)',
                  outline: 'none'
                }}
              />
              <button
                onClick={handleSaveAlbumName}
                style={{
                  background: 'var(--accent-color, #d1bfae)',
                  color: '#fff',
                  border: 'none',
                  padding: '6px 14px',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontSize: '0.9rem',
                  fontWeight: '500'
                }}
              >
                儲存
              </button>
              <button
                onClick={() => setIsEditingName(false)}
                style={{
                  background: 'transparent',
                  color: '#888',
                  border: '1px solid #ccc',
                  padding: '6px 12px',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontSize: '0.9rem'
                }}
              >
                取消
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <h1 className={styles.title} style={{ marginBottom: 0 }}>{albumName}</h1>
              {isAdmin && (
                <button
                  onClick={() => {
                    setEditingNameInput(albumName);
                    setIsEditingName(true);
                  }}
                  title="重新命名相簿"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#888',
                    cursor: 'pointer',
                    padding: '4px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    transition: 'color 0.2s ease'
                  }}
                  onMouseOver={e => e.currentTarget.style.color = 'var(--accent-color, #d1bfae)'}
                  onMouseOut={e => e.currentTarget.style.color = '#888'}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                  </svg>
                </button>
              )}
            </div>
          )}
          <p className={styles.meta} style={{ marginTop: '4px' }}>共 {photos.length} 張照片</p>
        </div>
        <div className={styles.controls}>
          <div className={styles.filters}>
            <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
              <input 
                type="text" 
                placeholder="搜尋照片 Story..." 
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className={styles.searchInput}
                style={{ paddingRight: searchQuery ? '32px' : '15px' }}
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  style={{
                    position: 'absolute',
                    right: '10px',
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-light, #888)',
                    fontSize: '1.1rem',
                    cursor: 'pointer',
                    padding: 0,
                    lineHeight: 1
                  }}
                  title="清除搜尋"
                >
                  ×
                </button>
              )}
            </div>
            <div className={pageStyles.desktopOnly}>
              <CustomSelect
                isMulti={true}
                value={selectedTags}
                onChange={(val) => setSelectedTags(val as number[])}
                options={availableTags.map(t => ({ value: t.id, label: t.name }))}
              />

              <CustomSelect
                value={sortBy}
                onChange={(val) => setSortBy(val as any)}
                options={[
                  { value: "custom", label: "自訂排序 (可拖曳)" },
                  { value: "upload_date", label: "依上傳日期 (新到舊)" },
                  { value: "taken_date", label: "依拍攝日期 (新到舊)" }
                ]}
              />

              <CustomSelect
                value={gridColumns || 0}
                onChange={(val) => setGridColumns(Number(val))}
                options={[
                  { value: 0, label: "縮圖版面: 自動" },
                  { value: 1, label: "縮圖版面: 1 欄 (大圖)" },
                  { value: 2, label: "縮圖版面: 2 欄 (雙排)" },
                  { value: 3, label: "縮圖版面: 3 欄 (精緻)" },
                  { value: 4, label: "縮圖版面: 4 欄 (多張)" },
                  { value: 5, label: "縮圖版面: 5 欄 (密集)" }
                ]}
              />
            </div>

            {/* 手機版滑出式篩選與排序觸控按鈕 */}
            <button
              type="button"
              className={pageStyles.mobileFilterBtn}
              onClick={() => setIsMobileFilterOpen(true)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
              </svg>
              篩選與排序
              {(selectedTags.length > 0 || sortBy !== "custom" || gridColumns !== 0) && (
                <span style={{
                  background: 'var(--accent-color, #d1bfae)',
                  color: '#fff',
                  borderRadius: '50%',
                  width: '8px',
                  height: '8px',
                  display: 'inline-block'
                }} />
              )}
            </button>
          </div>

          <FilterBottomSheet
            isOpen={isMobileFilterOpen}
            onClose={() => setIsMobileFilterOpen(false)}
            activeFilterCount={selectedTags.length + (sortBy !== "custom" ? 1 : 0) + (gridColumns !== 0 ? 1 : 0)}
            onReset={() => {
              setSelectedTags([]);
              setSortBy("custom");
              setGridColumns(0);
            }}
          >
            <div style={{ width: '100%', textAlign: 'center' }}>
              <label style={{ display: 'block', fontSize: '0.88rem', fontWeight: 600, color: 'var(--text-color)', marginBottom: '8px' }}>
                標籤篩選
              </label>
              <button
                type="button"
                onClick={() => setIsTagModalOpen(true)}
                style={{
                  width: '100%',
                  maxWidth: '280px',
                  padding: '10px 16px',
                  borderRadius: '12px',
                  border: '1px solid var(--border-color, rgba(0,0,0,0.1))',
                  background: 'var(--card-bg, rgba(255,255,255,0.9))',
                  color: 'var(--text-color, #333)',
                  fontSize: '0.9rem',
                  fontWeight: '500',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  cursor: 'pointer',
                  boxShadow: '0 2px 6px rgba(0,0,0,0.03)'
                }}
              >
                <span>
                  🏷️ {selectedTags.length === 0 ? '所有標籤' : selectedTags.length === availableTags.length ? '全選標籤 (所有)' : `已選取 ${selectedTags.length} 個標籤`}
                </span>
                <span style={{ fontSize: '0.8rem', color: '#888' }}>選擇 ❯</span>
              </button>
            </div>

            <div style={{ width: '100%', textAlign: 'center' }}>
              <label style={{ display: 'block', fontSize: '0.88rem', fontWeight: 600, color: 'var(--text-color)', marginBottom: '10px' }}>
                排序方式
              </label>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
                {[
                  { value: "custom", label: "自訂排序" },
                  { value: "upload_date", label: "依上傳日期 (新到舊)" },
                  { value: "taken_date", label: "依拍攝日期 (新到舊)" }
                ].map(opt => {
                  const isSelected = sortBy === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setSortBy(opt.value as any)}
                      style={{
                        padding: '8px 14px',
                        borderRadius: '20px',
                        border: isSelected ? '1px solid var(--accent-color, #d1bfae)' : '1px solid rgba(0,0,0,0.1)',
                        background: isSelected ? 'rgba(209, 191, 174, 0.25)' : 'rgba(0,0,0,0.03)',
                        color: isSelected ? 'var(--text-color, #111)' : 'var(--text-color, #555)',
                        fontSize: '0.88rem',
                        fontWeight: isSelected ? '600' : '400',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease'
                      }}
                    >
                      {isSelected ? `✓ ${opt.label}` : opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ width: '100%', textAlign: 'center' }}>
              <label style={{ display: 'block', fontSize: '0.88rem', fontWeight: 600, color: 'var(--text-color)', marginBottom: '10px' }}>
                縮圖版面欄數
              </label>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
                {[
                  { value: 0, label: "自動" },
                  { value: 1, label: "1 欄 (大圖)" },
                  { value: 2, label: "2 欄 (雙排)" },
                  { value: 3, label: "3 欄 (精緻)" },
                  { value: 4, label: "4 欄 (多張)" },
                  { value: 5, label: "5 欄 (密集)" }
                ].map(opt => {
                  const isSelected = (gridColumns || 0) === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setGridColumns(opt.value)}
                      style={{
                        padding: '8px 12px',
                        borderRadius: '20px',
                        border: isSelected ? '1px solid var(--accent-color, #d1bfae)' : '1px solid rgba(0,0,0,0.1)',
                        background: isSelected ? 'rgba(209, 191, 174, 0.25)' : 'rgba(0,0,0,0.03)',
                        color: isSelected ? 'var(--text-color, #111)' : 'var(--text-color, #555)',
                        fontSize: '0.85rem',
                        fontWeight: isSelected ? '600' : '400',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease'
                      }}
                    >
                      {isSelected ? `✓ ${opt.label}` : opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </FilterBottomSheet>

          {/* 標籤專屬彈出選擇 List 畫面 */}
          <FilterBottomSheet
            isOpen={isTagModalOpen}
            onClose={() => setIsTagModalOpen(false)}
            activeFilterCount={selectedTags.length}
            onReset={() => setSelectedTags([])}
            title="🏷️ 選擇標籤"
          >
            <div style={{ width: '100%', textAlign: 'center' }}>
              {/* 全選 快捷捷徑 */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 4px 10px 4px', marginBottom: '8px' }}>
                <button
                  type="button"
                  onClick={() => {
                    if (selectedTags.length === availableTags.length) setSelectedTags([]);
                    else setSelectedTags(availableTags.map(t => t.id));
                  }}
                  style={{ background: 'none', border: 'none', color: 'var(--accent-color, #d1bfae)', fontWeight: 600, fontSize: '0.88rem', cursor: 'pointer' }}
                >
                  {selectedTags.length === availableTags.length ? '取消全選' : '全選所有標籤'}
                </button>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'center', padding: '6px 4px 20px 4px' }}>
                {availableTags.length === 0 ? (
                  <div style={{ padding: '20px', color: '#888', fontSize: '0.9rem' }}>本相簿尚無相片標籤</div>
                ) : (
                  availableTags.map(t => {
                    const isSelected = selectedTags.includes(t.id);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => {
                          if (isSelected) setSelectedTags(selectedTags.filter(id => id !== t.id));
                          else setSelectedTags([...selectedTags, t.id]);
                        }}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '10px 18px',
                          borderRadius: '24px',
                          border: isSelected ? '1.5px solid var(--accent-color, #d1bfae)' : '1px solid rgba(0,0,0,0.1)',
                          background: isSelected ? 'rgba(209, 191, 174, 0.25)' : 'rgba(0,0,0,0.03)',
                          color: isSelected ? 'var(--text-color, #111)' : 'var(--text-color, #555)',
                          fontSize: '0.92rem',
                          fontWeight: isSelected ? '600' : '400',
                          cursor: 'pointer',
                          transition: 'all 0.15s ease',
                          boxShadow: isSelected ? '0 2px 8px rgba(209, 191, 174, 0.3)' : 'none'
                        }}
                      >
                        <span>{t.name}</span>
                        {isSelected && <span style={{ color: 'var(--accent-color, #d1bfae)', fontWeight: 'bold' }}>✓</span>}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </FilterBottomSheet>
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
        <div 
          className={styles.photoGrid}
          style={gridColumns > 0 ? { gridTemplateColumns: `repeat(${gridColumns}, 1fr)` } : undefined}
        >
          {displayPhotos.slice(0, visibleCount).map((photo, index) => (
            <div 
              key={photo.id} 
              ref={(el) => {
                if (el) photoCardRefs.current.set(index, el);
                else photoCardRefs.current.delete(index);
              }}
              className={`${styles.photoCard} ${draggingIndex === index ? styles.dragging : ""} ${longPressIndex === index ? styles.readyToDrag : ""}`}
              draggable={isAdmin && longPressIndex === index && sortBy === "custom"}
              onClick={async () => {
                if (longPressIndex !== null || draggingIndex !== null) return;
                if (isEditingPhotos) {
                  // 在編輯模式下，若點擊已是封面的照片則取消封面設定，否則設為新封面
                  const isCurrentCover = currentCoverPhotoUrl === photo.url;
                  const newCoverUrl = isCurrentCover ? null : photo.url;
                  setCurrentCoverPhotoUrl(newCoverUrl);
                  await updateAlbum(Number(id), { cover_photo_url: newCoverUrl || "" });
                  return;
                }
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
                <>
                  <input
                    type="checkbox"
                    checked={selectedPhotos.includes(photo.id)}
                    // 勾選狀態一律由 onClick 處理，才拿得到 shiftKey；
                    // onChange 保留空實作以避免 React 對受控 input 發出警告
                    onChange={() => {}}
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePhotoSelectClick(index, photo.id, e.shiftKey);
                    }}
                    style={{ position: 'absolute', top: '10px', left: '10px', width: '20px', height: '20px', zIndex: 10, cursor: 'pointer' }}
                  />
                  <div style={{
                    position: 'absolute', bottom: '10px', right: '10px', zIndex: 10,
                    background: currentCoverPhotoUrl === photo.url ? 'var(--accent-color)' : 'rgba(0, 0, 0, 0.55)',
                    color: '#fff', padding: '4px 10px',
                    borderRadius: '12px', fontSize: '0.75rem', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
                    border: currentCoverPhotoUrl === photo.url ? '1px solid var(--accent-color)' : '1px solid rgba(255, 255, 255, 0.25)',
                    pointerEvents: 'none', fontWeight: '500', transition: 'all 0.2s ease',
                    boxShadow: currentCoverPhotoUrl === photo.url ? '0 2px 8px rgba(0,0,0,0.3)' : 'none'
                  }}>
                    {currentCoverPhotoUrl === photo.url ? "★ 封面" : "設為封面"}
                  </div>
                </>
              )}
              <img 
                src={photo.thumb_url || photo.url} 
                alt={photo.title} 
                className={styles.photoImage} 
                loading="lazy" 
                decoding="async" 
              />
              {/* 當每排 3 欄 (含) 以上時，照片上隱藏文字與標籤資訊，只呈現純淨照片縮圖 */}
              {(gridColumns === 1 || gridColumns === 2) && (
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
              )}
            </div>
          ))}
          {displayPhotos.length === 0 && (
            <div className={styles.emptyState}>
              <p>找不到符合條件的照片，或是相簿空空如也！</p>
            </div>
          )}
        </div>
      )}

      {/* 右側懸浮照片時間軸滾動條 */}
      {timelineGroup.length > 0 && (
        <div className={`${styles.timelineTrack} ${isScrolling ? styles.timelineActive : ""}`}>
          {currentTimelineDate && (
            <div className={styles.timelineBubble}>
              {currentTimelineDate}
            </div>
          )}
          <div className={styles.timelineMarks}>
            {timelineGroup.map((item) => (
              <div 
                key={item.label} 
                className={styles.timelineNode}
                onClick={() => handleScrollToTimelineIndex(item.index)}
                title={`前往 ${item.label}`}
              >
                <span className={styles.timelineNodeDot} />
                <span className={styles.timelineNodeText}>{item.label}</span>
              </div>
            ))}
          </div>
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
            className={pageStyles.actionButton}
            onClick={() => setShowAssignPlace(true)}
            disabled={selectedPhotos.length === 0}
            style={{ opacity: selectedPhotos.length === 0 ? 0.5 : 1 }}
          >
            📍 指定地點
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

      <AssignPlaceModal
        isOpen={showAssignPlace}
        photoIds={selectedPhotos}
        albumId={id ? Number(id) : undefined}
        onClose={() => setShowAssignPlace(false)}
        onDone={({ updated, skippedExif }) => {
          setSelectedPhotos([]);
          lastSelectedIndexRef.current = null;
          loadData();
          const skipped = skippedExif > 0 ? `，${skippedExif} 張已有 GPS 未覆蓋` : '';
          alert(`已為 ${updated} 張照片指定地點${skipped}`);
        }}
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
