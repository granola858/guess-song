/* ==========================================================================
   24 點大腦算術 (Make 24) 核心遊戲邏輯
   ========================================================================== */

const STORAGE_KEY = 'make24_game_state';
const BEST_STREAK_KEY = 'make24_best_streak';

// 過關彩帶的調色盤（沿用本遊戲原本的六色，交由共用模組 BoboConfetti 播放）
const CONFETTI_COLORS = ['#6366F1', '#10B981', '#F59E0B', '#EF4444', '#EC4899', '#8B5CF6'];

const SUITS = [
  { symbol: '♠', type: 'suit-black', name: 'spade' },
  { symbol: '♥', type: 'suit-red', name: 'heart' },
  { symbol: '♦', type: 'suit-red', name: 'diamond' },
  { symbol: '♣', type: 'suit-black', name: 'club' }
];

const MODES = {
  easy: {
    id: 'easy',
    name: '簡單',
    maxNum: 9,
    oddMax: 2,           // 偶數 >= 2
    minSolutions: 8,
    allowFraction: false
  },
  medium: {
    id: 'medium',
    name: '標準',
    maxNum: 10,
    oddMax: 3,
    minSolutions: 3,
    maxSolutions: 7,
    allowFraction: false
  },
  hard: {
    id: 'hard',
    name: '困難',
    maxNum: 12,
    allowFraction: false
  },
  master: {
    id: 'master',
    name: '大師',
    maxNum: 13,
    allowFraction: true
  }
};

const CURATED_MASTER_PUZZLES = [
  [3, 3, 8, 8],
  [5, 5, 5, 1],
  [1, 4, 5, 6],
  [1, 3, 4, 6],
  [2, 7, 7, 10],
  [1, 5, 11, 11],
  [3, 7, 9, 13],
  [3, 3, 7, 7],
  [4, 4, 10, 10],
  [1, 6, 6, 8],
  [5, 7, 7, 11],
  [3, 8, 8, 10],
  [2, 3, 11, 13],
  [6, 9, 9, 10]
];

/* --------------------------------------------------------------------------
   求解與特徵分析演算法
   -------------------------------------------------------------------------- */

/**
 * 求解 24 點並消除交換律等價解，計算獨立思維路徑（Canonical Solutions）
 * 同時標記解法中是否出現分數/非整數中繼運算
 */
function solve24Detailed(nums) {
  const results = [];
  const helper = (list) => {
    if (list.length === 1) {
      if (Math.abs(list[0].val - 24) < 1e-5) {
        results.push({
          expr: list[0].expr,
          canon: list[0].canon,
          isFraction: !!list[0].isFraction
        });
      }
      return;
    }
    for (let i = 0; i < list.length; i++) {
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue;
        const nextList = list.filter((_, idx) => idx !== i && idx !== j);
        const a = list[i], b = list[j];

        // 加法（具交換律：正規化為 a.canon <= b.canon）
        if (i < j) {
          const canon = a.canon < b.canon ? `(${a.canon}+${b.canon})` : `(${b.canon}+${a.canon})`;
          helper([...nextList, {
            val: a.val + b.val,
            expr: `(${a.expr} + ${b.expr})`,
            canon,
            isFraction: a.isFraction || b.isFraction || !Number.isInteger(Math.round((a.val + b.val) * 1e5) / 1e5)
          }]);
        }

        // 減法（無交換律）
        helper([...nextList, {
          val: a.val - b.val,
          expr: `(${a.expr} - ${b.expr})`,
          canon: `(${a.canon}-${b.canon})`,
          isFraction: a.isFraction || b.isFraction || !Number.isInteger(Math.round((a.val - b.val) * 1e5) / 1e5)
        }]);

        // 乘法（具交換律：正規化為 a.canon <= b.canon）
        if (i < j) {
          const canon = a.canon < b.canon ? `(${a.canon}*${b.canon})` : `(${b.canon}*${a.canon})`;
          helper([...nextList, {
            val: a.val * b.val,
            expr: `(${a.expr} × ${b.expr})`,
            canon,
            isFraction: a.isFraction || b.isFraction || !Number.isInteger(Math.round((a.val * b.val) * 1e5) / 1e5)
          }]);
        }

        // 除法（無交換律）
        if (Math.abs(b.val) > 1e-5) {
          const divVal = a.val / b.val;
          const isNonIntegerDivision = Math.abs(divVal - Math.round(divVal)) > 1e-5;
          helper([...nextList, {
            val: divVal,
            expr: `(${a.expr} ÷ ${b.expr})`,
            canon: `(${a.canon}/${b.canon})`,
            isFraction: a.isFraction || b.isFraction || isNonIntegerDivision
          }]);
        }
      }
    }
  };

  helper(nums.map(n => ({ val: n, expr: n.toString(), canon: n.toString(), isFraction: false })));

  // 依正規化代數表達式去重，優先保留純整數解標記
  const map = new Map();
  results.forEach(item => {
    if (!map.has(item.canon)) {
      map.set(item.canon, item);
    } else if (!item.isFraction && map.get(item.canon).isFraction) {
      map.set(item.canon, item);
    }
  });

  return Array.from(map.values()).map(item => ({
    expr: item.expr,
    isFraction: item.isFraction
  }));
}

/**
 * 簡易封裝，回傳字串陣列（相容既有介面）
 */
function solve24(nums) {
  return solve24Detailed(nums).map(s => s.expr);
}

/**
 * 分析題目的奇偶特徵、解法空間與難度標籤
 */
function analyzePuzzle(nums) {
  const oddCount = nums.filter(n => n % 2 !== 0).length;
  const evenCount = 4 - oddCount;
  const rawSolutions = solve24Detailed(nums);
  const solutions = rawSolutions.map(s => s.expr);
  const solutionCount = solutions.length;
  const hasIntegerSolution = rawSolutions.some(s => !s.isFraction);
  const hasFractionSolution = rawSolutions.some(s => s.isFraction);
  const isFractionOnly = solutionCount > 0 && !hasIntegerSolution;

  let tag = '常規題型';
  if (isFractionOnly) {
    tag = '💡 分數逆算題';
  } else if (oddCount === 4) {
    tag = '💡 四奇數挑戰';
  } else if (oddCount === 3) {
    tag = '💡 三奇數攻防';
  } else if (solutionCount === 1) {
    tag = '💡 精準唯一解';
  } else if (evenCount >= 3) {
    tag = '💡 偶數因數題';
  } else if (hasFractionSolution) {
    tag = '💡 複合運算題';
  }

  return {
    nums,
    oddCount,
    evenCount,
    solutions,
    rawSolutions,
    solutionCount,
    hasIntegerSolution,
    hasFractionSolution,
    isFractionOnly,
    tag
  };
}

