'use client';

import { useCallback, useEffect, useState } from 'react';
import { checkAuth, consumeAuthHash, googleLoginUrl, verifyLogin } from './api';

/**
 * 三個頁面共用的管理員狀態。
 *
 * 以前首頁、相簿頁、地圖頁各有一套判斷（前兩者拿明文密碼重新驗證、地圖頁只看
 * localStorage 有沒有 token），結果地圖頁在 token 過期後仍然把整區管理工具顯示
 * 出來，按下去才靜默失敗。統一成這一個 hook，唯一依據是後端的 /api/auth/me。
 *
 * `checking` 為 true 時代表還沒問出結果，此時 `isAdmin` 一律是 false ——
 * 先樂觀開放編輯介面再回頭關掉，使用者會按到一半才發現自己其實沒登入。
 *
 * **登入的正門是 Google**（`loginWithGoogle`）：同一次授權就把 Drive 備份與
 * 相簿匯入的權限一起拿到，不必再另外「連結 Google Drive」。密碼登入留著當後路
 * —— Google 掛掉、帳號被鎖、OAuth 設定改壞的時候還進得了後台。
 */
export function useAdmin() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [checking, setChecking] = useState(true);
  /**
   * Google 登入失敗的原因代碼，登入畫面靠它決定要不要把密碼那條後路端出來。
   * 常見的是 `not_admin`（信箱不在白名單）與 `not_configured`（後端沒設 ADMIN_EMAILS）。
   */
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    // 先收登入回呼。這一步是同步的，而且會把 token 寫進 localStorage，
    // 一定要排在 checkAuth() 前面，不然剛登入回來的那一次會被判成沒登入
    const back = consumeAuthHash();
    if (back.error) setAuthError(back.error);
    if (back.admin) {
      setIsAdmin(true);
      setChecking(false);
      return;
    }

    checkAuth().then((ok) => {
      if (!alive) return;
      setIsAdmin(ok);
      setChecking(false);
    });
    return () => { alive = false; };
  }, []);

  /** 整頁跳去 Google。`albumId` 只是為了登入後回到原本那本相簿 */
  const loginWithGoogle = useCallback((albumId?: string | number) => {
    window.location.href = googleLoginUrl(albumId);
  }, []);

  /** 後路：密碼登入。verifyLogin 已經把 token 寫進 localStorage，這裡只要更新畫面狀態 */
  const login = useCallback(async (password: string) => {
    const result = await verifyLogin(password);
    if (result.success) setIsAdmin(true);
    return result;
  }, []);

  return { isAdmin, checking, login, loginWithGoogle, authError };
}
