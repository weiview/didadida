"use client";

import { useState } from "react";
import { setUserTrackColor } from "@/lib/api";
import { TRACK_PALETTE } from "@/lib/trackColors";

/**
 * 一排色票，選某個人在地圖上的軌跡顏色。
 *
 * **2026-09-04 從帳號牌搬進 /admin**（使用者要求：頭像朝向與軌跡顏色都收進
 * 後台設定）。在那之前這排色票是每個人在自己的帳號牌上挑的，於是同一件事
 * 有兩個地方改得到；現在入口只剩站長後台一個 —— 一般成員要換色請站長改。
 *
 * ⚠️ 別人已經在用的顏色會標上他的名字，但**照樣按得下去** ——
 * 全家出遊想跟老婆同色是他們家的事，站上不該替他們決定（使用者定調）。
 */
export default function TrackColorPicker({
  userId, current, others, onChange, disabled,
}: {
  userId: number;
  /** 這個人現在的顏色。後端一律回算好的值，undefined 是舊後端 —— 那時整排都不標選中 */
  current: string | null | undefined;
  /** 其他人各是什麼顏色，只拿來標「這個 OO 在用」。傳空陣列就不標 */
  others: { id: number; name: string | null; track_color?: string | null }[];
  /** 存成功之後把新顏色交回去，呼叫端自己更新手上那份清單 */
  onChange: (hex: string) => void;
  disabled?: boolean;
}) {
  // 正在存的那個顏色。整排一起鎖住，不然連點兩下會有兩個請求互相覆蓋
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 這個顏色被誰佔著（本人不算）。標示用，**不阻止**選同色 */
  const usedBy = (hex: string) =>
    others.find((m) => m.id !== userId && m.track_color === hex) ?? null;

  const pick = async (hex: string) => {
    if (saving || disabled || hex === current) return;
    setSaving(hex);
    setError(null);
    const result = await setUserTrackColor(userId, hex);
    setSaving(null);
    if (result.success) onChange(result.track_color || hex);
    else setError(result.message || "換色失敗");
  };

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {TRACK_PALETTE.map(({ hex, name }) => {
          const taken = usedBy(hex);
          const mine = current === hex;
          return (
            <button
              key={hex}
              type="button"
              onClick={() => pick(hex)}
              disabled={disabled || saving !== null}
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
                cursor: disabled ? "not-allowed" : saving ? "progress" : "pointer",
                // 選中的那顆用一圈白邊 + 外框撐出來，不靠打勾 ——
                // 24px 上的符號在深色底上幾乎看不見
                border: mine ? "2px solid #fff" : "1px solid rgba(0, 0, 0, 0.18)",
                boxShadow: mine ? `0 0 0 2px ${hex}` : "none",
                opacity: saving && saving !== hex ? 0.45 : 1,
                // 別人在用：右下角一個小白點，只是提示，不是禁止標誌
                backgroundImage: taken
                  ? "radial-gradient(circle at 78% 78%, rgba(255,255,255,0.95) 0 3px, transparent 3px)"
                  : undefined,
              }}
            />
          );
        })}
      </div>
      {error && (
        <div style={{ fontSize: 12, color: "#b91c1c", marginTop: 6 }}>{error}</div>
      )}
    </div>
  );
}
