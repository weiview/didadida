'use client';

import { useState } from 'react';
import { useAdmin } from '@/lib/useAdmin';
import { authErrorMessage } from '@/lib/authMessages';
import styles from './AccessGate.module.css';

/**
 * 整站的門。沒有有效 token 就只看得到這一頁，站內任何頁面都渲染不出來。
 *
 * **這不只是畫面上的遮罩** —— 後端同時也把原本公開的那批 GET（相簿清單、
 * 相簿內容、搜尋、標籤、足跡）改成要 token 了。所以繞過這個元件也拿不到資料，
 * 唯一還開著的是圖片（`<img src>` 帶不了 Authorization），而圖片的網址要先拿到
 * 相簿 JSON 才知道。
 *
 * 過了門之後預設是**訪客**：看得到公開內容，沒有任何編輯權，站內也不會再出現
 * 任何「升級成家庭成員」的入口 —— **這裡是全站唯一的登入點**。訪客想換身分
 * 得先登出回到這一頁（使用者的決定：訪客就是只有看跟登出）。
 */
export default function AccessGate({ children }: { children: React.ReactNode }) {
  const { hasAccess, checking, unlock, login, loginWithGoogle, authError } = useAdmin();

  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 管理員密碼那條後路平常收起來 —— 正門是 Google。Google 被打回票時
   * （帳號不在白名單、OAuth 設定壞了）自動攤開，不然使用者會卡在門外沒有出路。
   */
  const [adminFallback, setAdminFallback] = useState(false);
  /** 登入成功、正在往首頁跳。這期間繼續留白，不要閃一下舊頁面 */
  const [leaving, setLeaving] = useState(false);

  // 還在問後端「這張 token 還算數嗎」。這半秒留白，不要先畫出進站畫面
  // —— 已經登入的人每次重整都會看到它閃一下
  if (checking || leaving) return <div className={styles.splash} />;
  if (hasAccess) return <>{children}</>;

  const submit = async () => {
    if (!password || submitting) return;
    setSubmitting(true);
    setError(null);
    // 攤開後路時輸入框的意思就變成「管理員密碼」，兩把鑰匙走的是不同端點
    const result = adminFallback ? await login(password) : await unlock(password);
    if (!result.success) {
      setError(result.message || '密碼錯誤');
      setPassword('');
      setSubmitting(false);
      return;
    }
    /*
     * 登入成功一律回首頁（使用者指定：不管上一次停在哪一頁）。
     *
     * 不這樣做的話，在 /map 或 /album 登出再登入，這個元件一換成 children
     * 就直接停在原來那一頁。用整頁跳轉而不是 router.replace：換身分之後
     * 上一個身分留下的頁面狀態（載到一半的照片、地圖圖層、選取的相簿）
     * 一併清乾淨，剛好也是「不管前一次在哪個分頁狀態」要的效果。
     *
     * Google 那條不必處理：回呼本來就導向首頁（沒帶 state 時）。
     */
    if (window.location.pathname !== '/') {
      setLeaving(true);
      window.location.replace('/');
      return;
    }
    setSubmitting(false);
  };

  return (
    <div className={styles.screen}>
      <div className={styles.card}>
        <div className={styles.brand}>滴答生活</div>
        <p className={styles.subtitle}>
          {adminFallback ? '管理員密碼' : '這是私人相簿，請輸入通行密碼'}
        </p>

        <div className={styles.field}>
          <input
            type="password"
            inputMode="text"
            placeholder={adminFallback ? '管理員密碼...' : '通行密碼...'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            autoFocus
            autoComplete="current-password"
          />
        </div>

        <button
          type="button"
          className={styles.submit}
          onClick={submit}
          disabled={!password || submitting}
        >
          {submitting ? '確認中...' : '進入'}
        </button>

        {error && <p className={styles.error}>{error}</p>}
        {authError && <p className={styles.error}>{authErrorMessage(authError)}</p>}

        <div className={styles.divider} />

        {adminFallback ? (
          <button type="button" className={styles.adminLink} onClick={() => { setAdminFallback(false); setError(null); setPassword(''); }}>
            ← 改用通行密碼進入
          </button>
        ) : (
          <>
            {/* 家庭成員 ＝ 白名單上的 Google 帳號。名字用「家庭成員」不用「管理員」：
                這站是給家人用的，管理員是內部的權限說法，不是訪客該懂的詞 */}
            <button type="button" className={styles.adminLink} onClick={() => loginWithGoogle()}>
              家庭成員登入
            </button>
            <div style={{ marginTop: 10 }}>
              <button type="button" className={styles.adminLink} onClick={() => { setAdminFallback(true); setError(null); setPassword(''); }}>
                改用管理員密碼
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
