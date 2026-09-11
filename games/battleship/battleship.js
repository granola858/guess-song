/**
 * 海戰棋 Battleship - 核心遊戲引擎
 */

// 船艦配置定義
const SHIP_TYPES = [
  { id: 'carrier', name: '航空母艦', size: 5, icon: '🚢' },
  { id: 'battleship', name: '戰列艦', size: 4, icon: '🛳️' },
  { id: 'cruiser', name: '巡洋艦', size: 3, icon: '🚤' },
  { id: 'submarine', name: '潛水艇', size: 3, icon: '🧭' },
  { id: 'destroyer', name: '驅逐艦', size: 2, icon: '⛵' }
];

const BOARD_SIZE = 10;
const ROWS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
const STORAGE_KEY = 'bobo-battleship-saved-game-v1';

// 音效合成器 - 薄薄一層包在全站共用模組 BoboAudio 上。
// 瀏覽器樣板（AudioContext 延後到使用者手勢才建立、iOS 靜音 buffer 解鎖、
// 背景 suspend／前景與 'interrupted' 喚醒、每個節點都 stop + disconnect、
// 偏好持久化）全部由模組接管，這裡只留下海戰棋自己的音色。
//
// 注意：'battleship-muted' 這個舊 key 存的是「靜音」，與模組的 enabled 相反，
// 所以要 invert: true —— 老玩家的靜音偏好才不會被反過來。
//
// BoboAudio 缺席時整個類別安靜退場：遊戲照常能玩，只是沒有聲音。
class SoundFX {
  constructor() {
    this.kit = (typeof BoboAudio !== 'undefined' && BoboAudio)
      ? BoboAudio.create({ storageKey: 'battleship-muted', invert: true })
      : null;
  }

  /** 是否靜音（UI 沿用舊介面讀 muted，與模組的 enabled 相反） */
  get muted() {
    return this.kit ? !this.kit.enabled : false;
  }

  /** 切換靜音並持久化 @returns {boolean} 切換後是否靜音 */
  toggleMute() {
    if (!this.kit) return false;
    return !this.kit.toggle();
  }

  /** 聲納掃描：880 → 440 Hz 下滑 */
  playSonar() {
    if (!this.kit) return;
    this.kit.sweep({ from: 880, to: 440, type: 'sine', duration: 0.3, gain: 0.15, floor: 0.001 });
  }

  /** 發射砲彈：300 → 900 Hz 上滑（音量走線性衰減） */
  playLaunch() {
    if (!this.kit) return;
    this.kit.sweep({
      from: 300, to: 900, glide: 0.18, type: 'triangle',
      duration: 0.2, gain: 0.12, curve: 'linear', floor: 0.01
    });
  }

  /** 命中爆炸：低通濾波白噪，截止頻率 900 → 50 Hz */
  playHit() {
    if (!this.kit) return;
    this.kit.noise({
      duration: 0.35, gain: 0.4, floor: 0.01,
      filter: { type: 'lowpass', frequency: 900, to: 50 }
    });
  }

  /** 落空水花：160 → 90 Hz 悶響 */
  playMiss() {
    if (!this.kit) return;
    this.kit.sweep({ from: 160, to: 90, type: 'sine', duration: 0.22, gain: 0.2, floor: 0.01 });
  }

  /** 擊沉：兩聲間隔 0.22 秒的 520 → 280 Hz 線性下滑警報 */
  playSunk() {
    if (!this.kit) return;
    this.kit.chord(
      [{ from: 520, to: 280, delay: 0 }, { from: 520, to: 280, delay: 0.22 }],
      { type: 'sawtooth', duration: 0.18, gain: 0.16, freqCurve: 'linear', floor: 0.01 }
    );
  }

  /** 勝利：C 大三和弦琶音上行 */
  playVictory() {
    if (!this.kit) return;
    this.kit.chord(
      [523.25, 659.25, 783.99, 1046.50],
      { type: 'triangle', duration: 0.35, gain: 0.2, stagger: 0.12, floor: 0.001 }
    );
  }

  /** 落敗：四音下行 */
  playDefeat() {
    if (!this.kit) return;
    this.kit.chord(
      [440, 392, 349.23, 293.66],
      { type: 'sine', duration: 0.38, gain: 0.25, stagger: 0.16, floor: 0.001 }
    );
  }
}

// 智慧 AI 對手系統
class BattleAI {
  constructor(difficulty = 'medium') {
    this.difficulty = difficulty;
    this.reset();
  }

  reset() {
    this.targetQueue = [];
    this.currentHits = [];
    this.huntDirection = null;
    this.shotsFired = new Set();
  }

  setDifficulty(diff) {
    this.difficulty = diff;
  }

  toJSON() {
    return {
      difficulty: this.difficulty,
      targetQueue: this.targetQueue,
      currentHits: this.currentHits,
      huntDirection: this.huntDirection,
      shotsFired: Array.from(this.shotsFired)
    };
  }

