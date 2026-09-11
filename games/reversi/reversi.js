/* ==========================================================================
   黑白棋 (Reversi / Othello)
   核心引擎、Alpha-Beta 搜尋 AI、觸控 UX 與進度持久化
   ========================================================================== */

'use strict';

// --------------------------------------------------------------------------
// 核心常數：棋盤表示與基本尺寸
// --------------------------------------------------------------------------
// 盤面用 Int8Array(64) 表示，index = row * 8 + col，row 0 在最上、col 0 在最左。
// 黑白用正負號表示，換手時直接 -player，negamax 可以省掉分支判斷。
const EMPTY = 0;
const BLACK = 1;
const WHITE = -1;
const SIZE = 8;
const CELLS = SIZE * SIZE;

// 搜尋用的「無限大」分數（終局分數約 ±1e6，留足夠餘裕）
const INFINITY_SCORE = 1e9;

// 八方向的 (dr, dc)，順序固定：左上、上、右上、左、右、左下、下、右下
const _rvDIR_VECTORS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1]
];

// 八方向對應的 index 位移（僅供外部參考，內部一律走 RAYS 以免 wrap-around）
const DELTAS = new Int8Array([-9, -8, -7, -1, 1, 7, 8, 9]);

// 方向索引常數（內部使用，對應 _rvDIR_VECTORS 的順序）
const _rvDIR_UL = 0;
const _rvDIR_UP = 1;
const _rvDIR_UR = 2;
const _rvDIR_LEFT = 3;
const _rvDIR_RIGHT = 4;
const _rvDIR_DL = 5;
const _rvDIR_DOWN = 6;
const _rvDIR_DR = 7;

// --------------------------------------------------------------------------
// 預先計算的射線表（RAYS）與相鄰表（NEIGHBORS）
// --------------------------------------------------------------------------
// RAYS[sq * 8 + d] = 從 sq 往方向 d 一路到邊界的所有格號（Int8Array，不含 sq 自己）。
// 有了射線表就不必在內迴圈重算 row / col 邊界，也徹底根除「index 加減繞到下一列」
// 的 wrap-around bug（例如 h4 往右絕對不會跑到 a5）。
const RAYS = new Array(CELLS * 8);
const NEIGHBORS = new Array(CELLS);

for (let row = 0; row < SIZE; row++) {
  for (let col = 0; col < SIZE; col++) {
    const sq = row * SIZE + col;
    const near = [];
    for (let d = 0; d < 8; d++) {
      const dr = _rvDIR_VECTORS[d][0];
      const dc = _rvDIR_VECTORS[d][1];
      const line = [];
      let r = row + dr;
      let c = col + dc;
      while (r >= 0 && r < SIZE && c >= 0 && c < SIZE) {
        line.push(r * SIZE + c);
        r += dr;
        c += dc;
      }
      RAYS[sq * 8 + d] = Int8Array.from(line);
      if (line.length > 0) near.push(line[0]);
    }
    NEIGHBORS[sq] = Int8Array.from(near);
  }
}

// --------------------------------------------------------------------------
// 位置權重表與關鍵格
// --------------------------------------------------------------------------
// 標準的八重對稱權重：角落最高、X 位（角落斜對角）最低。
const POS_WEIGHTS = new Int16Array([
  120, -20, 20, 5, 5, 20, -20, 120,
  -20, -40, -5, -5, -5, -5, -40, -20,
  20, -5, 15, 3, 3, 15, -5, 20,
  5, -5, 3, 3, 3, 3, -5, 5,
  5, -5, 3, 3, 3, 3, -5, 5,
  20, -5, 15, 3, 3, 15, -5, 20,
  -20, -40, -5, -5, -5, -5, -40, -20,
  120, -20, 20, 5, 5, 20, -20, 120
]);

// 四個角落（a1, h1, a8, h8）
const CORNERS = [0, 7, 56, 63];

// 四個 X 位，順序與 CORNERS 一一對應
const X_SQUARES = [9, 14, 49, 54];

// 每個角落的「守門格」：兩個 C 位 + 一個 X 位，角落還空著時佔這些格子很危險
const CORNER_GUARD = {
  0: [1, 8, 9],
  7: [6, 15, 14],
  56: [48, 57, 49],
  63: [55, 62, 54]
};

// 走步排序用的靜態優先序：角 0 → 中央 1 → 邊 2 → 次邊 3 → C 位 4 → X 位 5
const SQ_ORDER = new Int8Array(CELLS);

for (let sq = 0; sq < CELLS; sq++) {
  const row = (sq / SIZE) | 0;
  const col = sq % SIZE;
  const edgeRow = (row === 0 || row === SIZE - 1);
  const edgeCol = (col === 0 || col === SIZE - 1);
  const subRow = (row === 1 || row === SIZE - 2);
  const subCol = (col === 1 || col === SIZE - 2);
  let rank;
  if (edgeRow && edgeCol) rank = 0;                              // 角落
  else if (subRow && subCol) rank = 5;                           // X 位
  else if ((edgeRow && subCol) || (edgeCol && subRow)) rank = 4;  // C 位
  else if (edgeRow || edgeCol) rank = 2;                         // 邊線
  else if (subRow || subCol) rank = 3;                           // 次邊線
  else rank = 1;                                                 // 中央
  SQ_ORDER[sq] = rank;
}

// 各角落往兩條邊延伸的方向索引，countStableEdges 用
const _rvCORNER_EDGE_DIRS = {
  0: [_rvDIR_RIGHT, _rvDIR_DOWN],
  7: [_rvDIR_LEFT, _rvDIR_DOWN],
  56: [_rvDIR_RIGHT, _rvDIR_UP],
  63: [_rvDIR_LEFT, _rvDIR_UP]
};

// 穩定子判定的四條軸（橫、直、左上右下斜、右上左下斜）
const _rvAXES = [
  [_rvDIR_LEFT, _rvDIR_RIGHT],
  [_rvDIR_UP, _rvDIR_DOWN],
  [_rvDIR_UL, _rvDIR_DR],
  [_rvDIR_UR, _rvDIR_DL]
];

// --------------------------------------------------------------------------
// 階段權重表與難度表
// --------------------------------------------------------------------------
// 依空格數切三個階段；各分項先正規化到約 ±100 再乘以這裡的權重。
const PHASE_W = {
  opening: { pos: 1.0, mob: 8.0, pmob: 1.5, corner: 16, xsq: 5.0, stable: 1.0, frontier: 3.0, disc: -0.5 },
  midgame: { pos: 1.0, mob: 6.0, pmob: 1.2, corner: 20, xsq: 6.0, stable: 5.0, frontier: 2.5, disc: 0.5 },
  endgame: { pos: 0.4, mob: 2.0, pmob: 0.4, corner: 22, xsq: 3.0, stable: 9.0, frontier: 1.0, disc: 4.0 }
};

const DIFFICULTIES = {
  easy: { id: 'easy', name: '簡單', label: '🌱 簡單', engine: 'shallow', randomRate: 0.6, cornerBias: 0.30, minThinkMs: 220 },
  normal: { id: 'normal', name: '普通', label: '🎯 普通', engine: 'search', maxDepth: 4, timeBudgetMs: 280, exactEmpties: 8, fullStability: false, tieToleranceEarly: 25, minThinkMs: 320 },
  hard: { id: 'hard', name: '困難', label: '🔥 困難', engine: 'search', maxDepth: 6, timeBudgetMs: 900, exactEmpties: 10, exactBudgetMs: 1800, fullStability: true, tieToleranceEarly: 8, minThinkMs: 380 }
};

// --------------------------------------------------------------------------
// 共用暫存緩衝區（避免熱路徑重複配置記憶體）
// --------------------------------------------------------------------------
// 單手最多能翻的子數遠低於 24，取 24 當每層的翻子堆疊格數已非常寬鬆。
const _rvMAX_FLIPS = 24;
const _rvMAX_PLY = 128;

const _rvFlipBuf = new Int8Array(_rvMAX_FLIPS);   // applyMove 用
const _rvEasyBuf = new Int8Array(_rvMAX_FLIPS);   // pickEasyMove 用
const _rvEdgeSeen = new Uint8Array(CELLS);        // countStableEdges 用
const _rvStableBuf = new Uint8Array(CELLS);       // countStableFull 用
const _rvStableEval = new Uint8Array(CELLS);      // evaluate 內部用（與上者分開避免互相覆蓋）

