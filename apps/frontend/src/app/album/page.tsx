"use client";

import { useEffect, useState, useRef, Suspense, useMemo } from "react";
import styles from "./album.module.css";
import pageStyles from "../page.module.css";
import Link from "next/link";
import { Photo, Tag, fetchPhotos, uploadPhoto, fetchAlbum, deletePhoto, reorderPhotos, fetchTags, updateAlbum, Album, createGooglePickerSession, fetchGooglePickerPhotos, fetchGoogleMediaFile, GoogleReauthError, photoThumbSrc, googleLoginUrl, DriveWriterError, type UploadedPhoto, type DuplicateMatch } from "@/lib/api";
import { ensureAlbumFolder, ensureDriveFolders, prewarmDrive, pushPhotoToDrive } from "@/lib/drive";
import { useAdmin } from "@/lib/useAdmin";
import SlideConfirmModal from "@/components/SlideConfirmModal";
import GoogleSyncConflictModal from "@/components/GoogleSyncConflictModal";
import AssignPlaceModal from "@/components/AssignPlaceModal";
import FixTimeModal from "@/components/FixTimeModal";
import PostUploadReviewModal from "@/components/PostUploadReviewModal";
import PlaceCheckinModal from "@/components/PlaceCheckinModal";
import DriveBackfillModal from "@/components/DriveBackfillModal";
import { resizeImageFile } from "@/lib/imageUtils";
import { useSearchParams } from "next/navigation";
import PhotoLightbox from "./PhotoLightbox";
import CustomSelect from "@/components/CustomSelect";
import FilterBottomSheet from "@/components/FilterBottomSheet";
import FabMenu, { type FabAction } from "@/components/FabMenu";
import BottomActionBar from "@/components/BottomActionBar";

/**
 * 被判定為重複、還沒寫進去的那一張。
 *
 * `resized` 是已經縮好的那份 —— 使用者選「照樣上傳」時直接用它，
 * 不必再解一次圖（大批照片重解會讓瀏覽器卡住）。`file` 是原始檔，
 * 給預覽圖與 Drive 備份用。
 */
type PendingDuplicate = {
  key: string;
  file: File;
  resized: File;
  /** 原始檔的 object URL，給視窗左邊那張「準備匯入的新照片」用。走完要 revoke */
  previewUrl: string;
  exifData: any;
  takenAt?: string;
  reason: 'same_file' | 'same_time';
  existing: DuplicateMatch[];
};

