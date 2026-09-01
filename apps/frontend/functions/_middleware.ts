/*
 * 前端這一道地理閘門。**後端 `apps/backend/src/index.ts` 還有一道**（看
 * `request.cf.country`），兩道各自獨立 —— 只關掉一道等於沒關，改允許清單
 * 一定要兩邊一起改。
 *
 * 2026-09-01：從「只有台灣」放寬成「台灣＋澳洲／紐西蘭」——
 * 家人住在澳洲，原本整個站對他是一片 403。
 * 這一層本來就只是縱深防禦：真正的護欄是進站閘門（密碼／Google 登入換 token），
 * 沒有 token 的請求在後端一律 401。
 *
 * `XX` 與 `T1` 不是國家：前者是 Cloudflare 判不出來時給的值（含本機開發），
 * 後者是 Tor。判不出來就放行，寧可漏也不要把自己人擋在外面。
 */
const ALLOWED_COUNTRIES = new Set(['TW', 'AU', 'NZ', 'XX', 'T1']);

export const onRequest = async (context: any) => {
  const country = context.request.headers.get('cf-ipcountry');

  if (country && !ALLOWED_COUNTRIES.has(country.toUpperCase())) {
    return new Response('Access Denied.', { status: 403 });
  }

  return context.next();
};
