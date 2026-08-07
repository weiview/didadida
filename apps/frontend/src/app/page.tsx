"use client";

import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import styles from "./page.module.css";
import albumStyles from "./album/album.module.css";
import Link from "next/link";
import { fetchAlbums, createAlbum, deleteAlbum, Album, reorderAlbums, searchPhotos, Photo, fetchTags, Tag, photoThumbSrc } from "@/lib/api";
import { useAdmin } from "@/lib/useAdmin";
import SlideConfirmModal from "@/components/SlideConfirmModal";
import PhotoLightbox from "./album/PhotoLightbox";
import CustomSelect from "@/components/CustomSelect";
import FilterBottomSheet from "@/components/FilterBottomSheet";
import FabMenu from "@/components/FabMenu";
import BottomActionBar from "@/components/BottomActionBar";

function AlbumCardComponent({ album, isAdmin, isEditing, draggingIndex, longPressIndex, sortBy, index, handlePointerDown, handlePointerUpOrLeave, handleDragStart, handleDragEnter, handleDragEnd, isSelected, onSelectToggle }: any) {
  const [hovered, setHovered] = useState(false);
  const [photoIndex, setPhotoIndex] = useState(0);
  const previews: string[] = album.preview_photos ?? [];

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (hovered && previews.length > 0) {
      interval = setInterval(() => {
        setPhotoIndex(prev => (prev + 1) % previews.length);
      }, 4000);
    } else {
      setPhotoIndex(0);
    }
    return () => clearInterval(interval);
  }, [hovered, previews.length]);

  /*
   * 輪播圖是「用到才掛上 DOM」的。
   *
   * 以前是把每一張預覽圖都渲染成 <div style={{backgroundImage, opacity: 0}}>，
   * 靠 opacity 藏起來。但瀏覽器只有 display: none 才會延後抓圖，opacity: 0 一律
   * 照抓，而且 loading="lazy" 對 CSS 背景圖完全無效 —— 結果是進首頁不 hover
   * 也會下載「相簿數 × 預覽張數」張縮圖，每一張都是一次 Workers 請求。
   *
   * 掛到「下一張」而不是只掛現在這張：下一張得先以 opacity 0 存在於 DOM 裡，
   * 交叉淡入才有起始畫格，否則會變成硬切。mountedCount 只增不減，滑鼠移開再
   * 移回來不會把已經載好的圖從 DOM 拔掉又重掛。
   */
  const [mountedCount, setMountedCount] = useState(0);
  useEffect(() => {
    if (!hovered) return;
    setMountedCount((c) => Math.max(c, Math.min(previews.length, photoIndex + 2)));
  }, [hovered, photoIndex, previews.length]);

  const coverText = album.name;

  return (
    <div style={{ position: 'relative' }} className={styles.albumCardWrapper}>
      {isAdmin && isEditing && (
        <input
          type="checkbox"
          checked={isSelected}
          onChange={(e) => {
            e.stopPropagation();
            onSelectToggle(album.id, e.target.checked);
          }}
          onClick={e => e.stopPropagation()}
          style={{ position: 'absolute', top: '10px', right: '10px', width: '20px', height: '20px', zIndex: 10, cursor: 'pointer' }}
        />
      )}
      <Link 
        href={`/album?id=${album.id}`}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={`glass-panel ${styles.albumCard} ${draggingIndex === index ? styles.dragging : ""} ${longPressIndex === index ? styles.readyToDrag : ""}`}
        draggable={isAdmin && longPressIndex === index && sortBy === "custom"}
        onPointerDown={() => sortBy === "custom" && handlePointerDown(index)}
        onPointerUp={handlePointerUpOrLeave}
        onPointerLeave={handlePointerUpOrLeave}
        onClick={(e) => {
          if (longPressIndex !== null || draggingIndex !== null) {
            e.preventDefault();
          }
        }}
        onDragStart={() => isAdmin && sortBy === "custom" && handleDragStart(index)}
        onDragEnter={() => isAdmin && sortBy === "custom" && handleDragEnter(index)}
        onDragEnd={isAdmin && sortBy === "custom" ? handleDragEnd : undefined}
        onDragOver={(e) => isAdmin && sortBy === "custom" && e.preventDefault()}
      >
        <div className={styles.coverPlaceholder}>
          {/* Carousel images（只掛已經輪到的，見上面 mountedCount 的說明） */}
          {previews.slice(0, mountedCount).map((photoUrl: string, i: number) => (
            <div
              key={photoUrl}
              className={styles.coverImage}
              style={{
                backgroundImage: `url(${photoUrl})`,
                opacity: (hovered && photoIndex === i) ? 1 : 0
              }}
            />
          ))}
          {/* Static cover photo */}
          {album.cover_photo_url && (
            <div
              className={styles.coverImage}
              style={{
                backgroundImage: `url(${album.cover_photo_url})`,
                opacity: (hovered && previews.length > 0) ? 0 : 1
              }}
            />
          )}

          {/* Static cover text (if no cover photo is set) */}
          {!album.cover_photo_url && (
            <span style={{
              position: 'relative',
              zIndex: 2,
              opacity: (hovered && previews.length > 0) ? 0 : 1,
              transition: 'opacity 3s ease-in-out'
            }}>
              {coverText}
            </span>
          )}
        </div>
        <h2 className={styles.albumTitle}>{album.name}</h2>
        <p className={styles.albumMeta}>
          {new Date(album.created_at).toLocaleDateString()}
        </p>
      </Link>
    </div>
  );
}