// 取得高解析度時間；Node 與瀏覽器都有 performance，沒有就退回 Date。
const _rvNow = (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
  ? function () { return performance.now(); }
  : function () { return Date.now(); };

// --------------------------------------------------------------------------
// 盤面建立、複製與字串互轉
// --------------------------------------------------------------------------
function createInitialBoard() {
  const board = new Int8Array(CELLS);
  board[27] = WHITE; // d4
  board[28] = BLACK; // e4
  board[35] = BLACK; // d5
  board[36] = WHITE; // e5
  return board;
}

function cloneBoard(board) {
  const next = new Int8Array(CELLS);
  next.set(board);
  return next;
}

// "." 空格 / "X" 黑 / "O" 白；接受 64 字元字串或 8 個字串的陣列，空白與換行一律忽略
function boardFromString(src) {
  const raw = Array.isArray(src) ? src.join('') : String(src == null ? '' : src);
  const board = new Int8Array(CELLS);
  let n = 0;
  for (let i = 0; i < raw.length && n < CELLS; i++) {
    const ch = raw.charAt(i);
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') continue;
    if (ch === 'X' || ch === 'x') board[n] = BLACK;
    else if (ch === 'O' || ch === 'o') board[n] = WHITE;
    else board[n] = EMPTY;
    n++;
  }
  return board;
}

// 輸出 8 行、以 \n 分隔的字串
function boardToString(board) {
  const lines = new Array(SIZE);
  for (let row = 0; row < SIZE; row++) {
    let line = '';
    for (let col = 0; col < SIZE; col++) {
      const v = board[row * SIZE + col];
      line += (v === BLACK ? 'X' : (v === WHITE ? 'O' : '.'));
    }
    lines[row] = line;
  }
  return lines.join('\n');
}

// --------------------------------------------------------------------------
// 規則核心：翻子、合法步與落子
// --------------------------------------------------------------------------
// 把 sq 這一手會翻到的格號寫進 out，回傳數量；非法或非空格回傳 0。
// 一條線上只翻到「最近的自己人」為止，中間夾到空格即整個方向不合法。
function collectFlips(board, sq, player, out) {
  if (sq < 0 || sq >= CELLS || board[sq] !== EMPTY) return 0;
  const opp = -player;
  let n = 0;
  for (let d = 0; d < 8; d++) {
    const ray = RAYS[sq * 8 + d];
    const len = ray.length;
    let i = 0;
    while (i < len && board[ray[i]] === opp) i++;
    // i > 0：至少夾到一顆對手子；board[ray[i]] === player：收尾的是自己人（空格會直接失敗）
    if (i > 0 && i < len && board[ray[i]] === player) {
      for (let k = 0; k < i; k++) {
        out[n] = ray[k];
        n++;
      }
    }
  }
  return n;
}

// 只判斷合法與否，找到第一個可翻方向就收工
function isLegalMove(board, sq, player) {
  if (sq < 0 || sq >= CELLS || board[sq] !== EMPTY) return false;
  const opp = -player;
  for (let d = 0; d < 8; d++) {
    const ray = RAYS[sq * 8 + d];
    const len = ray.length;
    let i = 0;
    while (i < len && board[ray[i]] === opp) i++;
    if (i > 0 && i < len && board[ray[i]] === player) return true;
  }
  return false;
}

// 回傳升冪排序的合法格號陣列（非熱路徑，允許配置陣列）
function getLegalMoves(board, player) {
  const moves = [];
  for (let sq = 0; sq < CELLS; sq++) {
    if (board[sq] !== EMPTY) continue;
    if (isLegalMove(board, sq, player)) moves.push(sq);
  }
  return moves;
}

function hasLegalMove(board, player) {
  for (let sq = 0; sq < CELLS; sq++) {
    if (board[sq] !== EMPTY) continue;
    if (isLegalMove(board, sq, player)) return true;
  }
  return false;
}

// 落子後回傳「全新的盤面」，絕對不動到傳入的 board；非法回 null。
function applyMove(board, sq, player) {
  const n = collectFlips(board, sq, player, _rvFlipBuf);
  if (n === 0) return null;
  const next = cloneBoard(board);
  next[sq] = player;
  const flips = new Array(n);
  for (let i = 0; i < n; i++) {
    const f = _rvFlipBuf[i];
    next[f] = player;
    flips[i] = f;
  }
  return { board: next, flips: flips };
}

function countDiscs(board) {
  let black = 0;
  let white = 0;
  let empty = 0;
  for (let sq = 0; sq < CELLS; sq++) {
    const v = board[sq];
    if (v === BLACK) black++;
    else if (v === WHITE) white++;
    else empty++;
  }
  return { black: black, white: white, empty: empty };
}

// 雙方皆無合法步即終局
function isGameOver(board) {
  return !hasLegalMove(board, BLACK) && !hasLegalMove(board, WHITE);
}

// 回傳 BLACK / WHITE / 0（和局）
function getWinner(board) {
  const c = countDiscs(board);
  if (c.black > c.white) return BLACK;
  if (c.white > c.black) return WHITE;
  return 0;
}

// --------------------------------------------------------------------------
// 局面特徵：行動力、潛在行動力、前沿子
// --------------------------------------------------------------------------
function countMobility(board, player) {
  let n = 0;
  for (let sq = 0; sq < CELLS; sq++) {
    if (board[sq] !== EMPTY) continue;
    if (isLegalMove(board, sq, player)) n++;
  }
  return n;
}

// 潛在行動力：貼著對手棋子的空格數（這些空格未來很可能變成自己的合法步）
function countPotentialMobility(board, player) {
  const opp = -player;
  let n = 0;
  for (let sq = 0; sq < CELLS; sq++) {
    if (board[sq] !== EMPTY) continue;
    const near = NEIGHBORS[sq];
    for (let i = 0; i < near.length; i++) {
      if (board[near[i]] === opp) {
        n++;
        break;
      }
    }
  }
  return n;
}

// 前沿子：己方棋子中至少鄰接一個空格者，越多代表越容易被對手咬
function countFrontier(board, player) {
  let n = 0;
  for (let sq = 0; sq < CELLS; sq++) {
    if (board[sq] !== player) continue;
    const near = NEIGHBORS[sq];
    for (let i = 0; i < near.length; i++) {
      if (board[near[i]] === EMPTY) {
        n++;
        break;
      }
    }
  }
  return n;
}

// --------------------------------------------------------------------------
// 穩定子計算（便宜版與完整版）
// --------------------------------------------------------------------------
// 便宜版：只從已佔領的角落沿著兩條邊往外數連續同色子。
function countStableEdges(board, player) {
  _rvEdgeSeen.fill(0);
  let n = 0;
  for (let i = 0; i < CORNERS.length; i++) {
    const corner = CORNERS[i];
    if (board[corner] !== player) continue;
    if (!_rvEdgeSeen[corner]) {
      _rvEdgeSeen[corner] = 1;
      n++;
    }
    const dirs = _rvCORNER_EDGE_DIRS[corner];
    for (let k = 0; k < dirs.length; k++) {
      const ray = RAYS[corner * 8 + dirs[k]];
      for (let j = 0; j < ray.length; j++) {
        const sq = ray[j];
        if (board[sq] !== player) break;
        if (!_rvEdgeSeen[sq]) {
          _rvEdgeSeen[sq] = 1;
          n++;
        }
      }
    }
  }
  return n;
}

// 判斷某顆子在一條軸上是否已經安全：
// (a) 該軸整條線已下滿，或 (b) 某一側緊鄰格出界，或 (c) 某一側緊鄰格是同色的已知穩定子。
function _rvAxisSecure(board, stable, sq, d1, d2, color) {
  const ray1 = RAYS[sq * 8 + d1];
  const ray2 = RAYS[sq * 8 + d2];
  // (b) 貼著棋盤邊界
  if (ray1.length === 0 || ray2.length === 0) return true;
  // (c) 緊鄰同色穩定子
  const n1 = ray1[0];
  const n2 = ray2[0];
  if (stable[n1] && board[n1] === color) return true;
  if (stable[n2] && board[n2] === color) return true;
  // (a) 整條線下滿，沒有空格可以反向包夾
  for (let i = 0; i < ray1.length; i++) {
    if (board[ray1[i]] === EMPTY) return false;
  }
  for (let i = 0; i < ray2.length; i++) {
    if (board[ray2[i]] === EMPTY) return false;
  }
  return true;
}

// 完整版：四軸固定點迭代。角落因為兩側都出界，天生就是種子。
function _rvComputeStable(board, stable) {
  stable.fill(0);
  let changed = true;
  while (changed) {
    changed = false;
    for (let sq = 0; sq < CELLS; sq++) {
      if (stable[sq] || board[sq] === EMPTY) continue;
      const color = board[sq];
      let secure = true;
      for (let a = 0; a < 4; a++) {
        const axis = _rvAXES[a];
        if (!_rvAxisSecure(board, stable, sq, axis[0], axis[1], color)) {
          secure = false;
          break;
        }
      }
      if (secure) {
        stable[sq] = 1;
        changed = true;
      }
    }
  }
  return stable;
}

function countStableFull(board, player) {
  _rvComputeStable(board, _rvStableBuf);
  let n = 0;
  for (let sq = 0; sq < CELLS; sq++) {
    if (_rvStableBuf[sq] && board[sq] === player) n++;
  }
  return n;
}

// --------------------------------------------------------------------------
// 盤面評估：一律先算「黑方視角」再依 player 翻號，保證嚴格反對稱
// --------------------------------------------------------------------------
// 正規化到約 ±100，分母 +1 避免除以零
function _rvNorm(a, b) {
  return 100 * (a - b) / (a + b + 1);
}

function _rvClip(v, limit) {
  if (v > limit) return limit;
  if (v < -limit) return -limit;
  return v;
}

function evaluate(board, player, opts) {
  const useFull = !!(opts && opts.fullStability);

  let black = 0;
  let white = 0;
  let empty = 0;
  let posBlack = 0;
  let posWhite = 0;
  for (let sq = 0; sq < CELLS; sq++) {
    const v = board[sq];
    if (v === BLACK) {
      black++;
      posBlack += POS_WEIGHTS[sq];
    } else if (v === WHITE) {
      white++;
      posWhite += POS_WEIGHTS[sq];
    } else {
      empty++;
    }
  }

  const w = empty >= 45 ? PHASE_W.opening : (empty >= 13 ? PHASE_W.midgame : PHASE_W.endgame);

  const mobBlack = countMobility(board, BLACK);
  const mobWhite = countMobility(board, WHITE);
  const pmobBlack = countPotentialMobility(board, BLACK);
  const pmobWhite = countPotentialMobility(board, WHITE);

  // 角落與危險守門格（X 位只在該角還空著時才算數）
  let cornerBlack = 0;
  let cornerWhite = 0;
  let xBlack = 0;
  let xWhite = 0;
  for (let i = 0; i < 4; i++) {
    const corner = CORNERS[i];
    const cv = board[corner];
    if (cv === BLACK) cornerBlack++;
    else if (cv === WHITE) cornerWhite++;
    else {
      const xv = board[X_SQUARES[i]];
      if (xv === BLACK) xBlack++;
      else if (xv === WHITE) xWhite++;
    }
  }

  let stableBlack;
  let stableWhite;
  if (useFull) {
    _rvComputeStable(board, _rvStableEval);
    stableBlack = 0;
    stableWhite = 0;
    for (let sq = 0; sq < CELLS; sq++) {
      if (!_rvStableEval[sq]) continue;
      if (board[sq] === BLACK) stableBlack++;
      else if (board[sq] === WHITE) stableWhite++;
    }
  } else {
    stableBlack = countStableEdges(board, BLACK);
    stableWhite = countStableEdges(board, WHITE);
  }

  const frontBlack = countFrontier(board, BLACK);
  const frontWhite = countFrontier(board, WHITE);

  let score = 0;
  score += w.pos * ((posBlack - posWhite) / 6);
  score += w.mob * _rvNorm(mobBlack, mobWhite);
  score += w.pmob * _rvNorm(pmobBlack, pmobWhite);
  score += w.corner * _rvClip(25 * (cornerBlack - cornerWhite), 100);
  score += w.xsq * _rvClip(-12.5 * (xBlack - xWhite), 100);
  score += w.stable * _rvNorm(stableBlack, stableWhite);
  score -= w.frontier * _rvNorm(frontBlack, frontWhite);
  score += w.disc * _rvNorm(black, white);

  return player === BLACK ? score : -score;
}

// 終局分數：子數差 d（player 視角）
function terminalScore(board, player) {
  const c = countDiscs(board);
  const mine = player === BLACK ? c.black : c.white;
  const yours = player === BLACK ? c.white : c.black;
  const d = mine - yours;
  if (d > 0) return 1e6 + d * 100;
  if (d < 0) return -1e6 + d * 100;
  return 0;
}

// --------------------------------------------------------------------------
// 搜尋內部：原地落子 / 還原（共用翻子堆疊，不在節點內配置新陣列）
// --------------------------------------------------------------------------
// 同一格往八個方向的射線彼此不重疊，所以邊翻邊掃不會互相汙染。
function _rvApplyInPlace(board, sq, player, stack, base) {
  const opp = -player;
  let n = 0;
  for (let d = 0; d < 8; d++) {
    const ray = RAYS[sq * 8 + d];
    const len = ray.length;
    let i = 0;
    while (i < len && board[ray[i]] === opp) i++;
    if (i > 0 && i < len && board[ray[i]] === player) {
      for (let k = 0; k < i; k++) {
        const f = ray[k];
        board[f] = player;
        stack[base + n] = f;
        n++;
      }
    }
  }
  if (n > 0) board[sq] = player;
  return n;
}

function _rvUndoInPlace(board, sq, player, stack, base, n) {
  if (n <= 0) return;
  board[sq] = EMPTY;
  const opp = -player;
  for (let i = 0; i < n; i++) {
    board[stack[base + i]] = opp;
  }
}

// 建立一份搜尋上下文（每次搜尋各自獨立，互不干擾）
function _rvNewContext() {
  const pv = new Int8Array(_rvMAX_PLY);
  pv.fill(-1);
  const killers = new Int8Array(_rvMAX_PLY);
  killers.fill(-1);
  return {
    board: null,
    stack: new Int8Array(_rvMAX_PLY * _rvMAX_FLIPS),
    moveBufs: new Array(_rvMAX_PLY),
    keyBufs: new Array(_rvMAX_PLY),
    pvByPly: pv,
    killers: killers,
    evalOpts: { fullStability: false },
    exact: false,
    nodes: 0,
    deadline: Infinity,
    aborted: false
  };
}

function _rvPlyBuf(ctx, ply) {
  let buf = ctx.moveBufs[ply];
  if (!buf) {
    buf = new Int8Array(CELLS);
    ctx.moveBufs[ply] = buf;
    ctx.keyBufs[ply] = new Int32Array(CELLS);
  }
  return buf;
}

// --------------------------------------------------------------------------
// 走步排序：PV move → killer move → 靜態格位優先序 → 對手行動力
// --------------------------------------------------------------------------
function _rvOrderMoves(ctx, moves, count, player, pvMove, killer, depth, ply) {
  const keys = ctx.keyBufs[ply];
  const board = ctx.board;
  const base = ply * _rvMAX_FLIPS; // 排序在本層的走子迴圈開始前跑完，可安全共用同一段堆疊
  for (let i = 0; i < count; i++) {
    const m = moves[i];
    let key;
    if (m === pvMove) {
      key = -2000000;
    } else if (m === killer) {
      key = -1000000;
    } else {
      key = SQ_ORDER[m] * 1000;
      if (depth >= 4) {
        // 深層才付得起這個成本：落子後讓對手行動力越小越優先
        const n = _rvApplyInPlace(board, m, player, ctx.stack, base);
        key += countMobility(board, -player);
        _rvUndoInPlace(board, m, player, ctx.stack, base, n);
      }
    }
    keys[i] = key;
  }
  // 插入排序（count 最多 30 出頭，比配置比較器物件划算）
  for (let i = 1; i < count; i++) {
    const mv = moves[i];
    const kv = keys[i];
    let j = i - 1;
    while (j >= 0 && keys[j] > kv) {
      keys[j + 1] = keys[j];
      moves[j + 1] = moves[j];
      j--;
    }
    keys[j + 1] = kv;
    moves[j + 1] = mv;
  }
}

// --------------------------------------------------------------------------
// negamax + alpha-beta
// --------------------------------------------------------------------------
// 無合法步時不減深度、換手並設 passed = true；雙方連續跳過即回 terminalScore。
function _rvNegamax(ctx, player, depth, alpha, beta, ply, passed) {
  if (ctx.aborted) return 0;
  ctx.nodes++;
  if ((ctx.nodes & 2047) === 0 && _rvNow() > ctx.deadline) {
    ctx.aborted = true;
    return 0;
  }

  const board = ctx.board;
  if (ply >= _rvMAX_PLY - 2) {
    return ctx.exact ? terminalScore(board, player) : evaluate(board, player, ctx.evalOpts);
  }

  const moves = _rvPlyBuf(ctx, ply);
  let count = 0;
  for (let sq = 0; sq < CELLS; sq++) {
    if (board[sq] !== EMPTY) continue;
    if (isLegalMove(board, sq, player)) {
      moves[count] = sq;
      count++;
    }
  }

  if (count === 0) {
    if (passed) return terminalScore(board, player);
    return -_rvNegamax(ctx, -player, depth, -beta, -alpha, ply + 1, true);
  }

  if (depth <= 0) {
    return ctx.exact ? terminalScore(board, player) : evaluate(board, player, ctx.evalOpts);
  }

  _rvOrderMoves(ctx, moves, count, player, ctx.pvByPly[ply], ctx.killers[ply], depth, ply);

  const alphaOrig = alpha;
  const base = ply * _rvMAX_FLIPS;
  let best = -INFINITY_SCORE;
  let bestMove = -1;

  for (let i = 0; i < count; i++) {
    const sq = moves[i];
    const n = _rvApplyInPlace(board, sq, player, ctx.stack, base);
    const score = -_rvNegamax(ctx, -player, depth - 1, -beta, -alpha, ply + 1, false);
    _rvUndoInPlace(board, sq, player, ctx.stack, base, n);
    if (ctx.aborted) return 0;
    if (score > best) {
      best = score;
      bestMove = sq;
    }
    if (best > alpha) alpha = best;
    if (alpha >= beta) {
      ctx.killers[ply] = sq;   // beta cutoff：記下殺手步給兄弟節點用
      break;
    }
  }

  // 只有 PV 節點（真的抬高了 alpha）才更新 PV 表，避免被淺層節點汙染
  if (best > alphaOrig && bestMove >= 0) ctx.pvByPly[ply] = bestMove;
  return best;
}

// --------------------------------------------------------------------------
// 分片搜尋任務：iterative deepening，以 root move 為分片粒度
// --------------------------------------------------------------------------
// 分片粒度＝一顆 root：step() 一定會完整算完至少一顆 root 才可能讓出主執行緒，
// 所以 index 必然前進（前進保證），不會發生「同一顆 root 每片重算又被砍掉」而燒光預算。
// conf.sliceMs 只是「算完一顆 root 之後要不要接著算下一顆」的軟邊界，不會丟棄任何成果；
// 真正中止搜尋的硬截止一律是總預算（timeBudgetMs / exactBudgetMs）。
// 因此單次 step() 的實際耗時 ≈ 軟邊界 + 最後那顆 root 的時間，上限仍被總預算夾住。
// 某一輪 depth 沒跑完就中止時，沿用上一輪已完整跑完的結果。
function createSearchTask(board, player, cfg) {
  const conf = cfg || {};
  const ctx = _rvNewContext();
  ctx.board = cloneBoard(board);
  ctx.evalOpts = { fullStability: !!conf.fullStability };

  const counts = countDiscs(board);
  const empties = counts.empty;
  const exactEmpties = typeof conf.exactEmpties === 'number' ? conf.exactEmpties : 0;
  const exact = empties > 0 && empties <= exactEmpties;
  ctx.exact = exact;

  const budget = exact
    ? (conf.exactBudgetMs || conf.timeBudgetMs || 1800)
    : (conf.timeBudgetMs || 400);
  const maxDepth = exact ? empties : Math.max(1, conf.maxDepth || 4);
  // 讓出主執行緒的軟邊界（毫秒）；實戰由 startAiTurn 傳入 AI_SLICE_MS
  const sliceMs = (typeof conf.sliceMs === 'number' && conf.sliceMs > 0) ? conf.sliceMs : 50;

  const roots = getLegalMoves(board, player);
  const startedAt = _rvNow();

  // 開局 8 手內在分數相近的步之間隨機挑一個，免得玩家每一局都看到同一盤棋。
  // deterministic: true 是逃生口（測試用），此時絕不呼叫 Math.random。
  const movesPlayed = CELLS - 4 - empties;
  const tieTol = (!conf.deterministic && typeof conf.tieToleranceEarly === 'number' && movesPlayed < 8)
    ? conf.tieToleranceEarly
    : 0;

  let curDepth = 1;
  let index = 0;
  let iterBest = -1;
  let iterScore = -INFINITY_SCORE;
  let iterAlpha = -INFINITY_SCORE;
  let iterScores = new Array(roots.length).fill(-INFINITY_SCORE);
  // 最後一輪「完整跑完」的走步順序與對應分數（在 roots 重排之前快照，索引才對得上）
  let doneOrder = null;
  let doneScores = null;

  const task = {
    best: roots.length > 0 ? roots[0] : -1,
    bestScore: 0,
    depth: 0,
    nodes: 0,
    done: roots.length === 0,
    exact: exact,
    maxDepth: maxDepth,
    step: step
  };

  function newIteration() {
    index = 0;
    iterBest = -1;
    iterScore = -INFINITY_SCORE;
    iterAlpha = -INFINITY_SCORE;
    iterScores = new Array(roots.length).fill(-INFINITY_SCORE);
  }

  // 開局變化性：在「與最佳步差距不超過 tieTol」的走步之間隨機挑一個
  function applyTieTolerance() {
    if (!(tieTol > 0) || !doneOrder || !doneScores) return;
    const pool = [];
    for (let i = 0; i < doneOrder.length; i++) {
      if (doneScores[i] >= task.bestScore - tieTol) pool.push(doneOrder[i]);
    }
    if (pool.length > 1) {
      const pick = Math.min(pool.length - 1, Math.floor(Math.random() * pool.length));
      task.best = pool[pick];
      task.bestScore = doneScores[doneOrder.indexOf(task.best)];
    }
  }

  function step() {
    if (task.done) return task;

    const sliceStart = _rvNow();
    const hardEnd = startedAt + budget;
    // 硬截止只看總預算：root 迴圈內不再用切片時間去砍搜尋，成果就不會被丟掉
    ctx.deadline = hardEnd;
    ctx.aborted = false;

    while (index < roots.length) {
      const sq = roots[index];
      const n = _rvApplyInPlace(ctx.board, sq, player, ctx.stack, 0);
      // tie 模式下不在 root 收窄 beta，各步分數才能互相比較
      const beta = tieTol > 0 ? INFINITY_SCORE : -iterAlpha;
      const score = -_rvNegamax(ctx, -player, curDepth - 1, -INFINITY_SCORE, beta, 1, false);
      _rvUndoInPlace(ctx.board, sq, player, ctx.stack, 0, n);
      task.nodes = ctx.nodes;
      if (ctx.aborted) break;   // 總預算用完才會走到這裡，這顆 root 是半成品
      iterScores[index] = score;
      if (score > iterScore) {
        iterScore = score;
        iterBest = sq;
        if (score > iterAlpha) iterAlpha = score;
      }
      index++;
      // 軟邊界：這顆 root 已經完整算完並記錄，讓出主執行緒不會損失任何工作
      if (_rvNow() - sliceStart >= sliceMs) break;
    }

    if (!ctx.aborted && index >= roots.length) {
      // 這一輪 depth 完整跑完，才敢採用
      task.best = iterBest;
      task.bestScore = iterScore;
      task.depth = curDepth;
      // 快照必須在下面的 splice/unshift 重排之前，否則索引會和分數錯位
      doneOrder = roots.slice();
      doneScores = iterScores.slice();
      const at = roots.indexOf(iterBest);
      if (at > 0) {
        roots.splice(at, 1);
        roots.unshift(iterBest);   // 本輪最佳步提到最前面，當下一輪的 PV move
      }
      ctx.pvByPly[0] = iterBest;
      if (curDepth >= maxDepth || _rvNow() >= hardEnd) {
        applyTieTolerance();
        task.done = true;
        return task;
      }
      curDepth++;
      newIteration();
      return task;
    }

    if (_rvNow() >= hardEnd) {
      // 總預算用完：第一輪都還沒完成的話，至少採用已算完的 root
      if (task.depth === 0 && iterBest >= 0) {
        task.best = iterBest;
        task.bestScore = iterScore;
        task.depth = curDepth;
      }
      applyTieTolerance();
      task.done = true;
    }
    return task;
  }

  return task;
}

// --------------------------------------------------------------------------
// 同步搜尋：給測試與「提示」功能使用
// --------------------------------------------------------------------------
// opts = { maxDepth, timeBudgetMs, exactEmpties, fullStability, deterministic, tieToleranceEarly }
// deterministic: true 時絕對不呼叫 Math.random，結果完全可重現。
function searchSync(board, player, opts) {
  const conf = opts || {};
  const roots = getLegalMoves(board, player);
  if (roots.length === 0) return { move: -1, score: 0, depth: 0, nodes: 0 };

  const ctx = _rvNewContext();
  ctx.board = cloneBoard(board);
  ctx.evalOpts = { fullStability: !!conf.fullStability };

  const counts = countDiscs(board);
  const empties = counts.empty;
  const exactEmpties = typeof conf.exactEmpties === 'number' ? conf.exactEmpties : 0;
  const exact = empties > 0 && empties <= exactEmpties;
  ctx.exact = exact;

  const maxDepth = exact ? empties : Math.max(1, conf.maxDepth || 4);
  const budget = typeof conf.timeBudgetMs === 'number' && conf.timeBudgetMs > 0 ? conf.timeBudgetMs : 0;
  const startedAt = _rvNow();
  ctx.deadline = budget > 0 ? startedAt + budget : Infinity;

  const deterministic = !!conf.deterministic;
  const tieTolerance = (!deterministic && typeof conf.tieToleranceEarly === 'number') ? conf.tieToleranceEarly : 0;
  const movesPlayed = CELLS - 4 - empties;
  // 開局 8 手內才製造變化；此時不在 root 收窄 alpha，才能拿到可比較的分數
  const tieMode = tieTolerance > 0 && movesPlayed < 8;

  let order = roots.slice();
  let best = order[0];
  let bestScore = 0;
  let doneDepth = 0;
  let lastOrder = null;
  let lastScores = null;

  for (let depth = 1; depth <= maxDepth; depth++) {
    ctx.aborted = false;
    let iterBest = -1;
    let iterScore = -INFINITY_SCORE;
    let iterAlpha = -INFINITY_SCORE;
    const scores = new Array(order.length);

    for (let i = 0; i < order.length; i++) {
      const sq = order[i];
      const n = _rvApplyInPlace(ctx.board, sq, player, ctx.stack, 0);
      const beta = tieMode ? INFINITY_SCORE : -iterAlpha;
      const score = -_rvNegamax(ctx, -player, depth - 1, -INFINITY_SCORE, beta, 1, false);
      _rvUndoInPlace(ctx.board, sq, player, ctx.stack, 0, n);
      if (ctx.aborted) break;
      scores[i] = score;
      if (score > iterScore) {
        iterScore = score;
        iterBest = sq;
        if (score > iterAlpha) iterAlpha = score;
      }
    }

    if (ctx.aborted) break;

    best = iterBest;
    bestScore = iterScore;
    doneDepth = depth;
    lastOrder = order.slice();
    lastScores = scores;

    const at = order.indexOf(iterBest);
    if (at > 0) {
      order.splice(at, 1);
      order.unshift(iterBest);
    }
    ctx.pvByPly[0] = iterBest;
  }

  if (tieMode && lastOrder && lastScores) {
    const pool = [];
    for (let i = 0; i < lastOrder.length; i++) {
      if (lastScores[i] >= bestScore - tieTolerance) pool.push(lastOrder[i]);
    }
    if (pool.length > 1) {
      const pick = Math.min(pool.length - 1, Math.floor(Math.random() * pool.length));
      best = pool[pick];
    }
  }

  return { move: best, score: bestScore, depth: doneDepth, nodes: ctx.nodes };
}

// --------------------------------------------------------------------------
// 簡單難度：佔角偏好 + 隨機 + 貪吃三段式
// --------------------------------------------------------------------------
// rng 預設 Math.random；有傳入時一定使用它，測試才能重現結果。
function pickEasyMove(board, player, rng) {
  const random = typeof rng === 'function' ? rng : Math.random;
  const moves = getLegalMoves(board, player);
  if (moves.length === 0) return -1;

  const conf = DIFFICULTIES.easy;

  const cornerMoves = [];
  for (let i = 0; i < moves.length; i++) {
    if (CORNERS.indexOf(moves[i]) >= 0) cornerMoves.push(moves[i]);
  }
  if (cornerMoves.length > 0 && random() < conf.cornerBias) {
    const pick = Math.min(cornerMoves.length - 1, Math.floor(random() * cornerMoves.length));
    return cornerMoves[pick];
  }

  if (random() < conf.randomRate) {
    const pick = Math.min(moves.length - 1, Math.floor(random() * moves.length));
    return moves[pick];
  }

  // 貪吃：翻最多子（同分取格號較小者，保持可決定）
  let best = moves[0];
  let bestFlips = -1;
  for (let i = 0; i < moves.length; i++) {
    const n = collectFlips(board, moves[i], player, _rvEasyBuf);
    if (n > bestFlips) {
      bestFlips = n;
      best = moves[i];
    }
  }
  return best;
}

// --------------------------------------------------------------------------
// 儲存鍵與 APP 段共用小工具（前綴 _app 以免與 CORE 段衝突）
// --------------------------------------------------------------------------
const SAVE_KEY = 'reversi_save_v1';
const STATS_KEY = 'reversi_stats_v1';
const PREF_KEY = 'reversi_pref_v1';
const HOME_PREF_KEY = 'bobo-home-preferences-v2';

const FILE_LABELS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const HINT_LIMIT = 3;
const TAP_THROTTLE_MS = 250;
const SHAKE_MS = 240;
// 動畫時序的唯一真相：CSS 只以 var() 取用，開場由 syncMotionTokens() 寫進 :root，
// 避免同一組數字在 JS 與 CSS 各留一份 copy 而漸漸不同步。
const FLIP_DURATION_MS = 300;   // 翻子基礎時長（對應 --flip-duration）
const FLIP_STEP_MS = 45;        // 每格距離的波浪延遲（對應 --flip-step）
const PLACE_POP_MS = 280;       // 落子彈入（對應 @keyframes dropIn）
const MODAL_FADE_MS = 250;      // 彈窗淡出（對應 .modal-overlay 的 opacity transition）
const SUGGEST_MS = 3000;
// AI 分片的「軟邊界」：超過這個時間就在兩顆 root 之間讓出主執行緒（不會丟棄已算完的 root）
const AI_SLICE_MS = 10;

// 高解析度時鐘；Node 測試環境沒有 performance 時退回 Date
function _appNow() {
  try {
    if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
      return performance.now();
    }
  } catch (_) {}
  return Date.now();
}

