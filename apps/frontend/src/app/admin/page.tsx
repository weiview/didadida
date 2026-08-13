"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import styles from "./admin.module.css";
import {
  PurgePreview, SharedDriveFolder, WhitelistUser, addWhitelistUser, fetchPurgePreview,
  fetchSharedDriveFolders, fetchSiteSettings, fetchWhitelist, purgeWhitelistUser,
  removeWhitelistUser, setUserTrackFolder, updateSiteSettings, updateWhitelistUser,
} from "@/lib/api";
import { useAdmin } from "@/lib/useAdmin";
import SlideConfirmModal from "@/components/SlideConfirmModal";

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
  const { isOwner, checking, isAdmin } = useAdmin();

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
  const [adding, setAdding] = useState(false);

  /** 正在確認移除的那個人 */
  const [removing, setRemoving] = useState<WhitelistUser | null>(null);

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

  /*
   * GPS 軌跡資料夾。**刻意不在開頁時就抓** —— 那是一次 Google Drive API 往返，
   * 而這一頁大多數時候是來加人或改權限的，資料夾綁一次之後幾年不會再動。
   * null ＝ 還沒按過那顆按鈕。
   */
  const [folders, setFolders] = useState<SharedDriveFolder[] | null>(null);
  const [saEmail, setSaEmail] = useState<string | null>(null);
  const [loadingFolders, setLoadingFolders] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, settings] = await Promise.all([fetchWhitelist(), fetchSiteSettings()]);
      setUsers(list);
      setGuestMap(settings.guest_can_view_map === 1);
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
    const result = await addWhitelistUser(email, newName.trim(), newCanManage);
    setAdding(false);
    if (!result.success) return setError(result.message || "新增失敗");
    setError(null);
    setNotice(result.restored
      ? `${email} 之前被停權過，已經重新啟用。`
      : `${email} 已加入白名單，他用 Google 登入就進得來了。`);
    setNewEmail("");
    setNewName("");
    setNewCanManage(false);
    load();
  };

  const patch = async (user: WhitelistUser, body: { can_manage_others?: boolean; active?: boolean }) => {
    setBusyId(user.id);
    setNotice(null);
    const result = await updateWhitelistUser(user.id, body);
    setBusyId(null);
    if (!result.success) return setError(result.message || "修改失敗");
    setError(null);
    load();
  };

  const loadFolders = async () => {
    setLoadingFolders(true);
    setNotice(null);
    try {
      const data = await fetchSharedDriveFolders();
      setFolders(data.folders);
      setSaEmail(data.serviceAccount);
      setError(null);
    } catch (e: any) {
      setError(e.message || "讀取分享資料夾失敗");
    }
    setLoadingFolders(false);
  };

  const bindFolder = async (user: WhitelistUser, folderId: string | null) => {
    setBusyId(user.id);
    setNotice(null);
    const result = await setUserTrackFolder(user.id, folderId);
    setBusyId(null);
    if (!result.success) return setError(result.message || "綁定失敗");
    setError(null);
    setNotice(folderId
      ? `${user.name || user.email} 的軌跡資料夾綁好了，他在地圖上按「從 Drive 同步」就會讀到自己的 GPX。`
      : `已解除 ${user.name || user.email} 的軌跡資料夾綁定，他暫時同步不到東西。`);
    load();
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
                <div className={styles.userMain}>
                  <div className={styles.userName}>
                    {user.name || "（未命名）"}
                    {owner && <span className={styles.tag}>站長</span>}
                    {!owner && user.active !== 1 && (
                      <span className={`${styles.tag} ${styles.tagOff}`}>已停權</span>
                    )}
                  </div>
                  <div className={styles.userMeta}>{user.email}</div>
                  <div className={styles.userMeta}>
                    {user.album_count} 本相簿 · {user.photo_count} 張照片
                    {" · "}
                    {user.last_login_at
                      ? `最後登入 ${new Date(user.last_login_at.replace(" ", "T") + "Z").toLocaleString()}`
                      : "還沒登入過"}
                  </div>
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
          再回來這裡把資料夾對上人 —— 之後他在地圖上按「從 Drive 同步」就讀得到自己的軌跡。
        </p>

        {saEmail && (
          <p className={styles.hint}>
            要分享給這個信箱（唯讀就夠了）：<br />
            <span className={styles.mono}>{saEmail}</span>
          </p>
        )}

        <div className={styles.formRow} style={{ marginBottom: "0.5rem" }}>
          <button
            type="button"
            className={styles.button}
            onClick={loadFolders}
            disabled={loadingFolders}
          >
            {loadingFolders ? "讀取中..." : folders ? "重新讀取分享的資料夾" : "讀取分享給我的資料夾"}
          </button>
        </div>

        {folders !== null && folders.length === 0 && (
          <p className={styles.hint}>
            目前沒有任何資料夾分享給這個服務帳號。請家人先在 Drive 上把 GPSLogger 的資料夾分享過來。
          </p>
        )}

        {users.filter((u) => u.active === 1).map((user) => {
          const busy = busyId === user.id;
          const bound = user.track_drive_folder_id;
          const known = folders?.find((f) => f.id === bound) ?? null;
          return (
            <div key={user.id} className={styles.userRow}>
              <div className={styles.userMain}>
                <div className={styles.userName}>{user.name || user.email}</div>
                <div className={styles.userMeta}>
                  {bound
                    ? `目前綁定：${known ? known.name : bound}`
                    : "還沒綁定，他同步不到任何軌跡"}
                </div>
              </div>
              <div className={styles.actions}>
                {folders === null ? (
                  <span className={styles.userMeta}>先按上面那顆按鈕讀取資料夾</span>
                ) : (
                  <select
                    className={styles.select}
                    value={bound ?? ""}
                    disabled={busy}
                    onChange={(e) => bindFolder(user, e.target.value || null)}
                  >
                    <option value="">（未綁定）</option>
                    {/* 已經綁著、但現在沒出現在分享清單裡的資料夾（對方取消分享了）。
                        不補這一項的話 select 會顯示成「未綁定」，看起來像資料掉了 */}
                    {bound && !known && <option value={bound}>{bound}（已不在分享清單）</option>}
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                        {f.ownerEmail ? `　—　${f.ownerEmail}` : ""}
                        {f.suggestedUserId === user.id ? "　✓ 信箱對得上" : ""}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          );
        })}
      </section>

      <SlideConfirmModal
        isOpen={removing !== null}
        title={`移出白名單：${removing?.name || removing?.email || ""}`}
        message={
          removing && removing.album_count > 0
            ? `${removing.email} 名下有 ${removing.album_count} 本相簿、${removing.photo_count} 張照片。移出白名單只會讓他登不進來，相簿與照片會原封不動留著，之後想讓他回來再加一次就好。`
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
