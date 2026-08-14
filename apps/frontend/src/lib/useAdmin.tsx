'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  AuthState, CurrentUser, checkAuth, consumeAuthHash, googleLoginUrl,
  logout as clearTokens, updateMyName, updateMyTrackColor, verifyGuest, verifyLogin,
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
  /** 登入中的那個人。訪客是 null */
  user: CurrentUser | null;
  /** 站長。唯一看得到 /admin 後台設定的人 */
  isOwner: boolean;
  /** 可以動別人的相簿與照片。站長永遠是 true */
  canManageOthers: boolean;
  /**
   * 看不看得到足跡地圖。管理員永遠是 true，訪客要站長在後台開了才有。
   * 沒有就不端出首頁那個連結，`/map` 本身也會擋（後端 403，這裡只是不讓人白跑）。
   */
  canViewMap: boolean;
  /**
   * 這本相簿／這張照片是不是「我的」，也就是畫面上該不該出現編輯與刪除。
   *
   * 跟後端 actorOwns 同一條規則：相簿主人是我、或照片是我傳的，任一相符就算數。
   * **前端這一層只是不端出按了會失敗的按鈕**，真正的閘門在後端 —— 這裡放行
   * 不等於改得動，這裡擋掉也不代表資料是安全的。
   */
  canEdit: (target: { user_id?: number | null; uploaded_by?: number | null } | null | undefined) => boolean;
  /**
   * 可不可以把照片**加進**這本相簿（上傳／從 Google 相簿匯入）。
   *
   * 跟 canEdit 分開是這一版的重點：家人本來連別人相簿的上傳鈕都看不到。
   * 現在「往裡面加」預設就有（站長可在 /admin 對個別帳號關掉），
   * 「改名／刪相簿／編輯別人的照片」照舊看 canEdit。
   */
  canAddTo: (target: { user_id?: number | null } | null | undefined) => boolean;
  /** 可不可以調整這本相簿裡的照片順序。預設只有自己的相簿，其餘要站長給 */
  canReorderIn: (target: { user_id?: number | null } | null | undefined) => boolean;
  /** 進站密碼 → 訪客身分 */
  unlock: (password: string) => Promise<{ success: boolean; message?: string; notConfigured?: boolean }>;
  /** 後路：管理員密碼登入 */
  login: (password: string) => Promise<{ success: boolean; message?: string }>;
  /** 正門：整頁跳去 Google */
  loginWithGoogle: (albumId?: string | number) => void;
  /**
   * Google 登入失敗的原因代碼，登入畫面靠它決定要不要把密碼那條後路端出來。
   * 常見的是 `not_admin`（信箱不在白名單，得先請站長加）與 `revoked`（在名單上但被停權）。
   */
  authError: string | null;
  /** 改自己的顯示名稱，成功會同步更新這裡的 user */
  renameSelf: (name: string) => Promise<{ success: boolean; message?: string }>;
  /**
   * 挑自己在地圖上的軌跡顏色（只收 TRACK_PALETTE 裡的值）。
   * 顏色是**每個人自己的**，所以在帳號牌上改，不在站長後台。
   */
  recolorSelf: (color: string) => Promise<{ success: boolean; message?: string }>;
  /** 登出：清掉站上與 Google 的 token，回到進站畫面 */
  logout: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ admin: false, guest: false, canViewMap: false, user: null });
  const [checking, setChecking] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    // 先收登入回呼。這一步是同步的，而且會把 token 寫進 localStorage，
    // 一定要排在 checkAuth() 前面，不然剛登入回來的那一次會被判成沒登入
    const back = consumeAuthHash();
    if (back.error) setAuthError(back.error);
    /*
     * 剛從 Google 回來。token 已經在 localStorage 裡了，但**還是要打一次
     * /auth/me** —— 「我是誰、能不能管別人」只有後端知道，fragment 裡沒有。
     * 先樂觀把 admin 設成 true 讓畫面立刻可用，帳號資料隨後補上。
     */
    if (back.admin) {
      setState({ admin: true, guest: false, canViewMap: true, user: null });
      checkAuth().then((next) => {
        if (!alive) return;
        setState(next);
        setChecking(false);
      });
      return () => { alive = false; };
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
    // 這裡要回後端問一次而不是自己拼 state：訪客看不看得到足跡地圖
    // 是站長的設定，只有 /auth/me 知道
    if (result.success) setState(await checkAuth());
    return result;
  }, []);

  const login = useCallback(async (password: string) => {
    const result = await verifyLogin(password);
    // 密碼登入拿到的是站長身分，但帳號資料一樣得回後端問
    if (result.success) setState(await checkAuth());
    return result;
  }, []);

  const renameSelf = useCallback(async (name: string) => {
    const result = await updateMyName(name);
    if (result.success && result.user) {
      setState((prev) => ({ ...prev, user: result.user! }));
    }
    return { success: result.success, message: result.message };
  }, []);

  const recolorSelf = useCallback(async (color: string) => {
    const result = await updateMyTrackColor(color);
    if (result.success && result.user) {
      setState((prev) => ({ ...prev, user: result.user! }));
    }
    return { success: result.success, message: result.message };
  }, []);

  const logout = useCallback(() => {
    clearTokens();
    setState({ admin: false, guest: false, canViewMap: false, user: null });
    setAuthError(null);
  }, []);

  const canManageOthers = state.user
    ? state.user.role === 'owner' || state.user.can_manage_others === 1
    // 沒有帳號資料的管理員只可能是舊 token（後端會當站長）。維持原本的全開行為，
    // 免得升級的當下所有編輯按鈕突然消失，看起來像壞掉
    : state.admin;

  const canEdit = useCallback((target: { user_id?: number | null; uploaded_by?: number | null } | null | undefined) => {
    if (!state.admin) return false;
    if (canManageOthers) return true;
    const uid = state.user?.id;
    if (uid == null || !target) return false;
    return target.user_id === uid || target.uploaded_by === uid;
  }, [state.admin, state.user, canManageOthers]);

  const canAddTo = useCallback((target: { user_id?: number | null } | null | undefined) => {
    if (!state.admin) return false;
    if (canManageOthers) return true;
    // 自己的相簿本來就進得去，不必靠這個權限
    const uid = state.user?.id;
    if (uid != null && target?.user_id === uid) return true;
    return state.user?.can_add_to_others === 1;
  }, [state.admin, state.user, canManageOthers]);

  const canReorderIn = useCallback((target: { user_id?: number | null } | null | undefined) => {
    if (!state.admin) return false;
    if (canManageOthers) return true;
    const uid = state.user?.id;
    if (uid != null && target?.user_id === uid) return true;
    return state.user?.can_reorder_others === 1;
  }, [state.admin, state.user, canManageOthers]);

  const value = useMemo<AuthValue>(() => ({
    isAdmin: state.admin,
    isGuest: state.guest,
    hasAccess: state.admin || state.guest,
    checking,
    user: state.user,
    isOwner: state.user?.role === 'owner',
    canManageOthers,
    canViewMap: state.canViewMap,
    canEdit,
    canAddTo,
    canReorderIn,
    unlock,
    login,
    loginWithGoogle,
    authError,
    renameSelf,
    recolorSelf,
    logout,
  }), [state, checking, canManageOthers, canEdit, canAddTo, canReorderIn, unlock, login, loginWithGoogle,
       authError, renameSelf, recolorSelf, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAdmin(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAdmin 必須用在 <AuthProvider> 裡面（見 app/layout.tsx）');
  return ctx;
}
