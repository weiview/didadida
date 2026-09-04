"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAdmin } from "@/lib/useAdmin";
import AvatarPicker from "./AvatarPicker";
import { fetchNotifications, type NotificationItem } from "@/lib/api";
import { uploadSummary } from "@/lib/uploadSummary";

/**
 * 右上角的帳號牌。收合時只有一顆圓鈕（顯示名稱的第一個字），點開才是整張卡。
 *
 * **掛在 RootLayout，全站共用** —— 以前只有首頁看得到登入入口，在相簿頁或地圖頁
 * 想知道「我現在是誰」「怎麼登出」得先退回首頁。而且多人共用之後，
 * 「我現在用的是哪個帳號」是每一頁都該回答得出來的事。
 *
 * 右上角是刻意選的：右下角已經被 FAB／編輯動作列／回到頂端鈕佔滿（見 cornerStack.ts），
 * 相簿頁的時間軸從 top: 88px 才開始長，這顆停在 12～52px 之間，兩邊碰不到。
 *
 * **訪客只有「看」跟「登出」**：這裡不放家庭成員登入的入口，改身分要先登出、
 * 回到進站畫面再選（使用者的決定）。站內唯一的登入點是 AccessGate，
 * 不然訪客會一直被提醒「你其實可以變成別的身分」。
 */

/** 圓鈕的直徑。跟 FAB 的 56 拉開一點，它不是主要動作 */
const BADGE = 40;

