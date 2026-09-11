/* ==========================================================================
   特工與地宮掃雷 (Minesweeper: Tactical & Dungeon)
   Core Engine, Audio Synthesizer, Touch UX & Persistence
   ========================================================================== */

'use strict';

// --------------------------------------------------------------------------
// Storage Keys & Constants
// --------------------------------------------------------------------------
const SAVE_KEY = 'minesweeper_save_state_v1';
const STATS_KEY = 'minesweeper_stats_v1';
const PREF_KEY = 'minesweeper_pref_v1';

const MODES = {
  TACTICAL: 'tactical',
  DUNGEON: 'dungeon',
  CLASSIC: 'classic'
};

const SKINS = {
  TACTICAL: 'tactical',
  DUNGEON: 'dungeon',
  CLASSIC: 'classic'
};

// 各模式綁定的預設外觀，經典模式固定使用 Windows 95 灰階風格
const MODE_SKIN_MAP = {
  [MODES.TACTICAL]: SKINS.TACTICAL,
  [MODES.DUNGEON]: SKINS.DUNGEON,
  [MODES.CLASSIC]: SKINS.CLASSIC
};

const SKIN_TITLES = {
  [SKINS.TACTICAL]: { text: '特工：戰術排雷', badge: 'Tactical Ops', label: '<span>🤖 戰術特工</span>' },
  [SKINS.DUNGEON]: { text: '地宮：掃雷冒險', badge: 'Dungeon Sweeper', label: '<span>🗺️ 地宮探險</span>' },
  [SKINS.CLASSIC]: { text: '掃雷：純粹經典', badge: 'Minesweeper', label: '<span>🖥️ 復古經典</span>' }
};

const ACTION_MODES = {
  DIG: 'dig',
  FLAG: 'flag',
  QUESTION: 'question',
  CHORD: 'chord'
};

const DIFFICULTY_PRESETS = {
  easy: { name: '簡單', rows: 9, cols: 9, mines: 10, doubleMines: false, initialShield: 1, initialRadar: 0 },
  medium: { name: '標準', rows: 16, cols: 16, mines: 40, doubleMines: false, initialShield: 1, initialRadar: 1 },
  hard: { name: '困難', rows: 16, cols: 30, mines: 99, doubleMines: false, initialShield: 1, initialRadar: 0 },
  inferno: { name: '地獄', rows: 20, cols: 20, mines: 75, doubleMines: true, initialShield: 2, initialRadar: 1 }
};

const DUNGEON_FLOORS = [
  { floor: 1, name: 'B1F 遺跡入口', rows: 8, cols: 8, mines: 8, chests: 2, goldTiles: 2 },
  { floor: 2, name: 'B2F 幽暗迴廊', rows: 9, cols: 9, mines: 13, chests: 2, goldTiles: 2 },
  { floor: 3, name: 'B3F 遠古密室', rows: 10, cols: 10, mines: 18, chests: 2, goldTiles: 3 },
  { floor: 4, name: 'B4F 熔岩深淵', rows: 11, cols: 11, mines: 24, chests: 3, goldTiles: 3 },
  { floor: 5, name: 'B5F 巨龍寶庫', rows: 12, cols: 12, mines: 30, chests: 3, goldTiles: 4 }
];

// --------------------------------------------------------------------------
// Web Audio API Sound Synthesizer
// --------------------------------------------------------------------------
class SweeperSoundManager {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    try {
      const pref = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      if (pref.sound !== undefined) this.enabled = !!pref.sound;
    } catch (_) {}
    this.bindLifecycle();
  }

  bindLifecycle() {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.ctx && this.ctx.state === 'running') {
          this.ctx.suspend().catch(() => {});
        }
      } else {
        if (this.ctx && this.ctx.state === 'suspended') {
          this.ctx.resume().catch(() => {});
        }
      }
    });
  }

  init() {
    if (!this.ctx && (window.AudioContext || window.webkitAudioContext)) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  toggle() {
    this.enabled = !this.enabled;
    try {
      const pref = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      pref.sound = this.enabled;
      localStorage.setItem(PREF_KEY, JSON.stringify(pref));
    } catch (_) {}
    return this.enabled;
  }

  playTone(freq, type = 'sine', duration = 0.08, gainVal = 0.15, decay = 0.04) {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);
      gain.gain.setValueAtTime(gainVal, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + duration);
    } catch (_) {}
  }

  playDig(skin = SKINS.TACTICAL) {
    if (skin === SKINS.CLASSIC) {
      // 復古 PC 蜂鳴器音色
      this.playTone(520, 'square', 0.04, 0.07);
    } else if (skin === SKINS.TACTICAL) {
      this.playTone(680, 'sine', 0.05, 0.12);
    } else {
      this.playTone(320, 'triangle', 0.07, 0.18);
    }
  }

  playFlag() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.08);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.08);
    } catch (_) {}
  }

  playUnflag() {
    this.playTone(380, 'sine', 0.05, 0.1);
  }

  playChord() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;
    [523.25, 659.25, 783.99].forEach((freq, idx) => {
      setTimeout(() => this.playTone(freq, 'sine', 0.1, 0.12), idx * 25);
    });
  }

  playShield() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(300, now);
      osc.frequency.exponentialRampToValueAtTime(1200, now + 0.25);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.25);
    } catch (_) {}
  }

  playRadar() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;
    [1046.5, 1318.51, 1567.98].forEach((freq, idx) => {
      setTimeout(() => this.playTone(freq, 'sine', 0.14, 0.15), idx * 80);
    });
  }

  playCoin() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;
    this.playTone(987.77, 'triangle', 0.08, 0.2);
    setTimeout(() => this.playTone(1318.51, 'triangle', 0.15, 0.2), 60);
  }

  playDamage() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(180, now);
      osc.frequency.exponentialRampToValueAtTime(60, now + 0.2);
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.2);
    } catch (_) {}
  }

  playExplode() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(120, now);
      osc.frequency.exponentialRampToValueAtTime(30, now + 0.4);
      gain.gain.setValueAtTime(0.35, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.4);
    } catch (_) {}
  }

  playWin() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
      setTimeout(() => this.playTone(f, 'sine', 0.2, 0.2), i * 100);
    });
  }
}

// --------------------------------------------------------------------------
// Core Logic Engine (Exportable for Unit Testing)
// --------------------------------------------------------------------------

/**
 * Creates an empty board grid
 */
function createEmptyBoard(rows, cols) {
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      row.push({
        row: r,
        col: c,
        isMine: false,
        isDouble: false,
        isChest: false,
        isStair: false,
        isGold: false,
        goldAmount: 0,
        count: 0,
        revealed: false,
        flagged: false,
        question: false,
        exploded: false,
        wrongFlag: false
      });
    }
    grid.push(row);
  }
  return grid;
}

/**
 * Gets valid neighbor cells for (r, c)
 */
function getNeighbors(grid, r, c) {
  const rows = grid.length;
  const cols = grid[0].length;
  const neighbors = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
        neighbors.push(grid[nr][nc]);
      }
    }
  }
  return neighbors;
}

/**
 * Populates mines with first-click 100% zero-safe guarantee (r0, c0 and its neighbors are free of mines)
 */