/**
 * 難度符合性檢驗（嚴格區間分層與上下限過濾）
 */
function isPuzzleMatchingDifficulty(puzzleInfo, mode) {
  if (puzzleInfo.solutionCount === 0) return false;

  switch (mode) {
    case 'easy':
      // 簡單模式：
      // 1. 數字 1~9, 偶數 >= 2
      // 2. 必須有純整數解
      // 3. 獨立思維解法數 >= 8 (確保充足解題路徑，絕非死板狹窄題)
      return puzzleInfo.nums.every(n => n <= 9) &&
             puzzleInfo.evenCount >= 2 &&
             puzzleInfo.hasIntegerSolution &&
             puzzleInfo.solutionCount >= 8;

    case 'medium':
      // 標準模式：
      // 1. 數字 1~10, 奇數 <= 3
      // 2. 必須有純整數解
      // 3. 解法數落在 3 ~ 7 種 (設定明確上限，杜絕標準模式抽到超簡單水題，也不會掉入 1~2 解的死胡同)
      return puzzleInfo.nums.every(n => n <= 10) &&
             puzzleInfo.oddCount <= 3 &&
             puzzleInfo.hasIntegerSolution &&
             puzzleInfo.solutionCount >= 3 &&
             puzzleInfo.solutionCount <= 7;

    case 'hard':
      // 困難模式：
      // 1. 數字 1~12
      // 2. 必須有解，且解法數極少 (<= 2 種)，或者 奇數 >= 3 且解法數 <= 3
      return puzzleInfo.nums.every(n => n <= 12) &&
             puzzleInfo.solutionCount >= 1 &&
             (puzzleInfo.solutionCount <= 2 || (puzzleInfo.oddCount >= 3 && puzzleInfo.solutionCount <= 3));

    case 'master':
      // 大師模式：
      // 1. 純分數逆算題 (isFractionOnly)
      // 2. 四奇數極少解 (oddCount === 4 && solutionCount <= 2)
      // 3. 奇數 >= 3 且極少解 (oddCount >= 3 && solutionCount <= 2)
      // 4. 含有大牌 (11~13) 且極少解 (solutionCount <= 2)
      return puzzleInfo.isFractionOnly ||
             (puzzleInfo.oddCount === 4 && puzzleInfo.solutionCount <= 2) ||
             (puzzleInfo.oddCount >= 3 && puzzleInfo.solutionCount <= 2) ||
             (puzzleInfo.nums.some(n => n >= 11) && puzzleInfo.solutionCount <= 2);

    default:
      return true;
  }
}

/* --------------------------------------------------------------------------
   音效管理
   - 瀏覽器樣板（AudioContext 延後建立、手勢解鎖、visibilitychange 暫停／喚醒、
     節點 stop 與 disconnect 回收）一律交給共用模組 BoboAudio，
     本類別只留下 24 點自己的四個音色
   - 本遊戲沒有音效開關，也沒有對應的偏好鍵，因此 create() 不帶 storageKey
     （開關只存在記憶體，預設開啟，行為與重構前完全一致）
   - 共用模組可缺席：載入失敗時 kit 為 null，遊戲照常能玩，只是沒有音效
   - 音量 0.12、衰減地板 0.001 是本遊戲原本四個音色共用的值
   -------------------------------------------------------------------------- */
const SOUND_GAIN = 0.12;
const SOUND_FLOOR = 0.001;

class SoundManager {
  constructor() {
    this.kit = (typeof BoboAudio !== 'undefined' && BoboAudio) ? BoboAudio.create() : null;
  }

  playCardClick() {
    if (!this.kit) return;
    this.kit.tone({
      freq: 520, type: 'sine', duration: 0.08, gain: SOUND_GAIN, floor: SOUND_FLOOR
    });
  }

  playOpClick() {
    if (!this.kit) return;
    this.kit.tone({
      freq: 440, type: 'triangle', duration: 0.06, gain: SOUND_GAIN, floor: SOUND_FLOOR
    });
  }

  playBackspace() {
    if (!this.kit) return;
    this.kit.tone({
      freq: 280, type: 'sine', duration: 0.08, gain: SOUND_GAIN, floor: SOUND_FLOOR
    });
  }

  playWin() {
    if (!this.kit) return;
    // 原本用 delay = i * 0.09 手動排四個音，改用 stagger 走音訊時鐘排程，聽感相同
    this.kit.chord([523.25, 659.25, 783.99, 1046.5], {
      type: 'triangle', duration: 0.25, gain: SOUND_GAIN, stagger: 0.09, floor: SOUND_FLOOR
    });
  }
}

/* --------------------------------------------------------------------------
   主遊戲控制類別
   -------------------------------------------------------------------------- */
class Make24Game {
  constructor() {
    // 狀態變數 (4 檔模式: easy, medium, hard, master)
    this.currentMode = 'easy';
    this.cardData = [];          // 當前局的 4 張卡片資料 [{num, suit, displayRank, subLabel}]
    this.usedCardIndices = new Set(); // 記錄已使用的卡片索引
    this.tokens = [];            // 目前算式 Token 陣列 [{type: 'num'|'op', val: string, cardIdx?: number}]
    this.cursorIndex = 0;        // 游標插入位置 (0 ~ tokens.length)
    this.selectionRange = null;  // 選取區間 null 或 { start: number, end: number }
    this.isSelecting = false;    // 滑鼠/觸控框選中標記
    this.dragStartIndex = null;  // 框選起始索引
    this.solutions = [];         // 當前數字的可行解
    this.puzzleInfo = null;      // 當前題目特徵資料
    this.sound = new SoundManager();
    this.isWon = false;

    // 計分與統計
    this.streak = 0;
    this.bestStreak = this.getBestStreak(this.currentMode);
    this.timerSeconds = 0;
    this.timerInterval = null;

    // DOM 元素引用 (支援 Node.js 測試與 SSR 環境)
    const isBrowser = typeof document !== 'undefined';
    this.dom = {
      themeBtn: isBrowser ? document.getElementById('theme-btn') : null,
      tabButtons: isBrowser ? document.querySelectorAll('.tab-btn') : [],
      timerText: isBrowser ? document.getElementById('timer-text') : null,
      streakText: isBrowser ? document.getElementById('streak-text') : null,
      bestText: isBrowser ? document.getElementById('best-text') : null,
      displayCard: isBrowser ? document.getElementById('display-card') : null,
      equationContainer: isBrowser ? document.getElementById('equation-container') : null,
      evalResult: isBrowser ? document.getElementById('eval-result') : null,
      cardsGrid: isBrowser ? document.getElementById('cards-grid') : null,
      keypadGrid: isBrowser ? document.getElementById('keypad-grid') : null,
      btnBackspace: isBrowser ? document.getElementById('btn-backspace') : null,
      btnClear: isBrowser ? document.getElementById('btn-clear') : null,
      btnHint: isBrowser ? document.getElementById('btn-hint') : null,
      btnSkip: isBrowser ? document.getElementById('btn-skip') : null,
      modalOverlay: isBrowser ? document.getElementById('modal-overlay') : null,
      modalTitle: isBrowser ? document.getElementById('modal-title') : null,
      modalBody: isBrowser ? document.getElementById('modal-body') : null,
      modalCloseBtn: isBrowser ? document.getElementById('modal-close-btn') : null,
      confettiCanvas: isBrowser ? document.getElementById('confetti-canvas') : null
    };

    if (isBrowser) {
      this.init();
    }
  }

