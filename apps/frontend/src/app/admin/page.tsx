"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import styles from "./admin.module.css";
import {
  CONVOY_PCT_DEFAULT, CONVOY_PCT_MAX, CONVOY_PCT_MIN,
  DriveAuditAlbumReport, DriveAuditState, PurgePreview, TrackFolderSync,
  UserContributions, WhitelistUser,
  addWhitelistUser, auditOneAlbum, fetchDriveAudit, fetchPurgePreview, fetchSiteSettings,
  fetchUserContributions, fetchWhitelist, purgeWhitelistUser, removeWhitelistUser,
  runDriveAudit, syncTrackFolders, updateSiteSettings, updateWhitelistUser,
} from "@/lib/api";
import { useAdmin } from "@/lib/useAdmin";
import DrivePendingCard from "./DrivePendingCard";
import SlideConfirmModal from "@/components/SlideConfirmModal";
import Avatar from "@/components/Avatar";
import AvatarPicker from "@/components/AvatarPicker";

/**
 * 站長後台：誰能用 Google 登入進來當管理員，以及他們各自能動到什麼。
 *
 * **這一頁只是入口的門面，真正的閘門在後端** —— `/api/admin/*` 一律先確認
 * 呼叫者是 role='owner' 的那一列，非站長就算把網址背起來也只會拿到 403。
 *
 * 「移出白名單」＝**停權**（見 removeWhitelistUser）：那一列會留著、active=0，
 * 他的相簿照片原封不動，隨時可以加回來。「刪除帳號」才是真的把列刪掉，不可逆，
 * 而且要另外勾要不要連他的內容一起清（見 purgeWhitelistUser）。
 *
 * 這一頁是**唯一**的管理員入口 —— 不在這份名單上的 Google 帳號一律登不進來，
 * 沒有環境變數之類的第二條路。
 */