function populateMines(grid, totalMines, safeR, safeC, options = {}) {
  const rows = grid.length;
  const cols = grid[0].length;
  const { allowDouble = false, chests = 0, goldTiles = 0, hasStair = false } = options;

  // Build list of all candidate coordinates outside safe zone
  const safeZone = new Set();
  if (safeR !== undefined && safeC !== undefined) {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const nr = safeR + dr;
        const nc = safeC + dc;
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
          safeZone.add(`${nr},${nc}`);
        }
      }
    }
  }

  const candidates = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!safeZone.has(`${r},${c}`)) {
        candidates.push({ r, c });
      }
    }
  }

  // Shuffle candidates
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  let placedMines = 0;
  let candidateIdx = 0;

  // 1. Place mines
  while (placedMines < totalMines && candidateIdx < candidates.length) {
    const { r, c } = candidates[candidateIdx++];
    grid[r][c].isMine = true;
    grid[r][c].isDouble = allowDouble && Math.random() < 0.25;
    placedMines++;
  }

  // 2. Place stairs (for Dungeon mode)
  if (hasStair && candidateIdx < candidates.length) {
    const { r, c } = candidates[candidateIdx++];
    grid[r][c].isStair = true;
  }

  // 3. Place chests (for Dungeon mode)
  for (let i = 0; i < chests && candidateIdx < candidates.length; i++) {
    const { r, c } = candidates[candidateIdx++];
    grid[r][c].isChest = true;
  }

  // 4. Place gold tiles
  for (let i = 0; i < goldTiles && candidateIdx < candidates.length; i++) {
    const { r, c } = candidates[candidateIdx++];
    grid[r][c].isGold = true;
    grid[r][c].goldAmount = Math.floor(Math.random() * 15) + 10;
  }

  // Calculate surrounding mine counts (Double mines count as +2)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c].isMine) continue;
      const neighbors = getNeighbors(grid, r, c);
      let count = 0;
      for (const n of neighbors) {
        if (n.isMine) {
          count += n.isDouble ? 2 : 1;
        }
      }
      grid[r][c].count = count;
    }
  }

  return grid;
}

/**
 * Reveals a cell and cascades if count == 0.
 * Returns array of newly revealed cells.
 */
function revealCell(grid, r, c) {
  const target = grid[r][c];
  if (target.revealed || target.flagged) return [];

  const revealedCells = [];
  const queue = [target];
  target.revealed = true;
  revealedCells.push(target);

  if (target.isMine) return revealedCells;

  while (queue.length > 0) {
    const current = queue.shift();
    if (current.count === 0 && !current.isMine && !current.isChest && !current.isStair) {
      const neighbors = getNeighbors(grid, current.row, current.col);
      for (const n of neighbors) {
        if (!n.revealed && !n.flagged && !n.isMine) {
          n.revealed = true;
          revealedCells.push(n);
          if (n.count === 0 && !n.isChest && !n.isStair) {
            queue.push(n);
          }
        }
      }
    }
  }

  return revealedCells;
}

/**
 * Performs smart chording on a revealed cell.
 * Returns { success: boolean, triggeredMine: boolean, cells: Array, detonatedCell: Object }
 */
function chordCell(grid, r, c) {
  const target = grid[r][c];
  if (!target.revealed || target.count <= 0 || target.isMine) {
    return { success: false, cells: [] };
  }

  const neighbors = getNeighbors(grid, r, c);
  // A flag on a double mine must satisfy the +2 clue contributed by that cell.
  const flagCount = neighbors.reduce((sum, n) => {
    if (!n.flagged) return sum;
    return sum + (n.isDouble ? 2 : 1);
  }, 0);

  if (flagCount !== target.count) {
    return { success: false, cells: [] };
  }

  const revealedList = [];
  const detonatedCells = [];

  for (const n of neighbors) {
    if (!n.revealed && !n.flagged) {
      const cascade = revealCell(grid, n.row, n.col);
      revealedList.push(...cascade);
      if (n.isMine) {
        detonatedCells.push(n);
      }
    }
  }

  return {
    success: revealedList.length > 0,
    triggeredMine: detonatedCells.length > 0,
    cells: revealedList,
    detonatedCell: detonatedCells[0] || null,
    detonatedCells
  };
}

/**
 * Checks if game has reached a win condition
 */
function checkWinCondition(grid, mode = MODES.TACTICAL) {
  const rows = grid.length;
  const cols = grid[0].length;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = grid[r][c];
      if (!cell.isMine && !cell.revealed) {
        return false;
      }
    }
  }
  return true;
}

// --------------------------------------------------------------------------
// Minesweeper Main Game Controller Class
// --------------------------------------------------------------------------
class MinesweeperApp {
  constructor() {
    this.sound = new SweeperSoundManager();
    // 預設進入純粹經典模式 (Windows 95 復古風格)
    this.mode = MODES.CLASSIC;
    this.difficulty = 'medium';
    this.skin = SKINS.CLASSIC;
    this.action = ACTION_MODES.DIG;

    this.grid = [];
    this.rows = 16;
    this.cols = 16;
    this.totalMines = 40;
    this.allowDouble = false;

    this.gameStarted = false;
    this.gameOver = false;
    this.gameWon = false;
    this.firstClick = true;

    // Tactical mode stats & items
    this.shields = 1;
    this.radars = 1;
    this.detectors = 1;
    this.defusers = 1;
    this.energy = 0;
    this.activeItem = null; // 'shield' | 'radar' | 'detector' | 'defuser'

    // Dungeon mode stats
    this.currentFloor = 1;
    this.maxHp = 3;
    this.hp = 3;
    this.gold = 0;
    this.stairRevealed = false;

    // Timer & Counters
    this.timer = 0;
    this.timerInterval = null;
    this.moves = 0;
    this.streak = 0;
    this.flagsPlaced = 0;

    // Touch & Pan Zoom state
    this.zoomScale = 1.0;
    this.touchMoved = false;
    this.longPressTimer = null;
    this.suppressNextClick = false;
    this.resizeFrame = null;
    this.shopTimer = null;
    this.lastFocusedElement = null;

    this.initElements();
    this.bindEvents();
    this.initSkinAndTheme();
    this.loadStateOrNewGame();
  }

  initElements() {
    this.el = {
      titleText: document.getElementById('title-text'),
      titleBadge: document.getElementById('title-badge'),
      modeTabs: document.querySelectorAll('.mode-tab-btn'),
      difficultyBar: document.getElementById('difficulty-bar'),
      diffBtns: document.querySelectorAll('.diff-btn'),
      skinToggleBtn: document.getElementById('skin-toggle-btn'),
      themeBtn: document.getElementById('theme-btn'),
      soundBtn: document.getElementById('sound-btn'),
      statsBtn: document.getElementById('stats-btn'),
      helpBtn: document.getElementById('help-btn'),
      restartBtn: document.getElementById('restart-btn'),

      // HUD elements
      tacticalHudRow: document.getElementById('tactical-hud-row'),
      dungeonHudRow: document.getElementById('dungeon-hud-row'),
      mineCounter: document.getElementById('mine-counter'),
      timerDisplay: document.getElementById('timer-display'),
      energyBarContainer: document.getElementById('energy-bar-container'),
      energyFill: document.getElementById('energy-fill'),

      // Dungeon HUD
      hpBar: document.getElementById('hp-bar'),
      goldCounter: document.getElementById('gold-counter'),
      floorBadge: document.getElementById('floor-badge'),

      // Item Bar
      itemBar: document.getElementById('item-bar'),
      shieldBtn: document.getElementById('shield-btn'),
      radarBtn: document.getElementById('radar-btn'),
      detectorBtn: document.getElementById('detector-btn'),
      defuserBtn: document.getElementById('defuser-btn'),
      shieldCount: document.getElementById('shield-count'),
      radarCount: document.getElementById('radar-count'),
      detectorCount: document.getElementById('detector-count'),
      defuserCount: document.getElementById('defuser-count'),

      // Board & Viewport
      boardViewport: document.getElementById('board-viewport'),
      boardContainer: document.getElementById('board-container'),
      gridEl: document.getElementById('minesweeper-grid'),

      // Bottom Action Bar
      actionBtns: document.querySelectorAll('.action-mode-btn'),
      zoomInBtn: document.getElementById('zoom-in-btn'),
      zoomOutBtn: document.getElementById('zoom-out-btn'),
      zoomResetBtn: document.getElementById('zoom-reset-btn'),

      // Modals
      shopModal: document.getElementById('shop-modal'),
      shopCloseBtn: document.getElementById('shop-close-btn'),
      shopNextFloorBtn: document.getElementById('shop-next-floor-btn'),
      customModal: document.getElementById('custom-modal'),
      customStartBtn: document.getElementById('custom-start-btn'),
      customCloseBtn: document.getElementById('custom-close-btn'),
      customCancelBtn: document.getElementById('custom-cancel-btn'),
      statsModal: document.getElementById('stats-modal'),
      statsCloseBtn: document.getElementById('stats-close-btn'),
      statsOkBtn: document.getElementById('stats-ok-btn'),
      helpModal: document.getElementById('help-modal'),
      helpCloseBtn: document.getElementById('help-close-btn'),
      helpOkBtn: document.getElementById('help-ok-btn'),

      // Toast & Confetti
      toastContainer: document.getElementById('toast-container'),
      confettiCanvas: document.getElementById('confetti-canvas')
    };
  }

