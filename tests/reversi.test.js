const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const GAME_DIR = path.join(__dirname, '..', 'games', 'reversi');
const JS_PATH = path.join(GAME_DIR, 'reversi.js');
const HTML_PATH = path.join(GAME_DIR, 'index.html');
const CSS_PATH = path.join(GAME_DIR, 'reversi.css');

// 即使 reversi.js 尚未完成，也只讓「斷言失敗」而不是整份測試檔炸掉
let moduleLoadError = null;
let core = {};
try {
  // eslint-disable-next-line global-require
  core = require(JS_PATH) || {};
} catch (err) {
  moduleLoadError = err;
}

const {
  EMPTY,
  BLACK,
  WHITE,
  SIZE,
  CELLS,
  POS_WEIGHTS,
  CORNERS,
  X_SQUARES,
  CORNER_GUARD,
  DIFFICULTIES,
  INFINITY_SCORE,
  createInitialBoard,
  cloneBoard,
  boardFromString,
  boardToString,
  collectFlips,
  isLegalMove,
  getLegalMoves,
  hasLegalMove,
  applyMove,
  countDiscs,
  isGameOver,
  getWinner,
  countMobility,
  countPotentialMobility,
  countFrontier,
  countStableEdges,
  countStableFull,
  evaluate,
  terminalScore,
  searchSync,
  createSearchTask,
  pickEasyMove,
  ReversiApp
} = core;

// ---------------------------------------------------------------------------
// 測試用的共用局面（皆以獨立參考實作手算驗證過）
// ---------------------------------------------------------------------------

const EMPTY_ROWS = [
  '........',
  '........',
  '........',
  '........',
  '........',
  '........',
  '........',
  '........'
];

// 只有黑子的盤面
const ONLY_BLACK_ROWS = [
  '........',
  '........',
  '..XXX...',
  '..XXX...',
  '..XXX...',
  '........',
  '........',
  '........'
];

// 中央 . 的八個方向各被「白一顆 + 黑一顆」夾住
const EIGHT_WAY_ROWS = [
  '........',
  '.X.X.X..',
  '..OOO...',
  '.XO.OX..',
  '..OOO...',
  '.X.X.X..',
  '........',
  '........'
];

// a1 落子往東：O O X O X，只能翻到最近的黑子為止（翻 1、2，不可翻 4）
const NEAREST_ROWS = [
  '.OOXOX..',
  '........',
  '........',
  '........',
  '........',
  '........',
  '........',
  '........'
];

// a1 落子往東：O O . X，中間有空格 → 不可夾
const GAP_ROWS = [
  '.OO.X...',
  '........',
  '........',
  '........',
  '........',
  '........',
  '........',
  '........'
];

// 同上但把空格補成白子 → 變成合法
const NO_GAP_ROWS = [
  '.OOOX...',
  '........',
  '........',
  '........',
  '........',
  '........',
  '........',
  '........'
];

// h4 = O、g4 = X；若實作誤把 a5(32) 的「西」算成 h4(31) 就會 wrap
const WRAP_WEST_ROWS = [
  '........',
  '........',
  '........',
  '......XO',
  '........',
  '........',
  '........',
  '........'
];

// a5 = O、b5 = X；若實作誤把 h4(31) 的「東」算成 a5(32) 就會 wrap
const WRAP_EAST_ROWS = [
  '........',
  '........',
  '........',
  '........',
  'OX......',
  '........',
  '........',
  '........'
];

// 白方只剩 a1 與 c2 兩顆，且全被封死 → 白無步、黑有步（9/17/18/19）
const WHITE_MUST_PASS_ROWS = [
  'OXXXXXXX',
  'X.OXXXXX',
  'X.......',
  'X.......',
  'X.......',
  'X.......',
  'X.......',
  'X.......'
];

// 白子只剩不可能被夾的角 a1 → 雙方皆無合法步，但棋盤未滿
const DOUBLE_PASS_ROWS = [
  'OXXXXXXX',
  'X.......',
  'X.......',
  'X.......',
  'X.......',
  'X.......',
  'X.......',
  'X.......'
];

const FULL_BLACK_WIN_ROWS = [
  'XXXXXXXX',
  'XXXXXXXX',
  'XXXXXXXX',
  'XXXXXXXX',
  'XXXXXXXX',
  'OOOOOOOO',
  'OOOOOOOO',
  'OOOOOOOO'
];

const FULL_DRAW_ROWS = [
  'XXXXXXXX',
  'XXXXXXXX',
  'XXXXXXXX',
  'XXXXXXXX',
  'OOOOOOOO',
  'OOOOOOOO',
  'OOOOOOOO',
  'OOOOOOOO'
];

const FULL_WHITE_WIN_ROWS = [
  'XXXXXXXX',
  'XXXXXXXX',
  'XXXXXXXX',
  'OOOOOOOO',
  'OOOOOOOO',
  'OOOOOOOO',
  'OOOOOOOO',
  'OOOOOOOO'
];

// 四角皆黑、中央兩顆白子（白子在任何軸線上都不固定）
const FOUR_CORNERS_ROWS = [
  'X......X',
  '........',
  '........',
  '...O....',
  '....O...',
  '........',
  '........',
  'X......X'
];

// 黑可下 0(a1 角)、9(X 位) 或 18；取角壓倒性最佳
const CORNER_BEST_ROWS = [
  '.OX.....',
  '..OX....',
  '........',
  '........',
  '........',
  '........',
  '........',
  '........'
];

// 黑只有 9(X 位) 與 25 兩手；下 9 之後白可立刻下 0 吃角
const AVOID_X_SQUARE_ROWS = [
  '........',
  '..OX....',
  '..O.....',
  '........',
  '........',
  '........',
  '........',
  '........'
];

// 黑白極度不對稱的局面，專門用來釘住 countFrontier / countPotentialMobility：
// 黑 11 子（9,10,11,12 / 17,18,19,20 / 25,26,28）、白 5 子（27 / 34,35,36 / 43）、空 48 格。
// 黑子 18(c3)、19(d3) 與白子 27(d4) 的八個鄰格全是棋子 → 前沿子必定少於各自的子數。
const FRONTIER_ASYM_ROWS = [
  '........',
  '.XXXX...',
  '.XXXX...',
  '.XXOX...',
  '..OOO...',
  '...O....',
  '........',
  '........'
];

// 只剩 4 個空格 (53/57/60/61)，黑可下 53/57/60，完美對局下唯有 57 能贏
const ENDGAME_ROWS = [
  'OOOOOXXX',
  'OOOOOOXX',
  'OOOOXXXX',
  'OOOXOXXX',
  'OXOOOOXX',
  'OXOOOOXX',
  'OOXOO.XX',
  'O.OO..XX'
];

function rowsToFlat(rows) {
  return rows.join('');
}

function asArray(board) {
  return Array.from(board);
}

