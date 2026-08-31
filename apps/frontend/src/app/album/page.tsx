"use client";

import { useEffect, useState, useRef, Suspense, useMemo, useCallback } from "react";
import styles from "./album.module.css";
import pageStyles from "../page.module.css";
import Link from "next/link";
import { Photo, Tag, fetchPhotos, uploadPhoto, fetchAlbum, deletePhoto, reorderPhotos, fetchTags, updateAlbum, Album, createGooglePickerSession, fetchGooglePickerPhotos, fetchGoogleMediaFile, GoogleReauthError, photoThumbSrc, googleLoginUrl, DriveWriterError, setPhotosRestricted, applyRestrictedPatch, type UploadedPhoto, type DuplicateMatch } from "@/lib/api";
import { ensureAlbumFolder, ensureDriveFolders, prewarmDrive, pushPhotoToDrive, pushVideoToDrive } from "@/lib/drive";
import { useAdmin } from "@/lib/useAdmin";
import { revealRestricted, toggleRestrictedReveal, useRevealedRestricted } from "@/lib/restrictedReveal";
import SlideConfirmModal from "@/components/SlideConfirmModal";
import GoogleSyncConflictModal from "@/components/GoogleSyncConflictModal";
import AssignPlaceModal from "@/components/AssignPlaceModal";
import FixTimeModal from "@/components/FixTimeModal";
import RotatePhotosModal from "@/components/RotatePhotosModal";
import PostUploadReviewModal from "@/components/PostUploadReviewModal";
import PlaceCheckinModal from "@/components/PlaceCheckinModal";
import { GIF_MAX_BYTES, isGifFile, resizeImageFile } from "@/lib/imageUtils";
import { ACCEPTED_VIDEO_TYPES, captureVideoPoster, formatDuration, isVideoFile } from "@/lib/videoUtils";
import { useSearchParams } from "next/navigation";
import PhotoLightbox from "./PhotoLightbox";
import CustomSelect from "@/components/CustomSelect";
import PhotoImage from "@/components/PhotoImage";
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
  /**
   * 有值就代表這一格是影片：`resized` 是封面圖、`file` 是原始影片檔。
   * 重複視窗那邊長得一模一樣（左邊就是封面），只有「照樣上傳」時要走
   * pushVideoToDrive 而不是 pushPhotoToDrive。
   */
  video?: { fileName: string; durationMs: number };
  /**
   * 有值就代表這一格是 GIF：`resized` 是第一格靜態圖、`file` 與這裡都是動畫本體。
   * 「照樣上傳」時要把它一起送給 uploadPhoto，不然 R2 上只會有一張不會動的圖。
   */
  gif?: { file: File };
};

/**
 * 整批的完成比例。有位元組進度的話，把「現在這個檔傳了幾成」也算進去 ——
 * 否則一支 2GB 的影片會讓進度條在同一格停十幾分鐘，看起來就是當掉了。
 */
function uploadFraction(p: { current: number; total: number; bytes?: { sent: number; total: number } }): number {
  if (p.total <= 0) return 0;
  const within = p.bytes && p.bytes.total > 0 ? p.bytes.sent / p.bytes.total : 0;
  // current 是「第幾個」（1 起算），所以前面已完成的是 current - 1 個
  return Math.min(1, (p.current - 1 + within) / p.total);
}

/** 位元組寫成人看得懂的樣子。影片動輒幾百 MB，顯示成位元組沒有意義 */
function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** 相簿格線的排序方式 */
type SortMode = "custom" | "upload_date" | "taken_date";

/**
 * 預設排序＝**拍攝時間**（新到舊），沒有拍攝時間的那一疊排在最前面。
 *
 * 為什麼不是自訂排序：`sort_order` 記的是「上傳進來的先後」，跟照片什麼時候拍的
 * 完全無關 —— 同一趟旅行分三次傳就散在三段。而「沒有拍攝時間的浮到最上面」是
 * 刻意的：那一疊是影片（封面圖是 canvas 畫的，沒有 EXIF）與掃描的老照片，
 * 要有人手動指定時間才排得進去，沉到最底下就再也不會有人發現它們還沒補。
 */
const DEFAULT_SORT: SortMode = "taken_date";

/** 這張照片的拍攝時刻（毫秒）。沒有或解不出來一律 null，**不要退回 created_at** */
function takenMs(p: Photo): number | null {
  if (!p.taken_at) return null;
  const t = new Date(p.taken_at).getTime();
  return isNaN(t) ? null : t;
}

/**
 * 這張照片在時間軸上算哪一天。**一定要跟格線正在用的排序依據同一個欄位。**
 *
 * 以前不管怎麼排都取 `taken_at || created_at`：按上傳日期排的時候軌上寫的卻是
 * 拍攝月份，兩者對不起來，看起來就是年月一路跳來跳去。
 */