// localStorage 讀取：隱私模式或 JSON 壞掉一律回退預設值
function _appReadJson(key, fallback) {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return fallback;
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (parsed === null || parsed === undefined) return fallback;
    return parsed;
  } catch (_) {
    return fallback;
  }
}

function _appWriteJson(key, value) {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return false;
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (_) {
    return false;
  }
}

function _appRemoveKey(key) {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return;
    localStorage.removeItem(key);
  } catch (_) {}
}

function _appIsPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// 全站共用模組是「可缺席」的：Node 單元測試與模組載入失敗的頁面都沒有這些全域，
// 此時下面三個取用函式一律回 null，遊戲照常能玩
// （只是沒彩帶、沒音效、主題退回 prefers-color-scheme）。
function _appThemeKit() {
  return (typeof BoboTheme !== 'undefined' && BoboTheme) ? BoboTheme : null;
}

function _appConfettiKit() {
  return (typeof BoboConfetti !== 'undefined' && BoboConfetti) ? BoboConfetti : null;
}

function _appAudioKit() {
  return (typeof BoboAudio !== 'undefined' && BoboAudio) ? BoboAudio : null;
}

// 難度 id 白名單檢查：只認 DIFFICULTIES 的「自有屬性」。
// 裸的 DIFFICULTIES[id] 會讓 'toString' / 'constructor' 這類原型鏈上的 key 通過驗證，
// 被污染的存檔就會讓難度按鈕全暗、戰績寫到 Object.prototype 上而永遠不增加。
function _appHasDifficulty(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(DIFFICULTIES, id);
}

// 取得難度設定；非法 id 一律退回普通難度，呼叫端不必再自己判斷
function _appDifficultyCfg(id) {
  return _appHasDifficulty(id) ? DIFFICULTIES[id] : DIFFICULTIES.normal;
}