function sortedFlips(out, count) {
  return Array.from(out).slice(0, count).map(Number).sort((a, b) => a - b);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 假 DOM / 假 localStorage（測 UI 方法時不需要真 DOM）
// ---------------------------------------------------------------------------

function makeElementStub() {
  const el = {
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    textContent: '',
    innerHTML: '',
    value: '',
    hidden: false,
    disabled: false,
    children: [],
    firstChild: null,
    setAttribute() {},
    removeAttribute() {},
    getAttribute() { return null; },
    appendChild(child) { return child; },
    removeChild(child) { return child; },
    replaceChildren() {},
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    click() {},
    remove() {},
    closest() { return null; },
    contains() { return false; },
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
  };
  el.querySelector = () => makeElementStub();
  el.querySelectorAll = () => [];
  return el;
}

function withStubEnv(fn) {
  const store = Object.create(null);
  const originals = {
    document: global.document,
    localStorage: global.localStorage,
    Stats: global.Stats
  };

  global.document = {
    documentElement: makeElementStub(),
    body: makeElementStub(),
    getElementById: () => makeElementStub(),
    querySelector: () => makeElementStub(),
    querySelectorAll: () => [],
    createElement: () => makeElementStub(),
    createDocumentFragment: () => makeElementStub(),
    addEventListener() {},
    removeEventListener() {}
  };
  global.localStorage = {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach(k => { delete store[k]; }); }
  };
  global.Stats = { recordGamePlay() {} };

  try {
    return fn(store);
  } finally {
    global.document = originals.document;
    global.localStorage = originals.localStorage;
    global.Stats = originals.Stats;
  }
}

// 灌入假依賴的 App 實例；只覆蓋純 UI 方法，遊戲邏輯方法一律用真的
// 這裡列的每一個名字都必須真的存在於 ReversiApp.prototype，
// 下方「makeApp 覆寫的方法都必須真實存在」那條測試會把它釘住。
// 目的是只把「碰 DOM 的」換成 noop，遊戲邏輯一律跑真的。
const UI_METHOD_STUBS = [
  'renderBoard',
  'renderCoords',
  'updateBoardCells',
  'refreshHUD',
  'updateActionButtons',
  'syncControlState',
  'setThinkingUI',
  'playFlipAnimation',
  'clearSuggestion',
  'showToast',
  'triggerConfetti',
  'renderStats',
  'showResultModal',
  'openModal',
  'closeModal'
];

function makeApp(extra) {
  assert.equal(typeof ReversiApp, 'function', 'reversi.js 必須匯出 ReversiApp 類別');
  const app = Object.create(ReversiApp.prototype);
  const noop = () => {};
  Object.assign(app, {
    // --- 狀態（欄位名與實作一致）---
    board: createInitialBoard(),
    history: [],
    current: BLACK,
    humanColor: BLACK,
    aiColor: WHITE,
    mode: 'ai',
    difficulty: 'normal',
    gameOver: false,
    thinking: false,
    winner: 0,
    hintsUsed: 0,
    undosUsed: 0,
    lastMoveSq: -1,
    suggestedSq: -1,
    lastTapAt: 0,
    animating: false,
    animUntil: 0,
    aiTask: null,
    aiTimer: null,
    aiToken: 0,
    el: {},
    cells: [],
    sound: {
      playPlace: noop, playFlip: noop, playPass: noop,
      playWin: noop, playLose: noop, playInvalid: noop
    }
  }, extra);

  // 只覆寫真正會碰 DOM 的方法；沒被 extra 指定的才套 noop
  UI_METHOD_STUBS.forEach(name => {
    if (!Object.prototype.hasOwnProperty.call(extra || {}, name)) app[name] = noop;
  });
  return app;
}

// history 是 entry 物件陣列：{ type:'move', sq, player, flips } 或 { type:'pass', player }。
// 存檔序列化時才攤平成格號陣列，因為 pass 與 flips 都必須保留才能正確悔棋。
function playMoves(app, squares) {
  squares.forEach(sq => {
    const applied = applyMove(app.board, sq, app.current);
    assert.ok(applied, `建立測試局面時 ${sq} 對 ${app.current === BLACK ? '黑' : '白'}方應為合法步`);
    app.board = applied.board;
    app.history.push({ type: 'move', sq, player: app.current, flips: applied.flips });
    app.current = -app.current;
  });
  return app;
}

// 取出 history 中實際落子的格號（略過 pass）
function movesOf(app) {
  return app.history.filter(h => h && h.type === 'move').map(h => h.sq);
}

