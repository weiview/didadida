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

export default function Avatar({
  src, name, color, size = 32, title,
}: {
  src?: string | null;
  name?: string | null;
  /** 沒有頭像時的底色，也是有頭像時墊在後面的淡色。傳 '#rrggbb' */
  color: string;
  size?: number;
  title?: string;
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

  if (src) {
    return (
      <span style={{ ...common, background: `${color}1f` }} title={title ?? name ?? undefined}>
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
    );
  }

  return (
    <span
      title={title ?? name ?? undefined}
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
}
