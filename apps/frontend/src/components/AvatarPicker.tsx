"use client";

import { useRef, useState } from "react";
import Avatar from "./Avatar";
import { prepareAvatar } from "@/lib/avatar";
import { removeAvatar, uploadAvatar } from "@/lib/api";

/**
 * 換頭像。**帳號牌與 /admin 後台共用同一個元件**（同一件事不要做兩套 UI）——
 * 差別只有 `userId` 指向誰：自己就是自助換，站長指別人就是代設。
 *
 * 後端的規則一樣是本人或站長，這裡不重複判斷，只負責不端出按了會 403 的按鈕
 * （呼叫端自己決定要不要放這個元件）。
 *
 * 圖片的縮放、去背判斷、圓形遮罩都在 lib/avatar.ts 做完才上傳。這裡只做兩件事：
 * 挑檔案，以及把「沒偵測到透明背景」這件事講給使用者聽 —— 不然他會以為
 * 站上偷偷改了他的圖。
 */
export default function AvatarPicker({
  userId, current, name, color, onChange, size = 64,
}: {
  userId: number;
  current: string | null | undefined;
  name: string | null;
  color: string;
  /** 換好之後的網址（移除是 null）。呼叫端自己更新畫面 */
  onChange: (avatar: string | null) => void;
  size?: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 上一次處理的圖本來就是去背的嗎。null ＝ 這一輪還沒處理過檔案 */
  const [hadAlpha, setHadAlpha] = useState<boolean | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    let previewUrl: string | null = null;
    try {
      const prepared = await prepareAvatar(file);
      previewUrl = prepared.previewUrl;
      setHadAlpha(prepared.hadAlpha);
      const result = await uploadAvatar(userId, prepared.blob, prepared.type);
      if (result.success) onChange(result.avatar ?? null);
      else setError(result.message ?? "頭像上傳失敗");
    } catch (e: any) {
      setError(e?.message || "這個檔案處理不了");
    } finally {
      // 預覽只是處理過程的產物，上傳完畫面吃的是後端回來的網址
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setBusy(false);
      // 同一個檔案連選兩次也要觸發 change
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const drop = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await removeAvatar(userId);
    if (result.success) {
      onChange(null);
      setHadAlpha(null);
    } else {
      setError(result.message ?? "移除頭像失敗");
    }
    setBusy(false);
  };

  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <Avatar src={current} name={name} color={color} size={size} />
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" style={btn} disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? "處理中…" : current ? "換一張" : "上傳頭像"}
          </button>
          {current && (
            <button type="button" style={{ ...btn, color: "#9b2c2c" }} disabled={busy} onClick={drop}>
              移除
            </button>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => pick(e.target.files?.[0])}
        />
        <p style={{ margin: 0, fontSize: 11, opacity: 0.6, lineHeight: 1.6 }}>
          {/* 講清楚它會出現在哪裡 —— 使用者不會預期留言用的頭像跑到地圖上去 */}
          留言區和地圖上那台車坐的都是這張。<strong>建議用去背的 PNG</strong>，
          在地圖上才是一顆大頭而不是一塊圓照片。
        </p>
        {hadAlpha === false && (
          <p style={{ margin: 0, fontSize: 11, color: "#8a6d3b", lineHeight: 1.6 }}>
            這張圖沒有透明背景，已經自動裁成圓形。
          </p>
        )}
        {error && (
          <p style={{ margin: 0, fontSize: 11, color: "#9b2c2c", lineHeight: 1.6 }}>{error}</p>
        )}
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 10,
  border: "1px solid rgba(120, 100, 84, 0.22)",
  background: "rgba(255, 255, 255, 0.55)",
  fontSize: "0.85rem",
  cursor: "pointer",
  color: "inherit",
};
