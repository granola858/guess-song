const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const GAME_DIR = path.join(__dirname, '..', 'games', '2048');
const JS_PATH = path.join(GAME_DIR, '2048.js');
const HTML_PATH = path.join(GAME_DIR, 'index.html');
const CSS_PATH = path.join(GAME_DIR, '2048.css');

// 即使 2048.js 尚未完成，也只讓「斷言失敗」而不是整份測試檔炸掉
let moduleLoadError = null;
let core = {};
try {
  // eslint-disable-next-line global-require
  core = require(JS_PATH) || {};
} catch (err) {
  moduleLoadError = err;
}

const {
  DIR,
  DIR_NAMES,
  MODES,
  SIZE_CONFIG,
  BLITZ_CONFIG,
  UNDO_LIMIT,
  MAX_LEVEL,
  SLIDE_MS,
  POP_MS,
  SPAWN_MS,
  SWIPE,
  createRng,
  createInitialGrid,
  buildLines,
  computeMove,
  spawnTile,
  canMove,
  maxTile,
  isWin,
  isGameOver,
  levelOf,
  gridToValues,
  gridFromValues,
  valuesFromRows,
  lockSwipeAxis,
  resolveSwipe,
  SAVE_KEY,
  STATS_KEY,
  PREF_KEY,
  SKINS,
  EVOLVE_GLYPHS,
  Game2048
} = core;

// ---------------------------------------------------------------------------
// 契約第 4 節的精確匯出集合（= 第 3 節 CORE 全部符號 ＋ 第 9 節追加的三個
// 手勢符號 ＋ 第 4 節列出的 APP 符號）。多一個少一個都必須失敗。
// 注意：HOME_PREF_KEY 是 APP 段的 const，但契約的 module.exports 區塊並未列入，
// 所以它「不得」出現在匯出集合裡。
// ---------------------------------------------------------------------------
const EXPECTED_EXPORTS = [
  'DIR', 'DIR_NAMES', 'MODES', 'SIZE_CONFIG', 'BLITZ_CONFIG', 'UNDO_LIMIT', 'MAX_LEVEL',
  'SLIDE_MS', 'POP_MS', 'SPAWN_MS',
  'createRng', 'createInitialGrid', 'buildLines', 'computeMove', 'spawnTile', 'canMove',
  'maxTile', 'isWin', 'isGameOver', 'levelOf', 'gridToValues', 'gridFromValues', 'valuesFromRows',
  'SWIPE', 'lockSwipeAxis', 'resolveSwipe',
  'SAVE_KEY', 'STATS_KEY', 'PREF_KEY', 'SKINS', 'EVOLVE_GLYPHS', 'Game2048'
];

// ---------------------------------------------------------------------------
// 獨立於實作的小工具（刻意不使用 gridToValues，才能真的驗到它）
// ---------------------------------------------------------------------------

/** 讀出盤面的面值陣列；空格為 0 */
function readValues(grid) {
  return Array.from(grid, tile => (tile && typeof tile.value === 'number' ? tile.value : 0));
}

/** 讀出盤面的 id 陣列；空格為 0 */
function readIds(grid) {
  return Array.from(grid, tile => (tile && typeof tile.id === 'number' ? tile.id : 0));
}

/** 用 { index: [id, value] } 的對照表手工組一個盤面，id 完全由測試決定 */
function gridOfTiles(n, table) {
  const grid = new Array(n * n).fill(null);
  Object.keys(table).forEach(key => {
    const idx = Number(key);
    grid[idx] = { id: table[key][0], value: table[key][1] };
  });
  return grid;
}

/** 由 valuesFromRows 的列字串建盤面（id 由 gridFromValues 依序配發） */
function gridOfRows(rows, startId) {
  const built = gridFromValues(valuesFromRows(rows), startId === undefined ? 1 : startId);
  return built.grid;
}

/**
 * 第 0 條線（水平方向取第 0 列、垂直方向取第 0 行）
 * 由「靠牆端」往「遠端」數的第 k 個格號。
 * index = row * n + col，row 0 在最上、col 0 在最左。
 */
function indexOnLine(n, dir, k) {
  if (dir === DIR.LEFT) return k;                 // 牆在左：col 0,1,2…
  if (dir === DIR.RIGHT) return (n - 1) - k;      // 牆在右：col n-1,n-2…
  if (dir === DIR.UP) return k * n;               // 牆在上：row 0,1,2…
  return (n - 1 - k) * n;                         // 牆在下：row n-1,n-2…
}

/** 把「靠牆端 → 遠端」的一維面值序列鋪到第 0 條線上，其餘留空 */
function gridFromLine(n, dir, lineValues, startId) {
  const values = new Array(n * n).fill(0);
  lineValues.forEach((v, k) => { values[indexOnLine(n, dir, k)] = v; });
  return gridFromValues(values, startId === undefined ? 1 : startId).grid;
}

/** 依「靠牆端 → 遠端」讀回第 0 條線的面值序列 */
function readLine(n, dir, grid) {
  const out = [];
  for (let k = 0; k < n; k += 1) {
    const tile = grid[indexOnLine(n, dir, k)];
    out.push(tile && typeof tile.value === 'number' ? tile.value : 0);
  }
  return out;
}

/** 把「靠牆端 → 遠端」的期望序列展開成整盤期望面值 */
function expectedValuesFromLine(n, dir, lineValues) {
  const values = new Array(n * n).fill(0);
  lineValues.forEach((v, k) => { values[indexOnLine(n, dir, k)] = v; });
  return values;
}

const ALL_DIRS = () => [
  ['UP', DIR.UP], ['RIGHT', DIR.RIGHT], ['DOWN', DIR.DOWN], ['LEFT', DIR.LEFT]
];

function sortMoves(moves) {
  return Array.from(moves).map(m => ({
    id: m.id, from: m.from, to: m.to, dying: m.dying
  })).sort((a, b) => a.id - b.id);
}

function sortMerges(merges) {
  return Array.from(merges).map(m => ({
    keepId: m.keepId, to: m.to, value: m.value
  })).sort((a, b) => a.keepId - b.keepId);
}

// ---------------------------------------------------------------------------
// 假 DOM / 假 localStorage（測 UI 方法時不需要真 DOM）
// ---------------------------------------------------------------------------

function makeStyleStub() {
  const store = {};
  return {
    setProperty(name, value) { store[name] = value; },
    removeProperty(name) { delete store[name]; },
    getPropertyValue(name) { return store[name] || ''; },
    _store: store
  };
}

function makeElementStub() {
  const el = {
    style: makeStyleStub(),
    dataset: {},
    classList: {
      add() {}, remove() {}, toggle() {}, replace() {}, contains() { return false; }
    },
    textContent: '',
    innerHTML: '',
    value: '',
    hidden: false,
    disabled: false,
    children: [],
    firstChild: null,
    firstElementChild: null,
    offsetWidth: 0,
    setAttribute() {},
    removeAttribute() {},
    getAttribute() { return null; },
    hasAttribute() { return false; },
    appendChild(child) { return child; },
    removeChild(child) { return child; },
    replaceChildren() {},
    insertBefore(child) { return child; },
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    focus() {},
    click() {},
    remove() {},
    closest() { return null; },
    contains() { return false; },
    animate() { return { cancel() {}, finish() {} }; },
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
    Stats: global.Stats,
    requestAnimationFrame: global.requestAnimationFrame,
    cancelAnimationFrame: global.cancelAnimationFrame,
    navigator: global.navigator
  };

  global.document = {
    documentElement: makeElementStub(),
    body: makeElementStub(),
    hidden: false,
    visibilityState: 'visible',
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
  global.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
  global.cancelAnimationFrame = (handle) => clearTimeout(handle);
  if (!originals.navigator) global.navigator = { userAgent: 'node', vibrate() {} };

  try {
    return fn(store);
  } finally {
    global.document = originals.document;
    global.localStorage = originals.localStorage;
    global.Stats = originals.Stats;
    global.requestAnimationFrame = originals.requestAnimationFrame;
    global.cancelAnimationFrame = originals.cancelAnimationFrame;
    if (!originals.navigator) delete global.navigator;
  }
}

function requireApp() {
  assert.equal(typeof Game2048, 'function',
    `2048.js 必須匯出 Game2048 類別${moduleLoadError ? `（require 失敗：${moduleLoadError.message}）` : ''}`);
  return Game2048;
}

/**
 * 灌入假依賴的 Game2048 實例。
 * 契約第 0 節第 2 條要求「每個方法都要能容忍 this.el.xxx 為 undefined」，
 * 所以 el 刻意留成空物件 —— 這本身就是一項驗收。
 */
function makeApp(extra) {
  requireApp();
  const app = Object.create(Game2048.prototype);
  Object.assign(app, {
    mode: MODES.CLASSIC,
    size: 4,
    n: 4,
    grid: createInitialGrid(4),
    score: 0,
    best: 0,
    bestScore: 0,
    moveCount: 0,
    nextId: 1,
    undosUsed: 0,
    hintsUsed: 0,
    continued: false,
    won: false,
    gameOver: false,
    locked: false,
    blitzLeftMs: BLITZ_CONFIG ? BLITZ_CONFIG.startMs : 90000,
    startedAt: 1700000000000,
    skin: SKINS ? SKINS.NUMBER : 'number',
    glyphOnly: false,
    sound: false,
    nodes: new Map(),
    dying: [],
    pendingMerges: [],
    pendingSpawn: null,
    commitTimer: null,
    blitzTimer: null,
    gesture: null,
    rng: Math.random,
    el: {}
  }, extra);
  return app;
}

/**
 * 契約沒有指定「執行悔棋」與「結算戰績」這兩個方法的名字，
 * 這裡在 prototype 上找第一個存在的候選名，找不到就給出明確的失敗訊息。
 */
function pickMethod(candidates, purpose, exclude) {
  requireApp();
  const found = candidates.filter(name => (
    (!exclude || exclude.indexOf(name) === -1)
    && typeof Game2048.prototype[name] === 'function'
  ));
  assert.ok(found.length > 0,
    `Game2048.prototype 找不到「${purpose}」的方法。`
    + `契約未指定名稱，測試接受下列任一候選：${candidates.join(' / ')}`);
  return found[0];
}

/** pushUndo() 之後，找出承接 UndoSnapshot 的那個欄位名 */
function isSnapshotShaped(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Array.isArray(value.values)
    && typeof value.score === 'number'
    && typeof value.nextId === 'number'
    && typeof value.moveCount === 'number';
}

function findSnapshotField(app) {
  const keys = Object.keys(app);
  for (let i = 0; i < keys.length; i += 1) {
    if (isSnapshotShaped(app[keys[i]])) return keys[i];
  }
  return null;
}

/** 實例上所有「長得像 UndoSnapshot」的欄位（含藏在陣列裡的） */
function countSnapshots(app) {
  let count = 0;
  Object.keys(app).forEach(key => {
    const value = app[key];
    if (isSnapshotShaped(value)) count += 1;
    else if (Array.isArray(value)) value.forEach(item => { if (isSnapshotShaped(item)) count += 1; });
  });
  return count;
}

/** 實例上所有陣列欄位的長度快照 */
function arrayLengths(app) {
  const out = {};
  Object.keys(app).forEach(key => {
    if (Array.isArray(app[key])) out[key] = app[key].length;
  });
  return out;
}

function zeroBucket() {
  return {
    plays: 0,
    bestScore: 0,
    practiceBestScore: 0,
    bestTile: 0,
    targetHits: 0,
    fewestMovesToTarget: 0,
    fastestMs: 0,
    streak: 0,
    bestStreak: 0
  };
}

function zeroStats() {
  return {
    classic: { 3: zeroBucket(), 4: zeroBucket(), 5: zeroBucket() },
    blitz: { plays: 0, bestScore: 0, longestSurvivalMs: 0, bestChain: 0 },
    global: { totalMerges: 0, totalMoves: 0, totalPlays: 0, achievements: [] }
  };
}

// ---------------------------------------------------------------------------
// 靜態掃描工具（跨檔案對齊用）
// ---------------------------------------------------------------------------

function readOrNull(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return null;
  }
}

