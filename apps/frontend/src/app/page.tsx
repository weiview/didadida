"use client";

import { useEffect, useState, useRef } from "react";
import styles from "./page.module.css";
import Link from "next/link";
import { fetchAlbums, createAlbum, Album, reorderAlbums, verifyLogin } from "@/lib/api";

export default function Home() {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  
  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Drag and drop state
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);

  const loadData = async () => {
    setLoading(true);
    const data = await fetchAlbums();
    setAlbums(data || []);
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
    loadData();
  }, []);

  const handleLogin = async () => {
    setIsSubmitting(true);
    const valid = await verifyLogin(passwordInput);
    if (valid) {
      localStorage.setItem("admin_password", passwordInput);
      setIsAdmin(true);
      setShowLoginModal(false);
      setPasswordInput("");
    } else {
      alert("密碼錯誤");
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

  // Drag and Drop handlers
  const handleDragStart = (index: number) => {
    dragItem.current = index;
  };

  const handleDragEnter = (index: number) => {
    dragOverItem.current = index;
  };

  const handleDragEnd = async () => {
    if (dragItem.current !== null && dragOverItem.current !== null && dragItem.current !== dragOverItem.current) {
      const newAlbums = [...albums];
      const draggedItemContent = newAlbums.splice(dragItem.current, 1)[0];
      newAlbums.splice(dragOverItem.current, 0, draggedItemContent);
      setAlbums(newAlbums); // 樂觀更新 UI

      // 呼叫 API 儲存新的排序順序
      const updates = newAlbums.map((album, index) => ({
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
  };

  return (
    <main className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerContent}>
          <h1 className={styles.title}>DidaDida</h1>
          <p className={styles.subtitle}>質感相簿 紀錄每一個美好瞬間</p>
        </div>
        {isAdmin ? (
          <button 
            className={styles.createButton}
            onClick={() => setShowModal(true)}
          >
            + 建立相簿
          </button>
        ) : (
          <button 
            className={styles.createButton}
            onClick={() => setShowLoginModal(true)}
          >
            管理員登入
          </button>
        )}
      </header>

      {loading ? (
        <div className={styles.loading}>載入中...</div>
      ) : (
        <div className={styles.albumGrid}>
          {albums.map((album, index) => (
            <Link 
              href={`/album?id=${album.id}`} 
              key={album.id} 
              className={`glass-panel ${styles.albumCard}`}
              draggable={isAdmin}
              onDragStart={() => isAdmin && handleDragStart(index)}
              onDragEnter={() => isAdmin && handleDragEnter(index)}
              onDragEnd={isAdmin ? handleDragEnd : undefined}
              onDragOver={(e) => isAdmin && e.preventDefault()}
            >
              <div className={styles.coverPlaceholder}>
                {album.name.substring(0, 1)}
              </div>
              <h2 className={styles.albumTitle}>{album.name}</h2>
              <p className={styles.albumMeta}>
                {new Date(album.created_at).toLocaleDateString()}
              </p>
            </Link>
          ))}
          {albums.length === 0 && (
            <div className={styles.emptyState}>目前還沒有相簿</div>
          )}
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
    </main>
  );
}