// ---------------------------------------------------------------------------
// 原始碼靜態掃描：把註解與字串／樣板字面值的「內容」塗成空白（保留換行以維持行號），
// 之後就能單純用大括號配對判斷「某個位置是不是落在某個 try 區塊裡」。
// ---------------------------------------------------------------------------
function blankLiterals(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (idx) => {
    if (idx < n && out[idx] !== '\n') out[idx] = ' ';
  };
  let i = 0;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') { blank(i); i += 1; }
      continue;
    }
    if (ch === '/' && next === '*') {
      blank(i); blank(i + 1); i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { blank(i); i += 1; }
      blank(i); blank(i + 1); i += 2;
      continue;
    }
    if (ch === '"' || ch === '\'' || ch === '`') {
      i += 1; // 頭尾的引號原樣留著，只塗掉中間的內容
      while (i < n && src[i] !== ch) {
        if (src[i] === '\\') { blank(i); blank(i + 1); i += 2; continue; }
        blank(i); i += 1;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

// 找出所有「try { ... }」區塊在塗白後原始碼中的 [開括號, 閉括號] 位置
function tryBlockRanges(code) {
  const ranges = [];
  const re = /\btry\s*\{/g;
  let m = re.exec(code);
  while (m) {
    const open = code.indexOf('{', m.index);
    let depth = 0;
    let j = open;
    for (; j < code.length; j += 1) {
      if (code[j] === '{') depth += 1;
      else if (code[j] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    ranges.push([open, j]);
    m = re.exec(code);
  }
  return ranges;
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

// ---------------------------------------------------------------------------
// 0. 模組載入
// ---------------------------------------------------------------------------

test('reversi.js 可被 require 並匯出契約規定的符號', () => {
  assert.equal(moduleLoadError, null,
    `require('${JS_PATH}') 失敗：${moduleLoadError && moduleLoadError.message}`);

  const requiredFunctions = [
    'createInitialBoard', 'cloneBoard', 'boardFromString', 'boardToString',
    'collectFlips', 'isLegalMove', 'getLegalMoves', 'hasLegalMove', 'applyMove',
    'countDiscs', 'isGameOver', 'getWinner', 'countMobility', 'countPotentialMobility',
    'countFrontier', 'countStableEdges', 'countStableFull', 'evaluate', 'terminalScore',
    'searchSync', 'createSearchTask', 'pickEasyMove'
  ];
  requiredFunctions.forEach(name => {
    assert.equal(typeof core[name], 'function', `缺少 CORE 函式 ${name}()`);
  });

  assert.equal(EMPTY, 0, 'EMPTY 必須為 0');
  assert.equal(BLACK, 1, 'BLACK 必須為 1');
  assert.equal(WHITE, -1, 'WHITE 必須為 -1（負號讓 negamax 可直接換手）');
  assert.equal(SIZE, 8);
  assert.equal(CELLS, 64);
  assert.ok(typeof INFINITY_SCORE === 'number' && INFINITY_SCORE > 100000,
    'INFINITY_SCORE 應為足夠大的數字');
  assert.equal(typeof ReversiApp, 'function', '必須匯出 ReversiApp');
});

test('makeApp 覆寫的方法都必須真實存在於 ReversiApp.prototype', () => {
  // 若 stub 了不存在的名字，真方法就會在測試裡裸跑，
  // 哪天它多一行 DOM 存取整批測試就會莫名其妙爆掉。
  const missing = UI_METHOD_STUBS.filter(
    name => typeof ReversiApp.prototype[name] !== 'function'
  );
  assert.deepEqual(missing, [], `stub 了不存在的方法：${missing.join(', ')}`);
});

// ---------------------------------------------------------------------------
// A. 盤面與合法步
// ---------------------------------------------------------------------------

test('createInitialBoard 建立標準開局：黑白各 2 子、60 空格且四子位置正確', () => {
  const board = createInitialBoard();

  assert.equal(board.length, 64);
  assert.ok(board instanceof Int8Array, '盤面必須是 Int8Array(64)');
  assert.deepEqual(countDiscs(board), { black: 2, white: 2, empty: 60 });

  assert.equal(board[27], WHITE, 'd4(27) 必須是白子');
  assert.equal(board[28], BLACK, 'e4(28) 必須是黑子');
  assert.equal(board[35], BLACK, 'd5(35) 必須是黑子');
  assert.equal(board[36], WHITE, 'e5(36) 必須是白子');

  // 其餘 60 格必須是空的
  for (let i = 0; i < 64; i++) {
    if (i === 27 || i === 28 || i === 35 || i === 36) continue;
    assert.equal(board[i], EMPTY, `格號 ${i} 應為空格`);
  }

  // cloneBoard 必須是真複製
  const copy = cloneBoard(board);
  assert.notEqual(copy, board, 'cloneBoard 不可回傳同一個參考');
  assert.deepEqual(asArray(copy), asArray(board));
  copy[0] = BLACK;
  assert.equal(board[0], EMPTY, 'cloneBoard 後修改副本不得影響原盤');
});

test('開局合法步：黑方精確為 [19,26,37,44]、白方精確為 [20,29,34,43]', () => {
  const board = createInitialBoard();

  const blackMoves = getLegalMoves(board, BLACK);
  assert.ok(Array.isArray(blackMoves), 'getLegalMoves 必須回傳一般陣列');
  assert.deepEqual(blackMoves, [19, 26, 37, 44], '黑方開局合法步必須是 d3/c4/f5/e6');
  assert.deepEqual(getLegalMoves(board, WHITE), [20, 29, 34, 43], '白方開局合法步必須是 e3/f4/c5/d6');

  assert.equal(hasLegalMove(board, BLACK), true);
  assert.equal(hasLegalMove(board, WHITE), true);
  assert.equal(countMobility(board, BLACK), 4);
  assert.equal(countMobility(board, WHITE), 4);
  [19, 26, 37, 44].forEach(sq => assert.equal(isLegalMove(board, sq, BLACK), true, `${sq} 應為黑方合法步`));
  [0, 27, 28, 35, 36, 63].forEach(sq => assert.equal(isLegalMove(board, sq, BLACK), false, `${sq} 不應為黑方合法步`));
});

test('boardFromString / boardToString 支援 8 行陣列與 64 字元字串並可互轉', () => {
  const fromRows = boardFromString(EIGHT_WAY_ROWS);
  const fromFlat = boardFromString(rowsToFlat(EIGHT_WAY_ROWS));
  assert.deepEqual(asArray(fromRows), asArray(fromFlat), '兩種輸入格式必須得到相同盤面');

  assert.equal(boardToString(createInitialBoard()), [
    '........',
    '........',
    '........',
    '...OX...',
    '...XO...',
    '........',
    '........',
    '........'
  ].join('\n'));

  assert.equal(boardToString(fromRows), EIGHT_WAY_ROWS.join('\n'));
  // 含換行與空白的輸入必須被忽略
  assert.deepEqual(asArray(boardFromString(EIGHT_WAY_ROWS.join('\n'))), asArray(fromRows));
});

test('空盤與單一顏色的盤面皆沒有任何合法步', () => {
  const emptyBoard = boardFromString(EMPTY_ROWS);
  assert.deepEqual(countDiscs(emptyBoard), { black: 0, white: 0, empty: 64 });
  assert.deepEqual(getLegalMoves(emptyBoard, BLACK), []);
  assert.deepEqual(getLegalMoves(emptyBoard, WHITE), []);
  assert.equal(hasLegalMove(emptyBoard, BLACK), false);
  assert.equal(hasLegalMove(emptyBoard, WHITE), false);

  const onlyBlack = boardFromString(ONLY_BLACK_ROWS);
  assert.deepEqual(getLegalMoves(onlyBlack, BLACK), [], '沒有對手棋子可翻時黑方無合法步');
  assert.deepEqual(getLegalMoves(onlyBlack, WHITE), [], '自己一顆都沒有時白方無合法步');
});

test('夾子不可跨越空格（O O . X 之類的序列一律不合法）', () => {
  const gapped = boardFromString(GAP_ROWS);
  assert.equal(isLegalMove(gapped, 0, BLACK), false, 'a1 往東遇到空格就不能夾');
  assert.equal(isLegalMove(gapped, 3, BLACK), false, '被夾的另一端是空格也不能夾');
  assert.deepEqual(getLegalMoves(gapped, BLACK), [], '整盤黑方都不該有合法步');
  assert.deepEqual(getLegalMoves(gapped, WHITE), []);

  const out = new Int8Array(64);
  assert.equal(collectFlips(gapped, 0, BLACK, out), 0, '非法落子必須回傳 0 顆翻子');

  // 把空格補成白子之後同一格就變合法，且翻 3 顆
  const solid = boardFromString(NO_GAP_ROWS);
  assert.equal(isLegalMove(solid, 0, BLACK), true);
  assert.deepEqual(getLegalMoves(solid, BLACK), [0]);
  const n = collectFlips(solid, 0, BLACK, out);
  assert.equal(n, 3);
  assert.deepEqual(sortedFlips(out, n), [1, 2, 3]);
});

test('夾子不可跨越棋盤左右邊界（h 行與 a 行之間不得 wrap）', () => {
  // h4(31)=O、g4(30)=X；a5(32) 的「西」在真實棋盤上不存在
  const west = boardFromString(WRAP_WEST_ROWS);
  assert.equal(isLegalMove(west, 32, BLACK), false, 'a5 不可往西 wrap 夾到 h4');
  assert.deepEqual(getLegalMoves(west, BLACK), [], '此盤面黑方應完全無步');
  const out = new Int8Array(64);
  assert.equal(collectFlips(west, 32, BLACK, out), 0);

  // a5(32)=O、b5(33)=X；h4(31) 的「東」在真實棋盤上不存在
  const east = boardFromString(WRAP_EAST_ROWS);
  assert.equal(isLegalMove(east, 31, BLACK), false, 'h4 不可往東 wrap 夾到 a5');
  assert.deepEqual(getLegalMoves(east, BLACK), []);
  assert.equal(collectFlips(east, 31, BLACK, out), 0);
});

// ---------------------------------------------------------------------------
// B. 翻子
// ---------------------------------------------------------------------------

test('八個方向同時成立時一次翻 8 顆', () => {
  const board = boardFromString(EIGHT_WAY_ROWS);
  const out = new Int8Array(64);
  const n = collectFlips(board, 27, BLACK, out);

  assert.equal(n, 8, '中心格落子必須同時翻掉八方各一顆');
  assert.deepEqual(sortedFlips(out, n), [18, 19, 20, 26, 28, 34, 35, 36]);

  const result = applyMove(board, 27, BLACK);
  assert.ok(result, '八方向夾殺必須是合法步');
  assert.deepEqual(result.flips.slice().sort((a, b) => a - b), [18, 19, 20, 26, 28, 34, 35, 36]);
  assert.equal(result.board[27], BLACK);
  [18, 19, 20, 26, 28, 34, 35, 36].forEach(sq => {
    assert.equal(result.board[sq], BLACK, `格號 ${sq} 落子後應變成黑子`);
  });
  assert.deepEqual(countDiscs(result.board), { black: 8 + 1 + 8, white: 0, empty: 64 - 17 });
});

test('同一條線只翻到最近的己方棋子為止，不會翻過頭', () => {
  // a1 往東依序是 O O X O X：只能翻 b1、c1，絕不能翻到 e1
  const board = boardFromString(NEAREST_ROWS);
  const out = new Int8Array(64);
  const n = collectFlips(board, 0, BLACK, out);

  assert.equal(n, 2, '只能翻到最近的黑子為止');
  assert.deepEqual(sortedFlips(out, n), [1, 2]);

  const result = applyMove(board, 0, BLACK);
  assert.equal(result.board[1], BLACK);
  assert.equal(result.board[2], BLACK);
  assert.equal(result.board[3], BLACK, '原本就是黑子');
  assert.equal(result.board[4], WHITE, 'e1 在黑子後方，不得被翻');
  assert.equal(result.board[5], BLACK);
});

test('applyMove 非法步回傳 null，且無論合法與否都不得改動傳入的盤面', () => {
  const board = createInitialBoard();
  const snapshot = asArray(board);

  assert.equal(applyMove(board, 0, BLACK), null, 'a1 在開局並非合法步');
  assert.equal(applyMove(board, 27, BLACK), null, '已有棋子的格子不可落子');
  assert.equal(applyMove(board, 20, BLACK), null, '20 是白方的合法步，黑方不合法');
  assert.deepEqual(asArray(board), snapshot, '非法落子不得改動傳入的盤面');

  const result = applyMove(board, 19, BLACK);
  assert.ok(result && result.board, '19 應為合法步');
  assert.deepEqual(asArray(board), snapshot, 'applyMove 絕對不可就地修改傳入的 board');
  assert.notEqual(result.board, board, '必須回傳新的盤面物件');
  assert.deepEqual(result.flips, [27]);
  assert.deepEqual(countDiscs(result.board), { black: 4, white: 1, empty: 59 });
});

// ---------------------------------------------------------------------------
// C. 跳過與終局
// ---------------------------------------------------------------------------

test('單方無合法步時必須跳過而不是結束對局', () => {
  const board = boardFromString(WHITE_MUST_PASS_ROWS);

  assert.equal(hasLegalMove(board, WHITE), false, '白方在此局面完全沒有合法步');
  assert.equal(hasLegalMove(board, BLACK), true, '黑方仍有合法步');
  assert.deepEqual(getLegalMoves(board, WHITE), []);
  assert.deepEqual(getLegalMoves(board, BLACK), [9, 17, 18, 19]);
  assert.equal(isGameOver(board), false, '只有一方無步時不算終局');
  assert.deepEqual(countDiscs(board), { black: 19, white: 2, empty: 43 });
});

test('雙方皆無合法步時即使棋盤未滿也算終局', () => {
  const board = boardFromString(DOUBLE_PASS_ROWS);

  assert.deepEqual(getLegalMoves(board, BLACK), [], '白子只剩不可夾的 a1 角，黑方無步');
  assert.deepEqual(getLegalMoves(board, WHITE), [], '白子被自己的黑牆封死，白方無步');
  assert.equal(isGameOver(board), true);
  assert.deepEqual(countDiscs(board), { black: 14, white: 1, empty: 49 });
  assert.equal(getWinner(board), BLACK);
});

test('棋盤下滿時終局且依子數判定黑勝、白勝與和局', () => {
  const blackWin = boardFromString(FULL_BLACK_WIN_ROWS);
  assert.deepEqual(countDiscs(blackWin), { black: 40, white: 24, empty: 0 });
  assert.equal(isGameOver(blackWin), true);
  assert.equal(getWinner(blackWin), BLACK);

  const draw = boardFromString(FULL_DRAW_ROWS);
  assert.deepEqual(countDiscs(draw), { black: 32, white: 32, empty: 0 });
  assert.equal(isGameOver(draw), true);
  assert.equal(getWinner(draw), 0, '32:32 必須回傳 0 代表和局');

  const whiteWin = boardFromString(FULL_WHITE_WIN_ROWS);
  assert.deepEqual(countDiscs(whiteWin), { black: 24, white: 40, empty: 0 });
  assert.equal(isGameOver(whiteWin), true);
  assert.equal(getWinner(whiteWin), WHITE);
});

test('一方棋子歸零即為終局，贏家是仍有棋子的另一方', () => {
  const noWhite = boardFromString([
    'XXXXXXXX', '........', '........', '........',
    '........', '........', '........', '........'
  ]);
  assert.deepEqual(countDiscs(noWhite), { black: 8, white: 0, empty: 56 });
  assert.equal(isGameOver(noWhite), true);
  assert.equal(getWinner(noWhite), BLACK);

  const noBlack = boardFromString([
    'OOOOOOOO', '........', '........', '........',
    '........', '........', '........', '........'
  ]);
  assert.deepEqual(countDiscs(noBlack), { black: 0, white: 8, empty: 56 });
  assert.equal(isGameOver(noBlack), true);
  assert.equal(getWinner(noBlack), WHITE);
});

// ---------------------------------------------------------------------------
// D. 權重表與評估
// ---------------------------------------------------------------------------

test('POS_WEIGHTS 具備完整八重對稱性', () => {
  assert.equal(POS_WEIGHTS.length, 64);
  const w = (r, c) => POS_WEIGHTS[r * 8 + c];

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const base = w(r, c);
      assert.equal(w(r, 7 - c), base, `(${r},${c}) 左右鏡射不對稱`);
      assert.equal(w(7 - r, c), base, `(${r},${c}) 上下鏡射不對稱`);
      assert.equal(w(7 - r, 7 - c), base, `(${r},${c}) 180 度旋轉不對稱`);
      assert.equal(w(c, r), base, `(${r},${c}) 主對角轉置不對稱`);
      assert.equal(w(7 - c, 7 - r), base, `(${r},${c}) 反對角轉置不對稱`);
    }
  }
});

test('POS_WEIGHTS 四角是全表最大值 120、X 位是最小值 -40', () => {
  const values = Array.from(POS_WEIGHTS);
  assert.equal(Math.max(...values), 120);
  assert.equal(Math.min(...values), -40);

  assert.deepEqual(Array.from(CORNERS), [0, 7, 56, 63]);
  assert.deepEqual(Array.from(X_SQUARES), [9, 14, 49, 54]);
  CORNERS.forEach(sq => assert.equal(POS_WEIGHTS[sq], 120, `角 ${sq} 權重必須是 120`));
  X_SQUARES.forEach(sq => assert.equal(POS_WEIGHTS[sq], -40, `X 位 ${sq} 權重必須是 -40`));

  assert.deepEqual(Array.from(CORNER_GUARD[0]), [1, 8, 9]);
  assert.deepEqual(Array.from(CORNER_GUARD[7]), [6, 15, 14]);
  assert.deepEqual(Array.from(CORNER_GUARD[56]), [48, 57, 49]);
  assert.deepEqual(Array.from(CORNER_GUARD[63]), [55, 62, 54]);
});

test('evaluate 對黑白完全反對稱', () => {
  const boards = [
    createInitialBoard(),
    boardFromString(EIGHT_WAY_ROWS),
    boardFromString(WHITE_MUST_PASS_ROWS),
    boardFromString(CORNER_BEST_ROWS),
    boardFromString(FOUR_CORNERS_ROWS),
    boardFromString(ENDGAME_ROWS)
  ];

  boards.forEach((board, idx) => {
    const cheap = evaluate(board, BLACK) + evaluate(board, WHITE);
    assert.ok(Math.abs(cheap) < 1e-9, `第 ${idx} 個盤面 evaluate 不反對稱：${cheap}`);

    const full = evaluate(board, BLACK, { fullStability: true })
      + evaluate(board, WHITE, { fullStability: true });
    assert.ok(Math.abs(full) < 1e-9, `第 ${idx} 個盤面在 fullStability 下不反對稱：${full}`);

    assert.equal(Number.isFinite(evaluate(board, BLACK)), true, 'evaluate 必須回傳有限數值');
  });
});

test('terminalScore 依子數差判定勝負且黑白反對稱', () => {
  const blackWin = boardFromString(FULL_BLACK_WIN_ROWS);
  assert.ok(terminalScore(blackWin, BLACK) > 0, '黑方 40:24 應為正分');
  assert.ok(terminalScore(blackWin, WHITE) < 0, '白方 24:40 應為負分');
  assert.equal(terminalScore(blackWin, BLACK) + terminalScore(blackWin, WHITE), 0);

  const draw = boardFromString(FULL_DRAW_ROWS);
  assert.equal(terminalScore(draw, BLACK), 0, '和局分數必須為 0');
  assert.equal(terminalScore(draw, WHITE), 0);
});

test('countStableFull 正確判定角落固定子，開局四子則完全不固定', () => {
  const corners = boardFromString(FOUR_CORNERS_ROWS);
  assert.equal(countStableFull(corners, BLACK), 4, '四個角必定都是固定子');
  assert.equal(countStableFull(corners, WHITE), 0, '中央的兩顆白子在四軸上都不固定');

  const initial = createInitialBoard();
  assert.equal(countStableFull(initial, BLACK), 0, '開局的四子沒有任何固定子');
  assert.equal(countStableFull(initial, WHITE), 0);

  assert.equal(countStableEdges(initial, BLACK), 0, '沒有佔角就沒有便宜版邊線固定子');
  assert.equal(countStableEdges(initial, WHITE), 0);
  assert.ok(countStableEdges(corners, BLACK) >= 4, '四角皆黑時便宜版至少要算出 4 顆');
});

test('countMobility / countPotentialMobility / countFrontier 在開局局面數值正確', () => {
  const board = createInitialBoard();

  assert.equal(countMobility(board, BLACK), 4);
  assert.equal(countMobility(board, WHITE), 4);

  // 貼著對手棋子的空格：白子 d4/e5 周圍共 10 個相異空格
  assert.equal(countPotentialMobility(board, BLACK), 10);
  assert.equal(countPotentialMobility(board, WHITE), 10);

  // 開局四子每顆都鄰接空格
  assert.equal(countFrontier(board, BLACK), 2);
  assert.equal(countFrontier(board, WHITE), 2);
});

// 開局盤黑白 180° 對稱，上面六條斷言全部落在退化點上（pmob 兩色同為 10、
// frontier 兩色同為 2 而 2 又剛好等於各自的子數），把顏色接反或把「鄰接空格」
// 的判定整個拿掉都照樣會通過。以下改用兩個黑白不對稱、且可逐格手算的局面釘住。
test('countPotentialMobility / countFrontier 在黑白不對稱的局面仍逐格正確', () => {
  //      a b c d e f g h
  //   1  . . . . . . . .
  //   2  . X X X X . . .   黑 11 子：9,10,11,12 / 17,18,19,20 / 25,26,28
  //   3  . X X X X . . .   白  5 子：27 / 34,35,36 / 43
  //   4  . X X O X . . .
  //   5  . . O O O . . .
  //   6  . . . O . . . .
  //   7  . . . . . . . .
  //   8  . . . . . . . .
  const asym = boardFromString(FRONTIER_ASYM_ROWS);
  const asymDiscs = countDiscs(asym);
  assert.deepEqual(asymDiscs, { black: 11, white: 5, empty: 48 },
    '前置條件：此局面黑白子數必須不同');

  // 潛在行動力＝「至少鄰接一顆對手棋子」的空格數（算相異格數，不是鄰接次數）。
  // 黑方數的是貼著白子的空格：
  //   27(d4) 八鄰全是棋子      → 無
  //   34(c5) → 33, 41, 42
  //   35(d5) → 42, 44
  //   36(e5) → 29, 37, 44, 45
  //   43(d6) → 42, 44, 50, 51, 52
  //   聯集 {29,33,37,41,42,44,45,50,51,52} = 10
  assert.equal(countPotentialMobility(asym, BLACK), 10,
    '黑方的潛在行動力必須數「白子」旁邊的空格');
  // 白方數的是貼著黑子的空格：
  //   9  → 0,1,2,8,16      10 → 1,2,3        11 → 2,3,4
  //   12 → 3,4,5,13,21     17 → 8,16,24      18/19 八鄰全是棋子 → 無
  //   20 → 13,21,29        25 → 16,24,32,33  26 → 33
  //   28 → 21,29,37
  //   聯集 {0,1,2,3,4,5,8,13,16,21,24,29,32,33,37} = 15
  assert.equal(countPotentialMobility(asym, WHITE), 15,
    '白方的潛在行動力必須數「黑子」旁邊的空格');
  assert.notEqual(countPotentialMobility(asym, BLACK), countPotentialMobility(asym, WHITE),
    '顏色接反（opp = player）時黑白會互換，此局面必須測得出來');
  assert.notEqual(countPotentialMobility(asym, BLACK), asymDiscs.empty,
    'countPotentialMobility 不得退化成單純數空格');

  // 前沿子＝己方棋子中「至少鄰接一個空格」者。
  // 黑 11 子裡，18(c3) 與 19(d3) 的八個鄰格全是棋子 → 11 - 2 = 9
  assert.equal(countFrontier(asym, BLACK), 9);
  // 白 5 子裡，27(d4) 的八個鄰格全是棋子 → 5 - 1 = 4
  assert.equal(countFrontier(asym, WHITE), 4);
  assert.notEqual(countFrontier(asym, BLACK), asymDiscs.black,
    'countFrontier 不得退化成己方棋子總數（鄰接空格的判定不可省略）');
  assert.notEqual(countFrontier(asym, WHITE), asymDiscs.white,
    '白方同樣不得退化成棋子總數');
  assert.notEqual(countFrontier(asym, BLACK), countFrontier(asym, WHITE),
    '顏色接反時黑白會互換，此局面必須測得出來');

  // 第二個不對稱局面（黑 19 / 白 2），順帶蓋到「整條 a 行都是黑子」的邊界。
  const lopsided = boardFromString(WHITE_MUST_PASS_ROWS);
  assert.deepEqual(countDiscs(lopsided), { black: 19, white: 2, empty: 43 });
  assert.equal(countMobility(lopsided, BLACK), 4);
  assert.equal(countMobility(lopsided, WHITE), 0, '白方在此局面完全無步');

  // 白子只有 a1(0) 與 c2(10)：a1 的空鄰格只有 9；c2 的空鄰格是 9,17,18,19
  // → 聯集 {9,17,18,19} = 4
  assert.equal(countPotentialMobility(lopsided, BLACK), 4);
  // 貼著黑子的空格：9、第 3 列 17~23 共 7 格、以及 25/33/41/49/57 → 1 + 7 + 5 = 13
  assert.equal(countPotentialMobility(lopsided, WHITE), 13);

  // 黑 19 子裡，d1~h1（3,4,5,6,7）這 5 顆四周（含第 2 列 c2~h2）全是棋子 → 19 - 5 = 14
  assert.equal(countFrontier(lopsided, BLACK), 14);
  // 白子 a1 與 c2 都鄰接空格 b2(9)
  assert.equal(countFrontier(lopsided, WHITE), 2);
  assert.notEqual(countFrontier(lopsided, BLACK), countDiscs(lopsided).black,
    'countFrontier 不得退化成己方棋子總數');
});

// ---------------------------------------------------------------------------
// E. AI 行為
// ---------------------------------------------------------------------------

test('searchSync 會在明顯可佔角時選擇 a1（格號 0）', () => {
  const board = boardFromString(CORNER_BEST_ROWS);
  assert.deepEqual(getLegalMoves(board, BLACK), [0, 9, 18], '此局面黑方僅有 0 / 9 / 18 三手');

  const result = searchSync(board, BLACK, { maxDepth: 4, timeBudgetMs: 2000, deterministic: true });
  assert.ok(result && typeof result.move === 'number', 'searchSync 必須回傳 { move, score, depth, nodes }');
  assert.equal(result.move, 0, '取得 a1 角遠優於 X 位(9) 或 18');
  assert.ok(result.depth >= 1, 'depth 必須回報實際搜尋深度');
  assert.ok(result.nodes > 0, 'nodes 必須回報搜尋節點數');

  // 可決定性：同樣輸入必須得到同樣結果
  const again = searchSync(board, BLACK, { maxDepth: 4, timeBudgetMs: 2000, deterministic: true });
  assert.equal(again.move, result.move, 'deterministic: true 時同一局面必須回傳同一手');
});

test('困難難度不會為了一顆子而下 X 位把角送給對手', () => {
  const board = boardFromString(AVOID_X_SQUARE_ROWS);
  assert.deepEqual(getLegalMoves(board, BLACK), [9, 25], '此局面黑方僅有 9(X 位) 與 25 兩手');

  // 下 9 之後白方立刻可以下 0 把 a1 角吃走；下 25 則完全碰不到角
  const afterX = applyMove(board, 9, BLACK);
  assert.equal(isLegalMove(afterX.board, 0, WHITE), true, '下 X 位之後白方可以直接佔角');
  const afterSafe = applyMove(board, 25, BLACK);
  assert.equal(isLegalMove(afterSafe.board, 0, WHITE), false, '安全替代步不會送角');

  const hard = DIFFICULTIES.hard;
  const result = searchSync(board, BLACK, {
    maxDepth: hard.maxDepth,
    timeBudgetMs: hard.timeBudgetMs,
    exactEmpties: hard.exactEmpties,
    fullStability: hard.fullStability,
    deterministic: true
  });

  assert.notEqual(result.move, 9, '困難難度絕不可選擇會送角的 X 位');
  assert.equal(result.move, 25, '唯一的安全替代步是 25');
});

test('殘局只剩 4 個空格時能算出唯一的致勝手', () => {
  const board = boardFromString(ENDGAME_ROWS);
  assert.deepEqual(countDiscs(board), { black: 24, white: 36, empty: 4 });
  assert.deepEqual(getLegalMoves(board, BLACK), [53, 57, 60], '黑方僅有 53 / 57 / 60 三手');

  // 完美對局結果（最終黑子-白子）：53 → -22、57 → +4、60 → -12
  // 翻最多子的貪心手是 60（翻 6 顆）卻會輸，必須靠精確搜尋才選得到 57（只翻 1 顆）
  const result = searchSync(board, BLACK, {
    maxDepth: 12,
    timeBudgetMs: 5000,
    exactEmpties: 10,
    exactBudgetMs: 5000,
    fullStability: true,
    deterministic: true
  });

  assert.equal(result.move, 57, '唯一能贏的手是 57（b8）');
});

test('DIFFICULTIES 三檔難度結構完整且符合契約數值', () => {
  assert.deepEqual(Object.keys(DIFFICULTIES), ['easy', 'normal', 'hard'], '必須剛好三檔難度');

  const { easy, normal, hard } = DIFFICULTIES;

  assert.equal(easy.id, 'easy');
  assert.equal(easy.name, '簡單');
  assert.equal(easy.label, '🌱 簡單');
  assert.equal(easy.engine, 'shallow');
  assert.equal(easy.randomRate, 0.6);
  assert.equal(easy.cornerBias, 0.30);
  assert.equal(easy.minThinkMs, 220);

  assert.equal(normal.id, 'normal');
  assert.equal(normal.name, '普通');
  assert.equal(normal.label, '🎯 普通');
  assert.equal(normal.engine, 'search');
  assert.equal(normal.maxDepth, 4);
  assert.equal(normal.timeBudgetMs, 280);
  assert.equal(normal.exactEmpties, 8);
  assert.equal(normal.fullStability, false);
  assert.equal(normal.tieToleranceEarly, 25);
  assert.equal(normal.minThinkMs, 320);

  assert.equal(hard.id, 'hard');
  assert.equal(hard.name, '困難');
  assert.equal(hard.label, '🔥 困難');
  assert.equal(hard.engine, 'search');
  assert.equal(hard.maxDepth, 6);
  assert.equal(hard.timeBudgetMs, 900);
  assert.equal(hard.exactEmpties, 10);
  assert.equal(hard.exactBudgetMs, 1800);
  assert.equal(hard.fullStability, true);
  assert.equal(hard.tieToleranceEarly, 8);
  assert.equal(hard.minThinkMs, 380);

  assert.ok(hard.maxDepth > normal.maxDepth, '困難必須比普通看得更深');
  assert.ok(hard.exactEmpties >= normal.exactEmpties, '困難的精確殘局範圍不得小於普通');
});

test('簡單難度 AI 連下 30 局自我對局，每一步都必須是合法步', () => {
  const rng = mulberry32(20260911);
  let finished = 0;

  for (let game = 0; game < 30; game++) {
    let board = createInitialBoard();
    let player = BLACK;
    let plies = 0;

    for (let iter = 0; iter < 200; iter++) {
      if (isGameOver(board)) break;
      if (!hasLegalMove(board, player)) {
        player = -player;
        continue;
      }

      const sq = pickEasyMove(board, player, rng);
      assert.equal(typeof sq, 'number', `第 ${game} 局第 ${plies} 手回傳的不是格號：${sq}`);
      assert.equal(Number.isInteger(sq) && sq >= 0 && sq < 64, true,
        `第 ${game} 局第 ${plies} 手格號超出範圍：${sq}`);
      assert.equal(isLegalMove(board, sq, player), true,
        `第 ${game} 局第 ${plies} 手（${player === BLACK ? '黑' : '白'}）下出非法步 ${sq}\n${boardToString(board)}`);

      const applied = applyMove(board, sq, player);
      assert.ok(applied, `第 ${game} 局第 ${plies} 手 applyMove 不應回傳 null`);
      board = applied.board;
      player = -player;
      plies++;
    }

    assert.equal(isGameOver(board), true, `第 ${game} 局在 200 次迭代內未能結束`);
    assert.ok(plies >= 10, `第 ${game} 局只走了 ${plies} 手，明顯不正常`);
    finished++;
  }

  assert.equal(finished, 30);
});

test('pickEasyMove 使用傳入的 rng，同種子必得同結果且永遠合法', () => {
  const board = createInitialBoard();

  const a = pickEasyMove(board, BLACK, mulberry32(7));
  const b = pickEasyMove(board, BLACK, mulberry32(7));
  assert.equal(a, b, '同一組亂數種子必須產生相同的一手（測試才可決定）');
  assert.equal(isLegalMove(board, a, BLACK), true);

  // 只有一個合法步時無論亂數如何都只能選它
  const forced = boardFromString(NO_GAP_ROWS);
  assert.deepEqual(getLegalMoves(forced, BLACK), [0]);
  assert.equal(pickEasyMove(forced, BLACK, mulberry32(99)), 0);
});

test('createSearchTask 分片搜尋結束後會給出合法的最佳手', () => {
  const board = boardFromString(CORNER_BEST_ROWS);
  const task = createSearchTask(board, BLACK, {
    maxDepth: 4,
    timeBudgetMs: 2000,
    deterministic: true
  });

  assert.equal(typeof task.step, 'function', 'createSearchTask 必須提供 step()');

  let guard = 0;
  while (!task.done && guard < 2000) {
    task.step();
    guard++;
  }

  assert.equal(task.done, true, `分片搜尋必須在有限次 step() 內完成（已跑 ${guard} 次）`);
  assert.equal(typeof task.best, 'number', 'best 必須是格號');
  assert.equal(isLegalMove(board, task.best, BLACK), true, '分片搜尋的最佳手必須合法');
  assert.equal(task.best, 0, '同樣應該選擇 a1 角');
  assert.ok(task.nodes > 0);
  assert.ok(task.depth >= 1);
});

// ---------------------------------------------------------------------------
// F. 悔棋與存檔
// ---------------------------------------------------------------------------

test('undo 會把盤面與輪次退回人類上一手之前（人機模式連 AI 那手一起退）', () => {
  withStubEnv(() => {
    // 參考局面：只走了黑 d3、白 c3 兩手
    const reference = playMoves(makeApp({ saveGameState() {} }), [19, 18]);

    // 實際局面：再多走人類（黑）b3
    const app = playMoves(makeApp({ saveGameState() {} }), [19, 18, 17]);
    assert.equal(app.current, WHITE, '前置條件：三手後應輪到白');

    assert.equal(typeof app.undo, 'function', 'ReversiApp 必須提供 undo()');
    app.undo();

    assert.deepEqual(asArray(app.board), asArray(reference.board), '悔棋後盤面必須回到人類落子前');
    assert.equal(app.current, BLACK, '悔棋後必須輪回人類');
    assert.equal(app.history.length, 2, '悔棋後 history 長度必須是 2');
    assert.deepEqual(movesOf(app), [19, 18]);
  });
});

test('雙人同機模式的 undo 只退一手', () => {
  withStubEnv(() => {
    const app = playMoves(makeApp({ mode: 'duo', saveGameState() {} }), [19, 18, 17]);
    app.undo();
    assert.equal(app.history.length, 2, 'duo 模式只退一手');
    assert.equal(app.current, BLACK, '退掉黑方那手後應輪回黑方');
  });
});

test('在開局狀態下 undo 不會壞掉也不會產生副作用', () => {
  withStubEnv(() => {
    const app = makeApp({ saveGameState() {} });
    const snapshot = asArray(app.board);
    app.undo();
    assert.equal(app.history.length, 0);
    assert.deepEqual(asArray(app.board), snapshot, '開局悔棋不得改動盤面');
    assert.equal(app.current, BLACK);
  });
});

test('saveGameState 與 loadGameState 可完整 round-trip（走步序列 replay 後盤面一致）', () => {
  withStubEnv(store => {
    const moves = [19, 18, 17];
    let board = createInitialBoard();
    moves.forEach((sq, i) => {
      const applied = applyMove(board, sq, i % 2 === 0 ? BLACK : WHITE);
      assert.ok(applied, `建立測試局面時 ${sq} 應為合法步`);
      board = applied.board;
    });

    const saver = playMoves(makeApp({}), moves);
    assert.deepEqual(asArray(saver.board), asArray(board), '前置條件：兩種建構方式盤面應一致');
    saver.saveGameState();

    assert.ok(store.reversi_save_v1, '存檔必須寫進 reversi_save_v1');
    assert.deepEqual(JSON.parse(store.reversi_save_v1).moves, moves,
      '存檔應把 history 攤平成格號陣列');

    const loader = makeApp({
      board: createInitialBoard(),
      history: [],
      current: BLACK,
      humanColor: BLACK,
      aiColor: WHITE
    });
    assert.equal(loader.loadGameState(), true, '有合法存檔時 loadGameState 必須回傳 true');
    assert.deepEqual(asArray(loader.board), asArray(board), 'replay 後的盤面必須與原局完全一致');
    assert.deepEqual(movesOf(loader), moves, '走步序列必須完整還原');
    assert.equal(loader.current, WHITE, '還原後應輪到白方');

    // clearGameState 必須真的把存檔清掉
    loader.clearGameState();
    assert.ok(!store.reversi_save_v1, 'clearGameState 必須移除 reversi_save_v1');
  });
});

test('存檔中夾帶非法走步時 loadGameState 回傳 false 且不污染現有盤面', () => {
  withStubEnv(store => {
    // 19 是黑方合法步，但 0 對白方而言完全不合法
    // 直接寫入一份走步序列被竄改過的存檔（0 對白方而言完全不合法）
    store.reversi_save_v1 = JSON.stringify({
      v: 1,
      mode: 'ai',
      difficulty: 'normal',
      humanColor: BLACK,
      moves: [19, 0],
      hintsUsed: 0,
      undosUsed: 0
    });

    const app = makeApp({
      board: createInitialBoard(),
      history: [],
      current: BLACK,
      humanColor: BLACK,
      aiColor: WHITE
    });
    const snapshot = asArray(app.board);

    assert.equal(app.loadGameState(), false, 'replay 驗證失敗時必須回傳 false');
    assert.deepEqual(asArray(app.board), snapshot, '載入失敗不得污染現有盤面');
    assert.deepEqual(movesOf(app), [], '載入失敗不得污染走步序列');
  });
});

// ---------------------------------------------------------------------------
// G. 資源與結構
// ---------------------------------------------------------------------------

test('黑白棋頁面只記錄一次遊玩 (Stats.recordGamePlay)', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const js = fs.readFileSync(JS_PATH, 'utf8');
  const hits = (html + js).match(/Stats\.recordGamePlay\(\s*['"]reversi['"]\s*\)/g) || [];
  assert.equal(hits.length, 1, `Stats.recordGamePlay('reversi') 應只出現 1 次，實際 ${hits.length} 次`);
  assert.match(html, /\.\.\/\.\.\/assets\/js\/stats\.js/, '必須引用 ../../assets/js/stats.js');
  assert.match(html, /href="\.\.\/\.\.\/index\.html"/, '必須有回首頁連結');
});

test('index.html 具備 4 個預設隱藏的 modal-overlay 彈窗', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const overlays = html.match(/class="modal-overlay"[^>]*\shidden/g) || [];
  assert.equal(overlays.length, 4, `帶 hidden 的 modal-overlay 應恰好 4 個，實際 ${overlays.length} 個`);
});

test('index.html 具備三檔難度按鈕與所有必要的 HUD 元素', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');

  ['easy', 'normal', 'hard'].forEach(diff => {
    assert.match(html, new RegExp(`data-diff="${diff}"`), `缺少 data-diff="${diff}" 的難度按鈕`);
  });

  ['board', 'undo-btn', 'hint-btn', 'restart-btn', 'score-black', 'score-white', 'turn-text', 'legal-count']
    .forEach(id => {
      assert.match(html, new RegExp(`id="${id}"`), `缺少 id="${id}" 的元素`);
    });
});

test('reversi.js 具備契約規定的存檔 key 與三個生命週期方法', () => {
  const js = fs.readFileSync(JS_PATH, 'utf8');

  assert.match(js, /reversi_save_v1/, '必須使用 reversi_save_v1 作為存檔 key');
  assert.match(js, /reversi_stats_v1/, '必須使用 reversi_stats_v1 作為戰績 key');
  assert.match(js, /reversi_pref_v1/, '必須使用 reversi_pref_v1 作為偏好 key');
  assert.match(js, /bobo-home-preferences-v2/, '主題必須相容首頁的 bobo-home-preferences-v2');

  assert.match(js, /saveGameState\s*\(/, '應包含 saveGameState(');
  assert.match(js, /loadGameState\s*\(/, '應包含 loadGameState(');
  assert.match(js, /clearGameState\s*\(/, '應包含 clearGameState(');

});

// AGENTS.md 第 4 條「防禦性錯誤處理」的自動化守門。
// 注意：不可退回成 assert.match(js, /try\s*\{/) 這種寫法 —— 檔案裡另有十幾處
// 與 localStorage 無關的 try（_appNow、音效、prefersReducedMotion…），
// 只要有任何一處存在就會通過，等於完全沒測。
test('reversi.js 每一處 localStorage 讀寫刪都必須落在 try...catch 區塊內', () => {
  const js = fs.readFileSync(JS_PATH, 'utf8');
  const code = blankLiterals(js);

  // 掃描器自我檢查：塗白後整份檔案的大括號必須配平，
  // 否則（例如出現含大括號的正規表示式字面值）下面的判斷都不可信，寧可紅燈。
  let depth = 0;
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') depth -= 1;
  }
  assert.equal(depth, 0, '塗白後大括號不配平，靜態掃描結果不可信');

  // 只採計「後面真的接著 catch (」的 try 區塊，try…finally 不算有處理錯誤
  const guarded = tryBlockRanges(code).filter(
    ([, end]) => /^\s*catch\s*\(/.test(code.slice(end + 1, end + 40))
  );
  assert.ok(guarded.length > 0, 'reversi.js 必須至少有一個 try...catch');

  // localStorage.getItem / setItem / removeItem / clear 以及 localStorage[...] 全部要抓
  const accessRe = /localStorage\s*(?:\.\s*\w+|\[)/g;
  const accesses = [];
  let hit = accessRe.exec(code);
  while (hit) {
    accesses.push(hit.index);
    hit = accessRe.exec(code);
  }
  assert.ok(accesses.length >= 3,
    `應至少掃到 3 處 localStorage 存取，實際 ${accesses.length} 處（掃描規則可能已失效）`);

  const naked = accesses
    .filter(idx => !guarded.some(([start, end]) => idx > start && idx < end))
    .map(idx => lineOf(js, idx));
  assert.deepEqual(naked, [],
    `reversi.js 第 ${naked.join(' / ')} 行的 localStorage 存取沒有被 try...catch 包住`);
});

test('localStorage 全面拋錯時所有存取路徑都不得讓例外逸出', () => {
  withStubEnv(() => {
    // 必須在 withStubEnv 的 callback 內覆蓋，finally 的還原才會把它清掉，
    // 否則會漏到後面的測項去（其他測試會拿到一個只會拋錯的 localStorage）。
    const boom = () => { throw new Error('SecurityError'); };
    global.localStorage = {
      getItem: boom, setItem: boom, removeItem: boom, clear: boom
    };

    assert.doesNotThrow(() => {
      const app = playMoves(makeApp({}), [19]);

      assert.equal(app.saveGameState(), false, 'setItem 拋錯時 saveGameState 必須回傳 false');
      assert.equal(app.loadGameState(), false, 'getItem 拋錯時 loadGameState 必須回傳 false');
      app.clearGameState();

      const stats = app.loadStats();
      assert.ok(stats && stats.easy && stats.normal && stats.hard,
        'getItem 拋錯時 loadStats 必須回退成三檔預設戰績');
      app.saveStats(stats);
      app.recordResult();
      app.resetStats();

      app.loadPreferences();
      app.savePreferences();
      app.initTheme();
      app.toggleTheme();
    }, 'localStorage 拋錯時不得有任何例外逸出（Safari 無痕模式會這樣）');
  });
});

test('存檔／戰績／偏好被寫成壞 JSON 時只能回退預設值，不得 throw', () => {
  withStubEnv(store => {
    // 只有 getItem 會拋錯的話 JSON.parse 這條路徑測不到，所以另外測壞 JSON
    store.reversi_save_v1 = '{oops not json';
    store.reversi_stats_v1 = 'definitely not json';
    store.reversi_pref_v1 = '[[[';
    store['bobo-home-preferences-v2'] = '}{';

    const app = makeApp({});
    assert.doesNotThrow(() => {
      assert.equal(app.loadGameState(), false, '壞 JSON 必須被吞掉並回傳 false');
      const stats = app.loadStats();
      assert.ok(stats && stats.easy && stats.normal && stats.hard,
        '壞 JSON 時 loadStats 必須回退成三檔預設戰績');
      app.loadPreferences();
      app.initTheme();
    }, '壞 JSON 不得讓例外逸出（JSON.parse 必須也在 try 內）');
  });
});

test('AI 分片以 setTimeout + performance.now 驅動，不得使用 requestIdleCallback', () => {
  const js = fs.readFileSync(JS_PATH, 'utf8');
  assert.doesNotMatch(js, /requestIdleCallback/, '不得使用 requestIdleCallback');
  assert.match(js, /setTimeout\s*\(/, '必須以 setTimeout 分片');
  assert.match(js, /performance\.now\s*\(/, '必須以 performance.now 控制時間預算');
});

test('reversi.css 具備行動裝置點擊與翻子動畫所需的關鍵屬性', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  assert.match(css, /touch-action:\s*manipulation/, '必須設定 touch-action: manipulation');
  assert.match(css, /backface-visibility/, '翻子動畫必須處理 backface-visibility');
});