  init() {
    this.setupTheme();
    this.bindEvents();
    if (!this.loadGameState()) {
      this.bestStreak = this.getBestStreak(this.currentMode);
      this.updateStatsDisplay();
      this.startNewGame();
    }
  }

  getBestStreakKey(mode) {
    return `make24_best_streak_${mode}`;
  }

  getBestStreak(mode) {
    try {
      const modeVal = localStorage.getItem(this.getBestStreakKey(mode));
      if (modeVal !== null) return parseInt(modeVal, 10) || 0;
      const oldVal = localStorage.getItem(BEST_STREAK_KEY);
      if (oldVal !== null) return parseInt(oldVal, 10) || 0;
    } catch (_) {}
    return 0;
  }

  /* ------------------------------------------------------------------------
     主題切換邏輯
     - 首頁偏好 (bobo-home-preferences-v2) 的讀寫一律交給共用模組 BoboTheme，
       由它負責「只改 theme 欄位、不覆蓋 order / hidden」
     - 本遊戲自己的 make24_theme 偏好鍵仍完整保留（相容舊版存檔）
     - 共用模組可缺席：載入失敗時退回本地邏輯，遊戲照常能玩
     ------------------------------------------------------------------------ */
  setupTheme() {
    const themeKit = (typeof BoboTheme !== 'undefined' && BoboTheme) ? BoboTheme : null;
    const localTheme = this.readLocalTheme();
    let savedTheme;

    if (themeKit) {
      // 先套用首頁偏好，並掛上系統主題監聽（使用者沒明確選過時才跟隨系統）
      savedTheme = themeKit.init();
      if (!themeKit.hasExplicitPreference() && localTheme) {
        // 首頁沒有明確偏好時，才輪到本遊戲自己的舊偏好鍵
        savedTheme = themeKit.apply(localTheme);
        // make24_theme 本身就是使用者明確選過的結果，因此不再跟隨系統變化
        themeKit.destroy();
      }
    } else {
      savedTheme = this.readThemeWithoutKit(localTheme);
      document.documentElement.setAttribute('data-theme', savedTheme);
    }

    this.updateThemeIcon(savedTheme);

    if (this.dom.themeBtn) {
      this.dom.themeBtn.addEventListener('click', () => {
        const nextTheme = themeKit
          ? themeKit.toggle()
          : this.toggleThemeWithoutKit();
        this.writeLocalTheme(nextTheme);
        this.updateThemeIcon(nextTheme);
      });
    }
  }

  // 讀取本遊戲專屬的主題偏好鍵，沒有或值非法時回傳 null
  readLocalTheme() {
    try {
      const value = localStorage.getItem('make24_theme');
      return ['dark', 'light'].includes(value) ? value : null;
    } catch (_) {
      return null;
    }
  }

  // 寫回本遊戲專屬的主題偏好鍵（首頁那包由 BoboTheme 負責）
  writeLocalTheme(theme) {
    try {
      localStorage.setItem('make24_theme', theme);
    } catch (_) {}
  }

  // BoboTheme 缺席時的退路：首頁偏好 → 本遊戲偏好 → 系統偏好
  readThemeWithoutKit(localTheme) {
    try {
      const prefs = JSON.parse(localStorage.getItem('bobo-home-preferences-v2') || '{}');
      if (prefs && ['dark', 'light'].includes(prefs.theme)) return prefs.theme;
    } catch (_) {}
    if (localTheme) return localTheme;
    try {
      if (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches) {
        return 'dark';
      }
    } catch (_) {}
    return 'light';
  }

