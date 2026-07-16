import styles from "./album.module.css";
import Link from "next/link";

// 模擬資料，後續串接 D1 資料庫 API
const DUMMY_ALBUMS: Record<string, string> = {
  "1": "2026 寶寶成長日記",
  "2": "日本旅行",
  "3": "家庭聚餐",
};

const DUMMY_PHOTOS = [
  { id: 101, title: "出生第一天", fileName: "001.jpg", date: "2026-06-06", url: "https://images.unsplash.com/photo-1519689680058-324335c77eba?auto=format&fit=crop&w=600&q=80" },
  { id: 102, title: "第一次微笑", fileName: "002.jpg", date: "2026-06-10", url: "https://images.unsplash.com/photo-1519340333755-56e9c1d04579?auto=format&fit=crop&w=600&q=80" },
  { id: 103, title: "滿月慶祝", fileName: "003.jpg", date: "2026-07-06", url: "https://images.unsplash.com/photo-1522771731478-4ea583a48e77?auto=format&fit=crop&w=600&q=80" },
];

export default function AlbumPage({ params }: { params: { id: string } }) {
  // 未來會使用 params.id 去 API 抓取相簿資訊與照片列表
  const albumName = DUMMY_ALBUMS[params.id] || "未知相簿"; 

  return (
    <div className={styles.container}>
      <Link href="/" className={styles.backButton}>
        ← 返回相簿列表
      </Link>

      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>{albumName}</h1>
          <p className={styles.meta}>共 {DUMMY_PHOTOS.length} 張照片</p>
        </div>
        <button className={styles.uploadButton}>
          上傳照片
        </button>
      </div>

      <div className={styles.photoGrid}>
        {DUMMY_PHOTOS.map((photo) => (
          <div key={photo.id} className={styles.photoCard}>
            {/* 實際開發時可使用 next/image */}
            <img src={photo.url} alt={photo.title} className={styles.photoImage} />
            <div className={styles.photoOverlay}>
              <h3 className={styles.photoTitle}>{photo.title}</h3>
              <p className={styles.photoDate}>{photo.date}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
