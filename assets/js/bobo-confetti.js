/**
 * 波波小遊戲 - 全站共用彩帶模組 (BoboConfetti)
 *
 * 全站原本有四份逐字複製的 triggerConfetti()，各自演化出不一致的修正。
 * 這支模組把它們收斂成單一實作，並把散落的修正一次補齊：
 *   1. prefers-reduced-motion 守衛（原本只有黑白棋有）
 *   2. 保存 rAF handle，stop() 與重複 burst 時 cancelAnimationFrame（原本四份都會疊迴圈或漏收）
 *   3. devicePixelRatio 與視窗尺寸處理（原本直接用 CSS 像素畫，高 DPI 螢幕會糊）
 *   4. 全程 try...catch，取不到 canvas / 2d context 時安靜退場
 *
 * 用法（使用端一律要寫可缺席守衛）：
 *   const confetti = (typeof BoboConfetti !== 'undefined') ? BoboConfetti : null;
 *   if (confetti) this.confettiStop = confetti.burst(canvasEl);
 *
 * 零遊戲耦合：不碰盤面、分數、存檔，也不假設任何全域存在。
 */
const BoboConfetti = (() => {
  'use strict';

  // 預設調色盤：前五色是全站既有實作的共同值，第六色（近白）是黑白棋後來補上的亮點
  const DEFAULT_COLORS = ['#38bdf8', '#fbbf24', '#f43f5e', '#34d399', '#a855f7', '#f8fafc'];
  const DEFAULT_PIECES = 90;
  // 110 幀是黑白棋調整後的值（掃雷等舊版是 90，收得太急）
  const DEFAULT_FRAMES = 110;
  // 0 = 等速下落，與既有四份實作的手感一致；想要加速墜落感可自行傳入 0.05 ~ 0.2
  const DEFAULT_GRAVITY = 0;

  // 回傳給呼叫端的 no-op stop，讓使用端永遠可以無條件呼叫
  const NOOP = () => {};

  const getWin = () => (typeof window !== 'undefined' ? window : null);

  // 是否啟用了「減少動態效果」。取不到 matchMedia 時一律視為沒有啟用。
  const prefersReducedMotion = () => {
    try {
      const win = getWin();
      return !!(win && typeof win.matchMedia === 'function'
        && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_) {
      return false;
    }
  };

  // 每張 canvas 同時只允許一個 rAF 迴圈，重複 burst 會先收掉上一輪
  const running = (typeof WeakMap === 'function') ? new WeakMap() : null;

  const rememberRun = (canvas, stop) => {
    try {
      if (running) running.set(canvas, stop);
    } catch (_) {}
  };

  const forgetRun = (canvas, stop) => {
    try {
      if (running && running.get(canvas) === stop) running.delete(canvas);
    } catch (_) {}
  };

  // 收掉這張 canvas 上還在跑的前一輪
  const stopPrevious = (canvas) => {
    try {
      if (!running) return;
      const prev = running.get(canvas);
      if (typeof prev === 'function') prev();
    } catch (_) {}
  };

  // 取正數，非法值一律回退到預設
  const positive = (value, fallback) => {
    const num = Number(value);
    return (Number.isFinite(num) && num > 0) ? num : fallback;
  };

  // 取有限數（可為 0 或負數），非法值回退到預設
  const finite = (value, fallback) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  };

  /**
   * 在指定 canvas 上灑一次彩帶。
   *
   * @param {HTMLCanvasElement} canvas 目標 canvas（通常是整頁固定定位的 #confetti-canvas）
   * @param {Object} [options]
   * @param {number} [options.pieces=90]    彩帶數量
   * @param {number} [options.frames=110]   播放幾幀後自動收尾
   * @param {string[]} [options.colors]     顏色陣列
   * @param {number} [options.gravity=0]    每幀對 vy 的加速度（0 為等速下落）
   * @param {string} [options.origin='top']  'top' 從畫面上方灑落｜'center' 從畫面中心爆開
   * @param {string} [options.shape='square'] 'square' 旋轉方片｜'circle' 圓點
   * @param {number} [options.fade=0]        每幀 alpha 衰減量，0 代表不淡出（純靠 frames 收尾）
   * @param {number} [options.spread=6]      初速的水平散開幅度（origin: 'center' 時建議加大）
   * @returns {Function} stop()：可重複呼叫，會 cancelAnimationFrame 並清空 canvas
   */
  const burst = (canvas, options) => {
    try {
      const win = getWin();
      // 沒有 window（Node 測試環境）或沒有 rAF 就直接不播
      if (!win || typeof win.requestAnimationFrame !== 'function') return NOOP;
      // 尊重使用者的減少動態偏好：不播，並回傳 no-op stop
      if (prefersReducedMotion()) return NOOP;
      if (!canvas || typeof canvas.getContext !== 'function') return NOOP;

      const ctx = canvas.getContext('2d');
      if (!ctx) return NOOP;

      const opts = options || {};
      const pieceCount = Math.max(1, Math.floor(positive(opts.pieces, DEFAULT_PIECES)));
      const totalFrames = Math.max(1, Math.floor(positive(opts.frames, DEFAULT_FRAMES)));
      const gravity = finite(opts.gravity, DEFAULT_GRAVITY);
      const fromCenter = opts.origin === 'center';
      const isCircle = opts.shape === 'circle';
      const fade = Math.max(0, finite(opts.fade, 0));
      const spread = positive(opts.spread, fromCenter ? 14 : 6);
      const colors = (Array.isArray(opts.colors) && opts.colors.length)
        ? opts.colors.slice()
        : DEFAULT_COLORS;

      // 同一張 canvas 上的前一輪先收掉，避免兩個 rAF 迴圈同時畫同一張圖
      stopPrevious(canvas);

      // 邏輯尺寸一律用 CSS 像素，實體像素由 devicePixelRatio 放大
      const size = { w: 1, h: 1 };

      const resize = () => {
        const dpr = positive(win.devicePixelRatio, 1);
        const w = Math.max(1, Math.floor(positive(win.innerWidth, 1)));
        const h = Math.max(1, Math.floor(positive(win.innerHeight, 1)));
        size.w = w;
        size.h = h;
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
        // 內聯樣式讓 canvas 的 CSS 尺寸與視窗一致（頁面若已用 CSS 設定，這裡的值相同不會有副作用）
        if (canvas.style) {
          canvas.style.width = w + 'px';
          canvas.style.height = h + 'px';
        }
        // 之後所有繪製座標都可以直接用 CSS 像素
        if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      };

      resize();

      const pieces = [];
      for (let i = 0; i < pieceCount; i++) {
        pieces.push({
          // 'center' 從畫面正中央往外爆；'top' 散佈在上方四成的區域往下飄
          x: fromCenter ? size.w / 2 : Math.random() * size.w,
          y: fromCenter ? size.h / 2 : Math.random() * size.h * 0.4,
          size: Math.random() * (isCircle ? 6 : 8) + 4,
          color: colors[Math.floor(Math.random() * colors.length)],
          vx: (Math.random() - 0.5) * spread,
          // 中心爆發要先往上衝再被重力拉回來，所以初速偏負
          vy: fromCenter ? (Math.random() - 0.8) * spread * 0.85 : Math.random() * 4 + 2,
          rot: Math.random() * 360,
          dRot: (Math.random() - 0.5) * 8,
          alpha: 1
        });
      }

      let frameHandle = null;
      let stopped = false;

      const onResize = () => {
        try {
          resize();
        } catch (_) {}
      };

      try {
        if (typeof win.addEventListener === 'function') win.addEventListener('resize', onResize);
      } catch (_) {}

      // stop() 可以被重複呼叫，第二次之後是 no-op
      const stop = () => {
        if (stopped) return;
        stopped = true;
        try {
          if (frameHandle !== null && typeof win.cancelAnimationFrame === 'function') {
            win.cancelAnimationFrame(frameHandle);
          }
        } catch (_) {}
        frameHandle = null;
        try {
          if (typeof win.removeEventListener === 'function') win.removeEventListener('resize', onResize);
        } catch (_) {}
        try {
          ctx.clearRect(0, 0, size.w, size.h);
        } catch (_) {}
        forgetRun(canvas, stop);
      };

      rememberRun(canvas, stop);

      let frames = 0;
      const step = () => {
        if (stopped) return;
        try {
          ctx.clearRect(0, 0, size.w, size.h);
          let alive = false;
          for (let i = 0; i < pieces.length; i++) {
            const p = pieces[i];
            p.vy += gravity;
            p.x += p.vx;
            p.y += p.vy;
            p.rot += p.dRot;
            if (fade > 0) {
              p.alpha -= fade;
              if (p.alpha <= 0) continue;   // 淡光了就不畫，也不算還活著
            }
            alive = true;
            ctx.save();
            ctx.globalAlpha = fade > 0 ? Math.max(0, Math.min(1, p.alpha)) : 1;
            ctx.translate(p.x, p.y);
            ctx.fillStyle = p.color;
            if (isCircle) {
              // 圓點不旋轉（轉了也看不出來，省一次 rotate）
              ctx.beginPath();
              ctx.arc(0, 0, p.size, 0, Math.PI * 2);
              ctx.fill();
            } else {
              ctx.rotate((p.rot * Math.PI) / 180);
              ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
            }
            ctx.restore();
          }
          frames++;
          // 有開淡出時，全部淡光就提早收尾（不必硬撐到 frames 上限）
          if (fade > 0 && !alive) {
            frameHandle = null;
            stop();
          } else if (frames < totalFrames) {
            frameHandle = win.requestAnimationFrame(step);
          } else {
            frameHandle = null;
            // 播完照樣走 stop()：清空畫布、解掉 resize 監聽、從 running 表移除
            stop();
          }
        } catch (_) {
          // 畫到一半出錯（例如 canvas 被移除）就安靜收尾，不讓例外往外丟
          stop();
        }
      };

      frameHandle = win.requestAnimationFrame(step);
      return stop;
    } catch (_) {
      return NOOP;
    }
  };

  /**
   * 主動收掉某張 canvas 上還在跑的彩帶（例如重開新局時）。
   * 沒有正在跑的動畫時是 no-op。
   */
  const stop = (canvas) => {
    try {
      if (canvas) stopPrevious(canvas);
    } catch (_) {}
  };

  return {
    burst,
    stop,
    prefersReducedMotion,
    DEFAULT_COLORS,
    DEFAULT_PIECES,
    DEFAULT_FRAMES,
    DEFAULT_GRAVITY
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = BoboConfetti;
}