export default function AdminPage() {
  const { isOwner, checking, isAdmin, user: me, setMyAvatar } = useAdmin();

  const [users, setUsers] = useState<WhitelistUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 正在等後端回應的那一列，避免連點 */
  const [busyId, setBusyId] = useState<number | null>(null);

  // 新增表單
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newCanManage, setNewCanManage] = useState(false);
  /*
   * 新加入的人**預設不給**足跡工具（見 migrations/0016）。
   * 欄位本身是 DEFAULT 1，那是為了不動到現有成員；「新增時決定給不給」是這裡。
   */
  const [newCanUseTools, setNewCanUseTools] = useState(false);
  const [adding, setAdding] = useState(false);

  /*
   * Drive 備份對帳。**這一份是唯讀報告，跑對帳的是 cron**（十分鐘一次、一次一本，
   * 掃完一輪就休息一天）—— 這裡只是把結果拿回來看，外加三顆手動的按鈕。
   *
   * 不在進頁時自動抓：這一頁平常是來加人、改權限的，多打一次請求沒必要。
   */
  const [audit, setAudit] = useState<DriveAuditState | null>(null);
  const [auditBusy, setAuditBusy] = useState<null | "load" | "run" | "reset" | "trash" | "one">(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditNote, setAuditNote] = useState<string | null>(null);

  /*
   * 「單獨對一本」的結果。跟上面那份整輪報告**是兩件事**，所以另外存一份：
   * 那一趟刻意不推游標、不累加 totals（見後端 /api/admin/drive-audit 的註解），
   * 混在一起會讓整輪的數字看起來被算了兩次。
   */
  const [auditAlbumId, setAuditAlbumId] = useState<number | "">("");
  const [albumReport, setAlbumReport] = useState<DriveAuditAlbumReport | null>(null);

  const runOneAlbum = async () => {
    if (auditBusy || auditAlbumId === "") return;
    setAuditBusy("one");
    setAuditError(null);
    setAuditNote(null);
    try {
      setAlbumReport(await auditOneAlbum(Number(auditAlbumId)));
    } catch (e) {
      setAlbumReport(null);
      setAuditError(e instanceof Error ? e.message : "對帳失敗");
    } finally {
      setAuditBusy(null);
    }
  };

  const withAudit = async (
    kind: "load" | "run" | "reset" | "trash",
    fn: () => Promise<DriveAuditState & { revived?: number }>,
  ) => {
    if (auditBusy) return;
    setAuditBusy(kind);
    setAuditError(null);
    setAuditNote(null);
    try {
      const state = await fn();
      setAudit(state);
      if (kind === "trash") {
        setAuditNote(
          state.revived
            ? `救回 ${state.revived} 筆待搬，已經重新試過一次`
            : "沒有放棄的待搬項目",
        );
        // 救回來的那幾筆是待搬佇列的事，報告本身沒變 —— 重抓一次才看得到新的數字
        setAudit(await fetchDriveAudit());
      }
    } catch (e) {
      setAuditError(e instanceof Error ? e.message : "對帳失敗");
    } finally {
      setAuditBusy(null);
    }
  };

  /** 正在確認移除的那個人 */
  const [removing, setRemoving] = useState<WhitelistUser | null>(null);

  /*
   * 展開中的「明細」。key 是 user id：
   *   沒有這個 key  ＝ 沒展開過
   *   undefined     ＝ 正在載入
   *   物件          ＝ 已經載到，再點只是收合，不重打
   *
   * 每個人各要一次請求，所以載過就留著。權限改了不影響這份（那是誰動得了什麼，
   * 不是誰傳了什麼），只有刪照片／刪帳號才需要重讀 —— 那兩件事都會 load()。
   */
  const [details, setDetails] = useState<Record<number, UserContributions | undefined>>({});
  const [openDetail, setOpenDetail] = useState<number | null>(null);
  const [detailError, setDetailError] = useState<Record<number, string>>({});

  const toggleDetail = async (user: WhitelistUser) => {
    if (openDetail === user.id) { setOpenDetail(null); return; }
    setOpenDetail(user.id);
    if (user.id in details && details[user.id]) return;
    setDetails((d) => ({ ...d, [user.id]: undefined }));
    setDetailError((e) => { const next = { ...e }; delete next[user.id]; return next; });
    try {
      const data = await fetchUserContributions(user.id);
      setDetails((d) => ({ ...d, [user.id]: data }));
    } catch (err: any) {
      setDetailError((e) => ({ ...e, [user.id]: err.message || "讀取失敗" }));
    }
  };

  /**
   * 展開換頭像的那個人。**站長代設**用的 —— 家人自己在右上角的帳號牌就能換，
   * 這裡是給「他自己弄不來」的情況（跟明細一樣一次只開一個，整排都攤開會很吵）。
   */
  const [openAvatar, setOpenAvatar] = useState<number | null>(null);

  /** 正在確認**刪除帳號**的那個人。跟 removing 是兩件事，所以兩個 state */
  const [purging, setPurging] = useState<WhitelistUser | null>(null);
  /** 他名下有多少東西。開視窗時才去問（那個查詢要掃 Photo，不能塞在清單裡） */
  const [preview, setPreview] = useState<PurgePreview | null>(null);
  const [dropAlbums, setDropAlbums] = useState(false);
  const [dropPhotos, setDropPhotos] = useState(false);
  const [dropTracks, setDropTracks] = useState(false);

  /** 站台開關：訪客看不看得到足跡地圖。null = 還沒讀到 */
  const [guestMap, setGuestMap] = useState<boolean | null>(null);
  const [savingGuestMap, setSavingGuestMap] = useState(false);
  /**
   * 站台開關：訪客看不看得到留言。**預設關**。
   * 訪客永遠寫不了（資料模型上就沒有訪客這個作者），所以只有「看」這一格。
   */
  const [guestComments, setGuestComments] = useState<boolean | null>(null);
  const [savingGuestComments, setSavingGuestComments] = useState(false);
  /**
   * 站台開關：不開放的照片要不要連「看得到的人」也先蓋一層模糊。**預設關**。
   *
   * ⚠️ 這一格**不是權限**。沒權限的人手上根本沒有那幾張（後端 SQL 就濾掉了），
   * 開關管的是站長與可管理全站內容的人自己那一份畫面。
   */
  const [restrictedBlur, setRestrictedBlur] = useState<boolean | null>(null);
  const [savingRestrictedBlur, setSavingRestrictedBlur] = useState(false);

  /*
   * 同遊門檻。拉桿有兩份值：`convoyPct` 是手指現在拖到哪（每動一格就變），
   * `savedConvoyPct` 是後端真正存著的那個。
   *
   * 分成兩份是為了**不要邊拖邊送** —— range 的 onChange 一次拖曳會觸發幾十次，
   * 每次都 PUT 等於幾十次 D1 寫入。放手（pointerup／鍵盤放開）才送，
   * 而且只在兩份值不同時送，避免只是點一下拉桿也白寫一次。
   */
  const [convoyPct, setConvoyPct] = useState<number | null>(null);
  const [savedConvoyPct, setSavedConvoyPct] = useState<number | null>(null);
  const [savingConvoy, setSavingConvoy] = useState(false);

  /*
   * GPS 軌跡資料夾的掃描結果。**刻意不在開頁時就跑** —— 那是一次 Google Drive
   * API 往返，而這一頁大多數時候是來加人或改權限的，資料夾設好之後幾年不會再動。
   * null ＝ 還沒按過那顆按鈕。
   */
  const [scan, setScan] = useState<TrackFolderSync | null>(null);
  const [scanning, setScanning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, settings] = await Promise.all([fetchWhitelist(), fetchSiteSettings()]);
      setUsers(list);
      setGuestMap(settings.guest_can_view_map === 1);
      setGuestComments(settings.guest_can_view_comments === 1);
      setConvoyPct(settings.convoy_overlap_pct);
      setSavedConvoyPct(settings.convoy_overlap_pct);
      setRestrictedBlur(settings.restricted_blur === 1);
      setError(null);
    } catch (e: any) {
      setError(e.message || "讀取白名單失敗");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!checking && isOwner) load();
    else if (!checking) setLoading(false);
  }, [checking, isOwner, load]);

  const handleAdd = async () => {
    const email = newEmail.trim();
    if (!email || adding) return;
    setAdding(true);
    setNotice(null);
    const result = await addWhitelistUser(email, newName.trim(), newCanManage, newCanUseTools);
    setAdding(false);
    if (!result.success) return setError(result.message || "新增失敗");
    setError(null);
    setNotice(result.restored
      ? `${email} 之前被停權過，已經重新啟用。`
      : `${email} 已加入白名單，他用 Google 登入就進得來了。`);
    setNewEmail("");
    setNewName("");
    setNewCanManage(false);
    setNewCanUseTools(false);
    load();
  };

  const patch = async (
    user: WhitelistUser,
    body: {
      can_manage_others?: boolean; active?: boolean;
      can_add_to_others?: boolean; can_reorder_others?: boolean;
      can_comment?: boolean; can_view_comments?: boolean; can_view_map?: boolean;
      can_use_tools?: boolean;
    },
  ) => {
    setBusyId(user.id);
    setNotice(null);
    const result = await updateWhitelistUser(user.id, body);
    setBusyId(null);
    if (!result.success) return setError(result.message || "修改失敗");
    setError(null);
    load();
  };

  const runScan = async () => {
    setScanning(true);
    setNotice(null);
    try {
      const data = await syncTrackFolders();
      setScan(data);
      setError(null);
      const changed = data.results.filter((r) => r.status === "updated");
      setNotice(changed.length
        ? `已自動綁定 ${changed.length} 人：${changed.map((r) => `${r.name}（${r.folder_name}）`).join("、")}。他們在地圖上按「從 Drive 同步」就讀得到自己的軌跡了。`
        : "掃完了，沒有需要變更的綁定。");
      // 綁定寫在 User 上，重讀白名單才不會讓下面那些列停在舊值
      load();
    } catch (e: any) {
      setError(e.message || "掃描分享資料夾失敗");
    }
    setScanning(false);
  };

  const toggleGuestMap = async (next: boolean) => {
    setSavingGuestMap(true);
    setNotice(null);
    const result = await updateSiteSettings({ guest_can_view_map: next });
    setSavingGuestMap(false);
    if (!result.success) return setError(result.message || "修改失敗");
    setError(null);
    setGuestMap(result.settings!.guest_can_view_map === 1);
    setNotice(next
      ? "訪客現在看得到足跡地圖了。"
      : "訪客看不到足跡地圖了，首頁那個連結也會消失。");
  };

  /** 放手才送。值沒變就什麼都不做 —— 點一下拉桿不該產生一次寫入 */
  const commitConvoyPct = async () => {
    if (convoyPct === null || savingConvoy || convoyPct === savedConvoyPct) return;
    const next = convoyPct;
    setSavingConvoy(true);
    setNotice(null);
    const result = await updateSiteSettings({ convoy_overlap_pct: next });
    setSavingConvoy(false);
    if (!result.success) {
      // 存不進去就把拉桿彈回後端真正的值，不要讓畫面顯示一個沒生效的數字
      setConvoyPct(savedConvoyPct);
      return setError(result.message || "修改失敗");
    }
    setError(null);
    const saved = result.settings!.convoy_overlap_pct;
    setConvoyPct(saved);
    setSavedConvoyPct(saved);
    setNotice(`同遊門檻改成 ${saved}%。大家下次重整地圖就會用新的判定。`);
  };

  const toggleGuestComments = async (next: boolean) => {
    setSavingGuestComments(true);
    setNotice(null);
    const result = await updateSiteSettings({ guest_can_view_comments: next });
    setSavingGuestComments(false);
    if (!result.success) return setError(result.message || "修改失敗");
    setError(null);
    setGuestComments(result.settings!.guest_can_view_comments === 1);
    setNotice(next
      ? "訪客現在看得到照片底下的留言了（還是留不了言）。"
      : "訪客看不到留言了，燈箱裡那一塊會整個消失。");
  };

  const toggleRestrictedBlur = async (next: boolean) => {
    setSavingRestrictedBlur(true);
    setNotice(null);
    const result = await updateSiteSettings({ restricted_blur: next });
    setSavingRestrictedBlur(false);
    if (!result.success) return setError(result.message || "修改失敗");
    setError(null);
    setRestrictedBlur(result.settings!.restricted_blur === 1);
    setNotice(next
      ? "不開放的照片現在會先蓋一層模糊，點一下才暫時看得到。重整之後又蓋回去。"
      : "不開放的照片恢復正常顯示（其他人本來就看不到那幾張）。");
  };

  const handleRemove = async () => {
    const user = removing;
    setRemoving(null);
    if (!user) return;
    setBusyId(user.id);
    setNotice(null);
    const result = await removeWhitelistUser(user.id);
    setBusyId(null);
    if (!result.success) return setError(result.message || "移除失敗");
    setError(null);
    setNotice(
      `${user.email} 已停權，登不進來了。`
      + (result.albumCount
        ? `他名下的 ${result.albumCount} 本相簿原封不動留著。`
        : "")
      + "帳號留在名單上（標示為停權），要放他回來直接再加一次就好。",
    );
    load();
  };

  /*
   * 打開刪除視窗。三個勾選一律從「不勾」開始 —— 預設值決定了手滑的後果，
   * 而這裡手滑的後果是別人的照片從 R2 消失。
   */
  const openPurge = (user: WhitelistUser) => {
    setPurging(user);
    setPreview(null);
    setDropAlbums(false);
    setDropPhotos(false);
    setDropTracks(false);
    setNotice(null);
    fetchPurgePreview(user.id)
      .then((p) => setPreview(p))
      .catch((e) => {
        setPurging(null);
        setError(e.message || "讀取失敗");
      });
  };

  const handlePurge = async () => {
    const user = purging;
    const scope = { albums: dropAlbums, photos: dropPhotos, tracks: dropTracks };
    setPurging(null);
    if (!user) return;
    setBusyId(user.id);
    setNotice(null);
    const result = await purgeWhitelistUser(user.id, scope);
    setBusyId(null);
    if (!result.success) return setError(result.message || "刪除失敗");
    setError(null);
    const parts = [`${user.email} 的帳號已經刪掉了。`];
    if (result.deletedAlbums) parts.push(`一併刪掉 ${result.deletedAlbums} 本相簿。`);
    if (result.deletedPhotos) parts.push(`一併刪掉 ${result.deletedPhotos} 張照片（Drive 上的備份會搬進 trash/）。`);
    if (result.keptAlbums) parts.push(`保留下來的 ${result.keptAlbums} 本相簿已經改掛在你名下。`);
    if (result.deletedTrackDays) parts.push(`一併刪掉 ${result.deletedTrackDays} 天的足跡。`);
    if (result.keptTrackDays) parts.push(`保留下來的 ${result.keptTrackDays} 天足跡已經改掛在你名下。`);
    setNotice(parts.join(""));
    load();
  };

  /*
   * 要綁資料夾的人 —— 站長自己不在裡面。他沒綁的時候後端會退回
   * GOOGLE_DRIVE_FOLDER_ID 那顆環境變數（見 trackFolderFor），所以對他寫
   * 「還沒綁定，他同步不到任何軌跡」是錯的，他同步得到。這一段是拿來對
   * 家人的資料夾的，站長不該出現在自己的待辦清單裡。
   */
  const trackTargets = users.filter((u) => u.active === 1 && u.role !== "owner");

  if (checking) return <div className={styles.container} />;

  /*
   * 不是站長就什麼都不解釋。訪客只會是自己打網址進來的（站內沒有任何連結指到這裡），
   * 對他講「請以站長身分登入」等於在提示還有別的身分可以換 —— 使用者要的是
   * 訪客只有看跟登出。家庭成員則講清楚，免得以為是壞掉了。
   */
  if (!isOwner) {
    return (
      <div className={styles.container}>
        <Link href="/" className={styles.back}>← 回相簿</Link>
        <h1 className={styles.title}>找不到這一頁</h1>
        {isAdmin && (
          <p className={styles.hint}>
            後台設定只有站長看得到。你可以管理自己的相簿與照片，但白名單不在你的權限範圍內。
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <Link href="/" className={styles.back}>← 回相簿</Link>
        <h1 className={styles.title}>後台設定</h1>
        <p className={styles.hint}>
          只有白名單上的信箱能用「家庭成員登入」進來。預設每個人只動得了自己建的相簿與自己上傳的照片；
          勾了「可管理全站內容」才動得了別人的東西，也才碰得到相簿排序、GPS 軌跡這類全站共用的設定。
        </p>
      </header>

      {error && <p className={`${styles.message} ${styles.err}`}>{error}</p>}
      {notice && <p className={`${styles.message} ${styles.ok}`}>{notice}</p>}

      <section className={`glass-panel ${styles.card}`}>
        <h2 className={styles.sectionTitle}>訪客能看到什麼</h2>
        <p className={styles.hint}>
          用通行密碼進站的訪客預設只看得到相簿。足跡地圖會把照片的實際位置畫在地圖上
          （已經標成不公開的相簿與照片仍然不會出現），要不要給訪客看由你決定。
        </p>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={guestMap === true}
            disabled={guestMap === null || savingGuestMap}
            onChange={(e) => toggleGuestMap(e.target.checked)}
          />
          讓訪客看足跡地圖
        </label>

        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={guestComments === true}
            disabled={guestComments === null || savingGuestComments}
            onChange={(e) => toggleGuestComments(e.target.checked)}
          />
          讓訪客看照片底下的留言
        </label>
        <p className={styles.hint}>
          訪客<strong>永遠留不了言</strong>，這格只管看不看得到。家人之間的對話會連名字一起被
          訪客看見，開之前先想一下留言區裡都講了些什麼。
        </p>
      </section>

      <section className={`glass-panel ${styles.card}`}>
        <h2 className={styles.sectionTitle}>不開放的照片</h2>
        <p className={styles.hint}>
          標成「不開放」的照片<strong>只有你跟可管理全站內容的人看得到</strong>，
          其他成員與訪客的相簿、搜尋、地圖上那一格整個不存在 —— 那是權限，一直都在。
          這裡這一格管的是<strong>你自己那一份畫面</strong>：捲到那幾張的時候要不要先糊著。
        </p>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={restrictedBlur === true}
            disabled={restrictedBlur === null || savingRestrictedBlur}
            onChange={(e) => toggleRestrictedBlur(e.target.checked)}
          />
          不開放的照片先蓋一層模糊（縮圖與燈箱都算）
        </label>
        <p className={styles.hint}>
          點那一張一下就暫時掀開，再點角標上的「收回」蓋回去；
          <strong>重整或關掉分頁就全部蓋回去</strong>，不會記住。
          用途是旁邊剛好有人看著螢幕的時候，捲相簿不會整片跳出來。
        </p>
      </section>

      <section className={`glass-panel ${styles.card}`}>
        <h2 className={styles.sectionTitle}>足跡地圖：一起出遊的判定</h2>
        <p className={styles.hint}>
          播放足跡時，一起出遊的人會合體成同一台車。判定的方式是拿兩個人
          <strong>貼路之後的移動路線</strong>逐趟比對：同一趟裡，走在對方那條路上
          （相隔五分鐘以內經過）的比例超過這個門檻，整趟就算一起出遊，
          動畫預設是合併的，只有中途真的分頭走一段才會拆開。
        </p>
        <div className={styles.sliderRow}>
          <input
            type="range"
            min={CONVOY_PCT_MIN}
            max={CONVOY_PCT_MAX}
            step={5}
            value={convoyPct ?? CONVOY_PCT_DEFAULT}
            disabled={convoyPct === null || savingConvoy}
            onChange={(e) => setConvoyPct(Number(e.target.value))}
            // 放手才送，理由見 commitConvoyPct。鍵盤（左右鍵）也要有一份，
            // 只綁 pointerup 的話用鍵盤調完永遠不會存
            onPointerUp={commitConvoyPct}
            onKeyUp={commitConvoyPct}
            aria-label="一起出遊的重疊率門檻"
          />
          <span className={styles.sliderValue}>
            {convoyPct === null ? "…" : `${convoyPct}%`}
          </span>
        </div>
        <p className={styles.hint}>
          真的同車的兩份軌跡貼完路通常重疊九成以上，
          <strong>預設 {CONVOY_PCT_DEFAULT}%</strong> 已經留了不少餘裕給停車場、路口岔開。
          調低會讓「順路載一段」也算成一起出遊；調高則只有整趟幾乎一模一樣才合體。
          改完不必重貼路，家人下次開地圖就是新的判定。
        </p>
      </section>

      <section className={`glass-panel ${styles.card}`}>
        <h2 className={styles.sectionTitle}>加入白名單</h2>
        <div className={styles.formRow}>
          <div className={styles.field}>
            <label htmlFor="new-email">Google 信箱</label>
            <input
              id="new-email"
              type="email"
              value={newEmail}
              placeholder="someone@example.com"
              onChange={(e) => setNewEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="new-name">顯示名稱（可留白）</label>
            <input
              id="new-name"
              type="text"
              value={newName}
              placeholder="他自己之後也改得動"
              maxLength={40}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            />
          </div>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={newCanManage}
              onChange={(e) => setNewCanManage(e.target.checked)}
            />
            可管理全站內容
          </label>
          <label className={styles.checkbox} title="給了才動得了足跡：同步 Drive、上傳 GPX、匯入 Google 時間軸">
            <input
              type="checkbox"
              checked={newCanUseTools}
              onChange={(e) => setNewCanUseTools(e.target.checked)}
            />
            可用足跡工具
          </label>
          <button
            type="button"
            className={`${styles.button} ${styles.primary}`}
            onClick={handleAdd}
            disabled={!newEmail.trim() || adding}
          >
            {adding ? "新增中..." : "加入"}
          </button>
        </div>
      </section>

      <section className={`glass-panel ${styles.card}`}>
        <h2 className={styles.sectionTitle}>白名單（{users.length}）</h2>
        {loading ? (
          <p className={styles.hint}>讀取中...</p>
        ) : users.length === 0 ? (
          <p className={styles.hint}>目前只有你自己。</p>
        ) : (
          users.map((user) => {
            const owner = user.role === "owner";
            const busy = busyId === user.id;
            return (
              <div key={user.id} className={styles.userRow}>
                <Avatar
                  src={user.avatar}
                  name={user.name || user.email}
                  color={user.track_color ?? "#8a7f72"}
                  size={38}
                />
                <div className={styles.userMain}>
                  <div className={styles.userName}>
                    {user.name || "（未命名）"}
                    {owner && <span className={styles.tag}>站長</span>}
                    {!owner && user.active !== 1 && (
                      <span className={`${styles.tag} ${styles.tagOff}`}>已停權</span>
                    )}
                  </div>
                  <div className={styles.userMeta}>{user.email}</div>
                  {/*
                    * 「上傳」是照 uploaded_by 算的，含他傳進**別人**相簿的那些。
                    * 這裡刻意不印 user.photo_count（他的相簿裡總共幾張）——
                    * 那個數字含別人傳進來的，擺在人名底下會被讀成「他傳了這麼多」。
                    * 它該出現的地方是刪除視窗，還有底下明細裡的「其中 X 張是別人傳的」。
                    */}
                  <div className={styles.userMeta}>
                    建立 {user.album_count} 本相簿 · 上傳 {user.uploaded_count} 張照片
                    {" · "}
                    {user.last_login_at
                      ? `最後登入 ${new Date(user.last_login_at.replace(" ", "T") + "Z").toLocaleString()}`
                      : "還沒登入過"}
                    {(user.album_count > 0 || user.uploaded_count > 0) && (
                      <>
                        {" · "}
                        <button
                          type="button"
                          className={styles.linkButton}
                          onClick={() => toggleDetail(user)}
                        >
                          {openDetail === user.id ? "▾ 明細" : "▸ 明細"}
                        </button>
                      </>
                    )}
                    {" · "}
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={() => setOpenAvatar((v) => (v === user.id ? null : user.id))}
                    >
                      {openAvatar === user.id ? "▾ 頭像" : "▸ 頭像"}
                    </button>
                  </div>

                  {openAvatar === user.id && (
                    <div className={styles.detail}>
                      <AvatarPicker
                        userId={user.id}
                        current={user.avatar}
                        name={user.name || user.email}
                        color={user.track_color ?? "#8a7f72"}
                        onChange={(avatar) => {
                          setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, avatar } : u)));
                          // 站長在這裡換自己的，右上角那顆圓鈕也要跟著換
                          if (user.id === me?.id) setMyAvatar(avatar);
                        }}
                      />
                    </div>
                  )}

                  {openDetail === user.id && (
                    <div className={styles.detail}>
                      {detailError[user.id] ? (
                        <p className={styles.hint}>{detailError[user.id]}</p>
                      ) : !details[user.id] ? (
                        <p className={styles.hint}>讀取中...</p>
                      ) : (
                        <>
                          {details[user.id]!.own_albums.length > 0 && (
                            <>
                              <div className={styles.detailHead}>他建立的相簿</div>
                              {details[user.id]!.own_albums.map((a) => (
                                <div key={a.album_id} className={styles.detailRow}>
                                  <Link href={`/album?id=${a.album_id}`} className={styles.detailName}>
                                    {a.album_name}
                                  </Link>
                                  <span className={styles.detailNum}>
                                    {a.uploaded} 張
                                    {/* 差額就是別人傳進來的。不講的話「他建的相簿有 5 張
                                        但他只傳了 1 張」看起來像算錯 */}
                                    {a.total > a.uploaded && (
                                      <span className={styles.detailNote}>
                                        （另有 {a.total - a.uploaded} 張是別人傳的）
                                      </span>
                                    )}
                                    {a.total === 0 && <span className={styles.detailNote}>（空相簿）</span>}
                                  </span>
                                </div>
                              ))}
                            </>
                          )}

                          {details[user.id]!.elsewhere.length > 0 && (
                            <>
                              <div className={styles.detailHead}>他傳進別人的相簿</div>
                              {details[user.id]!.elsewhere.map((a) => (
                                <div key={a.album_id} className={styles.detailRow}>
                                  <Link href={`/album?id=${a.album_id}`} className={styles.detailName}>
                                    {a.album_name}
                                    <span className={styles.detailNote}>
                                      （{a.owner_name || "未命名"} 的）
                                    </span>
                                  </Link>
                                  <span className={styles.detailNum}>{a.uploaded} 張</span>
                                </div>
                              ))}
                            </>
                          )}

                          {details[user.id]!.own_albums.length === 0
                            && details[user.id]!.elsewhere.length === 0 && (
                            <p className={styles.hint}>還沒有建過相簿，也還沒傳過照片。</p>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div className={styles.actions}>
                  {/* 站長的權限不能在這裡改（後端也會擋）—— 唯一的站長把自己降權之後
                      就沒有人能改回來了 */}
                  <label className={styles.checkbox} title={owner ? "站長本來就是全開" : undefined}>
                    <input
                      type="checkbox"
                      checked={owner || user.can_manage_others === 1}
                      disabled={owner || busy || user.active !== 1}
                      onChange={(e) => patch(user, { can_manage_others: e.target.checked })}
                    />
                    可管理全站內容
                  </label>

                  {/*
                    * 「可管理全站」底下的兩格細項。勾了全站就一律全開（後端也是
                    * 這樣算的），所以那時這兩顆顯示成打勾且不能動 —— 讓它們維持
                    * 原本的樣子只會讓人以為關得掉。
                    *
                    * 加照片預設就是開的：家人本來就該傳得進彼此的相簿，
                    * 這裡是為了「某個帳號要單獨關掉」而存在。
                    */}
                  <label
                    className={styles.checkbox}
                    title="可以把照片上傳／匯入到別人建的相簿。加進去的照片相簿主人隨時刪得掉"
                  >
                    <input
                      type="checkbox"
                      checked={owner || user.can_manage_others === 1 || user.can_add_to_others === 1}
                      disabled={owner || busy || user.active !== 1 || user.can_manage_others === 1}
                      onChange={(e) => patch(user, { can_add_to_others: e.target.checked })}
                    />
                    可加照片到別人的相簿
                  </label>

                  <label
                    className={styles.checkbox}
                    title="可以拖曳調整別人相簿裡的照片順序。原本的順序沒有留底，改了救不回來"
                  >
                    <input
                      type="checkbox"
                      checked={owner || user.can_manage_others === 1 || user.can_reorder_others === 1}
                      disabled={owner || busy || user.active !== 1 || user.can_manage_others === 1}
                      onChange={(e) => patch(user, { can_reorder_others: e.target.checked })}
                    />
                    可排序別人的相簿
                  </label>

                  {/*
                    * 留言的兩格。**刻意不掛在「可管理全站」底下** —— 那格講的是
                    * 動不動得了別人的東西，跟看不看得到家人的對話沒有關係，
                    * 所以這兩顆在勾了全站的人身上照樣按得動。
                    *
                    * 看留言關掉的人，燈箱裡整塊留言區直接不出現。
                    */}
                  <label
                    className={styles.checkbox}
                    title="關掉之後他在燈箱裡看不到留言區（連別人的留言也看不到）"
                  >
                    <input
                      type="checkbox"
                      checked={owner || user.can_view_comments === 1}
                      disabled={owner || busy || user.active !== 1}
                      onChange={(e) => patch(user, { can_view_comments: e.target.checked })}
                    />
                    可看留言
                  </label>

                  <label
                    className={styles.checkbox}
                    title="關掉之後他還是看得到留言，只是沒有輸入框"
                  >
                    <input
                      type="checkbox"
                      checked={owner || user.can_comment === 1}
                      disabled={owner || busy || user.active !== 1}
                      onChange={(e) => patch(user, { can_comment: e.target.checked })}
                    />
                    可留言
                  </label>

                  {/*
                    * 足跡也是同一類的獨立開關（`can_view_map`，見 migrations/0014）。
                    * 關掉的人首頁不會出現地圖入口，直接打網址會看到「找不到這一頁」，
                    * 後端所有軌跡路由也一律 403 —— 不是只把畫面藏起來。
                    *
                    * 訪客那一層是上面的全站開關（guest_can_view_map），兩者互不相干。
                    */}
                  <label
                    className={styles.checkbox}
                    title="關掉之後他看不到足跡地圖（連自己的軌跡也看不到），首頁不會出現地圖入口"
                  >
                    <input
                      type="checkbox"
                      checked={owner || user.can_view_map === 1}
                      disabled={owner || busy || user.active !== 1}
                      onChange={(e) => patch(user, { can_view_map: e.target.checked })}
                    />
                    可看足跡
                  </label>

                  {/*
                    * 「看得到」跟「寫得進去」是兩件事（`can_use_tools`，見 migrations/0016）。
                    * 這格關掉的人照樣看得到地圖與自己的軌跡，只是 /map 上那塊工具區
                    * 整塊不出現，進頁面的自動同步與自動貼路也不跑，後端那 10 支
                    * 寫入路由一律 403。
                    *
                    * 現有成員一律是開的（migration DEFAULT 1），**新加入的預設不給** ——
                    * 上面新增表單那顆勾勾預設不勾。
                    */}
                  <label
                    className={styles.checkbox}
                    title="關掉之後他還是看得到地圖，只是不能同步 Drive、上傳 GPX、匯入 Google 時間軸"
                  >
                    <input
                      type="checkbox"
                      checked={owner || user.can_use_tools === 1}
                      disabled={owner || busy || user.active !== 1}
                      onChange={(e) => patch(user, { can_use_tools: e.target.checked })}
                    />
                    可用足跡工具
                  </label>

                  {!owner && user.active !== 1 && (
                    <button
                      type="button"
                      className={styles.button}
                      disabled={busy}
                      onClick={() => patch(user, { active: true })}
                    >
                      重新啟用
                    </button>
                  )}

                  {!owner && user.active === 1 && (
                    <button
                      type="button"
                      className={`${styles.button} ${styles.danger}`}
                      disabled={busy}
                      onClick={() => setRemoving(user)}
                    >
                      移出白名單
                    </button>
                  )}

                  {/* 停權中的人也刪得掉 —— 「不讓他進來」跟「把他抹掉」是兩件事，
                      而且通常是先停權觀望一陣子才決定要不要真的刪 */}
                  {!owner && (
                    <button
                      type="button"
                      className={`${styles.button} ${styles.danger}`}
                      disabled={busy}
                      onClick={() => openPurge(user)}
                    >
                      刪除帳號
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </section>

      {/*
        Drive 備份對帳。站上一張照片，Drive 上就該有一份 4K ＋ 一份原始檔
        （影片只有原始檔一份）。上傳與刪除都可能在半路失敗，兩邊因此會慢慢走鐘，
        而走鐘是**安靜的** —— 這一格就是把它變成看得見的數字。
      */}
      <section className={`glass-panel ${styles.card}`}>
        <h2 className={styles.sectionTitle}>Drive 備份對帳</h2>
        <p className={styles.hint}>
          站上一張照片，Drive 上就該有<strong>一份 4K ＋ 一份原始檔</strong>
          （影片沒有 4K，只有原始檔一份）。系統每十分鐘自己對一本相簿，
          對完一輪休息一天。這裡看得到最近一輪的結果，也可以手動催。
          想知道<strong>某一本到底哪幾張要補、哪幾張不用</strong>，
          先按「看最新結果」載入相簿清單，再用下面那個選單單獨對那一本。
        </p>

        <div className={styles.formRow}>
          <button
            className={styles.button}
            disabled={auditBusy !== null}
            onClick={() => withAudit("load", fetchDriveAudit)}
          >
            {auditBusy === "load" ? "讀取中…" : "看最新結果"}
          </button>
          <button
            className={`${styles.button} ${styles.primary}`}
            disabled={auditBusy !== null}
            onClick={() => withAudit("run", () => runDriveAudit({ albums: 3 }))}
          >
            {auditBusy === "run" ? "對帳中…" : "現在對 3 本"}
          </button>
          <button
            className={styles.button}
            disabled={auditBusy !== null}
            onClick={() => withAudit("reset", () => runDriveAudit({ reset: true, albums: 3 }))}
          >
            {auditBusy === "reset" ? "重來中…" : "從第一本重新對"}
          </button>
        </div>

        {/*
          單獨對一本。相簿清單跟著 GET 一起回來（後端一句 SELECT id, name FROM Album）
          —— 刻意不打 /api/albums，那一支每本都要撈封面與預覽圖，這裡只要名字。
        */}
        {audit?.albums && audit.albums.length > 0 && (
          <div className={styles.formRow}>
            <div className={styles.field}>
              <label htmlFor="audit-album">單獨對一本（會列出逐張明細）</label>
              <select
                id="audit-album"
                className={styles.select}
                value={auditAlbumId}
                disabled={auditBusy !== null}
                onChange={(e) => setAuditAlbumId(e.target.value === "" ? "" : Number(e.target.value))}
              >
                <option value="">選一本相簿…</option>
                {audit.albums.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            <button
              className={`${styles.button} ${styles.primary}`}
              disabled={auditBusy !== null || auditAlbumId === ""}
              onClick={runOneAlbum}
            >
              {auditBusy === "one" ? "比對中…" : "全面比對這一本"}
            </button>
          </div>
        )}

        {auditError && <p className={`${styles.message} ${styles.err}`}>{auditError}</p>}
        {auditNote && <p className={`${styles.message} ${styles.ok}`}>{auditNote}</p>}

        {albumReport && <AlbumAuditReport report={albumReport} />}

        {audit && (
          <>
            <p className={styles.hint}>
              {audit.finished_at
                ? `上一輪對完於 ${new Date(audit.finished_at).toLocaleString("zh-TW")}`
                : audit.cursor > 0
                  ? `對到一半（已經對過 ${audit.albums_done} 本，下次從 id > ${audit.cursor} 接著）`
                  : "還沒對過"}
              {audit.last_run_at && `，最近一次執行 ${new Date(audit.last_run_at).toLocaleString("zh-TW")}`}
            </p>

            <div className={styles.detail}>
              <div className={styles.detailRow}>
                <span className={styles.detailName}>對過的相簿 / 照片</span>
                <span className={styles.detailNum}>{audit.totals.albums} / {audit.totals.photos}</span>
              </div>
              <div className={styles.detailRow}>
                <span className={styles.detailName}>兩份都在（不用補）</span>
                <span className={styles.detailNum}>{audit.totals.ok ?? 0}</span>
              </div>
              <div className={styles.detailRow}>
                <span className={styles.detailName}>缺 4K</span>
                <span className={styles.detailNum}>{audit.totals.missing_4k}</span>
              </div>
              <div className={styles.detailRow}>
                <span className={styles.detailName}>缺原始檔</span>
                <span className={styles.detailNum}>{audit.totals.missing_original}</span>
              </div>
              <div className={styles.detailRow}>
                <span className={styles.detailName}>檔案在、記錄漏掉（已自動接回來）</span>
                <span className={styles.detailNum}>{audit.totals.linked ?? 0}</span>
              </div>
              <div className={styles.detailRow}>
                <span className={styles.detailName}>Drive 上找不到（已清掉記錄，會出現在下面那份清單）</span>
                <span className={styles.detailNum}>{audit.totals.cleared}</span>
              </div>
              <div className={styles.detailRow}>
                <span className={styles.detailName}>只是被搬到別的資料夾（備份還在，沒動它）</span>
                <span className={styles.detailNum}>{audit.totals.moved}</span>
              </div>
              <div className={styles.detailRow}>
                <span className={styles.detailName}>沒人指著的檔，已排進 trash/</span>
                <span className={styles.detailNum}>{audit.totals.orphans_queued}</span>
              </div>
              <div className={styles.detailRow}>
                <span className={styles.detailName}>不是本站放的檔（一律不碰）</span>
                <span className={styles.detailNum}>{audit.totals.foreign}</span>
              </div>
            </div>

            <p className={styles.hint}>
              對帳比的是<strong>檔名</strong>：站上每一張該有的
              <span className={styles.mono}>&lt;編號&gt;_&lt;檔名&gt;</span>
              在那本相簿的 Drive 資料夾裡是不是都找得到。
              找得到卻沒記錄的會直接接回來（那是「傳上去了、網站沒記到」的下場，
              以前會變成一筆假的缺件<strong>加上</strong>一個假孤兒）。
              「缺 4K／缺原始檔」要補的話，<strong>把同一個原始檔再拖進那本相簿一次</strong>
              —— 站上會認出是同一個檔，直接補上缺的那一份，不會多一格
              （是哪幾個檔看下面那格「缺 Drive 備份的檔案」）。
              真正的 4K 只編得出來一次，R2 上那份縮圖補不了，所以非得要原始檔不可。
              孤兒檔是<strong>搬進 <span className={styles.mono}>didadida/trash/</span></strong>
              不是刪除，反悔隨時去 Drive 搬回來。
            </p>

            {audit.last_error && (
              <p className={`${styles.message} ${styles.err}`}>上次出錯：{audit.last_error}</p>
            )}

            {audit.reports.length > 0 && (
              <details className={styles.guide}>
                <summary className={styles.guideSummary}>逐本相簿的結果（{audit.reports.length}）</summary>
                <div className={styles.guideBody}>
                  {audit.reports.map((r) => (
                    <div key={r.album_id} className={styles.detailRow}>
                      <span className={styles.detailName}>{r.name}</span>
                      <span className={styles.detailNote}>
                        {r.error
                          ? `出錯：${r.error}`
                          : r.no_folder
                            ? `${r.photos} 張，Drive 上還沒有這本的資料夾`
                            : [
                                `${r.photos} 張`,
                                r.missing_4k > 0 ? `缺 4K ${r.missing_4k}` : "",
                                r.missing_original > 0 ? `缺原始檔 ${r.missing_original}` : "",
                                r.linked > 0 ? `接回記錄 ${r.linked}` : "",
                                r.cleared > 0 ? `Drive 上不見了 ${r.cleared}` : "",
                                r.moved > 0 ? `被搬走 ${r.moved}` : "",
                                r.orphans_queued > 0 ? `孤兒 ${r.orphans_queued}` : "",
                                r.foreign > 0 ? `外來檔 ${r.foreign}` : "",
                                r.truncated ? "（檔案太多沒列完，這本的判定不算數）" : "",
                              ].filter(Boolean).join("、")}
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            )}

            {/*
              待搬佇列。刪照片時 Drive 那一下失敗會試三次，三次都失敗就永遠躺在表裡 ——
              以前站上沒有任何地方看得到它，「Drive 刪除失敗」跳完就再也沒有下文。
            */}
            {audit.trash && (
              <>
                <p className={styles.hint}>
                  Drive 待搬（刪掉的照片要搬進 <span className={styles.mono}>trash/</span>）：
                  排隊中 <strong>{audit.trash.remaining}</strong>、
                  已放棄 <strong style={{ color: audit.trash.gave_up > 0 ? "#b91c1c" : undefined }}>
                    {audit.trash.gave_up}
                  </strong>。
                </p>
                {audit.trash.gave_up > 0 && (
                  <>
                    <div className={styles.formRow}>
                      <button
                        className={`${styles.button} ${styles.primary}`}
                        disabled={auditBusy !== null}
                        onClick={() => withAudit("trash", () => runDriveAudit({ retryTrash: true }))}
                      >
                        {auditBusy === "trash" ? "重試中…" : `重試放棄的 ${audit.trash.gave_up} 筆`}
                      </button>
                    </div>
                    <details className={styles.guide}>
                      <summary className={styles.guideSummary}>看卡住的是哪幾筆</summary>
                      <div className={styles.guideBody}>
                        {audit.trash.stuck.map((t) => (
                          <div key={t.id} className={styles.detailRow}>
                            <span className={styles.mono}>{t.drive_id}</span>
                            <span className={styles.detailNote}>
                              試了 {t.attempts} 次{t.last_error ? `：${t.last_error}` : ""}
                            </span>
                          </div>
                        ))}
                      </div>
                    </details>
                  </>
                )}
              </>
            )}
          </>
        )}
      </section>

      {/*
        缺 Drive 備份的檔案清單。跟上面那一格的分工：對帳是「有沒有走鐘」的
        總數與自動修正，這一格是「**到底是哪幾個檔、誰傳的、在哪一本**」。
        唯讀 —— 補的方法是把同一個原始檔再拖進那本相簿一次。
      */}
      <DrivePendingCard />

      {/*
        GPS 軌跡資料夾。為什麼要一個人一個資料夾：GPSLogger 只拿得到
        `drive.file` 權限（只碰得到自己建的檔），所以做不到「全家都上傳到
        站長的 Drive」。每個人傳進自己的 Drive，再把那個資料夾分享給站上的
        服務帳號，由這裡綁上去。
      */}
      <section className={`glass-panel ${styles.card}`}>
        <h2 className={styles.sectionTitle}>GPS 軌跡資料夾</h2>
        <p className={styles.hint}>
          每個人的 GPSLogger 都是傳進他自己的 Google Drive（手機 App 只碰得到自己建的資料夾，
          沒辦法直接傳到你這邊）。請他把那個資料夾<strong>分享</strong>給下面這個服務帳號，
          你再按一次掃描 —— 對得上信箱的會自動綁好，之後他在地圖上按「從 Drive 同步」
          就讀得到自己的軌跡。
        </p>
        <p className={styles.hint}>
          配對只認一件事：<strong>分享過來的資料夾，擁有者要是他登入本站的那個 Google 帳號</strong>。
          手機上如果是用另一個帳號設定 GPSLogger，這裡永遠對不到他。
        </p>

        {/*
          完整說明預設收起來。這一頁平常是來加人、改權限的，資料夾綁一次之後
          幾年不會再動 —— 一整篇步驟攤在這裡只會擋路。真的要設定的那一天才展開。
        */}
        <details className={styles.guide}>
          <summary className={styles.guideSummary}>設定步驟與疑難排解</summary>
          <div className={styles.guideBody}>
            <h3 className={styles.guideHead}>為什麼要一個人一個資料夾</h3>
            <p>
              GPSLogger 只拿得到「自己建立的檔案」這種權限，看不到也寫不進別人的資料夾，
              所以「全家都傳進站長的 Drive」做不到。每個人只能傳進自己的 Drive，
              各自把那個資料夾分享給站上的服務帳號，再由你在這裡對上人。
            </p>

            <h3 className={styles.guideHead}>請家人做的事（只做一次）</h3>
            <ol className={styles.guideList}>
              <li>
                從 <strong>F-Droid</strong> 安裝 GPSLogger（mendhak 版，v122 以上）。
                不要用 GitHub 下載的 APK —— 簽章對不上，Drive 授權會失敗；
                Play 商店那個同名的 BasicAirData GPS Logger 是另一套軟體，沒有自動上傳，不能用。
              </li>
              <li>
                <span className={styles.code}>Auto send, email and upload</span> →
                開啟 Allow auto sending → 目標選 Google Drive → 授權。
                <strong>授權時要選他登入這個站的那個 Google 帳號</strong> ——
                這裡選錯，後面就永遠自動對不上他。
                資料夾填<strong>單層名稱</strong>（例如 <span className={styles.code}>GPSLogger</span>），不要填路徑。
              </li>
              <li>
                三個一定要改：關掉 <span className={styles.code}>Send zip file</span>（預設是開的）、
                關掉 <span className={styles.code}>Prefix unique string to the file name</span>、
                <span className={styles.code}>New file creation</span> 選 <strong>Once a day</strong>。
              </li>
              <li>
                傳送頻率設 <strong>15 分鐘</strong>。auto-send 每次只送「當下那個檔」，
                跨過午夜就換成新的一天了，間隔太長會讓前一天最後那段永遠傳不上來。
              </li>
              <li>
                用設定頁裡的 <span className={styles.code}>Test upload</span> 按一下，確認 Drive 上真的長出那個資料夾。
              </li>
              <li>
                到 Google Drive 對那個資料夾按「共用」，加入下面那個服務帳號信箱，
                權限給<strong>檢視者</strong>就夠 —— 服務帳號只讀不寫，也刪不掉任何東西。
              </li>
            </ol>

            <h3 className={styles.guideHead}>你在這裡做的事</h3>
            <ol className={styles.guideList}>
              <li>按一次掃描，服務帳號信箱就會出現，可以複製給家人。</li>
              <li>
                家人分享完，再按一次。<strong>沒有東西要挑</strong> ——
                資料夾的擁有者信箱等於誰的帳號，就自動綁給誰，下面每一列會寫清楚結果。
              </li>
              <li>
                綁好立刻生效，不用重新部署。之後他在地圖上按「從 Drive 同步」就讀得到自己的軌跡。
              </li>
            </ol>
            <p>
              一個資料夾<strong>只會綁一個人</strong>：綁重了兩個人會同步到同一批檔案，
              同一天會多出一份不是他的軌跡。信箱是唯一的，所以自動配對不可能配出這種狀況；
              舊的人工綁定如果卡在別人身上，掃描時會直接拆掉換人。
            </p>

            <h3 className={styles.guideHead}>狀況對照</h3>
            <dl className={styles.guideFaq}>
              <dt>某個人一直是「還沒設定共享資料夾」</dt>
              <dd>
                最常見的是他手機上授權 Drive 用的 Google 帳號，跟他登入這個站的帳號不是同一個 ——
                那就要請他在 GPSLogger 裡改用正確的帳號重新授權。其次才是根本還沒分享：
                Test upload 成功不代表已經分享，那是兩件事。
              </dd>

              <dt>畫面說有資料夾對不到任何帳號</dt>
              <dd>
                通常就是上一條那個帳號不對，訊息裡會寫出那個資料夾是哪個信箱分享的 ——
                把它跟白名單上的信箱對一下就知道差在哪。也可能是 Drive 沒告訴我們擁有者是誰
                （對方帳號設定不揭露），那種情況自動配對救不了，要跟我說一聲手動綁。
              </dd>

              <dt>顯示「分享了 2 個以上，請只留一個」</dt>
              <dd>同一個帳號分享了不只一個資料夾，我們不猜哪個是 GPSLogger 的。請他在 Drive 上把多餘的取消共用，再掃一次。</dd>

              <dt>本來綁好的人變成「還沒設定」</dt>
              <dd>
                對方取消分享或把資料夾丟進垃圾桶了，同步會失敗，要請他重新分享一次。
                舊的綁定會刻意留著不清掉，所以重新分享後掃一次就恢復。
              </dd>

              <dt>綁好了，但同步是空的</dt>
              <dd>資料夾裡沒有 .gpx。我們只認副檔名 .gpx，Test upload 產生的 gpslogger_test.xml 會被跳過，那是正常的。</dd>

              <dt>清單裡沒有你自己</dt>
              <dd>
                站長不用在這裡綁。你的軌跡讀的是部署時設好的
                <span className={styles.code}>GOOGLE_DRIVE_FOLDER_ID</span>，
                要換資料夾是去改那顆環境變數，不是在這一頁。
              </dd>

              <dt>掃描回「尚未設定 GOOGLE_DRIVE_SA_KEY」</dt>
              <dd>這個環境的 Worker 還沒灌那顆 secret，整段功能都不會動。</dd>
            </dl>
          </div>
        </details>

        {scan && (
          <p className={styles.hint}>
            要分享給這個信箱（唯讀就夠了）：<br />
            <span className={styles.mono}>{scan.serviceAccount}</span>
          </p>
        )}

        <div className={styles.formRow} style={{ marginBottom: "0.5rem" }}>
          <button
            type="button"
            className={styles.button}
            onClick={runScan}
            disabled={scanning}
          >
            {scanning ? "掃描中..." : scan ? "重新掃描 Drive" : "掃描 Drive 並自動綁定"}
          </button>
        </div>

        {/*
          分享過來卻對不到任何帳號的資料夾。自動配對沒得挑，所以「我明明分享了
          怎麼沒反應」只剩這一段能查 —— 信箱印出來，跟白名單一比就知道差在哪。
        */}
        {scan && scan.unmatched.length > 0 && (
          <p className={styles.hint}>
            另外有 {scan.unmatched.length} 個資料夾分享過來，但對不到任何帳號：
            {scan.unmatched.map((f) => `${f.name}（${f.ownerEmail || "拿不到擁有者"}）`).join("、")}。
            這些信箱不在白名單裡，或跟白名單上的寫法不一樣。
          </p>
        )}

        {trackTargets.length === 0 && (
          <p className={styles.hint}>白名單裡目前只有你自己，你的軌跡不用在這裡設定。</p>
        )}

        {trackTargets.map((user) => {
          const r = scan?.results.find((x) => x.user_id === user.id) ?? null;
          return (
            <div key={user.id} className={styles.userRow}>
              <div className={styles.userMain}>
                <div className={styles.userName}>{user.name || user.email}</div>
                <div className={styles.userMeta}>
                  {/* 還沒掃過：只知道 D1 有沒有存 id，不知道那個資料夾叫什麼名字
                      （名字在 Drive 上，沒存進來），所以這裡只能講狀態不能講名字 */}
                  {!r && (user.track_drive_folder_id
                    ? "已綁定資料夾。按上面掃描可以確認現在還通不通。"
                    : "還沒設定共享資料夾。")}
                  {r?.status === "bound" && `目前綁定：${r.folder_name}`}
                  {r?.status === "updated" && `已自動綁定：${r.folder_name}`}
                  {r?.status === "missing" && (
                    <>
                      還沒設定共享資料夾 —— 找不到用 <span className={styles.code}>{r.email}</span>{" "}
                      分享過來的資料夾。
                      {r.still_bound && "（之前綁的還留著，沒有動它）"}
                    </>
                  )}
                  {r?.status === "ambiguous" && (
                    <>
                      {r.email} 分享了 {r.folder_names?.length} 個資料夾（
                      {r.folder_names?.join("、")}），無法判斷哪一個是 GPSLogger 的，
                      這次沒有綁。請他只留一個再掃一次。
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </section>

      <SlideConfirmModal
        isOpen={removing !== null}
        title={`移出白名單：${removing?.name || removing?.email || ""}`}
        message={
          /*
           * 這裡的 photo_count 是「他那幾本相簿裡總共幾張」（含別人傳進去的），
           * 不是他上傳的數量 —— 講的是「移除他會碰到多少東西」，所以是對的。
           * 用詞跟著改成「裡面共 X 張」，免得跟上面那行的「上傳 N 張」對不起來。
           */
          removing && removing.album_count > 0
            ? `${removing.email} 名下有 ${removing.album_count} 本相簿、裡面共 ${removing.photo_count} 張照片。移出白名單只會讓他登不進來，相簿與照片會原封不動留著，之後想讓他回來再加一次就好。`
            : `${removing?.email} 之後就登不進來了。帳號會留在名單上標示為停權，想讓他回來再加一次就好。`
        }
        onConfirm={handleRemove}
        onCancel={() => setRemoving(null)}
      />

      <SlideConfirmModal
        isOpen={purging !== null}
        title={`刪除帳號：${purging?.name || purging?.email || ""}`}
        message={
          // 沒東西可勾的人不要講「由下面的選項決定」——下面根本沒有選項
          preview
            ? `${preview.email} 會從白名單上消失，救不回來。`
              + (preview.albums > 0 || preview.photos_uploaded > 0 || preview.track_days > 0
                ? "要不要順便清掉他的內容，由下面的選項決定。" : "")
            : "正在算他名下有多少東西..."
        }
        onConfirm={handlePurge}
        onCancel={() => setPurging(null)}
      >
        {preview && (preview.albums > 0 || preview.photos_uploaded > 0 || preview.track_days > 0 ? (
          <>
            {preview.albums > 0 && (
              <label className={styles.purgeOption}>
                <input
                  type="checkbox"
                  checked={dropAlbums}
                  onChange={(e) => setDropAlbums(e.target.checked)}
                />
                <span>
                  一併刪除他建立的 {preview.albums} 本相簿
                  <span className={styles.purgeNote} style={{ display: "block" }}>
                    連同裡面全部 {preview.photos_in_albums} 張照片。
                    <strong>包含別人傳進去的</strong> —— 相簿沒了，照片沒有地方可以放。
                  </span>
                </span>
              </label>
            )}

            {preview.photos_uploaded > 0 && (
              <label className={styles.purgeOption}>
                <input
                  type="checkbox"
                  checked={dropPhotos}
                  onChange={(e) => setDropPhotos(e.target.checked)}
                />
                <span>
                  一併刪除他上傳的 {preview.photos_uploaded} 張照片
                  <span className={styles.purgeNote} style={{ display: "block" }}>
                    {preview.photos_elsewhere > 0
                      ? <>其中 <strong>{preview.photos_elsewhere} 張放在別人的相簿裡</strong>，也會一起消失。</>
                      : "都在他自己的相簿裡。"}
                  </span>
                </span>
              </label>
            )}

            {preview.track_days > 0 && (
              <label className={styles.purgeOption}>
                <input
                  type="checkbox"
                  checked={dropTracks}
                  onChange={(e) => setDropTracks(e.target.checked)}
                />
                <span>
                  一併刪除他 {preview.track_days} 天的足跡
                  <span className={styles.purgeNote} style={{ display: "block" }}>
                    連同原始 GPX 與貼過路的結果。
                    <strong>這是刪他的移動紀錄，跟相簿無關</strong> —— 照片上的位置不受影響。
                  </span>
                </span>
              </label>
            )}

            <p className={styles.purgeNote}>
              {!dropAlbums && preview.albums > 0
                && `沒勾的話，他那 ${preview.albums} 本相簿會改掛在你（站長）名下，內容原封不動。`}
              {!dropTracks && preview.track_days > 0
                && `沒勾的話，他那 ${preview.track_days} 天足跡會改掛在你（站長）名下。`}
              {(dropAlbums || dropPhotos)
                && "刪掉的照片會直接從 R2 移除；Google Drive 上的備份是搬進 trash/ 資料夾，不會真的刪檔。"}
              {dropTracks
                && "足跡刪掉之後救不回來 —— 原始 GPX 還在他自己的 Google Drive 裡，站上這份是唯一的副本。"}
            </p>
          </>
        ) : (
          <p className={styles.purgeNote}>他沒有建過相簿、沒有上傳過照片，也沒有足跡，刪掉不會動到任何內容。</p>
        ))}
      </SlideConfirmModal>
    </div>
  );
}


/* ── 單獨對一本的結果 ─────────────────────────────────────────────────────

  這一格回答的是使用者實際問的兩個問題：**「哪幾張要補、哪幾張不用」**，
  以及**「多餘的那些怎麼了」**。

  ⚠️「多餘的」在這個站有兩種，處理方式刻意不同（後端 findDuplicateRows 有長註解）：
    - **Drive 上多出來的檔**：沒有任何一列指著它，過三道閘就自動排進 trash/。
      搬進垃圾桶是可逆的，所以敢自動做。
    - **站上多出來的列**：刪一列 Photo ＝ 相簿裡少一格，連同標籤、留言、Story、
      手動修過的座標與時間一起沒。哪一列該留只有人判斷得了，**所以只列出來**。
*/

const SLOT_LABEL: Record<string, string> = { "4k": "4K", original: "原始檔" };

/** 還沒解決的那幾種，會出現在「還缺哪些」那一段 */
const NEEDS_ACTION = new Set(["missing", "cleared", "gone"]);

const ITEM_STATE_LABEL: Record<string, string> = {
  missing: "從來沒傳成功過",
  cleared: "Drive 上確認沒了，記錄已清掉",
  gone: "記錄有、Drive 清單裡沒有（還沒追問到）",
  linked: "檔案在，記錄漏掉，已自動接回來",
  linking: "檔案在，記錄下一輪才寫得回去（備份是好的）",
  moved: "被搬到別的資料夾，備份是好的",
};

const EXTRA_REASON_LABEL: Record<string, string> = {
  foreign: "不是本站放的檔，一律不碰",
  too_new: "建立不到 24 小時，可能是剛傳完還沒回報",
  in_use: "那張照片還指著它",
  queued_before: "早就在待搬佇列裡了",
  over_limit: "這一輪額度用完，下一輪再處理",
};

function AlbumAuditReport({ report: r }: { report: DriveAuditAlbumReport }) {
  const items = r.items ?? [];
  const todo = items.filter((i) => NEEDS_ACTION.has(i.state));
  const done = items.filter((i) => !NEEDS_ACTION.has(i.state));
  const extras = r.extras ?? [];
  const queued = extras.filter((e) => e.action === "queued");
  const kept = extras.filter((e) => e.action === "kept");
  const dups = r.dups ?? [];

  return (
    <div className={styles.detail}>
      <div className={styles.detailHead}>單獨比對：{r.name}</div>

      {r.error && <p className={`${styles.message} ${styles.err}`}>出錯：{r.error}</p>}

      {r.no_folder ? (
        <p className={styles.hint}>
          這本相簿在 Drive 上<strong>還沒有資料夾</strong> —— {r.photos} 張全都沒有備份過。
          把任何一個原始檔再拖進那本相簿一次就會建起來。
        </p>
      ) : r.truncated ? (
        <p className={`${styles.message} ${styles.err}`}>
          這本在 Drive 上的檔案太多，這次<strong>沒有列完</strong>。
          「不見了」與「多出來的檔」整段跳過 —— 拿半份清單去判定會清掉好資料。
        </p>
      ) : null}

      <div className={styles.detailRow}>
        <span className={styles.detailName}>
          <strong>{r.ok}</strong> / {r.photos} 張<strong>不用補</strong>（該有的備份都在）
        </span>
        <span className={styles.detailNum}>
          {r.photos - r.ok > 0 ? `還有 ${r.photos - r.ok} 張要處理` : "全部齊了"}
        </span>
      </div>

      {todo.length > 0 && (
        <>
          <div className={styles.detailHead}>還缺哪些（{todo.length}{r.items_more ? "＋" : ""}）</div>
          {todo.map((i) => (
            <div key={`${i.photo_id}-${i.slot}`} className={styles.detailRow}>
              <span className={styles.detailName}>
                {i.title}{i.media_type === "video" ? "（影片）" : ""} — 缺 {SLOT_LABEL[i.slot] ?? i.slot}
              </span>
              <span className={styles.detailNote}>{ITEM_STATE_LABEL[i.state] ?? i.state}</span>
            </div>
          ))}
          <p className={styles.hint}>
            補的方法：把同一個原始檔再拖進那本相簿一次（站上會認出是同一個檔），
            它只會補缺的那一份。⚠️ 真正的 4K 只編得出來一次 ——
            R2 上那份 2000px 補不回 4K，一定要拿原始檔。
          </p>
        </>
      )}

      {done.length > 0 && (
        <details className={styles.guide}>
          <summary className={styles.guideSummary}>已經自動處理好的（{done.length}）</summary>
          <div className={styles.guideBody}>
            {done.map((i) => (
              <div key={`${i.photo_id}-${i.slot}`} className={styles.detailRow}>
                <span className={styles.detailName}>
                  {i.title} — {SLOT_LABEL[i.slot] ?? i.slot}
                </span>
                <span className={styles.detailNote}>{ITEM_STATE_LABEL[i.state] ?? i.state}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {r.items_more ? (
        <p className={styles.hint}>明細只列前面那些，另外還有 {r.items_more} 筆沒列出來。</p>
      ) : null}

      {(queued.length > 0 || kept.length > 0) && (
        <details className={styles.guide}>
          <summary className={styles.guideSummary}>
            Drive 上多出來的檔（已排進 trash/ {queued.length}、這次不動 {kept.length}）
          </summary>
          <div className={styles.guideBody}>
            <p>
              「排進 trash/」是<strong>搬進 <span className={styles.code}>didadida/trash/</span></strong>
              不是刪除，反悔隨時去 Drive 搬回來。
            </p>
            {queued.map((e) => (
              <div key={e.drive_id} className={styles.detailRow}>
                <span className={styles.detailName}>{e.name}</span>
                <span className={styles.detailNote}>已排進 trash/</span>
              </div>
            ))}
            {kept.map((e) => (
              <div key={e.drive_id} className={styles.detailRow}>
                <span className={styles.detailName}>{e.name}</span>
                <span className={styles.detailNote}>
                  {EXTRA_REASON_LABEL[e.reason ?? ""] ?? "不動它"}
                </span>
              </div>
            ))}
            {r.extras_more ? <p>另外還有 {r.extras_more} 個沒列出來。</p> : null}
          </div>
        </details>
      )}

      {dups.length > 0 && (
        <details className={styles.guide}>
          <summary className={styles.guideSummary}>站上重複的照片（{dups.length} 組，不會自動刪）</summary>
          <div className={styles.guideBody}>
            <p>
              這幾組是<strong>站上（相簿裡）有兩格以上</strong>指著同一張照片。
              <strong>不會自動刪</strong> —— 刪一格連同它的標籤、留言、Story、
              手動修過的座標與時間一起沒，哪一格該留只有你判斷得了。
              到相簿裡進編輯模式選起來刪掉不要的那一格就好。
            </p>
            {dups.map((d) => (
              <div key={`${d.kind}-${d.key}`}>
                <div className={styles.detailHead}>
                  {d.kind === "same_hash"
                    ? "同一個檔（位元組一模一樣）"
                    : "檔名一樣（不一定是同一張，請自己看一眼）"}
                  ：{d.key}
                </div>
                {d.photos.map((p) => (
                  <div key={p.id} className={styles.detailRow}>
                    <span className={styles.detailName}>
                      #{p.id} {p.title}{p.media_type === "video" ? "（影片）" : ""}
                    </span>
                    <span className={styles.detailNote}>
                      {p.media_type === "video"
                        ? (p.has_original ? "Drive 有原始檔" : "Drive 沒有備份")
                        : `${p.has_4k ? "有 4K" : "缺 4K"}、${p.has_original ? "有原始檔" : "缺原始檔"}`}
                      {p.created_at ? `　${p.created_at.slice(0, 10)} 加入` : ""}
                    </span>
                  </div>
                ))}
              </div>
            ))}
            {r.dups_more ? <p>另外還有 {r.dups_more} 組沒列出來。</p> : null}
          </div>
        </details>
      )}

      {todo.length === 0 && done.length === 0 && extras.length === 0 && dups.length === 0
        && !r.no_folder && !r.truncated && (
        <p className={styles.hint}>這一本兩邊完全對得起來，沒有要補的、也沒有多餘的。</p>
      )}
    </div>
  );
}
