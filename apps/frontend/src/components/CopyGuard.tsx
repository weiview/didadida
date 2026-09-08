'use client';

import { useEffect } from 'react';
import { useAdmin } from '@/lib/useAdmin';

/**
 * 訪客不能複製照片時，把右鍵、拖曳與手機長按擋掉。
 *
 * ⚠️⚠️ **這不是權限，是門檻。** 位元組已經在對方的瀏覽器裡了 —— 螢幕截圖、
 * 開發者工具、直接開圖片網址，這一層一個都擋不掉，**也不要為了擋它們再加東西**
 * （停用 F12、偵測 devtools 那類招式只會弄壞正常瀏覽）。真正有份量的那一半在後端：
 * 關著的時候訪客的 `/api/photos/:id/full` 只給 R2 那顆 800px 縮圖，Drive 上那份 4K
 * 一律不發。這裡要做的只是「不小心按到右鍵就存下來」那條最順手的路。
 *
 * ⚠️ **成員永遠不受影響**（`canCopyPhotos` 對成員恆為 true）—— 那是自己家的照片。
 *
 * ⚠️ 掛在 `layout.tsx` 一個地方，**不要改成每個顯示照片的元件各擋一次**：
 *    站上有格線、燈箱、地圖、留言頭像好幾條路，逐個加等於漏掉一條就破功，
 *    而這裡一支 document 層的監聽器就全部蓋到了。
 *
 * ⚠️ 只擋 `<img>`／`<video>` 上的右鍵，**不是整頁停用右鍵** —— 訪客照樣要能在
 *    連結上開新分頁、在文字上複製。首頁那幾張相簿封面是 CSS 背景圖，本來就沒有
 *    「另存圖片」可以按。
 */
export default function CopyGuard() {
  const { canCopyPhotos } = useAdmin();

  useEffect(() => {
    if (canCopyPhotos) return;

    const isMedia = (t: EventTarget | null) =>
      t instanceof Element && !!t.closest('img, video');

    const onContextMenu = (e: MouseEvent) => { if (isMedia(e.target)) e.preventDefault(); };
    const onDragStart = (e: DragEvent) => { if (isMedia(e.target)) e.preventDefault(); };

    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('dragstart', onDragStart);
    // 手機的長按選單擋不掉事件，只能靠 CSS（-webkit-touch-callout）—— 見 globals.css
    document.body.classList.add('no-copy-media');

    return () => {
      document.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('dragstart', onDragStart);
      document.body.classList.remove('no-copy-media');
    };
  }, [canCopyPhotos]);

  return null;
}
