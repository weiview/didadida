/**
 * 把後端回的登入失敗原因代碼翻成人話。看得懂才知道是「換個帳號」還是
 * 「去改後端設定」，認不得的代碼就原樣顯示 —— 總比吞掉好。
 *
 * 放在 lib 而不是某一頁裡面：進站畫面（AccessGate）與首頁的管理員登入 Modal
 * 都會顯示同一批代碼，兩邊各寫一份遲早會有一邊漏掉新的原因。
 */
export function authErrorMessage(reason: string): string {
  switch (reason) {
    case 'not_admin':
      return '此 Google 帳號不在白名單中，無法登入。請聯絡站長將此信箱加入白名單後再試。';
    case 'revoked':
      return '此 Google 帳號已停權，如需恢復請聯絡站長。';
    case 'not_configured':
      return '尚未設定 Google 登入（GOOGLE_CLIENT_ID），請改用密碼登入。';
    case 'email_unverified':
      return '此 Google 帳號的信箱尚未驗證，無法用於登入。';
    case 'wrong_audience':
      return 'Google 憑證的對象不是本站，登入設定可能有誤，請改用密碼登入。';
    case 'token_invalid':
      return 'Google 憑證已失效，請重新登入。';
    case 'token_exchange_failed':
      return '無法向 Google 取得憑證，請重新登入；若持續失敗請改用密碼登入。';
    default:
      return `Google 登入失敗（${reason}）。`;
  }
}
