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
      return '這個 Google 帳號不在管理員名單裡。換個帳號登入，或用下面的密碼進來。';
    case 'not_configured':
      return '後端還沒設定管理員信箱（ADMIN_EMAILS），Google 登入暫時不能用。請先用密碼登入。';
    case 'email_unverified':
      return '這個 Google 帳號的信箱還沒驗證，不能用來登入管理員。';
    case 'wrong_audience':
      return 'Google 給的憑證不是發給這個網站的，登入流程設定可能壞了。請用密碼登入。';
    case 'token_invalid':
      return 'Google 憑證失效了，請再試一次。';
    default:
      return `Google 登入失敗（${reason}）。`;
  }
}
