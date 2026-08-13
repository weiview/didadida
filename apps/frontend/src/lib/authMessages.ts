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
      return '這個 Google 帳號不在白名單裡，所以不能當管理員。請站長先把這個信箱加進白名單，再登入一次。';
    case 'revoked':
      return '這個 Google 帳號已經被停權了。要恢復請找站長。';
    case 'not_configured':
      return '後端還沒設定 Google 登入（GOOGLE_CLIENT_ID），暫時不能用。請先用密碼登入。';
    case 'email_unverified':
      return '這個 Google 帳號的信箱還沒驗證，不能用來登入管理員。';
    case 'wrong_audience':
      return 'Google 給的憑證不是發給這個網站的，登入流程設定可能壞了。請用密碼登入。';
    case 'token_invalid':
      return 'Google 憑證失效了，請再試一次。';
    case 'token_exchange_failed':
      return 'Google 那邊沒有換到憑證，請再登入一次。一直失敗的話請用密碼進來。';
    default:
      return `Google 登入失敗（${reason}）。`;
  }
}
