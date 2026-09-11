/**
 * 波波小遊戲 - 全站共用主題模組 (BoboTheme)
 *
 * 主題這件事有兩個「只靠人工紀律很容易漏」的點，而全站現況已經漏了：
 *
 *   1. 防閃爍那段 IIFE 必須 inline 在 <head> 且在 CSS 之前（外連的 script 來不及，
 *      深色使用者進頁面會先閃一下白畫面）。它先天不能抽成模組，
 *      但它可以是一段「逐字複製的固定樣板」—— 就是下面的 ANTI_FLASH_SNIPPET。
 *      loop 與 make24 目前就是漏了這段。
 *
 *   2. 寫入 bobo-home-preferences-v2 時必須「先讀回整包再只改 theme 欄位」。
 *      整包覆寫會清掉使用者在首頁排的卡片順序（order）與隱藏設定（hidden）。
 *      這條規則每款遊戲各自重寫一次，寫錯一次就出事，所以只該有一份實作 —— 就是這裡。
 *
 * 用法（使用端一律要寫可缺席守衛）：
 *   const themeKit = (typeof BoboTheme !== 'undefined') ? BoboTheme : null;
 *   if (themeKit) themeKit.init();
 *   if (themeKit) themeKit.toggle();
 *
 * 不假設任何全域存在（window / document 都有 typeof 守衛），
 * 所有 localStorage 操作一律包 try...catch。
 */