// 兩個格號之間的切比雪夫距離（翻子動畫的波紋順序就靠它）
function _appChebyshev(a, b) {
  const ra = Math.floor(a / SIZE);
  const ca = a % SIZE;
  const rb = Math.floor(b / SIZE);
  const cb = b % SIZE;
  return Math.max(Math.abs(ra - rb), Math.abs(ca - cb));
}

// 0 -> "a1"、63 -> "h8"
function _appSquareName(sq) {
  if (!Number.isInteger(sq) || sq < 0 || sq >= CELLS) return '--';
  return FILE_LABELS[sq % SIZE] + String(Math.floor(sq / SIZE) + 1);
}

function _appClamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// requestAnimationFrame 的安全包裝（Node 測試沒有這個 API）
function _appNextFrame(fn) {
  try {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(fn);
      return;
    }
  } catch (_) {}
  setTimeout(fn, 16);
}

// --------------------------------------------------------------------------
// 音效（落子、翻子、跳過、勝、敗、誤點）
//
// 瀏覽器樣板整段交給共用模組 BoboAudio：AudioContext 的延後建立與喚醒、
// 手勢解鎖、visibilitychange 進背景 suspend／回前景 resume、
// 每個 oscillator 的 stop() 與結束後 disconnect、
// 以及開關寫回 reversi_pref_v1.sound（讀回整包只改 sound 欄位）。
// 這個類別只剩下 reversi 自己的音色，頻率／波形／時長／音量／延遲一律照舊。
//
// 模組缺席時 kit 為 null，每個 play*() 安靜退場，遊戲照常能玩（只是沒聲音）。
// --------------------------------------------------------------------------
class ReversiSoundManager {
  constructor() {
    const audio = _appAudioKit();
    this.kit = audio ? audio.create({ storageKey: PREF_KEY, storageField: 'sound' }) : null;
    // 模組缺席時開關只留在記憶體。這裡仍要讀回偏好：否則 savePreferences()
    // 會把玩家原本開著的 sound 覆寫成 false，模組之後恢復了也變成靜音。
    const pref = _appReadJson(PREF_KEY, {});
    this.memoEnabled = (_appIsPlainObject(pref) && typeof pref.sound === 'boolean')
      ? pref.sound
      : true;
  }

  // 有模組時一律以 kit 為準（kit.enabled 是即時值，不是快照）
  get enabled() {
    return this.kit ? this.kit.enabled : this.memoEnabled;
  }

  set enabled(on) {
    this.memoEnabled = !!on;
    // setEnabled 會順手持久化，並在開啟時解鎖、關閉時停掉還在響的聲音
    if (this.kit) this.kit.setEnabled(this.memoEnabled);
  }

  toggle() {
    this.enabled = !this.enabled;
    return this.enabled;
  }

  // 落子：短促的木頭敲擊感
  playPlace() {
    if (!this.kit) return;
    this.kit.tone({ freq: 420, type: 'triangle', duration: 0.07, gain: 0.18 });
    this.kit.tone({ freq: 210, type: 'sine', duration: 0.1, gain: 0.1, delay: 0.01 });
  }

  // 翻子：輕脆的滑音
  playFlip() {
    if (!this.kit) return;
    this.kit.sweep({ from: 620, to: 980, type: 'sine', duration: 0.12, gain: 0.1 });
  }

  // 跳過：下行提示音
  playPass() {
    if (!this.kit) return;
    this.kit.sweep({ from: 520, to: 260, type: 'triangle', duration: 0.22, gain: 0.12 });
  }

  // 勝利：上行大三和弦琶音（原本的 setTimeout 琶音改用音訊時鐘排程，間隔不變）
  playWin() {
    if (!this.kit) return;
    this.kit.chord([523.25, 659.25, 783.99, 1046.5], {
      type: 'sine', duration: 0.22, gain: 0.16, stagger: 0.11
    });
  }

  // 落敗：下行小三和弦
  playLose() {
    if (!this.kit) return;
    this.kit.chord([392, 329.63, 261.63], {
      type: 'triangle', duration: 0.26, gain: 0.14, stagger: 0.14
    });
  }

  // 誤點：悶悶的低頻回饋
  playInvalid() {
    if (!this.kit) return;
    this.kit.tone({ freq: 150, type: 'square', duration: 0.09, gain: 0.09 });
  }
}

// --------------------------------------------------------------------------
// 主控制器 ReversiApp
// --------------------------------------------------------------------------
class ReversiApp {
  constructor() {
    this.sound = new ReversiSoundManager();

    // 對局設定
    this.mode = 'ai';                // 'ai' | 'duo'
    this.difficulty = 'normal';
    this.humanColor = BLACK;
    this.showHints = true;

    // 對局狀態
    this.board = createInitialBoard();
    this.current = BLACK;
    this.history = [];
    this.gameOver = false;
    this.winner = 0;
    this.lastMoveSq = -1;
    this.suggestedSq = -1;
    this.hintLimit = HINT_LIMIT;
    this.hintsUsed = 0;
    this.undosUsed = 0;

    // 流程旗標
    this.animating = false;
    this.thinking = false;
    this.animUntil = 0;
    this.lastTapAt = 0;
    this.focusIdx = 27;
    this.statsTab = 'normal';

    // 計時器控制代碼
    this.aiTimer = null;
    this.aiTask = null;
    this.aiToken = 0;
    this.aiStartAt = 0;
    this.animTimer = null;
    this.hintTimer = null;
    this.resultTimer = null;

    this.cells = [];
    this.el = {};
    this.lastFocusedElement = null;

    this.init();
  }

  // ------------------------------------------------------------------------
  // 啟動流程：先載入偏好與主題，再嘗試續玩未完成對局
  // ------------------------------------------------------------------------
  init() {
    this.initElements();
    this.syncMotionTokens();
    this.loadPreferences();
    this.initTheme();
    this.bindEvents();
    this.renderCoords();
    this.renderBoard({ animate: false, rebuild: true });
    this.syncControlState();

    if (!this.loadGameState()) {
      this.startNewGame({ silent: true });
    }
  }

  // ------------------------------------------------------------------------
  // DOM 元素快取（全專案唯一查詢 DOM 的地方）
  // ------------------------------------------------------------------------
  initElements() {
    if (typeof document === 'undefined') {
      this.el = {};
      return;
    }
    const byId = (id) => document.getElementById(id);
    this.el = {
      // 頂部工具列
      themeBtn: byId('theme-btn'),
      soundBtn: byId('sound-btn'),
      statsBtn: byId('stats-btn'),
      helpBtn: byId('help-btn'),
      titleText: byId('title-text'),

      // 模式 / 難度 / 執子
      modeTabs: document.querySelectorAll('.mode-tab-btn'),
      difficultyBar: byId('difficulty-bar'),
      diffBtns: document.querySelectorAll('#difficulty-bar .diff-btn'),
      sideBar: byId('side-bar'),
      sideBtns: document.querySelectorAll('.side-btn'),

      // HUD
      scoreCardBlack: byId('score-card-black'),
      scoreCardWhite: byId('score-card-white'),
      ownerBlack: byId('owner-black'),
      ownerWhite: byId('owner-white'),
      scoreBlack: byId('score-black'),
      scoreWhite: byId('score-white'),
      turnIndicator: byId('turn-indicator'),
      turnDisc: byId('turn-disc'),
      turnText: byId('turn-text'),
      legalCount: byId('legal-count'),
      aiThinking: byId('ai-thinking'),
      aiThinkingText: byId('ai-thinking-text'),
      ratioFill: byId('ratio-fill'),

      // 棋盤
      boardFrame: byId('board-frame'),
      coordFiles: byId('coord-files'),
      coordRanks: byId('coord-ranks'),
      boardEl: byId('board'),

      // 底部動作列
      undoBtn: byId('undo-btn'),
      hintBtn: byId('hint-btn'),
      hintBadge: byId('hint-badge'),
      restartBtn: byId('restart-btn'),
      toggleHintBtn: byId('toggle-hint-btn'),

      // 結算彈窗
      resultModal: byId('result-modal'),
      resultEmoji: byId('result-emoji'),
      resultTitleText: byId('result-title-text'),
      resultCloseBtn: byId('result-close-btn'),
      resultBlack: byId('result-black'),
      resultWhite: byId('result-white'),
      resultDetail: byId('result-detail'),
      resultWinrate: byId('result-winrate'),
      resultStreak: byId('result-streak'),
      resultReviewBtn: byId('result-review-btn'),
      resultAgainBtn: byId('result-again-btn'),

      // 重開確認彈窗
      confirmModal: byId('confirm-modal'),
      confirmTitle: byId('confirm-title'),
      confirmCloseBtn: byId('confirm-close-btn'),
      confirmText: byId('confirm-text'),
      confirmCancelBtn: byId('confirm-cancel-btn'),
      confirmOkBtn: byId('confirm-ok-btn'),

      // 戰績彈窗
      statsModal: byId('stats-modal'),
      statsDiffTabs: byId('stats-diff-tabs'),
      statsDiffBtns: document.querySelectorAll('#stats-diff-tabs .diff-btn'),
      statPlays: byId('stat-plays'),
      statWld: byId('stat-wld'),
      statWinrate: byId('stat-winrate'),
      statStreak: byId('stat-streak'),
      statBestdiff: byId('stat-bestdiff'),
      statsResetBtn: byId('stats-reset-btn'),
      statsOkBtn: byId('stats-ok-btn'),
      statsCloseBtn: byId('stats-close-btn'),

      // 說明彈窗
      helpModal: byId('help-modal'),
      helpCloseBtn: byId('help-close-btn'),
      helpOkBtn: byId('help-ok-btn'),

      // Toast 與彩帶
      toastContainer: byId('toast-container'),
      confettiCanvas: byId('confetti-canvas')
    };
  }

  // ------------------------------------------------------------------------
  // 偏好設定（reversi_pref_v1）
  // ------------------------------------------------------------------------
  loadPreferences() {
    const pref = _appReadJson(PREF_KEY, {});
    if (!_appIsPlainObject(pref)) return;
    if (pref.mode === 'ai' || pref.mode === 'duo') this.mode = pref.mode;
    if (_appHasDifficulty(pref.difficulty)) this.difficulty = pref.difficulty;
    if (pref.humanColor === BLACK || pref.humanColor === WHITE) this.humanColor = pref.humanColor;
    if (typeof pref.showHints === 'boolean') this.showHints = pref.showHints;
    if (typeof pref.sound === 'boolean' && this.sound) this.sound.enabled = pref.sound;
    this.statsTab = this.difficulty;
  }

  savePreferences() {
    _appWriteJson(PREF_KEY, {
      sound: !!(this.sound && this.sound.enabled),
      showHints: !!this.showHints,
      difficulty: this.difficulty,
      humanColor: this.humanColor,
      mode: this.mode
    });
  }