function timelineDateOf(p: Photo, sortBy: SortMode): Date | null {
  const s = sortBy === "upload_date" ? p.created_at : p.taken_at;
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** 時間軸上「還沒有拍攝時間」那一段的節點文字 */
const NO_DATE_LABEL = "無日期";

function AlbumContent() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  
  const [albumName, setAlbumName] = useState("相簿");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const { isAdmin, isOwner, canEdit, canAddTo, canReorderIn, canManageOthers, restrictedBlur } = useAdmin();
  /**
   * 「不開放先糊著」的遮罩：掀開了哪幾張。
   *
   * 集合放在 module 層（lib/restrictedReveal），不是這一頁的 state ——
   * 在格線掀開之後點進燈箱要是又糊回去，那不叫暫時解開，那叫壞掉。
   * 重整就全部蓋回去。
   */
  const revealedRestricted = useRevealedRestricted();
  const isBlurred = (p: Photo) =>
    restrictedBlur && p.restricted === 1 && !revealedRestricted.has(p.id);
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
  /**
   * 上傳進度。`bytes` 只有影片會有 —— 一支 2GB 的影片在「1/1」那一格會停十幾分鐘，
   * 沒有位元組進度的話進度條整段不動，就是使用者說的「以為當掉了」。
   * 照片幾 MB 一下就過去，不需要（也不值得為它多接一層 XHR 來拿進度）。
   */
  const [uploadProgress, setUploadProgress] = useState<{
    current: number; total: number; fileName: string;
    bytes?: { sent: number; total: number };
  } | null>(null);
  /** Drive 沒接上時的原因。照片照樣傳得上去，只是少了 4K 與原始檔備份 */
  const [driveError, setDriveError] = useState<string | null>(null);
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
   *
   * ⚠️ **重整之後就沒了，而且站上沒有第二條補傳的路**（2026-08-28 把「補傳 Drive」
   *    那個重選檔案的視窗整個拿掉了）。那時候的做法是把同一個原始檔再拖進來一次 ——
   *    上傳流程會認出位元組一樣，直接補既有那一列缺的那一半（見 incompleteTwin），
   *    不會多一格。缺備份的是哪幾個檔在 /admin 那份清單上。
   *
   * `need` 記的是**還缺哪一半**（4K／原始檔）。上傳那兩份是分開試的，
   * 常常是一份上去了另一份失敗 —— 補傳時整份重來的話，成功的那一半會在
   * Drive 上再多一個同名檔（Drive 不會去重）。
   */
  const [pendingDriveBatch, setPendingDriveBatch] = useState<
    { photoId: number; file: File; need?: { fourK?: boolean; original?: boolean } }[]
  >([]);
  const [driveBatchProgress, setDriveBatchProgress] = useState<{ current: number; total: number } | null>(null);
  /**
   * 後端擋下來的重複照片，跑完一批之後一張一張問，用的是 Google 匯入那套
   * 衝突視窗（可複選要取代哪幾張既有照片）。空陣列＝沒東西要問。
   */
  const [duplicateItems, setDuplicateItems] = useState<PendingDuplicate[]>([]);
  const [duplicateIndex, setDuplicateIndex] = useState(0);
  /**
   * 決定完的那幾張排在這條鏈上**在背景做完**，使用者按完立刻跳下一張。
   *
   * 以前是 `await` 完才換下一張：按一次就要等上傳 → Drive 4K → Drive 原始檔
   * （幾秒到幾十秒，影片更久），一批撞到二十張就是坐在那裡按一次等一次。
   * 而「要不要留」這個決定根本不需要那些結果。
   *
   * ⚠️ **是一條鏈，不是各自 fire-and-forget**：同時開二十份上傳會把記憶體與
   *    頻寬吃光（影片那幾份尤其）。排隊做跟以前的行為一模一樣，只是不擋人。
   */
  const dupJobsRef = useRef<Promise<void>>(Promise.resolve());
  /** 背景那條鏈的進度（交辦幾張／做完幾張），給進度列與視窗上那行字用 */
  const [dupJobs, setDupJobs] = useState<{ queued: number; done: number }>({ queued: 0, done: 0 });
  /** 背景做失敗的，**一行一個原因**，收工一次講完（同 IngestResult.failures 的規矩） */
  const dupFailuresRef = useRef<string[]>([]);
  /** 這一批的 Drive 位置，重複那幾張決定要傳時直接沿用，不必重跑一次 bootstrap */
  const driveRef = useRef<{ folderId: string; token: string } | null>(null);
  /** 重複那幾張補傳成功的，等整個佇列走完再一起丟給補地點的視窗 */
  const dupUploadedRef = useRef<UploadedPhoto[]>([]);

  // 批次刪除 State
  const [selectedPhotos, setSelectedPhotos] = useState<number[]>([]);
  const [showAssignPlace, setShowAssignPlace] = useState(false);
  const [showFixTime, setShowFixTime] = useState(false);
  const [showRotate, setShowRotate] = useState(false);
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
   * 「Picker 開著、還在等使用者挑照片」那一段。跟 `syncingGoogle` 分開，
   * 是因為只有這一段可以取消 —— 位元組開始搬之後再喊停是另一件事。
   */
  const [googlePickerWaiting, setGooglePickerWaiting] = useState(false);
  /**
   * 取消匯入的把手。輪詢跑在 `handleGoogleSync` 的閉包裡，FAB 上那顆按鈕
   * 只能透過這支 ref 叫它收工。
   *
   * ⚠️ **這顆按鈕是使用者唯一的出口**：我們沒辦法知道他是不是把 Google 那個
   * 視窗關掉不想匯了（`popup.closed` 會說謊，見 `handleGoogleSync`）。
   */
  const cancelGoogleSyncRef = useRef<(() => void) | null>(null);
  // 離開這一頁就把還在跑的輪詢收掉（計時器與那兩個喚醒監聽都掛在 document／window 上，
  // 不收的話會一直跑到 10 分鐘逾時為止）
  useEffect(() => () => { cancelGoogleSyncRef.current?.(); }, []);
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
  const [sortBy, setSortBy] = useState<SortMode>(DEFAULT_SORT);
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

  /**
   * 取消還沒成立的長按，並把已經舉起來的那一張放回去。
   *
   * ⚠️⚠️ 這是「手指縮放之後照片點不動」的解法。長按計時器是在 pointerdown 起跑的，
   * 而**兩指捏合時瀏覽器會把手勢接管走、發的是 `pointercancel` 不是 `pointerup`**
   * —— 原本只有 pointerup／pointerleave 在清計時器，於是計時器活了下來，一秒後
   * `longPressIndex` 被設起來，而卡片的 onClick 看到它不是 null 就整個 return，
   * **從此每一張照片都點不開**（清掉它的 handleDragEnd 永遠不會跑，因為根本沒有
   * 拖曳開始過）。所以捏合一開始就要在這裡收乾淨。
   */
  const cancelLongPress = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // 真的在拖的時候不要動它 —— draggable 還靠它撐著（見卡片上的 draggable）
    if (dragItem.current === null) setLongPressIndex(null);
  }, []);

  // 雙指 Pinch 手勢即時連續縮放照片網格大小 (手機觸控)
  useEffect(() => {
    const getDistance = (touches: TouchList) => {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.hypot(dx, dy);
    };

    /**
     * 燈箱開著的時候整組讓開 —— 那裡有它自己的雙指縮放（放大照片），
     * 不讓開的話捏一下照片，被蓋住的相簿格線也跟著改欄數。
     */
    const inLightbox = (e: TouchEvent) =>
      !!(e.target as HTMLElement | null)?.closest?.('[data-lightbox]');

    const handleTouchStart = (e: TouchEvent) => {
      if (inLightbox(e)) return;
      if (e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        // 手指落在照片上時長按已經在倒數了，捏合不是長按（見 cancelLongPress）
        cancelLongPress();
        touchStartDistRef.current = getDistance(e.touches);
        // 開始時記錄目前畫面的基準欄數（手機預設 2 欄，平板/電腦預設 4 欄）
        const defaultCols = window.innerWidth <= 768 ? 2 : 4;
        initialColumnsRef.current = gridColumns > 0 ? gridColumns : defaultCols;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (inLightbox(e)) return;
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
  }, [gridColumns, cancelLongPress]);

  const [currentCoverPhotoUrl, setCurrentCoverPhotoUrl] = useState<string | null>(null);

  /** 正在改「不開放」的那一張（那顆鎖轉圈圈用），一次只會有一張 */
  const [restrictBusyId, setRestrictBusyId] = useState<number | null>(null);

  /**
   * 切換「不開放」。格線角落那顆鎖與燈箱左上角那顆共用這一支。
   *
   * ⚠️ **成功之後不重抓（不呼叫 loadData）。** 使用者的原話是
   * 「不要每次點了鎖圖 就重新整理 這樣我要重新再找」—— 重抓一次捲軸就回頂端，
   * 一本幾千張的相簿要重新捲回剛剛那一格。改成把回來的結果併回手上那一列。
   *
   * 有三件事後端在同一趟裡順手做了，這裡要跟著對齊，不然畫面會跟資料對不上：
   *   ① 縮圖的 R2 鍵換掉了，舊物件當場刪除 —— 不換新網址就是破圖（applyRestrictedPatch）。
   *   ② 指到這張的相簿封面被清成 NULL。
   *   ③ 遮罩開著的話它會立刻糊掉 —— 剛按完就消失在一片模糊裡很難理解，
   *      所以順手掀開它（掀開狀態本來就只活在記憶體裡，重整就蓋回去）。
   */
  const handleToggleRestricted = async (photoId: number, next: boolean): Promise<boolean> => {
    const target = photos.find((p) => p.id === photoId);
    setRestrictBusyId(photoId);
    const res = await setPhotosRestricted([photoId], next);
    setRestrictBusyId(null);
    if (!res.ok) return false;
    setPhotos((prev) => applyRestrictedPatch(prev, [photoId], res));
    if (next) {
      if (target && currentCoverPhotoUrl === target.url) setCurrentCoverPhotoUrl(null);
      revealRestricted(photoId);
    }
    return true;
  };

  /**
   * 回傳重抓到的照片，讓呼叫端不必等 state 生效就能依最新資料做決定。
   *
   * ⚠️ `silent` ＝ **不要把整片格線換成「載入照片中...」**。`loading` 一翻上去
   *    格線就 unmount，頁面高度當場塌成 0，瀏覽器把捲軸收回頂端 —— 資料回來
   *    重畫完也回不去了，使用者得從頭捲回剛剛那一格（同那顆「不開放」的快速鎖
   *    為什麼不重抓）。**燈箱裡改完資料那條路一律走 silent**：手上已經有一份
   *    畫得出來的清單，沒有任何理由先清空它。
   */
  const loadData = async (opts?: { silent?: boolean }): Promise<Photo[]> => {
    if (!id) return [];
    if (!opts?.silent) setLoading(true);

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

    if (!opts?.silent) setLoading(false);
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
      /*
       * 關鍵字篩選：Story／描述，以及 **title**。
       * ⚠️ `title` 存的就是上傳當下的原始檔名，而且**上傳之後沒有任何一條路徑改得動它**
       *    —— 所以「把 /admin 那份缺備份清單上的檔名貼進來」就是這裡的主要用途之一，
       *    輸入框的 placeholder 要把「檔名」講出來，不然沒有人會想到可以這樣用。
       *    這一頁是純前端 includes()，所以檔名的**任何一段**都比得到（首頁那個
       *    走 FTS，只能從 token 的開頭比）。
       */
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
        /*
         * 沒有拍攝時間的排**最前面**，不是退回 created_at 混在中間。
         * 那一疊（影片、掃描的老照片）要人手動指定時間才排得進去，
         * 混在中間就等於永遠沒有人會發現它們還沒補。
         */
        const at = takenMs(a);
        const bt = takenMs(b);
        if (at === null || bt === null) {
          if (at !== null) return 1;
          if (bt !== null) return -1;
          // 兩張都沒時間：照上傳時間新的在前，剛傳完的影片就落在第一格
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        }
        return bt - at;
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
   * 燈箱正在看的那一張的 **id**，不是索引。兩件事都要它：
   *   ① 在燈箱裡改完資料會重抓，而重抓回來的順序可能整個不一樣（剛補完拍攝
   *      時間的那張就從「沒時間」那一疊掉進中間）—— 索引原地不動就會指到別張。
   *   ② 關燈箱時要捲回那張照片**現在**在格線上的位置。
   */
  const viewingIdRef = useRef<number | null>(null);

  /**
   * 關掉燈箱之後回到那張照片在格線上的位置。
   *
   * 已經整張在畫面裡就不動（在原地開燈箱、改完資料原地關掉是最常見的一次，
   * 硬捲一下只是晃）；不在畫面裡才把它捲到中間，而且是**瞬間不是 smooth** ——
   * 平滑捲過八百張照片要好幾秒，而使用者要的就只是「回到剛剛那裡」。
   */
  const scrollBackTo = (photoId: number | null) => {
    if (photoId == null || typeof window === "undefined") return;
    const index = displayPhotos.findIndex((p) => p.id === photoId);
    if (index < 0) return;
    // 改完時間之後它可能被挪到還沒 render 的區段（無限捲動一次只放 24 張）
    if (index >= visibleCount) setVisibleCount(index + 24);
    // 等它畫出來 —— 跟時間軸那顆節點同一個作法
    setTimeout(() => {
      const el = photoCardRefs.current.get(index);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.top >= 0 && rect.bottom <= window.innerHeight) return;
      el.scrollIntoView({ block: "center" });
    }, 50);
  };

  /**
   * 關燈箱。**順手把網址上的 `?photo=` 拿掉** —— 那是通知點進來留下的深連結，
   * 留著的話重新整理又會被上面那段效果重新開一次燈箱（`deepLinkDone` 只擋得住
   * 同一次載入之內的重開，擋不住重整）。
   *
   * 用 `history.replaceState` 不用 router.replace：這裡只是要改網址列，不需要
   * 讓 Next 重跑一輪路由（會捲回頂端、也會讓整頁重畫）。
   */
  const closeLightbox = () => {
    const backTo = viewingIdRef.current;
    viewingIdRef.current = null;
    setSelectedPhotoIndex(null);
    scrollBackTo(backTo);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("photo")) return;
    url.searchParams.delete("photo");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  };

  /*
   * 開燈箱／換上下一張時把 id 記下來。
   * ⚠️ 相依只有 selectedPhotoIndex —— 清單自己變動時**不能**跟著改，
   *    那正是下面那段要靠這個 id 認人的時候。
   */
  useEffect(() => {
    if (selectedPhotoIndex == null) return;
    const p = displayPhotos[selectedPhotoIndex];
    if (p) viewingIdRef.current = p.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPhotoIndex]);

  /*
   * 清單換了（重抓、改排序、改篩選）就照 id 把索引挪回同一張照片身上。
   * 沒有這一段的話，在燈箱裡補完拍攝時間的那一瞬間，畫面上那張會換成
   * 剛好排到同一個索引的另一張照片。整個找不到（被刪了、被篩掉了）就收起來。
   */
  useEffect(() => {
    const want = viewingIdRef.current;
    if (selectedPhotoIndex == null || want == null) return;
    if (displayPhotos[selectedPhotoIndex]?.id === want) return;
    const next = displayPhotos.findIndex((p) => p.id === want);
    if (next >= 0) setSelectedPhotoIndex(next);
    else closeLightbox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayPhotos]);

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

  /*
   * 右側時間軸那條軌 —— 它就是**格線順序的縮影**：把 displayPhotos 由上往下走一遍，
   * 年月換了就插一個節點。所以順序不是照時間排的時候，軌上的年月本來就會跳來跳去
   * （自訂排序的 sort_order 跟時間毫無關係）。那不是壞掉，是這條軌在那個模式下
   * 沒有意義 —— 而且點下去會把人送到一個跟標籤對不上的位置，所以整條收起來。
   */
  const timelineGroup = useMemo(() => {
    if (sortBy === "custom" || displayPhotos.length === 0) return [];
    const groups: { label: string; index: number }[] = [];
    let lastLabel = "";

    displayPhotos.forEach((photo, index) => {
      const dateObj = timelineDateOf(photo, sortBy);
      // 沒有時間的那一疊也給一個節點：它們就排在最上面，點一下正好跳過去補時間
      const label = dateObj
        ? `${dateObj.getFullYear()}/${String(dateObj.getMonth() + 1).padStart(2, '0')}`
        : NO_DATE_LABEL;
      if (label !== lastLabel) {
        lastLabel = label;
        groups.push({ label, index });
      }
    });

    return groups;
  }, [displayPhotos, sortBy]);

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
      // 畫面上有幾張還沒有拍攝時間。全都是的話氣泡不能留著上一個月份不動
      let visibleNoDate = 0;
      const windowHeight = window.innerHeight;

      for (let i = 0; i < displayPhotos.length; i++) {
        const el = photoCardRefs.current.get(i);
        if (el) {
          const rect = el.getBoundingClientRect();
          // 卡片只要出現在螢幕視野內
          if (rect.bottom >= 0 && rect.top <= windowHeight) {
            // 跟軌上的節點同一個欄位，不然氣泡寫的月份會跟旁邊的節點對不起來
            const d = timelineDateOf(displayPhotos[i], sortBy);
            if (d) visibleDates.push(d);
            else visibleNoDate++;
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
      } else if (visibleNoDate > 0) {
        // 整個畫面都是還沒補時間的那一疊
        setCurrentTimelineDate("還沒有拍攝時間");
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
  }, [displayPhotos, sortBy]);

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
   * 原本「上傳照片」是一顆點了會再展開下拉選單的按鈕，收進 FabMenu 之後直接攤平。
   *
   * **兩組權限**：上傳那一組看 `canAddToAlbum`（別人的相簿也給），其餘（地點、
   * 編輯照片）看 `canEditAlbum`。在別人的相簿裡就只剩上傳那一顆。
   */
  const buildFabActions = (): FabAction[] => {
    if (uploading || syncingGoogle) {
      /*
       * 還在等使用者挑照片那一段是**可以按的**：`popup.closed` 靠不住
       *（見 handleGoogleSync），沒有人猜得出他是關掉視窗不想匯了，
       * 所以這顆就是他唯一的出口 —— 不然只能等 10 分鐘逾時或重整頁面。
       */
      if (googlePickerWaiting && !uploadProgress) {
        return [{
          key: 'busy',
          label: '選相片中... 按這裡取消',
          title: '在 Google 那個視窗選完就會自動接手，不用回來按。不想匯了才按這顆',
          onClick: () => cancelGoogleSyncRef.current?.(),
        }];
      }
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
        // 所有「把檔案送進來」的事收成一扇門。攤在最上層並排的話，
        // 「上傳照片」與「從 Google 相簿匯入」看起來像兩件不相干的事，
        // 其實是同一件事的兩個來源
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
          /*
           * ⚠️ 這裡以前還有一顆「補傳 Drive」（重選一次原始檔補上缺的備份），
           *    2026-08-28 拿掉了：**補傳就是本機上傳**。同一個原始檔再拖進來一次，
           *    重複偵測會認出位元組一樣（same_file），直接補既有那一列缺的那一半，
           *    相簿裡不會多一格，標籤／留言／改過的時間地點全都留著 ——
           *    比那個視窗做得更好（它「取代」會換新 id，那些東西全沒）。
           *    缺備份的是哪幾個檔、誰傳的、在哪一本，看 /admin 那份清單。
           */
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
   * 黃色橫幅那顆按鈕：把**剛上傳那批**的 4K 與原始檔補上去。
   *
   * 不必請人重選檔案，也不必靠檔名對回照片 —— `pendingDriveBatch` 裡的照片 id
   * 是上傳當下後端回傳的，配對不可能錯。
   *
   * ⚠️ 手上沒有那批 File（重整過頁面）就**沒有這顆按鈕**了：站上唯一的另一條路
   *    是把同一個原始檔再拖進來一次（上傳流程自己會補），所以橫幅那邊改成講這句話，
   *    不再端一顆按了會跳視窗的按鈕出來。
   */
  const handleBackfillCurrentBatch = async () => {
    if (driveBatchProgress || !id) return;
    if (pendingDriveBatch.length === 0) return;

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

    /*
     * 沒補成功的留在佇列裡，按鈕可以再按一次；成功的不要重傳，會在 Drive 上留兩份。
     *
     * ⚠️ **半套要留下「還缺哪一半」**，下一次才不會把已經上去的那份再傳一遍。
     */
    const stillMissing: typeof batch = [];
    const reasons: string[] = [];
    for (let i = 0; i < batch.length; i++) {
      setDriveBatchProgress({ current: i + 1, total: batch.length });
      const item = batch[i];
      try {
        const res = await pushPhotoToDrive(drive, item.photoId, item.file, item.need ?? {});
        if (!res.ok) {
          stillMissing.push({
            ...item,
            // 'skipped' 是「本來就不用傳」（GIF 的 4K），不是「還缺」——
            // 寫成 !== 'ok' 的話下一次會拿 GIF 去跑 encode4kWebp
            need: { fourK: res.fourK === 'failed', original: res.original === 'failed' },
          });
          reasons.push(`${item.file.name}：${res.reason ?? 'Drive 上傳失敗'}`);
        }
      } catch (err) {
        console.warn(`照片 ${item.photoId} 補傳失敗`, err);
        stillMissing.push(item);
        reasons.push(`${item.file.name}：${errText(err)}`);
      }
    }

    setDriveBatchProgress(null);
    setPendingDriveBatch(stillMissing);
    if (stillMissing.length === 0) setDriveNeedsLink(false);
    // 逐張講原因：「還有 N 張沒補成功」查不出 N 張各自卡在哪
    setDriveError(stillMissing.length > 0
      ? `還有 ${stillMissing.length} 張沒補成功，可以再按一次。\n${reasons.slice(0, 5).join('\n')}`
      : null);
    await loadData();
  };

  /*
   * 先把 Drive 準備好（必要時建資料夾），一批只做一次。
   *
   * 寫入用的 token 是跟後端換的（不是登入者自己的），所以這裡不會有任何彈窗，
   * 也不會在上傳中途跳走 —— 跳走的話使用者選好的檔案會全沒。
   *
   * 沒接上**不擋上傳** —— 照片只要 R2 的縮圖成功就算存在，Drive 是加分項。
   * drive_file_id 留 NULL，之後把同一個檔再拖進來一次就會補上。
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

  /** 佇列走完：等背景那條鏈做完、收拾狀態、重抓資料，該補地點的再問一次 */
  const finishDuplicateQueue = async () => {
    const items = duplicateItems;
    setDuplicateItems([]);
    setDuplicateIndex(0);

    /*
     * ⚠️ **一定要等背景那條鏈跑完再 loadData()。** 不等的話，剛剛按完的最後
     *    幾張還在上傳，重抓回來的清單裡沒有它們 —— 畫面上看起來就是「選了等於沒選」。
     */
    await dupJobsRef.current;
    items.forEach((d) => URL.revokeObjectURL(d.previewUrl));
    setDupJobs({ queued: 0, done: 0 });

    // 背景做的事沒辦法當場 alert（會蓋在正在挑的下一張上面），所以攢到這裡一次講完
    const failures = dupFailuresRef.current;
    dupFailuresRef.current = [];
    if (failures.length > 0) {
      const shown = failures.slice(0, 10).join('\n');
      const rest = failures.length - 10;
      alert(`有 ${failures.length} 張重複的照片沒處理成功：\n\n${shown}`
        + (rest > 0 ? `\n…另外還有 ${rest} 張` : ''));
    }

    const uploaded = dupUploadedRef.current;
    dupUploadedRef.current = [];
    if (uploaded.length === 0) return;
    await loadData();
    if (uploaded.some((p) => p.lat === null || p.lng === null)) {
      setPostUploadIds(uploaded.map((p) => p.id));
    }
  };

  /** 換下一張；已經是最後一張就收工（收工要等背景，所以不擋在這裡） */
  const advanceDuplicate = () => {
    if (duplicateIndex + 1 < duplicateItems.length) setDuplicateIndex(duplicateIndex + 1);
    else void finishDuplicateQueue();
  };

  /**
   * 真的把這一張處理掉：`keep_both` 是兩張都留，`replace` 是傳新的、再刪掉勾選的舊照片。
   *
   * **一定要先上傳成功才刪。** 反過來的話上傳失敗就變成舊的也沒了、新的也沒進來，
   * 使用者以為只是取代一下，結果照片憑空消失。
   *
   * ⚠️ 這支跑在背景那條鏈上，**畫面早就跳去下一張了** —— 所以出錯一律記進
   *    `dupFailuresRef`，不可以 alert（會蓋在使用者正在挑的那一張上面）。
   */
  const runDuplicateJob = async (
    item: PendingDuplicate,
    decision: 'keep_both' | 'replace',
    replaceIds?: number[],
  ) => {
    const name = item.file.name;
    try {
      const result = await uploadPhoto(
        id as string, item.resized, item.exifData, item.takenAt, true, item.video, item.gif,
      );
      if (result.status !== 'ok') {
        dupFailuresRef.current.push(`${name}：${result.status === 'error' ? result.reason : '上傳失敗'}`);
        return;
      }

      /*
       * 影片跟照片在這裡分岔：影片的 Drive 是必要的，不是備份。傳不上去就把
       * 剛建的那一列收掉（同 ingestSources 的理由），而且不能記進「待補 Drive」
       * —— 那份清單走的是 pushPhotoToDrive，會拿影片去跑 encode4kWebp。
       */
      if (item.video) {
        try {
          if (!driveRef.current) throw new Error('Drive 沒接上，影片沒有地方存');
          await pushVideoToDrive(driveRef.current, result.photo.id, item.file);
        } catch (err) {
          console.error('影片沒送上 Drive，收掉剛建的那一列', err);
          // ⚠️ 回滾自己也會失敗。沒收掉就等於相簿裡留下一格點開只有靜止畫面的東西，
          //    而使用者以為「跳過了」—— 講出來，讓他知道要手動刪
          const rolled = await deletePhoto(result.photo.id);
          dupFailuresRef.current.push(rolled
            ? `${name}：影片沒送上 Drive（${errText(err)}）`
            : `${name}：影片沒送上 Drive，而且那一格沒收掉，請手動刪除（${errText(err)}）`);
          return;
        }
        dupUploadedRef.current.push(result.photo);
      } else {
        dupUploadedRef.current.push(result.photo);
        // Drive 沿用整批那次的授權；沒有就記進待補清單，跟一般上傳一樣
        if (driveRef.current) {
          try {
            // GIF 在 Drive 上只有原始檔那一份（同 ingestSources）
            const need = item.gif ? { fourK: false } : {};
            // 半套也要進待補清單，只是記著缺的是哪一半
            const res = await pushPhotoToDrive(driveRef.current, result.photo.id, item.file, need);
            if (!res.ok) {
              setPendingDriveBatch((prev) => [...prev, {
                photoId: result.photo.id, file: item.file,
                need: { fourK: res.fourK === 'failed', original: res.original === 'failed' },
              }]);
            }
          } catch (err) {
            console.warn('新照片沒送上 Drive', err);
            setPendingDriveBatch((prev) => [...prev, {
              photoId: result.photo.id, file: item.file, need: item.gif ? { fourK: false } : {},
            }]);
          }
        } else {
          setPendingDriveBatch((prev) => [...prev, {
            photoId: result.photo.id, file: item.file, need: item.gif ? { fourK: false } : {},
          }]);
        }
      }

      if (decision === 'replace' && replaceIds && replaceIds.length > 0) {
        // 刪除端點自己會處理 R2 的檔與 Drive 的待搬佇列，這裡不用另外收尾
        const failed = (await Promise.all(replaceIds.map((pid) => deletePhoto(pid))))
          .filter((ok) => !ok).length;
        if (failed > 0) {
          dupFailuresRef.current.push(`${name}：新照片已上傳，但有 ${failed} 張舊照片沒刪掉`);
        }
      }
    } catch (err) {
      console.error(err);
      dupFailuresRef.current.push(`${name}：${errText(err)}`);
    }
  };

  /**
   * 重複視窗按下確認：**排進背景那條鏈，畫面立刻跳下一張。**
   *
   * 使用者要決定的是「留哪一張」，那個決定不需要等上傳跑完 —— 以前每按一次
   * 都要坐等幾秒到幾十秒，一批二十張就是被卡在那裡二十次。
   */
  const resolveDuplicate = (decision: 'keep_both' | 'replace', replaceIds?: number[]) => {
    const item = duplicateItems[duplicateIndex];
    if (!id || !item) return;

    setDupJobs((prev) => ({ ...prev, queued: prev.queued + 1 }));
    dupJobsRef.current = dupJobsRef.current
      .then(() => runDuplicateJob(item, decision, replaceIds))
      // 一張出錯不能把整條鏈斷掉，後面排隊的還要做（runDuplicateJob 自己也有
      // catch，這裡是最後一道保險）
      .catch((err) => { console.error('背景處理重複的照片時出錯', err); })
      .then(() => { setDupJobs((prev) => ({ ...prev, done: prev.done + 1 })); });

    advanceDuplicate();
  };

  /**
   * 一張待匯入的照片。**檔案是延後載入的**（`load()`）—— Google 匯入一批可能幾十張，
   * 先全部抓下來等於把整批原始檔一起壓在記憶體裡，這樣一次只留手上這一張。
   */
  type IngestSource = { name: string; load: () => Promise<File> };

  type IngestResult = {
    uploaded: UploadedPhoto[];
    dupes: PendingDuplicate[];
    /**
     * 沒進來的那幾個，**一行一個原因**。
     *
     * 以前這裡只有一個 `allSuccess` 布林，收工彈的是「部分或全部照片上傳失敗，
     * 請稍後再試」—— 使用者既不知道是哪一張，也不知道再試有沒有用（HEIC 再試
     * 一百次還是一樣）。跟 Google 匯入那條的 `skipped` 同一個規矩：
     * **每一個失敗都要留下痕跡**。
     */
    failures: string[];
    /**
     * 網站上早就有了、只是 Drive 缺一半，這一趟**直接補上去**的那幾個。
     *
     * ⚠️ 補了要講出來。它跟「重複、跳過了」在畫面上長得一模一樣（都沒有新照片
     * 出現在相簿裡），不講的話使用者只會覺得「我重傳了，什麼事都沒發生」。
     */
    backfilled: string[];
    reauth: GoogleReauthError | null;
  };

  /** 把任何丟出來的東西變成一句看得懂的話 */
  const errText = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

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
    onProgress: (
      current: number, total: number, name: string,
      /** 影片才有：這個檔傳了幾個位元組 */
      bytes?: { sent: number; total: number },
    ) => void,
  ): Promise<IngestResult> => {
    const total = sources.length;
    const uploaded: UploadedPhoto[] = [];
    // Drive 沒接上時，把「哪張照片配哪個原始檔」留下來給橫幅那顆按鈕用
    const missedDrive: { photoId: number; file: File; need?: { fourK?: boolean; original?: boolean } }[] = [];
    // 後端判定跟相簿裡撞了的那幾張。**它們一個位元組都還沒寫進去**，跑完再統一問
    const dupes: PendingDuplicate[] = [];
    const failures: string[] = [];
    const backfilled: string[] = [];
    let reauth: GoogleReauthError | null = null;

    /*
     * 「這個檔網站上已經有了，但 Drive 上缺一半」—— 回那一列，代表**直接補**，
     * 不要跳重複視窗。
     *
     * ⚠️ **只認 `same_file`（hash 一樣＝位元組層級的同一個檔），不認 `same_time`。**
     * 時間相同只說明 EXIF 的快門秒數一樣，連拍很容易撞在同一秒 —— 拿 A 的原始檔
     * 去填 B 的欄位，之後燈箱點開的大圖就是別張照片，而且錯得很安靜。
     *
     * ⚠️ 也**只認剛好命中一列**。同一個檔在同一本裡本來就不該有兩列，真的有
     * （以前選過「全部保留」）就該讓使用者自己看一眼決定要補哪一列。
     *
     * 媒體種類對不上也退回問人：影片的封面圖跟某張照片 hash 相同的話，
     * 拿影片檔去補照片的原始檔欄位就完全錯了。GIF 也一樣 —— 它的縮圖是
     * canvas 畫的第一格，跟某張照片撞上 hash 的話補進去的會是一份 .gif。
     */
    const incompleteTwin = (
      existing: DuplicateMatch[], kind: 'photo' | 'video' | 'gif',
    ): DuplicateMatch | null => {
      const hits = existing.filter((e) => e.same_file);
      if (hits.length !== 1) return null;
      const twin = hits[0];
      if (twin.media_type !== kind) return null;
      // 兩份都齊 ＝ 真的是重複，該問人（這是視窗現在唯一還會跳出來的情況）
      if (twin.has_4k && twin.has_original) return null;
      return twin;
    };

    /** 補上去之後要講的那句話：到底補了哪一半 */
    const needLabel = (need: { fourK?: boolean; original?: boolean }) =>
      [need.fourK ? '4K' : '', need.original ? '原始檔' : ''].filter(Boolean).join(' ＋ ');

    const drive = await prepareDrive();
    // 重複那幾張稍後才決定要不要傳，那時不該再跑一次 bootstrap，沿用這批的位置
    driveRef.current = drive;

    for (let i = 0; i < total; i++) {
      const source = sources[i];
      onProgress(i + 1, total, source.name);
      try {
        const rawFile = await source.load();

        /*
         * 影片：擷一格當封面，走同一支 uploadPhoto（封面就是那張「照片」），
         * 原始檔再用分塊上傳送 Drive。
         *
         * ⚠️ **影片沒有 Drive 就等於沒有影片** —— R2 上只有封面圖，相簿裡會多
         *    一格點開只有靜止畫面的東西。所以這裡跟照片相反：Drive 失敗要把剛
         *    建的那一列刪掉，讓使用者看到「這支失敗了」而不是一格壞掉的影片。
         */
        if (isVideoFile(rawFile)) {
          const { poster, durationMs } = await captureVideoPoster(rawFile);
          const meta = { fileName: rawFile.name, durationMs };
          const result = await uploadPhoto(id as string, poster, undefined, undefined, false, meta);
          if (result.status === 'duplicate') {
            /*
             * 這支影片站上已經有了，只是 Drive 上沒有原始檔（上傳當下 Drive 斷線，
             * 或是傳上去了但 recordDriveIds 那一趟沒回來）。封面圖不必再產一次，
             * 直接把原始檔補上那一列就好 —— 相簿裡不會多一格。
             */
            const twin = incompleteTwin(result.existing, 'video');
            if (twin) {
              if (!drive) {
                failures.push(`${source.name}：這支影片站上已經有了，但 Drive 沒接上，原始檔補不了`);
              } else {
                try {
                  await pushVideoToDrive(drive, twin.id, rawFile,
                    (sent, size) => onProgress(i + 1, total, source.name, { sent, total: size }));
                  backfilled.push(`${source.name}：補上了 Drive 的影片原始檔`);
                } catch (err) {
                  failures.push(`${source.name}：影片原始檔沒補上 Drive（${errText(err)}）`);
                }
              }
              continue;
            }
            dupes.push({
              key: `${Date.now()}-${i}-${source.name}`,
              file: rawFile, resized: poster, previewUrl: URL.createObjectURL(poster),
              exifData: undefined, takenAt: undefined,
              reason: result.reason, existing: result.existing,
              video: meta,
            });
          } else if (result.status === 'ok') {
            try {
              if (!drive) throw new Error('Drive 沒接上，影片沒有地方存');
              await pushVideoToDrive(drive, result.photo.id, rawFile,
                (sent, size) => onProgress(i + 1, total, source.name, { sent, total: size }));
              uploaded.push(result.photo);
            } catch (err) {
              console.error(`影片 ${rawFile.name} 沒送上 Drive，收掉剛建的那一列`, err);
              // 回滾失敗要另外講：那一格還在相簿裡，而且點開只有靜止畫面
              const rolled = await deletePhoto(result.photo.id);
              failures.push(rolled
                ? `${source.name}：影片沒送上 Drive（${errText(err)}）`
                : `${source.name}：影片沒送上 Drive，而且那一格沒收掉，請手動刪除（${errText(err)}）`);
            }
          } else {
            failures.push(`${source.name}：${result.reason}`);
          }
          continue;
        }

        /*
         * GIF 跟照片走**同一條路**，只有三點不同（見 migrations/0021）：
         *   ① 縮圖照樣是 resizeImageFile 畫的 —— canvas 只畫得出第一格，
         *      而第一格正好就是我們要的靜態縮圖，不必另外寫一支；
         *   ② 動畫本體跟著同一趟 uploadPhoto 送上去，由後端整份寫進 R2；
         *   ③ Drive 上**只放原始檔那一份**（`fourK: false`）——「4K WebP」對 GIF
         *      是把第一格放大成一張靜態圖，存了沒有任何用途。
         *
         * ⚠️ **不要因此把 GIF 當成影片**：它的 Drive 失敗是**可以吞的**（動畫本體
         *    已經在 R2 上，相簿裡那一格是完整的），跟影片相反 —— 影片沒有 Drive
         *    就只剩一張封面。所以底下照舊記進 pendingDriveBatch，不做回滾。
         */
        const gifSource = isGifFile(rawFile);
        if (gifSource && rawFile.size > GIF_MAX_BYTES) {
          // 後端也會擋（那道才是真的關），但在這裡就講清楚，省一趟白傳的上傳
          failures.push(`${source.name}：GIF 太大了（${Math.round(rawFile.size / 1024 / 1024)}MB），`
            + `上限 ${Math.round(GIF_MAX_BYTES / 1024 / 1024)}MB。這種長度的動畫請錄成影片上傳`);
          continue;
        }
        // GIF 在 Drive 上沒有「衍生的 4K」那一份
        const driveNeed = gifSource ? { fourK: false } : {};

        // 縮圖處理 (長邊不超過 2000px)
        const { file, exifData, takenAt } = await resizeImageFile(rawFile, 2000);
        const result = await uploadPhoto(
          id as string, file, exifData, takenAt || undefined, false, undefined,
          gifSource ? { file: rawFile } : undefined,
        );
        if (result.status === 'ok') {
          uploaded.push(result.photo);
          /*
           * 4K 與原始檔送 Drive。失敗**只是少一份備份**，照片本身已經在 R2 了。
           *
           * ⚠️ 這裡以前沒有 try：一張的 Drive 斷線會被外層的 catch 接走、
           *    整張算成「上傳失敗」（其實它好好地在相簿裡），而且**不會**進待補
           *    清單 —— 橫幅那顆「補傳這批」與 /admin 那份清單從此看不到它。
           */
          if (drive) {
            try {
              /*
               * ⚠️ 半套（例如 4K 上去了、原始檔失敗）以前會被當成成功 ——
               *    回的是 boolean 而且「有一份就算 true」，於是那張照片再也
               *    不會出現在任何補傳清單上，使用者以為備份好了。
               */
              const res = await pushPhotoToDrive(drive, result.photo.id, rawFile, driveNeed);
              if (!res.ok) {
                missedDrive.push({
                  photoId: result.photo.id, file: rawFile,
                  // 'skipped'（GIF 的 4K）不是失敗，記成「還缺」會讓下一次補傳
                  // 拿 GIF 去跑 encode4kWebp
                  need: { fourK: res.fourK === 'failed', original: res.original === 'failed' },
                });
              }
            } catch (err) {
              console.warn('新照片沒送上 Drive，記進待補清單', err);
              missedDrive.push({ photoId: result.photo.id, file: rawFile, need: driveNeed });
            }
          } else missedDrive.push({ photoId: result.photo.id, file: rawFile, need: driveNeed });
        } else if (result.status === 'duplicate') {
          /*
           * 網站上有這張、Drive 上缺一半 —— **直接補缺的那一半就好**。
           *
           * 以前這裡一律跳重複視窗，而視窗給的兩條路都補不好這件事：
           * 「全部保留」多一列＋多兩顆 R2 物件，缺的那半照樣缺；「取代」補得起來
           * 但會換一個新的照片 id，標籤、留言、Story、手動修過的座標與時間全沒了。
           * 補的是**既有那一列**，id 不動，什麼都不會掉。
           */
          const twin = incompleteTwin(result.existing, gifSource ? 'gif' : 'photo');
          if (twin) {
            const need = { fourK: !twin.has_4k, original: !twin.has_original };
            if (!drive) {
              // Drive 沒接上：交給橫幅那顆「補傳這批」，別把使用者晾在這裡
              missedDrive.push({ photoId: twin.id, file: rawFile, need });
              backfilled.push(`${source.name}：站上已經有了，Drive 缺 ${needLabel(need)}，已排進待補清單`);
            } else {
              try {
                const res = await pushPhotoToDrive(drive, twin.id, rawFile, need);
                if (res.ok) {
                  backfilled.push(`${source.name}：補上了 Drive 的 ${needLabel(need)}`);
                } else {
                  // 半套照樣進待補清單，`need` 只留這次還是沒成功的那一半
                  missedDrive.push({
                    photoId: twin.id, file: rawFile,
                    need: {
                      fourK: need.fourK && res.fourK !== 'ok',
                      original: need.original && res.original !== 'ok',
                    },
                  });
                  failures.push(`${source.name}：Drive 缺的那份沒補成功（${res.reason || 'Drive 上傳失敗'}）`);
                }
              } catch (err) {
                missedDrive.push({ photoId: twin.id, file: rawFile, need });
                failures.push(`${source.name}：Drive 缺的那份沒補成功（${errText(err)}）`);
              }
            }
            continue;
          }

          // 縮好的 file 一起留著：使用者若選「照樣上傳」，不必再解一次圖
          dupes.push({
            key: `${Date.now()}-${i}-${source.name}`,
            file: rawFile, resized: file, previewUrl: URL.createObjectURL(rawFile),
            exifData, takenAt: takenAt || undefined,
            reason: result.reason, existing: result.existing,
            ...(gifSource ? { gif: { file: rawFile } } : {}),
          });
        } else {
          failures.push(`${source.name}：${result.reason}`);
        }
      } catch (err) {
        if (err instanceof GoogleReauthError) { reauth = err; break; }
        console.error(err);
        failures.push(`${source.name}：${errText(err)}`);
      }
    }

    // 累加而不是覆蓋：連傳兩批都沒接上 Drive 時，第一批不該被第二批洗掉
    if (missedDrive.length > 0) setPendingDriveBatch((prev) => [...prev, ...missedDrive]);

    return { uploaded, dupes, failures, backfilled, reauth };
  };

  /** 匯入收尾。視窗順序是固定的：重複清單疊在補地點上面，先決定要不要傳 */
  const finishIngest = async (result: IngestResult) => {
    if (result.reauth) setGoogleReauth(result.reauth.message);
    else {
      /*
       * 一次講完。**兩件事都要講**：
       *   失敗的 —— 逐行列出哪一個、為什麼（HEIC 再試一百次也是一樣，光說「請稍後
       *   再試」是句假話）。
       *   自動補上的 —— 那幾個檔畫面上什麼都沒多出來（照片本來就在相簿裡），
       *   不講的話使用者只會覺得「我重傳了，結果什麼都沒發生」。
       * 太多就只列前 10 行，剩下的用數字帶過 —— alert 塞不下五十行，而前十行
       * 通常就足以看出全部是同一個原因。
       */
      const section = (title: string, lines: string[]) => {
        const shown = lines.slice(0, 10).join('\n');
        const rest = lines.length - 10;
        return `${title}\n\n${shown}` + (rest > 0 ? `\n…另外還有 ${rest} 個` : '');
      };
      const blocks: string[] = [];
      if (result.failures.length > 0) {
        blocks.push(section(`有 ${result.failures.length} 個檔案沒上傳成功：`, result.failures));
      }
      if (result.backfilled.length > 0) {
        blocks.push(section(
          `有 ${result.backfilled.length} 個檔案站上已經有了，缺的備份已經自動補上：`,
          result.backfilled,
        ));
      }
      if (blocks.length > 0) alert(blocks.join('\n\n'));
    }

    await loadData(); // 重新整理照片。要 await，補件視窗才拿得到縮圖

    // 這批只要有任何一張沒有 EXIF 座標就跳出補件視窗；全部都有 GPS 的話不打擾。
    if (result.uploaded.some((p) => p.lat === null || p.lng === null)) {
      setPostUploadIds(result.uploaded.map((p) => p.id));
    }
    if (result.dupes.length > 0) setDuplicateItems(result.dupes);
  };

  /**
   * 本機選檔上傳。
   *
   * ⚠️ **整段一定要包在 try/finally 裡。** 中途任何一個沒預料到的錯誤丟出來的話：
   *    ① `uploading` 永遠停在 true，右下角那顆 FAB 從此只剩一行「上傳中...」；
   *    ② `<input type="file">` 的 value 沒清掉，**再選同一批檔案不會觸發 change**
   *       —— 按了、選了，然後什麼都沒發生，Console 只有一行 unhandled rejection。
   *    這正是「有時候傳得上去、有時候按了沒反應」的長相。
   */
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!id) return;
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    try {
      const result = await ingestSources(
        Array.from(files).map((f) => ({ name: f.name, load: async () => f })),
        (current, total, fileName, bytes) => setUploadProgress({ current, total, fileName, bytes }),
      );
      await finishIngest(result);
    } catch (err) {
      console.error('上傳流程整個中斷', err);
      alert(`上傳中斷了：${errText(err)}`);
    } finally {
      setUploading(false);
      setUploadProgress(null);
      // 一定要清掉：不清的話「再選同一批檔案」瀏覽器認為值沒變，change 不會來
      if (fileInputRef.current) fileInputRef.current.value = "";
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
    /*
     * 視窗被擋掉就當場講。沒有它整條路只是空轉：session 建了、輪詢跑滿 10 分鐘，
     * 而使用者從頭到尾沒看到任何可以挑照片的地方。
     */
    if (!popup) {
      alert("瀏覽器擋掉了選相片的視窗。請允許這個網站開啟彈出式視窗，再按一次「從 Google 相簿匯入」。");
      return;
    }
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

      // 這行也是刻意留著的診斷起點：Console 連這一行都沒有，代表問題在按鈕
      // 到建 session 之間，不在後面那串輪詢
      console.log('Picker session 已建立', session.id);

      // 非同步取得連結後，直接將 popup 的網址更換為支援自動關閉的 pickerUri
      if (popup) {
        popup.location.href = session.pickerUri + "/autoclose";
      }

      const startTime = Date.now();
      let photosProcessingStarted = false;
      // 最後一次查詢失敗的樣子。輪詢單次失敗不停（可能只是網路抖一下），
      // 但收工時要拿它講清楚 —— 不然又變成「什麼都沒發生」
      let lastPollError: string | null = null;

      /*
       * ⚠️⚠️ **不要再用 `popup.closed` 判斷「使用者取消了」。那個值會說謊。**
       *
       * Google 的選相片頁帶著 `Cross-Origin-Opener-Policy: same-origin`：popup 一
       * 導過去，瀏覽器就把它跟開它的這一頁切成兩個瀏覽環境群組，我們手上這個
       * window 參考當場退化成一個斷開的代理 —— 而斷開的代理 **`closed` 一律回
       * `true`**，視窗其實好端端開著。（會不會斷取決於中間經過哪幾頁，
       * 所以症狀是時好時壞。）
       *
       * 曾經是「發現 closed 就記時間，20 秒內還沒 ready 就當作取消」：於是視窗一
       * 導到 Google 就被判定關閉，使用者從按下匯入起**只有 20 秒可以挑照片**，
       * 挑慢一點整批就被丟掉；而取消刻意不彈東西，看起來就是「按了沒反應」。
       * 再前一版的「關窗 1.5 秒後問一次」是同一個坑的另一面。
       *
       * 現在**完全不猜**：選完了就接手（Google 那邊 `mediaItemsSet` 翻 true），
       * 不想匯了由使用者自己按 FAB 上那顆「取消」，撐到 10 分鐘才自動收工。
       * 這條路的規矩是「手動路徑優先，自動推論只是加分項」—— 這個推論是負分。
       */

      let pollTimer: ReturnType<typeof setInterval> | null = null;
      let wakePoll: () => void = () => {};
      /*
       * 收工：拆掉輪詢與兩個喚醒監聽，並宣告「已經有人接手了」。
       * 每一條離開輪詢的路都要走它，漏掉的話 setInterval 會一直跑下去。
       */
      const stopPolling = () => {
        photosProcessingStarted = true;
        if (pollTimer) clearInterval(pollTimer);
        document.removeEventListener('visibilitychange', wakePoll);
        window.removeEventListener('focus', wakePoll);
        setGooglePickerWaiting(false);
        cancelGoogleSyncRef.current = null;
      };

      const pollOnce = async () => {
        if (photosProcessingStarted) {
          return;
        }

        // 如果超過 10 分鐘，自動中斷
        if (Date.now() - startTime > 10 * 60 * 1000) {
          stopPolling();
          setSyncingGoogle(false);
          alert(lastPollError
            ? `同步逾時，已自動取消。最後一次查詢的錯誤：${lastPollError}`
            : "同步逾時，已自動取消。");
          return;
        }

        // 這裡在 interval 裡面，丟出去沒人接得到（會變成 unhandled rejection，
        // 而且輪詢還會繼續跑），所以每一輪自己收乾淨
        let res: { ready: boolean; mediaItems?: any[]; error?: string };
        try {
          res = await fetchGooglePickerPhotos(session!.id!);
          lastPollError = res.error ?? null;
        } catch (err) {
          stopPolling();
          setSyncingGoogle(false);
          if (err instanceof GoogleReauthError) setGoogleReauth(err.message);
          else console.error(err);
          return;
        }

        // 2 秒那支跟「剛回到分頁」那一下可能同時在飛，await 回來要再確認一次
        // 還沒有人接手 —— 不然同一批會被匯進來兩次
        if (photosProcessingStarted) return;

        if (res.ready && res.mediaItems) {
          stopPolling();
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
          /*
           * ⚠️ **選完了但一個項目都沒有，要當成異常講出來。** 這個組合以前是
           *    整段流程最安靜的失敗：迴圈跑零次、沒有 sources、沒有 skipped，
           *    於是關掉轉圈圈就 return —— 使用者眼中就是「按了完全沒反應」。
           */
          if (res.mediaItems.length === 0) {
            setSyncingGoogle(false);
            setUploadProgress(null);
            alert("Google 說你選完了，但一個項目都沒回傳。請再試一次；一直這樣的話把 Console 的訊息給我。");
            return;
          }
          // 這行是刻意留著的：下次再有「匯不進來」時，這裡直接看得出 Google 回了什麼
          console.log('Picker 回傳', res.mediaItems.length, '個項目',
            res.mediaItems.map((it: any) => ({
              type: it.type,
              mime: it.mediaFile?.mimeType,
              name: it.mediaFile?.filename,
              hasBaseUrl: !!it.mediaFile?.baseUrl,
              video: it.mediaFile?.mediaFileMetadata?.videoMetadata,
            })));

          const sources: IngestSource[] = [];
          // 被擋掉的那幾筆。跑完統一講一次 —— 以前是 console.warn，
          // 於是整批都被擋掉時畫面上什麼都不會發生，看起來就是「匯入壞了」
          const skipped: string[] = [];
          for (const item of res.mediaItems) {
            const baseUrl = item.mediaFile?.baseUrl || item.baseUrl;
            const mimeType: string = item.mediaFile?.mimeType || item.mimeType || '';
            // Picker 的 mediaItem 有 type: 'PHOTO' | 'VIDEO'，mimeType 只是保險
            const isVideoItem = mimeType.startsWith('video/') || item.type === 'VIDEO';
            const filename = item.mediaFile?.filename || item.filename
              || item.id + (isVideoItem ? '.mp4' : '.jpg');
            if (!baseUrl || (!isVideoItem && mimeType && !mimeType.startsWith('image/'))) {
              skipped.push(`${filename}：不是照片或影片`);
              continue;
            }
            /*
             * ⚠️ 影片要 Google 那邊**轉完檔**才拿得到位元組（`=dv`）。還在處理時
             *    直接抓會 502，與其讓它跑到一半才炸，不如在這裡就講明白哪幾支
             *    要等一下再匯。processingStatus 只有影片才有。
             */
            const status = item.mediaFile?.mediaFileMetadata?.videoMetadata?.processingStatus;
            // ⚠️ 只擋明確講「還在處理／失敗」的。列舉值還有一個 UNSPECIFIED，
            //    寫成「不是 READY 就擋」會把它一起擋掉 —— 拿不準的一律讓它去試
            if (isVideoItem && (status === 'PROCESSING' || status === 'FAILED')) {
              skipped.push(`${filename}：Google 那邊還沒處理好這支影片（${status}），等一下再匯`);
              continue;
            }
            // Picker 把時間放在 mediaItem.createTime，舊回應在 mediaMetadata 底下
            const creationTime = item.createTime
              || item.mediaFile?.mediaFileMetadata?.creationTime
              || item.mediaMetadata?.creationTime;
            sources.push({
              name: filename,
              load: () => fetchGoogleMediaFile(baseUrl, filename, creationTime, isVideoItem),
            });
          }

          if (sources.length === 0) {
            setSyncingGoogle(false);
            setUploadProgress(null);
            if (skipped.length > 0) alert(`這批沒有東西可以匯入：\n\n${skipped.join('\n')}`);
            return;
          }

          /*
           * **進度回報跟本機上傳共用同一份 `uploadProgress`**，畫的也是同一條
           * 進度列。以前這裡另外記一份 `syncProgress`，只餵得起 FAB 上那行
           * 「匯入中 (x/y)」—— 於是同一條管線（ingestSources）跑起來，本機那條
           * 有進度列、Google 這條沒有，看起來像卡住。
           */
          // finally 跟本機那條同一個理由：丟出來的話 syncingGoogle 永遠停在 true，
          // FAB 從此只剩一行「匯入中...」。而且這裡在 setInterval 的 callback 裡，
          // 錯誤連個接的人都沒有
          try {
            const result = await ingestSources(
              sources,
              (current, total, fileName, bytes) => setUploadProgress({ current, total, fileName, bytes }),
            );
            await finishIngest(result);
          } catch (err) {
            console.error('Google 匯入流程整個中斷', err);
            alert(`匯入中斷了：${errText(err)}`);
          } finally {
            setSyncingGoogle(false);
            setUploadProgress(null);
          }
          if (skipped.length > 0) alert(`有 ${skipped.length} 個項目沒匯進來：\n\n${skipped.join('\n')}`);
        }
      };

      /*
       * 挑照片的時候我們這一頁多半是被蓋住的，而被蓋住的分頁 `setInterval` 會被
       * 瀏覽器降頻到**一分鐘一次** —— 選完回來要乾等快一分鐘才有反應，看起來
       * 就是「選完了卻沒動靜」。所以一回到前景就補問一次。
       *（`/autoclose` 把 popup 關掉之後焦點會自己回來，這一下通常就接上了。）
       */
      wakePoll = () => {
        if (document.visibilityState === 'visible') void pollOnce();
      };
      document.addEventListener('visibilitychange', wakePoll);
      window.addEventListener('focus', wakePoll);
      pollTimer = setInterval(() => { void pollOnce(); }, 2000);

      setGooglePickerWaiting(true);
      cancelGoogleSyncRef.current = () => {
        console.log('使用者自己取消了 Google 匯入');
        stopPolling();
        setSyncingGoogle(false);
        setUploadProgress(null);
        // 關得掉就關。COOP 切斷之後多半關不掉，那就留給 /autoclose 或使用者自己
        try { popup?.close(); } catch (e) {}
      };
    } catch (err) {
      console.error(err);
      setSyncingGoogle(false);
      setGooglePickerWaiting(false);
      cancelGoogleSyncRef.current = null;
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

  /**
   * 手指／滑鼠離開就收 —— pointerup、pointerleave，以及**手勢被瀏覽器接管走的
   * `pointercancel`**（捏合、系統的返回手勢都是走這一條，見 cancelLongPress）。
   *
   * 除了計時器，也把 `longPressIndex` 放回去：長按一秒卻沒有拖就放開的話，
   * 以前那一張會一直停在「舉起來」的狀態，而卡片的 onClick 因此吃掉每一次點擊。
   */
  const handlePointerUpOrLeave = () => {
    cancelLongPress();
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
                placeholder="搜尋 Story 或檔名..." 
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
              {(selectedTags.length > 0 || sortBy !== DEFAULT_SORT || gridColumns !== 0) && (
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
            activeFilterCount={selectedTags.length + (sortBy !== DEFAULT_SORT ? 1 : 0) + (gridColumns !== 0 ? 1 : 0)}
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
              /*
               * 影片的格式清單刻意跟播放端同一組（見 videoUtils）：瀏覽器解不開的
               * 檔，封面擷不出來、之後也播不出來 —— 擋在選檔那一步比事後報錯好懂。
               */
              /*
               * GIF 收得進來，而且**不轉影片、動畫本體整份進 R2**（見 0021）。
               * 上限 25MB（GIF_MAX_BYTES）；選檔視窗攔不了大小，由 ingestSources 擋。
               */
              accept={`image/jpeg, image/png, image/webp, image/gif, image/heic, image/heif, ${ACCEPTED_VIDEO_TYPES}`}
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
             * 前面：回來之後這批要把同一批檔案再拖進來一次。**不自動跳轉。**
             */
            isOwner ? (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 13, marginBottom: 8 }}>
                  用 Google 登入一次就會把授權收回來。這批照片要回來之後
                  <strong>把同一批檔案再拖進來一次</strong>補上 ——
                  站上會認出是同一個檔，只補缺的那一份，相簿裡不會多一格
                  （離開這一頁會忘記剛才選了哪些）。
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
                之後回到這裡把同一批檔案再拖進來一次就補得上（不會多一格）。
              </div>
            )
          ) : (
            <div style={{ marginTop: 8 }}>
              {/*
                * Drive 用的是後端換來的站長寫入 token，跟按下去的人是誰無關，
                * 所以這裡不必先去登入什麼 —— 重試就好。
                *
                * ⚠️ 只有**手上還握著那批 File** 時才端這顆按鈕。重整過頁面就沒了，
                *    那時給一顆按了什麼都不會發生的按鈕比不給還糟 —— 改成講清楚
                *    唯一的那條路：同一批檔案再拖進來一次。
                */}
              {pendingDriveBatch.length > 0 ? (
                <button
                  type="button"
                  onClick={handleBackfillCurrentBatch}
                  style={{
                    padding: '7px 14px', borderRadius: 7, border: 'none',
                    background: '#b45309', color: '#fff', fontSize: 13.5, cursor: 'pointer',
                  }}
                >
                  補傳這批（{pendingDriveBatch.length} 張）
                </button>
              ) : (
                <div style={{ fontSize: 13 }}>
                  把同一批檔案<strong>再拖進來上傳一次</strong>就補得上 ——
                  站上會認出是同一個檔，只補缺的那一份，相簿裡不會多一格。
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/*
        重複那批的背景進度。決定完就跳下一張，所以真正在做的事只剩這條線在講；
        最後一張按完視窗會收起來，這條就是「還沒好，別急著關頁面」的唯一提示。
      */}
      {dupJobs.queued > dupJobs.done && (
        <div className={styles.progressContainer}>
          <div className={styles.progressBar}>
            <div
              className={styles.progressFill}
              style={{ width: `${(dupJobs.done / dupJobs.queued) * 100}%` }}
            />
          </div>
          <p className={styles.progressText}>
            背景處理重複的照片 ({dupJobs.done} / {dupJobs.queued})
          </p>
        </div>
      )}

      {uploadProgress && (
        <div className={styles.progressContainer}>
          <div className={styles.progressBar}>
            <div 
              className={styles.progressFill} 
              /*
               * 有位元組進度時，把「這個檔傳到幾成」算進整批的比例裡，
               * 進度條才會在一支大影片的十幾分鐘裡持續前進，而不是卡在同一格。
               */
              style={{ width: `${uploadFraction(uploadProgress) * 100}%` }}
            />
          </div>
          <p className={styles.progressText}>
            正在處理: {uploadProgress.fileName} ({uploadProgress.current} / {uploadProgress.total})
            {uploadProgress.bytes && (
              <> · 上傳 {formatBytes(uploadProgress.bytes.sent)} / {formatBytes(uploadProgress.bytes.total)}</>
            )}
          </p>
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
              className={`${styles.photoCard} ${draggingIndex === index ? styles.dragging : ""} ${longPressIndex === index ? styles.readyToDrag : ""} ${isBlurred(photo) ? styles.blurredPhoto : ""}`}
              draggable={canReorderPhotos && longPressIndex === index && sortBy === "custom"}
              onClick={async () => {
                // ⚠️ 比的是 `=== index` 不是 `!== null` —— 萬一哪一張卡在「舉起來」的
                //    狀態，只有它自己點不動，不會連累格線上其他每一張
                if (longPressIndex === index || draggingIndex !== null) return;
                if (isEditingPhotos) {
                  /*
                   * 不開放的那一張不能當封面 —— 封面是存下來的網址，會出現在
                   * 首頁與相簿列表上，對所有人。後端在標成不開放的當下就會把
                   * 既有的封面清掉，這裡擋的是反過來的順序。
                   */
                  if (photo.restricted === 1) {
                    alert("這一張設成不開放了，不能當相簿封面");
                    return;
                  }
                  // 在編輯模式下，若點擊已是封面的照片則取消封面設定，否則設為新封面
                  const isCurrentCover = currentCoverPhotoUrl === photo.url;
                  const newCoverUrl = isCurrentCover ? null : photo.url;
                  setCurrentCoverPhotoUrl(newCoverUrl);
                  await updateAlbum(Number(id), { cover_photo_url: newCoverUrl || "" });
                  return;
                }
                /*
                 * 遮罩開著時，第一下只掀開這一格、**不進燈箱** ——
                 * 不然點下去馬上是一張全螢幕的大圖，遮罩就白蓋了。
                 * 掀開之後再點一下才是平常的「打開燈箱」。
                 */
                if (isBlurred(photo)) {
                  revealRestricted(photo.id);
                  return;
                }
                setSelectedPhotoIndex(index);
              }}
              onPointerDown={() => sortBy === "custom" && handlePointerDown(index)}
              onPointerUp={handlePointerUpOrLeave}
              onPointerLeave={handlePointerUpOrLeave}
              // ⚠️ 捏合縮放時瀏覽器接管手勢，發的是這一顆不是 pointerup
              onPointerCancel={handlePointerUpOrLeave}
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
              <PhotoImage
                src={photoThumbSrc(photo, 'md')}
                alt={photo.title}
                className={styles.photoImage}
                lazy
              />
              {/*
                * 影片在格線上就是它的封面圖，跟照片長得一模一樣 —— 沒有這個角標
                * 使用者根本看不出哪幾格點下去會動。長度抓不到時 formatDuration
                * 回 null，那就只剩一個播放三角形。
                */}
              {photo.media_type === 'video' && (
                <span className={styles.videoBadge}>
                  <span className={styles.videoBadgeIcon} aria-hidden="true">▶</span>
                  {formatDuration(photo.duration_ms)}
                </span>
              )}
              {/*
                * GIF 在格線上是**靜止的第一格**（縮圖就是那樣產的），點開燈箱才會動。
                * 沿用影片那顆角標的位置與樣式 —— 同一件事（「這格點下去會動」）
                * 沒有理由做出第二種長相。
                */}
              {photo.media_type === 'gif' && (
                <span className={styles.videoBadge}>GIF</span>
              )}
              {/*
                * 不開放的那幾格只有可管理全站內容的人拿得到（後端就濾掉了，
                * 見 migrations/0020）—— 所以這裡不必再判斷一次身分，
                * 看得到 restricted === 1 本身就代表「我是那種人」。
                * 沒有角標的話，站長會完全分不出哪幾張是藏起來的。
                */}
              {photo.restricted === 1 && (
                /*
                 * 遮罩開著時角標同時是那一格的開關（點它收回／掀開），所以要能吃到
                 * 點擊 —— 平常那顆是 pointer-events: none，整張卡都是「打開燈箱」。
                 */
                restrictedBlur ? (
                  <button
                    type="button"
                    className={`${styles.restrictedBadge} ${styles.restrictedBadgeBtn}`}
                    onClick={(e) => { e.stopPropagation(); toggleRestrictedReveal(photo.id); }}
                  >
                    🔒 不開放 · {isBlurred(photo) ? '點一下顯示' : '收回'}
                  </button>
                ) : (
                  <span className={styles.restrictedBadge}>🔒 不開放</span>
                )
              )}
              {/*
                * 快速鎖：不必點進燈箱就能把一張標成／取消不開放。
                *
                * 位置跟燈箱那顆一樣在左上角，長相也沿用同一套語彙（關著很淡、
                * 開著整顆亮起來）—— 同一件事不要在兩個地方長成兩種東西。
                * 「不開放」三個字由左下角那個角標負責寫出來，這裡不重複一次。
                *
                * ⚠️ 編輯模式下不端出來：左上角那個位置已經是勾選框了，
                *    而且那個模式的每一下點擊都是在選照片／設封面。
                */}
              {canManageOthers && !isEditingPhotos && (
                <button
                  type="button"
                  className={`${styles.restrictLock} ${photo.restricted === 1 ? styles.restrictLockOn : ""}`}
                  disabled={restrictBusyId === photo.id}
                  aria-pressed={photo.restricted === 1}
                  title={photo.restricted === 1
                    ? "目前不開放：只有可管理全站內容的人看得到。按一下改回開放"
                    : "按一下設成不開放：只有可管理全站內容的人看得到"}
                  onClick={async (e) => {
                    e.stopPropagation();
                    const ok = await handleToggleRestricted(photo.id, photo.restricted !== 1);
                    if (!ok) alert("設定失敗，請再試一次");
                  }}
                >
                  {photo.restricted === 1 ? "🔒" : "🔓"}
                </button>
              )}
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
          /* ⚠️ silent：不要把格線換成「載入照片中...」再換回來，那一下捲軸就回頂端了 */
          onUpdate={() => { void loadData({ silent: true }); }}
          onToggleRestricted={handleToggleRestricted}
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
            className={pageStyles.actionButton}
            onClick={() => setShowRotate(true)}
            disabled={selectedPhotos.length === 0}
            style={{ opacity: selectedPhotos.length === 0 ? 0.5 : 1 }}
          >
            🔄 旋轉
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
          reason={duplicateItems[duplicateIndex].reason}
          tempPhoto={{
            url: duplicateItems[duplicateIndex].previewUrl,
            // 檔名一定要給：兩張縮圖長得幾乎一樣，這是使用者唯一分辨得出來的線索
            name: duplicateItems[duplicateIndex].file.name,
          }}
          existingPhotos={duplicateItems[duplicateIndex].existing.map((e) => ({
            id: e.id,
            url: e.thumb_url || '',
            // 放大看用 800px 那顆；舊版後端沒有這個欄位時退回縮圖
            largeUrl: e.thumb_lg || e.thumb_url || '',
            name: e.title || undefined,
            sameFile: e.same_file,
            taken_at: e.taken_at || undefined,
          }))}
          onResolve={(decision, replaceIds) => { resolveDuplicate(decision, replaceIds); }}
          onSkip={() => advanceDuplicate()}
          counter={{ current: duplicateIndex + 1, total: duplicateItems.length }}
          backgroundNote={dupJobs.queued > dupJobs.done
            ? `背景處理中 ${dupJobs.queued - dupJobs.done} 張`
            : undefined}
        />
      )}


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

      {/*
        * 旋轉只動 R2 那兩顆縮圖（Drive 的原始檔與 4K 不碰，那兩份本來就是正的）。
        * ⚠️ **成功之後不重抓（不呼叫 loadData）** —— 同那顆「不開放」的快速鎖：
        *    重抓一次捲軸就回頂端，一本幾千張的相簿要重新捲回剛剛那一格。
        *    後端換掉了 R2 的物件鍵、舊物件當場刪除，所以新網址要就地併回手上那一列，
        *    不套用那幾格就是破圖。
        */}
      <RotatePhotosModal
        isOpen={showRotate}
        photos={selectedPhotos.map((pid) => photos.find((p) => p.id === pid)).filter(Boolean) as Photo[]}
        onClose={() => setShowRotate(false)}
        onDone={({ rotated, failures, skipped }) => {
          const patch = new Map(rotated.map((r) => [r.id, r]));
          setPhotos((prev) => prev.map((p) => {
            const r = patch.get(p.id);
            // ⚠️ thumb_sm_url 的 null 是有主張的（後端已經把欄位清成 NULL），
            //    留著舊值會指向一顆剛被刪掉的物件
            return r ? { ...p, url: r.url, thumb_url: r.thumb_url, thumb_sm_url: r.thumb_sm_url ?? undefined } : p;
          }));
          // 封面存的是網址不是 id，換了鍵就要跟著換，不然首頁那張變破圖
          const cover = rotated.find((r) => currentCoverPhotoUrl && photos.find((p) => p.id === r.id)?.url === currentCoverPhotoUrl);
          if (cover) setCurrentCoverPhotoUrl(cover.url);
          setSelectedPhotos([]);
          lastSelectedIndexRef.current = null;
          // 失敗一律逐張講原因，收工一次講完 —— 批次跑到一半 alert 會蓋住還在跑的那幾張
          const parts = [`已旋轉 ${rotated.length} 張`];
          if (skipped > 0) parts.push(`${skipped} 個影片／GIF 未處理`);
          let msg = parts.join('，');
          if (failures.length > 0) {
            // 每一張各自一行，`，` 串起來會擠成一團看不出有幾張
            msg += `，${failures.length} 張失敗：
${failures.join(`
`)}`;
          }
          alert(msg);
        }}
      />

      {/* titles 是原始檔名，只給「指定時間」那個模式預填用（VID_20260824_143000.mp4） */}
      <FixTimeModal
        isOpen={showFixTime}
        photoIds={selectedPhotos}
        titles={selectedPhotos.map((id) => photos.find((p) => p.id === id)?.title ?? '')}
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
