"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import styles from "./page.module.css";
import Link from "next/link";
import { fetchAlbums, createAlbum, deleteAlbum, Album, reorderAlbums, verifyLogin } from "@/lib/api";
import SlideConfirmModal from "@/components/SlideConfirmModal";

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

  const loadData = async () => {
    setLoading(true);
    const data = await fetchAlbums();
    setAlbums(data || []);
    setLoading(false);
  };

  useEffect(() => {
    loadData();
    if (typeof window !== "undefined") {
      const pwd = localStorage.getItem("admin_password");
      if (pwd) {
        setIsAdmin(true);
        const checkAdmin = async () => {
          const result = await verifyLogin(pwd);
          setIsAdmin(result.success);
          if (!result.success) localStorage.removeItem("admin_password");
          setIsCheckingAuth(false);
        };
        checkAdmin();
      } else {
        setIsCheckingAuth(false);
      }
    }
  }, []);

  // 計算經過篩選與排序的相簿
  const displayAlbums = useMemo(() => {
    return albums.filter(album => {
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return album.name.toLowerCase().includes(q) || album.description?.toLowerCase().includes(q);
      }
      return true;
    }).sort((a, b) => {
      if (sortBy === "custom") return a.sort_order - b.sort_order;
      if (sortBy === "upload_date") return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      return 0;
    });
  }, [albums, searchQuery, sortBy]);

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
    setIsBatchDeleting(true);
    for (const id of selectedAlbums) {
      await deleteAlbum(id);
    }
    setIsBatchDeleting(false);
    setShowDeleteConfirm(false);
    setSelectedAlbums([]);
    setIsEditingAlbums(false);
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
          <h1 className={styles.title}>DidaDida</h1>
          <p className={styles.subtitle}>紀錄每一個美好瞬間</p>
        </div>
        <div className={styles.controls}>
          <div className={styles.filters}>
            <input 
              type="text" 
              placeholder="搜尋相簿名稱..." 
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className={styles.searchInput}
            />
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
      ) : (
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