  fromJSON(data) {
    if (!data) return;
    this.difficulty = data.difficulty || 'medium';
    this.targetQueue = data.targetQueue || [];
    this.currentHits = data.currentHits || [];
    this.huntDirection = data.huntDirection || null;
    this.shotsFired = new Set(data.shotsFired || []);
  }

  getNextMove(playerBoard) {
    let target = null;

    if (this.difficulty === 'easy') {
      target = this.getRandomShot();
    } else if (this.difficulty === 'medium') {
      target = this.getHuntAndTargetMove(playerBoard);
    } else {
      target = this.getAdvancedMove(playerBoard);
    }

    if (target) {
      this.shotsFired.add(`${target.r},${target.c}`);
    }
    return target;
  }

  getRandomShot() {
    const available = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        const key = `${r},${c}`;
        if (!this.shotsFired.has(key)) {
          available.push({ r, c });
        }
      }
    }
    if (available.length === 0) return null;
    return available[Math.floor(Math.random() * available.length)];
  }

  getHuntAndTargetMove(playerBoard) {
    while (this.targetQueue.length > 0) {
      const candidate = this.targetQueue.shift();
      const key = `${candidate.r},${candidate.c}`;
      if (!this.shotsFired.has(key) && this.isValidCoord(candidate.r, candidate.c)) {
        return candidate;
      }
    }

    const parityShots = [];
    const regularShots = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        const key = `${r},${c}`;
        if (!this.shotsFired.has(key)) {
          if ((r + c) % 2 === 0) {
            parityShots.push({ r, c });
          } else {
            regularShots.push({ r, c });
          }
        }
      }
    }

    if (parityShots.length > 0) {
      return parityShots[Math.floor(Math.random() * parityShots.length)];
    }
    if (regularShots.length > 0) {
      return regularShots[Math.floor(Math.random() * regularShots.length)];
    }
    return null;
  }

  getAdvancedMove(playerBoard) {
    const minShipLen = this.getSmallestAliveShipSize(playerBoard);

    while (this.targetQueue.length > 0) {
      const candidate = this.targetQueue.shift();
      const key = `${candidate.r},${candidate.c}`;
      if (!this.shotsFired.has(key) && this.isValidCoord(candidate.r, candidate.c)) {
        return candidate;
      }
    }

    const candidates = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        const key = `${r},${c}`;
        if (!this.shotsFired.has(key) && (r + c) % 2 === 0) {
          const space = this.calculateFreeSpace(r, c);
          if (space >= minShipLen) {
            candidates.push({ r, c, weight: space });
          }
        }
      }
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.weight - a.weight);
      const topCount = Math.min(candidates.length, 3);
      return candidates[Math.floor(Math.random() * topCount)];
    }

    return this.getHuntAndTargetMove(playerBoard);
  }

  calculateFreeSpace(r, c) {
    let hSpace = 1;
    for (let col = c - 1; col >= 0 && !this.shotsFired.has(`${r},${col}`); col--) hSpace++;
    for (let col = c + 1; col < BOARD_SIZE && !this.shotsFired.has(`${r},${col}`); col++) hSpace++;

    let vSpace = 1;
    for (let row = r - 1; row >= 0 && !this.shotsFired.has(`${row},${c}`); row--) vSpace++;
    for (let row = r + 1; row < BOARD_SIZE && !this.shotsFired.has(`${row},${c}`); row++) vSpace++;

    return Math.max(hSpace, vSpace);
  }

  getSmallestAliveShipSize(playerBoard) {
    let minSize = 5;
    playerBoard.ships.forEach(ship => {
      if (!ship.isSunk && ship.size < minSize) {
        minSize = ship.size;
      }
    });
    return minSize;
  }

  recordShotResult(r, c, isHit, isSunk, sunkShip) {
    if (isHit) {
      this.currentHits.push({ r, c });

      if (isSunk) {
        this.currentHits = [];
        this.huntDirection = null;
        this.targetQueue = [];
      } else {
        this.updateTargetQueue();
      }
    }
  }

  updateTargetQueue() {
    if (this.currentHits.length === 1) {
      const { r, c } = this.currentHits[0];
      const neighbors = [
        { r: r - 1, c },
        { r: r + 1, c },
        { r, c: c - 1 },
        { r, c: c + 1 }
      ];
      this.targetQueue = neighbors.filter(n => 
        this.isValidCoord(n.r, n.c) && !this.shotsFired.has(`${n.r},${n.c}`)
      );
    } else if (this.currentHits.length >= 2) {
      const isHorizontal = this.currentHits[0].r === this.currentHits[1].r;
      const sorted = [...this.currentHits].sort((a, b) => 
        isHorizontal ? a.c - b.c : a.r - b.r
      );
      
      const newQueue = [];
      if (isHorizontal) {
        const row = sorted[0].r;
        const left = { r: row, c: sorted[0].c - 1 };
        const right = { r: row, c: sorted[sorted.length - 1].c + 1 };
        if (this.isValidCoord(left.r, left.c) && !this.shotsFired.has(`${left.r},${left.c}`)) newQueue.push(left);
        if (this.isValidCoord(right.r, right.c) && !this.shotsFired.has(`${right.r},${right.c}`)) newQueue.push(right);
      } else {
        const col = sorted[0].c;
        const top = { r: sorted[0].r - 1, c: col };
        const bottom = { r: sorted[sorted.length - 1].r + 1, c: col };
        if (this.isValidCoord(top.r, top.c) && !this.shotsFired.has(`${top.r},${top.c}`)) newQueue.push(top);
        if (this.isValidCoord(bottom.r, bottom.c) && !this.shotsFired.has(`${bottom.r},${bottom.c}`)) newQueue.push(bottom);
      }
      this.targetQueue = newQueue;
    }
  }

  isValidCoord(r, c) {
    return r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE;
  }
}

