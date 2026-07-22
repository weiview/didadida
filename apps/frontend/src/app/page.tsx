"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import styles from "./page.module.css";
import albumStyles from "./album/album.module.css";
import Link from "next/link";
import { fetchAlbums, createAlbum, deleteAlbum, Album, reorderAlbums, verifyLogin, fetchAllPhotos, Photo } from "@/lib/api";
import SlideConfirmModal from "@/components/SlideConfirmModal";
import PhotoLightbox from "./album/PhotoLightbox";

function AlbumCardComponent({ album, isAdmin, isEditing, draggingIndex, longPressIndex, sortBy, index, handlePointerDown, handlePointerUpOrLeave, handleDragStart, handleDragEnter, handleDragEnd, isSelected, onSelectToggle }: any) {
  const [hovered, setHovered] = useState(false);
  const [photoIndex, setPhotoIndex] = useState(0);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (hovered && album.preview_photos && album.preview_photos.length > 0) {
      interval = setInterval(() => {
        setPhotoIndex(prev => (prev + 1) % album.preview_photos.length);
      }, 4000);
    } else {
      setPhotoIndex(0);
    }
    return () => clearInterval(interval);
  }, [hovered, album]);

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
          {/* Carousel images */}
          {album.preview_photos?.map((photoUrl: string, i: number) => (
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
                opacity: (hovered && album.preview_photos && album.preview_photos.length > 0) ? 0 : 1
              }}
            />
          )}
          
          {/* Static cover text (if no cover photo is set) */}
          {!album.cover_photo_url && (
            <span style={{ 
              position: 'relative', 
              zIndex: 2,
              opacity: (hovered && album.preview_photos && album.preview_photos.length > 0) ? 0 : 1,
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
  const [isAdmin, setIsAdmin] = useState(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  
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
  const [sortBy, setSortBy] = useState<"custom" | "upload_date">("custom");

  // Drag and drop state
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [longPressIndex, setLongPressIndex] = useState<number | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // 照片全站搜尋與大圖檢視 State
  const [allPhotos, setAllPhotos] = useState<Photo[]>([]);
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState<number | null>(null);

  // 時間軸滾動條 State
  const [currentTimelineDate, setCurrentTimelineDate] = useState<string>("");
  const [isScrolling, setIsScrolling] = useState<boolean>(false);
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const photoCardRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const loadData = async () => {
    setLoading(true);
    const [albumsData, photosData] = await Promise.all([
      fetchAlbums(),
      fetchAllPhotos()
    ]);
    setAlbums(albumsData || []);
    setAllPhotos(photosData || []);
    setLoading(false);
  };

  useEffect(() => {
    loadData();
    if (typeof window !== "undefined") {
      const pwd = localStorage.getItem("admin_password");
      if (pwd) {
        setIsAdmin(true);
        setIsCheckingAuth(false); // 立即顯示管理員按鈕
        const checkAdmin = async () => {
          const result = await verifyLogin(pwd);
          setIsAdmin(result.success);
          if (!result.success) localStorage.removeItem("admin_password");
        };
        checkAdmin();
      } else {
        setIsCheckingAuth(false);
      }
    }
  }, []);

  // 計算符合條件的全站照片
  const displayPhotos = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase().trim();
    return allPhotos.filter(photo => {
      const matchTitle = photo.title?.toLowerCase().includes(q);
      const matchDesc = photo.description?.toLowerCase().includes(q);
      const matchTag = photo.tags?.some(t => t.name.toLowerCase().includes(q));
      return matchTitle || matchDesc || matchTag;
    });
  }, [allPhotos, searchQuery]);

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

  // 計算經過篩選與排序的相簿 (包含：相簿名稱、相簿描述、或是底下照片包含匹配標籤/Story 的相簿)
  const displayAlbums = useMemo(() => {
    if (!searchQuery.trim()) {
      return [...albums].sort((a, b) => {
        if (sortBy === "custom") return a.sort_order - b.sort_order;
        if (sortBy === "upload_date") return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        return 0;
      });
    }

    const q = searchQuery.toLowerCase().trim();

    // 找出所有符合搜尋條件的照片所屬的 album_id
    const matchedAlbumIdsFromPhotos = new Set(
      allPhotos
        .filter(photo => {
          const matchTitle = photo.title?.toLowerCase().includes(q);
          const matchDesc = photo.description?.toLowerCase().includes(q);
          const matchTag = photo.tags?.some(t => t.name.toLowerCase().includes(q));
          return matchTitle || matchDesc || matchTag;
        })
        .map(photo => photo.album_id)
    );

    return albums.filter(album => {
      const matchAlbumName = album.name.toLowerCase().includes(q);
      const matchAlbumDesc = album.description?.toLowerCase().includes(q);
      const matchChildPhotos = matchedAlbumIdsFromPhotos.has(album.id);
      return matchAlbumName || matchAlbumDesc || matchChildPhotos;
    }).sort((a, b) => {
      if (sortBy === "custom") return a.sort_order - b.sort_order;
      if (sortBy === "upload_date") return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      return 0;
    });
  }, [albums, allPhotos, searchQuery, sortBy]);

  const handleLogin = async () => {
    setIsSubmitting(true);
    const result = await verifyLogin(passwordInput);
    if (result.success) {
      setIsAdmin(true);
      localStorage.setItem("admin_password", passwordInput);
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
      // 呼叫 API 儲存新的排序順序
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
        </div>
        <div className={styles.controls}>
          <div className={styles.filters}>
            <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
              <input 
                type="text" 
                placeholder="搜尋相簿、照片 Story 或標籤..." 
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
            <select value={sortBy} onChange={e => setSortBy(e.target.value as any)} className={styles.select}>
              <option value="custom">自訂排序 (可拖曳)</option>
              <option value="upload_date">依建立日期 (新到舊)</option>
            </select>
          </div>
          {!isCheckingAuth && (
            isAdmin ? (
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  className={`${styles.createButton} ${isEditingAlbums ? styles.primary : ''}`}
                  onClick={() => {
                    if (isEditingAlbums) {
                      setIsEditingAlbums(false);
                      setSelectedAlbums([]);
                    } else {
                      setIsEditingAlbums(true);
                    }
                  }}
                >
                  {isEditingAlbums ? '完成' : '編輯'}
                </button>

                {!isEditingAlbums && (
                  <button 
                    className={styles.createButton}
                    onClick={() => setShowModal(true)}
                  >
                    + 建立相簿
                  </button>
                )}
              </div>
            ) : (
              <button 
                className={styles.createButton}
                onClick={() => setShowLoginModal(true)}
              >
                管理員登入
              </button>
            )
          )}
        </div>
      </header>

      {loading ? (
        <div className={styles.loading}>載入中...</div>
      ) : searchQuery.trim() ? (
        /* 照片與相簿搜尋結果模式 */
        <div>
          {displayPhotos.length > 0 && (
            <div style={{ marginBottom: '40px' }}>
              <h2 style={{ fontSize: '1.2rem', fontWeight: 300, color: 'var(--text-color)', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '8px', letterSpacing: '0.05em' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                  <circle cx="8.5" cy="8.5" r="1.5"></circle>
                  <polyline points="21 15 16 10 5 21"></polyline>
                </svg>
                照片搜尋結果 ({displayPhotos.length} 張)
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
                      src={photo.thumb_url || photo.url} 
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
                相簿搜尋結果 ({displayAlbums.length} 個)
              </h2>
              <div className={styles.albumGrid}>
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
        <div className={styles.albumGrid}>
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
          {displayAlbums.length === 0 && (
            <div className={styles.emptyState}>找不到相簿</div>
          )}
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

      {/* 底部動作列 (編輯模式) */}
      {isEditingAlbums && (
        <div className={styles.actionBar}>
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
        </div>
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