const BoboTheme = (() => {
  'use strict';

  // 首頁偏好的儲存鍵。這一包同時放 theme / order / hidden，所以永遠只能 merge，不能覆寫。
  const HOME_PREF_KEY = 'bobo-home-preferences-v2';

  const DARK = 'dark';
  const LIGHT = 'light';

  // meta[name="theme-color"] 的預設值。
  // 個別頁面若要用自己的色票，可在該 meta 上加
  // data-theme-color-dark / data-theme-color-light 屬性覆寫。
  const DEFAULT_META_DARK = '#0f172a';
  const DEFAULT_META_LIGHT = '#f5f7fb';

  /**
   * 必須 inline 進每個頁面 <head>、且排在所有 CSS 連結之前的防閃爍樣板。
   * 這是全站唯一的複製來源 —— 請整段逐字貼進 <script> ... </script>，不要改寫。
   */
  const ANTI_FLASH_SNIPPET = [
    '(() => {',
    '  try {',
    "    const homePref = JSON.parse(localStorage.getItem('bobo-home-preferences-v2') || '{}');",
    "    const theme = ['dark', 'light'].includes(homePref.theme)",
    '      ? homePref.theme',
    "      : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');",
    '    document.documentElement.dataset.theme = theme;',
    '  } catch (_) {}',
    '})();'
  ].join('\n');

  const getWin = () => (typeof window !== 'undefined' ? window : null);
  const getDoc = () => (typeof document !== 'undefined' ? document : null);

  // 取得 localStorage；拿不到（隱私模式、Node）就回 null
  const getStore = () => {
    try {
      const win = getWin();
      if (win && win.localStorage) return win.localStorage;
      if (typeof localStorage !== 'undefined') return localStorage;
    } catch (_) {}
    return null;
  };

  const isPlainObject = (value) => (
    !!value && typeof value === 'object' && !Array.isArray(value)
  );

  const isTheme = (value) => (value === DARK || value === LIGHT);

  // 讀回整包首頁偏好。任何異常（沒有 localStorage、JSON 壞掉、值不是物件）一律回空物件。
  const readHomePreferences = () => {
    const store = getStore();
    if (!store) return {};
    try {
      const raw = store.getItem(HOME_PREF_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return isPlainObject(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  };

  /**
   * 只改 theme 欄位，其餘欄位（order / hidden 以及未來新增的任何欄位）原封不動帶回去。
   * 【絕對不可】改成直接寫入 { theme } —— 那會清掉使用者在首頁排的順序與隱藏設定。
   */
  const writeHomeTheme = (theme) => {
    if (!isTheme(theme)) return false;
    const store = getStore();
    if (!store) return false;
    try {
      const merged = readHomePreferences();
      merged.theme = theme;
      store.setItem(HOME_PREF_KEY, JSON.stringify(merged));
      return true;
    } catch (_) {
      return false;
    }
  };

  // 系統目前是不是深色。取不到 matchMedia 時一律當作淺色。
  const systemTheme = () => {
    try {
      const win = getWin();
      if (win && typeof win.matchMedia === 'function') {
        return win.matchMedia('(prefers-color-scheme: dark)').matches ? DARK : LIGHT;
      }
    } catch (_) {}
    return LIGHT;
  };

  /**
   * 使用者有沒有「明確選過」主題。
   * 有的話系統主題變化時就不該跟著改，否則會覆蓋掉使用者的選擇。
   */
  const hasExplicitPreference = () => {
    const home = readHomePreferences();
    return isTheme(home.theme);
  };

  /**
   * 讀取目前該用的主題。
   * 有存過的偏好就用它，沒有就跟隨系統的 prefers-color-scheme。
   * @returns {'dark'|'light'}
   */
  const read = () => {
    const home = readHomePreferences();
    if (isTheme(home.theme)) return home.theme;
    return systemTheme();
  };

  // 同步 <meta name="theme-color">，讓行動裝置的網址列跟著換色
  const syncMetaThemeColor = (theme) => {
    const doc = getDoc();
    if (!doc || typeof doc.querySelector !== 'function') return;
    try {
      const meta = doc.querySelector('meta[name="theme-color"]');
      if (!meta || typeof meta.setAttribute !== 'function') return;
      let color = null;
      if (typeof meta.getAttribute === 'function') {
        color = meta.getAttribute(theme === DARK ? 'data-theme-color-dark' : 'data-theme-color-light');
      }
      if (!color) color = theme === DARK ? DEFAULT_META_DARK : DEFAULT_META_LIGHT;
      meta.setAttribute('content', color);
    } catch (_) {}
  };

  /**
   * 套用主題到 documentElement.dataset.theme 並同步 meta theme-color。
   * 只套用、不持久化 —— 持久化是 toggle() 的事。
   * @param {'dark'|'light'} theme
   * @returns {'dark'|'light'} 實際套用的主題（傳入非法值時回退為目前偏好）
   */
  const apply = (theme) => {
    const next = isTheme(theme) ? theme : read();
    const doc = getDoc();
    if (doc && doc.documentElement) {
      try {
        if (doc.documentElement.dataset) {
          doc.documentElement.dataset.theme = next;
        } else if (typeof doc.documentElement.setAttribute === 'function') {
          doc.documentElement.setAttribute('data-theme', next);
        }
      } catch (_) {}
    }
    syncMetaThemeColor(next);
    return next;
  };

  // 目前畫面上掛著的主題（以 DOM 為準，讀不到就退回偏好）
  const current = () => {
    const doc = getDoc();
    try {
      if (doc && doc.documentElement && doc.documentElement.dataset
        && isTheme(doc.documentElement.dataset.theme)) {
        return doc.documentElement.dataset.theme;
      }
    } catch (_) {}
    return read();
  };

  /**
   * 切換主題並持久化（只改 bobo-home-preferences-v2 的 theme 欄位）。
   * @returns {'dark'|'light'} 切換後的新主題
   */
  const toggle = () => {
    const next = current() === DARK ? LIGHT : DARK;
    apply(next);
    writeHomeTheme(next);
    return next;
  };

  // 已掛上的系統主題監聽器，避免重複 init 疊加監聽
  let mediaQuery = null;
  let mediaListener = null;

  const detachSystemListener = () => {
    if (!mediaQuery || !mediaListener) return;
    try {
      if (typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', mediaListener);
      } else if (typeof mediaQuery.removeListener === 'function') {
        mediaQuery.removeListener(mediaListener);
      }
    } catch (_) {}
    mediaQuery = null;
    mediaListener = null;
  };

  const attachSystemListener = () => {
    detachSystemListener();
    try {
      const win = getWin();
      if (!win || typeof win.matchMedia !== 'function') return;
      const mq = win.matchMedia('(prefers-color-scheme: dark)');
      if (!mq) return;
      const listener = (event) => {
        try {
          // 使用者明確選過主題就不跟隨系統，否則會蓋掉他的選擇
          if (hasExplicitPreference()) return;
          const dark = event && typeof event.matches === 'boolean' ? event.matches : mq.matches;
          apply(dark ? DARK : LIGHT);
        } catch (_) {}
      };
      if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', listener);
      } else if (typeof mq.addListener === 'function') {
        // Safari 14 以前只有舊式 API
        mq.addListener(listener);
      } else {
        return;
      }
      mediaQuery = mq;
      mediaListener = listener;
    } catch (_) {}
  };

  /**
   * 套用目前偏好並開始監聽系統主題變化（使用者沒有明確選過時才跟隨）。
   * 可重複呼叫，不會疊加監聽器。
   * @returns {'dark'|'light'} 套用的主題
   */
  const init = () => {
    const theme = apply(read());
    attachSystemListener();
    return theme;
  };

  /** 停止監聽系統主題變化（頁面卸載或測試收尾用） */
  const destroy = () => {
    detachSystemListener();
  };

  return {
    read,
    apply,
    toggle,
    init,
    destroy,
    current,
    hasExplicitPreference,
    readHomePreferences,
    writeHomeTheme,
    systemTheme,
    HOME_PREF_KEY,
    ANTI_FLASH_SNIPPET
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = BoboTheme;
}