  // BoboTheme 缺席時的退路：只切換畫面，不去碰首頁那包偏好（避免覆蓋 order / hidden）
  toggleThemeWithoutKit() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    return next;
  }

  updateThemeIcon(theme) {
    if (this.dom.themeBtn) {
      this.dom.themeBtn.innerHTML = theme === 'dark'
        ? '<svg class="icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: #FBBF24;"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/></svg>'
        : '<svg class="icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/></svg>';
    }
  }

  /* ------------------------------------------------------------------------
     事件綁定 (Events & Keyboard Shortcuts)
     ------------------------------------------------------------------------ */
  bindEvents() {
    // 4 檔模式切換
    this.dom.tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (mode && MODES[mode]) {
          this.switchMode(mode);
        }
      });
    });

    // 運算符按鈕
    document.querySelectorAll('.btn-key.op').forEach(btn => {
      btn.addEventListener('click', () => {
        this.sound.playOpClick();
        this.addOperatorToken(btn.dataset.op);
      });
    });

    // 功能按鈕
    if (this.dom.btnBackspace) {
      this.dom.btnBackspace.addEventListener('click', () => {
        this.sound.playBackspace();
        this.handleBackspace();
      });
    }
    if (this.dom.btnClear) {
      this.dom.btnClear.addEventListener('click', () => {
        this.sound.playBackspace();
        this.handleClear();
      });
    }
    if (this.dom.btnHint) {
      this.dom.btnHint.addEventListener('click', () => this.showHint());
    }
    if (this.dom.btnSkip) {
      this.dom.btnSkip.addEventListener('click', () => {
        this.streak = 0; // 換牌重置連勝
        this.updateStatsDisplay();
        this.clearGameState();
        this.startNewGame();
      });
    }

    // 綁定算式容器之 Pointer Events (相容滑鼠與手機觸控按住拖曳選取)
    this.setupEquationContainerInteractions();

    // Modal 關閉
    if (this.dom.modalCloseBtn) {
      this.dom.modalCloseBtn.addEventListener('click', () => {
        this.dom.modalOverlay.classList.remove('active');
        if (this.isWon) {
          this.clearGameState();
          this.startNewGame();
        }
      });
    }

    if (this.dom.modalOverlay) {
      this.dom.modalOverlay.addEventListener('click', (e) => {
        if (e.target === this.dom.modalOverlay) {
          this.dom.modalOverlay.classList.remove('active');
          if (this.isWon) {
            this.clearGameState();
            this.startNewGame();
          }
        }
      });
    }

    // 頁面卸載時保存進度
    window.addEventListener('beforeunload', () => {
      if (!this.isWon) this.saveGameState();
    });

    // 鍵盤快速鍵支援
    window.addEventListener('keydown', (e) => {
      if (this.dom.modalOverlay && this.dom.modalOverlay.classList.contains('active')) {
        if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') {
          e.preventDefault();
          if (this.dom.modalCloseBtn) this.dom.modalCloseBtn.click();
        }
        return;
      }

      if (['1', '2', '3', '4'].includes(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const cardIndex = parseInt(e.key, 10) - 1;
        if (this.cardData[cardIndex] && !this.usedCardIndices.has(cardIndex)) {
          e.preventDefault();
          this.sound.playCardClick();
          this.addNumberToken(cardIndex, this.cardData[cardIndex].num);
        }
      } else if (['+', '-', '*', '/', '(', ')'].includes(e.key)) {
        e.preventDefault();
        this.sound.playOpClick();
        const map = { '*': '×', '/': '÷' };
        this.addOperatorToken(map[e.key] || e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        this.sound.playBackspace();
        this.handleBackspace();
      } else if (e.key === 'Delete') {
        e.preventDefault();
        this.sound.playBackspace();
        this.handleDelete();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (this.selectionRange) {
          this.clearSelection();
        } else {
          this.sound.playBackspace();
          this.handleClear();
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.handleArrowKey(-1, e.shiftKey);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.handleArrowKey(1, e.shiftKey);
      } else if (e.key === 'Home') {
        e.preventDefault();
        this.setCursorIndex(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        this.setCursorIndex(this.tokens.length);
      }
    });
  }

  /* ------------------------------------------------------------------------
     算式容器 Pointer Events 觸控與滑鼠拖曳選取引擎
     ------------------------------------------------------------------------ */
  setupEquationContainerInteractions() {
    const container = this.dom.equationContainer;
    if (!container) return;

    let isPointerDown = false;
    let pointerStartX = 0;
    let pointerStartY = 0;
    let hasMoved = false;
    let activePointerId = null;
    let pendingSelectionRange = null;

    const getTokenIndexFromElement = (el) => {
      if (!el) return null;
      const tokenEl = el.closest('.equation-token');
      if (tokenEl && tokenEl.dataset.tokenIndex !== undefined) {
        return parseInt(tokenEl.dataset.tokenIndex, 10);
      }
      return null;
    };

    const getSlotIndexFromElement = (el) => {
      if (!el) return null;
      const slotEl = el.closest('.equation-slot');
      if (slotEl && slotEl.dataset.slot !== undefined) {
        return parseInt(slotEl.dataset.slot, 10);
      }
      return null;
    };

    const getTokenIndexAtPoint = (clientX, clientY) => {
      const targetEl = document.elementFromPoint(clientX, clientY);
      const directIndex = getTokenIndexFromElement(targetEl);
      if (directIndex !== null) return directIndex;

      const tokenElements = Array.from(container.querySelectorAll('.equation-token'));
      const nearbyToken = tokenElements.find(tokenEl => {
        const rect = tokenEl.getBoundingClientRect();
        return clientX >= rect.left - 6 && clientX <= rect.right + 6 &&
               clientY >= rect.top - 6 && clientY <= rect.bottom + 6;
      });
      return getTokenIndexFromElement(nearbyToken);
    };

    const startInteraction = (clientX, clientY, target, pointerId = null) => {
      if (this.isWon) return;

      isPointerDown = true;
      hasMoved = false;
      pendingSelectionRange = null;
      pointerStartX = clientX;
      pointerStartY = clientY;
      activePointerId = pointerId;

      const tokenIdx = getTokenIndexFromElement(target);
      const slotIdx = getSlotIndexFromElement(target);

      if (tokenIdx !== null) {
        this.isSelecting = true;
        this.dragStartIndex = tokenIdx;
      } else if (slotIdx !== null) {
        this.isSelecting = false;
        this.dragStartIndex = null;
        this.setCursorIndex(slotIdx);
      } else {
        this.isSelecting = false;
        this.dragStartIndex = null;
      }
    };

    const moveInteraction = (clientX, clientY) => {
      if (!isPointerDown || !this.isSelecting || this.dragStartIndex === null) return;

      const dx = Math.abs(clientX - pointerStartX);
      const dy = Math.abs(clientY - pointerStartY);
      if (dx > 4 || dy > 4) {
        hasMoved = true;
      }

      const currentTokenIdx = getTokenIndexAtPoint(clientX, clientY);

      if (currentTokenIdx !== null) {
        const start = Math.min(this.dragStartIndex, currentTokenIdx);
        const end = Math.max(this.dragStartIndex, currentTokenIdx) + 1;
        if (!pendingSelectionRange || pendingSelectionRange.start !== start || pendingSelectionRange.end !== end) {
          pendingSelectionRange = { start, end };
          this.selectionRange = pendingSelectionRange;
          this.cursorIndex = end;
          container.querySelectorAll('.equation-token').forEach(tokenEl => {
            const tokenIndex = parseInt(tokenEl.dataset.tokenIndex, 10);
            tokenEl.classList.toggle('selected', tokenIndex >= start && tokenIndex < end);
          });
        }
      }
    };

    const endInteraction = () => {
      if (!isPointerDown) return;
      isPointerDown = false;
      this.isSelecting = false;

      // 若為純點擊 (無明顯拖曳)
      if (!hasMoved && this.dragStartIndex !== null) {
        const clickedIdx = this.dragStartIndex;
        if (this.selectionRange && this.selectionRange.start === clickedIdx && this.selectionRange.end === clickedIdx + 1) {
          // 再次點擊已選中的單一 Token：取消選取並把游標移到後方
          this.setCursorIndex(clickedIdx + 1);
        } else {
          this.setSelectionRange(clickedIdx, clickedIdx + 1);
        }
      } else if (pendingSelectionRange) {
        this.setSelectionRange(pendingSelectionRange.start, pendingSelectionRange.end);
      }
      this.dragStartIndex = null;
      pendingSelectionRange = null;
    };

    container.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || (e.button !== 0 && e.pointerType === 'mouse')) return;
      startInteraction(e.clientX, e.clientY, e.target, e.pointerId);
      if (this.isSelecting) e.preventDefault();

      try {
        container.setPointerCapture(e.pointerId);
      } catch (_) {}
    });

    container.addEventListener('pointermove', (e) => {
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
      moveInteraction(e.clientX, e.clientY);
      if (this.isSelecting) e.preventDefault();
    });

    const handlePointerEnd = (e) => {
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
      endInteraction();

      if (activePointerId !== null) {
        try {
          container.releasePointerCapture(activePointerId);
        } catch (_) {}
        activePointerId = null;
      }
    };

    container.addEventListener('pointerup', handlePointerEnd);
    container.addEventListener('pointercancel', handlePointerEnd);

    // 舊版 iOS Safari 與部分 WebView 不支援 Pointer Events，改用 Touch Events。
    if (!window.PointerEvent) {
      container.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        const touch = e.touches[0];
        startInteraction(touch.clientX, touch.clientY, e.target);
        if (this.isSelecting) e.preventDefault();
      }, { passive: false });

      window.addEventListener('touchmove', (e) => {
        if (e.touches.length !== 1) return;
        const touch = e.touches[0];
        moveInteraction(touch.clientX, touch.clientY);
        if (this.isSelecting) e.preventDefault();
      }, { passive: false });

      window.addEventListener('touchend', endInteraction);
      window.addEventListener('touchcancel', endInteraction);
    }

    // 點擊空白處移至最末尾
    if (this.dom.displayCard) {
      this.dom.displayCard.addEventListener('pointerdown', (e) => {
        if (e.target === this.dom.displayCard) {
          this.setCursorIndex(this.tokens.length);
        }
      });
    }
  }

  handleArrowKey(direction, isShift) {
    if (this.tokens.length === 0) return;

    if (isShift) {
      // Shift + 方向鍵：擴展或收縮選取區間
      const anchor = this.selectionRange ? this.selectionRange.start : this.cursorIndex;
      const target = Math.max(0, Math.min(this.tokens.length, this.cursorIndex + direction));
      if (anchor === target) {
        this.setCursorIndex(target);
      } else {
        this.setSelectionRange(Math.min(anchor, target), Math.max(anchor, target));
        this.cursorIndex = target;
        this.updateEquationDisplay();
      }
    } else {
      if (this.selectionRange) {
        const target = direction < 0 ? this.selectionRange.start : this.selectionRange.end;
        this.setCursorIndex(target);
      } else {
        this.setCursorIndex(this.cursorIndex + direction);
      }
    }
  }

  switchMode(mode) {
    if (this.currentMode === mode) return;
    this.currentMode = mode;
    this.dom.tabButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    this.streak = 0;
    this.bestStreak = this.getBestStreak(mode);
    this.updateStatsDisplay();
    this.clearGameState();
    this.startNewGame();
  }

  /* ------------------------------------------------------------------------
     遊戲流程控制 (Game Loop)
     ------------------------------------------------------------------------ */
  startNewGame() {
    this.stopTimer();
    this.timerSeconds = 0;
    this.isWon = false;
    if (this.dom.timerText) this.dom.timerText.textContent = '0s';

    // 生成符合當前難度特徵的保證有解卡牌
    this.generateSolvableCards();
    this.usedCardIndices.clear();
    this.tokens = [];
    this.cursorIndex = 0;
    this.selectionRange = null;

    this.renderCards();
    this.updateEquationDisplay();
    this.startTimer();
    this.saveGameState();
  }

  startTimer() {
    this.stopTimer();
    // Controller instances created by Node.js tests/SSR must not keep the
    // process alive with a browser-only timer.
    if (typeof window === 'undefined') return;
    this.timerInterval = setInterval(() => {
      this.timerSeconds++;
      if (this.dom.timerText) this.dom.timerText.textContent = `${this.timerSeconds}s`;
      if (this.timerSeconds % 5 === 0 && !this.isWon) {
        this.saveGameState();
      }
    }, 1000);
  }

  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  /* ------------------------------------------------------------------------
     進度持久化 (localStorage)
     ------------------------------------------------------------------------ */
  saveGameState() {
    if (this.isWon) return;
    try {
      const state = {
        currentMode: this.currentMode,
        cardData: this.cardData,
        usedCardIndices: Array.from(this.usedCardIndices),
        tokens: this.tokens,
        cursorIndex: this.cursorIndex,
        selectionRange: this.selectionRange,
        solutions: this.solutions,
        puzzleInfo: this.puzzleInfo,
        streak: this.streak,
        timerSeconds: this.timerSeconds,
        timestamp: Date.now()
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {}
  }

  loadGameState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const state = JSON.parse(raw);
      if (!state || !state.cardData || state.cardData.length !== 4) return false;

      // 舊版難度相容遷移
      let mode = state.currentMode || 'easy';
      if (mode === 'classic') mode = 'medium';
      if (mode === 'expert') mode = 'master';
      if (!MODES[mode]) mode = 'easy';

      this.currentMode = mode;
      this.cardData = state.cardData;
      this.usedCardIndices = new Set(state.usedCardIndices || []);
      this.tokens = state.tokens || [];
      this.cursorIndex = typeof state.cursorIndex === 'number'
        ? Math.max(0, Math.min(this.tokens.length, state.cursorIndex))
        : this.tokens.length;
      this.selectionRange = state.selectionRange || null;
      this.solutions = state.solutions || [];
      this.puzzleInfo = state.puzzleInfo || null;
      this.streak = state.streak || 0;
      this.bestStreak = this.getBestStreak(this.currentMode);
      this.timerSeconds = state.timerSeconds || 0;
      this.isWon = false;

      this.dom.tabButtons.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === this.currentMode);
      });

      this.updateStatsDisplay();
      this.renderCards();
      this.updateEquationDisplay();
      this.startTimer();
      return true;
    } catch (e) {
      console.warn('載入 24 點進度失敗:', e);
      return false;
    }
  }

  clearGameState() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }

  /* ------------------------------------------------------------------------
     智慧難度題目生成引擎
     ------------------------------------------------------------------------ */
  generateSolvableCards() {
    const mode = this.currentMode;
    const modeConfig = MODES[mode] || MODES.easy;
    let puzzle = null;

    // 大師模式有 45% 機率直接從經典魔王題庫選題
    if (mode === 'master' && Math.random() < 0.45) {
      const template = CURATED_MASTER_PUZZLES[Math.floor(Math.random() * CURATED_MASTER_PUZZLES.length)];
      const shuffled = [...template].sort(() => Math.random() - 0.5);
      const analyzed = analyzePuzzle(shuffled);
      if (analyzed.solutionCount > 0) {
        puzzle = analyzed;
      }
    }

    if (!puzzle) {
      let attempts = 0;
      const maxAttempts = 150;
      while (attempts < maxAttempts) {
        attempts++;
        const testNums = Array.from({ length: 4 }, () => Math.floor(Math.random() * modeConfig.maxNum) + 1);
        const analyzed = analyzePuzzle(testNums);
        if (isPuzzleMatchingDifficulty(analyzed, mode)) {
          puzzle = analyzed;
          break;
        }
      }
    }

    // 防呆備援機制
    if (!puzzle) {
      if (mode === 'master') {
        const template = CURATED_MASTER_PUZZLES[Math.floor(Math.random() * CURATED_MASTER_PUZZLES.length)];
        puzzle = analyzePuzzle([...template].sort(() => Math.random() - 0.5));
      } else {
        const fallbacks = {
          easy: [2, 4, 6, 8],
          medium: [1, 5, 6, 8],
          hard: [3, 3, 7, 7]
        };
        const nums = fallbacks[mode] || [1, 2, 3, 4];
        puzzle = analyzePuzzle(nums);
      }
    }

    this.puzzleInfo = puzzle;
    // 簡單與標準模式優先展示整數解
    if (mode === 'easy' || mode === 'medium') {
      const integerSolutions = puzzle.rawSolutions.filter(s => !s.isFraction).map(s => s.expr);
      this.solutions = integerSolutions.length > 0 ? integerSolutions : puzzle.solutions;
    } else {
      this.solutions = puzzle.solutions;
    }

    // 隨機指派撲克牌花色與牌面文字
    this.cardData = puzzle.nums.map(num => {
      const suit = SUITS[Math.floor(Math.random() * SUITS.length)];
      let displayRank = num.toString();
      let subLabel = '';
      if (num === 1) { displayRank = 'A'; subLabel = '1'; }
      else if (num === 11) { displayRank = 'J'; subLabel = '11'; }
      else if (num === 12) { displayRank = 'Q'; subLabel = '12'; }
      else if (num === 13) { displayRank = 'K'; subLabel = '13'; }

      return { num, suit, displayRank, subLabel };
    });
  }

  /* ------------------------------------------------------------------------
     UI 繪製：撲克牌卡片
     ------------------------------------------------------------------------ */
  renderCards() {
    if (!this.dom.cardsGrid) return;
    this.dom.cardsGrid.innerHTML = '';
    this.cardData.forEach((card, idx) => {
      const btn = document.createElement('button');
      btn.className = `poker-card ${card.suit.type}`;
      btn.dataset.index = idx;
      btn.disabled = this.usedCardIndices.has(idx) || this.isWon;
      btn.title = `第 ${idx + 1} 張牌 (鍵盤快速鍵: ${idx + 1})`;

      btn.innerHTML = `
        <div class="card-corner top">
          <span class="card-suit-icon">${card.suit.symbol}</span>
        </div>
        <div class="card-center">
          <span class="center-number">${card.displayRank}</span>
          ${card.subLabel ? `<span class="center-sub">(${card.subLabel})</span>` : ''}
        </div>
        <div class="card-corner bottom">
          <span class="card-suit-icon">${card.suit.symbol}</span>
        </div>
      `;

      btn.addEventListener('click', () => {
        this.sound.playCardClick();
        this.addNumberToken(idx, card.num);
      });
      this.dom.cardsGrid.appendChild(btn);
    });
  }

  /* ------------------------------------------------------------------------
     游標定位、選取與智慧括號編輯方法
     ------------------------------------------------------------------------ */
  setCursorIndex(idx) {
    this.cursorIndex = Math.max(0, Math.min(this.tokens.length, idx));
    this.selectionRange = null;
    this.updateEquationDisplay();
    this.saveGameState();
  }

  setSelectionRange(start, end) {
    if (start === end) {
      this.setCursorIndex(start);
      return;
    }
    const s = Math.max(0, Math.min(start, end));
    const e = Math.min(this.tokens.length, Math.max(start, end));
    this.selectionRange = { start: s, end: e };
    this.cursorIndex = e;
    this.updateEquationDisplay();
    this.saveGameState();
  }

  clearSelection() {
    this.selectionRange = null;
    this.updateEquationDisplay();
    this.saveGameState();
  }

  /**
   * 檢查選取區間是否剛好被成對的配對括號包裹 (如 ( 3 + 5 ))
   */
  isSelectionEnclosedByMatchingParens(start, end) {
    if (end - start < 2) return false;
    if (this.tokens[start].val !== '(' || this.tokens[end - 1].val !== ')') return false;

    let depth = 0;
    for (let i = start; i < end; i++) {
      if (this.tokens[i].val === '(') depth++;
      else if (this.tokens[i].val === ')') {
        depth--;
        if (depth === 0 && i < end - 1) return false; // 中途就閉合了，例如 (1+2)+(3+4)
      }
    }
    return depth === 0;
  }

  /**
   * 智慧括號包裹或解開
   */
  wrapOrUnwrapSelection() {
    if (!this.selectionRange || this.isWon) return;
    const { start, end } = this.selectionRange;

    if (this.isSelectionEnclosedByMatchingParens(start, end)) {
      // 解開括號 (Unwrap)
      this.tokens.splice(end - 1, 1);
      this.tokens.splice(start, 1);
      const newEnd = end - 2;
      if (newEnd > start) {
        this.selectionRange = { start, end: newEnd };
        this.cursorIndex = newEnd;
      } else {
        this.selectionRange = null;
        this.cursorIndex = start;
      }
    } else {
      // 包裹括號 (Wrap)
      this.tokens.splice(end, 0, { type: 'op', val: ')' });
      this.tokens.splice(start, 0, { type: 'op', val: '(' });
      this.selectionRange = { start, end: end + 2 };
      this.cursorIndex = end + 2;
    }

    this.updateEquationDisplay();
    this.saveGameState();
  }

  deleteSelection() {
    if (!this.selectionRange) return;
    const { start, end } = this.selectionRange;
    for (let i = start; i < end; i++) {
      const t = this.tokens[i];
      if (t.type === 'num' && t.cardIdx !== undefined) {
        this.usedCardIndices.delete(t.cardIdx);
      }
    }
    this.tokens.splice(start, end - start);
    this.cursorIndex = start;
    this.selectionRange = null;
    this.renderCards();
  }

  addNumberToken(cardIdx, numValue) {
    if (this.usedCardIndices.has(cardIdx) || this.isWon) return;

    if (this.selectionRange) {
      this.deleteSelection();
    }

    this.tokens.splice(this.cursorIndex, 0, { type: 'num', val: numValue.toString(), cardIdx });
    this.usedCardIndices.add(cardIdx);
    this.cursorIndex++;
    this.selectionRange = null;

    this.renderCards();
    this.updateEquationDisplay();
    this.saveGameState();
  }

  addOperatorToken(opSymbol) {
    if (this.isWon) return;

    if (this.selectionRange) {
      if (opSymbol === '(' || opSymbol === ')') {
        this.wrapOrUnwrapSelection();
        return;
      }
      this.deleteSelection();
    }

    this.tokens.splice(this.cursorIndex, 0, { type: 'op', val: opSymbol });
    this.cursorIndex++;
    this.selectionRange = null;

    this.updateEquationDisplay();
    this.saveGameState();
  }

  handleBackspace() {
    if (this.tokens.length === 0 || this.isWon) return;

    if (this.selectionRange) {
      this.deleteSelection();
      this.updateEquationDisplay();
      this.saveGameState();
      return;
    }

    if (this.cursorIndex > 0) {
      const removed = this.tokens.splice(this.cursorIndex - 1, 1)[0];
      if (removed.type === 'num' && removed.cardIdx !== undefined) {
        this.usedCardIndices.delete(removed.cardIdx);
        this.renderCards();
      }
      this.cursorIndex--;
      this.updateEquationDisplay();
      this.saveGameState();
    }
  }

  handleDelete() {
    if (this.tokens.length === 0 || this.isWon) return;

    if (this.selectionRange) {
      this.deleteSelection();
      this.updateEquationDisplay();
      this.saveGameState();
      return;
    }

    if (this.cursorIndex < this.tokens.length) {
      const removed = this.tokens.splice(this.cursorIndex, 1)[0];
      if (removed.type === 'num' && removed.cardIdx !== undefined) {
        this.usedCardIndices.delete(removed.cardIdx);
        this.renderCards();
      }
      this.updateEquationDisplay();
      this.saveGameState();
    }
  }

  handleClear() {
    if (this.isWon) return;
    this.tokens = [];
    this.usedCardIndices.clear();
    this.cursorIndex = 0;
    this.selectionRange = null;
    this.renderCards();
    this.updateEquationDisplay();
    this.saveGameState();
  }

  /* ------------------------------------------------------------------------
     算式輸入框顯示與即時計算
     ------------------------------------------------------------------------ */
  updateEquationDisplay() {
    if (!this.dom.equationContainer || !this.dom.evalResult) return;

    // 校驗 cursorIndex 在合法範圍
    this.cursorIndex = Math.max(0, Math.min(this.tokens.length, this.cursorIndex));

    // 更新括號按鈕高亮狀態與 tooltip
    this.updateKeypadState();

    if (this.tokens.length === 0) {
      this.dom.equationContainer.innerHTML = `
        <div class="equation-slot active" data-slot="0">
          <span class="equation-caret"></span>
        </div>
        <span class="equation-placeholder">點選下方撲克牌與符號組合 24 點</span>
      `;
      const emptySlot = this.dom.equationContainer.querySelector('.equation-slot');
      if (emptySlot) {
        emptySlot.addEventListener('click', (e) => {
          e.stopPropagation();
          this.setCursorIndex(0);
        });
      }
      this.dom.evalResult.textContent = '';
      if (this.dom.displayCard) this.dom.displayCard.classList.remove('is-correct');
      return;
    }

    this.dom.equationContainer.innerHTML = '';

    // 渲染 slots 與 tokens 交錯結構
    for (let i = 0; i <= this.tokens.length; i++) {
      // 1. 建立 Slot i (游標放置點)
      const slot = document.createElement('div');
      slot.className = 'equation-slot';
      slot.dataset.slot = i.toString();

      // 當無選取且游標在該處時，顯示 Caret
      if (!this.selectionRange && this.cursorIndex === i) {
        slot.classList.add('active');
        const caret = document.createElement('span');
        caret.className = 'equation-caret';
        slot.appendChild(caret);
      }

      this.dom.equationContainer.appendChild(slot);

      // 2. 建立 Token i (若 i < tokens.length)
      if (i < this.tokens.length) {
        const token = this.tokens[i];
        const span = document.createElement('span');
        span.className = `equation-token ${token.type === 'num' ? 'num' : 'op'}`;
        if (token.val === '(' || token.val === ')') {
          span.classList.add('paren');
        }
        span.dataset.tokenIndex = i.toString();
        span.textContent = token.val;

        // 判斷是否被選取
        if (this.selectionRange && i >= this.selectionRange.start && i < this.selectionRange.end) {
          span.classList.add('selected');
        }

        this.dom.equationContainer.appendChild(span);
      }
    }

    const evalRes = this.evaluateTokens();
    if (evalRes.error) {
      this.dom.evalResult.textContent = '算式計算中...';
      this.dom.evalResult.className = 'eval-result';
      if (this.dom.displayCard) this.dom.displayCard.classList.remove('is-correct');
    } else {
      const valFormatted = Number.isInteger(evalRes.val) ? evalRes.val : evalRes.val.toFixed(2);
      this.dom.evalResult.textContent = `= ${valFormatted}`;

      // 獲勝判定：使用全部 4 張卡牌且計算結果等於 24
      const allUsed = this.usedCardIndices.size === 4;
      const isTwentyFour = Math.abs(evalRes.val - 24) < 1e-5;

      if (allUsed && isTwentyFour && !this.isWon) {
        this.dom.evalResult.textContent = '= 24 (過關！🎉)';
        this.dom.evalResult.className = 'eval-result success';
        if (this.dom.displayCard) this.dom.displayCard.classList.add('is-correct');
        this.handleWin();
      } else {
        this.dom.evalResult.className = 'eval-result';
        if (this.dom.displayCard) this.dom.displayCard.classList.remove('is-correct');
      }
    }
  }

  updateKeypadState() {
    if (typeof document === 'undefined') return;
    const parenBtns = document.querySelectorAll('.btn-key.op.paren');
    if (!parenBtns) return;

    if (this.selectionRange) {
      const isEnclosed = this.isSelectionEnclosedByMatchingParens(this.selectionRange.start, this.selectionRange.end);
      parenBtns.forEach(btn => {
        btn.classList.add('wrap-active');
        if (isEnclosed) {
          btn.classList.add('unwrap-mode');
          btn.title = '解除外層括號 (Unwrap)';
        } else {
          btn.classList.remove('unwrap-mode');
          btn.title = '為選取算式加上括號 (Wrap)';
        }
      });
    } else {
      parenBtns.forEach(btn => {
        btn.classList.remove('wrap-active', 'unwrap-mode');
        btn.title = btn.dataset.op === '(' ? '左括號' : '右括號';
      });
    }
  }

  evaluateTokens() {
    try {
      const exprStr = this.tokens.map(t => {
        if (t.val === '×') return '*';
        if (t.val === '÷') return '/';
        return t.val;
      }).join('');

      // 安全檢查：僅允許數字、四則運算符、括號與小數點
      if (!/^[0-9+\-*/().\s]+$/.test(exprStr)) return { error: true };
      if (/[*\/+\-]$/.test(exprStr)) return { error: true };

      const fn = new Function(`return (${exprStr})`);
      const val = fn();
      if (typeof val !== 'number' || isNaN(val) || !isFinite(val)) return { error: true };

      return { val };
    } catch (_) {
      return { error: true };
    }
  }

  /* ------------------------------------------------------------------------
     過關與獎勵
     ------------------------------------------------------------------------ */
  handleWin() {
    this.isWon = true;
    this.stopTimer();
    this.clearGameState();
    this.streak++;
    if (this.streak > this.bestStreak) {
      this.bestStreak = this.streak;
      try {
        localStorage.setItem(this.getBestStreakKey(this.currentMode), this.bestStreak.toString());
        localStorage.setItem(BEST_STREAK_KEY, this.bestStreak.toString());
      } catch (_) {}
    }
    this.updateStatsDisplay();
    this.sound.playWin();

    this.triggerConfetti();

    // 取得玩家過關時拼出的完整算式
    const finalEquation = this.tokens.map(t => t.val).join(' ');
    const modeName = MODES[this.currentMode]?.name || '當前';
    const tagHtml = this.puzzleInfo && this.puzzleInfo.tag
      ? `<div class="puzzle-tag">${this.puzzleInfo.tag}</div>`
      : '';

    const contentHtml = `
      ${tagHtml}
      <div class="win-equation-card">
        <div class="win-equation-label">通關算式</div>
        <div class="win-equation-text">${finalEquation} = 24</div>
      </div>
      <div class="win-stats-grid">
        <div class="win-stat-item">
          <span class="stat-label">難度模式</span>
          <span class="stat-val">${modeName}</span>
        </div>
        <div class="win-stat-item">
          <span class="stat-label">通關耗時</span>
          <span class="stat-val">${this.timerSeconds}s</span>
        </div>
        <div class="win-stat-item">
          <span class="stat-label">目前連勝</span>
          <span class="stat-val highlight">${this.streak} 局</span>
        </div>
        <div class="win-stat-item">
          <span class="stat-label">模式最佳</span>
          <span class="stat-val">${this.bestStreak} 局</span>
        </div>
      </div>
      <div class="win-modal-actions">
        <button class="btn-action secondary" id="modal-view-board-btn" type="button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> 檢視盤面
        </button>
        <button class="btn-action primary" id="modal-next-game-btn" type="button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg> 下一局
        </button>
      </div>
    `;

    if (typeof document === 'undefined') return;

    setTimeout(() => {
      this.showModal('解謎成功！🎉', contentHtml, true);

      const nextBtn = document.getElementById('modal-next-game-btn');
      if (nextBtn) {
        nextBtn.onclick = () => {
          this.dom.modalOverlay.classList.remove('active');
          this.startNewGame();
        };
      }

      const viewBoardBtn = document.getElementById('modal-view-board-btn');
      if (viewBoardBtn) {
        viewBoardBtn.onclick = () => {
          // 暫時關閉彈窗以檢視盤面與算式
          this.dom.modalOverlay.classList.remove('active');
        };
      }
    }, 450);
  }

  updateStatsDisplay() {
    if (this.dom.streakText) this.dom.streakText.textContent = this.streak;
    if (this.dom.bestText) this.dom.bestText.textContent = this.bestStreak;
  }

  /* ------------------------------------------------------------------------
     提示與彈窗
     ------------------------------------------------------------------------ */
  showHint() {
    if (this.solutions.length === 0) return;
    const randomSolution = this.solutions[Math.floor(Math.random() * this.solutions.length)];
    const tagHtml = this.puzzleInfo && this.puzzleInfo.tag
      ? `<div class="puzzle-tag">${this.puzzleInfo.tag}</div>`
      : '';

    this.showModal('解法參考', `${tagHtml}<div>其中一個可行的組合算式為：</div><div class="hint-solution">${randomSolution} = 24</div>`);
    if (this.dom.modalCloseBtn) {
      this.dom.modalCloseBtn.onclick = () => {
        this.dom.modalOverlay.classList.remove('active');
      };
    }
  }

  showModal(title, htmlContent, hideDefaultCloseBtn = false) {
    if (!this.dom.modalTitle || !this.dom.modalBody || !this.dom.modalOverlay) return;
    this.dom.modalTitle.textContent = title;
    this.dom.modalBody.innerHTML = htmlContent;
    if (this.dom.modalCloseBtn) {
      this.dom.modalCloseBtn.style.display = hideDefaultCloseBtn ? 'none' : 'block';
    }
    this.dom.modalOverlay.classList.add('active');
  }

  /* ------------------------------------------------------------------------
     五彩紙屑粒子特效 (Confetti)
     改由共用模組 BoboConfetti 負責；模組可缺席，缺席時安靜退場不影響遊戲。
     ------------------------------------------------------------------------ */
  triggerConfetti() {
    const confetti = (typeof BoboConfetti !== 'undefined' && BoboConfetti) ? BoboConfetti : null;
    if (!confetti) return;
    const canvas = this.dom.confettiCanvas;
    if (!canvas) return;
    // 參數完全比照本遊戲原本那份實作，接共用模組不改變既有的慶祝手感：
    // 45 顆圓點從畫面中心爆開、帶重力落下並淡出
    confetti.burst(canvas, {
      colors: CONFETTI_COLORS,
      pieces: 45,
      origin: 'center',
      shape: 'circle',
      spread: 12,
      gravity: 0.25,
      fade: 0.022
    });
  }
}

// 支援 Node.js 模組匯出以供測試
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    Make24Game,
    MODES,
    CURATED_MASTER_PUZZLES,
    solve24Detailed,
    solve24,
    analyzePuzzle,
    isPuzzleMatchingDifficulty
  };
}

// 初始化遊戲實例 (瀏覽器環境)
if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    new Make24Game();
  });
}