function needFile(filePath) {
  const text = readOrNull(filePath);
  assert.ok(text !== null, `${filePath} 尚未建立（實作未完成）`);
  return text;
}

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** 把 CSS 拆成 { rules: [{selector, body}], keyframes: [{prelude, body}] } */
function parseCss(src, out) {
  const acc = out || { rules: [], keyframes: [] };
  const n = src.length;
  let i = 0;
  let buf = '';
  while (i < n) {
    const ch = src[i];
    if (ch === '{') {
      const prelude = buf.trim();
      buf = '';
      let depth = 1;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '{') depth += 1;
        else if (src[j] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
        j += 1;
      }
      const body = src.slice(i + 1, j);
      if (/^@(-webkit-|-moz-)?keyframes\b/i.test(prelude)) {
        acc.keyframes.push({ prelude, body });
      } else if (/^@(media|supports|layer|container|scope|document)\b/i.test(prelude)) {
        parseCss(body, acc);
      } else if (prelude.charAt(0) !== '@') {
        acc.rules.push({ selector: prelude, body });
      }
      i = j + 1;
      continue;
    }
    if (ch === '}' || ch === ';') { buf = ''; i += 1; continue; }
    buf += ch;
    i += 1;
  }
  return acc;
}

function classesInSelector(selector) {
  const out = [];
  const re = /\.(-?[_a-zA-Z][\w-]*)/g;
  let m = re.exec(selector);
  while (m) {
    out.push(m[1]);
    m = re.exec(selector);
  }
  return out;
}

/** 選擇器最後一段複合選擇器（用來判斷 @keyframes 掛在誰身上） */
function lastCompound(selector) {
  const parts = selector.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function addTokens(set, raw) {
  String(raw).split(/\s+/).forEach(token => {
    if (!token) return;
    if (token.indexOf('$') !== -1 || token.indexOf('{') !== -1) return;
    set.add(token);
  });
}

function collectHtmlClasses(html) {
  const set = new Set();
  let m;
  const dq = /\bclass\s*=\s*"([^"]*)"/g;
  m = dq.exec(html);
  while (m) { addTokens(set, m[1]); m = dq.exec(html); }
  const sq = /\bclass\s*=\s*'([^']*)'/g;
  m = sq.exec(html);
  while (m) { addTokens(set, m[1]); m = sq.exec(html); }
  return set;
}

function collectJsClasses(js) {
  const set = new Set();
  let m;

  const listCall = /classList\s*\.\s*(?:add|remove|toggle|contains|replace)\s*\(([^)]*)\)/g;
  m = listCall.exec(js);
  while (m) {
    const args = m[1];
    const lit = /['"`]([^'"`]*)['"`]/g;
    let a = lit.exec(args);
    while (a) { addTokens(set, a[1]); a = lit.exec(args); }
    m = listCall.exec(js);
  }

  const nameAssign = /className\s*\+?=\s*['"`]([^'"`]*)['"`]/g;
  m = nameAssign.exec(js);
  while (m) { addTokens(set, m[1]); m = nameAssign.exec(js); }

  const setAttr = /setAttribute\s*\(\s*['"`]class['"`]\s*,\s*['"`]([^'"`]*)['"`]/g;
  m = setAttr.exec(js);
  while (m) { addTokens(set, m[1]); m = setAttr.exec(js); }

  // 樣板字串裡的 class="..." / class='...'
  const inline = /\bclass\s*=\s*\\?"([^"]*)"/g;
  m = inline.exec(js);
  while (m) { addTokens(set, m[1]); m = inline.exec(js); }
  const inlineSq = /\bclass\s*=\s*\\?'([^']*)'/g;
  m = inlineSq.exec(js);
  while (m) { addTokens(set, m[1]); m = inlineSq.exec(js); }

  // querySelector('.foo') / closest('.foo') / matches('.foo')
  const sel = /(?:querySelector|querySelectorAll|closest|matches)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  m = sel.exec(js);
  while (m) {
    classesInSelector(m[1]).forEach(c => set.add(c));
    m = sel.exec(js);
  }

  return set;
}

// ---------------------------------------------------------------------------
// 0. 模組載入與硬性規則
// ---------------------------------------------------------------------------

test('2048.js 可被 require，且 module.exports 是契約第 4 節的精確集合', () => {
  assert.equal(moduleLoadError, null,
    `require('${JS_PATH}') 失敗：${moduleLoadError && moduleLoadError.message}`);

  const actual = Object.keys(core).sort();
  const expected = EXPECTED_EXPORTS.slice().sort();

  const missing = expected.filter(k => actual.indexOf(k) === -1);
  const extra = actual.filter(k => expected.indexOf(k) === -1);
  assert.deepEqual(missing, [], `module.exports 少了：${missing.join(', ')}`);
  assert.deepEqual(extra, [], `module.exports 多了契約沒有的符號：${extra.join(', ')}`);
  assert.deepEqual(actual, expected);

  [
    'createRng', 'createInitialGrid', 'buildLines', 'computeMove', 'spawnTile', 'canMove',
    'maxTile', 'isWin', 'isGameOver', 'levelOf', 'gridToValues', 'gridFromValues',
    'valuesFromRows', 'lockSwipeAxis', 'resolveSwipe'
  ].forEach(name => {
    assert.equal(typeof core[name], 'function', `${name} 必須是函式`);
  });
  assert.equal(typeof Game2048, 'function', 'Game2048 必須是類別');
});

