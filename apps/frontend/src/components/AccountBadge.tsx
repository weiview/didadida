"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAdmin } from "@/lib/useAdmin";

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
    renameSelf, logout,
  } = useAdmin();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