export default function AccountBadge() {
  const {
    isAdmin, isGuest, checking, user, isOwner, canManageOthers,
    unreadNotifications, markNotificationsRead,
    renameSelf, setMyAvatar, logout,
  } = useAdmin();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /*
   * 通知。**沒有另外做一顆鈴鐺** —— 右上角這顆圓鈕已經是全站唯一的個人角落，
   * 再擺一個浮動按鈕只會跟 FAB／回到頂端那疊搶位置（見 cornerStack.ts）。
   * 未讀數量畫成圓鈕上的紅點，內容就掛在這張卡裡。
   *
   * null ＝ 這次還沒問過。跟顏色那份不同的是**每次點開都重問**：
   * 未讀通知的重點就是新，快取一份舊的沒有意義。
   */
  const [notifs, setNotifs] = useState<NotificationItem[] | null>(null);

  // 面板收起來時把改名的狀態一起重置，下次點開不會停在上次的半途
  useEffect(() => {
    if (open) return;
    setEditing(false);
    setError(null);
    setNotifs(null);
  }, [open]);

  /*
   * 點開就抓通知，順手全部標成已讀（後端只有一個時間戳，沒有逐則已讀）。
   *
   * 標已讀排在抓完之後：`unread` 旗標是抓下來那一刻的快照，先標的話這一次
   * 打開會看到一片「都已讀」，使用者根本不知道哪幾則是新的。
   */
  useEffect(() => {
    if (!open || !isAdmin || user?.id == null) return;
    let alive = true;
    fetchNotifications().then(({ items }) => {
      if (!alive) return;
      setNotifs(items);
      if (unreadNotifications > 0) markNotificationsRead();
    });
    return () => { alive = false; };
    // unreadNotifications 刻意不進相依：標成已讀會把它歸零，進去就會再跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isAdmin, user?.id]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);


  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 改名中先退出改名，第二下才關掉面板 —— 一次關掉全部會讓人以為誤觸
      if (editing) setEditing(false);
      else setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, editing]);

  // 還在問後端「這張 token 算不算數」的期間不畫。先畫成訪客再跳成管理員會閃一下
  if (checking || (!isAdmin && !isGuest)) return null;

  const displayName = user?.name?.trim() || (isAdmin ? "家庭成員" : "訪客");
  const initial = Array.from(displayName)[0] ?? "?";
  /* 對外一律講「家庭成員」，不講「管理員」—— 這站是給家人用的，
     管理員是內部的權限說法。站長還是站長，那是他自己看得懂的身分。

     訪客是 null：使用者的決定 —— 這一格不要跟訪客講「只能瀏覽」。
     他本來就只能看，講了只是在提醒他自己少了什麼。 */
  const roleLabel = !isAdmin
    ? null
    : isOwner
      ? "站長"
      : canManageOthers
        ? "家庭成員（可管理全站內容）"
        : "家庭成員（只能管自己的內容）";

  /*
   * 我在地圖上的顏色。這裡只拿來當頭像的底色 —— **換色的入口在 /admin**
   * （2026-09-04 使用者要求搬過去，跟頭像朝向一起收進後台設定）。
   */
  const myColor = user?.track_color ?? null;

  const startRename = () => {
    setDraft(user?.name ?? "");
    setError(null);
    setEditing(true);
  };

  const submitRename = async () => {
    const next = draft.trim();
    if (!next || saving) return;
    if (next === user?.name) return setEditing(false);
    setSaving(true);
    setError(null);
    const result = await renameSelf(next);
    setSaving(false);
    if (result.success) setEditing(false);
    else setError(result.message || "改名失敗");
  };


  return (
    <>
      {/* 點空白處收起。不壓暗背景 —— 這是一張資訊卡，不是需要專心的動作 */}
      {open && (
        <div
          className="floating-control"
          onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, zIndex: 930 }}
        />
      )}

      <div
        style={{
          position: "fixed",
          top: "max(12px, env(safe-area-inset-top))",
          right: "max(12px, env(safe-area-inset-right))",
          zIndex: 935,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 10,
          // 收合時面板只是 opacity: 0，還佔著版面。這層不能吃點擊，
          // 否則整片會蓋住右上角的內容（跟 FabMenu 同一個坑）
          pointerEvents: "none",
        }}
      >
        <button
          type="button"
          aria-label={`帳號：${displayName}`}
          aria-expanded={open}
          title={user?.email || displayName}
          // floating-control：捲動中 globals.css 會關掉全站 pointer-events，這是豁免票
          className={`floating-control glass-control${isAdmin ? " glass-accent" : ""}`}
          onClick={() => setOpen((v) => !v)}
          style={{
            width: BADGE,
            height: BADGE,
            borderRadius: "50%",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "1rem",
            fontWeight: 600,
            pointerEvents: "auto",
            position: "relative",
          }}
        >
          {/* 有頭像就蓋掉首字。圖是正方形的（見 lib/avatar.ts），
              去背的部分會透出底下那層 glass，看起來就是一顆貼在按鈕上的頭 */}
          {user?.avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={user.avatar}
              alt=""
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                borderRadius: "50%",
                objectFit: "cover",
              }}
            />
          ) : initial}
          {/* 未讀紅點。**不寫數字**：家裡幾個人的留言不會多到需要計數，
              一顆點就足夠說「有新的東西」，也不會把 40px 的圓鈕塞爆 */}
          {unreadNotifications > 0 && (
            <span
              aria-label={`有 ${unreadNotifications} 則新通知`}
              style={{
                position: "absolute",
                top: 1,
                right: 1,
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: "#e53e3e",
                border: "2px solid rgba(255, 255, 255, 0.9)",
                boxSizing: "content-box",
              }}
            />
          )}
        </button>

        <div
          className={`glass-control${open ? " floating-control" : ""}`}
          role="dialog"
          aria-label="帳號"
          style={{
            width: "min(280px, calc(100vw - 24px))",
            padding: "16px 18px",
            borderRadius: 18,
            textAlign: "left",
            cursor: "default",
            opacity: open ? 1 : 0,
            ["--glass-transform" as string]: open ? "translateY(0)" : "translateY(-8px) scale(0.97)",
            pointerEvents: open ? "auto" : "none",
          } as React.CSSProperties}
        >
          {editing ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label style={{ fontSize: 12, opacity: 0.7 }}>顯示名稱</label>
              <input
                ref={inputRef}
                type="text"
                value={draft}
                maxLength={40}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitRename();
                }}
                style={{
                  padding: "8px 10px", borderRadius: 10, fontSize: "0.95rem",
                  border: "1px solid rgba(120, 100, 84, 0.28)",
                  background: "rgba(255, 255, 255, 0.7)", color: "inherit",
                }}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" onClick={submitRename} disabled={!draft.trim() || saving} style={primaryBtn}>
                  {saving ? "儲存中..." : "儲存"}
                </button>
                <button type="button" onClick={() => setEditing(false)} style={plainBtn}>取消</button>
              </div>
            </div>
          ) : (
            <>
              <div style={{ fontSize: "1.05rem", fontWeight: 600, wordBreak: "break-word" }}>
                {displayName}
              </div>
              {user?.email && (
                <div style={{ fontSize: 12, opacity: 0.65, marginTop: 2, wordBreak: "break-all" }}>
                  {user.email}
                </div>
              )}
              {roleLabel && (
                <div style={{ fontSize: 12, opacity: 0.75, marginTop: 8 }}>{roleLabel}</div>
              )}

              {/* 通知。**兩種混在同一份清單裡**：留言，以及有人傳了新的照片／影片。
                  ⚠️ 這裡刻意**不看 `canViewComments`**（2026-09-04 加上傳通知時放寬的）
                  —— 過濾留言那半由後端負責（看不到留言的人那一段整個不查），
                  前端跟著擋的話他會連「有人上傳了新照片」都收不到。 */}
              {isAdmin && user?.id != null && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>通知</div>
                  {notifs === null ? (
                    <div style={{ fontSize: 12, opacity: 0.55 }}>載入中…</div>
                  ) : notifs.length === 0 ? (
                    <div style={{ fontSize: 12, opacity: 0.55 }}>還沒有通知</div>
                  ) : (
                    <div style={{ maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                      {notifs.map((n) => (
                        // ⚠️ key 要 kind ＋ id 一起：留言與上傳的 id 各自從 1 開始，
                        // 只用 id 兩種會撞在一起
                        <NotificationRow key={`${n.kind}-${n.id}`} item={n} onGo={() => setOpen(false)} />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 頭像。換圖是**每個人自己的**事，留在這裡。
                  ⚠️ 「頭像朝哪一邊」與「軌跡顏色」**2026-09-04 搬去 /admin 了**
                  （使用者要求：朝向的按鈕跟車上座位放一起，顏色也一併進後台）。
                  那兩件事都是「這台車看起來對不對」，站長要調得動別人的；
                  留一份在這裡就變成同一件事兩個入口，遲早走鐘。
                  一般成員要換色或轉向請站長改。 */}
              {isAdmin && user?.id != null && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>頭像</div>
                  <AvatarPicker
                    userId={user.id}
                    current={user.avatar}
                    name={displayName}
                    color={myColor ?? "#8a7f72"}
                    size={56}
                    onChange={setMyAvatar}
                  />
                </div>
              )}

              {/* 沒有帳號列的管理員（舊 token 或密碼登入時站長列不見了）改不了名字，
                  按下去只會被後端回 409，乾脆不端出來 */}
              {isAdmin && user?.id != null && (
                <button type="button" onClick={startRename} style={{ ...plainBtn, marginTop: 12, width: "100%" }}>
                  ✎ 修改顯示名稱
                </button>
              )}

              {/* 「可管理全站內容」＝共同站長，後台每一格都給（見 /admin 那一頁
                  的註解）。這顆是站上唯一通往 /admin 的連結，跟著一起放行，
                  不然他只能靠自己打網址。 */}
              {canManageOthers && (
                <Link
                  href="/admin"
                  onClick={() => setOpen(false)}
                  style={{ ...plainBtn, marginTop: 8, width: "100%", display: "block", textAlign: "center", textDecoration: "none" }}
                >
                  ⚙ 後台設定
                </Link>
              )}

              <button
                type="button"
                onClick={() => { setOpen(false); logout(); }}
                // 訪客的面板上面什麼都沒有（沒有身分標籤、沒有改名、沒有後台），
                // 只留 8px 會讓按鈕整個貼在名字下面
                style={{ ...plainBtn, marginTop: isAdmin ? 8 : 14, width: "100%", color: "#9b2c2c" }}
              >
                登出
              </button>
            </>
          )}

          {error && (
            <p style={{ margin: "10px 0 0", fontSize: 12, color: "#9b2c2c", lineHeight: 1.6 }}>{error}</p>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * 通知的一行。整行是連結，點下去開到那張照片的燈箱。
 *
 * ⚠️ **上傳那種點的是相簿，不是某一張** —— 它指的是一整批（`photo_id` 是 null），
 * 硬要挑一張出來當代表就得在後端多一次查詢，而使用者要的本來就是「去看那一批」。
 */
function NotificationRow({ item, onGo }: { item: NotificationItem; onGo: () => void }) {
  const isUpload = item.kind === "upload";
  const who = item.actor_name || "有人";
  const what = isUpload
    ? `傳了 ${uploadSummary(item.photos, item.videos)}`
    : REASON_TEXT[item.reason] ?? "留言了";
  /*
   * 預覽裡不留 `@[uid]` 這種原始標記 —— 這裡沒有名字對照表（那要另外打一支
   * /users/mentionable），而理由那一行本來就已經講了「提到了你」，
   * 標記留著只是雜訊。直接拿掉。
   *
   * 上傳那種沒有內文，第二行改講進了哪一本相簿。
   */
  const preview = isUpload
    ? (item.album_name ? `到「${item.album_name}」` : "")
    : item.body.replace(/@\[\d+\]\s*/g, "").trim();

  const inner = (
    <>
      {item.thumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.thumb} alt="" width={34} height={34}
             style={{ borderRadius: 6, objectFit: "cover", flexShrink: 0 }} />
      ) : (
        <span style={{
          width: 34, height: 34, borderRadius: 6, flexShrink: 0,
          background: item.color, display: "inline-block",
        }} />
      )}
      <span style={{ minWidth: 0 }}>
        <span style={{ fontSize: 12, lineHeight: 1.5, display: "block" }}>
          <strong style={{ fontWeight: 600 }}>{who}</strong> {what}
        </span>
        {preview && (
          <span style={{
            fontSize: 12, opacity: 0.6, lineHeight: 1.5, display: "block",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {preview}
          </span>
        )}
      </span>
    </>
  );

  const style: React.CSSProperties = {
    display: "flex",
    gap: 8,
    alignItems: "center",
    padding: "6px 8px",
    borderRadius: 10,
    textDecoration: "none",
    color: "inherit",
    // 未讀那幾則墊一層底色。旗標是「抓下來那一刻」的快照，
    // 標成已讀之後這一次打開還是看得出哪些是新的
    background: item.unread ? "rgba(var(--glass-tint-accent), 0.55)" : "transparent",
  };

  // 相簿被刪掉了就沒地方可去。整行照樣顯示（通知本來就可能比內容活得久），
  // 只是不做成連結
  if (item.album_id == null) return <div style={{ ...style, opacity: 0.6 }}>{inner}</div>;

  return (
    <Link
      // ⚠️ 相簿頁是 `/album?id=<相簿>`，**不是** `/album/<相簿>` ——
      // 靜態匯出的站沒有 [id] 那一層，多打一段路徑就是實實在在的 404
      href={item.photo_id == null
        ? `/album?id=${item.album_id}`
        : `/album?id=${item.album_id}&photo=${item.photo_id}`}
      onClick={onGo}
      style={style}
    >
      {inner}
    </Link>
  );
}

const REASON_TEXT: Record<string, string> = {
  mention: "提到了你",
  reply: "回覆了你的留言",
  photo: "在你傳的照片下留言",
  album: "在你的相簿裡留言",
};

const plainBtn: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 10,
  border: "1px solid rgba(120, 100, 84, 0.22)",
  background: "rgba(255, 255, 255, 0.55)",
  fontSize: "0.9rem",
  cursor: "pointer",
  color: "inherit",
};

const primaryBtn: React.CSSProperties = {
  ...plainBtn,
  border: "1px solid rgba(120, 100, 84, 0.32)",
  background: "rgba(var(--glass-tint-accent), 0.9)",
  fontWeight: 500,
};