// 艦隊棋盤管理類
class GameBoard {
  constructor() {
    this.ships = [];
    this.grid = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
    this.shots = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  }

  reset() {
    this.ships = [];
    this.grid = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
    this.shots = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  }

  toJSON() {
    return {
      ships: this.ships.map(s => ({
        id: s.id,
        name: s.name,
        size: s.size,
        isHorizontal: s.isHorizontal,
        positions: s.positions,
        hits: Array.from(s.hits),
        isSunk: s.isSunk
      })),
      grid: this.grid,
      shots: this.shots
    };
  }

  fromJSON(data) {
    if (!data) return;
    this.grid = data.grid || Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
    this.shots = data.shots || Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
    this.ships = (data.ships || []).map(s => ({
      id: s.id,
      name: s.name,
      size: s.size,
      isHorizontal: s.isHorizontal,
      positions: s.positions || [],
      hits: new Set(s.hits || []),
      isSunk: !!s.isSunk
    }));
  }

  canPlaceShip(shipId, size, r, c, isHorizontal) {
    if (isHorizontal) {
      if (c + size > BOARD_SIZE) return false;
      for (let i = 0; i < size; i++) {
        if (this.grid[r][c + i] !== null && this.grid[r][c + i] !== shipId) return false;
      }
    } else {
      if (r + size > BOARD_SIZE) return false;
      for (let i = 0; i < size; i++) {
        if (this.grid[r + i][c] !== null && this.grid[r + i][c] !== shipId) return false;
      }
    }
    return true;
  }

  placeShip(shipDef, r, c, isHorizontal) {
    const { id, name, size } = shipDef;
    if (!this.canPlaceShip(id, size, r, c, isHorizontal)) return false;

    this.removeShip(id);

    const positions = [];
    for (let i = 0; i < size; i++) {
      const row = isHorizontal ? r : r + i;
      const col = isHorizontal ? c + i : c;
      this.grid[row][col] = id;
      positions.push({ r: row, c: col });
    }

    this.ships.push({
      id,
      name,
      size,
      isHorizontal,
      positions,
      hits: new Set(),
      isSunk: false
    });

    return true;
  }

  removeShip(shipId) {
    const idx = this.ships.findIndex(s => s.id === shipId);
    if (idx !== -1) {
      const ship = this.ships[idx];
      ship.positions.forEach(p => {
        this.grid[p.r][p.c] = null;
      });
      this.ships.splice(idx, 1);
    }
  }

  randomizeFleet() {
    this.reset();
    SHIP_TYPES.forEach(shipDef => {
      let placed = false;
      let attempts = 0;
      while (!placed && attempts < 200) {
        const isHorizontal = Math.random() < 0.5;
        const r = Math.floor(Math.random() * BOARD_SIZE);
        const c = Math.floor(Math.random() * BOARD_SIZE);
        if (this.canPlaceShip(shipDef.id, shipDef.size, r, c, isHorizontal)) {
          this.placeShip(shipDef, r, c, isHorizontal);
          placed = true;
        }
        attempts++;
      }
    });
  }

  receiveAttack(r, c) {
    if (this.shots[r][c] !== null) {
      return { alreadyShot: true };
    }

    const shipId = this.grid[r][c];
    if (shipId) {
      this.shots[r][c] = 'hit';
      const ship = this.ships.find(s => s.id === shipId);
      ship.hits.add(`${r},${c}`);
      if (ship.hits.size === ship.size) {
        ship.isSunk = true;
      }
      return {
        hit: true,
        isSunk: ship.isSunk,
        ship
      };
    } else {
      this.shots[r][c] = 'miss';
      return { hit: false };
    }
  }

  allShipsSunk() {
    return this.ships.length === SHIP_TYPES.length && this.ships.every(s => s.isSunk);
  }

  getAliveShipsCount() {
    return this.ships.filter(s => !s.isSunk).length;
  }
}

// 主遊戲控制器
class BattleshipGame {
  constructor() {
    this.sound = new SoundFX();
    this.ai = new BattleAI('medium');
    this.playerBoard = new GameBoard();
    this.enemyBoard = new GameBoard();

    this.gameState = 'placement';
    this.selectedShipId = null;
    this.isHorizontal = true;
    this.lastActionCoord = null;

    // 統計數據
    this.stats = {
      playerShots: 0,
      playerHits: 0,
      enemyShots: 0,
      enemyHits: 0,
      elapsedSeconds: 0,
      timerInterval: null
    };

    this.cacheDOM();
    this.bindEvents();
    this.init();
  }