  // ------------------------------------------------------------------------
  // Preferences, Skin & Theme Sync
  // ------------------------------------------------------------------------
  initSkinAndTheme() {
    // 1. Sync Theme：主題一律交給共用 BoboTheme（它負責讀首頁偏好、跟隨系統色與同步 meta）
    const themeKit = (typeof BoboTheme !== 'undefined') ? BoboTheme : null;
    // 模組缺席時不自行重讀偏好，直接沿用 <head> 防閃爍腳本已寫上的主題
    this.updateThemeIcon(themeKit ? themeKit.init() : this.readAppliedTheme());

    // 2. Sync Skin
    try {
      const pref = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      if (this.mode !== MODES.CLASSIC && pref.skin && pref.skin !== SKINS.CLASSIC
        && Object.values(SKINS).includes(pref.skin)) {
        this.skin = pref.skin;
      }
    } catch (_) {}

    this.applySkin(this.mode === MODES.CLASSIC ? SKINS.CLASSIC : this.skin);
    this.updateSoundIcon();
  }

  applySkin(skin) {
    const info = SKIN_TITLES[skin] || SKIN_TITLES[SKINS.TACTICAL];
    this.skin = skin;
    if (typeof document !== 'undefined') document.documentElement.dataset.skin = skin;

    if (this.el.skinToggleBtn) {
      this.el.skinToggleBtn.innerHTML = info.label;
      // 經典風格由模式鎖定，不提供手動切換
      this.el.skinToggleBtn.style.display = skin === SKINS.CLASSIC ? 'none' : '';
    }

    if (this.el.titleText) this.el.titleText.textContent = info.text;
    if (this.el.titleBadge) this.el.titleBadge.textContent = info.badge;

    // 僅保存使用者可自由切換的風格，避免經典風格外溢到其他模式
    if (skin === SKINS.CLASSIC) return;

    try {
      const pref = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      pref.skin = skin;
      localStorage.setItem(PREF_KEY, JSON.stringify(pref));
    } catch (_) {}
  }

  toggleSkin() {
    if (this.mode === MODES.CLASSIC) return;
    const nextSkin = this.skin === SKINS.TACTICAL ? SKINS.DUNGEON : SKINS.TACTICAL;
    this.applySkin(nextSkin);
    this.showToast(nextSkin === SKINS.TACTICAL ? '🤖 已切換至「戰術特工」風格' : '🗺️ 已切換至「地宮探險」風格');
    this.sound.playTone(800, 'sine', 0.08);
  }

  // 讀出畫面上目前掛著的主題；BoboTheme 缺席時的最小備援，不碰 localStorage
  readAppliedTheme() {
    try {
      if (typeof document === 'undefined') return 'light';
      return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    } catch (_) {
      return 'light';
    }
  }

  toggleTheme() {
    const themeKit = (typeof BoboTheme !== 'undefined') ? BoboTheme : null;
    // 共用模組負責寫回 bobo-home-preferences-v2，且只改 theme 欄位，不會動到首頁的排序與隱藏設定
    if (themeKit) {
      this.updateThemeIcon(themeKit.toggle());
      return;
    }

    // 模組缺席時仍可當場切換，只是不持久化（重整後回到 prefers-color-scheme）
    const curTheme = this.readAppliedTheme() === 'dark' ? 'light' : 'dark';
    if (typeof document !== 'undefined') document.documentElement.dataset.theme = curTheme;
    this.updateThemeIcon(curTheme);
  }

  updateThemeIcon(theme) {
    if (!this.el.themeBtn) return;
    this.el.themeBtn.innerHTML = theme === 'dark'
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/></svg>';
  }

  updateSoundIcon() {
    if (!this.el.soundBtn) return;
    this.el.soundBtn.innerHTML = this.sound.enabled
      ? '<span>🔊</span>'
      : '<span style="opacity:0.5">🔇</span>';
  }

