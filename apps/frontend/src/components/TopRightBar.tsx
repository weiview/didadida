"use client";

/**
 * 帳號牌左邊那一排：「★ 精選」＋「誰在線上」。
 *
 * 兩顆各自決定要不要畫（沒有精選、訪客、還沒抓回來…），這一排只負責
 * 把它們並排擺好 —— 各自寫死一個 `right` 的話，其中一顆不見時另一顆會
 * 留在原地，中間空出一個洞。
 */

import FeaturedBar from "./FeaturedBar";
import OnlineBar from "./OnlineBar";
import styles from "./TopRightBar.module.css";

export default function TopRightBar() {
  return (
    <div className={styles.row}>
      <FeaturedBar />
      <OnlineBar />
    </div>
  );
}
