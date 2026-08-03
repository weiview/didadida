'use client';

import { useCallback, useEffect, useState } from 'react';
import { checkAuth, verifyLogin } from './api';

/**
 * 三個頁面共用的管理員狀態。
 *
 * 以前首頁、相簿頁、地圖頁各有一套判斷（前兩者拿明文密碼重新驗證、地圖頁只看
 * localStorage 有沒有 token），結果地圖頁在 token 過期後仍然把整區管理工具顯示
 * 出來，按下去才靜默失敗。統一成這一個 hook，唯一依據是後端的 /api/auth/me。
 *
 * `checking` 為 true 時代表還沒問出結果，此時 `isAdmin` 一律是 false ——
 * 先樂觀開放編輯介面再回頭關掉，使用者會按到一半才發現自己其實沒登入。
 */
export function useAdmin() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let alive = true;
    checkAuth().then((ok) => {
      if (!alive) return;
      setIsAdmin(ok);
      setChecking(false);
    });
    return () => { alive = false; };
  }, []);

  /** 登入成功時 verifyLogin 已經把 token 寫進 localStorage，這裡只要更新畫面狀態 */
  const login = useCallback(async (password: string) => {
    const result = await verifyLogin(password);
    if (result.success) setIsAdmin(true);
    return result;
  }, []);

  return { isAdmin, checking, login };
}