  // ------------------------------------------------------------------------
  // 主題（與首頁共用 bobo-home-preferences-v2）
  //
  // 有載到 BoboTheme 就整段交給它：偏好讀寫、meta theme-color、
  // 以及「只改 theme 欄位、不覆蓋首頁的 order / hidden」這條規則都在模組裡。
  // 模組缺席時走下面的退場路徑，行為與接模組前逐字相同。
  // ------------------------------------------------------------------------
  initTheme() {
    if (typeof document === 'undefined') return;
    const themeKit = _appThemeKit();
    if (themeKit) {
      // init() 會套用目前偏好，並在使用者沒明確選過主題時跟隨系統的 prefers-color-scheme
      this.updateThemeIcon(themeKit.init());
      return;
    }
    const home = _appReadJson(HOME_PREF_KEY, {});
    let theme = null;
    if (_appIsPlainObject(home) && (home.theme === 'dark' || home.theme === 'light')) {
      theme = home.theme;
    }
    if (!theme) {
      let prefersDark = false;
      try {
        prefersDark = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-color-scheme: dark)').matches;
      } catch (_) {}
      theme = prefersDark ? 'dark' : 'light';
    }
    this.applyTheme(theme);
  }

  applyTheme(theme) {
    if (typeof document === 'undefined') return;
    const themeKit = _appThemeKit();
    if (themeKit) {
      // apply() 回傳實際套用的主題（傳入非法值時會回退成目前偏好）
      this.updateThemeIcon(themeKit.apply(theme));
      return;
    }
    if (document.documentElement) document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0f172a' : '#f5f7fb');
    this.updateThemeIcon(theme);
  }

  toggleTheme() {
    if (typeof document === 'undefined') return;
    const themeKit = _appThemeKit();
    if (themeKit) {
      // toggle() 內部是「先讀回整包 bobo-home-preferences-v2，再只改 theme 欄位」
      this.updateThemeIcon(themeKit.toggle());
      return;
    }
    const next = (document.documentElement && document.documentElement.dataset.theme === 'dark') ? 'light' : 'dark';
    this.applyTheme(next);
    // 先讀回整包再只改 theme，不可整包覆寫（會清掉首頁的卡片順序與隱藏設定）
    const home = _appReadJson(HOME_PREF_KEY, {});
    const merged = _appIsPlainObject(home) ? home : {};
    merged.theme = next;
    _appWriteJson(HOME_PREF_KEY, merged);
  }

  updateThemeIcon(theme) {
    if (!this.el || !this.el.themeBtn) return;
    // 主題鍵語意是「按下去會切到另一個模式」，不是同一個狀態的按下／未按下，
    // 所以用會變動的 aria-label 陳述結果，而不是 aria-pressed（避免與系統偏好混淆）。
    if (typeof this.el.themeBtn.setAttribute === 'function') {
      const label = theme === 'dark' ? '切換為淺色模式' : '切換為深色模式';
      this.el.themeBtn.setAttribute('aria-label', label);
      this.el.themeBtn.setAttribute('title', label);
    }
    this.el.themeBtn.innerHTML = theme === 'dark'
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/></svg>';
  }

  updateSoundIcon() {
    if (!this.el || !this.el.soundBtn) return;
    const on = !!(this.sound && this.sound.enabled);
    this.el.soundBtn.innerHTML = on
      ? '<span>🔊</span>'
      : '<span style="opacity:0.5">🔇</span>';
    // 音效鍵是真正的開／關切換：比照底部「提示點」按鈕用 aria-pressed 表達狀態，
    // aria-label 維持固定字串，避免狀態被播報兩次。
    if (typeof this.el.soundBtn.setAttribute === 'function') {
      this.el.soundBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      this.el.soundBtn.setAttribute('title', on ? '音效開關（目前開啟）' : '音效開關（目前靜音）');
    }
  }

  // ------------------------------------------------------------------------
  // 事件綁定
  // ------------------------------------------------------------------------
  bindEvents() {
    if (typeof document === 'undefined' || !this.el) return;

    if (this.el.themeBtn) this.el.themeBtn.addEventListener('click', () => this.toggleTheme());
    if (this.el.soundBtn) {
      this.el.soundBtn.addEventListener('click', () => {
        const on = this.sound ? this.sound.toggle() : false;
        this.updateSoundIcon();
        this.savePreferences();
        this.showToast(on ? '🔊 音效已開啟' : '🔇 音效已靜音');
      });
    }
    if (this.el.statsBtn) this.el.statsBtn.addEventListener('click', () => this.openStatsModal());
    if (this.el.helpBtn) this.el.helpBtn.addEventListener('click', () => this.openHelpModal());

    if (this.el.modeTabs && this.el.modeTabs.forEach) {
      this.el.modeTabs.forEach((btn) => {
        btn.addEventListener('click', () => this.setMode(btn.dataset ? btn.dataset.mode : null));
      });
    }
    if (this.el.diffBtns && this.el.diffBtns.forEach) {
      this.el.diffBtns.forEach((btn) => {
        btn.addEventListener('click', () => this.setDifficulty(btn.dataset ? btn.dataset.diff : null));
      });
    }
    if (this.el.sideBtns && this.el.sideBtns.forEach) {
      this.el.sideBtns.forEach((btn) => {
        btn.addEventListener('click', () => this.setSide(btn.dataset ? btn.dataset.side : null));
      });
    }

    if (this.el.boardEl) {
      this.el.boardEl.addEventListener('click', (event) => this.handleBoardClick(event));
    }

    if (this.el.undoBtn) this.el.undoBtn.addEventListener('click', () => this.undo());
    if (this.el.hintBtn) this.el.hintBtn.addEventListener('click', () => this.hint());
    if (this.el.restartBtn) this.el.restartBtn.addEventListener('click', () => this.requestRestart());
    if (this.el.toggleHintBtn) this.el.toggleHintBtn.addEventListener('click', () => this.toggleHints());

    // 彈窗按鈕
    if (this.el.resultCloseBtn) this.el.resultCloseBtn.addEventListener('click', () => this.closeModal(this.el.resultModal));
    if (this.el.resultReviewBtn) this.el.resultReviewBtn.addEventListener('click', () => this.reviewFinalBoard());
    if (this.el.resultAgainBtn) {
      this.el.resultAgainBtn.addEventListener('click', () => {
        this.closeModal(this.el.resultModal);
        this.startNewGame();
      });
    }
    if (this.el.confirmCloseBtn) this.el.confirmCloseBtn.addEventListener('click', () => this.closeModal(this.el.confirmModal));
    if (this.el.confirmCancelBtn) this.el.confirmCancelBtn.addEventListener('click', () => this.closeModal(this.el.confirmModal));
    if (this.el.confirmOkBtn) {
      this.el.confirmOkBtn.addEventListener('click', () => {
        this.closeModal(this.el.confirmModal);
        this.startNewGame();
      });
    }
    if (this.el.statsCloseBtn) this.el.statsCloseBtn.addEventListener('click', () => this.closeModal(this.el.statsModal));
    if (this.el.statsOkBtn) this.el.statsOkBtn.addEventListener('click', () => this.closeModal(this.el.statsModal));
    if (this.el.statsResetBtn) this.el.statsResetBtn.addEventListener('click', () => this.resetStats());
    if (this.el.statsDiffBtns && this.el.statsDiffBtns.forEach) {
      this.el.statsDiffBtns.forEach((btn) => {
        btn.addEventListener('click', () => this.renderStats(btn.dataset ? btn.dataset.statdiff : null));
      });
    }
    if (this.el.helpCloseBtn) this.el.helpCloseBtn.addEventListener('click', () => this.closeModal(this.el.helpModal));
    if (this.el.helpOkBtn) this.el.helpOkBtn.addEventListener('click', () => this.closeModal(this.el.helpModal));

    // 點遮罩關閉彈窗
    document.querySelectorAll('.modal-overlay').forEach((modal) => {
      modal.addEventListener('click', (event) => {
        if (event.target === modal) this.closeModal(modal);
      });
    });

    document.addEventListener('keydown', (event) => this.handleKeydown(event));

    // 切到背景與離開頁面時保存進度
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.saveGameState();
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => this.saveGameState());
    }
  }

  // ------------------------------------------------------------------------
  // 鍵盤操作：方向鍵移動焦點、Enter/Space 落子、U 悔棋、H 提示、Esc 關窗
  // ------------------------------------------------------------------------
  handleKeydown(event) {
    if (!event || typeof document === 'undefined') return;
    const openModal = document.querySelector('.modal-overlay.open');

    if (event.key === 'Escape') {
      if (openModal) this.closeModal(openModal);
      return;
    }

    if (event.key === 'Tab' && openModal) {
      const focusable = this.focusableIn(openModal);
      if (focusable.length === 0) {
        // 彈窗內沒有任何可聚焦元素時也不能讓焦點溜到背景頁去
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!active || typeof openModal.contains !== 'function' || !openModal.contains(active)) {
        // 焦點已經在彈窗外（點到彈窗內純文字就會掉到 <body>）：強制拉回彈窗頭尾
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (openModal) return;

    const target = event.target;
    const tag = target && target.tagName ? target.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (target && target.isContentEditable) return;

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      // 只有焦點確實在棋盤內才攔截方向鍵；否則交還瀏覽器，
      // 讓頁面捲動、工具列瀏覽與模式分頁的左右鍵切換維持原生行為。
      const inBoard = !!(target && typeof target.closest === 'function' && target.closest('#board'));
      if (!inBoard) return;
      event.preventDefault();
      this.moveFocus(event.key);
      return;
    }
    if (event.key === 'u' || event.key === 'U') {
      event.preventDefault();
      this.undo();
      return;
    }
    if (event.key === 'h' || event.key === 'H') {
      event.preventDefault();
      this.hint();
    }
    // Enter / Space 由 button 元素的原生行為觸發 click，不另外處理避免重複落子
  }

  // 取出容器內「真的可以被 Tab 到」的元素（過濾掉 hidden 與尺寸為 0 的殘留節點）
  focusableIn(container) {
    if (!container || typeof container.querySelectorAll !== 'function') return [];
    const nodes = Array.prototype.slice.call(container.querySelectorAll(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'
    ));
    return nodes.filter((el) => {
      if (!el || el.hidden) return false;
      if (el.offsetWidth > 0 || el.offsetHeight > 0) return true;
      // position: fixed 的元素 offsetParent 為 null，改用 getClientRects 判斷
      return typeof el.getClientRects === 'function' && el.getClientRects().length > 0;
    });
  }

  // roving tabindex：只有目前焦點格留在 Tab 順序中，其餘 63 格設為 -1，
  // 讓鍵盤使用者一次 Tab 就能跨過棋盤，格子之間改用方向鍵移動。
  syncCellTabIndex() {
    if (!Array.isArray(this.cells) || this.cells.length !== CELLS) return;
    const target = (Number.isInteger(this.focusIdx) && this.focusIdx >= 0 && this.focusIdx < CELLS)
      ? this.focusIdx
      : 27;
    this.focusIdx = target;
    for (let i = 0; i < CELLS; i++) {
      const cell = this.cells[i];
      if (cell) cell.tabIndex = (i === target ? 0 : -1);
    }
  }

  moveFocus(key) {
    const active = (typeof document !== 'undefined' && document.activeElement) ? document.activeElement : null;
    let cur = Number.isInteger(this.focusIdx) ? this.focusIdx : 27;
    if (active && active.dataset && active.dataset.idx !== undefined) {
      const parsed = parseInt(active.dataset.idx, 10);
      if (Number.isInteger(parsed)) cur = parsed;
    }
    let row = Math.floor(cur / SIZE);
    let col = cur % SIZE;
    if (key === 'ArrowUp') row -= 1;
    else if (key === 'ArrowDown') row += 1;
    else if (key === 'ArrowLeft') col -= 1;
    else if (key === 'ArrowRight') col += 1;
    row = _appClamp(row, 0, SIZE - 1);
    col = _appClamp(col, 0, SIZE - 1);
    this.focusIdx = row * SIZE + col;
    this.syncCellTabIndex();
    const cell = this.cells && this.cells[this.focusIdx];
    if (cell && typeof cell.focus === 'function') cell.focus();
  }

  // ------------------------------------------------------------------------
  // 棋盤渲染：只建立一次 64 個按鈕，之後僅更新 class / dataset
  // ------------------------------------------------------------------------
  renderCoords() {
    if (!this.el) return;
    if (this.el.coordFiles) {
      this.el.coordFiles.innerHTML = FILE_LABELS.map((f) => `<span>${f}</span>`).join('');
    }
    if (this.el.coordRanks) {
      this.el.coordRanks.innerHTML = FILE_LABELS.map((_f, i) => `<span>${i + 1}</span>`).join('');
    }
  }

  renderBoard(options) {
    const opts = options || {};
    if (!this.el || !this.el.boardEl || typeof document === 'undefined') return;
    const boardEl = this.el.boardEl;
    const needBuild = opts.rebuild || !Array.isArray(this.cells) || this.cells.length !== CELLS;

    if (needBuild) {
      boardEl.innerHTML = '';
      this.cells = [];
      const frag = document.createDocumentFragment();
      const startIdx = (Number.isInteger(this.focusIdx) && this.focusIdx >= 0 && this.focusIdx < CELLS)
        ? this.focusIdx
        : 27;
      for (let row = 0; row < SIZE; row++) {
        // role="grid" 底下必須是 role="row"，否則整個 grid 結構無效、AT 數不到列。
        // 列容器（.board-row）與格容器（.board-cell）都用 display: contents 不參與版面，
        // 這樣 #board 的 repeat(8, 1fr) 格線仍然直接排到 64 顆 .cell 上。
        // 這裡同時寫 inline style 當保險，CSS 還沒補上規則時版面也不會壞。
        const rowEl = document.createElement('div');
        rowEl.className = 'board-row';
        rowEl.setAttribute('role', 'row');
        if (rowEl.style) rowEl.style.display = 'contents';

        for (let col = 0; col < SIZE; col++) {
          const i = row * SIZE + col;
          // gridcell 角色掛在外層容器上、不掛在按鈕上，按鈕才能保留原生 button 語意，
          // AT 會繼續播報「按鈕」，使用者也才知道可以按 Enter / 空白鍵落子。
          const cellEl = document.createElement('div');
          cellEl.className = 'board-cell';
          cellEl.setAttribute('role', 'gridcell');
          if (cellEl.style) cellEl.style.display = 'contents';

          const btn = document.createElement('button');
          btn.className = 'cell';
          btn.type = 'button';
          // roving tabindex：建立當下就只留一格在 Tab 順序中
          btn.tabIndex = (i === startIdx ? 0 : -1);
          btn.dataset.idx = String(i);
          btn.innerHTML = '<span class="disc"><span class="disc-face front"></span><span class="disc-face back"></span></span>'
            + '<span class="hint-dot" aria-hidden="true"></span>';
          cellEl.appendChild(btn);
          rowEl.appendChild(cellEl);
          this.cells.push(btn);
        }
        frag.appendChild(rowEl);
      }
      boardEl.appendChild(frag);
    }

    // 不播動畫時清掉波紋順序，避免殘留上一手的延遲
    if (opts.animate === false) {
      for (let i = 0; i < this.cells.length; i++) {
        const cell = this.cells[i];
        if (!cell) continue;
        if (cell.style && cell.style.removeProperty) cell.style.removeProperty('--flip-order');
        if (cell.classList) {
          cell.classList.remove('just-placed');
          cell.classList.remove('shake');
        }
      }
    }

    boardEl.dataset.hints = this.showHints ? 'on' : 'off';
    this.updateBoardCells();
  }

  updateBoardCells() {
    if (!Array.isArray(this.cells) || this.cells.length !== CELLS || !this.board) return;
    // 翻子動畫期間 handleHumanMove 會擋掉落子，所以這裡也不能再宣稱「可落子」——
    // 綠色提示點與 aria-label 必須跟實際可操作狀態一致，否則玩家會以為卡住而猛點。
    const playable = !this.gameOver && !this.thinking && !this.animating && this.isHumanTurn();
    const legal = playable ? getLegalMoves(this.board, this.current) : [];
    const legalSet = new Set(legal);

    for (let i = 0; i < CELLS; i++) {
      const cell = this.cells[i];
      if (!cell || !cell.classList) continue;
      const value = this.board[i];
      if (cell.dataset) {
        if (value === BLACK) cell.dataset.disc = 'black';
        else if (value === WHITE) cell.dataset.disc = 'white';
        else delete cell.dataset.disc;
      }
      const isLegal = legalSet.has(i);
      cell.classList.toggle('legal', isLegal);
      cell.classList.toggle('last-move', i === this.lastMoveSq);
      cell.classList.toggle('suggested', i === this.suggestedSq);
      if (typeof cell.setAttribute === 'function') {
        const owner = value === BLACK ? '黑子' : (value === WHITE ? '白子' : '空格');
        cell.setAttribute('aria-label', `${_appSquareName(i)} ${owner}${isLegal ? '，可落子' : ''}`);
      }
    }

    this.syncCellTabIndex();
    this.updateBoardLock();
  }

  // 棋盤遮罩：AI 思考中或翻子動畫進行中都不接受落子，視覺與 ARIA 必須一起說實話
  updateBoardLock() {
    if (!this.el || !this.el.boardEl) return;
    const locked = !!this.thinking || !!this.animating;
    if (this.el.boardEl.classList) this.el.boardEl.classList.toggle('locked', locked);
    if (typeof this.el.boardEl.setAttribute === 'function') {
      this.el.boardEl.setAttribute('aria-busy', locked ? 'true' : 'false');
    }
  }

  // ------------------------------------------------------------------------
  // HUD：比分、輪次、可下點數、比例條
  // ------------------------------------------------------------------------
  refreshHUD() {
    if (!this.board) return;
    const counts = countDiscs(this.board);
    const total = counts.black + counts.white;

    if (this.el) {
      if (this.el.scoreBlack) this.el.scoreBlack.textContent = String(counts.black);
      if (this.el.scoreWhite) this.el.scoreWhite.textContent = String(counts.white);
      if (this.el.ownerBlack) this.el.ownerBlack.textContent = this.ownerLabel(BLACK);
      if (this.el.ownerWhite) this.el.ownerWhite.textContent = this.ownerLabel(WHITE);

      if (this.el.turnDisc && this.el.turnDisc.dataset) {
        this.el.turnDisc.dataset.color = this.current === WHITE ? 'white' : 'black';
      }
      if (this.el.turnText) this.el.turnText.textContent = this.turnLabel();

      const legalMoves = this.gameOver ? [] : getLegalMoves(this.board, this.current);
      if (this.el.legalCount) {
        this.el.legalCount.textContent = this.gameOver ? '對局結束' : `可下 ${legalMoves.length} 點`;
      }
      if (this.el.ratioFill && this.el.ratioFill.style) {
        const ratio = total > 0 ? Math.round((counts.black / total) * 100) : 50;
        this.el.ratioFill.style.width = `${ratio}%`;
      }
      if (this.el.scoreCardBlack && this.el.scoreCardBlack.classList) {
        this.el.scoreCardBlack.classList.toggle('turn-active', !this.gameOver && this.current === BLACK);
      }
      if (this.el.scoreCardWhite && this.el.scoreCardWhite.classList) {
        this.el.scoreCardWhite.classList.toggle('turn-active', !this.gameOver && this.current === WHITE);
      }
    }

    this.updateBoardCells();
    this.updateActionButtons();
  }

  updateActionButtons() {
    if (!this.el) return;
    const canUndo = this.canUndo();
    // 兩顆按鈕的 disabled 條件必須與 undo() / hint() 內部的守衛完全一致，
    // 否則按鈕看起來可按、按下去卻被靜默吞掉。
    if (this.el.undoBtn) {
      this.el.undoBtn.disabled = !!this.thinking || !!this.animating || !!this.gameOver || !canUndo;
    }
    const hintsLeft = Math.max(0, this.hintLimit - (this.hintsUsed || 0));
    if (this.el.hintBadge) this.el.hintBadge.textContent = String(hintsLeft);
    if (this.el.hintBtn) {
      this.el.hintBtn.disabled = !!this.thinking || !!this.animating || !!this.gameOver
        || hintsLeft <= 0 || !this.isHumanTurn();
    }
    if (this.el.toggleHintBtn && typeof this.el.toggleHintBtn.setAttribute === 'function') {
      this.el.toggleHintBtn.setAttribute('aria-pressed', this.showHints ? 'true' : 'false');
    }
  }

  // 依模式回傳該色的擁有者名稱
  ownerLabel(color) {
    if (this.mode === 'duo') return color === BLACK ? '玩家一' : '玩家二';
    return color === this.humanColor ? '你' : '電腦';
  }

  // 提示訊息用的稱呼，例如「電腦（白）」
  sideLabel(color) {
    const disc = color === BLACK ? '黑' : '白';
    if (this.mode === 'duo') return `${disc}方`;
    return color === this.humanColor ? `你（${disc}）` : `電腦（${disc}）`;
  }

  turnLabel() {
    if (this.gameOver) {
      if (this.winner === 0) return '和局';
      if (this.mode === 'duo') return this.winner === BLACK ? '黑方獲勝' : '白方獲勝';
      return this.winner === this.humanColor ? '你獲勝！' : '電腦獲勝';
    }
    if (this.mode === 'duo') return this.current === BLACK ? '輪到黑方' : '輪到白方';
    return this.current === this.humanColor ? '輪到你' : '輪到電腦';
  }

  isHumanTurn() {
    if (this.mode === 'duo') return true;
    return this.current === this.humanColor;
  }

  // ------------------------------------------------------------------------
  // 對局流程：落子、回合推進、結束
  // ------------------------------------------------------------------------
  handleBoardClick(event) {
    if (!event || !event.target || typeof event.target.closest !== 'function') return;
    const target = event.target.closest('.cell');
    if (!target || !target.dataset) return;
    const idx = parseInt(target.dataset.idx, 10);
    if (!Number.isInteger(idx)) return;
    this.focusIdx = idx;
    this.syncCellTabIndex();
    this.handleHumanMove(idx);
  }

  handleHumanMove(sq) {
    // animating / thinking 期間一律不收落子；此時 updateBoardCells 不會標示「可落子」、
    // updateBoardLock 也會蓋上 .locked 遮罩，畫面與行為一致，不會有靜默吞掉輸入的落差。
    if (this.gameOver || this.animating || this.thinking) return false;
    if (!this.isHumanTurn()) return false;
    if (!Number.isInteger(sq) || sq < 0 || sq >= CELLS) return false;

    // 連點節流：避免手指連拍造成連續落子
    // lastTapAt 為 0 代表這一局還沒落過子，不可節流
    // （_appNow() 是「開頁後經過的毫秒數」，開頁前 250ms 內會誤判成連點）
    const now = _appNow();
    if (this.lastTapAt && now - this.lastTapAt < TAP_THROTTLE_MS) return false;

    if (!isLegalMove(this.board, sq, this.current)) {
      this.rejectCell(sq);
      return false;
    }
    this.lastTapAt = now;
    return this.commitMove(sq, this.current);
  }

  // 誤點回饋：抖一下並出聲，完全不動狀態
  rejectCell(sq) {
    if (this.sound) this.sound.playInvalid();
    const cell = Array.isArray(this.cells) ? this.cells[sq] : null;
    if (!cell || !cell.classList) return;
    cell.classList.add('shake');
    setTimeout(() => {
      if (cell.classList) cell.classList.remove('shake');
    }, SHAKE_MS);
  }

  commitMove(sq, player) {
    if (this.gameOver) return false;
    const applied = applyMove(this.board, sq, player);
    if (!applied) return false;

    this.board = applied.board;
    const flips = Array.prototype.slice.call(applied.flips || []);
    this.history.push({ type: 'move', sq, player, flips });
    this.lastMoveSq = sq;
    this.clearSuggestion();

    if (this.sound) {
      this.sound.playPlace();
      if (flips.length > 0) setTimeout(() => this.sound.playFlip(), 90);
    }

    this.playFlipAnimation(sq, flips, player);
    this.advanceTurn();
    this.saveGameState();
    return true;
  }

  // 換手；對方無棋可下就記一筆 pass 並維持自己回合，雙方皆無則結束
  advanceTurn() {
    this.current = -this.current;
    this.clearSuggestion();
    const alive = this.resolveTurn();
    this.refreshHUD();
    if (!alive) return false;
    this.maybeStartAiTurn();
    return true;
  }

  // 確保 this.current 是有合法步的一方；silent 供存檔 replay 使用
  resolveTurn(options) {
    const opts = options || {};
    if (hasLegalMove(this.board, this.current)) return true;
    if (hasLegalMove(this.board, -this.current)) {
      const skipped = this.current;
      // pass 的 player 記錄「被跳過的一方」
      this.history.push({ type: 'pass', player: skipped });
      this.current = -skipped;
      if (!opts.silent) {
        this.showToast(`${this.sideLabel(skipped)}無棋可下，跳過一手`);
        if (this.sound) this.sound.playPass();
      }
      return true;
    }
    if (!opts.silent) this.endGame();
    return false;
  }

  maybeStartAiTurn() {
    if (this.mode !== 'ai' || this.gameOver) return;
    if (this.current === this.humanColor) return;
    this.startAiTurn();
  }

  endGame() {
    if (this.gameOver) return;
    this.gameOver = true;
    this.abortAi();
    this.clearSuggestion();
    this.winner = getWinner(this.board);
    this.clearGameState();

    const bucket = this.recordResult();
    const humanWin = this.mode === 'duo' ? false : this.winner === this.humanColor;

    if (this.sound) {
      if (this.mode === 'duo' || this.winner === 0) this.sound.playPass();
      else if (humanWin) this.sound.playWin();
      else this.sound.playLose();
    }
    if (humanWin || (this.mode === 'duo' && this.winner !== 0)) {
      this.triggerConfetti();
    }

    this.refreshHUD();

    const wait = Math.max(0, (this.animUntil || 0) - _appNow()) + 260;
    if (this.resultTimer) clearTimeout(this.resultTimer);
    this.resultTimer = setTimeout(() => {
      this.resultTimer = null;
      this.showResultModal(bucket);
    }, wait);
  }

  startNewGame(options) {
    const opts = options || {};
    this.abortAi();
    this.clearSuggestion();
    if (this.animTimer) {
      clearTimeout(this.animTimer);
      this.animTimer = null;
    }
    if (this.resultTimer) {
      clearTimeout(this.resultTimer);
      this.resultTimer = null;
    }

    this.board = createInitialBoard();
    this.current = BLACK;
    this.history = [];
    this.gameOver = false;
    this.winner = 0;
    this.lastMoveSq = -1;
    this.hintsUsed = 0;
    this.undosUsed = 0;
    this.animating = false;
    this.animUntil = 0;
    this.lastTapAt = 0;
    this.focusIdx = 27;

    this.clearGameState();
    this.syncControlState();
    this.renderBoard({ animate: false });
    this.refreshHUD();
    this.savePreferences();
    if (!opts.silent) this.showToast('🆕 新的一局開始囉');
    this.maybeStartAiTurn();
  }

  requestRestart() {
    const inProgress = Array.isArray(this.history)
      && this.history.some((h) => h && h.type === 'move')
      && !this.gameOver;
    if (!inProgress) {
      this.startNewGame();
      return;
    }
    if (this.el) {
      if (this.el.confirmTitle) this.el.confirmTitle.textContent = '重新開始？';
      if (this.el.confirmText) this.el.confirmText.textContent = '目前這局的進度會全部消失，確定要重新開始嗎？';
    }
    this.openModal(this.el ? this.el.confirmModal : null, this.el ? this.el.confirmCancelBtn : null);
  }

  // ------------------------------------------------------------------------
  // AI 回合：shallow 直接挑步，search 用 setTimeout 分片驅動
  // ------------------------------------------------------------------------
  startAiTurn() {
    if (this.mode !== 'ai' || this.gameOver) return;
    if (this.current === this.humanColor) return;
    if (this.thinking) return;

    const cfg = _appDifficultyCfg(this.difficulty);
    this.thinking = true;
    this.aiToken = (this.aiToken || 0) + 1;
    const token = this.aiToken;
    this.aiStartAt = _appNow();
    this.setThinkingUI(true);

    if (cfg.engine === 'shallow') {
      const move = pickEasyMove(this.board, this.current);
      this.aiTimer = setTimeout(() => this.commitAiMove(token, move), this.readyDelay(cfg));
      return;
    }

    // sliceMs 放在最後覆寫，確保 AI_SLICE_MS 真的生效，也不會就地改到 DIFFICULTIES 物件
    const task = createSearchTask(this.board, this.current, Object.assign({}, cfg, { sliceMs: AI_SLICE_MS }));
    this.aiTask = task;

    // 切片語意：step() 一定會完整算完至少一顆 root，超過 AI_SLICE_MS 這個軟邊界才讓出主執行緒，
    // 所以單片實際阻塞 ≈ AI_SLICE_MS + 最後那顆 root 的時間，並非「最多 10ms」。
    // 換來的是每一片的成果都會被保留（前進保證），深度不會被切片砍死 —— 詳見 createSearchTask 的註解。
    // 這裡刻意用 setTimeout(fn, 0)：瀏覽器的閒置回呼 API 在 iOS 舊版不支援，
    // 而且主執行緒忙碌時可能被無限延後，玩家會以為 AI 當掉。
    const pump = () => {
      if (token !== this.aiToken) return;
      this.aiTimer = null;
      try {
        const sliceEnd = _appNow() + AI_SLICE_MS;
        while (!task.done && _appNow() < sliceEnd) {
          task.step();
        }
      } catch (_) {
        this.aiTimer = setTimeout(() => this.commitAiMove(token, -1), 0);
        return;
      }
      if (!task.done) {
        this.aiTimer = setTimeout(pump, 0);
        return;
      }
      const best = task.best;
      this.aiTimer = setTimeout(() => this.commitAiMove(token, best), this.readyDelay(cfg));
    };
    this.aiTimer = setTimeout(pump, 0);
  }

  // 最短思考時間與翻子動畫都跑完才落子（搜尋比動畫快時才需要補等待）
  readyDelay(cfg) {
    const minThink = (cfg && cfg.minThinkMs) || 0;
    const earliest = Math.max((this.aiStartAt || 0) + minThink, this.animUntil || 0);
    return Math.max(0, Math.round(earliest - _appNow()));
  }

  commitAiMove(token, sq) {
    if (token !== this.aiToken) return false;
    this.aiTimer = null;
    this.aiTask = null;
    this.thinking = false;
    this.setThinkingUI(false);
    if (this.gameOver || this.mode !== 'ai') return false;

    let target = sq;
    if (!Number.isInteger(target) || target < 0 || !isLegalMove(this.board, target, this.current)) {
      const legal = getLegalMoves(this.board, this.current);
      if (legal.length === 0) {
        this.advanceTurn();
        return false;
      }
      target = legal[0];
    }
    return this.commitMove(target, this.current);
  }

  // 悔棋 / 重開 / 切難度時安全中止搜尋
  abortAi() {
    this.aiToken = (this.aiToken || 0) + 1;
    if (this.aiTimer) {
      clearTimeout(this.aiTimer);
      this.aiTimer = null;
    }
    this.aiTask = null;
    this.thinking = false;
    this.setThinkingUI(false);
  }

  setThinkingUI(active) {
    if (!this.el) return;
    if (this.el.aiThinking) this.el.aiThinking.hidden = !active;
    if (this.el.aiThinkingText) {
      const cfg = _appDifficultyCfg(this.difficulty);
      this.el.aiThinkingText.textContent = active && cfg ? `${cfg.name}AI 思考中…` : 'AI 思考中…';
    }
    this.updateBoardLock();
    this.updateActionButtons();
  }

  // ------------------------------------------------------------------------
  // 翻子動畫：以切比雪夫距離做波紋延遲
  // ------------------------------------------------------------------------
  prefersReducedMotion() {
    try {
      return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_) {
      return false;
    }
  }

  // 把 JS 的時序常數推進 CSS 變數，確保兩邊永遠同一組數字
  syncMotionTokens() {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (!root || !root.style || typeof root.style.setProperty !== 'function') return;
    root.style.setProperty('--flip-duration', FLIP_DURATION_MS + 'ms');
    root.style.setProperty('--flip-step', FLIP_STEP_MS + 'ms');
    root.style.setProperty('--place-pop-duration', PLACE_POP_MS + 'ms');
  }

  playFlipAnimation(sq, flips, player) {
    const list = Array.isArray(flips) ? flips : Array.prototype.slice.call(flips || []);
    const reduce = this.prefersReducedMotion();
    let maxDist = 0;
    for (let i = 0; i < list.length; i++) {
      const d = _appChebyshev(sq, list[i]);
      if (d > maxDist) maxDist = d;
    }
    const duration = reduce ? 0 : FLIP_DURATION_MS + maxDist * FLIP_STEP_MS;
    const color = player === BLACK ? 'black' : 'white';
    const cells = Array.isArray(this.cells) ? this.cells : [];

    const placed = cells[sq];
    if (placed) {
      // 落子格本身不參與波浪延遲；不歸零的話會沿用這一格上次翻面留下的值
      if (placed.style && typeof placed.style.setProperty === 'function') {
        placed.style.setProperty('--flip-order', '0');
      }
      if (placed.dataset) placed.dataset.disc = color;
      if (!reduce && placed.classList) {
        placed.classList.add('just-placed');
        setTimeout(() => {
          if (placed.classList) placed.classList.remove('just-placed');
        }, PLACE_POP_MS + 80);   // 多留 80ms 緩衝，確保動畫收尾後才移除 class
      }
    }

    for (let i = 0; i < list.length; i++) {
      const idx = list[i];
      const cell = cells[idx];
      if (!cell) continue;
      if (cell.style && cell.style.setProperty) {
        cell.style.setProperty('--flip-order', String(reduce ? 0 : _appChebyshev(sq, idx)));
      }
      if (cell.dataset) cell.dataset.disc = color;
    }

    this.animUntil = _appNow() + duration;
    if (duration > 0) {
      this.animating = true;
      // 動畫一開始就上鎖：綠點與 .locked 遮罩同步反映「現在不能下」
      this.updateBoardLock();
      if (this.animTimer) clearTimeout(this.animTimer);
      this.animTimer = setTimeout(() => {
        this.animTimer = null;
        this.animating = false;
        this.updateBoardCells();
        this.updateActionButtons();
      }, duration);
    } else {
      if (this.animTimer) {
        clearTimeout(this.animTimer);
        this.animTimer = null;
      }
      this.animating = false;
      this.updateBoardLock();
    }
    return duration;
  }

  // ------------------------------------------------------------------------
  // 悔棋：一路回退到「人類的上一手」為止
  // ------------------------------------------------------------------------
  canUndo() {
    if (!Array.isArray(this.history) || this.history.length === 0) return false;
    if (this.mode === 'duo') return this.history.some((h) => h && h.type === 'move');
    return this.history.some((h) => h && h.type === 'move' && h.player === this.humanColor);
  }

  revertEntry(entry) {
    if (!entry) return;
    if (entry.type === 'pass') {
      // pass 只還原輪次（後續 move 的還原會再覆蓋一次）
      this.current = entry.player;
      return;
    }
    if (entry.type !== 'move') return;
    this.board[entry.sq] = EMPTY;
    const flips = Array.isArray(entry.flips) ? entry.flips : [];
    for (let i = 0; i < flips.length; i++) {
      this.board[flips[i]] = -entry.player;
    }
    this.current = entry.player;
  }

  undo() {
    // 終局守衛必須擺在 canUndo() 之前：終局時 canUndo() 通常仍為 true，
    // 順序顛倒會先被「已經是開局囉」吃掉。鍵盤 U 會直接呼叫 undo()，
    // 沒有這道守衛就能繞過已經 disabled 的悔棋鈕、讓已結算的對局復活並重複計入戰績。
    if (this.gameOver) {
      this.showToast('這局已經結束，按「🔄 重開」再來一場吧');
      return false;
    }
    if (this.thinking || this.animating) {
      this.showToast('等這一手走完再悔棋吧');
      return false;
    }
    if (!this.canUndo()) {
      this.showToast('已經是開局囉');
      return false;
    }
    this.abortAi();
    if (this.animTimer) {
      clearTimeout(this.animTimer);
      this.animTimer = null;
    }
    // 終局守衛已擋掉 gameOver，但 resultTimer 一併清掉才不會有漏網的排程彈窗
    if (this.resultTimer) {
      clearTimeout(this.resultTimer);
      this.resultTimer = null;
    }
    this.animating = false;
    this.animUntil = 0;
    this.updateBoardLock();

    const duo = this.mode === 'duo';
    while (this.history.length > 0) {
      const entry = this.history.pop();
      this.revertEntry(entry);
      if (entry && entry.type === 'move') {
        // 雙人模式只退一手；人機模式退到人類那一手為止
        if (duo || entry.player === this.humanColor) break;
      }
    }

    this.undosUsed = (this.undosUsed || 0) + 1;
    this.gameOver = false;
    this.winner = 0;
    this.lastTapAt = 0;

    let last = -1;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const h = this.history[i];
      if (h && h.type === 'move') {
        last = h.sq;
        break;
      }
    }
    this.lastMoveSq = last;

    this.renderBoard({ animate: false });
    this.refreshHUD();
    this.saveGameState();
    this.showToast(`↩️ 已悔棋（本局第 ${this.undosUsed} 次）`);
    return true;
  }

  // ------------------------------------------------------------------------
  // 提示：用普通難度的同步搜尋算一手，每局 3 次
  // ------------------------------------------------------------------------
  clearSuggestion() {
    if (this.hintTimer) {
      clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
    const prev = this.suggestedSq;
    this.suggestedSq = -1;
    if (prev >= 0 && Array.isArray(this.cells)) {
      const cell = this.cells[prev];
      if (cell && cell.classList) cell.classList.remove('suggested');
    }
  }

  hint() {
    if (this.gameOver || this.thinking || this.animating) return false;
    if (!this.isHumanTurn()) {
      this.showToast('等對手下完再看提示吧');
      return false;
    }
    if ((this.hintsUsed || 0) >= this.hintLimit) {
      this.showToast('這局的提示已經用完囉');
      return false;
    }

    const base = DIFFICULTIES.normal;
    const opts = {
      maxDepth: base.maxDepth,
      timeBudgetMs: 150,
      exactEmpties: base.exactEmpties,
      fullStability: false,
      deterministic: true
    };
    let sq = -1;
    try {
      const res = searchSync(this.board, this.current, opts);
      if (res && Number.isInteger(res.move)) sq = res.move;
    } catch (_) {
      sq = -1;
    }
    if (sq < 0 || sq >= CELLS) {
      const legal = getLegalMoves(this.board, this.current);
      if (legal.length === 0) {
        this.showToast('目前沒有可以下的位置');
        return false;
      }
      sq = legal[0];
    }

    this.hintsUsed = (this.hintsUsed || 0) + 1;
    this.clearSuggestion();
    this.suggestedSq = sq;
    const cell = Array.isArray(this.cells) ? this.cells[sq] : null;
    if (cell && cell.classList) cell.classList.add('suggested');
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null;
      this.clearSuggestion();
    }, SUGGEST_MS);

    this.showToast(`💡 建議下在 ${_appSquareName(sq)}`);
    this.saveGameState();
    this.updateActionButtons();
    return true;
  }

  toggleHints() {
    this.showHints = !this.showHints;
    if (this.el && this.el.boardEl && this.el.boardEl.dataset) {
      this.el.boardEl.dataset.hints = this.showHints ? 'on' : 'off';
    }
    this.updateActionButtons();
    this.savePreferences();
    this.showToast(this.showHints ? '👁️ 已顯示可落子提示點' : '🙈 已隱藏可落子提示點');
  }

  // ------------------------------------------------------------------------
  // 模式 / 難度 / 執子切換
  // ------------------------------------------------------------------------
  setMode(mode) {
    if (mode !== 'ai' && mode !== 'duo') return;
    if (mode === this.mode) return;
    this.abortAi();
    this.mode = mode;
    this.syncControlState();
    this.savePreferences();
    this.startNewGame({ silent: true });
    this.showToast(mode === 'duo' ? '👥 已切換為雙人同機對戰' : '🤖 已切換為人機對弈');
  }

  setDifficulty(diff) {
    if (!_appHasDifficulty(diff)) return;
    if (diff === this.difficulty) return;
    // 立即生效、不打斷目前對局：中止舊搜尋後用新難度重新思考
    this.abortAi();
    this.difficulty = diff;
    this.statsTab = diff;
    this.syncControlState();
    this.savePreferences();
    this.saveGameState();
    this.refreshHUD();
    this.showToast(`${DIFFICULTIES[diff].label} 難度已套用`);
    this.maybeStartAiTurn();
  }

  setSide(side) {
    if (side !== 'black' && side !== 'white') return;
    const color = side === 'black' ? BLACK : WHITE;
    if (color === this.humanColor) return;
    this.abortAi();
    this.humanColor = color;
    this.syncControlState();
    this.savePreferences();
    this.startNewGame({ silent: true });
    this.showToast(color === BLACK ? '⚫ 你改執黑先手' : '⚪ 你改執白後手');
  }

  syncControlState() {
    if (!this.el) return;
    if (typeof document !== 'undefined' && document.body && document.body.dataset) {
      document.body.dataset.mode = this.mode;
    }
    if (this.el.modeTabs && this.el.modeTabs.forEach) {
      this.el.modeTabs.forEach((btn) => {
        const on = !!(btn.dataset && btn.dataset.mode === this.mode);
        if (btn.classList) btn.classList.toggle('active', on);
        if (typeof btn.setAttribute !== 'function') return;
        // 這頁沒有 tabpanel，index.html 若把 role="tab" 改成 role="group" 內的普通按鈕，
        // 狀態屬性也要跟著換成 aria-pressed，所以這裡依實際 role 決定要寫哪一個。
        const isTab = typeof btn.getAttribute === 'function' && btn.getAttribute('role') === 'tab';
        if (isTab) btn.setAttribute('aria-selected', on ? 'true' : 'false');
        else btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    // 難度與執子是普通 <button> 的群組，選取狀態一律用 aria-pressed 暴露，
    // 與底部「提示點」按鈕的既有慣例一致（不必動 role="group"）。
    if (this.el.diffBtns && this.el.diffBtns.forEach) {
      this.el.diffBtns.forEach((btn) => {
        const on = !!(btn.dataset && btn.dataset.diff === this.difficulty);
        if (btn.classList) btn.classList.toggle('active', on);
        if (typeof btn.setAttribute === 'function') btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    if (this.el.sideBtns && this.el.sideBtns.forEach) {
      const want = this.humanColor === BLACK ? 'black' : 'white';
      this.el.sideBtns.forEach((btn) => {
        const on = !!(btn.dataset && btn.dataset.side === want);
        if (btn.classList) btn.classList.toggle('active', on);
        if (typeof btn.setAttribute === 'function') btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    if (this.el.boardEl && this.el.boardEl.dataset) {
      this.el.boardEl.dataset.hints = this.showHints ? 'on' : 'off';
    }
    this.updateSoundIcon();
    this.updateActionButtons();
  }

  // ------------------------------------------------------------------------
  // 進度持久化（reversi_save_v1，只存走步序列）
  // ------------------------------------------------------------------------
  serializeState() {
    const moves = [];
    const history = Array.isArray(this.history) ? this.history : [];
    for (let i = 0; i < history.length; i++) {
      const h = history[i];
      if (h && h.type === 'move') moves.push(h.sq);
    }
    return {
      v: 1,
      mode: this.mode,
      difficulty: this.difficulty,
      humanColor: this.humanColor,
      moves,
      hintsUsed: this.hintsUsed || 0,
      undosUsed: this.undosUsed || 0
    };
  }

  saveGameState() {
    if (this.gameOver) return false;
    const state = this.serializeState();
    if (!state.moves.length) {
      this.clearGameState();
      return false;
    }
    return _appWriteJson(SAVE_KEY, state);
  }

  // 從初始盤面 replay 驗證；任何一步非法就整包丟棄
  deserializeState(data) {
    if (!_appIsPlainObject(data) || data.v !== 1) return false;
    if (!Array.isArray(data.moves) || data.moves.length === 0) return false;

    const mode = data.mode === 'duo' ? 'duo' : 'ai';
    const difficulty = _appHasDifficulty(data.difficulty) ? data.difficulty : 'normal';
    const humanColor = data.humanColor === WHITE ? WHITE : BLACK;

    const prevBoard = this.board;
    const prevHistory = this.history;
    const prevCurrent = this.current;

    this.board = createInitialBoard();
    this.current = BLACK;
    this.history = [];
    this.lastMoveSq = -1;

    for (let i = 0; i < data.moves.length; i++) {
      const sq = data.moves[i];
      if (!Number.isInteger(sq) || sq < 0 || sq >= CELLS) {
        this.board = prevBoard;
        this.history = prevHistory;
        this.current = prevCurrent;
        return false;
      }
      // 補上這一步之前可能發生的跳過（讓悔棋能跨 session 使用）
      if (!this.resolveTurn({ silent: true })) {
        this.board = prevBoard;
        this.history = prevHistory;
        this.current = prevCurrent;
        return false;
      }
      const applied = applyMove(this.board, sq, this.current);
      if (!applied) {
        this.board = prevBoard;
        this.history = prevHistory;
        this.current = prevCurrent;
        return false;
      }
      this.board = applied.board;
      this.history.push({
        type: 'move',
        sq,
        player: this.current,
        flips: Array.prototype.slice.call(applied.flips || [])
      });
      this.lastMoveSq = sq;
      this.current = -this.current;
    }

    // 收尾：處理最後一手之後的跳過；若雙方皆無合法步代表這局已經下完
    if (!this.resolveTurn({ silent: true })) {
      this.board = prevBoard;
      this.history = prevHistory;
      this.current = prevCurrent;
      return false;
    }

    this.mode = mode;
    this.difficulty = difficulty;
    this.humanColor = humanColor;
    this.hintsUsed = Number.isInteger(data.hintsUsed) ? data.hintsUsed : 0;
    this.undosUsed = Number.isInteger(data.undosUsed) ? data.undosUsed : 0;
    this.gameOver = false;
    this.winner = 0;
    this.animating = false;
    this.animUntil = 0;
    return true;
  }

  loadGameState() {
    const data = _appReadJson(SAVE_KEY, null);
    if (!data) return false;
    let ok = false;
    try {
      ok = this.deserializeState(data);
    } catch (_) {
      ok = false;
    }
    if (!ok) {
      this.clearGameState();
      return false;
    }

    this.statsTab = this.difficulty;
    this.syncControlState();
    this.renderBoard({ animate: false });
    this.refreshHUD();
    this.showToast('📥 已為您接回上次未完成的棋局');
    this.maybeStartAiTurn();
    return true;
  }

  clearGameState() {
    _appRemoveKey(SAVE_KEY);
  }

  // ------------------------------------------------------------------------
  // 戰績（reversi_stats_v1，以難度分桶）
  // ------------------------------------------------------------------------
  emptyBucket() {
    return { plays: 0, wins: 0, losses: 0, draws: 0, streak: 0, maxStreak: 0, bestDiff: 0 };
  }

  loadStats() {
    const raw = _appReadJson(STATS_KEY, {});
    const source = _appIsPlainObject(raw) ? raw : {};
    // 無原型物件：縱深防禦，就算日後有人繞過難度白名單，stats[key] 也只會是 undefined，
    // 不會撈到 Object.prototype 上的內建函式再被種出 plays: NaN
    const stats = Object.create(null);
    Object.keys(DIFFICULTIES).forEach((key) => {
      const bucket = this.emptyBucket();
      const saved = source[key];
      if (_appIsPlainObject(saved)) {
        Object.keys(bucket).forEach((field) => {
          if (Number.isFinite(saved[field])) bucket[field] = saved[field];
        });
      }
      stats[key] = bucket;
    });
    return stats;
  }

  saveStats(stats) {
    return _appWriteJson(STATS_KEY, stats);
  }

  // 悔棋過的對局照樣計入場次與勝負，但不列入連勝與最大勝差（避免刷分）
  recordResult() {
    if (this.mode !== 'ai') return null;
    const key = _appHasDifficulty(this.difficulty) ? this.difficulty : 'normal';
    const stats = this.loadStats();
    if (!stats[key]) stats[key] = this.emptyBucket();
    const bucket = stats[key];
    const counts = countDiscs(this.board);
    const mine = this.humanColor === BLACK ? counts.black : counts.white;
    const theirs = this.humanColor === BLACK ? counts.white : counts.black;
    const diff = mine - theirs;
    const clean = (this.undosUsed || 0) === 0;

    bucket.plays += 1;
    if (diff > 0) {
      bucket.wins += 1;
      if (clean) {
        bucket.streak += 1;
        if (bucket.streak > bucket.maxStreak) bucket.maxStreak = bucket.streak;
        if (diff > bucket.bestDiff) bucket.bestDiff = diff;
      }
    } else if (diff < 0) {
      bucket.losses += 1;
      bucket.streak = 0;
    } else {
      bucket.draws += 1;
      bucket.streak = 0;
    }

    this.saveStats(stats);
    return bucket;
  }

  resetStats() {
    _appRemoveKey(STATS_KEY);
    this.renderStats(this.statsTab);
    this.showToast('🗑️ 戰績紀錄已清除');
  }

  renderStats(diff) {
    const key = _appHasDifficulty(diff) ? diff : (_appHasDifficulty(this.statsTab) ? this.statsTab : 'normal');
    this.statsTab = key;
    const bucket = this.loadStats()[key] || this.emptyBucket();
    if (!this.el) return bucket;

    if (this.el.statsDiffBtns && this.el.statsDiffBtns.forEach) {
      this.el.statsDiffBtns.forEach((btn) => {
        const on = !!(btn.dataset && btn.dataset.statdiff === key);
        if (btn.classList) btn.classList.toggle('active', on);
        // 分頁選取狀態也要對輔助科技暴露，否則只有底色看得出目前在看哪一檔
        if (typeof btn.setAttribute === 'function') btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    const rate = bucket.plays > 0 ? Math.round((bucket.wins / bucket.plays) * 100) : 0;
    if (this.el.statPlays) this.el.statPlays.textContent = String(bucket.plays);
    if (this.el.statWld) this.el.statWld.textContent = `${bucket.wins} / ${bucket.draws} / ${bucket.losses}`;
    if (this.el.statWinrate) this.el.statWinrate.textContent = `${rate}%`;
    if (this.el.statStreak) this.el.statStreak.textContent = String(bucket.maxStreak);
    if (this.el.statBestdiff) {
      this.el.statBestdiff.textContent = bucket.bestDiff > 0 ? `+${bucket.bestDiff} 子` : '--';
    }
    return bucket;
  }

  // ------------------------------------------------------------------------
  // 彈窗
  // ------------------------------------------------------------------------
  // 彈窗開啟時把背景對鍵盤與輔助科技一起關掉，讓 focus trap 不是唯一防線。
  // inert 舊瀏覽器沒有，所以用 typeof 守衛偵測，偵測不到時至少用 aria-hidden 擋住 AT。
  setBackgroundInert(on) {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    const supported = typeof HTMLElement !== 'undefined'
      && HTMLElement.prototype
      && 'inert' in HTMLElement.prototype;
    const targets = document.querySelectorAll('.page-container, .thumb-action-bar');
    if (!targets || !targets.forEach) return;
    targets.forEach((el) => {
      if (!el) return;
      if (supported) el.inert = !!on;
      if (typeof el.setAttribute !== 'function') return;
      if (on) el.setAttribute('aria-hidden', 'true');
      else el.removeAttribute('aria-hidden');
    });
  }

  openModal(modal, focusTarget) {
    if (!modal) return;
    // 取消上一次關閉排定、尚未觸發的隱藏計時器；
    // 否則在淡出期間重開同一個彈窗，舊 timer 會在開啟後才把它設成 hidden，
    // 畫面上彈窗消失但 .open 還在，方向鍵 / u / h 會全部被當成「有彈窗開著」而失效。
    if (modal._hideTimer) {
      clearTimeout(modal._hideTimer);
      modal._hideTimer = null;
    }
    if (typeof document !== 'undefined') this.lastFocusedElement = document.activeElement;
    modal.hidden = false;
    if (typeof modal.setAttribute === 'function') modal.setAttribute('aria-hidden', 'false');
    this.setBackgroundInert(true);
    _appNextFrame(() => {
      if (modal.classList) modal.classList.add('open');
      if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
    });
  }

  closeModal(modal) {
    if (!modal) return;
    if (modal.classList) modal.classList.remove('open');
    // aria-hidden 立刻生效，不必等離場動畫（AT 不該還讀得到正在淡出的彈窗）
    if (typeof modal.setAttribute === 'function') modal.setAttribute('aria-hidden', 'true');
    if (modal._hideTimer) clearTimeout(modal._hideTimer);
    // 等離場動畫結束再補回 hidden，維持可及性
    modal._hideTimer = setTimeout(() => {
      modal._hideTimer = null;
      // 雙保險：期間又被重新開啟就不要動 hidden
      if (modal.classList && modal.classList.contains('open')) return;
      modal.hidden = true;
    }, MODAL_FADE_MS);
    // 沒有其他彈窗還開著才解除背景 inert，且一定要在 focus() 之前 ——
    // lastFocusedElement 多半位於 .page-container 內，inert 狀態下 focus() 會靜默失效
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function'
      || !document.querySelector('.modal-overlay.open')) {
      this.setBackgroundInert(false);
    }
    const prev = this.lastFocusedElement;
    if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus();
    this.lastFocusedElement = null;
  }

  openStatsModal() {
    if (!this.el || !this.el.statsModal) return;
    this.renderStats(this.statsTab);
    this.openModal(this.el.statsModal, this.el.statsOkBtn);
  }

  openHelpModal() {
    if (!this.el) return;
    this.openModal(this.el.helpModal, this.el.helpOkBtn);
  }

  reviewFinalBoard() {
    if (!this.el) return;
    this.closeModal(this.el.resultModal);
    this.showToast('🔍 可以慢慢看終盤，想再戰就按「重開」');
  }

  showResultModal(bucket) {
    if (!this.el || !this.el.resultModal) return;
    const counts = countDiscs(this.board);
    const winner = this.winner;

    let emoji = '🤝';
    let title = '平手收場';
    if (this.mode === 'duo') {
      if (winner === BLACK) {
        emoji = '⚫';
        title = '黑方獲勝！';
      } else if (winner === WHITE) {
        emoji = '⚪';
        title = '白方獲勝！';
      }
    } else if (winner === this.humanColor) {
      emoji = '🏆';
      title = '你贏了！';
    } else if (winner !== 0) {
      emoji = '😿';
      title = '電腦獲勝';
    }

    if (this.el.resultEmoji) this.el.resultEmoji.textContent = emoji;
    if (this.el.resultTitleText) this.el.resultTitleText.textContent = title;
    if (this.el.resultBlack) this.el.resultBlack.textContent = String(counts.black);
    if (this.el.resultWhite) this.el.resultWhite.textContent = String(counts.white);

    const parts = [];
    if (this.mode === 'duo') {
      parts.push('雙人同機');
    } else {
      const cfg = _appDifficultyCfg(this.difficulty);
      parts.push(cfg ? cfg.label : '普通');
      parts.push(this.humanColor === BLACK ? '你執黑' : '你執白');
    }
    if ((this.undosUsed || 0) > 0) parts.push(`本局悔棋 ${this.undosUsed} 次`);
    if ((this.hintsUsed || 0) > 0) parts.push(`用了 ${this.hintsUsed} 次提示`);

    // 兩個 .stat-val 是 1.3rem 等寬數字格，只放純數字；
    // 補充敘述一律掛到 #result-detail 那行小字，360px 手機才不會爆版。
    // 值改用 bucket.streak（目前連勝）讓標籤「目前連勝」名實相符 ——
    // 歷史最高連勝在戰績彈窗的「最高連勝」已經有了，兩邊剛好分工。
    if (this.mode === 'duo' || !bucket) {
      if (this.el.resultWinrate) this.el.resultWinrate.textContent = '--';
      if (this.el.resultStreak) this.el.resultStreak.textContent = '--';
      parts.push('雙人對戰不列入戰績');
    } else {
      const rate = bucket.plays > 0 ? Math.round((bucket.wins / bucket.plays) * 100) : 0;
      if (this.el.resultWinrate) this.el.resultWinrate.textContent = `${rate}%`;
      if (this.el.resultStreak) this.el.resultStreak.textContent = String(bucket.streak || 0);
      parts.push(`累積 ${bucket.plays} 局`);
      if ((this.undosUsed || 0) > 0) parts.push('悔棋局不計入連勝與勝差');
    }

    // 這一行必須放在上面的分支之後，後面 push 進去的敘述才會真的顯示出來
    if (this.el.resultDetail) this.el.resultDetail.textContent = parts.join(' · ');

    this.openModal(this.el.resultModal, this.el.resultAgainBtn);
  }

  // ------------------------------------------------------------------------
  // Toast 與彩帶
  // ------------------------------------------------------------------------
  showToast(message) {
    if (!this.el || !this.el.toastContainer || typeof document === 'undefined') return;
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

  // 彩帶整段交給共用模組 BoboConfetti：
  // prefers-reduced-motion 守衛、rAF handle 管理（重複呼叫會先收掉上一輪）、
  // 高 DPI 與視窗縮放都在模組裡，這裡只負責「要不要放」與放在哪張 canvas。
  // 模組缺席時安靜退場，對局結算流程完全不受影響。
  triggerConfetti() {
    if (!this.el || !this.el.confettiCanvas) return;
    const confetti = _appConfettiKit();
    if (!confetti) return;
    // 數量 90、110 幀、六色都是模組預設值，與本遊戲原本的實作一致，不必另外傳參數
    confetti.burst(this.el.confettiCanvas);
  }
}

// --------------------------------------------------------------------------
// 瀏覽器啟動
// --------------------------------------------------------------------------
let gameInstance = null;
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    gameInstance = new ReversiApp();
  });
}

// --------------------------------------------------------------------------
// Node 單元測試匯出
// --------------------------------------------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    EMPTY,
    BLACK,
    WHITE,
    SIZE,
    CELLS,
    INFINITY_SCORE,
    DELTAS,
    RAYS,
    NEIGHBORS,
    POS_WEIGHTS,
    CORNERS,
    X_SQUARES,
    CORNER_GUARD,
    SQ_ORDER,
    PHASE_W,
    DIFFICULTIES,
    SAVE_KEY,
    STATS_KEY,
    PREF_KEY,
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
    ReversiApp,
    ReversiSoundManager
  };
}
