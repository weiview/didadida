import styles from "./page.module.css";
import Link from "next/link";

// 模擬資料，後續會串接 Cloudflare Workers API
const DUMMY_ALBUMS = [
  { id: 1, name: "2026 寶寶成長日記", photoCount: 128, date: "2026-06-06" },
  { id: 2, name: "日本旅行", photoCount: 342, date: "2026-04-12" },
  { id: 3, name: "家庭聚餐", photoCount: 56, date: "2026-01-20" },
];

export default function Home() {
  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1 className={styles.title}>DidaDida</h1>
        <p className={styles.subtitle}>您的專屬質感相簿</p>
      </header>

      <div className={styles.albumGrid}>
        {DUMMY_ALBUMS.map((album) => (
          <Link href={`/album/${album.id}`} key={album.id} className={`glass-panel ${styles.albumCard}`}>
            <div className={styles.coverPlaceholder}>
              {album.name.substring(0, 1)}
            </div>
            <h2 className={styles.albumTitle}>{album.name}</h2>
            <p className={styles.albumMeta}>
              {album.photoCount} 張照片 • {album.date}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
