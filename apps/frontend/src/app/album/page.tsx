"use client";

import { useEffect, useState, useRef, Suspense, useMemo } from "react";
import styles from "./album.module.css";
import pageStyles from "../page.module.css";
import Link from "next/link";
import { Photo, Tag, fetchPhotos, uploadPhoto, fetchAlbum, deletePhoto, reorderPhotos, fetchTags, updateAlbum, Album, createGooglePickerSession, fetchGooglePickerPhotos, syncGooglePhoto, resolveGooglePhotoConflict, photoThumbSrc, getGoogleToken, googleLoginUrl, driveWriterLoginUrl, DriveWriterError, type UploadedPhoto, type DuplicateMatch } from "@/lib/api";
import { ensureAlbumFolder, ensureDriveFolders, prewarmDrive, pushPhotoToDrive, resetDriveWriterToken } from "@/lib/drive";
import { useAdmin } from "@/lib/useAdmin";
import SlideConfirmModal from "@/components/SlideConfirmModal";
import GoogleSyncConflictModal from "@/components/GoogleSyncConflictModal";
import AssignPlaceModal from "@/components/AssignPlaceModal";
import FixTimeModal from "@/components/FixTimeModal";
import PostUploadReviewModal from "@/components/PostUploadReviewModal";
import PlaceCheckinModal from "@/components/PlaceCheckinModal";
import DriveBackfillModal from "@/components/DriveBackfillModal";
import DriveAccessModal from "@/components/DriveAccessModal";
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
  const { isAdmin, driveLink, canEdit } = useAdmin();
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
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState<number | null>(null);
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [visibleCount, setVisibleCount] = useState<number>(24);
  const [uploadProgress, setUploadProgress] = useState<{current: number, total: number, fileName: string} | null>(null);
  const [hasGoogleToken, setHasGoogleToken] = useState(false);
  /** Drive 沒接上時的原因。照片照樣傳得上去，只是少了 4K 與原始檔備份 */
  const [driveError, setDriveError] = useState<string | null>(null);
  const [showDriveBackfill, setShowDriveBackfill] = useState(false);
  const [showDriveAccess, setShowDriveAccess] = useState(false);
  /**
   * 這次失敗是不是「Drive 寫入帳號沒接上」——沒連結過，或存著的授權過期了。
   *
   * 這種要跳去 Google 重新連結一次，跟一般的上傳失敗（重試就好）完全兩回事，
   * 按鈕的行為也不同，所以分開記。
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
     * 這裡只是問一句「手上那個 Google token 還能用嗎」—— 它同時是相簿匯入
     * 與 Drive 備份的憑證，登入時一起拿到的。
     */
    if (typeof window !== "undefined") {
      setHasGoogleToken(!!getGoogleToken());
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
   */
  const buildFabActions = (): FabAction[] => {
    if (uploading || syncingGoogle) {
      // 上傳／匯入中：進度另有整條進度列，這裡只是別讓人以為按鈕不見了
      return [{
        key: 'busy',
        disabled: true,
        label: syncingGoogle
          ? (syncProgress ? `匯入中... (${syncProgress.current}/${syncProgress.total})` : "準備 Google 相簿...")
          : (uploadProgress ? `上傳中... (${uploadProgress.current}/${uploadProgress.total})` : "上傳中..."),
      }];
    }

    return [
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
            label: hasGoogleToken ? '從 Google 相簿匯入' : '連結 Google 相簿',
            title: 'Google Picker 不會給位置資訊，匯入後要自己補地點',
            onClick: () => {
              let popup: Window | null = null;
              if (hasGoogleToken) {
                // 絕對同步開啟空視窗取得權限，突破任何阻擋器
                popup = window.open("", "GooglePicker", "width=1000,height=800,menubar=no,toolbar=no,location=no,status=no");
                if (popup) popup.document.write("<html><body style='font-family:sans-serif;text-align:center;margin-top:20%;'>載入 Google 相簿中...</body></html>");
              }
              handleGoogleSync(null, popup);
            },
          },
        ],
      },
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
      // 連結寫入帳號的常駐入口，順便是「到底卡在哪一步」的診斷
      {
        key: 'drive-access',
        label: 'Drive 寫入帳號',
        title: '連結／重新連結備份用的 Google 帳號，並逐項檢查存取狀況',
        onClick: () => setShowDriveAccess(true),
      },
      { key: 'edit', label: '編輯照片', onClick: () => setIsEditingPhotos(true) },
    ];
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
          ? '還沒連結 Drive 寫入帳號'
          : 'Drive 寫入帳號的授權過期了（同意畫面還在測試中的話只有 7 天）'
        : err instanceof Error ? err.message : 'Google Drive 沒接上',
    );
  };

  /*
   * 剛從「連結 Drive 寫入帳號」跳轉回來。
   *
   * 成功就只是把狀態清乾淨（連結前那批照片的 File 早在跳轉時就沒了，
   * 要補得走「補傳 Drive」重選檔案，這裡不假裝能自動處理）。
   * 失敗最常見的是 Google 不再發第二張 refresh token，訊息要直接講怎麼解。
   *
   * 兩種情況都要丟掉這一頁的舊 token —— 換了帳號的話，抱著舊的會一路 404。
   */
  useEffect(() => {
    if (!driveLink) return;
    resetDriveWriterToken();
    if (driveLink.error) {
      setDriveNeedsLink(true);
      setDriveError(
        driveLink.error === 'no_refresh_token'
          ? 'Google 沒有給長期授權 —— 到「Google 帳號 → 安全性 → 你的第三方應用程式」把這個網站的存取權移除，再連結一次'
          : `連結失敗（${driveLink.error}）`,
      );
      return;
    }
    setDriveNeedsLink(false);
    setDriveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driveLink]);

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

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!id) return;
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    let allSuccess = true;
    const total = files.length;
    const uploaded: UploadedPhoto[] = [];
    // Drive 沒接上時，把「哪張照片配哪個原始檔」留下來給橫幅那顆按鈕用
    const missedDrive: { photoId: number; file: File }[] = [];
    // 後端判定跟相簿裡撞了的那幾張。**它們一個位元組都還沒寫進去**，跑完再統一問
    const dupes: PendingDuplicate[] = [];

    const drive = await prepareDrive();
    // 重複那幾張稍後才決定要不要傳，那時不該再跑一次 bootstrap，沿用這批的位置
    driveRef.current = drive;

    for (let i = 0; i < total; i++) {
      const rawFile = files[i];
      setUploadProgress({ current: i + 1, total, fileName: rawFile.name });
      try {
        // 縮圖處理 (長邊不超過 2000px)
        const { file, exifData, takenAt } = await resizeImageFile(rawFile, 2000);
        const result = await uploadPhoto(id, file, exifData, takenAt || undefined);
        if (result.status === 'ok') {
          uploaded.push(result.photo);
          // 4K 與原始檔送 Drive。任何一步失敗都只是少一份備份，照片已經存在了
          if (drive) await pushPhotoToDrive(drive, result.photo.id, rawFile);
          else missedDrive.push({ photoId: result.photo.id, file: rawFile });
        } else if (result.status === 'duplicate') {
          // 縮好的 file 一起留著：使用者若選「照樣上傳」，不必再解一次圖
          dupes.push({
            key: `${Date.now()}-${i}-${rawFile.name}`,
            file: rawFile, resized: file, previewUrl: URL.createObjectURL(rawFile),
            exifData, takenAt: takenAt || undefined,
            reason: result.reason, existing: result.existing,
          });
        } else {
          allSuccess = false;
        }
      } catch (err) {
        console.error(err);
        allSuccess = false;
      }
    }

    // 累加而不是覆蓋：連傳兩批都沒接上 Drive 時，第一批不該被第二批洗掉
    if (missedDrive.length > 0) setPendingDriveBatch((prev) => [...prev, ...missedDrive]);

    if (!allSuccess) {
      alert("部分或全部照片上傳失敗，請稍後再試。");
    }

    await loadData(); // 重新整理照片。要 await，補件視窗才拿得到縮圖
    setUploading(false);
    setUploadProgress(null);

    // 這批只要有任何一張沒有 EXIF 座標就跳出補件視窗；全部都有 GPS 的話不打擾。
    if (uploaded.some((p) => p.lat === null || p.lng === null)) {
      setPostUploadIds(uploaded.map((p) => p.id));
    }
    // 重複清單疊在補件視窗上面：先決定要不要傳，關掉之後才輪到補地點
    if (dupes.length > 0) setDuplicateItems(dupes);

    // reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleGoogleSync = async (initialSession: any, popup: Window | null) => {
    try {
      if (!hasGoogleToken) {
        // 沒 token 就是還沒登入（或登入過期）。這個 token 只給 Google 相簿匯入用，
        // Drive 備份走的是另一套（後端的寫入帳號）
        window.location.href = googleLoginUrl(id ?? undefined);
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
    if (!canEditAlbum) return;
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
          {canEditAlbum && (
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
        * Drive 沒接上要講出來，不能只寫進 console。照片是傳成功了，但少了 4K 與
        * 原始檔備份 —— 使用者以為備份好了才是真正的問題。
        *
        * 橫幅裡那顆按鈕分兩種情況：手上還有 Google token 就直接補傳剛才那批；
        * token 過期就只能先去登入 —— 跳轉會把記在記憶體裡的 File 弄丟，
        * 所以標籤要講清楚回來之後得走「補傳 Drive」重選檔案那條路。
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
            // 連結是整頁跳轉，會把記憶體裡的 File 弄丟，所以要先講清楚回來要做什麼
            <div style={{ marginTop: 8 }}>
              <a
                href={driveWriterLoginUrl(id ?? undefined)}
                style={{
                  display: 'inline-block', padding: '7px 14px', borderRadius: 7,
                  background: '#b45309', color: '#fff', fontSize: 13.5, textDecoration: 'none',
                }}
              >
                連結 Drive 寫入帳號（回來後用「補傳 Drive」重選檔案）
              </a>
            </div>
          ) : (
            <div style={{ marginTop: 8 }}>
              {/* Drive 用的是後端換來的寫入 token，跟「有沒有 Google 登入」無關，
                  所以這裡不必再管 hasGoogleToken —— 重試就好 */}
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
              draggable={canEditAlbum && longPressIndex === index && sortBy === "custom"}
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
                if (canEditAlbum && sortBy === "custom") handleDragStart(index);
              }}
              onDragEnter={() => canEditAlbum && sortBy === "custom" && handleDragEnter(index)}
              onDragEnd={canEditAlbum && sortBy === "custom" ? handleDragEnd : undefined}
              onDragOver={(e) => canEditAlbum && sortBy === "custom" && e.preventDefault()}
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
          // 燈箱裡的編輯（改標題、改時間、刪這張）跟頁面上是同一組權限
          isAdmin={canEditAlbum}
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

      {/* 右下角浮動操作鈕。編輯模式下交棒給底部動作列，所以這裡給空陣列 */}
      <FabMenu
        actions={!canEditAlbum || isEditingPhotos ? [] : buildFabActions()}
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

      {/* Drive 寫入帳號的連結與存取檢查 */}
      <DriveAccessModal
        isOpen={showDriveAccess}
        albumId={id ? Number(id) : undefined}
        onClose={() => setShowDriveAccess(false)}
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
