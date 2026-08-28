"use client";

/**
 * 一顆圓頭像。全站的頭像都走這裡 —— 留言、通知、帳號牌、後台名單。
 *
 * 沒設頭像的人畫成「名字首字 + 他的顏色」，跟以前一模一樣（帳號牌本來就長那樣）。
 * 有頭像的人底下墊一層很淡的同色 —— 去背圖是透明的，不墊會像浮在半空中。
 *
 * 圖是後端的 /api/users/avatar/<檔名>，那條路由在進站閘門的白名單裡
 * （<img src> 帶不了 Authorization），所以這裡直接用 <img> 就好，不必自己帶 token。
 */

/**
 * 右下角那顆上線燈。
 *
 * ⚠️ **`undefined` ＝ 整顆不畫**，不是畫灰的。頭像有幾個地方跟「誰在線上」
 *    完全無關（AvatarPicker 的預覽、地圖上的大頭），那些地方多一顆灰點只是雜訊。
 *    要畫燈的呼叫端自己明講 'online' 或 'offline'。
 */
export type PresenceState = "online" | "offline";

/** 綠：#22c55e。灰：#9ca3af。外圈那層白邊是為了讓燈在深色頭像上也看得出來 */
function PresenceDot({ state, size }: { state: PresenceState; size: number }) {
  // 燈跟著頭像縮。太小會變成一個看不出顏色的點，所以夾一個下限
  const d = Math.max(8, Math.round(size * 0.3));
  return (
    <span
      aria-hidden
      title={state === "online" ? "上線中" : "離線"}
      style={{
        position: "absolute",
        right: -1,
        bottom: -1,
        width: d,
        height: d,
        borderRadius: "50%",
        background: state === "online" ? "#22c55e" : "#9ca3af",
        border: `${Math.max(1, Math.round(d * 0.16))}px solid var(--bg, #fff)`,
        boxSizing: "border-box",
        pointerEvents: "none",
      }}
    />
  );
}

export default function Avatar({
  src, name, color, size = 32, title, presence,
}: {
  src?: string | null;
  name?: string | null;
  /** 沒有頭像時的底色，也是有頭像時墊在後面的淡色。傳 '#rrggbb' */
  color: string;
  size?: number;
  title?: string;
  /** 上線燈。**不給就不畫**（見 PresenceState 上面那段） */
  presence?: PresenceState | null;
}) {
  const initial = Array.from((name ?? "").trim())[0] ?? "?";
  const common: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  };

  const tip = title ?? name ?? undefined;
  const fullTip = tip && presence
    ? `${tip}（${presence === "online" ? "上線中" : "離線"}）`
    : tip;

  const inner = src ? (
    <span style={{ ...common, background: `${color}1f` }} title={fullTip}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={name ?? ""}
        width={size}
        height={size}
        // 圖本身已經是正方形（見 lib/avatar.ts），cover 不會裁到東西
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
      />
    </span>
  ) : (
    <span
      title={fullTip}
      style={{
        ...common,
        background: color,
        color: "#fff",
        fontWeight: 600,
        // 首字要跟著圓一起縮。0.46 是試出來的：再大一點中文字會頂到邊
        fontSize: Math.round(size * 0.46),
        lineHeight: 1,
      }}
    >
      {initial}
    </span>
  );

  /*
   * 沒有燈的時候**完全維持原樣**（就是原本那一層 span），不要為了統一就永遠包兩層
   * —— 頭像出現在很多既有版面裡，外面多一層會動到既有的對齊。
   */
  if (!presence) return inner;

  return (
    <span style={{ position: "relative", display: "inline-flex", flexShrink: 0, lineHeight: 0 }}>
      {inner}
      <PresenceDot state={presence} size={size} />
    </span>
  );
}
