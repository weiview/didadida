'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  AuthState, checkAuth, consumeAuthHash, googleLoginUrl, verifyGuest, verifyLogin,
} from './api';

/**
 * 全站共用的身分狀態。
 *
 * 身分有三種，由外而內：
 *   - **沒進站**：手上沒有有效 token。`AccessGate` 會擋在所有頁面前面要進站密碼，
 *     而且不只是畫面上擋 —— 後端那批原本公開的 GET 現在也會回 401。
 *   - **訪客**（`isGuest`）：用進站密碼換到的身分。看得到的內容跟以前的匿名訪客
 *     一模一樣（私密相簿的座標照樣被後端抹掉），只是外人現在連清單都拿不到。
 *   - **管理員**（`isAdmin`）：Google 登入或 APP_PASSWORD。所有編輯權限。
 *
 * **為什麼是 Provider 而不是各頁各跑一次 hook**：`consumeAuthHash()` 會把網址
 * fragment 裡的 token 收走並立刻擦掉網址，只能有一個人做。以前三個頁面各呼叫一次
 * useAdmin 也還好（同一頁只有一個消費者），但現在 AccessGate 跟頁面同時存在，
 * 兩份 state 會互相搶那個 fragment —— 誰先跑誰拿到，另一邊永遠判成沒登入。
 *
 * `checking` 為 true 時 `isAdmin` 一律是 false —— 先樂觀開放編輯介面再回頭關掉，
 * 使用者會按到一半才發現自己其實沒登入。
 */
interface AuthValue {
  isAdmin: boolean;
  isGuest: boolean;
  /** 進得了站就是 true（訪客或管理員）。AccessGate 唯一看的就是它 */
  hasAccess: boolean;
  checking: boolean;
  /** 進站密碼 → 訪客身分 */
  unlock: (password: string) => Promise<{ success: boolean; message?: string; notConfigured?: boolean }>;
  /** 後路：管理員密碼登入 */
  login: (password: string) => Promise<{ success: boolean; message?: string }>;
  /** 正門：整頁跳去 Google */
  loginWithGoogle: (albumId?: string | number) => void;
  /**
   * Google 登入失敗的原因代碼，登入畫面靠它決定要不要把密碼那條後路端出來。
   * 常見的是 `not_admin`（信箱不在白名單）與 `not_configured`（後端沒設 ADMIN_EMAILS）。
   */
  authError: string | null;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ admin: false, guest: false });
  const [checking, setChecking] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    // 先收登入回呼。這一步是同步的，而且會把 token 寫進 localStorage，
    // 一定要排在 checkAuth() 前面，不然剛登入回來的那一次會被判成沒登入
    const back = consumeAuthHash();
    if (back.error) setAuthError(back.error);
    if (back.admin) {
      setState({ admin: true, guest: false });
      setChecking(false);
      return;
    }

    checkAuth().then((next) => {
      if (!alive) return;
      setState(next);
      setChecking(false);
    });
    return () => { alive = false; };
  }, []);

  /** 整頁跳去 Google。`albumId` 只是為了登入後回到原本那本相簿 */
  const loginWithGoogle = useCallback((albumId?: string | number) => {
    window.location.href = googleLoginUrl(albumId);
  }, []);

  // verifyGuest / verifyLogin 都已經把 token 寫進 localStorage，這裡只更新畫面狀態
  const unlock = useCallback(async (password: string) => {
    const result = await verifyGuest(password);
    if (result.success) setState({ admin: false, guest: true });
    return result;
  }, []);

  const login = useCallback(async (password: string) => {
    const result = await verifyLogin(password);
    if (result.success) setState({ admin: true, guest: false });
    return result;
  }, []);

  const value = useMemo<AuthValue>(() => ({
    isAdmin: state.admin,
    isGuest: state.guest,
    hasAccess: state.admin || state.guest,
    checking,
    unlock,
    login,
    loginWithGoogle,
    authError,
  }), [state, checking, unlock, login, loginWithGoogle, authError]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAdmin(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAdmin 必須用在 <AuthProvider> 裡面（見 app/layout.tsx）');
  return ctx;
}