  // ------------------------------------------------------------------------
  // Event Binding & Touch Controls
  // ------------------------------------------------------------------------
  bindEvents() {
    // Header actions
    if (this.el.skinToggleBtn) this.el.skinToggleBtn.addEventListener('click', () => this.toggleSkin());
    if (this.el.themeBtn) this.el.themeBtn.addEventListener('click', () => this.toggleTheme());
    if (this.el.soundBtn) {
      this.el.soundBtn.addEventListener('click', () => {
        this.sound.toggle();
        this.updateSoundIcon();
        this.showToast(this.sound.enabled ? '🔊 音效已開啟' : '🔇 音效已靜音');
      });
    }
    if (this.el.statsBtn) this.el.statsBtn.addEventListener('click', () => this.openStatsModal());
    if (this.el.helpBtn) this.el.helpBtn.addEventListener('click', () => this.openHelpModal());
    if (this.el.restartBtn) this.el.restartBtn.addEventListener('click', () => this.startNewGame());

    // Mode Switcher
    this.el.modeTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const mode = tab.dataset.mode;
        if (mode && mode !== this.mode) {
          this.switchMode(mode);
        }
      });
    });

    this.bindGridEvents();

    // Difficulty Selector
    this.el.diffBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const diff = btn.dataset.diff;
        if (diff === 'custom') {
          this.openCustomModal();
        } else if (diff) {
          this.switchDifficulty(diff);
        }
      });
    });

    // Item Action buttons
    if (this.el.shieldBtn) this.el.shieldBtn.addEventListener('click', () => this.handleItemClick('shield'));
    if (this.el.radarBtn) this.el.radarBtn.addEventListener('click', () => this.handleItemClick('radar'));
    if (this.el.detectorBtn) this.el.detectorBtn.addEventListener('click', () => this.handleItemClick('detector'));
    if (this.el.defuserBtn) this.el.defuserBtn.addEventListener('click', () => this.handleItemClick('defuser'));

    // Bottom Action Bar
    this.el.actionBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.action;
        if (act) this.setAction(act);
      });
    });

    // Zoom controls
    if (this.el.zoomInBtn) this.el.zoomInBtn.addEventListener('click', () => this.adjustZoom(0.15));
    if (this.el.zoomOutBtn) this.el.zoomOutBtn.addEventListener('click', () => this.adjustZoom(-0.15));
    if (this.el.zoomResetBtn) this.el.zoomResetBtn.addEventListener('click', () => this.resetZoom());

    // Modals
    if (this.el.shopCloseBtn) this.el.shopCloseBtn.addEventListener('click', () => this.closeShopModal());
    if (this.el.shopNextFloorBtn) this.el.shopNextFloorBtn.addEventListener('click', () => this.proceedToNextFloor());
    if (this.el.customCloseBtn) this.el.customCloseBtn.addEventListener('click', () => this.closeCustomModal());
    if (this.el.customCancelBtn) this.el.customCancelBtn.addEventListener('click', () => this.closeCustomModal());
    if (this.el.customStartBtn) this.el.customStartBtn.addEventListener('click', () => this.startCustomGame());
    if (this.el.statsCloseBtn) this.el.statsCloseBtn.addEventListener('click', () => this.closeStatsModal());
    if (this.el.statsOkBtn) this.el.statsOkBtn.addEventListener('click', () => this.closeStatsModal());
    if (this.el.helpCloseBtn) this.el.helpCloseBtn.addEventListener('click', () => this.closeHelpModal());
    if (this.el.helpOkBtn) this.el.helpOkBtn.addEventListener('click', () => this.closeHelpModal());

    // Shop Item Purchase buttons
    document.querySelectorAll('.shop-buy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const itemType = btn.dataset.buy;
        const price = parseInt(btn.dataset.price, 10) || 0;
        this.buyShopItem(itemType, price);
      });
    });

    document.querySelectorAll('.modal-overlay').forEach(modal => {
      modal.addEventListener('click', (event) => {
        if (event.target === modal) this.closeModal(modal);
      });
    });

    document.addEventListener('keydown', (event) => {
      const openModal = document.querySelector('.modal-overlay.open');
      if (event.key === 'Escape') {
        if (openModal) this.closeModal(openModal);
        return;
      }
      if (event.key === 'Tab' && openModal) {
        const focusable = [...openModal.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    });

    window.addEventListener('resize', () => {
      if (this.resizeFrame) cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = requestAnimationFrame(() => {
        this.resizeFrame = null;
        this.autoScaleBoard();
      });
    });

    window.addEventListener('pagehide', () => this.saveGameState());
  }

  bindGridEvents() {
    if (!this.el.gridEl) return;

    const getTarget = (event) => {
      const cellEl = event.target.closest?.('.cell');
      if (!cellEl || !this.el.gridEl.contains(cellEl)) return null;
      const r = Number.parseInt(cellEl.dataset.row, 10);
      const c = Number.parseInt(cellEl.dataset.col, 10);
      if (!Number.isInteger(r) || !Number.isInteger(c)) return null;
      return { cellEl, r, c };
    };

    const clearLongPress = () => {
      if (this.longPressTimer) {
        clearTimeout(this.longPressTimer);
        this.longPressTimer = null;
      }
    };

    this.el.gridEl.addEventListener('contextmenu', (event) => {
      const target = getTarget(event);
      if (!target) return;
      event.preventDefault();
      if (!this.gameOver && !this.gameWon) this.handleFlagToggle(target.r, target.c);
    });

    this.el.gridEl.addEventListener('auxclick', (event) => {
      const target = getTarget(event);
      if (!target || event.button !== 1) return;
      event.preventDefault();
      this.handleChording(target.r, target.c);
    });

    this.el.gridEl.addEventListener('pointerdown', (event) => {
      const target = getTarget(event);
      if (!target || this.gameOver || this.gameWon) return;
      this.touchMoved = false;
      this.suppressNextClick = false;

      if (event.pointerType === 'touch') {
        clearLongPress();
        this.longPressTimer = setTimeout(() => {
          if (!this.touchMoved) {
            this.handleFlagToggle(target.r, target.c);
            if (navigator.vibrate) navigator.vibrate([20]);
            this.suppressNextClick = true;
          }
        }, 280);
      }
    });

    this.el.gridEl.addEventListener('pointermove', (event) => {
      if (event.pointerType === 'touch') this.touchMoved = true;
    });

    this.el.gridEl.addEventListener('pointerup', clearLongPress);
    this.el.gridEl.addEventListener('pointercancel', () => {
      this.touchMoved = true;
      clearLongPress();
    });

    this.el.gridEl.addEventListener('click', (event) => {
      const target = getTarget(event);
      if (!target || this.gameOver || this.gameWon) return;
      if (this.suppressNextClick) {
        this.suppressNextClick = false;
        return;
      }

      const { r, c } = target;
      if (this.activeItem) {
        this.executeActiveItem(r, c);
      } else if (this.action === ACTION_MODES.FLAG) {
        this.handleFlagToggle(r, c);
      } else if (this.action === ACTION_MODES.QUESTION) {
        this.handleQuestionToggle(r, c);
      } else if (this.action === ACTION_MODES.CHORD) {
        this.handleChording(r, c);
      } else if (this.grid[r][c].revealed) {
        this.handleChording(r, c);
      } else {
        this.handleDig(r, c);
      }
    });
  }

  // ------------------------------------------------------------------------
  // Game Setup & Initialization
  // ------------------------------------------------------------------------
  switchMode(newMode) {
    this.mode = newMode;
    this.syncControlState();

    // Auto sync skin when switching mode (經典模式強制套用 Windows 95 復古風格)
    const targetSkin = MODE_SKIN_MAP[newMode] || SKINS.TACTICAL;
    if (this.skin !== targetSkin) {
      this.applySkin(targetSkin);
    }

    this.startNewGame();
  }

  switchDifficulty(diff) {
    this.difficulty = diff;
    this.syncControlState();
    this.startNewGame();
  }

  syncControlState() {
    this.el.modeTabs.forEach(tab => {
      const selected = tab.dataset.mode === this.mode;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
    });
    this.el.diffBtns.forEach(btn => {
      const selected = btn.dataset.diff === this.difficulty;
      btn.classList.toggle('active', selected);
      btn.setAttribute('aria-pressed', String(selected));
    });
    this.el.actionBtns.forEach(btn => {
      btn.setAttribute('aria-pressed', String(btn.dataset.action === this.action));
    });
  }

  loadStateOrNewGame() {
    const loaded = this.loadGameState();
    if (!loaded) {
      this.startNewGame();
    }
  }

  startNewGame(options = {}) {
    const preserveDungeonRun = options.preserveDungeonRun === true;
    this.stopTimer();
    if (this.shopTimer) {
      clearTimeout(this.shopTimer);
      this.shopTimer = null;
    }
    this.closeShopModal();
    this.gameStarted = false;
    this.gameOver = false;
    this.gameWon = false;
    this.firstClick = true;
    this.timer = 0;
    this.moves = 0;
    this.flagsPlaced = 0;
    this.activeItem = null;
    this.updateActiveItemUI();

    if (this.mode === MODES.DUNGEON) {
      if (!preserveDungeonRun) {
        this.currentFloor = 1;
        this.maxHp = 3;
        this.hp = 3;
        this.gold = 0;
        this.shields = 0;
        this.radars = 0;
        this.detectors = 0;
        this.defusers = 0;
        this.energy = 0;
      }
      // Dungeon mode setup
      const floorInfo = DUNGEON_FLOORS[this.currentFloor - 1] || DUNGEON_FLOORS[0];
      this.rows = floorInfo.rows;
      this.cols = floorInfo.cols;
      this.totalMines = floorInfo.mines;
      this.allowDouble = false;
      this.stairRevealed = false;
    } else if (this.difficulty === 'custom') {
      // Keep existing custom settings or fallback
      this.rows = this.rows || 12;
      this.cols = this.cols || 12;
      this.totalMines = this.totalMines || 20;
    } else {
      // Tactical / Classic presets
      const preset = DIFFICULTY_PRESETS[this.difficulty] || DIFFICULTY_PRESETS.medium;
      this.rows = preset.rows;
      this.cols = preset.cols;
      this.totalMines = preset.mines;
      this.allowDouble = preset.doubleMines;

      if (this.mode === MODES.TACTICAL) {
        this.shields = preset.initialShield;
        this.radars = preset.initialRadar;
        this.detectors = 1;
        this.defusers = 1;
        this.energy = 0;
      } else {
        this.shields = 0;
        this.radars = 0;
        this.detectors = 0;
        this.defusers = 0;
        this.energy = 0;
      }
    }

    this.grid = createEmptyBoard(this.rows, this.cols);
    this.renderBoard();
    this.syncControlState();
    this.updateHUD();
    this.clearGameState();

    if (this.el.restartBtn) this.el.restartBtn.textContent = '🙂';

  }

  // ------------------------------------------------------------------------
  // Board Rendering & DOM Construction
  // ------------------------------------------------------------------------
  renderBoard() {
    if (!this.el.gridEl) return;
    this.el.gridEl.innerHTML = '';
    this.el.gridEl.style.gridTemplateRows = `repeat(${this.rows}, auto)`;
    this.el.gridEl.style.gridTemplateColumns = `repeat(${this.cols}, auto)`;
    this.el.gridEl.setAttribute('aria-rowcount', this.rows);
    this.el.gridEl.setAttribute('aria-colcount', this.cols);

    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const cellData = this.grid[r][c];
        const cellEl = document.createElement('button');
        cellEl.type = 'button';
        cellEl.className = 'cell';
        cellEl.dataset.row = r;
        cellEl.dataset.col = c;
        cellEl.setAttribute('aria-label', `格子 ${r + 1} 行 ${c + 1} 列`);

        this.updateCellElement(cellEl, cellData);
        this.el.gridEl.appendChild(cellEl);
      }
    }

    this.autoScaleBoard();
  }

  updateCellElement(cellEl, cellData) {
    if (!cellEl) return;
    cellEl.className = 'cell';
    delete cellEl.dataset.number;
    let stateLabel = '未翻開';

    if (cellData.revealed) {
      cellEl.classList.add('revealed');
      if (cellData.isMine) {
        cellEl.classList.add('mine');
        if (cellData.exploded) cellEl.classList.add('exploded');
        if (cellData.isDouble) cellEl.classList.add('double-mine');
        cellEl.textContent = cellData.isDouble ? '💥²' : '💣';
        stateLabel = cellData.isDouble ? '雙重地雷' : '地雷';
      } else if (cellData.isChest) {
        cellEl.classList.add('chest');
        cellEl.textContent = '📦';
        stateLabel = '寶箱';
      } else if (cellData.isStair) {
        cellEl.classList.add('stair');
        cellEl.textContent = '🪜';
        stateLabel = '階梯';
      } else if (cellData.isGold) {
        cellEl.classList.add('gold');
        cellEl.textContent = `🪙`;
        stateLabel = `金幣 ${cellData.goldAmount}`;
      } else if (cellData.count > 0) {
        cellEl.dataset.number = cellData.count;
        cellEl.textContent = cellData.count;
        stateLabel = `周圍地雷值 ${cellData.count}`;
      } else {
        cellEl.classList.add('cell-0');
        cellEl.textContent = '';
        stateLabel = '已翻開空格';
      }
    } else {
      if (cellData.wrongFlag) {
        cellEl.classList.add('wrong-flag');
        cellEl.textContent = '✕';
        stateLabel = '錯誤旗幟';
      } else if (cellData.flagged) {
        cellEl.classList.add('flagged');
        cellEl.textContent = '🚩';
        stateLabel = '已插旗';
      } else if (cellData.question) {
        cellEl.classList.add('question');
        cellEl.textContent = '❓';
        stateLabel = '疑問標記';
      } else {
        cellEl.textContent = '';
      }
    }

    cellEl.setAttribute('aria-label', `第 ${cellData.row + 1} 行第 ${cellData.col + 1} 列，${stateLabel}`);
  }

  // ------------------------------------------------------------------------
  // Core Gameplay Actions: Dig, Flag, Chording
  // ------------------------------------------------------------------------
  handleDig(r, c) {
    const cell = this.grid[r][c];
    if (cell.revealed || cell.flagged) return;

    // Handle First Click
    if (this.firstClick) {
      this.firstClick = false;
      this.startTimer();
      this.gameStarted = true;

      // Populate mines ensuring safe area
      const options = {
        allowDouble: this.allowDouble,
        chests: this.mode === MODES.DUNGEON ? (DUNGEON_FLOORS[this.currentFloor - 1]?.chests || 2) : 0,
        goldTiles: this.mode === MODES.DUNGEON ? (DUNGEON_FLOORS[this.currentFloor - 1]?.goldTiles || 2) : 0,
        hasStair: this.mode === MODES.DUNGEON
      };
      populateMines(this.grid, this.totalMines, r, c, options);
    }

    this.moves++;

    // Hit a mine!
    if (cell.isMine) {
      // Check for Shield protection
      if (this.shields > 0) {
        this.shields--;
        cell.flagged = true;
        this.flagsPlaced++;
        this.sound.playShield();
        this.showToast('🛡️ 護盾抵消了地雷爆炸！已自動插上安全旗');
        this.updateHUD();
        this.refreshGridDOM([cell]);
        this.saveGameState();
        return;
      }

      // Check Dungeon HP damage
      if (this.mode === MODES.DUNGEON && this.hp > 1) {
        this.hp--;
        cell.revealed = true;
        cell.exploded = true;
        this.sound.playDamage();
        if (navigator.vibrate) navigator.vibrate([100]);
        this.showToast(`💥 踩到陷阱！剩餘生命：${this.hp} ❤️`);
        this.updateHUD();
        this.refreshGridDOM([cell]);
        this.saveGameState();
        return;
      }

      // Game Over
      this.handleGameOver(r, c);
      return;
    }

    // Safe dig
    const revealedCells = revealCell(this.grid, r, c);
    this.sound.playDig(this.skin);

    // Energy Gain for Tactical Mode
    if (this.mode === MODES.TACTICAL) {
      this.addEnergy(revealedCells.length * 2);
    }

    // Dungeon Special Tile Checks
    this.processDungeonReveals(revealedCells);

    this.refreshGridDOM(revealedCells);

    // Check Win
    if (checkWinCondition(this.grid, this.mode)) {
      this.handleWin();
    } else {
      this.saveGameState();
    }
  }

  processDungeonReveals(revealedCells) {
    if (this.mode !== MODES.DUNGEON) return;
    revealedCells.forEach(revealed => {
      if (revealed.isChest) {
        this.openChest();
      } else if (revealed.isGold) {
        this.collectGold(revealed.goldAmount || 15);
      } else if (revealed.isStair) {
        this.revealStair();
      }
    });
  }

  handleFlagToggle(r, c) {
    const cell = this.grid[r][c];
    if (cell.revealed) return;

    if (cell.flagged) {
      cell.flagged = false;
      this.flagsPlaced--;
      this.sound.playUnflag();
    } else {
      cell.flagged = true;
      cell.question = false;
      this.flagsPlaced++;
      this.sound.playFlag();
    }

    this.updateHUD();
    this.refreshGridDOM([cell]);
    this.saveGameState();
  }

  handleQuestionToggle(r, c) {
    const cell = this.grid[r][c];
    if (cell.revealed) return;

    if (cell.question) {
      cell.question = false;
    } else {
      cell.question = true;
      if (cell.flagged) {
        cell.flagged = false;
        this.flagsPlaced--;
      }
    }

    this.updateHUD();
    this.refreshGridDOM([cell]);
    this.saveGameState();
  }

  handleChording(r, c) {
    const result = chordCell(this.grid, r, c);
    if (!result.success) return;

    this.moves++;

    if (result.triggeredMine) {
      for (const detonatedCell of result.detonatedCells || [result.detonatedCell]) {
        if (this.shields > 0) {
          this.shields--;
          detonatedCell.flagged = true;
          detonatedCell.revealed = false;
          this.flagsPlaced++;
          this.sound.playShield();
          this.showToast('🛡️ 護盾抵消了連鎖引爆！');
        } else if (this.mode === MODES.DUNGEON && this.hp > 1) {
          this.hp--;
          detonatedCell.exploded = true;
          this.sound.playDamage();
          this.showToast(`💥 連鎖觸發陷阱！剩餘生命：${this.hp} ❤️`);
        } else {
          this.handleGameOver(detonatedCell.row, detonatedCell.col);
          return;
        }
      }
    } else {
      this.sound.playChord();
      if (this.mode === MODES.TACTICAL) {
        this.addEnergy(result.cells.length * 3);
      }
    }

    this.processDungeonReveals(result.cells);
    this.refreshGridDOM(result.cells);

    if (checkWinCondition(this.grid, this.mode)) {
      this.handleWin();
    } else {
      this.saveGameState();
    }
  }

  // ------------------------------------------------------------------------
  // Tactical Items Logic (Shield, Sonar, Metal Detector, Drone Defuser)
  // ------------------------------------------------------------------------
  handleItemClick(itemType) {
    if (this.gameOver || this.gameWon) return;

    if (this.firstClick && itemType !== 'shield') {
      this.showToast('⛏️ 請先挖開第一格，再使用戰術道具');
      return;
    }

    if (this.activeItem === itemType) {
      this.activeItem = null;
      this.showToast('取消道具選擇');
    } else {
      if (itemType === 'shield') {
        if (this.shields <= 0) {
          this.showToast('⚠️ 護盾數量不足');
          return;
        }
        this.showToast('🛡️ 護盾處於就緒狀態，將在踩雷時自動抵消爆炸');
      } else if (itemType === 'radar') {
        if (this.radars <= 0) {
          this.showToast('⚠️ 聲納掃描次數不足');
          return;
        }
        this.activeItem = 'radar';
        this.showToast('📡 點擊地圖任意方塊，掃描該區 3×3 地雷');
      } else if (itemType === 'detector') {
        if (this.detectors <= 0) {
          this.showToast('⚠️ 金屬探測器次數不足');
          return;
        }
        this.activeItem = 'detector';
        this.showToast('🧲 點擊方塊，探測整行與整列的地雷總數');
      } else if (itemType === 'defuser') {
        if (this.defusers <= 0) {
          this.showToast('⚠️ 拆彈無人機次數不足');
          return;
        }
        this.activeItem = 'defuser';
        this.showToast('🤖 點擊任意未翻開方塊進行精準安全拆解');
      }
    }

    this.updateActiveItemUI();
  }

  executeActiveItem(r, c) {
    if (this.firstClick) {
      this.activeItem = null;
      this.updateActiveItemUI();
      this.showToast('⛏️ 請先挖開第一格，再使用戰術道具');
      return;
    }

    if (this.activeItem === 'radar') {
      this.radars--;
      this.sound.playRadar();
      const changedCells = [];

      // Scan 3x3
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < this.rows && nc >= 0 && nc < this.cols) {
            const cell = this.grid[nr][nc];
            if (cell.isMine) {
              if (!cell.flagged) {
                cell.flagged = true;
                cell.question = false;
                this.flagsPlaced++;
                changedCells.push(cell);
              }
            } else if (!cell.revealed) {
              changedCells.push(...revealCell(this.grid, nr, nc));
            }
          }
        }
      }
      this.showToast('📡 聲納掃描完成！地雷已自動標記');
      this.activeItem = null;
      this.processDungeonReveals(changedCells);
      this.refreshGridDOM(changedCells);
      this.updateHUD();

      if (checkWinCondition(this.grid, this.mode)) this.handleWin();

    } else if (this.activeItem === 'detector') {
      this.detectors--;
      this.sound.playTone(900, 'sine', 0.15);

      // Count row and col mines
      let rowMines = 0;
      let colMines = 0;
      for (let j = 0; j < this.cols; j++) {
        if (this.grid[r][j].isMine) rowMines += this.grid[r][j].isDouble ? 2 : 1;
      }
      for (let i = 0; i < this.rows; i++) {
        if (this.grid[i][c].isMine) colMines += this.grid[i][c].isDouble ? 2 : 1;
      }

      this.showToast(`🧲 探測結果：第 ${r + 1} 行共 ${rowMines} 雷，第 ${c + 1} 列共 ${colMines} 雷`);
      this.activeItem = null;
      this.updateHUD();

    } else if (this.activeItem === 'defuser') {
      this.defusers--;
      this.sound.playShield();
      const cell = this.grid[r][c];
      let changedCells = [cell];
      if (cell.isMine) {
        if (!cell.flagged) {
          cell.flagged = true;
          cell.question = false;
          this.flagsPlaced++;
        }
        this.showToast('🤖 無人機成功拆除並標記了 1 顆地雷！');
      } else {
        changedCells = revealCell(this.grid, r, c);
        this.processDungeonReveals(changedCells);
        this.showToast('🤖 無人機確認該格安全並成功翻開！');
      }
      this.activeItem = null;
      this.refreshGridDOM(changedCells);
      this.updateHUD();

      if (checkWinCondition(this.grid, this.mode)) this.handleWin();
    }

    this.updateActiveItemUI();
    this.saveGameState();
  }

  addEnergy(val) {
    this.energy = Math.min(100, this.energy + val);
    if (this.energy >= 100) {
      this.energy = 0;
      this.radars++;
      this.sound.playTone(1200, 'sine', 0.2);
      this.showToast('⚡ 戰術能量已滿！獲得 1 次【聲納掃描】');
    }
    this.updateHUD();
  }

  // ------------------------------------------------------------------------
  // Dungeon Mode Events: Chest, Gold, Floor Progression & Shop
  // ------------------------------------------------------------------------
  openChest() {
    this.sound.playCoin();
    const goldFound = Math.floor(Math.random() * 25) + 20;
    this.gold += goldFound;

    const bonusRoll = Math.random();
    if (bonusRoll < 0.4) {
      this.shields++;
      this.showToast(`📦 打開寶箱！獲得 ${goldFound} 金幣與 1 個【防爆護盾】🛡️`);
    } else if (bonusRoll < 0.7 && this.hp < this.maxHp) {
      this.hp++;
      this.showToast(`📦 打開寶箱！獲得 ${goldFound} 金幣並恢復 1 點生命 ❤️`);
    } else {
      this.radars++;
      this.showToast(`📦 打開寶箱！獲得 ${goldFound} 金幣與 1 次【地宮探測】📡`);
    }
    this.updateHUD();
  }

  collectGold(amount) {
    this.sound.playCoin();
    this.gold += amount;
    this.showToast(`🪙 發現金幣礦！獲得 ${amount} 金幣`);
    this.updateHUD();
  }

  revealStair() {
    this.stairRevealed = true;
    this.sound.playTone(700, 'sine', 0.2);
    this.showToast('🪜 發現通往下一層的階梯！全清盤面後即可前進');
  }

  openShopModal() {
    if (this.el.shopModal) {
      const goldSpan = document.getElementById('shop-player-gold');
      if (goldSpan) goldSpan.textContent = this.gold;
      this.openModal(this.el.shopModal, this.el.shopCloseBtn);
    }
  }

  closeShopModal() {
    this.closeModal(this.el.shopModal);
  }

  buyShopItem(type, price) {
    if (this.gold < price) {
      this.showToast('⚠️ 金幣不足！');
      return;
    }

    this.gold -= price;
    this.sound.playCoin();

    if (type === 'heal') {
      this.hp = Math.min(this.maxHp, this.hp + 1);
      this.showToast('🧪 購買成功！生命值 +1 ❤️');
    } else if (type === 'maxhp') {
      this.maxHp++;
      this.hp++;
      this.showToast('💖 購買成功！最大生命上限 +1');
    } else if (type === 'shield') {
      this.shields++;
      this.showToast('🛡️ 購買成功！護盾 +1');
    } else if (type === 'radar') {
      this.radars++;
      this.showToast('📡 購買成功！探測次數 +1');
    }

    this.updateHUD();
    const goldSpan = document.getElementById('shop-player-gold');
    if (goldSpan) goldSpan.textContent = this.gold;
  }

  proceedToNextFloor() {
    this.closeShopModal();
    if (this.currentFloor < DUNGEON_FLOORS.length) {
      this.currentFloor++;
      this.showToast(`🏰 進入地宮第 ${this.currentFloor} 層！`);
      this.startNewGame({ preserveDungeonRun: true });
    } else {
      this.handleFinalDungeonVictory();
    }
  }

  // ------------------------------------------------------------------------
  // Game State Handling: Win, Game Over, Persistence
  // ------------------------------------------------------------------------
  handleWin() {
    this.stopTimer();
    this.gameWon = true;
    this.sound.playWin();
    if (this.el.restartBtn) this.el.restartBtn.textContent = '😎';

    // Auto flag remaining mines
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this.grid[r][c].isMine && !this.grid[r][c].flagged) {
          this.grid[r][c].flagged = true;
          this.flagsPlaced++;
        }
      }
    }
    this.updateHUD();
    this.refreshGridDOM();
    this.triggerConfetti();

    if (this.mode === MODES.DUNGEON) {
      if (this.currentFloor < DUNGEON_FLOORS.length) {
        this.showToast(`🎉 第 ${this.currentFloor} 層排雷完成！開啟層間商店`);
        this.shopTimer = setTimeout(() => {
          this.shopTimer = null;
          if (this.gameWon && this.mode === MODES.DUNGEON) this.openShopModal();
        }, 600);
      } else {
        this.handleFinalDungeonVictory();
      }
    } else {
      this.recordStats(true);
      this.showToast(`🏆 恭喜通關！耗時 ${this.timer} 秒，共 ${this.moves} 步`);
    }

    this.clearGameState();
  }

  handleFinalDungeonVictory() {
    this.recordStats(true);
    this.showToast('👑 恭喜征服地宮全部 5 層！獲得遠古掃雷大師榮耀！');
  }

  handleGameOver(explodedR, explodedC) {
    this.stopTimer();
    this.gameOver = true;
    this.sound.playExplode();
    if (this.el.restartBtn) this.el.restartBtn.textContent = '😵';

    // Reveal all mines
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const cell = this.grid[r][c];
        if (cell.isMine) {
          cell.revealed = true;
          if (r === explodedR && c === explodedC) {
            cell.exploded = true;
          }
        } else if (cell.flagged) {
          // Wrong flag
          cell.wrongFlag = true;
        }
      }
    }

    this.refreshGridDOM();
    this.recordStats(false);
    this.showToast('💥 引爆地雷！遊戲結束，點擊笑臉重開一局');
    this.clearGameState();
  }

  // ------------------------------------------------------------------------
  // Timer & Stats Management
  // ------------------------------------------------------------------------
  startTimer(reset = true) {
    this.stopTimer();
    if (reset) this.timer = 0;
    if (typeof window === 'undefined') return;
    this.timerInterval = setInterval(() => {
      this.timer++;
      if (this.el.timerDisplay) {
        this.el.timerDisplay.textContent = this.timer;
      }
    }, 1000);
  }

  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  recordStats(isWin) {
    try {
      const stats = JSON.parse(localStorage.getItem(STATS_KEY) || '{}');
      const key = `${this.mode}_${this.difficulty}`;
      if (!stats[key]) {
        stats[key] = { plays: 0, wins: 0, bestTime: null, fewestMoves: null, streak: 0, maxStreak: 0 };
      }

      const s = stats[key];
      s.plays++;
      if (isWin) {
        s.wins++;
        s.streak++;
        s.maxStreak = Math.max(s.maxStreak, s.streak);
        if (s.bestTime === null || this.timer < s.bestTime) s.bestTime = this.timer;
        if (s.fewestMoves === null || this.moves < s.fewestMoves) s.fewestMoves = this.moves;
      } else {
        s.streak = 0;
      }

      localStorage.setItem(STATS_KEY, JSON.stringify(stats));
    } catch (_) {}
  }

  // ------------------------------------------------------------------------
  // State Persistence Standard (saveGameState, loadGameState, clearGameState)
  // ------------------------------------------------------------------------
  saveGameState() {
    if (!this.gameStarted || this.gameOver || this.gameWon) return;
    try {
      const state = {
        mode: this.mode,
        difficulty: this.difficulty,
        skin: this.skin,
        rows: this.rows,
        cols: this.cols,
        totalMines: this.totalMines,
        allowDouble: this.allowDouble,
        timer: this.timer,
        moves: this.moves,
        flagsPlaced: this.flagsPlaced,
        shields: this.shields,
        radars: this.radars,
        detectors: this.detectors,
        defusers: this.defusers,
        energy: this.energy,
        currentFloor: this.currentFloor,
        hp: this.hp,
        maxHp: this.maxHp,
        gold: this.gold,
        grid: this.grid.map(row => row.map(c => ({
          isMine: c.isMine,
          isDouble: c.isDouble,
          isChest: c.isChest,
          isStair: c.isStair,
          isGold: c.isGold,
          goldAmount: c.goldAmount,
          count: c.count,
          revealed: c.revealed,
          flagged: c.flagged,
          question: c.question
        })))
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    } catch (_) {}
  }

  loadGameState() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      const state = JSON.parse(raw);
      if (!state || !state.grid || !Array.isArray(state.grid)) return false;

      this.mode = state.mode || MODES.CLASSIC;
      this.difficulty = state.difficulty || 'medium';
      this.rows = state.rows;
      this.cols = state.cols;
      this.totalMines = state.totalMines;
      this.allowDouble = !!state.allowDouble;
      this.timer = state.timer || 0;
      this.moves = state.moves || 0;
      this.flagsPlaced = state.flagsPlaced || 0;
      this.shields = state.shields || 0;
      this.radars = state.radars || 0;
      this.detectors = state.detectors || 0;
      this.defusers = state.defusers || 0;
      this.energy = state.energy || 0;
      this.currentFloor = state.currentFloor || 1;
      this.hp = state.hp || 3;
      this.maxHp = state.maxHp || 3;
      this.gold = state.gold || 0;

      // Reconstruct grid
      this.grid = createEmptyBoard(this.rows, this.cols);
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          Object.assign(this.grid[r][c], state.grid[r][c]);
        }
      }

      this.gameStarted = true;
      this.firstClick = false;
      this.gameOver = false;
      this.gameWon = false;
      this.activeItem = null;
      // 經典模式一律鎖定復古風格，其餘模式沿用存檔中的使用者選擇
      const savedSkin = Object.values(SKINS).includes(state.skin) ? state.skin : this.skin;
      this.applySkin(this.mode === MODES.CLASSIC ? SKINS.CLASSIC : (savedSkin === SKINS.CLASSIC ? SKINS.TACTICAL : savedSkin));
      this.syncControlState();
      this.renderBoard();
      this.updateHUD();
      this.startTimer(false);
      this.showToast('📥 已為您自動恢復未完成的戰局');
      return true;
    } catch (_) {
      return false;
    }
  }

  clearGameState() {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch (_) {}
  }

  // ------------------------------------------------------------------------
  // UI & HUD Update Functions
  // ------------------------------------------------------------------------
  updateHUD() {
    const remainingMines = Math.max(0, this.totalMines - this.flagsPlaced);
    if (this.el.mineCounter) this.el.mineCounter.textContent = remainingMines;
    if (this.el.timerDisplay) this.el.timerDisplay.textContent = this.timer;

    // Tactical HUD vs Dungeon HUD Visibility
    if (this.mode === MODES.DUNGEON) {
      if (this.el.tacticalHudRow) this.el.tacticalHudRow.style.display = 'none';
      if (this.el.dungeonHudRow) this.el.dungeonHudRow.style.display = 'flex';
      if (this.el.itemBar) this.el.itemBar.style.display = 'flex';
      if (this.el.difficultyBar) this.el.difficultyBar.style.display = 'none';
      if (this.el.energyBarContainer) this.el.energyBarContainer.style.display = 'none';

      if (this.el.shieldBtn) this.el.shieldBtn.style.display = '';
      if (this.el.radarBtn) this.el.radarBtn.style.display = '';
      if (this.el.detectorBtn) this.el.detectorBtn.style.display = 'none';
      if (this.el.defuserBtn) this.el.defuserBtn.style.display = 'none';
      if (this.el.shieldCount) this.el.shieldCount.textContent = this.shields;
      if (this.el.radarCount) this.el.radarCount.textContent = this.radars;
      if (this.el.shieldBtn) this.el.shieldBtn.disabled = this.shields <= 0;
      if (this.el.radarBtn) this.el.radarBtn.disabled = this.radars <= 0;

      // Update Dungeon Hearts & Gold
      if (this.el.hpBar) {
        this.el.hpBar.innerHTML = '❤️'.repeat(this.hp) + '🖤'.repeat(Math.max(0, this.maxHp - this.hp));
      }
      if (this.el.goldCounter) this.el.goldCounter.textContent = `🪙 ${this.gold}`;
      if (this.el.floorBadge) this.el.floorBadge.textContent = `🏰 B${this.currentFloor}F`;
    } else {
      if (this.el.tacticalHudRow) this.el.tacticalHudRow.style.display = 'flex';
      if (this.el.dungeonHudRow) this.el.dungeonHudRow.style.display = 'none';
      if (this.el.difficultyBar) this.el.difficultyBar.style.display = 'flex';

      if (this.mode === MODES.TACTICAL) {
        if (this.el.itemBar) this.el.itemBar.style.display = 'flex';
        if (this.el.energyBarContainer) this.el.energyBarContainer.style.display = 'flex';
        if (this.el.energyFill) this.el.energyFill.style.width = `${this.energy}%`;
        if (this.el.shieldBtn) this.el.shieldBtn.style.display = '';
        if (this.el.radarBtn) this.el.radarBtn.style.display = '';
        if (this.el.detectorBtn) this.el.detectorBtn.style.display = '';
        if (this.el.defuserBtn) this.el.defuserBtn.style.display = '';

        // Update Item badges
        if (this.el.shieldCount) this.el.shieldCount.textContent = this.shields;
        if (this.el.radarCount) this.el.radarCount.textContent = this.radars;
        if (this.el.detectorCount) this.el.detectorCount.textContent = this.detectors;
        if (this.el.defuserCount) this.el.defuserCount.textContent = this.defusers;

        if (this.el.shieldBtn) this.el.shieldBtn.disabled = this.shields <= 0;
        if (this.el.radarBtn) this.el.radarBtn.disabled = this.radars <= 0;
        if (this.el.detectorBtn) this.el.detectorBtn.disabled = this.detectors <= 0;
        if (this.el.defuserBtn) this.el.defuserBtn.disabled = this.defusers <= 0;
      } else {
        // Classic mode -> Hide items and energy bar
        if (this.el.itemBar) this.el.itemBar.style.display = 'none';
        if (this.el.energyBarContainer) this.el.energyBarContainer.style.display = 'none';
      }
    }
  }

  updateActiveItemUI() {
    const itemBtns = {
      shield: this.el.shieldBtn,
      radar: this.el.radarBtn,
      detector: this.el.detectorBtn,
      defuser: this.el.defuserBtn
    };

    Object.entries(itemBtns).forEach(([key, btn]) => {
      if (btn) btn.classList.toggle('active', this.activeItem === key);
    });
  }

  refreshGridDOM(changedCells = null) {
    if (!this.el.gridEl) return;
    const cells = this.el.gridEl.children;
    if (Array.isArray(changedCells)) {
      const indexes = new Set(changedCells.map(cell => cell.row * this.cols + cell.col));
      indexes.forEach(index => {
        const cellEl = cells[index];
        if (!cellEl) return;
        const r = Number.parseInt(cellEl.dataset.row, 10);
        const c = Number.parseInt(cellEl.dataset.col, 10);
        this.updateCellElement(cellEl, this.grid[r][c]);
      });
      return;
    }
    for (let i = 0; i < cells.length; i++) {
      const cellEl = cells[i];
      const r = parseInt(cellEl.dataset.row, 10);
      const c = parseInt(cellEl.dataset.col, 10);
      this.updateCellElement(cellEl, this.grid[r][c]);
    }
  }

  setAction(action) {
    this.action = action;
    this.el.actionBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.action === action);
      btn.setAttribute('aria-pressed', String(btn.dataset.action === action));
    });
    this.sound.playTone(550, 'sine', 0.05);
  }

  // ------------------------------------------------------------------------
  // Zoom & RWD Pan Handling
  // ------------------------------------------------------------------------
  adjustZoom(delta) {
    this.zoomScale = Math.max(0.6, Math.min(2.0, this.zoomScale + delta));
    this.applyZoom();
  }

  resetZoom() {
    this.zoomScale = 1.0;
    this.applyZoom();
  }

  applyZoom() {
    if (!this.el.boardContainer || !this.el.gridEl) return;
    const naturalWidth = this.el.gridEl.offsetWidth;
    const naturalHeight = this.el.gridEl.offsetHeight;
    this.el.gridEl.style.transform = `scale(${this.zoomScale})`;
    this.el.boardContainer.style.width = `${naturalWidth * this.zoomScale}px`;
    this.el.boardContainer.style.height = `${naturalHeight * this.zoomScale}px`;
  }

  autoScaleBoard() {
    if (!this.el.boardViewport) return;
    const viewportW = this.el.boardViewport.clientWidth - 24;
    const totalW = this.el.gridEl?.offsetWidth || 0;

    if (totalW > viewportW && viewportW > 0) {
      this.zoomScale = Math.max(0.65, Math.min(1.0, viewportW / totalW));
    } else {
      this.zoomScale = 1.0;
    }
    this.applyZoom();
  }

  // ------------------------------------------------------------------------
  // Modals & Dialogs
  // ------------------------------------------------------------------------
  openModal(modal, focusTarget) {
    if (!modal) return;
    this.lastFocusedElement = document.activeElement;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    modal.classList.add('open');
    focusTarget?.focus();
  }

  closeModal(modal) {
    if (!modal) return;
    modal.classList.remove('open');
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    if (this.lastFocusedElement?.isConnected) this.lastFocusedElement.focus();
    this.lastFocusedElement = null;
  }

  openCustomModal() {
    this.openModal(this.el.customModal, this.el.customCloseBtn);
  }

  closeCustomModal() {
    this.closeModal(this.el.customModal);
  }

  startCustomGame() {
    const rowsInput = document.getElementById('custom-rows');
    const colsInput = document.getElementById('custom-cols');
    const minesInput = document.getElementById('custom-mines');
    const doubleCheckbox = document.getElementById('custom-double');

    const r = Math.max(8, Math.min(30, parseInt(rowsInput?.value, 10) || 12));
    const c = Math.max(8, Math.min(30, parseInt(colsInput?.value, 10) || 12));
    const maxMines = Math.floor(r * c * 0.85);
    const m = Math.max(1, Math.min(maxMines, parseInt(minesInput?.value, 10) || 15));

    this.rows = r;
    this.cols = c;
    this.totalMines = m;
    this.allowDouble = !!doubleCheckbox?.checked;
    this.difficulty = 'custom';

    this.closeCustomModal();
    this.startNewGame();
  }

  openStatsModal() {
    if (!this.el.statsModal) return;
    try {
      const stats = JSON.parse(localStorage.getItem(STATS_KEY) || '{}');
      const key = `${this.mode}_${this.difficulty}`;
      const s = stats[key] || { plays: 0, wins: 0, bestTime: null, fewestMoves: null, maxStreak: 0 };

      document.getElementById('stat-plays').textContent = s.plays;
      document.getElementById('stat-wins').textContent = s.wins;
      document.getElementById('stat-winrate').textContent = s.plays > 0 ? `${Math.round((s.wins / s.plays) * 100)}%` : '0%';
      document.getElementById('stat-besttime').textContent = s.bestTime !== null ? `${s.bestTime}s` : '--';
      document.getElementById('stat-streak').textContent = s.maxStreak || 0;
    } catch (_) {}

    this.openModal(this.el.statsModal, this.el.statsCloseBtn);
  }

  closeStatsModal() {
    this.closeModal(this.el.statsModal);
  }

  openHelpModal() {
    this.openModal(this.el.helpModal, this.el.helpCloseBtn);
  }

  closeHelpModal() {
    this.closeModal(this.el.helpModal);
  }

  // ------------------------------------------------------------------------
  // Toast & Confetti Notifications
  // ------------------------------------------------------------------------
  showToast(message) {
    if (!this.el.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = 'toast-msg';
    toast.textContent = message;
    this.el.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 2400);
  }

  // 彩帶走共用 BoboConfetti：內建 prefers-reduced-motion 守衛、高 DPI 處理
  // 與 cancelAnimationFrame 收尾；模組缺席時安靜退場，不影響遊戲進行
  triggerConfetti() {
    if (!this.el.confettiCanvas) return;
    const confettiKit = (typeof BoboConfetti !== 'undefined') ? BoboConfetti : null;
    if (!confettiKit) return;
    try {
      confettiKit.burst(this.el.confettiCanvas);
    } catch (_) {}
  }
}

// --------------------------------------------------------------------------
// Window Bootstrap
// --------------------------------------------------------------------------
let gameInstance = null;
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    gameInstance = new MinesweeperApp();
  });
}

// --------------------------------------------------------------------------
// Export for Node Unit Tests
// --------------------------------------------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MODES,
    SKINS,
    MODE_SKIN_MAP,
    SKIN_TITLES,
    ACTION_MODES,
    DIFFICULTY_PRESETS,
    DUNGEON_FLOORS,
    createEmptyBoard,
    getNeighbors,
    populateMines,
    revealCell,
    chordCell,
    checkWinCondition,
    MinesweeperApp
  };
}
