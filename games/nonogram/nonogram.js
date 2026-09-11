let size = 8;
    // 預設難度在下方常數區從 NonogramCore 取得後才指派，避免暫時性死區。
    let difficulty;
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
    // 這個文件自上次寫入後真的改動過的盤面槽位，只有它們會被標記成新版本。
    const dirtySlotKeys = new Set();

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
    // 純邏輯（題目生成、線解推理、難度評分）都在 nonogram-core.js，
    // 這裡解構成區域別名，既有呼叫點就不必逐一改寫。
    const {
      getClues,
      cloneGrid,
      createEmptyPlayerState,
      buildCluesFromSolution,
      countSolutions,
      areClueLinesEqual,
      isValidMatrix,
      isValidClueSet,
      normalizeDifficulty,
      DIFFICULTY_LEVELS,
      DEFAULT_DIFFICULTY
    } = NonogramCore;

    difficulty = DEFAULT_DIFFICULTY;

    const DIFFICULTY_LABELS = {
      easy: '簡單',
      medium: '中等',
      hard: '困難'
    };

    // 每個「盤面尺寸 × 難度」是一個獨立槽位，各自保存一局進度。
    const ALLOWED_SLOTS = ALLOWED_SIZES.flatMap(allowedSize =>
      DIFFICULTY_LEVELS.map(allowedDifficulty => ({
        size: allowedSize,
        difficulty: allowedDifficulty,
        key: getSlotKey(allowedSize, allowedDifficulty)
      }))
    );

    const levelBtns = document.querySelectorAll('#level-toggle .mode-btn');
    const difficultyBtns = document.querySelectorAll('#difficulty-toggle .mode-btn');
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
      const match = normalized.match(new RegExp(`^${SHARED_SEED_PREFIX}-(${ALLOWED_SIZES.join('|')})-([0-9A-F]+)$`));
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

      // 這裡只負責還原盤面，唯一性與難度交給 ratePuzzle 一次判定，
      // 才能分辨「不是唯一解」與「唯一解但必須猜測」並給出不同訊息。
      const { rowClues, colClues } = buildCluesFromSolution(solution);

      return {
        size: targetSize,
        solution: solution,
        rowClues: rowClues,
        colClues: colClues,
        seed: normalized
      };
    }

    function updateCurrentSeedDisplay() {
      const currentState = getCurrentState();
      currentSeedOutput.value = currentState ? encodeShareSeed(currentState.solution) : '';
    }

    function showSeedFeedback(message, isError = false) {
      seedFeedback.textContent = message;
      seedFeedback.classList.toggle('error', isError);
    }

    function loadSeedFromInput() {
      const decodedSeed = decodeShareSeed(seedInput.value);
      if (!decodedSeed) {
        showSeedFeedback('Seed 格式錯誤。', true);
        return;
      }

      const rating = NonogramCore.ratePuzzle(decodedSeed.rowClues, decodedSeed.colClues);
      if (!rating.unique) {
        showSeedFeedback('這個題目不是唯一解，無法載入。', true);
        return;
      }
      if (!rating.difficulty) {
        showSeedFeedback('這個題目必須靠猜測才能解完，無法載入。', true);
        return;
      }

      // Seed 只記錄盤面，難度是盤面的純函式，載入後直接切到判定出的難度槽位。
      size = decodedSeed.size;
      difficulty = rating.difficulty;
      const slotKey = getCurrentSlotKey();

      gameStates[slotKey] = {
        solution: decodedSeed.solution,
        playerState: createEmptyPlayerState(size),
        globalRowClues: decodedSeed.rowClues,
        globalColClues: decodedSeed.colClues,
        isGameOver: false,
        resultState: RESULT_STATE.IN_PROGRESS,
        stateRevision: getStateRevision(gameStates[slotKey])
      };
      markStateDirty(slotKey);
      actionHistory = [];

      updateSlotButtons();
      renderBoard();
      resetUI();
      seedInput.value = decodedSeed.seed;
      showSeedFeedback(`已載入指定 Seed（${size}x${size}・${DIFFICULTY_LABELS[difficulty]}）。`);
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

    function updateSlotButtons() {
      levelBtns.forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.size, 10) === size);
      });
      difficultyBtns.forEach(b => {
        b.classList.toggle('active', b.dataset.difficulty === difficulty);
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

    // --- 槽位 (Slots) ---
    function getSlotKey(targetSize, targetDifficulty) {
      return `${targetSize}x${targetDifficulty}`;
    }

    // 用白名單比對而非拆字串，舊存檔的數字 key（"8"）才不會被誤判成合法槽位。
    function parseSlotKey(key) {
      return ALLOWED_SLOTS.find(slot => slot.key === key) || null;
    }

    function getCurrentSlotKey() {
      return getSlotKey(size, difficulty);
    }

    function getCurrentState() {
      return gameStates[getCurrentSlotKey()];
    }

    // 標記「這個文件動過某個槽位的盤面」，寫檔時才會把它升到最新版本號。
    function markStateDirty(slotKey = getCurrentSlotKey()) {
      dirtySlotKeys.add(String(slotKey));
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

      ALLOWED_SLOTS.forEach(slot => {
        const validatedState = validateSavedGameState(gameStates[slot.key], slot.size);
        if (validatedState) snapshotStates[slot.key] = validatedState;
      });

      const availableKeys = Object.keys(snapshotStates);
      if (!availableKeys.length) return null;

      const currentKey = getCurrentSlotKey();
      const snapshotKey = snapshotStates[currentKey] ? currentKey : availableKeys[0];
      // 尺寸與難度一律從最終選定的槽位回推，不可拼湊出一個不存在的組合。
      const snapshotSlot = parseSlotKey(snapshotKey);

      return {
        size: snapshotSlot.size,
        difficulty: snapshotSlot.difficulty,
        themeColor: normalizeThemeColor(themeColor),
        darkMode: Boolean(darkMode),
        isBoardLocked: Boolean(isBoardLocked),
        isWakeLockEnabled: Boolean(isWakeLockEnabled),
        gameStates: snapshotStates,
        // actionHistory 只屬於目前操作中的槽位，退到別的槽位時必須丟棄，
        // 否則同尺寸不同題目的 undo 會通過尺寸檢查而套到錯的盤面上。
        actionHistory: snapshotKey === currentKey
          ? normalizeActionHistory(actionHistory, snapshotSlot.size)
          : [],
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
      ALLOWED_SLOTS.forEach(slot => {
        const resolvedState = resolveGameStateConflict(
          baseData?.gameStates?.[slot.key],
          incomingData?.gameStates?.[slot.key],
          !isBaseLive
        );
        if (resolvedState) mergedStates[slot.key] = resolvedState;
      });

      const availableKeys = Object.keys(mergedStates);
      if (!availableKeys.length) return null;

      const liveKey = getSlotKey(Number(liveData?.size), normalizeDifficulty(liveData?.difficulty));
      const staleKey = getSlotKey(Number(staleData?.size), normalizeDifficulty(staleData?.difficulty));
      const mergedKey = mergedStates[liveKey]
        ? liveKey
        : (mergedStates[staleKey] ? staleKey : availableKeys[0]);
      const mergedSlot = parseSlotKey(mergedKey);
      const mergedSize = mergedSlot.size;

      // 只採用「來源槽位就是最終槽位」那一側的 undo 歷史，避免套到別的題目上。
      const liveHistory = mergedKey === liveKey ? normalizeActionHistory(liveData?.actionHistory, mergedSize) : [];
      const staleHistory = mergedKey === staleKey ? normalizeActionHistory(staleData?.actionHistory, mergedSize) : [];

      return {
        size: mergedSize,
        difficulty: mergedSlot.difficulty,
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

      for (const slot of ALLOWED_SLOTS) {
        const leftState = leftData.gameStates?.[slot.key];
        const rightState = rightData.gameStates?.[slot.key];

        // 一側有、另一側沒有也算有差異，儲存層缺槽位時才會被回寫補齊。
        if (Boolean(leftState) !== Boolean(rightState)) return true;
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

      dirtySlotKeys.forEach(dirtyKey => {
        const dirtyState = runtimeSnapshot.gameStates[dirtyKey];
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
      dirtySlotKeys.forEach(dirtyKey => {
        if (gameStates[dirtyKey]) gameStates[dirtyKey].stateRevision = revision;
      });
      dirtySlotKeys.clear();

      // 合併時若採用了其他分頁較新的資料，立即套回畫面，避免記憶體與存檔長期不一致。
      if (hasGameStateDifference(runtimeSnapshot, mergedSnapshot)) {
        applySavedData(mergedSnapshot, false);
        renderBoard();
        if (!getCurrentState() || !getCurrentState().isGameOver) resetUI();
      }
    }

    function applySavedData(validatedData, shouldPersist = false) {
      size = validatedData.size;
      difficulty = validatedData.difficulty;
      themeColor = validatedData.themeColor;
      darkMode = validatedData.darkMode;
      gameStates = validatedData.gameStates;
      actionHistory = validatedData.actionHistory || [];
      saveRevision = Math.max(saveRevision, validatedData.revision || 0);
      lastSavedAt = Math.max(lastSavedAt, validatedData.savedAt || 0);

      applyDarkMode(darkMode);
      updateSlotButtons();

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

      if (!getCurrentState() || !getCurrentState().isGameOver) {
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
    // 按鈕的 active 狀態交給 switchSlot 內的 updateSlotButtons 回寫，
    // 生題失敗需要回滾時畫面才不會停在按不到的槽位上。
    levelBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        switchSlot(parseInt(e.currentTarget.dataset.size, 10), difficulty);
      });
    });

    difficultyBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        switchSlot(size, e.currentTarget.dataset.difficulty);
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
    newGameBtn.addEventListener('click', () => { confirmStartNewGame(size, difficulty); });
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

      ALLOWED_SLOTS.forEach(slot => {
        const validatedState = validateSavedGameState(parsed.gameStates[slot.key], slot.size);
        if (validatedState) validatedStates[slot.key] = validatedState;
      });

      // 舊存檔以「盤面尺寸」當 key，沒有難度概念；把它們視為中等難度搬進對應槽位。
      // 這裡不動任何版本號，首次載入後的正常回寫就會把格式落地。
      ALLOWED_SIZES.forEach(allowedSize => {
        const legacyState = validateSavedGameState(parsed.gameStates[allowedSize], allowedSize);
        if (!legacyState) return;

        const targetKey = getSlotKey(allowedSize, DEFAULT_DIFFICULTY);
        validatedStates[targetKey] = validatedStates[targetKey]
          ? resolveGameStateConflict(validatedStates[targetKey], legacyState, false)
          : legacyState;
      });

      const availableKeys = Object.keys(validatedStates);
      if (!availableKeys.length) return null;

      const candidateKey = getSlotKey(parsed.size, normalizeDifficulty(parsed.difficulty));
      const validatedKey = validatedStates[candidateKey] ? candidateKey : availableKeys[0];
      const validatedSlot = parseSlotKey(validatedKey);
      const validatedSize = validatedSlot.size;

      // 退到別的槽位時 undo 歷史必定不屬於那一局，直接丟棄。
      const validHistory = validatedKey === candidateKey && Array.isArray(parsed.actionHistory)
        ? parsed.actionHistory.filter(snapshot => isValidMatrix(snapshot, validatedSize, value => value === 0 || value === 1 || value === 2))
        : [];

      return {
        size: validatedSize,
        difficulty: validatedSlot.difficulty,
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

    function initGameData(targetSize, targetDifficulty) {
      const { solution, rowClues, colClues } = NonogramCore.generatePuzzle(targetSize, targetDifficulty);
      const slotKey = getSlotKey(targetSize, targetDifficulty);

      gameStates[slotKey] = {
        solution: solution,
        playerState: createEmptyPlayerState(targetSize),
        globalRowClues: rowClues,
        globalColClues: colClues,
        isGameOver: false
        , resultState: RESULT_STATE.IN_PROGRESS
        , stateRevision: getStateRevision(gameStates[slotKey])
      };
      markStateDirty(slotKey);
    }

    // 切換盤面尺寸或難度都走這裡：每個槽位各自保存一局，切過去若還沒有題目就現生一題。
    function switchSlot(nextSize, nextDifficulty) {
      const previousSize = size;
      const previousDifficulty = difficulty;
      const previousKey = getCurrentSlotKey();

      size = nextSize;
      difficulty = normalizeDifficulty(nextDifficulty);

      if (!getCurrentState()) {
        try {
          initGameData(size, difficulty);
        } catch (error) {
          console.error(error);
          size = previousSize;
          difficulty = previousDifficulty;
          updateSlotButtons();
          showGenerationFailure();
          return;
        }
      }

      // undo 歷史只屬於原本那一局，換槽位後必須清空，否則會套到別的題目上。
      if (getCurrentSlotKey() !== previousKey) actionHistory = [];

      updateSlotButtons();
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
      ngBtn.onclick = () => confirmStartNewGame(size, difficulty);
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
      const state = getCurrentState();
      const isEmpty = state ? isBoardEmpty(state.playerState) : true;
      const shouldDisable = !state || state.isGameOver || isEmpty;
      clearBoardBtn.disabled = shouldDisable;
      clearBoardBtn.setAttribute('aria-disabled', String(shouldDisable));
    }

    function updateUndoButtonState() {
      const shouldDisable = !actionHistory.length || !getCurrentState() || getCurrentState().isGameOver;
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
      let state = getCurrentState();
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

    function startNewGame(targetSize = size, targetDifficulty = difficulty) {
      actionHistory = [];
      try {
        initGameData(targetSize, targetDifficulty);
      } catch (error) {
        console.error(error);
        showGenerationFailure();
        return;
      }

      renderBoard();
      resetUI();
      saveData();
    }

    async function confirmStartNewGame(targetSize = size, targetDifficulty = difficulty) {
      const state = gameStates[getSlotKey(targetSize, targetDifficulty)];
      if (state && state.isGameOver) {
        startNewGame(targetSize, targetDifficulty);
        return;
      }

      const confirmed = await showConfirmDialog('新的一局', '確定要開始新的一局嗎？目前進度會遺失。', '開始新局');
      if (confirmed) {
        startNewGame(targetSize, targetDifficulty);
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
      const state = getCurrentState();
      if (!state || state.isGameOver || !actionHistory.length) return;

      const previous = state.playerState;
      const restored = actionHistory.pop();
      state.playerState = restored;
      state.resultState = RESULT_STATE.IN_PROGRESS;
      markStateDirty();

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
      const state = getCurrentState();
      if (!state || state.isGameOver) return;

      const confirmed = await showConfirmDialog('清空盤面', '確定要清空整個盤面嗎？這會移除目前所有塗黑與標記。', '確認清空');
      if (!confirmed) return;

      actionHistory.push(cloneGrid(state.playerState));
      state.playerState = createEmptyPlayerState(size);
      state.resultState = RESULT_STATE.IN_PROGRESS;
      markStateDirty();
      renderBoard();
      resetUI();
      saveData();
    }

    function handlePointerDown(e) {
      if (isBoardLocked || getCurrentState().isGameOver) return;
      if (e.type === 'touchstart') e.preventDefault();

      const cell = e.target.closest('.cell');
      if (!cell) return;

      isDragging = true;
      lastHoveredCell = cell;
      dragSnapshot = cloneGrid(getCurrentState().playerState);
      dragHistoryCommitted = false;
      const r = cell.dataset.r;
      const c = cell.dataset.c;
      const currentState = getCurrentState().playerState[r][c];

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
      if (isBoardLocked || !isDragging || getCurrentState().isGameOver) return;
      const cell = e.target.closest('.cell');
      if (!cell || cell === lastHoveredCell) return;
      lastHoveredCell = cell;
      applyAction(cell, cell.dataset.r, cell.dataset.c);
    }

    function handleTouchMove(e) {
      if (isBoardLocked || !isDragging || getCurrentState().isGameOver) return;
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
      let state = getCurrentState();
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
      markStateDirty();

      updateCompletedClueStatus(state);
      updateClearBoardButtonState();
      updateUndoButtonState();
    }

    function checkAnswer() {
      let state = getCurrentState();
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

      const state = getCurrentState();

      if (isWin) {
        state.playerState = cloneGrid(state.solution);
        state.isGameOver = true;
        state.resultState = RESULT_STATE.WIN;
        actionHistory = [];
        markStateDirty();
        renderBoard();

        saveData();
      } else {
        state.resultState = RESULT_STATE.IN_PROGRESS;
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
      let state = getCurrentState();
      state.playerState = cloneGrid(state.solution);
      state.isGameOver = true;
      state.resultState = RESULT_STATE.REVEALED;
      markStateDirty();
      renderBoard();

      saveData();
    }

    function resetUI() {
      if (getCurrentState() && getCurrentState().isGameOver) return; // 避免結束後還原按鈕

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
      switchSlot(size, difficulty); // 如果沒有 cookie/localStorage 記錄，載入預設 8x8 中等
    } else {
      renderBoard(); // 如果有記錄，直接繪製盤面
    }
