/**
 * 波波小遊戲 - 全站共用 Web Audio 樣板模組 (BoboAudio)
 *
 * 全站有六份各自演化的 Web Audio 合成器（battleship / loop / make24 /
 * minesweeper / reversi / 2048）。它們的「音色」各有個性，應該留在各自的遊戲裡；
 * 但底下那層瀏覽器樣板六份幾乎一樣，而且每一份都漏了別人有補的東西：
 *
 *   1. AudioContext 一律延後到「第一次使用者手勢」才 new（iOS 不給在手勢外播聲音），
 *      之後靠 resume() 喚醒 —— 六份都是延後建立，但只有 battleship 有綁手勢解鎖。
 *   2. visibilitychange 進背景 suspend、回前景 resume（行動裝置省電與通話中斷）。
 *      只有 battleship / reversi / 2048 有處理 'interrupted' 這個 Safari 專屬狀態。
 *   3. 【本模組要根治的洩漏】每一個 oscillator / bufferSource 都必須 stop()，
 *      而且結束後要 disconnect。meowdoku.js:249 有踩過的註解：
 *      「所有 oscillator（含 LFO）都必須 stop，漏掉 LFO 會讓整條子圖永久存活」。
 *      battleship 的 playHit() 現在就漏了 noise.stop()。
 *   4. enabled 開關的 localStorage 持久化。六份有三種寫法（整個 key 是布林、
 *      key 是物件的某個欄位、battleship 存的還是反過來的 muted），
 *      而且物件模式一定要「讀回整包再只改那個欄位」，否則會清掉其他偏好。
 *   5. 所有音訊操作包 try...catch（隱私模式、自動播放政策、context 已關閉
 *      都會丟出各式各樣的例外，絕對不能讓遊戲跟著掛掉）。
 *
 * 【界線】這支模組只做上面這層樣板，不做音色。
 * playPlace() / playWin() / playMerge() 這些是各遊戲的個性，請在自己的檔案裡
 * 用 kit.tone() / kit.sweep() / kit.chord() / kit.noise() 組出來。
 *
 * 用法（使用端一律要寫可缺席守衛）：
 *   const audioKit = (typeof BoboAudio !== 'undefined' && BoboAudio)
 *     ? BoboAudio.create({ storageKey: PREF_KEY, storageField: 'sound' })
 *     : null;
 *   if (audioKit) audioKit.tone({ freq: 420, type: 'triangle', duration: 0.07, gain: 0.18 });
 *
 * 模組載入失敗時遊戲必須還能正常玩，只是沒有音效。
 * 本模組本身也不假設任何全域存在（window / document / localStorage /
 * AudioContext 全部都有 typeof 守衛），因為 tests/games.test.js 會用
 * new Function(source) 編譯它，那個環境什麼都沒有。
 */