  cacheDOM() {
    this.dom = {
      soundToggle: document.getElementById('sound-toggle'),
      playerGrid: document.getElementById('player-grid'),
      enemyGrid: document.getElementById('enemy-grid'),
      placementPanel: document.getElementById('placement-panel'),
      shipDock: document.getElementById('ship-dock'),
      rotateBtn: document.getElementById('rotate-btn'),
      randomBtn: document.getElementById('random-btn'),
      resetPlacementBtn: document.getElementById('reset-placement-btn'),
      startBattleBtn: document.getElementById('start-battle-btn'),
      diffBtns: document.querySelectorAll('.diff-btn'),
      battlefield: document.getElementById('battlefield'),
      statusDot: document.getElementById('status-dot'),
      statusText: document.getElementById('status-text'),
      phaseTag: document.getElementById('phase-tag'),
      playerAccuracy: document.getElementById('player-accuracy'),
      battleTime: document.getElementById('battle-time'),
      playerBadges: document.getElementById('player-badges'),
      enemyBadges: document.getElementById('enemy-badges'),
      playerManifest: document.getElementById('player-manifest'),
      enemyManifest: document.getElementById('enemy-manifest'),
      playerFleetHealth: document.getElementById('player-fleet-health'),
      enemyFleetHealth: document.getElementById('enemy-fleet-health'),
      gameOverModal: document.getElementById('game-over-modal'),
      modalCard: document.getElementById('modal-card'),
      modalBadge: document.getElementById('modal-badge'),
      modalTitle: document.getElementById('modal-title'),
      modalDesc: document.getElementById('modal-desc'),
      modalAccuracy: document.getElementById('modal-accuracy'),
      modalShots: document.getElementById('modal-shots'),
      modalTime: document.getElementById('modal-time'),
      modalRestartBtn: document.getElementById('modal-restart-btn')
    };
  }

  init() {
    this.updateSoundToggleIcon();
    this.buildGridDOM(this.dom.playerGrid, 'player');
    this.buildGridDOM(this.dom.enemyGrid, 'enemy');

    // 嘗試從 LocalStorage 載入歷史進度
    if (!this.loadGameState()) {
      this.startPlacementPhase();
    }
  }

  saveGameState() {
    try {
      const state = {
        gameState: this.gameState,
        difficulty: this.ai.difficulty,
        playerBoard: this.playerBoard.toJSON(),
        enemyBoard: this.enemyBoard.toJSON(),
        ai: this.ai.toJSON(),
        stats: {
          playerShots: this.stats.playerShots,
          playerHits: this.stats.playerHits,
          enemyShots: this.stats.enemyShots,
          enemyHits: this.stats.enemyHits,
          elapsedSeconds: this.stats.elapsedSeconds
        },
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
      if (!state || !state.gameState) return false;

      this.ai.fromJSON(state.ai);
      this.dom.diffBtns.forEach(b => {
        b.classList.toggle('active', b.dataset.diff === this.ai.difficulty);
      });

      this.playerBoard.fromJSON(state.playerBoard);
      this.enemyBoard.fromJSON(state.enemyBoard);

      this.stats.playerShots = state.stats?.playerShots || 0;
      this.stats.playerHits = state.stats?.playerHits || 0;
      this.stats.enemyShots = state.stats?.enemyShots || 0;
      this.stats.enemyHits = state.stats?.enemyHits || 0;
      this.stats.elapsedSeconds = state.stats?.elapsedSeconds || 0;

      this.gameState = state.gameState;

      if (this.gameState === 'placement') {
        this.dom.placementPanel.classList.remove('hidden');
        this.dom.phaseTag.textContent = '佈陣階段';
        this.dom.statusDot.className = 'status-dot';
        this.dom.statusText.textContent = '請配置艦隊陣型，點擊「開始戰鬥」';
        this.renderShipDock();
        this.renderPlayerGrid();
        this.renderEnemyGrid();
        this.renderManifests();
        this.checkPlacementReady();
        this.updateAccuracy();
        this.updateTimerDisplay();
      } else if (this.gameState === 'player-turn' || this.gameState === 'enemy-turn') {
        this.dom.placementPanel.classList.add('hidden');
        this.dom.phaseTag.textContent = '戰鬥交火';
        this.dom.statusDot.className = 'status-dot';
        this.dom.statusText.textContent = '輪到你了！請點選敵方座標發射飛彈。';
        this.dom.enemyGrid.parentElement.classList.add('active-target');
        this.dom.playerGrid.parentElement.classList.remove('active-target');

        this.startTimer();
        this.renderPlayerGrid();
        this.renderEnemyGrid();
        this.renderManifests();
        this.updateAccuracy();
        this.updateTimerDisplay();

        if (this.gameState === 'enemy-turn') {
          this.gameState = 'player-turn';
        }
      } else {
        return false;
      }

      return true;
    } catch (e) {
      console.warn('載入進度失敗:', e);
      return false;
    }
  }

  clearGameState() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {}
  }