export default function Home() {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);
  const { isAdmin, checking: isCheckingAuth, login } = useAdmin();

  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Batch delete state
  const [selectedAlbums, setSelectedAlbums] = useState<number[]>([]);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  const [isEditingAlbums, setIsEditingAlbums] = useState(false);

  // 篩選與排序 State
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<number[]>([]);
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [sortBy, setSortBy] = useState<"custom" | "upload_date">("custom");
  const [gridColumns, setGridColumns] = useState<number>(0); // 0 代表預設/自動 RWD
  const [isMobileFilterOpen, setIsMobileFilterOpen] = useState(false);
  const [isTagModalOpen, setIsTagModalOpen] = useState(false);

  // Pinch 手勢連續縮放觸控 Ref
  const touchStartDistRef = useRef<number | null>(null);
  const initialColumnsRef = useRef<number>(2);

  // Drag and drop state
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [longPressIndex, setLongPressIndex] = useState<number | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // 雙指 Pinch 手勢即時連續縮放相簿網格大小 (手機觸控)
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
        const defaultCols = window.innerWidth <= 768 ? 2 : 3;
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
        
        if (ratio < 1) {
          // 兩指靠近（內縮）：欄數增加 (相簿卡片變小)
          deltaCols = Math.floor((1 - ratio) / 0.22);
        } else {
          // 兩指遠離（拉開）：欄數減少 (相簿卡片變大)
          deltaCols = -Math.floor((ratio - 1) / 0.22);
        }

        const calculatedCols = Math.min(5, Math.max(1, startCols + deltaCols));
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

  // 照片全站搜尋與大圖檢視 State
  const [displayPhotos, setDisplayPhotos] = useState<Photo[]>([]);
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState<number | null>(null);

  // 時間軸滾動條 State
  const [currentTimelineDate, setCurrentTimelineDate] = useState<string>("");
  const [isScrolling, setIsScrolling] = useState<boolean>(false);
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const photoCardRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  /*
   * 篩選與分頁全部改由後端負責。
   *
   * 以前是進站就把全站每一張照片抓回來，再用 includes() 在瀏覽器裡過濾。沒打
   * 關鍵字時那份資料根本沒被用到，卻每次都讓後端掃過整張 Photo 表 —— 照片一多，
   * D1 的每日讀取列數會比任何其他額度更早見底。
   *
   * 相簿也一樣改成一頁一頁要。既然手上永遠只有一部分，篩選和排序就不能再留在
   * 前端做：那只會把「已經載到的那幾本」排好，還沒載的仍然是錯的。
   */
  const ALBUM_PAGE_SIZE = 20;
  const PHOTO_PAGE_SIZE = 60;
  const [hasMoreAlbums, setHasMoreAlbums] = useState(false);
  const [loadingMoreAlbums, setLoadingMoreAlbums] = useState(false);
  const isFiltering = searchQuery.trim() !== "" || selectedTags.length > 0;

  // 慢的查詢先送、快的後送時，晚回來的舊結果會蓋掉新的。只讓最後一次發出的查詢
  // 寫進 state。
  const querySeq = useRef(0);

  const runQuery = useCallback(async () => {
    const seq = ++querySeq.current;
    setLoading(true);
    const q = searchQuery.trim();
    const filtering = q !== "" || selectedTags.length > 0;

    const [albumPage, photoPage] = await Promise.all([
      fetchAlbums({ q, tagIds: selectedTags, limit: ALBUM_PAGE_SIZE, sort: sortBy }),
      // 沒有任何篩選條件時首頁只顯示相簿，照片區塊是空的 —— 這時候完全不必問後端
      filtering
        ? searchPhotos({ q, tagIds: selectedTags, limit: PHOTO_PAGE_SIZE })
        : Promise.resolve({ photos: [] as Photo[], hasMore: false }),
    ]);
    if (seq !== querySeq.current) return;

    setAlbums(albumPage.albums);
    setHasMoreAlbums(albumPage.hasMore);
    setDisplayPhotos(photoPage.photos);
    setLoading(false);
  }, [searchQuery, selectedTags, sortBy]);

  // 對外仍叫 loadData：新增／刪除／排序失敗之後要用它把畫面拉回真實狀態
  const loadData = runQuery;

  // 標籤清單幾乎不變，進站載一次就好，不必跟著每次打字重抓
  useEffect(() => {
    fetchTags().then((t) => setAvailableTags(t || []));
  }, []);

  // 打字時 debounce，不要每一個字都送一次查詢；改標籤或排序則立即生效
  useEffect(() => {
    const delay = searchQuery.trim() ? 250 : 0;
    const handle = setTimeout(() => { runQuery(); }, delay);
    return () => clearTimeout(handle);
  }, [runQuery, searchQuery]);

  /*
   * 相簿無限捲動。哨兵進入畫面就要下一頁。
   *
   * offset 用 albums.length 而不是頁碼：中途刪掉一本相簿時頁碼會算錯，
   * 直接用「目前已經有幾本」永遠對得上。
   */
  const albumSentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = albumSentinelRef.current;
    if (!node || !hasMoreAlbums || loading) return;

    const observer = new IntersectionObserver(async (entries) => {
      if (!entries[0].isIntersecting || loadingMoreAlbums) return;
      setLoadingMoreAlbums(true);
      const seq = querySeq.current;
      const page = await fetchAlbums({
        q: searchQuery.trim(), tagIds: selectedTags,
        offset: albums.length, limit: ALBUM_PAGE_SIZE, sort: sortBy,
      });
      // 等這一頁的期間使用者又改了搜尋條件的話，這批資料已經不屬於畫面上那個清單了
      if (seq !== querySeq.current) return;
      setAlbums((prev) => {
        // 兩次請求之間如果有相簿被新增，offset 會讓某幾本重複出現，用 id 去重
        const seen = new Set(prev.map((a) => a.id));
        return [...prev, ...page.albums.filter((a) => !seen.has(a.id))];
      });
      setHasMoreAlbums(page.hasMore);
      setLoadingMoreAlbums(false);
    }, { rootMargin: "400px" });

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMoreAlbums, loading, loadingMoreAlbums, albums.length, searchQuery, selectedTags, sortBy]);

  // 時間軸標籤點 (照片模式)
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

  // 監聽頁面滾動 (當處於照片搜尋檢視模式時)
  useEffect(() => {
    if (displayPhotos.length === 0) return;

    const handleScroll = () => {
      setIsScrolling(true);
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = setTimeout(() => {
        setIsScrolling(false);
      }, 1200);

      const visibleDates: Date[] = [];
      const windowHeight = window.innerHeight;

      for (let i = 0; i < displayPhotos.length; i++) {
        const el = photoCardRefs.current.get(i);
        if (el) {
          const rect = el.getBoundingClientRect();
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
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    };
  }, [displayPhotos]);

  const handleScrollToTimelineIndex = (photoIdx: number) => {
    const el = photoCardRefs.current.get(photoIdx);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  /*
   * 篩選（相簿名／描述／底下照片命中）與排序都已經在後端做完，`albums` 拿到的
   * 就是要顯示的東西。這裡保留這個名字只是為了不用改動下面一整片 JSX。
   */
  const displayAlbums = albums;

  const handleLogin = async () => {
    setIsSubmitting(true);
    const result = await login(passwordInput);
    if (result.success) {
      setShowLoginModal(false);
      setPasswordInput("");
    } else {
      alert(result.message || "密碼錯誤");
    }
    setIsSubmitting(false);
  };

  const handleCreateAlbum = async () => {
    if (!newAlbumName.trim()) return;
    setIsSubmitting(true);
    const success = await createAlbum(newAlbumName, "");
    if (success) {
      setNewAlbumName("");
      setShowModal(false);
      loadData(); // 重新載入列表
    } else {
      alert("建立失敗，請稍後再試。");
    }
    setIsSubmitting(false);
  };

  const handleBatchDeleteAlbums = async () => {
    const idsToDelete = [...selectedAlbums];

    // 1. 立即關閉確認視窗與編輯模式
    setShowDeleteConfirm(false);
    setSelectedAlbums([]);
    setIsEditingAlbums(false);

    // 2. 樂觀更新: 立即從畫面上移除相簿
    setAlbums(prevAlbums => prevAlbums.filter(album => !idsToDelete.includes(album.id)));

    // 3. 背景非同步執行 API 刪除
    (async () => {
      let failCount = 0;
      for (const id of idsToDelete) {
        const success = await deleteAlbum(id);
        if (!success) failCount++;
      }
      if (failCount > 0) {
        loadData();
      }
    })();
  };

  // Drag and Drop handlers
  const handlePointerDown = (index: number) => {
    // 篩選中畫面上只是子集合，拖曳算出來的 sort_order 會是錯的（見 handleDragEnd）
    if (!isAdmin || isFiltering) return;
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
      
      const newAlbums = [...albums];
      const draggedItemContent = newAlbums.splice(dragItem.current, 1)[0];
      newAlbums.splice(index, 0, draggedItemContent);
      setAlbums(newAlbums); // 立即樂觀更新 UI
      
      // 更新 dragItem 到新的位置
      dragItem.current = index;
      setDraggingIndex(index);
    }
  };

  const handleDragEnd = async () => {
    if (dragItem.current !== null) {
      /*
       * sort_order 直接用「這本在畫面上的第幾個」。
       *
       * 成立的前提是畫面上這串相簿是完整順序的前綴 —— 無限捲動一定從 offset 0
       * 開始往後接，所以沒問題；但有搜尋或標籤篩選時畫面上是挑過的子集合，
       * 第 3 個實際上可能是全站的第 87 本，照這樣寫回去會把其他相簿的順序全部
       * 打亂。所以篩選中不讓拖曳生效（下面的 draggable 也一併關掉）。
       */
      const updates = albums.map((album, index) => ({
        id: album.id,
        sort_order: index,
      }));
      const success = await reorderAlbums(updates);
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
    <main className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerContent}>
          <h1 className={styles.title}>
            DidaDida
          </h1>
          <p className={styles.subtitle}>紀錄每一個美好瞬間</p>
          <Link
            href="/map"
            style={{
              display: 'inline-block', marginTop: 10, fontSize: 14,
              color: 'var(--accent-color, #2563eb)', textDecoration: 'none',
            }}
          >
            🗺️ 足跡地圖
          </Link>
        </div>
        <div className={styles.controls}>
          <div className={styles.filters}>
            <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
              <input 
                type="text" 
                placeholder="搜尋相簿或照片 Story..." 
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

            <div className={styles.desktopOnly}>
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
                  { value: "upload_date", label: "依建立日期 (新到舊)" }
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
              className={styles.mobileFilterBtn}
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
                    { value: "upload_date", label: "建立日期 (新到舊)" }
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
                    <div style={{ padding: '20px', color: '#888', fontSize: '0.9rem' }}>全站尚無相片標籤</div>
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
          </div>
          {/* 管理／登入的按鈕都收進右下角的 FabMenu，頁首只留搜尋與篩選 */}
        </div>
      </header>

      {loading ? (
        <div className={styles.loading}>載入中...</div>
      ) : (searchQuery.trim() || selectedTags.length > 0) ? (
        /* 照片與相簿分層搜尋/標籤篩選結果模式 */
        <div>
          {displayPhotos.length > 0 && (
            <div style={{ marginBottom: '40px' }}>
              <h2 style={{ fontSize: '1.2rem', fontWeight: 300, color: 'var(--text-color)', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '8px', letterSpacing: '0.05em' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                  <circle cx="8.5" cy="8.5" r="1.5"></circle>
                  <polyline points="21 15 16 10 5 21"></polyline>
                </svg>
                {selectedTags.length > 0 && !searchQuery.trim()
                  ? `標籤篩選照片 (${displayPhotos.length} 張)`
                  : `照片搜尋結果 (${displayPhotos.length} 張)`}
              </h2>
              <div className={albumStyles.photoGrid}>
                {displayPhotos.map((photo, index) => (
                  <div
                    key={photo.id}
                    ref={(el) => {
                      if (el) photoCardRefs.current.set(index, el);
                      else photoCardRefs.current.delete(index);
                    }}
                    className={albumStyles.photoCard}
                    onClick={() => setSelectedPhotoIndex(index)}
                  >
                    <img
                      src={photoThumbSrc(photo, 'md')}
                      alt={photo.title}
                      className={albumStyles.photoImage} 
                      loading="lazy" 
                      decoding="async" 
                    />
                    <div className={albumStyles.photoOverlay}>
                      <h3 className={albumStyles.photoTitle}>{photo.title}</h3>
                      <p className={albumStyles.photoDate}>
                        {(photo as any).album_name ? `[${(photo as any).album_name}] ` : ''}
                        {photo.taken_at ? new Date(photo.taken_at).toLocaleDateString() : new Date(photo.created_at).toLocaleDateString()}
                      </p>
                      {photo.tags && photo.tags.length > 0 && (
                         <div className={albumStyles.cardTags}>
                           {photo.tags.slice(0,3).map(t => <span key={t.id} className={albumStyles.cardTag}>{t.name}</span>)}
                           {photo.tags.length > 3 && <span className={albumStyles.cardTag}>+{photo.tags.length - 3}</span>}
                         </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {displayAlbums.length > 0 && (
            <div style={{ marginTop: '30px' }}>
              <h2 style={{ fontSize: '1.2rem', fontWeight: 300, color: 'var(--text-color)', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '8px', letterSpacing: '0.05em' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                </svg>
                {selectedTags.length > 0 && !searchQuery.trim()
                  ? `包含標籤的相簿 (${displayAlbums.length} 個)`
                  : `相簿搜尋結果 (${displayAlbums.length} 個)`}
              </h2>
              <div 
                className={styles.albumGrid}
                style={gridColumns > 0 ? { gridTemplateColumns: `repeat(${gridColumns}, 1fr)` } : undefined}
              >
                {displayAlbums.map((album, index) => (
                  <AlbumCardComponent 
                    key={album.id}
                    album={album}
                    index={index}
                    isAdmin={isAdmin}
                    isEditing={isEditingAlbums}
                    draggingIndex={draggingIndex}
                    longPressIndex={longPressIndex}
                    sortBy={sortBy}
                    handlePointerDown={handlePointerDown}
                    handlePointerUpOrLeave={handlePointerUpOrLeave}
                    handleDragStart={handleDragStart}
                    handleDragEnter={handleDragEnter}
                    handleDragEnd={handleDragEnd}
                    isSelected={selectedAlbums.includes(album.id)}
                    onSelectToggle={(id: number, checked: boolean) => {
                      if (checked) setSelectedAlbums(prev => [...prev, id]);
                      else setSelectedAlbums(prev => prev.filter(aid => aid !== id));
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {displayPhotos.length === 0 && displayAlbums.length === 0 && (
            <div className={styles.emptyState}>找不到符合條件的相簿或照片</div>
          )}
        </div>
      ) : (
        /* 預設相簿列表模式 */
        <div 
          className={styles.albumGrid}
          style={gridColumns > 0 ? { gridTemplateColumns: `repeat(${gridColumns}, 1fr)` } : undefined}
        >
          {displayAlbums.map((album, index) => (
            <AlbumCardComponent 
              key={album.id}
              album={album}
              index={index}
              isAdmin={isAdmin}
              isEditing={isEditingAlbums}
              draggingIndex={draggingIndex}
              longPressIndex={longPressIndex}
              sortBy={sortBy}
              handlePointerDown={handlePointerDown}
              handlePointerUpOrLeave={handlePointerUpOrLeave}
              handleDragStart={handleDragStart}
              handleDragEnter={handleDragEnter}
              handleDragEnd={handleDragEnd}
              isSelected={selectedAlbums.includes(album.id)}
              onSelectToggle={(id: number, checked: boolean) => {
                if (checked) setSelectedAlbums(prev => [...prev, id]);
                else setSelectedAlbums(prev => prev.filter(aid => aid !== id));
              }}
            />
          ))}
          {displayAlbums.length === 0 && !loading && (
            <div className={styles.emptyState}>找不到相簿</div>
          )}
        </div>
      )}

      {/*
        無限捲動的哨兵。放在網格外面而不是當成格子的一員 —— 塞進 grid 裡會佔掉
        一格，最後一列就會空一個洞。rootMargin 讓它在還差 400px 進畫面時就先要
        下一頁，捲到底時通常已經接上了。
      */}
      {hasMoreAlbums && (
        <div ref={albumSentinelRef} style={{ padding: '24px 0', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
          {loadingMoreAlbums ? '載入中…' : ''}
        </div>
      )}

      {/* 右側懸浮照片時間軸滾動條 */}
      {timelineGroup.length > 0 && searchQuery.trim() && (
        <div className={`${albumStyles.timelineTrack} ${isScrolling ? albumStyles.timelineActive : ""}`}>
          {currentTimelineDate && (
            <div className={albumStyles.timelineBubble}>
              {currentTimelineDate}
            </div>
          )}
          <div className={albumStyles.timelineMarks}>
            {timelineGroup.map((item) => (
              <div 
                key={item.label} 
                className={albumStyles.timelineNode}
                onClick={() => handleScrollToTimelineIndex(item.index)}
                title={`前往 ${item.label}`}
              >
                <span className={albumStyles.timelineNodeDot} />
                <span className={albumStyles.timelineNodeText}>{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 照片 Lightbox / 大圖檢視 */}
      {selectedPhotoIndex !== null && (
        <PhotoLightbox 
          photo={displayPhotos[selectedPhotoIndex]}
          isAdmin={isAdmin} 
          availableTags={[]} 
          onClose={() => setSelectedPhotoIndex(null)}
          onUpdate={loadData}
          onPrev={selectedPhotoIndex > 0 ? () => setSelectedPhotoIndex(selectedPhotoIndex - 1) : undefined}
          onNext={selectedPhotoIndex < displayPhotos.length - 1 ? () => setSelectedPhotoIndex(selectedPhotoIndex + 1) : undefined}
          hasPrev={selectedPhotoIndex > 0}
          hasNext={selectedPhotoIndex < displayPhotos.length - 1}
        />
      )}

      {/* 右下角浮動操作鈕。編輯模式下交棒給底部動作列，所以這裡給空陣列 */}
      <FabMenu
        actions={
          isCheckingAuth || isEditingAlbums
            ? []
            : isAdmin
              ? [
                  { key: 'create', label: '建立相簿', icon: '＋', onClick: () => setShowModal(true) },
                  { key: 'edit', label: '編輯相簿', icon: '✎', onClick: () => setIsEditingAlbums(true) },
                ]
              : [
                  { key: 'login', label: '管理員登入', icon: '🔑', onClick: () => setShowLoginModal(true) },
                ]
        }
      />

      {/* 底部動作列 (編輯模式) */}
      {isEditingAlbums && (
        <BottomActionBar className={styles.actionBar}>
          <button
            className={styles.actionButton}
            onClick={() => {
              if (selectedAlbums.length === displayAlbums.length) {
                setSelectedAlbums([]);
              } else {
                setSelectedAlbums(displayAlbums.map(a => a.id));
              }
            }}
          >
            {selectedAlbums.length === displayAlbums.length ? '取消全選' : '全選'}
          </button>

          <button
            className={`${styles.actionButton} ${selectedAlbums.length > 0 ? styles.danger : ''}`}
            onClick={() => setShowDeleteConfirm(true)}
            disabled={selectedAlbums.length === 0 || isBatchDeleting}
            style={{ opacity: selectedAlbums.length === 0 ? 0.5 : 1 }}
          >
            {isBatchDeleting ? '刪除中...' : `刪除 ${selectedAlbums.length} 個項目`}
          </button>

          {/* 「編輯／完成」的切換鈕原本在頁首，編輯模式下 FAB 收起，出口就放在這排的尾端 */}
          <button
            className={`${styles.actionButton} ${styles.primary}`}
            onClick={() => {
              setIsEditingAlbums(false);
              setSelectedAlbums([]);
            }}
          >
            完成
          </button>
        </BottomActionBar>
      )}

      {/* 建立相簿 Modal */}
      {showModal && (
        <div className={styles.modalOverlay} onClick={() => setShowModal(false)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <h2 className={styles.modalTitle}>建立新相簿</h2>
            <div className={styles.inputGroup}>
              <label>相簿名稱</label>
              <input 
                type="text" 
                placeholder="例如：2026 寶寶成長日記" 
                value={newAlbumName}
                onChange={e => setNewAlbumName(e.target.value)}
                autoFocus
                required
              />
            </div>
            <div className={styles.modalActions}>
              <button type="button" className={styles.cancelButton} onClick={() => setShowModal(false)}>取消</button>
              <button 
                type="button"
                className={styles.submitButton} 
                onClick={handleCreateAlbum}
                disabled={!newAlbumName.trim() || isSubmitting}
              >
                {isSubmitting ? "建立中..." : "建立"}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 登入 Modal */}
      {showLoginModal && (
        <div className={styles.modalOverlay} onClick={() => setShowLoginModal(false)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <h2 className={styles.modalTitle}>管理員登入</h2>
            <div className={styles.inputGroup}>
              <label>密碼</label>
              <input 
                type="password" 
                placeholder="請輸入管理員密碼..." 
                value={passwordInput}
                onChange={e => setPasswordInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleLogin()}
                autoFocus
                required
              />
            </div>
            <div className={styles.modalActions}>
              <button type="button" className={styles.cancelButton} onClick={() => setShowLoginModal(false)}>取消</button>
              <button 
                type="button"
                className={styles.submitButton} 
                onClick={handleLogin}
                disabled={!passwordInput || isSubmitting}
              >
                {isSubmitting ? "登入中..." : "登入"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Slide Confirm Modal for Albums */}
      <SlideConfirmModal 
        isOpen={showDeleteConfirm}
        title={`刪除 ${selectedAlbums.length} 個相簿`}
        message={`確定要刪除這 ${selectedAlbums.length} 個相簿嗎？這個動作無法復原，裡面的所有照片都會被刪除。`}
        onConfirm={handleBatchDeleteAlbums}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </main>
  );
}