const BoboAudio = (() => {
  'use strict';

  // --- 常數 ---------------------------------------------------------------

  const WAVE_TYPES = ['sine', 'square', 'sawtooth', 'triangle'];
  const FILTER_TYPES = [
    'lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass'
  ];

  // exponentialRampToValueAtTime 的目標不可以是 0，也不可以跨越 0，
  // 所以音量的地板統一夾到這個極小值（等同六份實作裡的 0.0001）。
  const MIN_LEVEL = 0.0001;
  // 頻率同理，不能指數滑到 0（reversi / 2048 原本就寫 Math.max(1, toFreq)）
  const MIN_FREQ = 1;

  // 預設值：以 reversi / 2048 這兩份最新的實作為準
  const DEFAULTS = {
    type: 'sine',
    duration: 0.08,
    gain: 0.12,
    delay: 0,
    attack: 0,
    release: 0,
    floor: MIN_LEVEL,
    curve: 'exponential',
    freqCurve: 'exponential'
  };

  // --- 環境存取（全部都要 typeof 守衛）-------------------------------------

  const getWin = () => {
    try {
      return (typeof window !== 'undefined' && window) ? window : null;
    } catch (_) {
      return null;
    }
  };

  const getDoc = () => {
    try {
      return (typeof document !== 'undefined' && document) ? document : null;
    } catch (_) {
      return null;
    }
  };

  // 取得 localStorage；拿不到（隱私模式、Node 測試環境）就回 null
  const getStore = () => {
    try {
      const win = getWin();
      if (win && win.localStorage) return win.localStorage;
      if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
    } catch (_) {}
    return null;
  };

  // 取得 AudioContext 建構子（含 Safari 的 webkit 前綴）
  const getAudioCtor = () => {
    try {
      const win = getWin();
      if (win && (win.AudioContext || win.webkitAudioContext)) {
        return win.AudioContext || win.webkitAudioContext;
      }
      if (typeof AudioContext !== 'undefined' && AudioContext) return AudioContext;
    } catch (_) {}
    return null;
  };

  const setTimer = (fn, ms) => {
    try {
      const win = getWin();
      if (win && typeof win.setTimeout === 'function') return win.setTimeout(fn, ms);
      if (typeof setTimeout === 'function') return setTimeout(fn, ms);
    } catch (_) {}
    return null;
  };

  const clearTimer = (handle) => {
    if (handle === null || handle === undefined) return;
    try {
      const win = getWin();
      if (win && typeof win.clearTimeout === 'function') {
        win.clearTimeout(handle);
        return;
      }
      if (typeof clearTimeout === 'function') clearTimeout(handle);
    } catch (_) {}
  };

  // --- 小工具 -------------------------------------------------------------

  const isPlainObject = (value) => (
    !!value && typeof value === 'object' && !Array.isArray(value)
  );

  // 取正數（必須 > 0），非法值回退預設
  const positive = (value, fallback) => {
    const num = Number(value);
    return (Number.isFinite(num) && num > 0) ? num : fallback;
  };

  // 取有限數（可為 0 或負數），非法值回退預設
  const finite = (value, fallback) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const waveType = (value) => (
    (typeof value === 'string' && WAVE_TYPES.indexOf(value) !== -1) ? value : DEFAULTS.type
  );

  const filterType = (value) => (
    (typeof value === 'string' && FILTER_TYPES.indexOf(value) !== -1) ? value : 'lowpass'
  );

  const curveOf = (value) => (value === 'linear' ? 'linear' : 'exponential');

  /**
   * 把存進 localStorage 的各種寫法還原成布林。
   * 六份實作寫進去的東西長得都不一樣：
   *   localStorage.setItem(key, this.enabled)   → 'true' / 'false'
   *   localStorage.setItem(key, String(flag))   → 'true' / 'false'
   *   JSON.stringify({ sound: true })           → 真布林
   * 認不出來就回 null，代表「沒存過」，由 defaultEnabled 決定。
   */
  const toBool = (value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
    if (typeof value === 'string') {
      const text = value.trim().toLowerCase();
      if (text === 'true' || text === '1' || text === 'on' || text === 'yes') return true;
      if (text === 'false' || text === '0' || text === 'off' || text === 'no') return false;
    }
    return null;
  };

  // AudioParam 可能是假的（測試替身），一律降級成直接寫 value
  const setParam = (param, value, time) => {
    if (!param) return;
    try {
      if (typeof param.setValueAtTime === 'function') {
        param.setValueAtTime(value, time);
      } else {
        param.value = value;
      }
    } catch (_) {}
  };

  const rampParam = (param, target, time, curve, minValue) => {
    if (!param) return;
    try {
      if (curve === 'linear') {
        if (typeof param.linearRampToValueAtTime === 'function') {
          param.linearRampToValueAtTime(Math.max(0, target), time);
        } else {
          param.value = Math.max(0, target);
        }
        return;
      }
      const safe = Math.max(minValue, target);
      if (typeof param.exponentialRampToValueAtTime === 'function') {
        param.exponentialRampToValueAtTime(safe, time);
      } else {
        param.value = safe;
      }
    } catch (_) {}
  };

  /**
   * 音量包絡。
   * attack = 0 且 release = 0（預設）時的行為就是六份實作的原樣：
   *   setValueAtTime(peak, start) → ramp 到 floor(start + duration)
   * 所以照搬既有音色時完全不需要碰這兩個參數，音色保證不變。
   */
  const applyEnvelope = (param, spec) => {
    const end = spec.start + spec.duration;
    let holdFrom = spec.start;

    if (spec.attack > 0) {
      // 有 attack 就從地板指數爬上峰值，避免 click
      setParam(param, spec.floor, spec.start);
      holdFrom = spec.start + Math.min(spec.attack, spec.duration);
      rampParam(param, spec.peak, holdFrom, 'exponential', MIN_LEVEL);
    } else {
      setParam(param, spec.peak, spec.start);
    }

    if (spec.release > 0) {
      // release > 0：先維持峰值到 end - release，最後 release 秒才衰減
      const decayFrom = Math.max(holdFrom, end - spec.release);
      if (decayFrom > holdFrom) setParam(param, spec.peak, decayFrom);
    }

    rampParam(param, spec.floor, end, spec.curve, MIN_LEVEL);
  };

  // --- 偏好持久化 ---------------------------------------------------------

  /**
   * 讀回已存的開關。
   * @returns {boolean|null} null 代表沒存過／讀不到，交給 defaultEnabled
   */
  const readPersisted = (cfg) => {
    const store = getStore();
    if (!store || !cfg.storageKey) return null;
    try {
      const raw = store.getItem(cfg.storageKey);
      if (raw === null || raw === undefined || raw === '') return null;
      if (cfg.storageField) {
        const parsed = JSON.parse(raw);
        if (!isPlainObject(parsed)) return null;
        return toBool(parsed[cfg.storageField]);
      }
      return toBool(raw);
    } catch (_) {
      return null;
    }
  };

  /**
   * 寫回開關。
   * storageField 模式【一定】要先讀回整包再只改那個欄位 ——
   * 整包覆寫會清掉同一個 key 裡的其他偏好（難度、主題、盤面設定…）。
   */
  const writePersisted = (cfg, enabled) => {
    const store = getStore();
    if (!store || !cfg.storageKey) return false;
    // invert：battleship 存的是 muted，跟 enabled 相反
    const stored = cfg.invert ? !enabled : enabled;
    try {
      if (cfg.storageField) {
        let merged = {};
        try {
          const raw = store.getItem(cfg.storageKey);
          const parsed = raw ? JSON.parse(raw) : null;
          if (isPlainObject(parsed)) merged = parsed;
        } catch (_) {
          merged = {};
        }
        merged[cfg.storageField] = stored;
        store.setItem(cfg.storageKey, JSON.stringify(merged));
      } else {
        store.setItem(cfg.storageKey, String(stored));
      }
      return true;
    } catch (_) {
      return false;
    }
  };

  // --- 主體 ---------------------------------------------------------------

  /**
   * 建立一個音效工具箱。
   *
   * @param {Object} [options]
   * @param {string} [options.storageKey]      localStorage 的 key；省略代表不持久化（開關只存在記憶體）
   * @param {string} [options.storageField]    該 key 存的是物件時，指定讀寫哪個欄位（例如 2048 的 g2048_pref_v1.sound）；
   *                                           省略代表整個 key 就是布林值（例如 loop 的 loopnet_sound）
   * @param {boolean} [options.defaultEnabled=true] 沒存過時的預設值
   * @param {boolean} [options.invert=false]   存進去的值與 enabled 相反（battleship 的 battleship-muted）
   * @param {boolean} [options.autoUnlock=true] 自動綁 pointerdown / touchstart / keydown 解鎖，
   *                                           並在 pageshow / focus 時 resume
   * @param {number} [options.volume=1]        全域音量倍率，乘在每個聲音的峰值上（0 ~ 1）
   * @param {number} [options.maxVoices=0]     同時發聲上限，超過就丟棄新的聲音；0 代表不限制
   * @returns {Object} kit
   */
  const create = (options) => {
    const opts = isPlainObject(options) ? options : {};

    const cfg = {
      storageKey: (typeof opts.storageKey === 'string' && opts.storageKey) ? opts.storageKey : null,
      storageField: (typeof opts.storageField === 'string' && opts.storageField) ? opts.storageField : null,
      invert: opts.invert === true
    };

    const defaultEnabled = (typeof opts.defaultEnabled === 'boolean') ? opts.defaultEnabled : true;
    const autoUnlock = opts.autoUnlock !== false;
    const volume = clamp(finite(opts.volume, 1), 0, 1);
    const maxVoices = Math.max(0, Math.floor(finite(opts.maxVoices, 0)));

    // 讀回偏好：invert 模式下存的是「靜音」，要反過來
    const persisted = readPersisted(cfg);
    let enabled = (persisted === null)
      ? defaultEnabled
      : (cfg.invert ? !persisted : persisted);

    let ctx = null;
    let destroyed = false;
    let unlocked = false;
    let activeVoices = 0;
    // 正在發聲的節點群，destroy() / stopAll() 要能全部收掉
    const live = [];

    // --- AudioContext 生命週期 -------------------------------------------

    const resumeIfNeeded = () => {
      try {
        if (!ctx) return;
        if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
          // Safari 的 'interrupted'（來電、鬧鐘）也要 resume，否則回前景永遠沒聲音
          const promise = ctx.resume();
          if (promise && typeof promise.catch === 'function') promise.catch(() => {});
        }
      } catch (_) {}
    };

    const suspendIfRunning = () => {
      try {
        if (!ctx || ctx.state !== 'running') return;
        const promise = ctx.suspend();
        if (promise && typeof promise.catch === 'function') promise.catch(() => {});
      } catch (_) {}
    };

    /**
     * 需要時才建立 AudioContext。
     * iOS 必須在使用者手勢裡建立，所以這裡絕對不在模組載入時就 new。
     */
    const ensureContext = () => {
      if (destroyed) return null;
      try {
        if (ctx) {
          // context 被關掉（少數瀏覽器在長時間背景後會關）就重建
          if (ctx.state === 'closed') {
            ctx = null;
            unlocked = false;
          } else {
            resumeIfNeeded();
            return ctx;
          }
        }
        const Ctor = getAudioCtor();
        if (!Ctor) return null;
        ctx = new Ctor();
      } catch (_) {
        ctx = null;
        return null;
      }
      resumeIfNeeded();
      return ctx;
    };

    /**
     * 使用者手勢時呼叫：建立／喚醒 AudioContext。
     * iOS 還需要播一個 1 frame 的靜音 buffer 才算真的解鎖。
     * 關閉音效時不建立 context（省資源），setEnabled(true) 會再補叫一次。
     *
     * 【為什麼 unlocked 只在 running 時才立起來】
     * 瀏覽器的「使用者啟動」在觸控裝置上是 touchend / pointerup 才成立，
     * touchstart / pointerdown 那一刻還不算數 —— 這時 new 出來的 AudioContext
     * 會是 suspended，resume() 也不會過。若在那裡就把 unlocked 記成 true，
     * 之後任何一次手勢都不會再補播解鎖用的靜音 buffer，玩家進遊戲後
     * 前幾個聲音會整個消失（症狀：要把音效開關關掉再打開才有聲音）。
     * 所以每次手勢都補播一次（成本是 1 frame 的靜音 buffer），
     * 直到 context 真的 running 為止。
     * @returns {Object|null} AudioContext 或 null
     */
    const unlock = () => {
      if (!enabled || destroyed) return null;
      const active = ensureContext();
      if (!active) return null;
      if (unlocked) return active;
      if (active.state === 'running') unlocked = true;
      try {
        const source = active.createBufferSource();
        source.buffer = active.createBuffer(1, 1, active.sampleRate || 44100);
        source.connect(active.destination);
        source.start(0);
        // 一定要 stop：這是本模組要根治的洩漏來源
        if (typeof source.stop === 'function') source.stop(0.001);
      } catch (_) {
        /* 解鎖失敗不影響其他功能 */
      }
      return active;
    };

    // 可以發聲嗎？回傳可用的 ctx，否則 null
    const ready = () => {
      if (!enabled || destroyed) return null;
      const active = ensureContext();
      if (!active) return null;
      if (maxVoices > 0 && activeVoices >= maxVoices) return null;
      return active;
    };

    // --- 節點回收（防洩漏的核心）------------------------------------------

    /**
     * 聲音結束後把整條子圖 disconnect。
     * onended 在部分瀏覽器／被 suspend 的 context 上不會觸發，所以另外用
     * setTimeout 兜底，兩者先到先做（kill 具備冪等性）。
     */
    const reap = (nodes, source, endTime) => {
      activeVoices++;
      let done = false;
      let timer = null;

      const entry = {
        source,
        kill: null
      };

      const kill = () => {
        if (done) return;
        done = true;
        activeVoices = Math.max(0, activeVoices - 1);
        clearTimer(timer);
        timer = null;
        for (let i = 0; i < nodes.length; i++) {
          try {
            if (nodes[i] && typeof nodes[i].disconnect === 'function') nodes[i].disconnect();
          } catch (_) {
            /* 已經斷開了 */
          }
        }
        const idx = live.indexOf(entry);
        if (idx !== -1) live.splice(idx, 1);
      };

      entry.kill = kill;
      live.push(entry);

      try {
        if (source) source.onended = kill;
      } catch (_) {}

      const nowTime = (() => {
        try {
          return Number.isFinite(ctx && ctx.currentTime) ? ctx.currentTime : 0;
        } catch (_) {
          return 0;
        }
      })();
      timer = setTimer(kill, Math.max(0, (endTime - nowTime) * 1000) + 250);
    };

    // --- 發聲原語 ---------------------------------------------------------

    // 把使用者傳進來的參數正規化成包絡需要的欄位
    const normalize = (raw, active) => {
      const o = isPlainObject(raw) ? raw : {};
      const duration = positive(o.duration, DEFAULTS.duration);
      const delay = Math.max(0, finite(o.delay, DEFAULTS.delay));
      const peak = Math.max(MIN_LEVEL, positive(o.gain, DEFAULTS.gain) * volume);
      const floorRaw = Math.max(0, finite(o.floor, DEFAULTS.floor));
      const curve = curveOf(o.curve);
      return {
        start: (Number.isFinite(active.currentTime) ? active.currentTime : 0) + delay,
        duration,
        peak,
        // 指數衰減的地板不能是 0；線性可以
        floor: curve === 'linear' ? Math.min(floorRaw, peak) : Math.max(MIN_LEVEL, Math.min(floorRaw, peak)),
        attack: Math.max(0, finite(o.attack, DEFAULTS.attack)),
        release: Math.max(0, finite(o.release, DEFAULTS.release)),
        curve
      };
    };

    /**
     * 單音。
     * @param {Object} opts
     * @param {number} [opts.freq=440]           頻率（Hz）
     * @param {string} [opts.type='sine']        波形 sine｜square｜sawtooth｜triangle
     * @param {number} [opts.duration=0.08]      長度（秒）
     * @param {number} [opts.gain=0.12]          峰值音量
     * @param {number} [opts.delay=0]            延後幾秒發聲（用音訊時鐘排程，比 setTimeout 精準）
     * @param {number} [opts.attack=0]           起音秒數，0 = 直接給峰值（既有六份的行為）
     * @param {number} [opts.release=0]          尾音秒數，0 = 整段 duration 都在衰減（既有六份的行為）
     * @param {number} [opts.floor=0.0001]       衰減終點音量（battleship / loop / make24 / minesweeper 是 0.001）
     * @param {string} [opts.curve='exponential'] 音量曲線 exponential｜linear
     * @returns {boolean} 是否成功排程
     */
    const tone = (opts) => {
      const active = ready();
      if (!active) return false;
      const o = isPlainObject(opts) ? opts : {};
      try {
        const env = normalize(o, active);
        const osc = active.createOscillator();
        const gainNode = active.createGain();

        osc.type = waveType(o.type);
        setParam(osc.frequency, positive(o.freq, 440), env.start);

        applyEnvelope(gainNode.gain, env);

        osc.connect(gainNode);
        gainNode.connect(active.destination);

        const end = env.start + env.duration;
        osc.start(env.start);
        // 【硬性規則】每個 oscillator 都要 stop()
        if (typeof osc.stop === 'function') osc.stop(end);
        reap([osc, gainNode], osc, end);
        return true;
      } catch (_) {
        return false;
      }
    };

    /**
     * 滑音。
     * @param {Object} opts
     * @param {number} [opts.from=440]           起始頻率
     * @param {number} [opts.to=880]             結束頻率
     * @param {number} [opts.glide]              頻率滑行秒數，預設等於 duration
     *                                           （battleship 的 playLaunch 是 0.18，但音長 0.2）
     * @param {string} [opts.freqCurve='exponential'] 頻率曲線 exponential｜linear
     *                                           （battleship 的 playSunk 用 linear）
     * 其餘 type / duration / gain / delay / attack / release / floor / curve 同 tone()
     * @returns {boolean} 是否成功排程
     */
    const sweep = (opts) => {
      const active = ready();
      if (!active) return false;
      const o = isPlainObject(opts) ? opts : {};
      try {
        const env = normalize(o, active);
        const from = positive(o.from, 440);
        const to = positive(o.to, 880);
        const glide = Math.min(env.duration, positive(o.glide, env.duration));
        const freqCurve = curveOf(o.freqCurve);

        const osc = active.createOscillator();
        const gainNode = active.createGain();

        osc.type = waveType(o.type);
        setParam(osc.frequency, from, env.start);
        rampParam(osc.frequency, to, env.start + glide, freqCurve, MIN_FREQ);

        applyEnvelope(gainNode.gain, env);

        osc.connect(gainNode);
        gainNode.connect(active.destination);

        const end = env.start + env.duration;
        osc.start(env.start);
        if (typeof osc.stop === 'function') osc.stop(end);
        reap([osc, gainNode], osc, end);
        return true;
      } catch (_) {
        return false;
      }
    };

    /**
     * 白噪（爆炸、沙沙聲用）。
     * @param {Object} opts
     * @param {number} [opts.duration=0.3]   長度（秒），同時決定噪音 buffer 長度
     * @param {number} [opts.gain=0.12]      峰值音量
     * @param {Object} [opts.filter]         濾波器，省略代表不過濾
     * @param {string} [opts.filter.type='lowpass']  濾波器型別
     * @param {number} [opts.filter.frequency=1000]  起始截止頻率
     * @param {number} [opts.filter.to]              終點截止頻率（有給才做掃頻；battleship 的 playHit 是 900 → 50）
     * @param {number} [opts.filter.glide]           掃頻秒數，預設等於 duration
     * @param {string} [opts.filter.curve='exponential'] 掃頻曲線
     * @param {number} [opts.filter.Q]               共振 Q 值
     * 其餘 delay / attack / release / floor / curve 同 tone()
     * @returns {boolean} 是否成功排程
     */
    const noise = (opts) => {
      const active = ready();
      if (!active) return false;
      const o = isPlainObject(opts) ? opts : {};
      try {
        const env = normalize({
          duration: positive(o.duration, 0.3),
          gain: o.gain,
          delay: o.delay,
          floor: o.floor,
          attack: o.attack,
          release: o.release,
          curve: o.curve
        }, active);

        const sampleRate = positive(active.sampleRate, 44100);
        const frames = Math.max(1, Math.floor(sampleRate * env.duration));
        const buffer = active.createBuffer(1, frames, sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

        const source = active.createBufferSource();
        source.buffer = buffer;

        const nodes = [source];
        let tail = source;

        const filterSpec = isPlainObject(o.filter) ? o.filter : null;
        if (filterSpec) {
          const biquad = active.createBiquadFilter();
          biquad.type = filterType(filterSpec.type);
          const fromFreq = positive(filterSpec.frequency, 1000);
          setParam(biquad.frequency, fromFreq, env.start);
          if (filterSpec.to !== undefined && filterSpec.to !== null) {
            const glide = Math.min(env.duration, positive(filterSpec.glide, env.duration));
            rampParam(
              biquad.frequency,
              positive(filterSpec.to, fromFreq),
              env.start + glide,
              curveOf(filterSpec.curve),
              MIN_FREQ
            );
          }
          if (filterSpec.Q !== undefined && filterSpec.Q !== null) {
            setParam(biquad.Q, positive(filterSpec.Q, 1), env.start);
          }
          tail.connect(biquad);
          tail = biquad;
          nodes.push(biquad);
        }

        const gainNode = active.createGain();
        applyEnvelope(gainNode.gain, env);
        tail.connect(gainNode);
        gainNode.connect(active.destination);
        nodes.push(gainNode);

        const end = env.start + env.duration;
        source.start(env.start);
        // battleship 的 playHit 原本漏了這行，noise 節點會一直掛在圖上
        if (typeof source.stop === 'function') source.stop(end);
        reap(nodes, source, end);
        return true;
      } catch (_) {
        return false;
      }
    };

    /**
     * 和弦／音階。
     * notes 可以是數字（頻率）或 tone()／sweep() 的參數物件；
     * 物件裡同時有 from 與 to 就走 sweep()，否則走 tone()。
     *
     * @param {Array} notes            例如 [523.25, 659.25, 783.99, 1046.5]
     * @param {Object} [shared]        套用到每一個音的共同參數
     * @param {number} [shared.stagger=0] 每個音之間的間隔秒數（取代既有實作的 setTimeout 琶音）
     * @returns {number} 成功排程的音數
     */
    const chord = (notes, shared) => {
      if (!Array.isArray(notes) || !notes.length) return 0;
      const base = isPlainObject(shared) ? shared : {};
      const stagger = Math.max(0, finite(base.stagger, 0));
      const baseDelay = Math.max(0, finite(base.delay, 0));
      let count = 0;

      for (let i = 0; i < notes.length; i++) {
        const item = notes[i];
        const spec = {};
        // 共同參數先鋪底，單音自己的設定再蓋上去
        for (const key in base) {
          if (Object.prototype.hasOwnProperty.call(base, key)) spec[key] = base[key];
        }
        if (typeof item === 'number') {
          spec.freq = item;
        } else if (isPlainObject(item)) {
          for (const key in item) {
            if (Object.prototype.hasOwnProperty.call(item, key)) spec[key] = item[key];
          }
        } else {
          continue;
        }
        // 單音沒指定 delay 時，用 stagger 自動排成琶音
        const hasOwnDelay = isPlainObject(item) && item.delay !== undefined && item.delay !== null;
        if (!hasOwnDelay) spec.delay = baseDelay + i * stagger;

        const isSweep = spec.from !== undefined && spec.from !== null
          && spec.to !== undefined && spec.to !== null;
        if (isSweep ? sweep(spec) : tone(spec)) count++;
      }
      return count;
    };

    // --- 開關 -------------------------------------------------------------

    /**
     * 設定開關並持久化。
     * @param {boolean} on
     * @returns {boolean} 新的值
     */
    const setEnabled = (on) => {
      const next = !!on;
      if (next === enabled) {
        // 值沒變也要確保持久化過（例如第一次呼叫）
        writePersisted(cfg, enabled);
        return enabled;
      }
      enabled = next;
      writePersisted(cfg, enabled);
      if (enabled) {
        // 開啟音效通常發生在使用者點擊裡，順手解鎖
        unlock();
      } else {
        // 關掉就順手停掉還在響的聲音
        stopAll();
      }
      return enabled;
    };

    /**
     * 切換開關並持久化。
     * @returns {boolean} 新的值
     */
    const toggle = () => setEnabled(!enabled);

    // --- 收尾 -------------------------------------------------------------

    /** 立刻停掉並回收所有正在發聲的節點 */
    const stopAll = () => {
      const pending = live.slice();
      for (let i = 0; i < pending.length; i++) {
        try {
          const src = pending[i].source;
          if (src && typeof src.stop === 'function') src.stop();
        } catch (_) {
          /* 已經停了 */
        }
        try {
          pending[i].kill();
        } catch (_) {}
      }
      live.length = 0;
      activeVoices = 0;
    };

    // --- 事件綁定 ---------------------------------------------------------

    const listeners = [];

    const bind = (target, event, handler, opts2) => {
      if (!target || typeof target.addEventListener !== 'function') return;
      try {
        target.addEventListener(event, handler, opts2);
        listeners.push({ target, event, handler, opts: opts2 });
      } catch (_) {}
    };

    const unbindAll = () => {
      while (listeners.length) {
        const item = listeners.pop();
        try {
          if (item.target && typeof item.target.removeEventListener === 'function') {
            item.target.removeEventListener(item.event, item.handler, item.opts);
          }
        } catch (_) {}
      }
    };

    // 切到背景時暫停音訊，回前景再喚醒（行動裝置省電與通話中斷）
    const onVisibility = () => {
      try {
        const doc = getDoc();
        if (!doc) return;
        const hidden = (doc.hidden === true) || (doc.visibilityState === 'hidden');
        if (hidden) suspendIfRunning();
        else resumeIfNeeded();
      } catch (_) {}
    };

    // 使用者手勢：這是 iOS 唯一允許建立／解鎖 AudioContext 的時機。
    // 「按下」與「放開」兩邊都要綁：觸控裝置的使用者啟動要等 touchend / pointerup
    // 才成立，只綁 pointerdown / touchstart 的話第一次手勢解不開（見 unlock() 的註解）。
    const onGesture = () => {
      try {
        unlock();
      } catch (_) {}
    };

    // 回到前景／從 bfcache 回來：只喚醒，不主動建立（沒有手勢的話建了也是 suspended）
    const onWake = () => {
      try {
        resumeIfNeeded();
      } catch (_) {}
    };

    const doc = getDoc();
    const win = getWin();
    bind(doc, 'visibilitychange', onVisibility);
    if (autoUnlock) {
      const passive = { passive: true };
      bind(doc, 'pointerdown', onGesture, passive);
      bind(doc, 'pointerup', onGesture, passive);
      bind(doc, 'touchstart', onGesture, passive);
      bind(doc, 'touchend', onGesture, passive);
      bind(doc, 'click', onGesture, passive);
      bind(doc, 'keydown', onGesture, passive);
      bind(win, 'pageshow', onWake);
      bind(win, 'focus', onWake);
    }

    /** 解除所有監聽、停掉所有聲音並關閉 AudioContext。之後所有 API 都變成 no-op */
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      unbindAll();
      stopAll();
      try {
        if (ctx && typeof ctx.close === 'function' && ctx.state !== 'closed') {
          const promise = ctx.close();
          if (promise && typeof promise.catch === 'function') promise.catch(() => {});
        }
      } catch (_) {}
      ctx = null;
      unlocked = false;
    };

    // --- 對外介面 ---------------------------------------------------------

    const kit = {
      unlock,
      tone,
      sweep,
      chord,
      noise,
      setEnabled,
      toggle,
      stopAll,
      destroy,
      /** 是否已啟用（等同 kit.enabled，給不方便讀 getter 的場合用） */
      isEnabled: () => enabled,
      /**
       * 底層 AudioContext，給現有原語表達不出來的音色當逃生口。
       * 會依需要建立／喚醒 context；呼叫端要自己先檢查 kit.enabled。
       * 自己接的節點請記得每個 oscillator 都要 stop()。
       * @returns {Object|null}
       */
      context: () => (destroyed ? null : ensureContext()),
      /** 目前的輸出端點（ctx.destination），自接節點時連到這裡 */
      destination: () => {
        try {
          const active = destroyed ? null : ensureContext();
          return active ? active.destination : null;
        } catch (_) {
          return null;
        }
      },
      /** 音訊時鐘的現在時間；沒有 context 時回 0（不會為了問時間就建立 context） */
      now: () => {
        try {
          return (ctx && Number.isFinite(ctx.currentTime)) ? ctx.currentTime : 0;
        } catch (_) {
          return 0;
        }
      },
      /** 手動暫停（例如遊戲進入暫停畫面） */
      suspend: suspendIfRunning,
      /** 手動喚醒 */
      resume: resumeIfNeeded,
      /** AudioContext 目前狀態，沒有 context 時回 'closed' */
      state: () => {
        try {
          return (ctx && ctx.state) ? ctx.state : 'closed';
        } catch (_) {
          return 'closed';
        }
      }
    };

    // enabled 用 getter 暴露，讓呼叫端可以直接讀 kit.enabled 而不會拿到過期的快照
    try {
      Object.defineProperty(kit, 'enabled', {
        enumerable: true,
        get: () => enabled,
        set: (value) => {
          setEnabled(value);
        }
      });
    } catch (_) {
      kit.enabled = enabled;
    }

    return kit;
  };

  return {
    create,
    DEFAULTS,
    WAVE_TYPES,
    FILTER_TYPES
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = BoboAudio;
}