  buildGridDOM(container, type) {
    container.innerHTML = '';

    const corner = document.createElement('div');
    corner.className = 'coord-header';
    container.appendChild(corner);

    for (let c = 1; c <= BOARD_SIZE; c++) {
      const colHeader = document.createElement('div');
      colHeader.className = 'coord-header';
      colHeader.textContent = c;
      container.appendChild(colHeader);
    }

    for (let r = 0; r < BOARD_SIZE; r++) {
      const rowHeader = document.createElement('div');
      rowHeader.className = 'coord-header';
      rowHeader.textContent = ROWS[r];
      container.appendChild(rowHeader);

      for (let c = 0; c < BOARD_SIZE; c++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.row = r;
        cell.dataset.col = c;
        cell.dataset.type = type;
        container.appendChild(cell);
      }
    }
  }

  bindEvents() {
    this.dom.soundToggle.addEventListener('click', () => {
      this.sound.toggleMute();
      this.updateSoundToggleIcon();
    });

    this.dom.rotateBtn.addEventListener('click', () => {
      this.isHorizontal = !this.isHorizontal;
      this.dom.rotateBtn.textContent = `🔄 旋轉方向 (${this.isHorizontal ? '水平' : '垂直'})`;
      this.sound.playSonar();
    });

    window.addEventListener('keydown', (e) => {
      if (this.gameState === 'placement' && (e.key === 'r' || e.key === 'R')) {
        this.dom.rotateBtn.click();
      }
    });

    this.dom.randomBtn.addEventListener('click', () => {
      this.playerBoard.randomizeFleet();
      this.renderPlayerGrid();
      this.renderShipDock();
      this.checkPlacementReady();
      this.sound.playSonar();
      this.saveGameState();
    });

    this.dom.resetPlacementBtn.addEventListener('click', () => {
      this.playerBoard.reset();
      this.selectedShipId = null;
      this.renderPlayerGrid();
      this.renderShipDock();
      this.checkPlacementReady();
      this.sound.playSonar();
      this.saveGameState();
    });

    this.dom.startBattleBtn.addEventListener('click', () => {
      if (this.playerBoard.ships.length === SHIP_TYPES.length) {
        this.startCombatPhase();
      }
    });

    this.dom.diffBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this.dom.diffBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const diff = btn.dataset.diff;
        this.ai.setDifficulty(diff);
        this.sound.playSonar();
        this.saveGameState();
      });
    });

    this.dom.playerGrid.addEventListener('mouseover', (e) => {
      if (this.gameState !== 'placement' || !this.selectedShipId) return;
      const cell = e.target.closest('.cell');
      if (!cell) return;
      const r = parseInt(cell.dataset.row, 10);
      const c = parseInt(cell.dataset.col, 10);
      this.previewShipPlacement(r, c);
    });

    this.dom.playerGrid.addEventListener('mouseleave', () => {
      if (this.gameState === 'placement') {
        this.clearPlacementPreview();
      }
    });

    this.dom.playerGrid.addEventListener('click', (e) => {
      if (this.gameState !== 'placement' || !this.selectedShipId) return;
      const cell = e.target.closest('.cell');
      if (!cell) return;
      const r = parseInt(cell.dataset.row, 10);
      const c = parseInt(cell.dataset.col, 10);
      const shipDef = SHIP_TYPES.find(s => s.id === this.selectedShipId);
      if (shipDef && this.playerBoard.placeShip(shipDef, r, c, this.isHorizontal)) {
        this.sound.playSonar();
        this.selectedShipId = null;
        this.renderPlayerGrid();
        this.renderShipDock();
        this.checkPlacementReady();
        this.saveGameState();
      }
    });

    // 點擊敵方棋盤開火（立即判定，零延遲打擊手感）
    this.dom.enemyGrid.addEventListener('click', (e) => {
      if (this.gameState !== 'player-turn') return;
      const cell = e.target.closest('.cell');
      if (!cell) return;
      const r = parseInt(cell.dataset.row, 10);
      const c = parseInt(cell.dataset.col, 10);
      this.handlePlayerAttack(r, c);
    });

    this.dom.modalRestartBtn.addEventListener('click', () => {
      this.dom.gameOverModal.classList.remove('show');
      this.clearGameState();
      this.startPlacementPhase();
    });
  }

  updateSoundToggleIcon() {
    this.dom.soundToggle.classList.toggle('muted', this.sound.muted);
    this.dom.soundToggle.setAttribute('title', this.sound.muted ? '已靜音 (點擊開啟)' : '音效開啟中 (點擊靜音)');
  }

  startPlacementPhase() {
    this.gameState = 'placement';
    this.playerBoard.reset();
    this.enemyBoard.reset();
    this.ai.reset();
    this.selectedShipId = null;
    this.clearIntervalTimer();

    this.playerBoard.randomizeFleet();

    this.dom.placementPanel.classList.remove('hidden');
    this.dom.enemyGrid.parentElement.classList.remove('active-target');
    this.dom.playerGrid.parentElement.classList.remove('active-target');
    this.dom.phaseTag.textContent = '佈陣階段';
    this.dom.statusDot.className = 'status-dot';
    this.dom.statusText.textContent = '請配置艦隊陣型，點擊「開始戰鬥」';
    this.dom.playerAccuracy.textContent = '0%';
    this.dom.battleTime.textContent = '00:00';

    this.stats = {
      playerShots: 0,
      playerHits: 0,
      enemyShots: 0,
      enemyHits: 0,
      elapsedSeconds: 0,
      timerInterval: null
    };

    this.renderShipDock();
    this.renderPlayerGrid();
    this.renderEnemyGrid();
    this.renderManifests();
    this.checkPlacementReady();
    this.saveGameState();
  }

  renderShipDock() {
    this.dom.shipDock.innerHTML = '';
    SHIP_TYPES.forEach(ship => {
      const placed = this.playerBoard.ships.some(s => s.id === ship.id);
      const dockShip = document.createElement('div');
      dockShip.className = `dock-ship ${placed ? 'placed' : ''} ${this.selectedShipId === ship.id ? 'selected' : ''}`;
      dockShip.dataset.id = ship.id;

      const info = document.createElement('div');
      info.className = 'ship-info';
      info.innerHTML = `<span>${ship.icon} ${ship.name}</span><span>${ship.size}格</span>`;

      const preview = document.createElement('div');
      preview.className = 'ship-preview';
      for (let i = 0; i < ship.size; i++) {
        const pCell = document.createElement('span');
        pCell.className = 'preview-cell';
        preview.appendChild(pCell);
      }

      dockShip.appendChild(info);
      dockShip.appendChild(preview);

      dockShip.addEventListener('click', () => {
        if (placed) {
          this.playerBoard.removeShip(ship.id);
          this.selectedShipId = ship.id;
          this.renderPlayerGrid();
          this.renderShipDock();
          this.checkPlacementReady();
          this.sound.playSonar();
          this.saveGameState();
        } else {
          this.selectedShipId = this.selectedShipId === ship.id ? null : ship.id;
          this.renderShipDock();
          this.sound.playSonar();
        }
      });

      this.dom.shipDock.appendChild(dockShip);
    });
  }

  previewShipPlacement(r, c) {
    this.clearPlacementPreview();
    const shipDef = SHIP_TYPES.find(s => s.id === this.selectedShipId);
    if (!shipDef) return;

    const canPlace = this.playerBoard.canPlaceShip(shipDef.id, shipDef.size, r, c, this.isHorizontal);
    const className = canPlace ? 'preview-valid' : 'preview-invalid';

    for (let i = 0; i < shipDef.size; i++) {
      const row = this.isHorizontal ? r : r + i;
      const col = this.isHorizontal ? c + i : c;
      if (row < BOARD_SIZE && col < BOARD_SIZE) {
        const cell = this.dom.playerGrid.querySelector(`[data-row="${row}"][data-col="${col}"]`);
        if (cell) {
          cell.classList.add(className);
        }
      }
    }
  }

  clearPlacementPreview() {
    const cells = this.dom.playerGrid.querySelectorAll('.preview-valid, .preview-invalid');
    cells.forEach(c => c.classList.remove('preview-valid', 'preview-invalid'));
  }

  checkPlacementReady() {
    const allPlaced = this.playerBoard.ships.length === SHIP_TYPES.length;
    this.dom.startBattleBtn.disabled = !allPlaced;
    if (allPlaced) {
      this.dom.startBattleBtn.classList.add('pulse');
    } else {
      this.dom.startBattleBtn.classList.remove('pulse');
    }
  }

  startCombatPhase() {
    this.gameState = 'player-turn';
    this.dom.placementPanel.classList.add('hidden');
    this.clearPlacementPreview();

    this.enemyBoard.randomizeFleet();

    this.stats.playerShots = 0;
    this.stats.playerHits = 0;
    this.stats.enemyShots = 0;
    this.stats.enemyHits = 0;
    this.stats.elapsedSeconds = 0;

    this.startTimer();

    this.dom.phaseTag.textContent = '戰鬥交火';
    this.dom.statusDot.className = 'status-dot';
    this.dom.statusText.textContent = '輪到你了！請點選敵方座標發射飛彈。';
    this.dom.enemyGrid.parentElement.classList.add('active-target');
    this.dom.playerGrid.parentElement.classList.remove('active-target');

    this.renderPlayerGrid();
    this.renderEnemyGrid();
    this.renderManifests();
    this.sound.playLaunch();
    this.saveGameState();
  }

  startTimer() {
    this.clearIntervalTimer();
    this.stats.timerInterval = setInterval(() => {
      this.stats.elapsedSeconds++;
      this.updateTimerDisplay();
      if (this.stats.elapsedSeconds % 5 === 0) {
        this.saveGameState();
      }
    }, 1000);
  }

  updateTimerDisplay() {
    const mins = String(Math.floor(this.stats.elapsedSeconds / 60)).padStart(2, '0');
    const secs = String(this.stats.elapsedSeconds % 60).padStart(2, '0');
    this.dom.battleTime.textContent = `${mins}:${secs}`;
  }

  clearIntervalTimer() {
    if (this.stats.timerInterval) {
      clearInterval(this.stats.timerInterval);
      this.stats.timerInterval = null;
    }
  }

  // 玩家開火（即時響應、俐落打擊感）
  handlePlayerAttack(r, c) {
    if (this.gameState !== 'player-turn') return;
    const res = this.enemyBoard.receiveAttack(r, c);
    if (res.alreadyShot) return;

    this.stats.playerShots++;
    const coordName = `${ROWS[r]}${c + 1}`;

    // 立即判定與立即給予視覺/音效反饋
    if (res.hit) {
      this.stats.playerHits++;
      this.triggerCellImpact(this.dom.enemyGrid, r, c);

      if (res.isSunk) {
        this.sound.playSunk();
        this.dom.statusText.textContent = `🎯 擊沉敵方【${res.ship.name}】(${coordName})！`;
      } else {
        this.sound.playHit();
        this.dom.statusText.textContent = `💥 命中敵方艦艇 (${coordName})！`;
      }
    } else {
      this.sound.playMiss();
      this.dom.statusText.textContent = `⚪ 砲彈落水未命中 (${coordName})`;
    }

    this.updateAccuracy();
    this.renderEnemyGrid();
    this.renderManifests();
    this.saveGameState();

    // 檢查是否勝利
    if (this.enemyBoard.allShipsSunk()) {
      this.handleGameOver('victory');
      return;
    }

    // 快速交接給 AI 回合（縮短等待時間至 350ms，提升節奏感）
    this.gameState = 'enemy-turn';
    this.dom.phaseTag.textContent = '敵方行動';
    this.dom.statusDot.className = 'status-dot enemy-turn';
    this.dom.enemyGrid.parentElement.classList.remove('active-target');
    this.dom.playerGrid.parentElement.classList.add('active-target');

    setTimeout(() => this.executeEnemyTurn(), 350);
  }

  // 電腦 AI 回合（緊湊反饋）
  executeEnemyTurn() {
    if (this.gameState !== 'enemy-turn') return;

    const move = this.ai.getNextMove(this.playerBoard);
    if (!move) return;

    const { r, c } = move;
    const res = this.playerBoard.receiveAttack(r, c);
    this.stats.enemyShots++;

    this.ai.recordShotResult(r, c, res.hit, res.isSunk, res.ship);
    const coordName = `${ROWS[r]}${c + 1}`;

    if (res.hit) {
      this.stats.enemyHits++;
      this.triggerCellImpact(this.dom.playerGrid, r, c);

      if (res.isSunk) {
        this.sound.playSunk();
        this.dom.statusText.textContent = `🚨 我方【${res.ship.name}】遭到擊沉 (${coordName})！`;
      } else {
        this.sound.playHit();
        this.dom.statusText.textContent = `🔥 我方艦艇遭受敵火命中 (${coordName})！`;
      }
    } else {
      this.sound.playMiss();
      this.dom.statusText.textContent = `🛡️ 敵方砲火落水未命中 (${coordName})`;
    }

    this.renderPlayerGrid();
    this.renderManifests();
    this.saveGameState();

    // 檢查是否戰敗
    if (this.playerBoard.allShipsSunk()) {
      this.handleGameOver('defeat');
      return;
    }

    // 快速切回玩家回合
    setTimeout(() => {
      if (this.gameState === 'enemy-turn') {
        this.gameState = 'player-turn';
        this.dom.phaseTag.textContent = '戰鬥交火';
        this.dom.statusDot.className = 'status-dot';
        this.dom.enemyGrid.parentElement.classList.add('active-target');
        this.dom.playerGrid.parentElement.classList.remove('active-target');
      }
    }, 200);
  }

  updateAccuracy() {
    if (this.stats.playerShots === 0) return;
    const acc = Math.round((this.stats.playerHits / this.stats.playerShots) * 100);
    this.dom.playerAccuracy.textContent = `${acc}%`;
  }

  triggerCellImpact(gridEl, r, c) {
    const cell = gridEl.querySelector(`[data-row="${r}"][data-col="${c}"]`);
    if (cell) {
      cell.classList.add('hit-impact');
      setTimeout(() => {
        cell.classList.remove('hit-impact');
      }, 300);
    }
  }

  handleGameOver(result) {
    this.gameState = 'game-over';
    this.clearIntervalTimer();
    this.clearGameState();
    this.dom.statusDot.className = 'status-dot game-over';

    const mins = String(Math.floor(this.stats.elapsedSeconds / 60)).padStart(2, '0');
    const secs = String(this.stats.elapsedSeconds % 60).padStart(2, '0');
    const timeStr = `${mins}:${secs}`;
    const acc = this.stats.playerShots > 0 ? Math.round((this.stats.playerHits / this.stats.playerShots) * 100) : 0;

    this.dom.modalAccuracy.textContent = `${acc}%`;
    this.dom.modalShots.textContent = `${this.stats.playerShots} 發`;
    this.dom.modalTime.textContent = timeStr;

    if (result === 'victory') {
      this.sound.playVictory();
      this.dom.statusText.textContent = '🎉 勝利！敵方艦隊全數沉沒！';
      this.dom.modalCard.className = 'modal-card victory';
      this.dom.modalBadge.textContent = '🏆';
      this.dom.modalTitle.textContent = '海上大捷！';
      this.dom.modalDesc.textContent = '你憑藉卓越的戰術判斷，成功全殲敵方海軍艦隊！';
    } else {
      this.sound.playDefeat();
      this.dom.statusText.textContent = '💀 戰敗！我方艦隊已被全數擊沉。';
      this.dom.modalCard.className = 'modal-card defeat';
      this.dom.modalBadge.textContent = '💥';
      this.dom.modalTitle.textContent = '艦隊覆沒';
      this.dom.modalDesc.textContent = '我方陣地已失守，重整陣型再來一局吧！';
    }

    setTimeout(() => {
      this.dom.gameOverModal.classList.add('show');
    }, 600);
  }

  renderPlayerGrid() {
    const cells = this.dom.playerGrid.querySelectorAll('.cell');
    cells.forEach(cell => {
      const r = parseInt(cell.dataset.row, 10);
      const c = parseInt(cell.dataset.col, 10);

      cell.className = 'cell';
      const shipId = this.playerBoard.grid[r][c];
      const shot = this.playerBoard.shots[r][c];

      if (shipId) {
        cell.classList.add('has-ship', 'ship-body');
      }

      if (shot === 'hit') {
        const ship = this.playerBoard.ships.find(s => s.id === shipId);
        if (ship && ship.isSunk) {
          cell.classList.add('sunk');
        } else {
          cell.classList.add('hit');
        }
      } else if (shot === 'miss') {
        cell.classList.add('miss');
      }
    });
  }

  renderEnemyGrid() {
    const cells = this.dom.enemyGrid.querySelectorAll('.cell');
    cells.forEach(cell => {
      const r = parseInt(cell.dataset.row, 10);
      const c = parseInt(cell.dataset.col, 10);

      cell.className = 'cell';
      const shot = this.enemyBoard.shots[r][c];
      const shipId = this.enemyBoard.grid[r][c];

      if (shot === 'hit') {
        const ship = this.enemyBoard.ships.find(s => s.id === shipId);
        if (ship && ship.isSunk) {
          cell.classList.add('sunk');
        } else {
          cell.classList.add('hit');
        }
      } else if (shot === 'miss') {
        cell.classList.add('miss');
      }
    });
  }

  renderManifests() {
    this.renderBadges(this.dom.playerBadges, this.playerBoard);
    this.renderBadges(this.dom.enemyBadges, this.enemyBoard);

    this.renderSingleManifest(this.dom.playerManifest, this.playerBoard, false);
    this.renderSingleManifest(this.dom.enemyManifest, this.enemyBoard, true);

    this.dom.playerFleetHealth.textContent = `我艦存活: ${this.playerBoard.getAliveShipsCount()} / 5`;
    this.dom.enemyFleetHealth.textContent = `敵艦存活: ${this.enemyBoard.getAliveShipsCount()} / 5`;
  }

  // 渲染頂部簡潔艦隊徽章
  renderBadges(container, board) {
    if (!container) return;
    container.innerHTML = '';
    SHIP_TYPES.forEach(shipDef => {
      const ship = board.ships.find(s => s.id === shipDef.id);
      const isSunk = ship ? ship.isSunk : false;
      const badge = document.createElement('span');
      badge.className = `fleet-badge ${isSunk ? 'sunk' : ''}`;
      badge.textContent = shipDef.icon;
      badge.title = `${shipDef.name} (${shipDef.size}格) - ${isSunk ? '已擊沉' : '存活'}`;
      container.appendChild(badge);
    });
  }

  // 渲染折疊式明細
  renderSingleManifest(container, board, isEnemy) {
    if (!container) return;
    container.innerHTML = '';
    SHIP_TYPES.forEach(shipDef => {
      const ship = board.ships.find(s => s.id === shipDef.id);
      const isSunk = ship ? ship.isSunk : false;
      const hitCount = ship ? ship.hits.size : 0;

      const item = document.createElement('div');
      item.className = `manifest-item ${isSunk ? 'sunk' : ''}`;

      const name = document.createElement('span');
      name.textContent = `${shipDef.icon} ${shipDef.name}`;

      const pegs = document.createElement('div');
      pegs.className = 'manifest-pegs';

      for (let i = 0; i < shipDef.size; i++) {
        const peg = document.createElement('span');
        if (isEnemy) {
          peg.className = `peg ${isSunk ? 'sunk-peg' : 'fog-peg'}`;
        } else {
          peg.className = `peg ${i < hitCount ? 'hit' : ''}`;
        }
        pegs.appendChild(peg);
      }

      item.appendChild(name);
      item.appendChild(pegs);
      container.appendChild(item);
    });
  }
}

// 頁面初始化
document.addEventListener('DOMContentLoaded', () => {
  window.battleshipGame = new BattleshipGame();
});