test('2048.js 通過 new Function(source)，無 IIFE 包裹、無舊集中式路徑、檔尾雙重守衛', () => {
  const src = needFile(JS_PATH);

  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new-func
    new Function(src);
  }, '2048.js 必須能通過 new Function(source)：不可有頂層 import / export');

  assert.doesNotMatch(src, /^\s*[;!+(]*\s*\(\s*function\s*\(/m,
    '絕對不可用 IIFE 包裹（會讓 require 拿不到東西）');
  assert.doesNotMatch(src, /^\s*\(\s*\(\s*\)\s*=>/m, '絕對不可用箭頭函式 IIFE 包裹');
  assert.doesNotMatch(src, /["'(]assets\//,
    '不得出現「引號或左括號緊接 assets/」的舊集中式路徑');

  assert.match(src, /typeof\s+window\s*!==\s*['"]undefined['"]/,
    '檔尾必須有 window 環境守衛');
  assert.match(src, /DOMContentLoaded/, '檔尾必須以 DOMContentLoaded 啟動');
  assert.match(src, /typeof\s+module\s*!==\s*['"]undefined['"]\s*&&\s*module\.exports/,
    '檔尾必須有 module.exports 環境守衛');
});

// ---------------------------------------------------------------------------
// A. 常數必須與契約逐字相同
// ---------------------------------------------------------------------------

test('DIR / DIR_NAMES / MODES 的值與契約完全相同', () => {
  assert.deepEqual(DIR, { UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 });
  assert.equal(Object.isFrozen(DIR), true, 'DIR 必須是凍結物件');

  assert.deepEqual(DIR_NAMES, ['up', 'right', 'down', 'left']);
  assert.equal(DIR_NAMES[DIR.UP], 'up');
  assert.equal(DIR_NAMES[DIR.RIGHT], 'right');
  assert.equal(DIR_NAMES[DIR.DOWN], 'down');
  assert.equal(DIR_NAMES[DIR.LEFT], 'left');

  assert.deepEqual(MODES, { CLASSIC: 'classic', BLITZ: 'blitz' });
  assert.deepEqual(SKINS, { NUMBER: 'number', EVOLVE: 'evolve' });

  assert.equal(SAVE_KEY, 'g2048_save_v1');
  assert.equal(STATS_KEY, 'g2048_stats_v1');
  assert.equal(PREF_KEY, 'g2048_pref_v1');
});

test('SIZE_CONFIG 三檔的 size / target / milestone / spawn4Rate / startTiles / 文案與契約完全相同', () => {
  assert.deepEqual(Object.keys(SIZE_CONFIG).sort(), ['3', '4', '5'],
    'SIZE_CONFIG 必須剛好有 3 / 4 / 5 三檔');

  assert.deepEqual(SIZE_CONFIG[3], {
    size: 3, target: 128, milestone: 64, spawn4Rate: 0, startTiles: 2,
    label: '3×3 口袋局', hint: '只會生成 2，零容錯'
  });
  assert.deepEqual(SIZE_CONFIG[4], {
    size: 4, target: 2048, milestone: 1024, spawn4Rate: 0.10, startTiles: 2,
    label: '4×4 正統局', hint: '原汁原味的 2048'
  });
  assert.deepEqual(SIZE_CONFIG[5], {
    size: 5, target: 4096, milestone: 2048, spawn4Rate: 0.20, startTiles: 2,
    label: '5×5 大局', hint: '格子多、局也長'
  });
});

test('每一檔的里程碑都必須小於目標，且兩者都是 2 的冪', () => {
  [3, 4, 5].forEach(n => {
    const cfg = SIZE_CONFIG[n];
    assert.ok(cfg.milestone < cfg.target,
      `${n}×${n} 的里程碑 ${cfg.milestone} 必須小於目標 ${cfg.target}`);
    assert.ok(levelOf(cfg.milestone) > 0, `${n}×${n} 的里程碑必須是 2 的冪`);
    assert.ok(levelOf(cfg.target) > 0, `${n}×${n} 的目標必須是 2 的冪`);
    // 里程碑至少要是目標的 1/4，否則太容易、失去階段目標的意義
    assert.ok(cfg.milestone * 4 >= cfg.target,
      `${n}×${n} 的里程碑 ${cfg.milestone} 不該低於目標的 1/4`);
  });
});

test('BLITZ_CONFIG / UNDO_LIMIT / MAX_LEVEL / EVOLVE_GLYPHS 與契約完全相同', () => {
  assert.deepEqual(BLITZ_CONFIG, {
    size: 4,
    startMs: 90000,
    maxMs: 180000,
    perLevelMs: 400,
    chainThreshold: 3,
    chainBonusMs: 1500
  });

  assert.equal(UNDO_LIMIT, 3);
  assert.equal(MAX_LEVEL, 17);
  assert.equal(Math.pow(2, MAX_LEVEL), 131072, 'MAX_LEVEL 必須對應 131072');

  assert.deepEqual(EVOLVE_GLYPHS, {
    2: '🦠', 4: '🐟', 8: '🐸', 16: '🦎', 32: '🐕', 64: '🐒', 128: '🧑',
    256: '🏛️', 512: '🚀', 1024: '🪐', 2048: '🌌', 4096: '🕳️', 8192: '♾️'
  });
});

test('SLIDE_MS / POP_MS / SPAWN_MS 與契約完全相同', () => {
  assert.equal(SLIDE_MS, 110);
  assert.equal(POP_MS, 180);
  assert.equal(SPAWN_MS, 140);
});

test('SWIPE 的八個門檻與契約完全相同', () => {
  assert.deepEqual(SWIPE, {
    AXIS_LOCK: 10,
    MIN_DISTANCE: 24,
    MIN_DISTANCE_MOUSE: 32,
    FLICK_DISTANCE: 12,
    FLICK_VELOCITY: 0.35,
    AXIS_RATIO: 1.4,
    MAX_DURATION: 1500,
    VELOCITY_WINDOW: 80
  });
});

// ---------------------------------------------------------------------------
// B. 基礎工具
// ---------------------------------------------------------------------------

test('createInitialGrid / gridToValues / gridFromValues 的形狀與 id 配發正確', () => {
  const grid = createInitialGrid(4);
  assert.equal(Array.isArray(grid), true, 'createInitialGrid 必須回傳一般陣列');
  assert.equal(grid.length, 16);
  grid.forEach((cell, i) => assert.equal(cell, null, `格號 ${i} 應為 null`));
  assert.equal(createInitialGrid(3).length, 9);
  assert.equal(createInitialGrid(5).length, 25);

  assert.deepEqual(gridToValues(createInitialGrid(3)), [0, 0, 0, 0, 0, 0, 0, 0, 0]);

  // gridFromValues 依序（依格號）配發 id，空格不佔 id
  const built = gridFromValues([2, 0, 4, 0, 0, 0, 0, 0, 8], 5);
  assert.equal(built.grid.length, 9);
  assert.deepEqual(readValues(built.grid), [2, 0, 4, 0, 0, 0, 0, 0, 8]);
  assert.deepEqual(readIds(built.grid), [5, 0, 6, 0, 0, 0, 0, 0, 7]);
  assert.equal(built.nextId, 8, '配發 3 顆磚之後 nextId 必須是 5 + 3');
  assert.equal(built.grid[1], null, '空格必須是 null，不可是 0 或 undefined');

  // gridToValues 是 gridFromValues 的逆運算
  assert.deepEqual(gridToValues(built.grid), [2, 0, 4, 0, 0, 0, 0, 0, 8]);

  const emptyBuilt = gridFromValues([0, 0, 0, 0], 1);
  assert.equal(emptyBuilt.nextId, 1, '沒有任何磚時 nextId 不得前進');
});

test('valuesFromRows 支援空白、逗號、點號與單一多行字串', () => {
  const expected = [2, 2, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 2];

  assert.deepEqual(valuesFromRows([
    '2 2 4 0',
    '0 0 0 0',
    '. . . .',
    '4 0 0 2'
  ]), expected, '契約第 3 節的範例必須逐字成立');

  assert.deepEqual(valuesFromRows([
    '2,2,4,0',
    '0,0,0,0',
    '.,.,.,.',
    '4,0,0,2'
  ]), expected, '逗號分隔必須等價');

  assert.deepEqual(valuesFromRows('2 2 4 0\n0 0 0 0\n. . . .\n4 0 0 2'), expected,
    '單一多行字串必須等價');

  assert.deepEqual(valuesFromRows(['2 4 8', '. . .', '0 0 16']),
    [2, 4, 8, 0, 0, 0, 0, 0, 16], '3×3 也要支援');

  assert.deepEqual(valuesFromRows([[2, 4], [8, 0]]), [2, 4, 8, 0],
    'rows 也可以是陣列');
});

test('levelOf 對 2 的冪回層級，其餘一律回 0', () => {
  const pairs = [
    [2, 1], [4, 2], [8, 3], [16, 4], [32, 5], [64, 6], [128, 7], [256, 8],
    [512, 9], [1024, 10], [2048, 11], [4096, 12], [8192, 13], [16384, 14],
    [32768, 15], [65536, 16], [131072, 17]
  ];
  pairs.forEach(([value, level]) => {
    assert.equal(levelOf(value), level, `levelOf(${value}) 應為 ${level}`);
  });
  assert.equal(levelOf(131072), MAX_LEVEL, '配色表必須涵蓋到 MAX_LEVEL');

  [0, 1, 3, 5, 6, 7, 12, 100, -2, -4, 2.5, NaN].forEach(value => {
    assert.equal(levelOf(value), 0, `levelOf(${value}) 應為 0`);
  });
});

test('buildLines 四個方向都由靠牆端往遠端排序', () => {
  const toArrays = (lines) => Array.from(lines, line => Array.from(line, Number))
    .sort((a, b) => a[0] - b[0]);

  assert.deepEqual(toArrays(buildLines(4, DIR.LEFT)), [
    [0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15]
  ], '向左：每列由 col 0 往 col 3');

  assert.deepEqual(toArrays(buildLines(4, DIR.RIGHT)), [
    [3, 2, 1, 0], [7, 6, 5, 4], [11, 10, 9, 8], [15, 14, 13, 12]
  ], '向右：每列由 col 3 往 col 0');

  assert.deepEqual(toArrays(buildLines(4, DIR.UP)), [
    [0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15]
  ], '向上：每行由 row 0 往 row 3');

  assert.deepEqual(toArrays(buildLines(4, DIR.DOWN)), [
    [12, 8, 4, 0], [13, 9, 5, 1], [14, 10, 6, 2], [15, 11, 7, 3]
  ], '向下：每行由 row 3 往 row 0');

  [3, 4, 5].forEach(n => {
    ALL_DIRS().forEach(([name, dir]) => {
      const lines = buildLines(n, dir);
      assert.equal(lines.length, n, `${n}×${n} 的 ${name} 必須有 ${n} 條線`);
      const seen = new Set();
      Array.from(lines).forEach(line => {
        assert.equal(line.length, n, `${n}×${n} 的 ${name} 每條線必須有 ${n} 格`);
        Array.from(line).forEach(idx => seen.add(Number(idx)));
      });
      assert.equal(seen.size, n * n, `${n}×${n} 的 ${name} 必須不重不漏覆蓋所有格子`);
    });
  });
});

test('createRng 同種子必得同序列、不同種子分歧、值落在 [0,1)', () => {
  const a = createRng(20260911);
  const b = createRng(20260911);
  const c = createRng(20260912);

  const seqA = [];
  const seqB = [];
  const seqC = [];
  for (let i = 0; i < 50; i += 1) {
    seqA.push(a());
    seqB.push(b());
    seqC.push(c());
  }

  assert.deepEqual(seqA, seqB, '同一組種子必須產生完全相同的序列');
  assert.notDeepEqual(seqA, seqC, '不同種子必須產生不同的序列');

  seqA.forEach((v, i) => {
    assert.equal(typeof v, 'number', `第 ${i} 個取樣不是數字`);
    assert.ok(v >= 0 && v < 1, `第 ${i} 個取樣 ${v} 超出 [0,1)`);
  });

  const rng = createRng(7);
  let sum = 0;
  for (let i = 0; i < 4000; i += 1) sum += rng();
  const mean = sum / 4000;
  assert.ok(mean > 0.45 && mean < 0.55, `平均值 ${mean} 偏離太多，分佈不像均勻亂數`);
});

// ---------------------------------------------------------------------------
// C. computeMove —— 全份測試最重要的一段
// ---------------------------------------------------------------------------

test('四個方向的幾何：單顆磚會滑到正確的那面牆', () => {
  // 4×4，單顆 2 放在 row 2 / col 2（格號 10）
  const cases = [
    ['UP', DIR.UP, 2],       // row 0, col 2
    ['RIGHT', DIR.RIGHT, 11], // row 2, col 3
    ['DOWN', DIR.DOWN, 14],  // row 3, col 2
    ['LEFT', DIR.LEFT, 8]    // row 2, col 0
  ];

  cases.forEach(([name, dir, target]) => {
    const grid = gridOfTiles(4, { 10: [77, 2] });
    const plan = computeMove(grid, 4, dir);

    assert.equal(plan.changed, true, `${name}：磚塊應該要能移動`);
    const values = new Array(16).fill(0);
    values[target] = 2;
    assert.deepEqual(readValues(plan.next), values,
      `${name}：磚塊應該停在格號 ${target}`);
    assert.equal(plan.next[target].id, 77, `${name}：id 必須跟著磚塊走`);
    assert.deepEqual(sortMoves(plan.moves), [{ id: 77, from: 10, to: target, dying: false }],
      `${name}：moves 必須記錄 10 → ${target}`);
    assert.deepEqual(sortMerges(plan.merges), [], `${name}：沒有合併`);
    assert.equal(plan.gained, 0);
    assert.equal(plan.mergeCount, 0);
  });
});

test('契約第 2 節的七條驗收用例在四個方向都成立', () => {
  // 以「靠牆端 → 遠端」表示，四個方向共用同一組期望值
  const CASES = [
    { input: [2, 2, 2, 2], expect: [4, 4, 0, 0], gained: 8, merges: 2, max: 4 },
    { input: [4, 4, 4, 4], expect: [8, 8, 0, 0], gained: 16, merges: 2, max: 8 },
    { input: [2, 2, 2, 0], expect: [4, 2, 0, 0], gained: 4, merges: 1, max: 4 },
    { input: [2, 2, 4, 0], expect: [4, 4, 0, 0], gained: 4, merges: 1, max: 4 },
    { input: [4, 2, 2, 0], expect: [4, 4, 0, 0], gained: 4, merges: 1, max: 4 },
    { input: [2, 0, 2, 4], expect: [4, 4, 0, 0], gained: 4, merges: 1, max: 4 },
    { input: [0, 0, 0, 2], expect: [2, 0, 0, 0], gained: 0, merges: 0, max: 0 }
  ];

  ALL_DIRS().forEach(([dirName, dir]) => {
    CASES.forEach(c => {
      const label = `${dirName} [${c.input.join(',')}]`;
      const grid = gridFromLine(4, dir, c.input, 1);
      const plan = computeMove(grid, 4, dir);

      assert.deepEqual(readLine(4, dir, plan.next), c.expect,
        `${label} 應得 [${c.expect.join(',')}]`);
      assert.deepEqual(readValues(plan.next), expectedValuesFromLine(4, dir, c.expect),
        `${label}：其他格子不得被污染`);
      assert.equal(plan.changed, true, `${label}：盤面確實有變化`);
      assert.equal(plan.gained, c.gained, `${label}：gained 應為 ${c.gained}`);
      assert.equal(plan.mergeCount, c.merges, `${label}：mergeCount 應為 ${c.merges}`);
      assert.equal(plan.maxMerged, c.max, `${label}：maxMerged 應為 ${c.max}`);
      assert.equal(plan.merges.length, c.merges, `${label}：merges 筆數應為 ${c.merges}`);
    });
  });

  // 3×3 的 [2,2,2] → [4,2]（合併鎖在較短的線上同樣成立）
  ALL_DIRS().forEach(([dirName, dir]) => {
    const grid = gridFromLine(3, dir, [2, 2, 2], 1);
    const plan = computeMove(grid, 3, dir);
    assert.deepEqual(readLine(3, dir, plan.next), [4, 2, 0],
      `${dirName} 3×3 [2,2,2] 必須得到 [4,2]，不可是 [4,4] 或 [2,4]`);
    assert.equal(plan.gained, 4);
    assert.equal(plan.mergeCount, 1);
  });
});

test('computeMove 不得 mutate 傳入的 grid（連磚塊物件的 value 都不能動）', () => {
  // 悔棋快照是在 computeMove 之後、grid 換成 next 之前才拍的，
  // 若 computeMove 就地把存活者的 value 加倍，快照就會被寫壞。
  const grid = gridOfRows([
    '2 2 4 4',
    '8 8 0 0',
    '0 0 0 0',
    '16 16 16 0'
  ], 1);

  const beforeRefs = grid.slice();
  const beforeValues = readValues(grid);
  const beforeIds = readIds(grid);
  const beforeTiles = grid.map(t => (t ? { id: t.id, value: t.value } : null));

  const plan = computeMove(grid, 4, DIR.LEFT);

  assert.notEqual(plan.next, grid, 'next 必須是新陣列');
  assert.deepEqual(grid, beforeRefs, '傳入的 grid 陣列內容（磚塊參考）不得改變');
  assert.deepEqual(readValues(grid), beforeValues, '傳入 grid 的面值不得改變');
  assert.deepEqual(readIds(grid), beforeIds, '傳入 grid 的 id 不得改變');
  grid.forEach((tile, i) => {
    if (!beforeTiles[i]) {
      assert.equal(tile, null, `格號 ${i} 原本是空的，不得被填入`);
      return;
    }
    assert.equal(tile.id, beforeTiles[i].id, `格號 ${i} 的 id 被改掉了`);
    assert.equal(tile.value, beforeTiles[i].value,
      `格號 ${i} 的磚塊 value 被就地加倍了 —— 悔棋快照會被寫壞`);
  });

  // 再跑一次必須得到一模一樣的結果（證明沒有殘留狀態）
  const again = computeMove(grid, 4, DIR.LEFT);
  assert.deepEqual(readValues(again.next), readValues(plan.next));
  assert.equal(again.gained, plan.gained);
});

test('[2,2,2,2] 向左：merges.keepId 是靠牆端那顆、moves.dying 是被吃掉那顆', () => {
  // 第 0 列放四顆 2，id 由測試指定：格號 0→101、1→102、2→103、3→104
  const grid = gridOfTiles(4, { 0: [101, 2], 1: [102, 2], 2: [103, 2], 3: [104, 2] });
  const plan = computeMove(grid, 4, DIR.LEFT);

  assert.equal(plan.changed, true);
  assert.deepEqual(readValues(plan.next), [4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(readIds(plan.next), [101, 103, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    '存活者必須是靠牆端的 101 與 103');

  assert.deepEqual(sortMerges(plan.merges), [
    { keepId: 101, to: 0, value: 4 },
    { keepId: 103, to: 1, value: 4 }
  ], 'keepId 必須是靠牆端那顆；value 必須是合併後的新面值');

  assert.deepEqual(sortMoves(plan.moves), [
    { id: 102, from: 1, to: 0, dying: true },
    { id: 103, from: 2, to: 1, dying: false },
    { id: 104, from: 3, to: 1, dying: true }
  ], '沒動又沒死的 101 不得列入 moves；被吃掉的 102 / 104 必須 dying: true');

  assert.equal(plan.gained, 8);
  assert.equal(plan.mergeCount, 2);
  assert.equal(plan.maxMerged, 4);

  // [0,2,2,0]：靠牆端是格號 1 那顆
  const pair = gridOfTiles(4, { 1: [201, 2], 2: [202, 2] });
  const plan2 = computeMove(pair, 4, DIR.LEFT);
  assert.deepEqual(sortMerges(plan2.merges), [{ keepId: 201, to: 0, value: 4 }],
    '中間兩顆合併時，存活者是比較靠左的 201');
  assert.deepEqual(sortMoves(plan2.moves), [
    { id: 201, from: 1, to: 0, dying: false },
    { id: 202, from: 2, to: 0, dying: true }
  ]);
  assert.equal(plan2.next[0].id, 201);
  assert.equal(plan2.next[0].value, 4);
});

test('[2,2,2,2] 向右：存活者換成右側那顆（keepId 不可永遠取小 index）', () => {
  const grid = gridOfTiles(4, { 0: [101, 2], 1: [102, 2], 2: [103, 2], 3: [104, 2] });
  const plan = computeMove(grid, 4, DIR.RIGHT);

  assert.deepEqual(readValues(plan.next), [0, 0, 4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(readIds(plan.next), [0, 0, 102, 104, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    '向右時靠牆端是 104 與 102');

  assert.deepEqual(sortMerges(plan.merges), [
    { keepId: 102, to: 2, value: 4 },
    { keepId: 104, to: 3, value: 4 }
  ], '向右時 keepId 必須是格號較大的那顆');

  assert.deepEqual(sortMoves(plan.moves), [
    { id: 101, from: 0, to: 2, dying: true },
    { id: 102, from: 1, to: 2, dying: false },
    { id: 103, from: 2, to: 3, dying: true }
  ], '沒動又沒死的 104 不得列入 moves');

  assert.equal(plan.gained, 8);
  assert.equal(plan.mergeCount, 2);
  assert.equal(plan.maxMerged, 4);
});

test('撞牆時 changed 為 false，且沒有任何 moves / merges / gained', () => {
  // 第 0 列 [2,4,8,16] 已經貼左牆且相鄰皆不同值
  const row = gridOfTiles(4, { 0: [1, 2], 1: [2, 4], 2: [3, 8], 3: [4, 16] });
  const plan = computeMove(row, 4, DIR.LEFT);

  assert.equal(plan.changed, false, '已經貼牆且無法合併 → changed 必須是 false');
  assert.deepEqual(Array.from(plan.moves), [], 'changed 為 false 時不得有任何 moves');
  assert.deepEqual(Array.from(plan.merges), [], 'changed 為 false 時不得有任何 merges');
  assert.equal(plan.gained, 0);
  assert.equal(plan.mergeCount, 0);
  assert.equal(plan.maxMerged, 0);
  assert.deepEqual(readValues(plan.next), readValues(row), 'next 的面值應與原盤相同');

  // 全滿且四個方向都動不了
  const stuck = gridOfRows([
    '2 4 2 4',
    '4 2 4 2',
    '2 4 2 4',
    '4 2 4 2'
  ], 1);
  ALL_DIRS().forEach(([name, dir]) => {
    const p = computeMove(stuck, 4, dir);
    assert.equal(p.changed, false, `${name}：這個交錯盤面四個方向都不該動`);
    assert.equal(p.moves.length, 0, `${name}：不得有 moves`);
    assert.equal(p.merges.length, 0, `${name}：不得有 merges`);
    assert.equal(p.gained, 0, `${name}：不得有 gained`);
  });
});

test('gained / mergeCount / maxMerged 在多列同時合併時正確', () => {
  // 向左：
  //   [2,2,4,4]  → [4,8]    得分 4 + 8 = 12，2 組
  //   [8,8,0,0]  → [16]     得分 16，1 組
  //   [0,0,0,0]  → 不動
  //   [16,16,16,0] → [32,16] 得分 32，1 組
  // 合計 gained 60、mergeCount 4、maxMerged 32
  const grid = gridOfRows([
    '2 2 4 4',
    '8 8 0 0',
    '0 0 0 0',
    '16 16 16 0'
  ], 1);

  const plan = computeMove(grid, 4, DIR.LEFT);

  assert.deepEqual(readValues(plan.next), valuesFromRows([
    '4 8 0 0',
    '16 0 0 0',
    '0 0 0 0',
    '32 16 0 0'
  ]));
  assert.equal(plan.changed, true);
  assert.equal(plan.gained, 60, 'gained = 4 + 8 + 16 + 32');
  assert.equal(plan.mergeCount, 4, '共四組合併');
  assert.equal(plan.maxMerged, 32, '本次最大的合併面值是 32');
  assert.equal(plan.merges.length, 4);

  // gained 必須等於 merges 裡所有 value 的總和
  const sum = Array.from(plan.merges).reduce((acc, m) => acc + m.value, 0);
  assert.equal(plan.gained, sum, 'gained 必須等於所有合併後新面值的總和');
  const maxValue = Array.from(plan.merges).reduce((acc, m) => Math.max(acc, m.value), 0);
  assert.equal(plan.maxMerged, maxValue);
});

// ---------------------------------------------------------------------------
// D. 生成與終局
// ---------------------------------------------------------------------------

test('spawnTile 傳入 rng 時完全不呼叫 Math.random', () => {
  const originalRandom = Math.random;
  let calls = 0;
  Math.random = () => { calls += 1; return originalRandom(); };
  try {
    for (let i = 0; i < 20; i += 1) {
      const grid = createInitialGrid(4);
      const rng = createRng(1000 + i);
      const result = spawnTile(grid, 4, 1, 0.10, rng);
      assert.ok(result, 'spawnTile 在有空格時不得回傳 null');
    }
  } finally {
    Math.random = originalRandom;
  }
  assert.equal(calls, 0,
    `spawnTile 必須完全靠傳入的 rng，卻呼叫了 Math.random ${calls} 次`);
});

test('spawnTile 會 mutate 傳入的 grid 並回傳 { index, tile, nextId }', () => {
  const grid = gridOfTiles(4, { 0: [1, 2], 5: [2, 4] });
  const before = readValues(grid);
  const result = spawnTile(grid, 4, 9, 0, () => 0.5);

  assert.ok(result && typeof result === 'object', 'spawnTile 必須回傳物件');
  assert.equal(typeof result.index, 'number');
  assert.ok(Number.isInteger(result.index) && result.index >= 0 && result.index < 16,
    `index ${result.index} 超出範圍`);
  assert.equal(before[result.index], 0, '新磚只能生在空格');

  assert.ok(result.tile && typeof result.tile === 'object', 'tile 必須是 Tile 物件');
  assert.equal(result.tile.id, 9, '新磚的 id 必須是傳入的 nextId');
  assert.equal(result.tile.value, 2, 'spawn4Rate 為 0 時必定生成 2');
  assert.equal(result.nextId, 10, '回傳的 nextId 必須是傳入值 + 1');

  assert.equal(grid[result.index], result.tile,
    'spawnTile 必須就地把新磚放進傳入的 grid（唯一允許 mutate 的函式）');
  assert.equal(grid[0].id, 1, '既有磚塊不得被動到');
  assert.equal(grid[5].value, 4);
});

test('spawn4Rate 為 0 永遠生 2、為 1 永遠生 4、0.10 依 rng 值決定', () => {
  const probes = [0, 0.0001, 0.05, 0.099, 0.1, 0.5, 0.9, 0.999999];

  probes.forEach(p => {
    const grid3 = createInitialGrid(3);
    const r3 = spawnTile(grid3, 3, 1, SIZE_CONFIG[3].spawn4Rate, () => p);
    assert.equal(r3.tile.value, 2,
      `3×3 的 spawn4Rate 為 0，rng 回 ${p} 時仍必須生成 2（零容錯）`);

    const gridAll4 = createInitialGrid(4);
    const r4 = spawnTile(gridAll4, 4, 1, 1, () => p);
    assert.equal(r4.tile.value, 4, `spawn4Rate 為 1，rng 回 ${p} 時必須生成 4`);
  });

  // 4×4 的 spawn4Rate 是 0.10：比較必須是「rng() < spawn4Rate 才生 4」
  const low = spawnTile(createInitialGrid(4), 4, 1, SIZE_CONFIG[4].spawn4Rate, () => 0.05);
  assert.equal(low.tile.value, 4, 'rng 回 0.05 < 0.10 時必須生成 4');
  const high = spawnTile(createInitialGrid(4), 4, 1, SIZE_CONFIG[4].spawn4Rate, () => 0.5);
  assert.equal(high.tile.value, 2, 'rng 回 0.5 > 0.10 時必須生成 2');

  // 5×5 的 0.20 同理
  const low5 = spawnTile(createInitialGrid(5), 5, 1, SIZE_CONFIG[5].spawn4Rate, () => 0.15);
  assert.equal(low5.tile.value, 4);
  const high5 = spawnTile(createInitialGrid(5), 5, 1, SIZE_CONFIG[5].spawn4Rate, () => 0.25);
  assert.equal(high5.tile.value, 2);

  // 生成的面值永遠只能是 2 或 4
  const rng = createRng(4242);
  for (let i = 0; i < 200; i += 1) {
    const g = createInitialGrid(4);
    const r = spawnTile(g, 4, i + 1, 0.10, rng);
    assert.ok(r.tile.value === 2 || r.tile.value === 4,
      `生成了不該出現的面值 ${r.tile.value}`);
  }
});

test('盤面全滿時 spawnTile 回傳 null 且不動盤面', () => {
  const full = gridOfRows([
    '2 4 2 4',
    '4 2 4 2',
    '2 4 2 4',
    '4 2 4 2'
  ], 1);
  const before = readValues(full);
  const beforeIds = readIds(full);

  assert.equal(spawnTile(full, 4, 50, 0.10, () => 0.5), null,
    '沒有空格時 spawnTile 必須回傳 null');
  assert.deepEqual(readValues(full), before, '回 null 時不得動到盤面');
  assert.deepEqual(readIds(full), beforeIds);

  // 只剩最後一格時必定生在那一格
  const almost = gridOfRows([
    '2 4 2 4',
    '4 2 4 2',
    '2 4 2 4',
    '4 2 4 0'
  ], 1);
  const r = spawnTile(almost, 4, 60, 0, () => 0.9);
  assert.ok(r, '還有一格空位時不得回 null');
  assert.equal(r.index, 15, '唯一的空格是格號 15');
  assert.equal(almost[15].id, 60);
});

test('canMove / isGameOver：全滿有相鄰同值可動、全滿無相鄰同值結束', () => {
  // 交錯盤面：同列同行相鄰皆不同值（注意格號 3 與 4 面值相同，
  // 用 values[i] === values[i+1] 的裸判斷會跨列誤判成「還能動」）
  const stuck = gridOfRows([
    '2 4 2 4',
    '4 2 4 2',
    '2 4 2 4',
    '4 2 4 2'
  ], 1);
  assert.equal(canMove(stuck, 4), false, '全滿且無相鄰同值 → 不能動');
  assert.equal(isGameOver(stuck, 4), true, 'isGameOver 必須等於 !canMove');

  // 只改最後一格：row 3 變成 [4,2,4,4]，出現水平相鄰同值
  const horizontal = gridOfRows([
    '2 4 2 4',
    '4 2 4 2',
    '2 4 2 4',
    '4 2 4 4'
  ], 1);
  assert.equal(canMove(horizontal, 4), true, '全滿但有水平相鄰同值 → 還能動');
  assert.equal(isGameOver(horizontal, 4), false);

  // 只改 row 1 的第 0 格：格號 4 由 4 變 2，與格號 0 形成垂直相鄰同值
  const vertical = gridOfRows([
    '2 4 2 4',
    '2 2 4 2',
    '2 4 2 4',
    '4 2 4 2'
  ], 1);
  assert.equal(canMove(vertical, 4), true, '全滿但有垂直相鄰同值 → 還能動');

  // 有空格一定能動
  const withHole = gridOfRows([
    '2 4 2 4',
    '4 2 4 2',
    '2 4 2 4',
    '4 2 4 .'
  ], 1);
  assert.equal(canMove(withHole, 4), true, '有空格就一定能動');
  assert.equal(isGameOver(withHole, 4), false);
  assert.equal(canMove(createInitialGrid(4), 4), true, '空盤一定能動');

  // 3×3 / 5×5 的交錯盤面也必須判定為結束
  const stuck3 = gridOfRows(['2 4 2', '4 2 4', '2 4 2'], 1);
  assert.equal(canMove(stuck3, 3), false);
  assert.equal(isGameOver(stuck3, 3), true);

  const stuck5 = gridOfRows([
    '2 4 2 4 2',
    '4 2 4 2 4',
    '2 4 2 4 2',
    '4 2 4 2 4',
    '2 4 2 4 2'
  ], 1);
  assert.equal(canMove(stuck5, 5), false);
  assert.equal(isGameOver(stuck5, 5), true);
});

test('maxTile 與 isWin 依各尺寸 target 判定', () => {
  assert.equal(maxTile(createInitialGrid(4)), 0, '空盤的 maxTile 必須是 0');

  const grid = gridOfRows([
    '2 4 8 16',
    '32 64 128 256',
    '512 1024 0 0',
    '0 0 0 0'
  ], 1);
  assert.equal(maxTile(grid), 1024);

  // 3×3：target 128
  const t3 = SIZE_CONFIG[3].target;
  assert.equal(t3, 128);
  assert.equal(isWin(gridOfRows(['2 4 64', '0 0 0', '0 0 0'], 1), t3), false);
  assert.equal(isWin(gridOfRows(['2 4 128', '0 0 0', '0 0 0'], 1), t3), true);
  assert.equal(isWin(gridOfRows(['2 4 256', '0 0 0', '0 0 0'], 1), t3), true,
    '超過 target 也算達標');

  // 4×4：target 2048
  const t4 = SIZE_CONFIG[4].target;
  assert.equal(t4, 2048);
  assert.equal(isWin(grid, t4), false, '最大只有 1024 還沒達標');
  const won4 = gridOfRows(['2048 0 0 0', '0 0 0 0', '0 0 0 0', '0 0 0 0'], 1);
  assert.equal(isWin(won4, t4), true);
  assert.equal(isWin(won4, SIZE_CONFIG[5].target), false,
    '同一盤面在 5×5 的 4096 門檻下尚未達標');

  // 5×5：target 4096
  const won5 = gridFromValues(
    [4096].concat(new Array(24).fill(0)), 1
  ).grid;
  assert.equal(isWin(won5, SIZE_CONFIG[5].target), true);

  assert.equal(isWin(createInitialGrid(4), t4), false, '空盤不得達標');
});

// ---------------------------------------------------------------------------
// E. 手勢門檻（純函式，不需要 DOM）
// ---------------------------------------------------------------------------

test('lockSwipeAxis：位移不足與斜滑都不鎖軸，水平垂直各自正確', () => {
  // 位移不足（兩種可能的門檻解讀都同意）
  assert.equal(lockSwipeAxis(0, 0), null, '完全沒動不鎖軸');
  assert.equal(lockSwipeAxis(6, 0), null, `位移 6 < AXIS_LOCK(${SWIPE.AXIS_LOCK}) 不鎖軸`);
  assert.equal(lockSwipeAxis(0, -9), null, '位移 9 仍不足以鎖軸');
  assert.equal(lockSwipeAxis(8, 1), null, '位移不足時即使方向明確也不鎖軸');

  // 純水平 / 純垂直
  assert.equal(lockSwipeAxis(30, 0), 'x');
  assert.equal(lockSwipeAxis(-30, 0), 'x', '往左也是 x 軸');
  assert.equal(lockSwipeAxis(0, 30), 'y');
  assert.equal(lockSwipeAxis(0, -30), 'y', '往上也是 y 軸');

  // 斜滑：主軸／副軸比例 < AXIS_RATIO(1.4) 一律不鎖
  assert.equal(lockSwipeAxis(30, 30), null, '正 45 度不鎖軸');
  assert.equal(lockSwipeAxis(-30, 30), null, '另一條對角線也不鎖軸');
  assert.equal(lockSwipeAxis(30, 22), null, '比例 1.36 < 1.4 不鎖軸');
  assert.equal(lockSwipeAxis(22, 30), null, '比例 1.36 < 1.4 不鎖軸（垂直側）');

  // 比例剛好超過 1.4
  assert.equal(lockSwipeAxis(31, 22), 'x', '比例 1.41 > 1.4 鎖 x 軸');
  assert.equal(lockSwipeAxis(22, 31), 'y', '比例 1.41 > 1.4 鎖 y 軸');
  assert.equal(lockSwipeAxis(-31, -22), 'x', '負向同樣以絕對值判定');
  assert.equal(lockSwipeAxis(-22, -31), 'y');

  assert.equal(lockSwipeAxis(100, 5), 'x');
  assert.equal(lockSwipeAxis(5, 100), 'y');
});

test('resolveSwipe：距離門檻、尾段速度、逾時與滑鼠較高門檻', () => {
  // gesture 欄位依實作契約：呼叫端負責取樣（vx / vy 是最近 VELOCITY_WINDOW 的速度，px/ms），
  // 函式只負責判定。releasing / phase 表示是否已放手 —— 輕掃只在放手當下才判定。
  const g = (over) => Object.assign({
    axis: null,
    dx: 0,
    dy: 0,
    vx: 0,
    vy: 0,
    duration: 0,
    pointerType: 'touch',
    releasing: false
  }, over);

  // 回傳形狀：null 或 { dir, name, reason }。
  // 刻意不是裸數字 —— DIR.UP === 0，裸數字會讓呼叫端的 if (dir) 漏掉往上滑。
  const dirOf = (res) => (res === null ? null : res.name);

  const up = resolveSwipe(g({ axis: 'y', dy: -30, duration: 900 }));
  assert.equal(typeof up, 'object', 'resolveSwipe 必須回傳物件而非裸值');
  assert.equal(up.name, 'up');
  assert.equal(up.dir, DIR.UP, 'dir 必須是 DIR 的值');
  assert.equal(up.reason, 'distance', '走滿距離的觸發原因是 distance');

  // 沒鎖軸、方向又曖昧時不得出招
  assert.equal(dirOf(resolveSwipe(g({ axis: null, dx: 30, dy: 30, duration: 200 }))), null,
    '正 45 度且尚未鎖軸時不得觸發');

  // 慢速拖曳：達 MIN_DISTANCE(24) 就要在 pointermove 期間立刻觸發
  assert.equal(dirOf(resolveSwipe(g({ axis: 'x', dx: 30, duration: 900 }))), 'right',
    `位移 30 >= MIN_DISTANCE(${SWIPE.MIN_DISTANCE}) 必須觸發`);
  assert.equal(dirOf(resolveSwipe(g({ axis: 'x', dx: -30, duration: 900 }))), 'left');
  assert.equal(dirOf(resolveSwipe(g({ axis: 'y', dy: 30, duration: 900 }))), 'down');
  assert.equal(dirOf(resolveSwipe(g({ axis: 'y', dy: -30, duration: 900 }))), 'up');

  // 未達門檻不得觸發
  assert.equal(dirOf(resolveSwipe(g({ axis: 'x', dx: 20, duration: 900 }))), null,
    '位移 20 < 24 不得觸發');
  assert.equal(dirOf(resolveSwipe(g({ axis: 'y', dy: -20, duration: 900 }))), null);

  // 快速輕掃：靠最近 80ms 的取樣速度，且只在放手當下判定
  const flick = resolveSwipe(g({
    axis: 'x', dx: 14, duration: 120, vx: 14 / 30, releasing: true
  }));
  assert.equal(dirOf(flick), 'right',
    '14px / 30ms = 0.47 px/ms >= 0.35 且 14 >= FLICK_DISTANCE(12) 必須觸發');
  assert.equal(flick.reason, 'flick', '輕掃的觸發原因是 flick');

  assert.equal(dirOf(resolveSwipe(g({
    axis: 'y', dy: -14, duration: 120, vy: -14 / 30, releasing: true
  }))), 'up', '垂直輕掃同理');

  assert.equal(dirOf(resolveSwipe(g({
    axis: 'x', dx: 14, duration: 300, vx: 14 / 60, releasing: true
  }))), null, '14px / 60ms = 0.23 px/ms < 0.35 不得觸發');

  assert.equal(dirOf(resolveSwipe(g({
    axis: 'x', dx: 10, duration: 100, vx: 10 / 20, releasing: true
  }))), null, '速度夠但總位移 10 < FLICK_DISTANCE(12) 不得觸發');

  // 放手閘門：拖曳途中不得用尾段速度判定輕掃，否則 12px 的快速抖動就會誤觸發
  assert.equal(dirOf(resolveSwipe(g({
    axis: 'x', dx: 14, duration: 120, vx: 14 / 30, releasing: false
  }))), null, '尚未放手（releasing: false）不得用尾段速度判定');
  assert.equal(dirOf(resolveSwipe(g({
    axis: 'x', dx: 14, duration: 120, vx: 14 / 30, phase: 'move'
  }))), null, 'phase: move 同樣不得用尾段速度判定');
  assert.equal(dirOf(resolveSwipe(g({
    axis: 'x', dx: 14, duration: 120, vx: 14 / 30, phase: 'up'
  }))), 'right', 'phase: up 等同 releasing');

  // 逾時
  assert.equal(dirOf(resolveSwipe(g({ axis: 'x', dx: 60, duration: 1400, releasing: true }))), 'right',
    `duration 1400 <= MAX_DURATION(${SWIPE.MAX_DURATION}) 走滿距離仍然有效`);
  assert.equal(dirOf(resolveSwipe(g({
    axis: 'x', dx: 14, duration: 1600, vx: 14 / 30, releasing: true
  }))), null, 'duration 1600 > MAX_DURATION 的輕掃視為猶豫，必須放棄');

  // 滑鼠門檻比觸控高
  assert.equal(dirOf(resolveSwipe(g({ axis: 'x', dx: 28, duration: 300 }))), 'right',
    '觸控門檻 24：28px 過關');
  assert.equal(dirOf(resolveSwipe(g({ axis: 'x', dx: 28, duration: 300, pointerType: 'mouse' }))), null,
    `滑鼠門檻 ${SWIPE.MIN_DISTANCE_MOUSE}：28px 不過關`);
  assert.equal(dirOf(resolveSwipe(g({ axis: 'x', dx: 40, duration: 300, pointerType: 'mouse' }))), 'right',
    '滑鼠走 40px 才過關');
  assert.equal(dirOf(resolveSwipe(g({ axis: 'x', dx: 28, duration: 300, pointerType: 'pen' }))), 'right',
    '筆比照觸控門檻');

  // 斜滑在 resolveSwipe 這關也要被擋掉
  assert.equal(dirOf(resolveSwipe(g({ axis: 'x', dx: 40, dy: 35, duration: 300 }))), null,
    '主軸 40 < 副軸 35 × 1.4 = 49，斜滑不觸發');
  assert.equal(dirOf(resolveSwipe(g({ axis: 'x', dx: 60, dy: 35, duration: 300 }))), 'right',
    '主軸 60 > 49 才算數');

  // 一次手勢只能觸發一次；作廢的手勢一律不出招
  assert.equal(dirOf(resolveSwipe(g({ axis: 'x', dx: 60, duration: 300, fired: true }))), null,
    'fired 之後不得再觸發');
  assert.equal(dirOf(resolveSwipe(g({ axis: 'x', dx: 60, duration: 300, cancelled: true }))), null,
    '已作廢的手勢不得觸發');
});

// ---------------------------------------------------------------------------
// F. 持久化
// ---------------------------------------------------------------------------

test('saveGameState 寫出契約第 10 節的欄位，loadGameState 可完整還原', () => {
  withStubEnv(store => {
    const values = valuesFromRows([
      '2 4 8 0',
      '0 16 0 0',
      '0 0 32 0',
      '0 0 0 64'
    ]);
    const built = gridFromValues(values, 1);

    const saver = makeApp({
      mode: MODES.CLASSIC,
      size: 4,
      n: 4,
      grid: built.grid,
      score: 1234,
      moveCount: 87,
      nextId: 42,
      undosUsed: 2,
      hintsUsed: 1,
      continued: true,
      blitzLeftMs: 0,
      startedAt: 1700000000000
    });

    assert.equal(typeof saver.saveGameState, 'function', '必須提供 saveGameState()');
    saver.saveGameState();

    const raw = store[SAVE_KEY];
    assert.ok(raw, `存檔必須寫進 ${SAVE_KEY}`);
    const payload = JSON.parse(raw);

    assert.equal(payload.v, 1, '存檔版本必須是 1');
    assert.equal(payload.mode, MODES.CLASSIC);
    assert.equal(payload.size, 4);
    assert.deepEqual(payload.values, values, '存檔必須以 values 陣列保存盤面');
    assert.equal(payload.nextId, 42, 'nextId 必須原封不動寫進存檔');
    assert.equal(payload.score, 1234);
    assert.equal(payload.moveCount, 87);
    assert.equal(payload.undosUsed, 2);
    assert.equal(payload.hintsUsed, 1);
    assert.equal(payload.continued, true);
    assert.equal(typeof payload.blitzLeftMs, 'number');
    assert.equal(typeof payload.startedAt, 'number');
    assert.ok('undo' in payload, '存檔必須包含 undo 欄位（可為 null）');

    // ---- 讀回 ----
    const loader = makeApp({
      grid: createInitialGrid(4),
      score: 0,
      nextId: 1,
      undosUsed: 0,
      moveCount: 0,
      continued: false
    });
    assert.equal(typeof loader.loadGameState, 'function', '必須提供 loadGameState()');
    assert.equal(loader.loadGameState(), true, '合法存檔必須回傳 true');

    assert.deepEqual(readValues(loader.grid), values, '盤面必須完整還原');
    assert.equal(loader.score, 1234, '分數必須還原');
    assert.equal(loader.moveCount, 87, '步數必須還原');
    assert.equal(loader.undosUsed, 2, '悔棋次數必須還原');
    assert.equal(loader.continued, true, '續玩旗標必須還原');
    assert.equal(loader.mode, MODES.CLASSIC);

    // nextId：至少要從存檔續號，不得重新從 1 起算
    const tileCount = values.filter(v => v > 0).length;
    assert.ok(loader.nextId >= 42,
      `nextId 必須從存檔的 42 續號（實際 ${loader.nextId}），否則新磚 id 會撞到舊節點`);
    assert.ok(loader.nextId <= 42 + tileCount,
      `nextId 不該無故暴衝（實際 ${loader.nextId}）`);

    // 還原後的 id 必須互不重複、且都小於 nextId
    const ids = readIds(loader.grid).filter(v => v > 0);
    assert.equal(new Set(ids).size, ids.length, '還原後的磚塊 id 不得重複');
    ids.forEach(id => assert.ok(id < loader.nextId, `id ${id} 不得 >= nextId`));
  });
});

test('存檔被竄改時 loadGameState 回傳 false 且不污染現有盤面', () => {
  const legit = {
    v: 1,
    mode: MODES.CLASSIC,
    size: 4,
    values: valuesFromRows(['2 4 0 0', '0 0 0 0', '0 0 0 0', '0 0 0 8']),
    nextId: 9,
    score: 100,
    moveCount: 5,
    undosUsed: 0,
    hintsUsed: 0,
    continued: false,
    blitzLeftMs: 0,
    startedAt: 1700000000000,
    undo: null
  };

  const BAD_SAVES = [
    ['values 長度不符（15 個）', Object.assign({}, legit, { values: legit.values.slice(0, 15) })],
    ['values 長度不符（17 個）', Object.assign({}, legit, { values: legit.values.concat([2]) })],
    ['出現非 2 的冪（3）', Object.assign({}, legit, { values: [3].concat(legit.values.slice(1)) })],
    ['出現非 2 的冪（6）', Object.assign({}, legit, { values: [6].concat(legit.values.slice(1)) })],
    ['面值超過 2^MAX_LEVEL', Object.assign({}, legit, {
      values: [Math.pow(2, MAX_LEVEL + 1)].concat(legit.values.slice(1))
    })],
    ['面值是負數', Object.assign({}, legit, { values: [-2].concat(legit.values.slice(1)) })],
    ['size 不合法（6）', Object.assign({}, legit, { size: 6 })],
    ['size 不合法（字串 "4x"）', Object.assign({}, legit, { size: '4x' })],
    ['mode 不合法', Object.assign({}, legit, { mode: 'zen' })],
    ['nextId 是 0', Object.assign({}, legit, { nextId: 0 })],
    ['nextId 是負數', Object.assign({}, legit, { nextId: -3 })],
    ['nextId 不是整數', Object.assign({}, legit, { nextId: 2.5 })],
    ['nextId 是字串', Object.assign({}, legit, { nextId: '9' })],
    ['values 不是陣列', Object.assign({}, legit, { values: 'oops' })]
  ];

  BAD_SAVES.forEach(([label, payload]) => {
    withStubEnv(store => {
      store[SAVE_KEY] = JSON.stringify(payload);

      const baseline = gridOfRows(['2 0 0 0', '0 0 0 0', '0 0 0 0', '0 0 0 0'], 1);
      const app = makeApp({
        grid: baseline,
        score: 777,
        nextId: 2,
        undosUsed: 0,
        moveCount: 3
      });
      const before = readValues(app.grid);

      let result;
      assert.doesNotThrow(() => { result = app.loadGameState(); },
        `${label}：驗證失敗不得拋例外`);
      assert.equal(result, false, `${label}：loadGameState 必須回傳 false`);
      assert.deepEqual(readValues(app.grid), before, `${label}：不得污染現有盤面`);
      assert.equal(app.score, 777, `${label}：不得污染現有分數`);
    });
  });

  // 壞掉的 JSON 同樣只能回 false
  withStubEnv(store => {
    store[SAVE_KEY] = '{oops not json';
    const app = makeApp({});
    let result;
    assert.doesNotThrow(() => { result = app.loadGameState(); }, '壞 JSON 不得拋例外');
    assert.equal(result, false, '壞 JSON 必須回傳 false');
  });

  // 完全沒有存檔時回 false
  withStubEnv(() => {
    const app = makeApp({});
    assert.equal(app.loadGameState(), false, '沒有存檔時必須回傳 false');
  });
});

test('SIZE_CONFIG 的查表不得讓原型鏈上的 key 通過', () => {
  ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'].forEach(key => {
    assert.equal(Object.prototype.hasOwnProperty.call(SIZE_CONFIG, key), false,
      `SIZE_CONFIG 不得有自有屬性 ${key}`);
  });

  // 存檔把 size 竄改成原型鏈上的 key：裸的 SIZE_CONFIG[size] truthy 判斷會通過，
  // 必須用 Object.prototype.hasOwnProperty.call 擋下來。
  ['toString', 'constructor', 'valueOf', 'hasOwnProperty'].forEach(key => {
    withStubEnv(store => {
      store[SAVE_KEY] = JSON.stringify({
        v: 1,
        mode: MODES.CLASSIC,
        size: key,
        values: new Array(16).fill(0),
        nextId: 1,
        score: 0,
        moveCount: 0,
        undosUsed: 0,
        hintsUsed: 0,
        continued: false,
        blitzLeftMs: 0,
        startedAt: 1700000000000,
        undo: null
      });

      const app = makeApp({ grid: createInitialGrid(4), score: 55, size: 4, n: 4 });
      let result;
      assert.doesNotThrow(() => { result = app.loadGameState(); },
        `size: "${key}" 不得讓 loadGameState 拋例外`);
      assert.equal(result, false, `size: "${key}" 必須被擋下來`);
      assert.equal(app.score, 55, `size: "${key}" 被擋下後不得污染現有狀態`);
      assert.equal(app.size, 4, `size: "${key}" 被擋下後不得污染現有盤面大小`);
    });
  });

  // 上面的行為驗證有個死角：即使用裸的 SIZE_CONFIG[key] truthy 判斷，
  // 後續的 values 長度檢查也會因為 conf.size 是 undefined 而「意外」擋下來。
  // 契約第 10 節明文要求查表一律用 hasOwnProperty，這裡直接把它釘死。
  const js = needFile(JS_PATH);
  assert.match(js, /Object\.prototype\.hasOwnProperty\.call\s*\(\s*SIZE_CONFIG\s*,/,
    'SIZE_CONFIG 的查表必須寫成 Object.prototype.hasOwnProperty.call(SIZE_CONFIG, key)，'
    + '不可用裸的中括號 truthy 判斷（SIZE_CONFIG[\'toString\'] 是 truthy）');
  assert.doesNotMatch(js, /if\s*\(\s*!?\s*SIZE_CONFIG\s*\[/,
    '不得用 if (SIZE_CONFIG[key]) 這種裸的 truthy 判斷');
});

test('clearGameState 真的移除存檔', () => {
  withStubEnv(store => {
    const app = makeApp({
      grid: gridOfRows(['2 4 0 0', '0 0 0 0', '0 0 0 0', '0 0 0 0'], 1),
      score: 12,
      nextId: 3
    });
    app.saveGameState();
    assert.ok(store[SAVE_KEY], '前置條件：存檔必須先寫得進去');

    assert.equal(typeof app.clearGameState, 'function', '必須提供 clearGameState()');
    app.clearGameState();
    assert.ok(!store[SAVE_KEY], `clearGameState 必須移除 ${SAVE_KEY}`);

    // 清掉之後再讀必須回 false
    assert.equal(app.loadGameState(), false, '清掉存檔後 loadGameState 必須回傳 false');
  });
});

test('悔棋：只存 1 份快照、悔棋後必須先走一步才能再悔、UNDO_LIMIT 用完不能再悔', () => {
  withStubEnv(() => {
    requireApp();
    assert.equal(typeof Game2048.prototype.pushUndo, 'function',
      'Game2048 必須提供 pushUndo()（契約第 7 節）');

    const firstValues = valuesFromRows(['2 4 0 0', '0 0 0 0', '0 0 0 0', '0 0 0 0']);
    const app = makeApp({
      mode: MODES.CLASSIC,
      grid: gridFromValues(firstValues, 1).grid,
      score: 100,
      moveCount: 5,
      nextId: 9,
      undosUsed: 0
    });

    // 連續 push 三次：任何「會愈疊愈長」的結構都代表存了不只 1 份快照
    const lensBefore = arrayLengths(app);
    app.pushUndo();
    app.pushUndo();
    app.pushUndo();
    const lensAfter = arrayLengths(app);
    Object.keys(lensAfter).forEach(key => {
      if (Object.prototype.hasOwnProperty.call(lensBefore, key)) {
        assert.ok(lensAfter[key] <= lensBefore[key],
          `連呼叫 3 次 pushUndo 讓 ${key} 從 ${lensBefore[key]} 長到 ${lensAfter[key]}：`
          + '悔棋只能存 1 份快照，不得堆疊成可以連退好幾步');
      } else {
        assert.ok(lensAfter[key] <= 1,
          `pushUndo 建立了會成長的陣列 ${key}（長度 ${lensAfter[key]}）：悔棋只能存 1 份快照`);
      }
    });

    const snapField = findSnapshotField(app);
    assert.ok(snapField,
      'pushUndo() 之後必須在實例上留下一份 UndoSnapshot { values, score, moveCount, nextId }');
    assert.equal(countSnapshots(app), 1,
      `連呼叫 3 次 pushUndo 後，實例上只能留下 1 份快照，實際留下 ${countSnapshots(app)} 份`);

    const snap = app[snapField];
    assert.deepEqual(snap.values, firstValues, '快照必須是 gridToValues 的結果');
    assert.equal(snap.score, 100);
    assert.equal(snap.moveCount, 5);
    assert.equal(snap.nextId, 9);
    assert.equal(Array.isArray(app[snapField]), false,
      '悔棋快照必須是單一物件，不是可以連退好幾步的堆疊');

    // 只存 1 份：再 push 一次必須覆蓋
    const secondValues = valuesFromRows(['4 8 0 0', '0 0 0 0', '0 0 0 0', '0 0 0 0']);
    app.grid = gridFromValues(secondValues, 20).grid;
    app.score = 260;
    app.moveCount = 6;
    app.nextId = 22;
    app.pushUndo();
    assert.deepEqual(app[snapField].values, secondValues, 'pushUndo 必須覆蓋舊快照');
    assert.equal(app[snapField].score, 260, '只能保留最新的一份快照');

    // 執行悔棋
    const undoName = pickMethod(
      ['undoMove', 'performUndo', 'doUndo', 'applyUndo', 'undoOnce', 'undoStep', 'undo'],
      '執行悔棋',
      snapField === 'undo' ? ['undo'] : []
    );

    app.grid = gridFromValues(
      valuesFromRows(['8 16 0 0', '0 0 0 0', '0 0 0 0', '0 0 0 0']), 30
    ).grid;
    app.score = 900;
    app.moveCount = 7;
    app.nextId = 32;

    app[undoName]();
    assert.deepEqual(readValues(app.grid), secondValues, '悔棋必須把盤面退回快照');
    assert.equal(app.score, 260, '悔棋必須把分數退回快照');
    assert.equal(app.moveCount, 6, '悔棋必須把步數退回快照');
    // nextId 刻意【不】回捲：id 是磚塊的身分，回收重用會讓新磚的 id 撞到
    // 還留在 DOM 裡、正在播放消失動畫的舊節點（契約第 7 節 (c) 「id 重用誤判」）。
    // 快照裡的 nextId 是給「存檔還原」用的，不是給悔棋回捲用的。
    assert.ok(app.nextId >= 32, '悔棋不得回捲 nextId（id 永不重用），實際 ' + app.nextId);
    assert.equal(app.undosUsed, 1, '悔棋必須消耗一次次數');
    assert.ok(!app[snapField], '悔棋後快照必須清空 —— 必須先走一步才能再悔');

    // 沒有快照時再悔一次：什麼都不能變
    const scoreBefore = app.score;
    const valuesBefore = readValues(app.grid);
    app[undoName]();
    assert.equal(app.undosUsed, 1, '沒有快照時不得再消耗悔棋次數');
    assert.equal(app.score, scoreBefore, '沒有快照時不得改動分數');
    assert.deepEqual(readValues(app.grid), valuesBefore, '沒有快照時不得改動盤面');

    // UNDO_LIMIT 用完之後不得再悔
    const exhausted = makeApp({
      mode: MODES.CLASSIC,
      grid: gridFromValues(
        valuesFromRows(['32 64 0 0', '0 0 0 0', '0 0 0 0', '0 0 0 0']), 50
      ).grid,
      score: 5000,
      moveCount: 40,
      nextId: 52,
      undosUsed: UNDO_LIMIT
    });
    exhausted[snapField] = {
      values: valuesFromRows(['2 2 0 0', '0 0 0 0', '0 0 0 0', '0 0 0 0']),
      score: 4,
      moveCount: 1,
      nextId: 3
    };
    exhausted[undoName]();
    assert.equal(exhausted.undosUsed, UNDO_LIMIT,
      `已經用滿 UNDO_LIMIT(${UNDO_LIMIT}) 次就不得再悔`);
    assert.equal(exhausted.score, 5000, '次數用完時不得改動分數');

    // 閃電模式完全不給悔棋
    const blitz = makeApp({
      mode: MODES.BLITZ,
      grid: gridFromValues(
        valuesFromRows(['32 64 0 0', '0 0 0 0', '0 0 0 0', '0 0 0 0']), 60
      ).grid,
      score: 3000,
      moveCount: 30,
      nextId: 62,
      undosUsed: 0
    });
    blitz[snapField] = {
      values: valuesFromRows(['2 2 0 0', '0 0 0 0', '0 0 0 0', '0 0 0 0']),
      score: 4,
      moveCount: 1,
      nextId: 3
    };
    blitz[undoName]();
    assert.equal(blitz.score, 3000, '閃電模式不得允許悔棋');
    assert.equal(blitz.undosUsed, 0, '閃電模式不得消耗悔棋次數');
  });
});

test('有用過悔棋的一局只更新 practiceBestScore，不動 bestScore / streak', () => {
  const RECORD_CANDIDATES = [
    'recordResult', 'recordGameResult', 'recordGameEnd', 'recordGameOver',
    'settleGame', 'finalizeGame', 'recordStats', 'commitStats', 'recordOutcome'
  ];

  // 對照組：完全沒用悔棋 → 正式紀錄必須真的被寫進去
  withStubEnv(store => {
    const recordName = pickMethod(RECORD_CANDIDATES, '結算並寫入戰績');
    store[STATS_KEY] = JSON.stringify(zeroStats());

    const clean = makeApp({
      mode: MODES.CLASSIC,
      size: 4,
      n: 4,
      grid: gridOfRows(['512 256 128 64', '32 16 8 4', '2 4 8 16', '32 64 128 256'], 1),
      score: 5000,
      moveCount: 300,
      undosUsed: 0,
      gameOver: true
    });
    clean[recordName]();

    const stats = JSON.parse(store[STATS_KEY] || '{}');
    const bucket = stats.classic && stats.classic['4'];
    assert.ok(bucket, `結算後 ${STATS_KEY}.classic["4"] 必須存在`);
    assert.equal(bucket.bestScore, 5000,
      '前置條件：沒用悔棋的一局必須寫進 bestScore（否則下面的對照沒有意義）');
  });

  // 實驗組：用過悔棋 → 只能動 practiceBestScore
  withStubEnv(store => {
    const recordName = pickMethod(RECORD_CANDIDATES, '結算並寫入戰績');
    store[STATS_KEY] = JSON.stringify(zeroStats());

    const practiced = makeApp({
      mode: MODES.CLASSIC,
      size: 4,
      n: 4,
      grid: gridOfRows(['512 256 128 64', '32 16 8 4', '2 4 8 16', '32 64 128 256'], 1),
      score: 5000,
      moveCount: 300,
      undosUsed: 2,
      gameOver: true
    });
    practiced[recordName]();

    const stats = JSON.parse(store[STATS_KEY] || '{}');
    const bucket = stats.classic && stats.classic['4'];
    assert.ok(bucket, `結算後 ${STATS_KEY}.classic["4"] 必須存在`);

    assert.equal(bucket.practiceBestScore, 5000,
      'undosUsed >= 1 時必須更新 practiceBestScore');
    assert.equal(bucket.bestScore, 0,
      'undosUsed >= 1 時不得動到 bestScore');
    assert.equal(bucket.bestTile, 0,
      'undosUsed >= 1 時不得動到 bestTile');
    assert.equal(bucket.streak, 0,
      'undosUsed >= 1 時不得動到 streak');
    assert.equal(bucket.bestStreak, 0,
      'undosUsed >= 1 時不得動到 bestStreak');
  });
});

test('達標後續玩失敗，不得回頭取消這局的達標紀錄', () => {
  withStubEnv(store => {
    const recordName = pickMethod([
      'recordResult', 'recordGameResult', 'recordGameEnd', 'recordGameOver',
      'settleGame', 'finalizeGame', 'recordStats', 'commitStats', 'recordOutcome'
    ], '結算並寫入戰績');

    // 達標的那一刻已經寫進去的狀態
    const seeded = zeroStats();
    seeded.classic['4'] = Object.assign(zeroBucket(), {
      plays: 1,
      bestScore: 20000,
      bestTile: 2048,
      targetHits: 1,
      fewestMovesToTarget: 900,
      fastestMs: 600000,
      streak: 1,
      bestStreak: 1
    });
    store[STATS_KEY] = JSON.stringify(seeded);

    // 續玩之後塞死：分數更高但沒有再達標一次
    const app = makeApp({
      mode: MODES.CLASSIC,
      size: 4,
      n: 4,
      grid: gridOfRows([
        '2048 1024 512 256',
        '128 64 32 16',
        '8 4 2 4',
        '8 16 32 64'
      ], 1),
      score: 24000,
      moveCount: 1200,
      undosUsed: 0,
      continued: true,
      gameOver: true,
      // 契約沒有指定「本局是否達標」的旗標名稱，幾個常見寫法都先設好
      won: true,
      reachedTarget: true,
      targetReached: true,
      hitTarget: true
    });

    app[recordName]();

    const stats = JSON.parse(store[STATS_KEY] || '{}');
    const bucket = stats.classic && stats.classic['4'];
    assert.ok(bucket, `結算後 ${STATS_KEY}.classic["4"] 必須存在`);

    assert.ok(bucket.targetHits >= 1,
      `續玩失敗不得把 targetHits 退回去（實際 ${bucket.targetHits}）`);
    assert.ok(bucket.streak >= 1,
      `續玩失敗不得把這局的 streak 歸零（實際 ${bucket.streak}）`);
    assert.ok(bucket.bestStreak >= 1,
      `bestStreak 只能往上，不得被回頭抹掉（實際 ${bucket.bestStreak}）`);
    assert.equal(bucket.fewestMovesToTarget, 900,
      '達標時記下的最少步數不得被續玩後的 1200 步蓋掉');
    assert.equal(bucket.fastestMs, 600000,
      '達標時記下的最快時間不得被續玩後的時間蓋掉');
    assert.ok(bucket.bestScore >= 20000,
      'bestScore 只能往上');
  });
});

test('localStorage 全面拋錯時，存讀檔路徑都不得讓例外逸出', () => {
  withStubEnv(() => {
    // 必須在 withStubEnv 的 callback 內覆蓋，finally 的還原才會把它清掉，
    // 否則會漏到後面的測項去。
    const boom = () => { throw new Error('SecurityError: localStorage 被封鎖'); };
    global.localStorage = {
      getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0
    };

    const app = makeApp({
      grid: gridOfRows(['2 4 8 0', '0 0 0 0', '0 0 0 0', '0 0 0 0'], 1),
      score: 42,
      nextId: 5
    });

    assert.doesNotThrow(() => {
      app.saveGameState();
    }, 'setItem 拋錯時 saveGameState 不得讓例外逸出（Safari 無痕模式會這樣）');

    assert.doesNotThrow(() => {
      const ok = app.loadGameState();
      assert.equal(ok, false, 'getItem 拋錯時 loadGameState 必須回傳 false');
    }, 'getItem 拋錯時 loadGameState 不得讓例外逸出');

    assert.doesNotThrow(() => {
      app.clearGameState();
    }, 'removeItem 拋錯時 clearGameState 不得讓例外逸出');

    // 盤面不得被拋錯的讀檔流程弄壞
    assert.deepEqual(readValues(app.grid),
      valuesFromRows(['2 4 8 0', '0 0 0 0', '0 0 0 0', '0 0 0 0']),
      '讀檔失敗不得污染現有盤面');

    // 其他有寫 localStorage 的方法若存在，一樣不得逸出
    const optional = [
      'loadPreferences', 'savePreferences', 'loadPrefs', 'savePrefs',
      'loadStats', 'saveStats', 'resetStats', 'initTheme', 'toggleTheme',
      'applyTheme', 'syncHomeTheme'
    ];
    optional.forEach(name => {
      if (typeof Game2048.prototype[name] !== 'function') return;
      assert.doesNotThrow(() => { app[name](); },
        `${name}() 在 localStorage 拋錯時不得讓例外逸出`);
    });
  });

  // 壞 JSON 也必須被吞掉（只有 getItem 拋錯測不到 JSON.parse 那條路徑）
  withStubEnv(store => {
    store[SAVE_KEY] = '{{{ not json';
    store[STATS_KEY] = 'definitely not json';
    store[PREF_KEY] = '[[[';
    store['bobo-home-preferences-v2'] = '}{';

    const app = makeApp({});
    assert.doesNotThrow(() => {
      assert.equal(app.loadGameState(), false, '壞 JSON 必須被吞掉並回傳 false');
      ['loadPreferences', 'loadPrefs', 'loadStats', 'initTheme'].forEach(name => {
        if (typeof Game2048.prototype[name] === 'function') app[name]();
      });
    }, '壞 JSON 不得讓例外逸出（JSON.parse 必須也在 try 內）');
  });
});

// ---------------------------------------------------------------------------
// 里程碑（階段性目標）
// ---------------------------------------------------------------------------

test('currentGoal 在里程碑達成前後回傳不同的目標', () => {
  withStubEnv(() => {
    const app = makeApp({ mode: MODES.CLASSIC, size: 4 });

    // 盤面最大磚 8，還沒到里程碑 1024
    app.grid = gridFromValues(
      valuesFromRows(['2 4 8 0', '0 0 0 0', '0 0 0 0', '0 0 0 0']), 1
    ).grid;
    assert.equal(app.milestoneReached(), false, '最大磚 8 不該算達成里程碑');
    assert.deepEqual(app.currentGoal(), { value: 1024, isMilestone: true },
      '未達里程碑時目標欄要顯示里程碑');

    // 合出 1024 之後，目標換成真正的 2048
    app.grid = gridFromValues(
      valuesFromRows(['1024 4 8 0', '0 0 0 0', '0 0 0 0', '0 0 0 0']), 1
    ).grid;
    assert.equal(app.milestoneReached(), true);
    assert.deepEqual(app.currentGoal(), { value: 2048, isMilestone: false },
      '達成里程碑後目標欄要換成最終目標');

    // 超過里程碑同樣算達成
    app.grid = gridFromValues(
      valuesFromRows(['2048 4 8 0', '0 0 0 0', '0 0 0 0', '0 0 0 0']), 1
    ).grid;
    assert.equal(app.milestoneReached(), true, '超過里程碑當然也算達成');
  });
});

test('三種尺寸的 currentGoal 都對應到自己那一檔的里程碑', () => {
  withStubEnv(() => {
    [[3, 64, 128], [4, 1024, 2048], [5, 2048, 4096]].forEach(([size, milestone, target]) => {
      const app = makeApp({ mode: MODES.CLASSIC, size });
      app.grid = gridFromValues(valuesFromRows([new Array(size).fill('2').join(' ')]
        .concat(new Array(size - 1).fill(new Array(size).fill('0').join(' ')))), 1).grid;
      assert.deepEqual(app.currentGoal(), { value: milestone, isMilestone: true },
        `${size}×${size} 未達里程碑時應顯示 ${milestone}`);
      assert.equal(app.currentTarget(), target);
    });
  });
});

test('checkMilestone 只在「這一步剛好跨過里程碑」時記一次', () => {
  withStubEnv(store => {
    const toasts = [];
    const app = makeApp({
      mode: MODES.CLASSIC, size: 4,
      showToast: (m) => toasts.push(m),
      fireConfetti() {}
    });
    app.grid = gridFromValues(
      valuesFromRows(['1024 4 8 0', '0 0 0 0', '0 0 0 0', '0 0 0 0']), 1
    ).grid;

    // 這一步之前最大磚是 512 → 跨過里程碑，要記一次
    app.checkMilestone(512);
    let bucket = JSON.parse(store.g2048_stats_v1).classic['4'];
    assert.equal(bucket.milestoneHits, 1, '跨過里程碑要記一次');
    assert.equal(toasts.length, 1, '要跳一次慶祝訊息');

    // 這一步之前就已經是 1024 → 不能再記
    app.checkMilestone(1024);
    bucket = JSON.parse(store.g2048_stats_v1).classic['4'];
    assert.equal(bucket.milestoneHits, 1, '已經達成過就不得重複記');
    assert.equal(toasts.length, 1, '也不得重複慶祝');
  });
});

test('閃電模式不記里程碑', () => {
  withStubEnv(store => {
    const app = makeApp({
      mode: MODES.BLITZ, size: 4,
      showToast() {}, fireConfetti() {}
    });
    app.grid = gridFromValues(
      valuesFromRows(['1024 4 8 0', '0 0 0 0', '0 0 0 0', '0 0 0 0']), 1
    ).grid;
    app.checkMilestone(512);
    assert.ok(!store.g2048_stats_v1 || !JSON.parse(store.g2048_stats_v1).classic['4'].milestoneHits,
      '閃電模式不該寫入經典模式的里程碑次數');
  });
});

test('emptyBucket 含 milestoneHits 且初值為 0', () => {
  withStubEnv(() => {
    const app = makeApp({});
    const bucket = app.emptyBucket();
    assert.equal(bucket.milestoneHits, 0, 'milestoneHits 初值必須是 0');
  });
});

// ---------------------------------------------------------------------------
// G. 跨檔案對齊（契約第 12 節，純字串比對）
// ---------------------------------------------------------------------------

test('index.html 的 id 集合涵蓋 2048.js 所有 byId / getElementById 的參數', () => {
  const html = needFile(HTML_PATH);
  const js = needFile(JS_PATH);

  const htmlIds = new Set();
  let m;
  const idRe = /\bid\s*=\s*["']([^"']+)["']/g;
  m = idRe.exec(html);
  while (m) { htmlIds.add(m[1]); m = idRe.exec(html); }
  assert.ok(htmlIds.size > 10, `index.html 只掃到 ${htmlIds.size} 個 id，明顯不完整`);

  const wanted = new Set();
  const callRe = /\b(?:byId|getElementById)\s*\(\s*['"]([\w-]+)['"]\s*\)/g;
  m = callRe.exec(js);
  while (m) { wanted.add(m[1]); m = callRe.exec(js); }
  assert.ok(wanted.size > 10, `2048.js 只掃到 ${wanted.size} 個 byId('...')，掃描規則可能失效`);

  const missing = Array.from(wanted).filter(id => !htmlIds.has(id)).sort();
  assert.deepEqual(missing, [],
    `2048.js 取用了 index.html 沒有的 id：${missing.join(', ')}`);
});

test('2048.css 的 class 與 HTML / JS 使用到的 class 必須互相涵蓋', () => {
  const html = needFile(HTML_PATH);
  const js = needFile(JS_PATH);
  const css = needFile(CSS_PATH);

  const parsed = parseCss(stripCssComments(css));
  assert.ok(parsed.rules.length > 10, `2048.css 只解析出 ${parsed.rules.length} 條規則，掃描規則可能失效`);

  const cssClasses = new Set();
  parsed.rules.forEach(rule => {
    classesInSelector(rule.selector).forEach(c => cssClasses.add(c));
  });

  const used = new Set();
  collectHtmlClasses(html).forEach(c => used.add(c));
  collectJsClasses(js).forEach(c => used.add(c));

  assert.ok(cssClasses.size > 10, `只從 CSS 掃到 ${cssClasses.size} 個 class，掃描規則可能失效`);
  assert.ok(used.size > 10, `只從 HTML/JS 掃到 ${used.size} 個 class，掃描規則可能失效`);

  const dead = Array.from(cssClasses).filter(c => !used.has(c)).sort();
  assert.deepEqual(dead, [],
    `2048.css 有沒人使用的死 CSS class：${dead.join(', ')}`);

  const unstyled = Array.from(used).filter(c => !cssClasses.has(c)).sort();
  assert.deepEqual(unstyled, [],
    `HTML / JS 用到了 2048.css 沒有樣式的 class：${unstyled.join(', ')}`);
});

test('2048.css 內不得出現裸的動畫時長數字', () => {
  const css = needFile(CSS_PATH);
  let scrub = stripCssComments(css);

  // 契約第 6 節允許 :root 宣告同值的預設 fallback，所以先把這三個自訂屬性的宣告挖掉
  scrub = scrub.replace(/--(?:slide|pop|spawn)-ms\s*:[^;}]*/g, ' ');

  const timings = [['SLIDE_MS', SLIDE_MS], ['POP_MS', POP_MS], ['SPAWN_MS', SPAWN_MS]];
  timings.forEach(([name, ms]) => {
    const secs = String(ms / 1000);          // 110 -> "0.11"
    const frac = secs.replace(/^0/, '');     // "0.11" -> ".11"
    const patterns = [
      new RegExp('(?<![\\d.])' + ms + 'ms\\b'),
      new RegExp('(?<![\\d])0?' + frac.replace('.', '\\.') + 's\\b')
    ];
    patterns.forEach(re => {
      assert.doesNotMatch(scrub, re,
        `2048.css 硬寫了 ${name}(${ms}) 的時長；唯一真相是 2048.js 的常數，`
        + '使用點一律要寫 var(--slide-ms) / var(--pop-ms) / var(--spawn-ms)');
    });
  });

  // 使用點必須真的用到 CSS 變數
  assert.match(css, /var\(\s*--slide-ms/, '滑動時長必須以 var(--slide-ms) 使用');
  assert.match(css, /var\(\s*--pop-ms/, '合併彈跳時長必須以 var(--pop-ms) 使用');
  assert.match(css, /var\(\s*--spawn-ms/, '生成時長必須以 var(--spawn-ms) 使用');
});

test('2048.js 不得出現 style.transform =（transform 由 CSS 單獨擁有）', () => {
  const js = needFile(JS_PATH);

  assert.doesNotMatch(js, /\.style\s*\.\s*transform\s*=/,
    'JS 不得寫 element.style.transform；磚塊位移只能寫 --col / --row');
  assert.doesNotMatch(js, /\.style\s*\[\s*['"`]transform['"`]\s*\]\s*=/,
    'JS 不得用中括號寫 style["transform"]');
  assert.doesNotMatch(js, /setProperty\s*\(\s*['"`]transform['"`]/,
    'JS 不得用 setProperty(\'transform\', ...) 繞過去');
  assert.doesNotMatch(js, /\bcssText\s*=[^;]*transform/,
    'JS 不得用 cssText 夾帶 transform');

  // 位移一定是靠 --col / --row
  assert.match(js, /--col/, 'JS 必須寫入 --col');
  assert.match(js, /--row/, 'JS 必須寫入 --row');
  assert.match(js, /--n\b/, 'JS 必須在 #board-frame 寫入 --n');
});

test('@keyframes 只能掛在 .tile-face，不得掛在 .tile 上', () => {
  const css = needFile(CSS_PATH);
  const parsed = parseCss(stripCssComments(css));

  assert.ok(parsed.keyframes.length > 0, '2048.css 必須定義 @keyframes');

  const offenders = [];
  parsed.rules.forEach(rule => {
    const hasAnimation = /(^|[;{\s])animation(-name)?\s*:/.test(rule.body);
    if (!hasAnimation) return;
    const decl = rule.body.match(/(^|[;{\s])animation(-name)?\s*:([^;}]*)/);
    if (decl && /^\s*none\s*$/.test(decl[3])) return;

    rule.selector.split(',').forEach(part => {
      const tail = lastCompound(part);
      if (/\.tile(?![\w-])/.test(tail)) offenders.push(part.trim());
    });
  });

  assert.deepEqual(offenders, [],
    `這些規則把 animation 掛在 .tile 上（會整份覆寫掉 .tile 的位移 transform）：${offenders.join(' / ')}`);

  // .tile 也不得對 opacity 做過渡（opacity 是 grouping property，會壓平 3D）
  parsed.rules.forEach(rule => {
    rule.selector.split(',').forEach(part => {
      const tail = lastCompound(part);
      if (!/\.tile(?![\w-])/.test(tail)) return;
      const trans = rule.body.match(/(^|[;{\s])transition(-property)?\s*:([^;}]*)/);
      if (!trans) return;
      assert.ok(trans[3].indexOf('opacity') === -1 && trans[3].indexOf('all') === -1,
        `${part.trim()} 不得對 opacity（或 all）做過渡：opacity 會壓平 3D 並建立新的 stacking context`);
    });
  });
});

test('index.html 不得硬寫會被 JS 覆蓋的初始值', () => {
  const html = needFile(HTML_PATH);

  const innerOf = (id) => {
    const re = new RegExp('<([a-zA-Z][\\w-]*)([^>]*\\bid\\s*=\\s*["\']' + id + '["\'][^>]*)>([\\s\\S]*?)<\\/\\1>');
    const m = html.match(re);
    return m ? m[3] : null;
  };

  const ALLOWED = ['', '--', '—', '–', '&mdash;', '&ndash;'];
  ['score', 'best', 'target', 'undo-badge', 'blitz-time'].forEach(id => {
    const inner = innerOf(id);
    assert.ok(inner !== null, `index.html 找不到 id="${id}" 的元素`);
    const text = inner.replace(/<[^>]*>/g, '').trim();
    assert.ok(ALLOWED.indexOf(text) !== -1,
      `#${id} 不得硬寫初始值「${text}」；一律留空或放 --（JS 會覆蓋）`);
  });
});

test('Stats.recordGamePlay(\'2048\') 在 html + js 合起來只出現 1 次', () => {
  const html = needFile(HTML_PATH);
  const js = needFile(JS_PATH);
  const hits = (html + js).match(/Stats\.recordGamePlay\(\s*['"]2048['"]\s*\)/g) || [];
  assert.equal(hits.length, 1,
    `Stats.recordGamePlay('2048') 應只出現 1 次，實際 ${hits.length} 次`);
});

test('index.html 有回首頁連結，且四支 script 順序正確、都不加 defer / async', () => {
  const html = needFile(HTML_PATH);

  assert.match(html, /href="\.\.\/\.\.\/index\.html"/, '必須有回首頁連結');
  assert.doesNotMatch(html, /["'(]assets\//,
    'index.html 不得出現「引號或左括號緊接 assets/」的舊集中式路徑');

  const tags = [];
  const re = /<script\b([^>]*)>/g;
  let m = re.exec(html);
  while (m) { tags.push(m[1]); m = re.exec(html); }

  const srcs = tags
    .map(attrs => {
      const s = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/);
      return s ? { src: s[1], attrs } : null;
    })
    .filter(Boolean);

  const expectedOrder = [
    '../../assets/js/bobo-confetti.js',
    '../../assets/js/bobo-theme.js',
    '../../assets/js/stats.js',
    '2048.js'
  ];

  const actualOrder = srcs.map(s => s.src).filter(src => expectedOrder.indexOf(src) !== -1);
  assert.deepEqual(actualOrder, expectedOrder,
    `四支 script 的順序必須固定為 ${expectedOrder.join(' → ')}，實際為 ${actualOrder.join(' → ')}`);

  srcs.forEach(s => {
    if (expectedOrder.indexOf(s.src) === -1) return;
    assert.doesNotMatch(s.attrs, /\bdefer\b/, `${s.src} 不得加 defer`);
    assert.doesNotMatch(s.attrs, /\basync\b/, `${s.src} 不得加 async`);
  });
});

test('2048.js 使用 Pointer Events，並具備契約第 9 節要求的關鍵字', () => {
  const js = needFile(JS_PATH);
  const css = needFile(CSS_PATH);

  ['pointerdown', 'pointermove', 'pointercancel', 'pointerId'].forEach(token => {
    assert.ok(js.indexOf(token) !== -1, `2048.js 必須出現 ${token}`);
  });
  assert.match(js, /pointerType\s*===\s*['"]touch['"]/,
    '2048.js 必須以 pointerType === \'touch\' 區分觸控');
  assert.match(js, /addEventListener\s*\(\s*['"]touchmove['"][\s\S]{0,120}?passive\s*:\s*false/,
    'touchmove 必須以 { passive: false } 綁定');
  assert.match(js, /lostpointercapture/, 'lostpointercapture 必須一併視為中止');
  assert.match(js, /#board-frame|board-frame/, 'pointer capture 必須綁在 #board-frame');

  assert.match(css, /touch-action\s*:\s*none/,
    '#board-frame 必須設定 touch-action: none');
});
