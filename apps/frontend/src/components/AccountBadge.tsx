"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAdmin } from "@/lib/useAdmin";
import { fetchTrackMembers, type TrackMember } from "@/lib/api";
import { TRACK_PALETTE } from "@/lib/trackColors";

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
    renameSelf, recolorSelf, logout,
  } = useAdmin();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /*
   * 其他家人各自是什麼顏色。只為了在色票上標「這個 OO 在用」——
   * **不擋**（使用者定調：標出來就好，硬性唯一只會讓後來的人沒得選）。
   *
   * null ＝ 還沒問過。點開面板才去問，而且只問一次：這是一顆平常收著的按鈕，
   * 為了它在每一頁都多打一支 API 不值得。
   */
  const [members, setMembers] = useState<TrackMember[] | null>(null);
  // 正在存的那個顏色。整排一起鎖住，不然連點兩下會有兩個請求互相覆蓋
  const [savingColor, setSavingColor] = useState<string | null>(null);

  // 面板收起來時把改名的狀態一起重置，下次點開不會停在上次的半途
  useEffect(() => {
    if (open) return;
    setEditing(false);
    setError(null);
  }, [open]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!open || !isAdmin || user?.id == null || members !== null) return;
    let alive = true;
    fetchTrackMembers().then((list) => { if (alive) setMembers(list); });
    return () => { alive = false; };
  }, [open, isAdmin, user?.id, members]);

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

  // 我現在的顏色。後端一律回算好的值，沒有就是舊後端 —— 那時整排都不標選中
  const myColor = user?.track_color ?? null;
  /** 這個顏色被誰佔著（我自己不算）。標示用，**不阻止**選同色 */
  const usedBy = (hex: string) =>
    members?.find((m) => m.id !== user?.id && m.track_color === hex) ?? null;

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

  const pickColor = async (hex: string) => {
    if (savingColor || hex === myColor) return;
    setSavingColor(hex);
    setError(null);
    const result = await recolorSelf(hex);
    setSavingColor(null);
    if (result.success) {
      // 我剛佔走的顏色要立刻反映在「誰在用什麼」上，不然別人的標記會停在舊值
      setMembers((prev) => prev?.map((m) => (m.id === user?.id ? { ...m, track_color: hex } : m)) ?? prev);
    } else {
      setError(result.message || "換色失敗");
    }
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
          }}
        >
          {initial}
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

              {/* 沒有帳號列的管理員（舊 token 或密碼登入時站長列不見了）改不了名字，
                  按下去只會被後端回 409，乾脆不端出來 */}
              {isAdmin && user?.id != null && (
                <button type="button" onClick={startRename} style={{ ...plainBtn, marginTop: 12, width: "100%" }}>
                  ✎ 修改顯示名稱
                </button>
              )}

              {/* 軌跡顏色。跟改名同一個條件（要有帳號列才存得進去）。
                  放在帳號牌而不是後台：顏色是**每個人自己的**，不是站長分配的。
                  別人已經在用的顏色會標上他的名字，但照樣按得下去 —— 全家出遊
                  想跟老婆同色是他們家的事，站上不該替他們決定。 */}
              {isAdmin && user?.id != null && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
                    地圖上的軌跡顏色
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {TRACK_PALETTE.map(({ hex, name }) => {
                      const taken = usedBy(hex);
                      const mine = myColor === hex;
                      return (
                        <button
                          key={hex}
                          type="button"
                          onClick={() => pickColor(hex)}
                          disabled={savingColor !== null}
                          title={taken ? `${name}（${taken.name || "另一位家人"}已經在用）` : name}
                          aria-label={name}
                          aria-pressed={mine}
                          style={{
                            width: 24,
                            height: 24,
                            borderRadius: "50%",
                            // 用 backgroundColor 而不是 background 簡寫：底下還要疊
                            // 一個 backgroundImage，簡寫會把它洗掉
                            backgroundColor: hex,
                            cursor: savingColor ? "progress" : "pointer",
                            // 選中的那顆用一圈白邊 + 外框撐出來，不靠打勾 ——
                            // 24px 上的符號在深色底上幾乎看不見
                            border: mine ? "2px solid #fff" : "1px solid rgba(0, 0, 0, 0.18)",
                            boxShadow: mine ? `0 0 0 2px ${hex}` : "none",
                            opacity: savingColor && savingColor !== hex ? 0.45 : 1,
                            // 別人在用：右下角一個小白點，只是提示，不是禁止標誌
                            backgroundImage: taken
                              ? "radial-gradient(circle at 78% 78%, rgba(255,255,255,0.95) 0 3px, transparent 3px)"
                              : undefined,
                          }}
                        />
                      );
                    })}
                  </div>
                </div>
              )}

              {isOwner && (
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
