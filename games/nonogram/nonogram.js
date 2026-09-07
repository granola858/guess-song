let size = 8;
    let currentAction = 'fill';
    let gameStates = {};
    let themeColor = '#FFB7F1';
    let darkMode = false;

    let isDragging = false;
    let dragAction = null;
    let dragSnapshot = null;
    let dragHistoryCommitted = false;
    let actionHistory = [];
    let lastSavedAt = 0;
    // 存檔版本號：每次寫入都以 max(本地, 存檔) + 1 遞增，取代 Date.now() 當權威，
    // 避免背景分頁／bfcache 舊文件靠「寫得比較晚」搶走主導權。
    let saveRevision = 0;
    // 這個文件自上次寫入後真的改動過的盤面尺寸，只有它們會被標記成新版本。
    const dirtyStateSizes = new Set();

    let isBoardLocked = false;
    let wakeLockSentinel = null;
    let isWakeLockEnabled = false;

    const SAVE_KEY = 'nonogram_save_data';
    const ALLOWED_SIZES = [8, 10, 12];
    const DEFAULT_THEME_COLOR = '#FFB7F1';
    const PRIMARY_DARK_TEXT = '#13212F';
    const LIGHT_SURFACE_COLOR = '#FFFFFF';
    const DARK_SURFACE_COLOR = '#0F141C';
    const SHARED_SEED_PREFIX = 'NGM';
    const RESULT_STATE = {
      IN_PROGRESS: 'in-progress',
      WIN: 'win',
      REVEALED: 'revealed',
      COMPLETED: 'completed'
    };
    const MAX_GENERATION_ATTEMPTS = 120;
    const linePatternCache = new Map();

    const levelBtns = document.querySelectorAll('#level-toggle .mode-btn');
    const actionBtns = document.querySelectorAll('#action-toggle .action-btn');
    const actionToggle = document.getElementById('action-toggle');
    const topMsg = document.getElementById('top-msg');
    const boardEl = document.getElementById('board');
    const mainActions = document.getElementById('main-actions');
    const checkBtn = document.getElementById('check-btn');
    const newGameBtn = document.getElementById('new-game-btn');
    const undoBtn = document.getElementById('undo-btn');
    const clearBoardBtn = document.getElementById('clear-board-btn');
    const resultBox = document.getElementById('result-box');
    const resultBtns = document.getElementById('result-btns');
    const confirmOverlay = document.getElementById('confirm-overlay');
    const confirmTitle = document.getElementById('confirm-title');
    const confirmMessage = document.getElementById('confirm-message');
    const confirmCancelBtn = document.getElementById('confirm-cancel-btn');
    const confirmOkBtn = document.getElementById('confirm-ok-btn');
    const menuBtn = document.getElementById('menu-btn');
    const menuPanel = document.getElementById('menu-panel');
    const darkModeToggle = document.getElementById('dark-mode-toggle');
    const paletteBtns = document.querySelectorAll('.palette-swatch');
    const customColorInput = document.getElementById('custom-color-input');
    const currentSeedOutput = document.getElementById('current-seed-output');
    const copySeedBtn = document.getElementById('copy-seed-btn');
    const seedInput = document.getElementById('seed-input');
    const loadSeedBtn = document.getElementById('load-seed-btn');
    const seedFeedback = document.getElementById('seed-feedback');
    const boardLockBtn = document.getElementById('board-lock-btn');
    const wakeLockCheckbox = document.getElementById('wake-lock-checkbox');
    const wakeLockNote = document.getElementById('wake-lock-note');


    function isValidHexColor(value) {
      return /^#[0-9A-F]{6}$/i.test(value || '');
    }

    function normalizeThemeColor(value) {
      return isValidHexColor(value) ? value.toUpperCase() : DEFAULT_THEME_COLOR;
    }

    function hexToRgb(value) {
      const normalized = normalizeThemeColor(value).slice(1);
      return {
        r: parseInt(normalized.slice(0, 2), 16),
        g: parseInt(normalized.slice(2, 4), 16),
        b: parseInt(normalized.slice(4, 6), 16)
      };
    }

    function hexToRgba(value, alpha) {
      const { r, g, b } = hexToRgb(value);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    function toHexChannel(value) {
      return Math.round(value).toString(16).padStart(2, '0').toUpperCase();
    }

    function mixHexColors(start, end, amount) {
      const startRgb = hexToRgb(start);
      const endRgb = hexToRgb(end);
      const ratio = Math.min(1, Math.max(0, amount));
      return `#${toHexChannel(startRgb.r + (endRgb.r - startRgb.r) * ratio)}${toHexChannel(startRgb.g + (endRgb.g - startRgb.g) * ratio)}${toHexChannel(startRgb.b + (endRgb.b - startRgb.b) * ratio)}`;
    }

    function toLinearChannel(channel) {
      const normalized = channel / 255;
      return normalized <= 0.03928
        ? normalized / 12.92
        : Math.pow((normalized + 0.055) / 1.055, 2.4);
    }

    function getRelativeLuminance(value) {
      const { r, g, b } = hexToRgb(value);
      return 0.2126 * toLinearChannel(r) + 0.7152 * toLinearChannel(g) + 0.0722 * toLinearChannel(b);
    }

    function getContrastRatio(foreground, background) {
      const lighter = Math.max(getRelativeLuminance(foreground), getRelativeLuminance(background));
      const darker = Math.min(getRelativeLuminance(foreground), getRelativeLuminance(background));
      return (lighter + 0.05) / (darker + 0.05);
    }

    function getPrimaryContrastColor(value) {
      const { r, g, b } = hexToRgb(value);
      const yiq = (r * 299 + g * 587 + b * 114) / 1000;
      return yiq >= 165 ? PRIMARY_DARK_TEXT : LIGHT_SURFACE_COLOR;
    }

    function getReadableAccentColor(value) {
      if (!darkMode) return value;

      if (getContrastRatio(value, DARK_SURFACE_COLOR) >= 4.5) {
        return value;
      }

      for (let step = 1; step <= 10; step++) {
        const candidate = mixHexColors(value, LIGHT_SURFACE_COLOR, step / 10);
        if (getContrastRatio(candidate, DARK_SURFACE_COLOR) >= 4.5) {
          return candidate;
        }
      }

      return LIGHT_SURFACE_COLOR;
    }

    function updatePaletteSelection() {
      paletteBtns.forEach(btn => {
        btn.classList.toggle('active', normalizeThemeColor(btn.dataset.color) === themeColor);
      });
    }

    function applyThemeColor(nextColor) {
      themeColor = normalizeThemeColor(nextColor);
      const appliedPrimaryColor = getReadableAccentColor(themeColor);
      document.documentElement.style.setProperty('--primary-color', appliedPrimaryColor);
      document.documentElement.style.setProperty('--primary-shadow', hexToRgba(appliedPrimaryColor, darkMode ? 0.28 : 0.4));
      document.documentElement.style.setProperty('--primary-display', appliedPrimaryColor);
      document.documentElement.style.setProperty('--primary-contrast', getPrimaryContrastColor(appliedPrimaryColor));
      customColorInput.value = themeColor.toLowerCase();
      updatePaletteSelection();
    }

    function applyDarkMode(nextMode) {
      darkMode = Boolean(nextMode);
      document.documentElement.dataset.theme = darkMode ? 'dark' : 'light';
      document.documentElement.style.colorScheme = darkMode ? 'dark' : 'light';

      darkModeToggle.classList.toggle('active', darkMode);
      darkModeToggle.setAttribute('aria-checked', String(darkMode));
      const toggleLabel = darkMode ? '切換為淺色模式' : '切換為深色模式';
      darkModeToggle.setAttribute('aria-label', toggleLabel);
      darkModeToggle.title = toggleLabel;

      applyThemeColor(themeColor);
    }

    function closeMenu() {
      menuPanel.classList.add('hidden');
      menuBtn.classList.remove('active');
      menuBtn.setAttribute('aria-expanded', 'false');
    }

    function toggleMenu() {
      const isOpening = menuPanel.classList.contains('hidden');
      menuPanel.classList.toggle('hidden', !isOpening);
      menuBtn.classList.toggle('active', isOpening);
      menuBtn.setAttribute('aria-expanded', String(isOpening));
    }

    function solutionToHex(solution) {
      const bits = solution.flat().join('');
      let hex = '';
      for (let i = 0; i < bits.length; i += 4) {
        hex += parseInt(bits.slice(i, i + 4), 2).toString(16).toUpperCase();
      }
      return hex;
    }

    function encodeShareSeed(solution) {
      return `${SHARED_SEED_PREFIX}-${solution.length}-${solutionToHex(solution)}`;
    }

    function decodeShareSeed(seedText) {
      if (typeof seedText !== 'string') return null;

      const normalized = seedText.trim().toUpperCase();
      const match = normalized.match(/^NGM-(8|10|12)-([0-9A-F]+)$/);
      if (!match) return null;

      const targetSize = parseInt(match[1], 10);
      const hex = match[2];
      const expectedHexLength = (targetSize * targetSize) / 4;
      if (hex.length !== expectedHexLength) return null;

      let bits = '';
      for (const char of hex) {
        bits += parseInt(char, 16).toString(2).padStart(4, '0');
      }

      const solution = [];
      let pointer = 0;
      for (let r = 0; r < targetSize; r++) {
        const rowBits = bits.slice(pointer, pointer + targetSize);
        solution.push(rowBits.split('').map(Number));
        pointer += targetSize;
      }

      const { rowClues, colClues } = buildCluesFromSolution(solution);
      if (countSolutions(rowClues, colClues, 2) !== 1) return null;

      return {
        size: targetSize,
        solution: solution,
        rowClues: rowClues,
        colClues: colClues,
        seed: normalized
      };
    }

    function updateCurrentSeedDisplay() {
      const currentState = gameStates[size];
      currentSeedOutput.value = currentState ? encodeShareSeed(currentState.solution) : '';
    }

    function showSeedFeedback(message, isError = false) {
      seedFeedback.textContent = message;
      seedFeedback.classList.toggle('error', isError);
    }

    function loadSeedFromInput() {
      const decodedSeed = decodeShareSeed(seedInput.value);
      if (!decodedSeed) {
        showSeedFeedback('Seed 格式錯誤，或這個題目不是唯一解。', true);
        return;
      }

      size = decodedSeed.size;
      updateLevelButtons();
      gameStates[size] = {
        solution: decodedSeed.solution,
        playerState: createEmptyPlayerState(size),
        globalRowClues: decodedSeed.rowClues,
        globalColClues: decodedSeed.colClues,
        isGameOver: false,
        resultState: RESULT_STATE.IN_PROGRESS,
        stateRevision: getStateRevision(gameStates[size])
      };
      markStateDirty(size);

      renderBoard();
      resetUI();
      seedInput.value = decodedSeed.seed;
      showSeedFeedback('已載入指定 Seed。');
      saveData();
    }

    async function copyCurrentSeed() {
      const currentSeed = currentSeedOutput.value.trim();
      if (!currentSeed) {
        showSeedFeedback('目前還沒有可分享的 Seed。', true);
        return;
      }

      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(currentSeed);
          showSeedFeedback('Seed 已複製。');
          return;
        }

        currentSeedOutput.focus();
        currentSeedOutput.select();
        const copied = document.execCommand('copy');
        showSeedFeedback(copied ? 'Seed 已複製。' : '無法自動複製，請手動複製。', !copied);
      } catch (error) {
        console.error(error);
        showSeedFeedback('無法自動複製，請手動複製。', true);
      }
    }

    function updateLevelButtons() {
      levelBtns.forEach(b => {
        b.classList.remove('active');
        if (parseInt(b.dataset.size) === size) b.classList.add('active');
      });
    }

    function showGenerationFailure() {
      closeMenu();
      actionToggle.classList.add('hidden');
      topMsg.classList.remove('hidden');
      topMsg.style.color = 'var(--error-color)';
      topMsg.innerText = '題目生成失敗，請再試一次';
      mainActions.classList.remove('hidden');
      resultBox.classList.add('hidden');
    }

    function getStateRevision(state) {
      const revision = Number(state?.stateRevision);
      return Number.isInteger(revision) && revision > 0 ? revision : 0;
    }

    // 標記「這個文件動過某個尺寸的盤面」，寫檔時才會把它升到最新版本號。
    function markStateDirty(targetSize) {
      dirtyStateSizes.add(Number(targetSize));
    }

    function cloneSavedGameState(state) {
      if (!state) return null;
      return {
        solution: cloneGrid(state.solution),
        playerState: cloneGrid(state.playerState),
        globalRowClues: state.globalRowClues.map(line => line.slice()),
        globalColClues: state.globalColClues.map(line => line.slice()),
        isGameOver: Boolean(state.isGameOver),
        resultState: state.resultState || (state.isGameOver ? RESULT_STATE.COMPLETED : RESULT_STATE.IN_PROGRESS),
        stateRevision: getStateRevision(state)
      };
    }

    function getGameStatePriority(state) {
      if (!state) return -1;
      if (state.resultState === RESULT_STATE.WIN) return 3;
      if (state.resultState === RESULT_STATE.REVEALED) return 2;
      if (state.isGameOver || state.resultState === RESULT_STATE.COMPLETED) return 1;
      return 0;
    }

    function resolveGameStateConflict(baseState, incomingState, isIncomingLive = true) {
      if (!baseState) return cloneSavedGameState(incomingState);
      if (!incomingState) return cloneSavedGameState(baseState);

      // 盤面版本號只有在該文件真的動過這個盤面時才會升版，所以版本高的必定是較新的操作。
      // 這是防止背景分頁／bfcache 舊文件用過期資料蓋掉已結算牌局的主要防線，
      // 也讓「開新局／載入 Seed 換題目」自然勝出，不必再靠比對題目是否相同來猜測意圖。
      const baseRevision = getStateRevision(baseState);
      const incomingRevision = getStateRevision(incomingState);
      if (incomingRevision > baseRevision) return cloneSavedGameState(incomingState);
      if (baseRevision > incomingRevision) return cloneSavedGameState(baseState);

      // 版本相同（舊版存檔，或兩份資料同時被修改）才退回結算優先權：已完成的牌局永遠優先。
      const basePriority = getGameStatePriority(baseState);
      const incomingPriority = getGameStatePriority(incomingState);
      if (basePriority > incomingPriority) return cloneSavedGameState(baseState);
      if (incomingPriority > basePriority) return cloneSavedGameState(incomingState);

      // 完全平手時，信任「目前正在操作的那一份」。
      return cloneSavedGameState(isIncomingLive ? incomingState : baseState);
    }

    function normalizeActionHistory(history, targetSize) {
      if (!Array.isArray(history)) return [];
      return history
        .filter(snapshot => isValidMatrix(snapshot, targetSize, value => value === 0 || value === 1 || value === 2))
        .map(snapshot => cloneGrid(snapshot));
    }

    function createRuntimeSnapshot() {
      const snapshotStates = {};

      ALLOWED_SIZES.forEach(allowedSize => {
        const validatedState = validateSavedGameState(gameStates[allowedSize], allowedSize);
        if (validatedState) snapshotStates[allowedSize] = validatedState;
      });

      const availableSizes = Object.keys(snapshotStates).map(Number);
      if (!availableSizes.length) return null;

      const snapshotSize = ALLOWED_SIZES.includes(size) && snapshotStates[size]
        ? size
        : availableSizes[0];

      return {
        size: snapshotSize,
        themeColor: normalizeThemeColor(themeColor),
        darkMode: Boolean(darkMode),
        isBoardLocked: Boolean(isBoardLocked),
        isWakeLockEnabled: Boolean(isWakeLockEnabled),
        gameStates: snapshotStates,
        actionHistory: normalizeActionHistory(actionHistory, snapshotSize),
        revision: Math.max(0, saveRevision || 0),
        savedAt: Math.max(0, lastSavedAt || 0)
      };
    }

    // options.liveSide 指出哪一邊是「目前這個文件正在操作的資料」：
    //   'incoming' → 寫檔（base = localStorage、incoming = 本文件執行中的狀態）
    //   'base'     → 讀檔同步（base = 本文件執行中的狀態、incoming = localStorage）
    // 關卡選擇與個人化設定屬於這個文件本身，必須跟著 live 那一側，
    // 否則其他分頁的舊存檔會把正在結算的頁面拉到別的關卡。
    function mergeSavedData(baseData, incomingData, options = {}) {
      if (!baseData && !incomingData) return null;

      const isBaseLive = options.liveSide === 'base';
      const liveData = isBaseLive ? baseData : incomingData;
      const staleData = isBaseLive ? incomingData : baseData;

      const mergedStates = {};
      ALLOWED_SIZES.forEach(allowedSize => {
        const resolvedState = resolveGameStateConflict(
          baseData?.gameStates?.[allowedSize],
          incomingData?.gameStates?.[allowedSize],
          !isBaseLive
        );
        if (resolvedState) mergedStates[allowedSize] = resolvedState;
      });

      const availableSizes = Object.keys(mergedStates).map(Number);
      if (!availableSizes.length) return null;

      const liveSize = Number(liveData?.size);
      const staleSize = Number(staleData?.size);
      const mergedSize = Number.isInteger(liveSize) && mergedStates[liveSize]
        ? liveSize
        : (Number.isInteger(staleSize) && mergedStates[staleSize] ? staleSize : availableSizes[0]);

      const liveHistory = normalizeActionHistory(liveData?.actionHistory, mergedSize);
      const staleHistory = normalizeActionHistory(staleData?.actionHistory, mergedSize);

      return {
        size: mergedSize,
        themeColor: normalizeThemeColor(liveData?.themeColor ?? staleData?.themeColor),
        darkMode: Boolean((typeof liveData?.darkMode === 'boolean') ? liveData.darkMode : staleData?.darkMode),
        isBoardLocked: Boolean((typeof liveData?.isBoardLocked === 'boolean') ? liveData.isBoardLocked : staleData?.isBoardLocked),
        isWakeLockEnabled: Boolean((typeof liveData?.isWakeLockEnabled === 'boolean') ? liveData.isWakeLockEnabled : staleData?.isWakeLockEnabled),
        gameStates: mergedStates,
        actionHistory: liveHistory.length ? liveHistory : staleHistory,
        revision: Math.max(Number(baseData?.revision) || 0, Number(incomingData?.revision) || 0),
        savedAt: Math.max(Number(baseData?.savedAt) || 0, Number(incomingData?.savedAt) || 0)
      };
    }

    function areSavedStatesEquivalent(leftState, rightState) {
      if (!leftState || !rightState) return false;
      if (leftState.isGameOver !== rightState.isGameOver) return false;
      if (leftState.resultState !== rightState.resultState) return false;

      return JSON.stringify(leftState.solution) === JSON.stringify(rightState.solution) &&
        JSON.stringify(leftState.playerState) === JSON.stringify(rightState.playerState) &&
        JSON.stringify(leftState.globalRowClues) === JSON.stringify(rightState.globalRowClues) &&
        JSON.stringify(leftState.globalColClues) === JSON.stringify(rightState.globalColClues);
    }

    function hasGameStateDifference(leftData, rightData) {
      if (!leftData || !rightData) return false;

      for (const allowedSize of ALLOWED_SIZES) {
        const leftState = leftData.gameStates?.[allowedSize];
        const rightState = rightData.gameStates?.[allowedSize];

        if (leftState && rightState && !areSavedStatesEquivalent(leftState, rightState)) {
          return true;
        }
      }

      return false;
    }

    // --- 本地儲存資料功能 (Local Storage) ---
    function saveData() {
      const runtimeSnapshot = createRuntimeSnapshot();
      if (!runtimeSnapshot) return;

      // 寫入前先重讀並合併（read-merge-write），否則背景分頁／bfcache 舊文件
      // 被瀏覽器回收時觸發的 pagehide 存檔，會整包蓋掉別處剛完成的結算。
      const storedData = readSavedData();
      const revision = Math.max(saveRevision, storedData?.revision || 0) + 1;

      dirtyStateSizes.forEach(dirtySize => {
        const dirtyState = runtimeSnapshot.gameStates[dirtySize];
        if (dirtyState) dirtyState.stateRevision = revision;
      });

      const mergedSnapshot = mergeSavedData(storedData, runtimeSnapshot, { liveSide: 'incoming' }) || runtimeSnapshot;
      mergedSnapshot.revision = revision;
      mergedSnapshot.savedAt = Date.now();

      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(mergedSnapshot));
      } catch (e) {
        console.warn('Unable to save Nonogram state to localStorage', e);
        return;
      }

      saveRevision = revision;
      lastSavedAt = mergedSnapshot.savedAt;
      dirtyStateSizes.forEach(dirtySize => {
        if (gameStates[dirtySize]) gameStates[dirtySize].stateRevision = revision;
      });
      dirtyStateSizes.clear();

      // 合併時若採用了其他分頁較新的資料，立即套回畫面，避免記憶體與存檔長期不一致。
      if (hasGameStateDifference(runtimeSnapshot, mergedSnapshot)) {
        applySavedData(mergedSnapshot, false);
        renderBoard();
        if (!gameStates[size] || !gameStates[size].isGameOver) resetUI();
      }
    }

    function applySavedData(validatedData, shouldPersist = false) {
      size = validatedData.size;
      themeColor = validatedData.themeColor;
      darkMode = validatedData.darkMode;
      gameStates = validatedData.gameStates;
      actionHistory = validatedData.actionHistory || [];
      saveRevision = Math.max(saveRevision, validatedData.revision || 0);
      lastSavedAt = Math.max(lastSavedAt, validatedData.savedAt || 0);

      applyDarkMode(darkMode);
      updateLevelButtons();

      if (typeof validatedData.isBoardLocked === 'boolean') {
        setBoardLockState(validatedData.isBoardLocked);
      }
      if (typeof validatedData.isWakeLockEnabled === 'boolean') {
        handleWakeLockChange(validatedData.isWakeLockEnabled, false);
      }

      if (shouldPersist) saveData();
    }

    function readSavedData() {
      const data = localStorage.getItem(SAVE_KEY);
      if (!data) return null;

      try {
        const parsed = JSON.parse(data);
        const validatedData = validateSavedData(parsed);
        if (!validatedData) {
          localStorage.removeItem(SAVE_KEY);
          return null;
        }

        return validatedData;
      } catch (e) {
        console.error('localStorage parsing error', e);
        localStorage.removeItem(SAVE_KEY);
        return null;
      }
    }

    function loadData() {
      const validatedData = readSavedData();
      if (!validatedData) return false;

      applySavedData(validatedData, true);
      return true;
    }

    function syncStateFromStorage() {
      const storedData = readSavedData();
      // 用版本號而非時間戳判斷新舊：舊文件寫得再晚，版本號也不會超前。
      if (!storedData || (storedData.revision || 0) <= saveRevision) return false;

      const runtimeSnapshot = createRuntimeSnapshot();
      const resolvedData = mergeSavedData(runtimeSnapshot, storedData, { liveSide: 'base' });
      if (!resolvedData) return false;

      const shouldPersistResolved = hasGameStateDifference(storedData, resolvedData);
      resolvedData.revision = Math.max(Number(storedData.revision) || 0, Number(runtimeSnapshot?.revision) || 0);
      resolvedData.savedAt = Math.max(Number(storedData.savedAt) || 0, Number(runtimeSnapshot?.savedAt) || 0);

      applySavedData(resolvedData, shouldPersistResolved);
      renderBoard();

      if (!gameStates[size] || !gameStates[size].isGameOver) {
        resetUI();
      }

      return true;
    }

    function persistCurrentState() {
      if (!Object.keys(gameStates).length) return;

      if (isDragging) {
        handlePointerUp();
        return;
      }

      saveData();
    }

    // --- 綁定事件 (Event Listeners) ---
    levelBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        levelBtns.forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        let newSize = parseInt(e.currentTarget.dataset.size);
        loadLevel(newSize);
      });
    });

    actionBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        actionBtns.forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        currentAction = e.currentTarget.dataset.action;
      });
    });

    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMenu();
    });

    menuPanel.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    paletteBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        applyThemeColor(e.currentTarget.dataset.color);
        showSeedFeedback('顏色已更新。');
        saveData();
      });
    });

    customColorInput.addEventListener('input', (e) => {
      applyThemeColor(e.target.value);
      showSeedFeedback('顏色已更新。');
      saveData();
    });

    darkModeToggle.addEventListener('click', () => {
      applyDarkMode(!darkMode);
      saveData();
    });

    copySeedBtn.addEventListener('click', copyCurrentSeed);
    loadSeedBtn.addEventListener('click', loadSeedFromInput);
    seedInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') loadSeedFromInput();
    });

    checkBtn.addEventListener('click', checkAnswer);
    newGameBtn.addEventListener('click', () => { confirmStartNewGame(size); });
    undoBtn.addEventListener('click', undoLastAction);
    clearBoardBtn.addEventListener('click', clearBoard);

    boardLockBtn.addEventListener('click', toggleBoardLock);
    wakeLockCheckbox.addEventListener('change', (e) => {
      handleWakeLockChange(e.target.checked);
    });

    document.addEventListener('click', () => {
      closeMenu();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });

    // 盤面互動一律走事件委派：這四個監聽器取代原本每格各掛四個的做法，
    // 盤面重繪時也不必重新掛載
    boardEl.addEventListener('mousedown', handlePointerDown);
    boardEl.addEventListener('mouseover', handlePointerEnter);
    boardEl.addEventListener('touchstart', handlePointerDown, { passive: false });
    boardEl.addEventListener('touchmove', handleTouchMove, { passive: false });

    document.addEventListener('mouseup', handlePointerUp);
    document.addEventListener('touchend', handlePointerUp);
    document.addEventListener('touchcancel', handlePointerUp);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        persistCurrentState();
        return;
      }

      if (isWakeLockEnabled && !wakeLockSentinel) {
        requestWakeLock();
      }

      syncStateFromStorage();
    });

    window.addEventListener('pagehide', persistCurrentState);
    window.addEventListener('pageshow', syncStateFromStorage);
    window.addEventListener('focus', syncStateFromStorage);
    window.addEventListener('storage', (event) => {
      if (event.key === SAVE_KEY) syncStateFromStorage();
    });

    // --- 盤面鎖定與螢幕防休眠 (Board Lock & Wake Lock) ---
    function setBoardLockState(locked) {
      isBoardLocked = Boolean(locked);
      boardLockBtn.classList.toggle('locked', isBoardLocked);
      boardLockBtn.setAttribute('aria-label', isBoardLocked ? '解鎖盤面' : '鎖定盤面 (防誤觸)');
      boardLockBtn.title = isBoardLocked ? '解鎖盤面' : '鎖定盤面 (防誤觸)';
      boardEl.classList.toggle('board-locked', isBoardLocked);
      if (isBoardLocked && isDragging) {
        handlePointerUp();
      }
    }

    function toggleBoardLock() {
      setBoardLockState(!isBoardLocked);
      saveData();
    }

    async function requestWakeLock() {
      if (!('wakeLock' in navigator)) {
        wakeLockNote.textContent = '此瀏覽器不支援螢幕防休眠功能。';
        wakeLockNote.style.color = 'var(--error-color)';
        return false;
      }
      try {
        wakeLockSentinel = await navigator.wakeLock.request('screen');
        wakeLockSentinel.addEventListener('release', () => {
          wakeLockSentinel = null;
        });
        wakeLockNote.textContent = '已啟用螢幕常亮防休眠。';
        wakeLockNote.style.color = 'var(--text-muted)';
        return true;
      } catch (err) {
        console.warn('Wake Lock error:', err);
        wakeLockNote.textContent = '無法取得螢幕鎖，可能處於省電模式。';
        wakeLockNote.style.color = 'var(--error-color)';
        return false;
      }
    }

    async function releaseWakeLock() {
      if (wakeLockSentinel) {
        try {
          await wakeLockSentinel.release();
        } catch (err) {
          console.warn('Release Wake Lock error:', err);
        }
        wakeLockSentinel = null;
      }
      wakeLockNote.textContent = '防止遊戲進行期間螢幕自動變暗或休眠熄屏。';
      wakeLockNote.style.color = 'var(--text-muted)';
    }

    async function handleWakeLockChange(enabled, shouldSave = true) {
      isWakeLockEnabled = Boolean(enabled);
      wakeLockCheckbox.checked = isWakeLockEnabled;
      if (isWakeLockEnabled) {
        await requestWakeLock();
      } else {
        await releaseWakeLock();
      }
      if (shouldSave) saveData();
    }

    // --- 核心邏輯 (Core Logic) ---
    function getClues(arr) {
      let clues = [], count = 0;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] === 1) count++;
        else if (count > 0) { clues.push(count); count = 0; }
      }
      if (count > 0) clues.push(count);
      return clues.length > 0 ? clues : [0];
    }

    function cloneGrid(grid) {
      return grid.map(row => row.slice());
    }

    function createEmptyPlayerState(targetSize) {
      return Array.from({ length: targetSize }, () => new Array(targetSize).fill(0));
    }

    function buildCluesFromSolution(solution) {
      const targetSize = solution.length;
      const rowClues = solution.map(getClues);
      const colClues = [];

      for (let c = 0; c < targetSize; c++) {
        const col = [];
        for (let r = 0; r < targetSize; r++) col.push(solution[r][c]);
        colClues.push(getClues(col));
      }

      return { rowClues, colClues };
    }

    function createRandomSolution(targetSize) {
      const solution = [];

      for (let r = 0; r < targetSize; r++) {
        const row = [];
        for (let c = 0; c < targetSize; c++) {
          row.push(Math.random() > 0.45 ? 1 : 0);
        }
        solution.push(row);
      }

      return solution;
    }

    function generateLinePatterns(length, clues) {
      if (clues.length === 1 && clues[0] === 0) {
        return [new Array(length).fill(0)];
      }

      const patterns = [];

      function backtrack(clueIndex, position, line) {
        if (clueIndex === clues.length) {
          patterns.push(line.concat(new Array(length - line.length).fill(0)));
          return;
        }

        const blockLength = clues[clueIndex];
        const remainingBlocks = clues.slice(clueIndex + 1);
        const remainingMin = remainingBlocks.reduce((sum, value) => sum + value, 0) + remainingBlocks.length;
        const maxStart = length - blockLength - remainingMin;

        for (let start = position; start <= maxStart; start++) {
          const nextLine = line.slice();
          while (nextLine.length < start) nextLine.push(0);
          for (let i = 0; i < blockLength; i++) nextLine.push(1);
          if (clueIndex < clues.length - 1) nextLine.push(0);
          backtrack(clueIndex + 1, nextLine.length, nextLine);
        }
      }

      backtrack(0, 0, []);
      return patterns;
    }

    function getLinePatterns(length, clues) {
      const cacheKey = `${length}:${clues.join('-')}`;
      if (!linePatternCache.has(cacheKey)) {
        linePatternCache.set(cacheKey, generateLinePatterns(length, clues));
      }
      return linePatternCache.get(cacheKey);
    }

    function getForcedLineValue(patterns, index) {
      const firstValue = patterns[0][index];
      for (let i = 1; i < patterns.length; i++) {
        if (patterns[i][index] !== firstValue) return -1;
      }
      return firstValue;
    }

    function cloneDomains(domains) {
      return domains.map(domain => domain.slice());
    }

    function propagateConstraints(board, rowDomains, colDomains) {
      const targetSize = board.length;
      let changed = true;

      while (changed) {
        changed = false;

        for (let r = 0; r < targetSize; r++) {
          const filteredRowPatterns = rowDomains[r].filter(pattern => {
            for (let c = 0; c < targetSize; c++) {
              if (board[r][c] !== -1 && board[r][c] !== pattern[c]) return false;
            }
            return true;
          });

          if (!filteredRowPatterns.length) return false;
          if (filteredRowPatterns.length !== rowDomains[r].length) {
            rowDomains[r] = filteredRowPatterns;
            changed = true;
          }

          for (let c = 0; c < targetSize; c++) {
            const forcedValue = getForcedLineValue(rowDomains[r], c);
            if (forcedValue === -1) continue;
            if (board[r][c] === -1) {
              board[r][c] = forcedValue;
              changed = true;
            } else if (board[r][c] !== forcedValue) {
              return false;
            }
          }
        }

        for (let c = 0; c < targetSize; c++) {
          const filteredColPatterns = colDomains[c].filter(pattern => {
            for (let r = 0; r < targetSize; r++) {
              if (board[r][c] !== -1 && board[r][c] !== pattern[r]) return false;
            }
            return true;
          });

          if (!filteredColPatterns.length) return false;
          if (filteredColPatterns.length !== colDomains[c].length) {
            colDomains[c] = filteredColPatterns;
            changed = true;
          }

          for (let r = 0; r < targetSize; r++) {
            const forcedValue = getForcedLineValue(colDomains[c], r);
            if (forcedValue === -1) continue;
            if (board[r][c] === -1) {
              board[r][c] = forcedValue;
              changed = true;
            } else if (board[r][c] !== forcedValue) {
              return false;
            }
          }
        }
      }

      return true;
    }

    function isBoardSolved(board) {
      return board.every(row => row.every(cell => cell !== -1));
    }

    function searchSolutions(board, rowDomains, colDomains, limit, counter) {
      if (counter.count >= limit) return;
      if (!propagateConstraints(board, rowDomains, colDomains)) return;

      if (isBoardSolved(board)) {
        counter.count++;
        return;
      }

      let branch = null;

      for (let r = 0; r < rowDomains.length; r++) {
        if (rowDomains[r].length > 1 && (!branch || rowDomains[r].length < branch.domainSize)) {
          branch = { type: 'row', index: r, domainSize: rowDomains[r].length };
        }
      }

      for (let c = 0; c < colDomains.length; c++) {
        if (colDomains[c].length > 1 && (!branch || colDomains[c].length < branch.domainSize)) {
          branch = { type: 'col', index: c, domainSize: colDomains[c].length };
        }
      }

      if (!branch) return;

      const patterns = branch.type === 'row' ? rowDomains[branch.index] : colDomains[branch.index];

      for (const pattern of patterns) {
        if (counter.count >= limit) return;

        const nextBoard = cloneGrid(board);
        const nextRowDomains = cloneDomains(rowDomains);
        const nextColDomains = cloneDomains(colDomains);

        if (branch.type === 'row') {
          nextRowDomains[branch.index] = [pattern];
          for (let c = 0; c < pattern.length; c++) {
            if (nextBoard[branch.index][c] !== -1 && nextBoard[branch.index][c] !== pattern[c]) {
              return;
            }
            nextBoard[branch.index][c] = pattern[c];
          }
        } else {
          nextColDomains[branch.index] = [pattern];
          for (let r = 0; r < pattern.length; r++) {
            if (nextBoard[r][branch.index] !== -1 && nextBoard[r][branch.index] !== pattern[r]) {
              return;
            }
            nextBoard[r][branch.index] = pattern[r];
          }
        }

        searchSolutions(nextBoard, nextRowDomains, nextColDomains, limit, counter);
      }
    }

    function countSolutions(rowClues, colClues, limit = 2) {
      const targetSize = rowClues.length;
      const board = Array.from({ length: targetSize }, () => new Array(targetSize).fill(-1));
      const rowDomains = rowClues.map(clues => getLinePatterns(targetSize, clues));
      const colDomains = colClues.map(clues => getLinePatterns(targetSize, clues));
      const counter = { count: 0 };

      searchSolutions(board, rowDomains, colDomains, limit, counter);
      return counter.count;
    }

    function generateUniquePuzzle(targetSize) {
      for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
        const solution = createRandomSolution(targetSize);
        const { rowClues, colClues } = buildCluesFromSolution(solution);

        if (countSolutions(rowClues, colClues, 2) === 1) {
          return { solution, rowClues, colClues };
        }
      }

      throw new Error(`Unable to generate a unique ${targetSize}x${targetSize} puzzle.`);
    }

    function areClueLinesEqual(left, right) {
      return left.length === right.length && left.every((value, index) => value === right[index]);
    }

    function isValidMatrix(matrix, targetSize, isValidCell) {
      return Array.isArray(matrix) &&
        matrix.length === targetSize &&
        matrix.every(row => Array.isArray(row) && row.length === targetSize && row.every(isValidCell));
    }

    function isValidClueSet(clues, targetSize) {
      return Array.isArray(clues) &&
        clues.length === targetSize &&
        clues.every(line => Array.isArray(line) && line.length > 0 && line.every(value => Number.isInteger(value) && value >= 0));
    }

    function validateSavedGameState(savedState, targetSize) {
      if (!savedState || typeof savedState !== 'object') return null;
      if (!isValidMatrix(savedState.solution, targetSize, value => value === 0 || value === 1)) return null;
      if (!isValidMatrix(savedState.playerState, targetSize, value => value === 0 || value === 1 || value === 2)) return null;
      if (!isValidClueSet(savedState.globalRowClues, targetSize)) return null;
      if (!isValidClueSet(savedState.globalColClues, targetSize)) return null;

      const derivedClues = buildCluesFromSolution(savedState.solution);
      const isClueMismatch = derivedClues.rowClues.some((clues, index) => !areClueLinesEqual(clues, savedState.globalRowClues[index])) ||
        derivedClues.colClues.some((clues, index) => !areClueLinesEqual(clues, savedState.globalColClues[index]));

      if (isClueMismatch) return null;

      const isGameOver = Boolean(savedState.isGameOver);
      const resultState = isGameOver && (savedState.resultState === RESULT_STATE.WIN || savedState.resultState === RESULT_STATE.REVEALED)
        ? savedState.resultState
        : (isGameOver ? RESULT_STATE.COMPLETED : RESULT_STATE.IN_PROGRESS);

      return {
        solution: cloneGrid(savedState.solution),
        playerState: cloneGrid(savedState.playerState),
        globalRowClues: savedState.globalRowClues.map(line => line.slice()),
        globalColClues: savedState.globalColClues.map(line => line.slice()),
        isGameOver: isGameOver,
        resultState: resultState,
        stateRevision: getStateRevision(savedState)
      };
    }

    function validateSavedData(parsed) {
      if (!parsed || typeof parsed !== 'object' || !parsed.gameStates || typeof parsed.gameStates !== 'object') {
        return null;
      }

      const validatedStates = {};

      ALLOWED_SIZES.forEach(allowedSize => {
        const validatedState = validateSavedGameState(parsed.gameStates[allowedSize], allowedSize);
        if (validatedState) validatedStates[allowedSize] = validatedState;
      });

      const availableSizes = Object.keys(validatedStates).map(Number);
      if (!availableSizes.length) return null;

      const validatedSize = ALLOWED_SIZES.includes(parsed.size) && validatedStates[parsed.size]
        ? parsed.size
        : availableSizes[0];

      const validHistory = Array.isArray(parsed.actionHistory)
        ? parsed.actionHistory.filter(snapshot => isValidMatrix(snapshot, validatedSize, value => value === 0 || value === 1 || value === 2))
        : [];

      return {
        size: validatedSize,
        themeColor: normalizeThemeColor(parsed.themeColor),
        darkMode: Boolean(parsed.darkMode),
        isBoardLocked: Boolean(parsed.isBoardLocked),
        isWakeLockEnabled: Boolean(parsed.isWakeLockEnabled),
        gameStates: validatedStates,
        actionHistory: validHistory.map(snapshot => cloneGrid(snapshot)),
        revision: Number.isInteger(parsed.revision) && parsed.revision > 0 ? parsed.revision : 0,
        savedAt: Number.isFinite(parsed.savedAt) && parsed.savedAt > 0 ? parsed.savedAt : 0
      };
    }

    function initGameData(targetSize) {
      const { solution, rowClues, colClues } = generateUniquePuzzle(targetSize);

      gameStates[targetSize] = {
        solution: solution,
        playerState: createEmptyPlayerState(targetSize),
        globalRowClues: rowClues,
        globalColClues: colClues,
        isGameOver: false
        , resultState: RESULT_STATE.IN_PROGRESS
        , stateRevision: getStateRevision(gameStates[targetSize])
      };
      markStateDirty(targetSize);
      saveData();
    }

    function loadLevel(newSize) {
      const previousSize = size;
      size = newSize;

      if (!gameStates[size]) {
        try {
          initGameData(size);
        } catch (error) {
          console.error(error);
          size = previousSize;
          updateLevelButtons();
          showGenerationFailure();
          return;
        }
      }

      renderBoard();
      resetUI();
      saveData();
    }

    function createNewGameButton() {
      const ngBtn = document.createElement('button');
      ngBtn.className = 'primary-btn';
      ngBtn.type = 'button';
      ngBtn.setAttribute('aria-label', '新的一局');
      ngBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-3-6.7"></path>
          <path d="M21 3v6h-6"></path>
        </svg>`;
      ngBtn.onclick = () => confirmStartNewGame(size);
      return ngBtn;
    }

    function renderFinishedUI(state) {
      actionToggle.classList.add('hidden');
      topMsg.classList.remove('hidden');
      mainActions.classList.add('hidden');
      resultBox.classList.remove('hidden');
      resultBtns.innerHTML = '';
      resultBtns.appendChild(createNewGameButton());

      if (state.resultState === RESULT_STATE.WIN) {
        topMsg.style.color = 'var(--primary-display)';
        topMsg.innerText = '答對了！';
        return;
      }

      topMsg.style.color = 'var(--text-secondary)';
      topMsg.innerText = state.resultState === RESULT_STATE.REVEALED ? '答案已顯示' : '本局已結束';
    }

    function isPlayerSolutionCorrect(state) {
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          const isFilled = state.playerState[r][c] === 1;
          const shouldFill = state.solution[r][c] === 1;
          if (isFilled !== shouldFill) return false;
        }
      }
      return true;
    }

    function isBoardEmpty(playerState) {
      return playerState.every(row => row.every(cell => cell === 0));
    }

    function updateClearBoardButtonState() {
      const state = gameStates[size];
      const isEmpty = state ? isBoardEmpty(state.playerState) : true;
      const shouldDisable = !state || state.isGameOver || isEmpty;
      clearBoardBtn.disabled = shouldDisable;
      clearBoardBtn.setAttribute('aria-disabled', String(shouldDisable));
    }

    function updateUndoButtonState() {
      const shouldDisable = !actionHistory.length || !gameStates[size] || gameStates[size].isGameOver;
      undoBtn.disabled = shouldDisable;
      undoBtn.setAttribute('aria-disabled', String(shouldDisable));
    }

    function doesPlayerLineMatchClues(lineValues, targetClues) {
      const filledLine = lineValues.map(value => value === 1 ? 1 : 0);
      return areClueLinesEqual(getClues(filledLine), targetClues);
    }

    function isRowCompleted(state, rowIndex) {
      return doesPlayerLineMatchClues(state.playerState[rowIndex], state.globalRowClues[rowIndex]);
    }

    function isColumnCompleted(state, colIndex) {
      const columnValues = state.playerState.map(row => row[colIndex]);
      return doesPlayerLineMatchClues(columnValues, state.globalColClues[colIndex]);
    }

    function updateCompletedClueStatus(state) {
      const rowClues = boardEl.querySelectorAll('.clue-cell');
      const clueCells = Array.from(rowClues);

      for (let r = 0; r < size; r++) {
        const clueCell = clueCells[r + size + 1];
        if (clueCell) {
          clueCell.classList.toggle('completed', isRowCompleted(state, r));
        }
      }

      for (let c = 0; c < size; c++) {
        const clueCell = clueCells[c + 1];
        if (clueCell) {
          clueCell.classList.toggle('completed', isColumnCompleted(state, c));
        }
      }
    }

    // 依格子數值套用外觀。單格更新與整盤重建共用同一套規則
    function paintCell(cell, value) {
      if (!cell) return;
      cell.classList.remove('error-wrong', 'error-miss');
      cell.classList.toggle('filled', value === 1);
      cell.classList.toggle('marked', value === 2);
    }

    // cellEls[r][c] → 該格的 DOM 節點，讓單格更新不必每次查詢 DOM
    let cellEls = [];

    function renderBoard() {
      let state = gameStates[size];
      boardEl.style.gridTemplateColumns = `max-content repeat(${size}, minmax(0, 1fr))`;
      boardEl.innerHTML = '';
      cellEls = Array.from({ length: size }, () => new Array(size));

      const emptyCorner = document.createElement('div');
      emptyCorner.className = 'clue-cell';
      boardEl.appendChild(emptyCorner);

      for (let c = 0; c < size; c++) {
        const el = document.createElement('div');
        el.className = 'clue-cell';
        el.innerHTML = state.globalColClues[c].map(n => `<span>${n}</span>`).join('');
        boardEl.appendChild(el);
      }

      for (let r = 0; r < size; r++) {
        const rClue = document.createElement('div');
        rClue.className = 'clue-cell';
        rClue.style.flexDirection = 'row';
        rClue.style.gap = '4px';
        rClue.style.padding = '0 8px';
        rClue.innerHTML = state.globalRowClues[r].map(n => `<span>${n}</span>`).join('');
        boardEl.appendChild(rClue);

        for (let c = 0; c < size; c++) {
          const cell = document.createElement('div');
          cell.className = 'cell';
          cell.dataset.r = r;
          cell.dataset.c = c;

          paintCell(cell, state.playerState[r][c]);
          cellEls[r][c] = cell;

          // 互動事件統一委派給 boardEl，這裡不逐格掛載
          boardEl.appendChild(cell);
        }
      }

      updateCompletedClueStatus(state);

      if (state.isGameOver) {
        renderFinishedUI(state);
      }

      updateCurrentSeedDisplay();
      updateClearBoardButtonState();
      updateUndoButtonState();
    }

    function startNewGame(targetSize) {
      actionHistory = [];
      try {
        initGameData(targetSize);
      } catch (error) {
        console.error(error);
        showGenerationFailure();
        return;
      }

      renderBoard();
      resetUI();
      saveData();
    }

    async function confirmStartNewGame(targetSize) {
      const state = gameStates[targetSize];
      if (state && state.isGameOver) {
        startNewGame(targetSize);
        return;
      }

      const confirmed = await showConfirmDialog('新的一局', '確定要開始新的一局嗎？目前進度會遺失。', '開始新局');
      if (confirmed) {
        startNewGame(targetSize);
      }
    }

    function showConfirmDialog(title, message, confirmLabel) {
      return new Promise(resolve => {
        confirmTitle.textContent = title;
        confirmMessage.textContent = message;
        confirmOkBtn.textContent = confirmLabel;
        confirmOverlay.classList.remove('hidden');
        confirmOverlay.setAttribute('aria-hidden', 'false');

        const finish = (result) => {
          confirmOverlay.classList.add('hidden');
          confirmOverlay.setAttribute('aria-hidden', 'true');
          confirmCancelBtn.onclick = null;
          confirmOkBtn.onclick = null;
          resolve(result);
        };

        confirmCancelBtn.onclick = () => finish(false);
        confirmOkBtn.onclick = () => finish(true);
      });
    }

    function undoLastAction() {
      const state = gameStates[size];
      if (!state || state.isGameOver || !actionHistory.length) return;

      const previous = state.playerState;
      const restored = actionHistory.pop();
      state.playerState = restored;
      state.resultState = RESULT_STATE.IN_PROGRESS;
      markStateDirty(size);

      // 只更新真正改變的格子，不重建整個盤面。
      // 盤面結構若還沒建立（例如剛切換尺寸）才退回完整重繪
      const canPatch = cellEls.length === size && restored.length === size;
      if (canPatch) {
        for (let r = 0; r < size; r++) {
          for (let c = 0; c < size; c++) {
            if (previous[r][c] !== restored[r][c]) {
              paintCell(cellEls[r][c], restored[r][c]);
            }
          }
        }
        updateCompletedClueStatus(state);
        updateClearBoardButtonState();
      } else {
        renderBoard();
      }

      resetUI();
      saveData();
      updateUndoButtonState();
    }

    async function clearBoard() {
      const state = gameStates[size];
      if (!state || state.isGameOver) return;

      const confirmed = await showConfirmDialog('清空盤面', '確定要清空整個盤面嗎？這會移除目前所有塗黑與標記。', '確認清空');
      if (!confirmed) return;

      actionHistory.push(cloneGrid(state.playerState));
      state.playerState = createEmptyPlayerState(size);
      state.resultState = RESULT_STATE.IN_PROGRESS;
      markStateDirty(size);
      renderBoard();
      resetUI();
      saveData();
    }

    function handlePointerDown(e) {
      if (isBoardLocked || gameStates[size].isGameOver) return;
      if (e.type === 'touchstart') e.preventDefault();

      const cell = e.target.closest('.cell');
      if (!cell) return;

      isDragging = true;
      lastHoveredCell = cell;
      dragSnapshot = cloneGrid(gameStates[size].playerState);
      dragHistoryCommitted = false;
      const r = cell.dataset.r;
      const c = cell.dataset.c;
      const currentState = gameStates[size].playerState[r][c];

      if (currentAction === 'fill') {
        dragAction = (currentState === 1) ? 'unfill' : 'fill';
      } else {
        dragAction = (currentState === 2) ? 'unmark' : 'mark';
      }

      applyAction(cell, r, c);
    }

    // 註：使用會冒泡的 mouseover 以便委派（mouseenter 不冒泡）。
    // 在同一格內移動會重複觸發，因此記住上一格避免多餘工作
    let lastHoveredCell = null;

    function handlePointerEnter(e) {
      if (isBoardLocked || !isDragging || gameStates[size].isGameOver) return;
      const cell = e.target.closest('.cell');
      if (!cell || cell === lastHoveredCell) return;
      lastHoveredCell = cell;
      applyAction(cell, cell.dataset.r, cell.dataset.c);
    }

    function handleTouchMove(e) {
      if (isBoardLocked || !isDragging || gameStates[size].isGameOver) return;
      e.preventDefault();

      const touch = e.touches[0];
      const targetElement = document.elementFromPoint(touch.clientX, touch.clientY);

      if (targetElement && targetElement.classList.contains('cell')) {
        applyAction(targetElement, targetElement.dataset.r, targetElement.dataset.c);
      }
    }

    function handlePointerUp() {
      lastHoveredCell = null;
      if (isDragging) {
        isDragging = false;
        dragAction = null;
        dragSnapshot = null;
        dragHistoryCommitted = false;
        saveData(); // 拖曳結束後存檔
      }
    }

    function applyAction(cell, r, c) {
      let state = gameStates[size];
      const currentValue = state.playerState[r][c];
      cell.classList.remove('error-wrong', 'error-miss');

      let nextValue = currentValue;
      if (dragAction === 'fill') {
        nextValue = 1;
        cell.classList.add('filled');
        cell.classList.remove('marked');
      } else if (dragAction === 'unfill') {
        nextValue = 0;
        cell.classList.remove('filled');
      } else if (dragAction === 'mark') {
        nextValue = 2;
        cell.classList.add('marked');
        cell.classList.remove('filled');
      } else if (dragAction === 'unmark') {
        nextValue = 0;
        cell.classList.remove('marked');
      }

      // 數值沒變就不必重掃線索與重算按鈕狀態（掃描是 O(size²)）
      if (currentValue === nextValue) return;

      if (!dragHistoryCommitted && dragSnapshot) {
        actionHistory.push(dragSnapshot);
        dragHistoryCommitted = true;
      }
      state.playerState[r][c] = nextValue;
      markStateDirty(size);

      updateCompletedClueStatus(state);
      updateClearBoardButtonState();
      updateUndoButtonState();
    }

    function checkAnswer() {
      let state = gameStates[size];
      if (state.isGameOver) return;
      showResult(isPlayerSolutionCorrect(state));
    }

    function showResult(isWin) {
      mainActions.classList.add('hidden');
      resultBox.classList.remove('hidden');
      resultBtns.innerHTML = '';

      actionToggle.classList.add('hidden');
      topMsg.classList.remove('hidden');

      isDragging = false;
      dragAction = null;
      dragSnapshot = null;
      dragHistoryCommitted = false;

      if (isWin) {
        gameStates[size].playerState = cloneGrid(gameStates[size].solution);
        gameStates[size].isGameOver = true;
        gameStates[size].resultState = RESULT_STATE.WIN;
        actionHistory = [];
        markStateDirty(size);
        renderBoard();

        saveData();
      } else {
        gameStates[size].resultState = RESULT_STATE.IN_PROGRESS;
        topMsg.style.color = 'var(--text-secondary)';
        topMsg.innerText = '你再想想看';

        const answerBtn = document.createElement('button');
        answerBtn.className = 'secondary-btn';
        answerBtn.type = 'button';
        answerBtn.innerText = '直接解答';
        answerBtn.addEventListener('click', showSolution);

        const retryBtn = document.createElement('button');
        retryBtn.className = 'primary-btn';
        retryBtn.type = 'button';
        retryBtn.innerText = '再試一次';
        retryBtn.addEventListener('click', () => { resetUI(); });

        resultBtns.appendChild(answerBtn);
        resultBtns.appendChild(retryBtn);
      }
    }

    function showSolution() {
      let state = gameStates[size];
      state.playerState = cloneGrid(state.solution);
      state.isGameOver = true;
      state.resultState = RESULT_STATE.REVEALED;
      markStateDirty(size);
      renderBoard();

      saveData();
    }

    function resetUI() {
      if (gameStates[size] && gameStates[size].isGameOver) return; // 避免結束後還原按鈕

      actionToggle.classList.remove('hidden');
      topMsg.classList.add('hidden');
      mainActions.classList.remove('hidden');
      resultBox.classList.add('hidden');
      updateClearBoardButtonState();
      document.querySelectorAll('.cell.error-wrong, .cell.error-miss').forEach(el => {
        el.classList.remove('error-wrong', 'error-miss');
      });
    }

    // --- 初始化啟動 (Initialization) ---
    applyDarkMode(darkMode);

    if (!loadData()) {
      loadLevel(size); // 如果沒有 cookie/localStorage 記錄，載入預設 8x8
    } else {
      renderBoard(); // 如果有記錄，直接繪製盤面
    }