function AlbumContent() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  
  const [albumName, setAlbumName] = useState("相簿");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const { isAdmin, isOwner, canEdit, canAddTo, canReorderIn } = useAdmin();
  /**
   * 這本相簿本身。留著它是為了 `canEditAlbum` —— 光有 isAdmin 不夠，
   * 一般成員只動得了自己建的相簿（跟後端 canTouchAlbum 同一條規則）。
   */
  const [album, setAlbum] = useState<Album | null>(null);
  /**
   * 這本相簿我動不動得了 —— 頁面上所有編輯入口都看它，而不是只看 isAdmin。
   * 相簿還沒載進來時是 false，寧可晚半秒才長出按鈕，也不要先給再收回去。
   */
  const canEditAlbum = canEdit(album);
  /**
   * 「往這本相簿裡加照片」是另一格權限，不含改名、刪照片、設封面那些。
   * 家人預設就有（站長可在 /admin 對個別帳號關掉），所以別人建的相簿也看得到
   * 上傳入口。自己的相簿一定為 true —— canEditAlbum 成立時這個也一定成立。
   */
  const canAddToAlbum = canAddTo(album);
  /** 拖曳排序動到的是相簿主人的版面，預設只有自己的相簿，其餘要站長另外給 */
  const canReorderPhotos = canReorderIn(album);
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState<number | null>(null);
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [visibleCount, setVisibleCount] = useState<number>(24);
  const [uploadProgress, setUploadProgress] = useState<{current: number, total: number, fileName: string} | null>(null);
  /** Drive 沒接上時的原因。照片照樣傳得上去，只是少了 4K 與原始檔備份 */
  const [driveError, setDriveError] = useState<string | null>(null);
  const [showDriveBackfill, setShowDriveBackfill] = useState(false);
  /**
   * 這次失敗是不是「後端手上沒有站長的 Drive 授權」——從來沒有，或那份過期了。
   *
   * 站上**沒有任何按鈕**能修這件事（2026-08-14 拿掉了「連結 Drive 寫入帳號」）：
   * 授權是站長用 Google 登入時後端自動收下的，或直接設在環境 secret 裡。
   * 所以這個旗標現在只用來換一句「怎麼會這樣、該找誰」的說明，不是動作入口。
   */
  const [driveNeedsLink, setDriveNeedsLink] = useState(false);
  /**
   * 剛上傳、但沒送上 Drive 的那一批：照片 id 配上使用者原本選的那個 File。
   *
   * 留著它，黃色橫幅那顆按鈕才能真的「補傳這批」—— 授權完直接拿這些檔案送出去，
   * 不必請人再選一次，也不必靠檔名對回照片（id 是上傳當下回傳的，不會對錯）。
   * File 物件在沒重整頁面、原檔沒被移動的前提下一直有效。
   * 重整之後就沒了，那時只剩「補傳 Drive」那條重選檔案的路。
   */
  const [pendingDriveBatch, setPendingDriveBatch] = useState<{ photoId: number; file: File }[]>([]);
  const [driveBatchProgress, setDriveBatchProgress] = useState<{ current: number; total: number } | null>(null);
  /**
   * 後端擋下來的重複照片，跑完一批之後一張一張問，用的是 Google 匯入那套
   * 衝突視窗（可複選要取代哪幾張既有照片）。空陣列＝沒東西要問。
   */
  const [duplicateItems, setDuplicateItems] = useState<PendingDuplicate[]>([]);
  const [duplicateIndex, setDuplicateIndex] = useState(0);
  const [duplicateBusy, setDuplicateBusy] = useState(false);
  /** 這一批的 Drive 位置，重複那幾張決定要傳時直接沿用，不必重跑一次 bootstrap */
  const driveRef = useRef<{ folderId: string; token: string } | null>(null);
  /** 重複那幾張補傳成功的，等整個佇列走完再一起丟給補地點的視窗 */
  const dupUploadedRef = useRef<UploadedPhoto[]>([]);

  // 批次刪除 State
  const [selectedPhotos, setSelectedPhotos] = useState<number[]>([]);
  const [showAssignPlace, setShowAssignPlace] = useState(false);
  const [showFixTime, setShowFixTime] = useState(false);
  // 相簿層級的打卡補件畫面（整本攤開、照日期分組）
  const [showPlaceCheckin, setShowPlaceCheckin] = useState(false);
  // 從打卡畫面轉去指定地點時，套用完要回到打卡畫面繼續處理下一批
  const [returnToCheckin, setReturnToCheckin] = useState(false);
  // 剛上傳的那一批。非空即代表補件視窗開著
  const [postUploadIds, setPostUploadIds] = useState<number[]>([]);
  // Shift 連選的錨點（顯示順序上的 index）
  const lastSelectedIndexRef = useRef<number | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  const [isEditingPhotos, setIsEditingPhotos] = useState(false);

  // Google Sync State
  const [syncingGoogle, setSyncingGoogle] = useState(false);
  /**
   * Google 那半邊的授權掉了（後端回 409 google_reauth）時要講的話。
   *
   * 這是**唯一**會把人帶去 Google 的入口了 —— 平常匯入用的是後端存的
   * refresh token，按下去不會跳轉，頁面狀態也不會沒。
   */
  const [googleReauth, setGoogleReauth] = useState<string | null>(null);

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

  /** 回傳重抓到的照片，讓呼叫端不必等 state 生效就能依最新資料做決定 */
  const loadData = async (): Promise<Photo[]> => {
    if (!id) return [];
    setLoading(true);

    const [current, photoData, tags] = await Promise.all([
      fetchAlbum(id),
      fetchPhotos(id),
      fetchTags()
    ]);

    if (current) {
      setAlbum(current);
      setAlbumName(current.name);
      setCurrentCoverPhotoUrl(current.cover_photo_url || null);
    }
    
    const fresh = photoData || [];
    setPhotos(fresh);
    setAvailableTags(tags);

    setLoading(false);
    return fresh;
  };

  useEffect(() => {
    if (id) {
      loadData();
    }
    
    /*
     * 管理員狀態與登入回呼都由 useAdmin 負責（fragment 在那裡收，網址也在那裡擦）。
     * 這裡不再問「Google token 還在不在」—— 瀏覽器手上已經沒有那張票了。
     */
    if (typeof window !== "undefined") {
      // 訪客不預熱：`/api/config/drive` 是管理員才讀得到的設定，訪客打過去
      // 一定是 401，主控台就多一行紅字。備份是管理員的功能，訪客連按都按不到
      if (isAdmin) prewarmDrive();
    }
  }, [id, searchParams, isAdmin]);

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

  /**
   * `?photo=<id>` 直接開燈箱。通知列表點過來的就是這種網址。
   *
   * 只認一次（`deepLinkDone`）：這串要等照片載完才有得找，而 displayPhotos
   * 會隨篩選與排序一直變 —— 不記一筆的話，使用者關掉燈箱、改個排序，
   * 它就會自己再跳出來。
   *
   * 找不到（照片被刪了、或不在這本相簿裡）就什麼都不做，不要跳錯誤 ——
   * 通知本來就可能比內容活得久。
   */
  /**
   * 關燈箱。**順手把網址上的 `?photo=` 拿掉** —— 那是通知點進來留下的深連結，
   * 留著的話重新整理又會被上面那段效果重新開一次燈箱（`deepLinkDone` 只擋得住
   * 同一次載入之內的重開，擋不住重整）。
   *
   * 用 `history.replaceState` 不用 router.replace：這裡只是要改網址列，不需要
   * 讓 Next 重跑一輪路由（會捲回頂端、也會讓整頁重畫）。
   */
  const closeLightbox = () => {
    setSelectedPhotoIndex(null);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("photo")) return;
    url.searchParams.delete("photo");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  };

  const deepLinkDone = useRef(false);
  useEffect(() => {
    if (deepLinkDone.current || loading || displayPhotos.length === 0) return;
    const want = Number(searchParams.get("photo"));
    if (!Number.isFinite(want) || want <= 0) return;
    deepLinkDone.current = true;
    const index = displayPhotos.findIndex((p) => p.id === want);
    if (index >= 0) {
      // 燈箱吃的是 displayPhotos 的索引，所以那一張也得在「已載入」的範圍內，
      // 否則往前翻幾張就撞到還沒 render 的區段
      setVisibleCount((prev) => Math.max(prev, index + 12));
      setSelectedPhotoIndex(index);
    }
  }, [loading, displayPhotos, searchParams]);

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

  /**
   * 右下角浮動鈕展開後的那串動作。`actions[0]` 貼著 FAB，所以最常用的「上傳照片」擺第一。
   * 原本「上傳照片」是一顆點了會再展開下拉選單的按鈕，收進 FabMenu 之後直接攤平成兩項。
   *
   * **兩組權限**：上傳那一組看 `canAddToAlbum`（別人的相簿也給），其餘（地點、
   * Drive、編輯照片）看 `canEditAlbum`。在別人的相簿裡就只剩上傳那一顆。
   */
  const buildFabActions = (): FabAction[] => {
    if (uploading || syncingGoogle) {
      // 上傳／匯入中：進度另有整條進度列，這裡只是別讓人以為按鈕不見了
      return [{
        key: 'busy',
        disabled: true,
        label: syncingGoogle
          ? (uploadProgress ? `匯入中... (${uploadProgress.current}/${uploadProgress.total})` : "準備 Google 相簿...")
          : (uploadProgress ? `上傳中... (${uploadProgress.current}/${uploadProgress.total})` : "上傳中..."),
      }];
    }

    const uploadActions: FabAction[] = !canAddToAlbum ? [] : [
      {
        key: 'upload',
        label: '上傳照片',
        // 兩種來源收成一扇門。展開四顆藥丸時「上傳照片」跟「從 Google 相簿匯入」
        // 並排，看起來像兩件不相干的事，其實只是同一件事的兩個來源
        children: [
          {
            key: 'local',
            label: '本機上傳',
            // 排在最貼近 FAB 的位置：Picker 會把 GPS 洗掉，本機上傳才留得住 EXIF，
            // 是預設該走的路
            title: '從這台裝置選檔案。EXIF（含 GPS）會完整保留',
            onClick: handleUploadClick,
          },
          {
            key: 'google',
            // 永遠是「匯入」，沒有「連結 Google 相簿」那一態 —— 人已經是用
            // Google 身分登入的，匯入就走他自己那份授權（後端換 token）
            label: '從 Google 相簿匯入',
            title: 'Google Picker 不會給位置資訊，匯入後要自己補地點',
            onClick: () => {
              // 絕對同步開啟空視窗取得權限，突破任何阻擋器
              const popup = window.open("", "GooglePicker", "width=1000,height=800,menubar=no,toolbar=no,location=no,status=no");
              if (popup) popup.document.write("<html><body style='font-family:sans-serif;text-align:center;margin-top:20%;'>載入 Google 相簿中...</body></html>");
              handleGoogleSync(popup);
            },
          },
        ],
      },
    ];

    const ownerActions: FabAction[] = !canEditAlbum ? [] : [
      {
        key: 'place',
        label: '地點',
        title: '整本相簿攤開，照日期看哪些照片還缺位置或地名',
        onClick: () => setShowPlaceCheckin(true),
      },
      // 頁面重整之後黃色橫幅就沒了，但沒備份的照片還在。這裡是它唯一的常駐入口
      {
        key: 'drive',
        label: '補傳 Drive',
        title: '重選原始檔，補上缺的 4K 與原始檔備份',
        onClick: () => setShowDriveBackfill(true),
      },
      { key: 'edit', label: '編輯照片', onClick: () => setIsEditingPhotos(true) },
    ];

    return [...uploadActions, ...ownerActions];
  };

  /**
   * Drive 失敗的統一記錄點。
   *
   * 分辨「要重新連結寫入帳號」跟「重試就好」是這裡唯一在做的事 ——
   * 前者給一顆會跳去 Google 的按鈕，後者給補傳。給一顆按了也沒用的按鈕
   * 比不給還糟。
   *
   * **絕對不自動跳轉。** 跳走會把記在記憶體裡的 File 全部弄丟（那批就再也
   * 補不回來，只能重選檔案），所以一律等使用者自己按。
   */
  const noteDriveFailure = (err: unknown) => {
    const needsLink = err instanceof DriveWriterError && err.reason !== 'failed';
    setDriveNeedsLink(needsLink);
    setDriveError(
      needsLink
        ? (err as DriveWriterError).reason === 'not_linked'
          ? '後端還沒有站長的 Drive 授權'
          : '站長的 Drive 授權失效了（被撤銷，或換過 Google OAuth 設定）'
        : err instanceof Error ? err.message : 'Google Drive 沒接上',
    );
  };

  /**
   * 黃色橫幅那顆按鈕：把剛上傳那批的 4K 與原始檔補上去。
   *
   * 不必請人重選檔案，也不必靠檔名對回照片 —— `pendingDriveBatch` 裡的照片 id
   * 是上傳當下後端回傳的，配對不可能錯。只有重整過頁面（File 沒了）才退回
   * 「補傳 Drive」那條重選檔案的路。
   */
  const handleBackfillCurrentBatch = async () => {
    if (driveBatchProgress || !id) return;
    if (pendingDriveBatch.length === 0) {
      setShowDriveBackfill(true);
      return;
    }

    const batch = pendingDriveBatch;
    setDriveBatchProgress({ current: 0, total: batch.length });

    let drive: { folderId: string; token: string };
    try {
      const folders = await ensureDriveFolders();
      drive = { folderId: await ensureAlbumFolder(folders, Number(id)), token: folders.token };
    } catch (err) {
      console.warn('Drive 連結失敗', err);
      setDriveBatchProgress(null);
      noteDriveFailure(err);
      return;
    }

    // 沒補成功的留在佇列裡，按鈕可以再按一次；成功的不要重傳，會在 Drive 上留兩份
    const stillMissing: { photoId: number; file: File }[] = [];
    for (let i = 0; i < batch.length; i++) {
      setDriveBatchProgress({ current: i + 1, total: batch.length });
      try {
        if (!(await pushPhotoToDrive(drive, batch[i].photoId, batch[i].file))) stillMissing.push(batch[i]);
      } catch (err) {
        console.warn(`照片 ${batch[i].photoId} 補傳失敗`, err);
        stillMissing.push(batch[i]);
      }
    }

    setDriveBatchProgress(null);
    setPendingDriveBatch(stillMissing);
    if (stillMissing.length === 0) setDriveNeedsLink(false);
    setDriveError(stillMissing.length > 0 ? `還有 ${stillMissing.length} 張沒補成功，可以再按一次` : null);
    await loadData();
  };

  /*
   * 先把 Drive 準備好（必要時建資料夾），一批只做一次。
   *
   * 寫入用的 token 是跟後端換的（不是登入者自己的），所以這裡不會有任何彈窗，
   * 也不會在上傳中途跳走 —— 跳走的話使用者選好的檔案會全沒。
   *
   * 沒接上**不擋上傳** —— 照片只要 R2 的縮圖成功就算存在，Drive 是加分項。
   * drive_file_id 留 NULL，之後用「補傳 Drive」補。
   */
  const prepareDrive = async (): Promise<{ folderId: string; token: string } | null> => {
    try {
      const folders = await ensureDriveFolders();
      // 照片放進這本相簿自己的資料夾，不是 didadida/ 根目錄
      const folderId = await ensureAlbumFolder(folders, Number(id));
      setDriveNeedsLink(false);
      setDriveError(null);
      return { folderId, token: folders.token };
    } catch (err) {
      console.warn('Drive 沒接上，這批照片只會有 R2 的版本', err);
      noteDriveFailure(err);
      return null;
    }
  };

  /** 佇列走完：收拾狀態、重抓資料，該補地點的再問一次 */
  const finishDuplicateQueue = async () => {
    duplicateItems.forEach((d) => URL.revokeObjectURL(d.previewUrl));
    setDuplicateItems([]);
    setDuplicateIndex(0);
    const uploaded = dupUploadedRef.current;
    dupUploadedRef.current = [];
    if (uploaded.length === 0) return;
    await loadData();
    if (uploaded.some((p) => p.lat === null || p.lng === null)) {
      setPostUploadIds(uploaded.map((p) => p.id));
    }
  };

  const advanceDuplicate = async () => {
    if (duplicateIndex + 1 < duplicateItems.length) setDuplicateIndex(duplicateIndex + 1);
    else await finishDuplicateQueue();
  };

  /**
   * 重複視窗按下確認：`keep_both` 是兩張都留，`replace` 是傳新的、再刪掉勾選的舊照片。
   *
   * **一定要先上傳成功才刪。** 反過來的話上傳失敗就變成舊的也沒了、新的也沒進來，
   * 使用者以為只是取代一下，結果照片憑空消失。
   */
  const resolveDuplicate = async (decision: 'keep_both' | 'replace', replaceIds?: number[]) => {
    const item = duplicateItems[duplicateIndex];
    if (!id || !item || duplicateBusy) return;

    setDuplicateBusy(true);
    try {
      const result = await uploadPhoto(id, item.resized, item.exifData, item.takenAt, true);
      if (result.status !== 'ok') {
        alert('這張上傳失敗，先跳過。');
        return;
      }
      dupUploadedRef.current.push(result.photo);

      // Drive 沿用整批那次的授權；沒有就記進待補清單，跟一般上傳一樣
      if (driveRef.current) {
        try {
          await pushPhotoToDrive(driveRef.current, result.photo.id, item.file);
        } catch (err) {
          console.warn('新照片沒送上 Drive', err);
          setPendingDriveBatch((prev) => [...prev, { photoId: result.photo.id, file: item.file }]);
        }
      } else {
        setPendingDriveBatch((prev) => [...prev, { photoId: result.photo.id, file: item.file }]);
      }

      if (decision === 'replace' && replaceIds && replaceIds.length > 0) {
        // 刪除端點自己會處理 R2 的檔與 Drive 的待搬佇列，這裡不用另外收尾
        const failed = (await Promise.all(replaceIds.map((pid) => deletePhoto(pid))))
          .filter((ok) => !ok).length;
        if (failed > 0) alert(`新照片已上傳，但有 ${failed} 張舊照片沒刪掉。`);
      }
    } catch (err) {
      console.error(err);
      alert('處理這張時出錯了，先跳過。');
    } finally {
      setDuplicateBusy(false);
      await advanceDuplicate();
    }
  };

  /**
   * 一張待匯入的照片。**檔案是延後載入的**（`load()`）—— Google 匯入一批可能幾十張，
   * 先全部抓下來等於把整批原始檔一起壓在記憶體裡，這樣一次只留手上這一張。
   */
  type IngestSource = { name: string; load: () => Promise<File> };

  type IngestResult = {
    uploaded: UploadedPhoto[];
    dupes: PendingDuplicate[];
    allSuccess: boolean;
    reauth: GoogleReauthError | null;
  };

  /**
   * 匯入管線。**本機選檔與 Google 相簿匯入走的是同一條**：
   * 縮成 2000px → `uploadPhoto`（後端產 800／400 縮圖進 R2）→ 4K 與原始檔送 Drive。
   *
   * Google 那條以前是後端自己另做一套（把原始檔整個塞進 R2、沒有縮圖、也沒進 Drive），
   * 2026-08-21 併掉了 —— 同一件事沒有理由做出兩種結果，而且那一套還在啃 R2 額度。
   *
   * 重複與 Drive 失敗都**不中斷整批**：重複的留到最後統一問，Drive 失敗記進待補清單。
   * 只有 Google 授權沒了會停下來 —— 後面每一張都會是同一個錯，跑完只是白等。
   */
  const ingestSources = async (
    sources: IngestSource[],
    onProgress: (current: number, total: number, name: string) => void,
  ): Promise<IngestResult> => {
    const total = sources.length;
    const uploaded: UploadedPhoto[] = [];
    // Drive 沒接上時，把「哪張照片配哪個原始檔」留下來給橫幅那顆按鈕用
    const missedDrive: { photoId: number; file: File }[] = [];
    // 後端判定跟相簿裡撞了的那幾張。**它們一個位元組都還沒寫進去**，跑完再統一問
    const dupes: PendingDuplicate[] = [];
    let allSuccess = true;
    let reauth: GoogleReauthError | null = null;

    const drive = await prepareDrive();
    // 重複那幾張稍後才決定要不要傳，那時不該再跑一次 bootstrap，沿用這批的位置
    driveRef.current = drive;

    for (let i = 0; i < total; i++) {
      const source = sources[i];
      onProgress(i + 1, total, source.name);
      try {
        const rawFile = await source.load();
        // 縮圖處理 (長邊不超過 2000px)
        const { file, exifData, takenAt } = await resizeImageFile(rawFile, 2000);
        const result = await uploadPhoto(id as string, file, exifData, takenAt || undefined);
        if (result.status === 'ok') {
          uploaded.push(result.photo);
          // 4K 與原始檔送 Drive。任何一步失敗都只是少一份備份，照片已經存在了
          if (drive) await pushPhotoToDrive(drive, result.photo.id, rawFile);
          else missedDrive.push({ photoId: result.photo.id, file: rawFile });
        } else if (result.status === 'duplicate') {
          // 縮好的 file 一起留著：使用者若選「照樣上傳」，不必再解一次圖
          dupes.push({
            key: `${Date.now()}-${i}-${source.name}`,
            file: rawFile, resized: file, previewUrl: URL.createObjectURL(rawFile),
            exifData, takenAt: takenAt || undefined,
            reason: result.reason, existing: result.existing,
          });
        } else {
          allSuccess = false;
        }
      } catch (err) {
        if (err instanceof GoogleReauthError) { reauth = err; break; }
        console.error(err);
        allSuccess = false;
      }
    }

    // 累加而不是覆蓋：連傳兩批都沒接上 Drive 時，第一批不該被第二批洗掉
    if (missedDrive.length > 0) setPendingDriveBatch((prev) => [...prev, ...missedDrive]);

    return { uploaded, dupes, allSuccess, reauth };
  };

  /** 匯入收尾。視窗順序是固定的：重複清單疊在補地點上面，先決定要不要傳 */
  const finishIngest = async (result: IngestResult) => {
    if (result.reauth) setGoogleReauth(result.reauth.message);
    else if (!result.allSuccess) alert("部分或全部照片上傳失敗，請稍後再試。");

    await loadData(); // 重新整理照片。要 await，補件視窗才拿得到縮圖

    // 這批只要有任何一張沒有 EXIF 座標就跳出補件視窗；全部都有 GPS 的話不打擾。
    if (result.uploaded.some((p) => p.lat === null || p.lng === null)) {
      setPostUploadIds(result.uploaded.map((p) => p.id));
    }
    if (result.dupes.length > 0) setDuplicateItems(result.dupes);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!id) return;
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    const result = await ingestSources(
      Array.from(files).map((f) => ({ name: f.name, load: async () => f })),
      (current, total, fileName) => setUploadProgress({ current, total, fileName }),
    );
    await finishIngest(result);
    setUploading(false);
    setUploadProgress(null);

    // reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  /**
   * 從 Google 相簿匯入。
   *
   * **不會跳去 Google 要授權** —— 使用者本來就是用 Google 身分登入的，後端手上
   * 有他自己的 refresh token（migrations/0017），Picker 與取檔都由後端當場換票。
   * 只有那份授權被使用者自己收回時後端才回 409，那時才出現重新登入的入口。
   */
  const handleGoogleSync = async (popup: Window | null) => {
    try {
      // 立刻將 UI 設為載入鎖定狀態，避免異步建立 Session 期間 UI 切回
      setSyncingGoogle(true);
      setUploadProgress(null);
      setGoogleReauth(null);

      // 每次匯入都必須建立新的 Google Picker Session (舊 Session 無法重複選照片)
      const session = await createGooglePickerSession();
      if (!session || (session as any).error || !session.pickerUri) {
        alert("無法建立 Google Picker，請稍後再試。");
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
      /*
       * 使用者直接按 X 關掉選相片的視窗＝取消。**不能一看到 closed 就收工** ——
       * pickerUri 後面接的 `/autoclose` 就是要 Google 在選完之後自己關掉那個視窗，
       * 所以「視窗關了」同時是「取消」與「選完了」的樣子。差別只在 session 會不會
       * 變 ready —— 先關窗、下一瞬間才 ready 的順序也真的會發生。
       *
       * 所以看到關掉只先記時間，寬限期內照常輪詢，撐過去還沒 ready 才當作取消。
       * 取消不彈任何東西：是他自己關的，跳一個「已取消」只是多一次點擊。
       *
       * popup 被瀏覽器擋掉時是 null，這條就整個不成立，退回原本的 10 分鐘逾時。
       */
      let popupClosedAt = 0;
      const PICKER_CLOSE_GRACE_MS = 1500;

      const pollTimer = setInterval(async () => {
        if (photosProcessingStarted) {
          return;
        }

        // 如果超過 10 分鐘，自動中斷
        if (Date.now() - startTime > 10 * 60 * 1000) {
          clearInterval(pollTimer);
          photosProcessingStarted = true;
          setSyncingGoogle(false);
          alert("同步逾時，已自動取消。");
          return;
        }

        // 這裡在 interval 裡面，丟出去沒人接得到（會變成 unhandled rejection，
        // 而且輪詢還會繼續跑），所以每一輪自己收乾淨
        let res: { ready: boolean; mediaItems?: any[] };
        try {
          res = await fetchGooglePickerPhotos(session!.id!);
        } catch (err) {
          clearInterval(pollTimer);
          photosProcessingStarted = true;
          setSyncingGoogle(false);
          if (err instanceof GoogleReauthError) setGoogleReauth(err.message);
          else console.error(err);
          return;
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

          /*
           * Picker 回的是一串「照片在 Google 上的位置」，位元組還沒動。
           * 取檔要繞後端（`fetchGoogleMediaFile`）：baseUrl 在
           * lh3.googleusercontent.com 上、要帶 Authorization，而那個網域不回
           * CORS preflight，瀏覽器自己抓一定失敗。
           */
          const sources: IngestSource[] = [];
          for (const item of res.mediaItems) {
            const baseUrl = item.mediaFile?.baseUrl || item.baseUrl;
            const filename = item.mediaFile?.filename || item.filename || item.id + ".jpg";
            const mimeType: string = item.mediaFile?.mimeType || item.mimeType || '';
            // Picker 也選得到影片，這個站只收照片
            if (!baseUrl || (mimeType && !mimeType.startsWith('image/'))) {
              console.warn("跳過非照片或沒有下載連結的項目:", item);
              continue;
            }
            // Picker 把時間放在 mediaItem.createTime，舊回應在 mediaMetadata 底下
            const creationTime = item.createTime
              || item.mediaFile?.mediaFileMetadata?.creationTime
              || item.mediaMetadata?.creationTime;
            sources.push({
              name: filename,
              load: () => fetchGoogleMediaFile(baseUrl, filename, creationTime),
            });
          }

          if (sources.length === 0) {
            setSyncingGoogle(false);
            setUploadProgress(null);
            return;
          }

          /*
           * **進度回報跟本機上傳共用同一份 `uploadProgress`**，畫的也是同一條
           * 進度列。以前這裡另外記一份 `syncProgress`，只餵得起 FAB 上那行
           * 「匯入中 (x/y)」—— 於是同一條管線（ingestSources）跑起來，本機那條
           * 有進度列、Google 這條沒有，看起來像卡住。
           */
          const result = await ingestSources(
            sources,
            (current, total, fileName) => setUploadProgress({ current, total, fileName }),
          );
          setSyncingGoogle(false);
          setUploadProgress(null);
          await finishIngest(result);
        }
      }, 2000);

      /*
       * 關窗偵測**獨立成一支 400ms 的小哨兵**，不跟 2 秒那支狀態輪詢共用一拍 ——
       * 共用的話「發現關窗」本身就要先等最多 2 秒，再加寬限期，按下 X 之後右下角
       * 要卡上快十秒才回得來，用起來跟沒修一樣。
       *
       * 寬限期到了還分不出是取消還是選完，就自己問最後一次狀態：ready 代表他是
       * 選完才關的，原樣交還給狀態輪詢（下一拍 ≤2 秒就接手）；不 ready 才是取消。
       */
      const closeWatcher = setInterval(async () => {
        if (photosProcessingStarted) { clearInterval(closeWatcher); return; }
        if (!popup || !popup.closed) return;
        if (!popupClosedAt) { popupClosedAt = Date.now(); return; }
        if (Date.now() - popupClosedAt < PICKER_CLOSE_GRACE_MS) return;
        clearInterval(closeWatcher);
        try {
          const last = await fetchGooglePickerPhotos(session!.id!);
          if (last.ready) return;
        } catch (e) { /* 問不到就當取消，反正窗已經關了 */ }
        if (photosProcessingStarted) return;
        clearInterval(pollTimer);
        photosProcessingStarted = true;
        setSyncingGoogle(false);
        setUploadProgress(null);
      }, 400);
    } catch (err) {
      console.error(err);
      setSyncingGoogle(false);
      setUploadProgress(null);
      popup?.close();
      if (err instanceof GoogleReauthError) setGoogleReauth(err.message);
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
    if (!canReorderPhotos) return;
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
              {canEditAlbum && (
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
          {/* 管理用的按鈕都收進右下角的 FabMenu，頁首只留搜尋與篩選 */}
          {canAddToAlbum && (
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: 'none' }}
              accept="image/jpeg, image/png, image/webp, image/heic, image/heif"
              multiple
              onChange={handleFileChange}
            />
          )}
        </div>
      </div>
      
      {/*
        * Google 那半邊的授權掉了 —— 使用者自己在 Google 帳號設定裡收回權限，
        * 或改過密碼。**這是站上唯一還會把人帶去 Google 的入口**：平常匯入用的是
        * 後端存的 refresh token，按下去不跳轉、頁面狀態也不會沒。
        *
        * 站上的身分沒事（後端回的是 409 不是 401），所以只講 Google 這一半，
        * 不要說成「請重新登入」讓人以為整個站把他踢出去了。
        */}
      {googleReauth && (
        <div style={{
          margin: '10px 0', padding: '10px 14px', borderRadius: 8,
          background: '#fee2e2', border: '1px solid #fca5a5', color: '#7f1d1d',
          fontSize: 13.5, lineHeight: 1.7,
        }}>
          <strong>Google 相簿匯入需要重新授權</strong>（{googleReauth}）
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              onClick={() => { window.location.href = googleLoginUrl(id ?? undefined); }}
              style={{
                padding: '7px 14px', borderRadius: 7, border: 'none',
                background: '#b91c1c', color: '#fff', fontSize: 13.5, cursor: 'pointer',
              }}
            >
              用 Google 重新登入
            </button>
          </div>
        </div>
      )}

      {/*
        * Drive 沒接上要講出來，不能只寫進 console。照片是傳成功了，但少了 4K 與
        * 原始檔備份 —— 使用者以為備份好了才是真正的問題。
        *
        * 橫幅裡那顆按鈕分兩種情況：只是暫時沒接上就直接補傳剛才那批；
        * 後端根本沒有站長的 Drive 授權（driveNeedsLink）就連按都不給按 ——
        * 那份授權只有站長重新用 Google 登入一次才補得回來。
        */}
      {isAdmin && driveError && (
        <div style={{
          margin: '10px 0', padding: '10px 14px', borderRadius: 8,
          background: '#fef3c7', border: '1px solid #fcd34d', color: '#78350f',
          fontSize: 13.5, lineHeight: 1.7,
        }}>
          照片已經上傳，但 <strong>Google Drive 沒接上</strong>（{driveError}），
          這批只有 R2 的版本，缺 4K 與原始檔備份。
          {driveBatchProgress ? (
            <div style={{ marginTop: 8 }}>
              補傳中... {driveBatchProgress.current} / {driveBatchProgress.total}
            </div>
          ) : driveNeedsLink ? (
            /*
             * 備份用的是**站長的** Drive 授權，所以這裡分兩種人：
             *
             * 站長自己 → 給按鈕。他用 Google 登入一次，後端就會把授權收回來
             *   （`User.google_refresh_token`）。這是站上唯一補得回來的路。
             * 其他人   → 不給按鈕。按什麼都補不上，給一顆按了也沒用的按鈕比不給還糟。
             *
             * ⚠️ 按下去會離開這一頁，記在記憶體裡的 File 就沒了 —— 所以話要講在
             * 前面：回來之後這批要用「補傳 Drive」重選檔案。**不自動跳轉。**
             */
            isOwner ? (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 13, marginBottom: 8 }}>
                  用 Google 登入一次就會把授權收回來。這批照片要回來之後用
                  「補傳 Drive」重選檔案補上（離開這一頁會忘記剛才選了哪些）。
                </div>
                <button
                  type="button"
                  onClick={() => { window.location.href = googleLoginUrl(id ?? undefined); }}
                  style={{
                    padding: '7px 14px', borderRadius: 7, border: 'none',
                    background: '#b45309', color: '#fff', fontSize: 13.5, cursor: 'pointer',
                  }}
                >
                  用 Google 重新登入
                </button>
              </div>
            ) : (
              <div style={{ marginTop: 8, fontSize: 13 }}>
                這要站長處理：請站長用 Google 登入一次，後端會自己把授權收回來。
                之後回到這裡用「補傳 Drive」重選這批檔案就補得上。
              </div>
            )
          ) : (
            <div style={{ marginTop: 8 }}>
              {/* Drive 用的是後端換來的站長寫入 token，跟按下去的人是誰無關，
                  所以這裡不必先去登入什麼 —— 重試就好 */}
              <button
                type="button"
                onClick={handleBackfillCurrentBatch}
                style={{
                  padding: '7px 14px', borderRadius: 7, border: 'none',
                  background: '#b45309', color: '#fff', fontSize: 13.5, cursor: 'pointer',
                }}
              >
                {pendingDriveBatch.length > 0
                  ? `補傳這批（${pendingDriveBatch.length} 張）`
                  : '補傳 Drive'}
              </button>
            </div>
          )}
        </div>
      )}

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
              draggable={canReorderPhotos && longPressIndex === index && sortBy === "custom"}
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
                if (canReorderPhotos && sortBy === "custom") handleDragStart(index);
              }}
              onDragEnter={() => canReorderPhotos && sortBy === "custom" && handleDragEnter(index)}
              onDragEnd={canReorderPhotos && sortBy === "custom" ? handleDragEnd : undefined}
              onDragOver={(e) => canReorderPhotos && sortBy === "custom" && e.preventDefault()}
            >
              {canEditAlbum && isEditingPhotos && (
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
                src={photoThumbSrc(photo, 'md')}
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
          /*
           * 燈箱是**逐張**判斷，不是看整本相簿：我放進別人相簿的那幾張，
           * 後端本來就讓我改讓我刪（actorOwns 看 uploaded_by），
           * 這裡跟著給，不然自己傳的照片打錯字都改不了。
           */
          isAdmin={canEdit(displayPhotos[selectedPhotoIndex])}
          availableTags={availableTags}
          onClose={closeLightbox}
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

      {/* 右下角浮動操作鈕。編輯模式下交棒給底部動作列，所以這裡給空陣列 */}
      <FabMenu
        actions={(!canEditAlbum && !canAddToAlbum) || isEditingPhotos ? [] : buildFabActions()}
      />

      {/* 底部動作列 (編輯模式) */}
      {isEditingPhotos && (
        <BottomActionBar className={pageStyles.actionBar}>
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
            className={pageStyles.actionButton}
            onClick={() => setShowFixTime(true)}
            disabled={selectedPhotos.length === 0}
            style={{ opacity: selectedPhotos.length === 0 ? 0.5 : 1 }}
          >
            🕒 修正時間
          </button>

          <button
            className={`${pageStyles.actionButton} ${selectedPhotos.length > 0 ? pageStyles.danger : ''}`}
            onClick={() => setShowDeleteConfirm(true)}
            disabled={selectedPhotos.length === 0 || isBatchDeleting}
            style={{ opacity: selectedPhotos.length === 0 ? 0.5 : 1 }}
          >
            {isBatchDeleting ? '刪除中...' : `刪除 ${selectedPhotos.length} 個項目`}
          </button>

          {/* 「編輯／完成」的切換鈕原本在頁首，編輯模式下 FAB 收起，出口就放在這排的尾端 */}
          <button
            className={`${pageStyles.actionButton} ${pageStyles.primary}`}
            onClick={() => {
              setIsEditingPhotos(false);
              setSelectedPhotos([]);
            }}
          >
            完成
          </button>
        </BottomActionBar>
      )}

      {/* Slide Confirm Modal */}
      <SlideConfirmModal 
        isOpen={showDeleteConfirm}
        title="確認刪除"
        message={`確定要刪除選取的 ${selectedPhotos.length} 張照片嗎？此動作無法復原。`}
        onConfirm={handleBatchDeletePhotos}
        onCancel={() => setShowDeleteConfirm(false)}
      />

      {/* 上傳後的補件關卡。自己不寫入任何東西，只負責挑出要處理的照片後轉交下面兩個 modal */}
      <PostUploadReviewModal
        isOpen={postUploadIds.length > 0}
        photos={photos.filter((p) => postUploadIds.includes(p.id))}
        onClose={() => setPostUploadIds([])}
        onAssignPlace={(ids) => {
          setSelectedPhotos(ids);
          setPostUploadIds([]);
          setShowAssignPlace(true);
        }}
        onFixTime={(ids) => {
          setSelectedPhotos(ids);
          setPostUploadIds([]);
          setShowFixTime(true);
        }}
      />

      {/*
        本機上傳撞到重複：一張一張問，跟 Google 匯入用同一個視窗、同一套選項
        （全部保留／勾選要被取代的舊照片，可複選）。疊在補件視窗上面，先處理這個。
      */}
      {duplicateItems[duplicateIndex] && (
        <GoogleSyncConflictModal
          isOpen={true}
          tempPhoto={{ url: duplicateItems[duplicateIndex].previewUrl }}
          existingPhotos={duplicateItems[duplicateIndex].existing.map((e) => ({
            id: e.id,
            url: e.thumb_url || '',
            taken_at: e.taken_at || undefined,
          }))}
          onResolve={(decision, replaceIds) => { resolveDuplicate(decision, replaceIds); }}
          onSkip={() => { if (!duplicateBusy) advanceDuplicate(); }}
          counter={{ current: duplicateIndex + 1, total: duplicateItems.length }}
          busy={duplicateBusy}
        />
      )}

      {/* 補傳 Drive：重選原始檔，把缺的 4K 與原始檔補上去 */}
      <DriveBackfillModal
        isOpen={showDriveBackfill}
        albumId={id ? Number(id) : undefined}
        onClose={() => setShowDriveBackfill(false)}
        onDone={async () => {
          // 補完了就把橫幅收掉，不然它會一直宣稱備份沒做
          setDriveError(null);
          await loadData();
        }}
      />


      {/* 相簿層級的打卡補件。同樣不自己寫座標，挑完照片交給下面的 AssignPlaceModal */}
      <PlaceCheckinModal
        isOpen={showPlaceCheckin}
        albumId={id ? Number(id) : undefined}
        photos={photos}
        onClose={() => setShowPlaceCheckin(false)}
        onRefresh={loadData}
        onAssignPlace={(ids) => {
          setSelectedPhotos(ids);
          setShowPlaceCheckin(false);
          setReturnToCheckin(true);
          setShowAssignPlace(true);
        }}
      />

      <AssignPlaceModal
        isOpen={showAssignPlace}
        photoIds={selectedPhotos}
        albumId={id ? Number(id) : undefined}
        onClose={() => {
          setShowAssignPlace(false);
          // 取消：原路退回，什麼都沒改，不用重抓
          if (returnToCheckin) { setReturnToCheckin(false); setShowPlaceCheckin(true); }
        }}
        onDone={async ({ updated, skippedExif }) => {
          setShowAssignPlace(false);
          setSelectedPhotos([]);
          lastSelectedIndexRef.current = null;
          // 一定要等重抓完才決定下一步：不等的話跳回打卡畫面看到的是舊資料，
          // 剛指定好的那批還會掛在「沒有位置」底下
          const fresh = await loadData();
          const skipped = skippedExif > 0 ? `，${skippedExif} 張已有 GPS 未覆蓋` : '';

          if (!returnToCheckin) {
            alert(`已為 ${updated} 張照片指定地點${skipped}`);
            return;
          }

          setReturnToCheckin(false);
          // 打卡畫面上還有事可做嗎？缺座標、或有座標但沒地名，都算還沒完
          const left = fresh.filter(
            (p) => p.lat == null || p.lng == null || !p.place_name?.trim(),
          ).length;
          if (left > 0) {
            alert(`已為 ${updated} 張照片指定地點${skipped}，還有 ${left} 張要處理`);
            setShowPlaceCheckin(true);
          } else {
            alert(`已為 ${updated} 張照片指定地點${skipped}。這本相簿都有位置與地名了 🎉`);
          }
        }}
      />

      <FixTimeModal
        isOpen={showFixTime}
        photoIds={selectedPhotos}
        onClose={() => setShowFixTime(false)}
        onDone={({ updated, skippedNoTime, what }) => {
          setSelectedPhotos([]);
          lastSelectedIndexRef.current = null;
          loadData();
          const skipped = skippedNoTime > 0 ? `，${skippedNoTime} 張沒有拍攝時間未處理` : '';
          alert(`已為 ${updated} 張照片${what}${skipped}`);
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
