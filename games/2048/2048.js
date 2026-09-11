/* ==========================================================================
   2048
   核心引擎、磚塊動畫、滑動手勢與進度持久化
   ========================================================================== */

'use strict';

// --------------------------------------------------------------------------
// 方向、模式與尺寸設定
// --------------------------------------------------------------------------
// DIR 的四個值同時就是 DIR_NAMES 的索引。buildLines / computeMove 只吃這四個值，
// 其餘一律當成無效方向處理（回傳「沒有任何變化」而不是丟例外，讓 UI 層不必到處包 try）。
const DIR = Object.freeze({ UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 });

// 索引與 DIR 的值一一對應：0 上、1 右、2 下、3 左
const DIR_NAMES = ['up', 'right', 'down', 'left'];

// 遊戲模式代號（存檔與 body[data-mode] 都用這三個字串）
const MODES = { CLASSIC: 'classic', BLITZ: 'blitz', TOWER: 'tower' };

// 三種盤面尺寸的設定。key 是邊長（字串鍵），查表一律用 hasOwnProperty 避免原型污染。
// milestone 是「真正目標之前的階段性目標」。
// 4×4 合出 2048 需要看兩步以上的玩法，一般玩家的達標率是個位數；
// 2048 是招牌數字不能改，所以在它之前給一個看得到、摸得著的里程碑。
const SIZE_CONFIG = {
  3: { size: 3, target: 128,  milestone: 64,   spawn4Rate: 0,    startTiles: 2, label: '3×3 口袋局', hint: '只會生成 2，零容錯' },
  4: { size: 4, target: 2048, milestone: 1024, spawn4Rate: 0.10, startTiles: 2, label: '4×4 正統局', hint: '原汁原味的 2048' },
  5: { size: 5, target: 4096, milestone: 2048, spawn4Rate: 0.20, startTiles: 2, label: '5×5 大局',   hint: '格子多、局也長' }
};

// 加時閃電模式：固定 4×4，合出高階磚與連鎖合併都會加時間。
const BLITZ_CONFIG = {
  size: 4,
  startMs: 90000,          // 起始 90 秒
  maxMs: 180000,           // 時間上限 180 秒
  perLevelMs: 400,         // 合出 2^n 磚 → +(n-1) * 400ms
  chainThreshold: 3,       // 同一步合併 >= 3 組
  chainBonusMs: 1500       // 連鎖額外 +1.5 秒
};

// --------------------------------------------------------------------------
// 爬塔模式（Roguelite）
// --------------------------------------------------------------------------
// 固定 4×4、五層，由下往上爬。過關「不清盤」是這個模式的靈魂 ——
// 帶著上一層的資產往上爬才有累積感，過關就清空只會變成五場獨立短局。
const TOWER_FLOORS = [
  { floor: 1, name: '1F 塔底', target: 64,   maxSteps: 60,  ice: 0 },
  { floor: 2, name: '2F 迴廊', target: 128,  maxSteps: 80,  ice: 0 },
  { floor: 3, name: '3F 冰窖', target: 256,  maxSteps: 110, ice: 1 },
  { floor: 4, name: '4F 霜原', target: 512,  maxSteps: 150, ice: 1 },
  { floor: 5, name: '5F 塔頂', target: 1024, maxSteps: 200, ice: 2 }
];

// 層間商店的商品表。沒有 max 欄位代表可以一直買（實際持有數由 APP 段的 items 計數）。
const SHOP_ITEMS = [
  { id: 'smash',   icon: '🔨', name: '敲碎',     price: 25, desc: '點掉盤面上任意 1 顆磚（含冰塊）' },
  { id: 'undo',    icon: '↩️', name: '悔棋券',   price: 20, desc: '悔棋次數 +1' },
  { id: 'shuffle', icon: '🎲', name: '重新洗牌', price: 30, desc: '保留數值，隨機重排位置' },
  { id: 'seed',    icon: '✨', name: '種子磚',   price: 40, desc: '下一次生成保證是目前最大磚 ÷ 4' },
  { id: 'melt',    icon: '🧊', name: '融冰',     price: 35, desc: '下一層少放 1 顆冰塊' },
  { id: 'revive',  icon: '❤️', name: '復活權',   price: 60, desc: '步數用完時自動續 30 步', max: 2 }
];

// 冰塊在 gridToValues / gridFromValues（存檔與悔棋快照）裡的哨兵值。
// 一般磚的面值一律是 0 或 2 的冪，-1 結構上不可能與任何磚值撞號。
const ICE_VALUE = -1;

// 步數用完且持有 ❤️ 復活權時，自動續的步數
const REVIVE_STEPS = 30;

// 獻祭一顆小磚的金幣回饋（過關結算用）
const SACRIFICE_GOLD = 2;

// --------------------------------------------------------------------------
// 🧊 冰塊磚
// --------------------------------------------------------------------------
// 冰塊也是一顆 Tile（要有 id 讓渲染層能定位），但 value 為 0 且帶 ice 旗標：
//   IceTile = { id, value: 0, ice: true }
// value 0 天然不會與任何磚合併 —— 合併條件是 prev.value === tile.value，
// 而一般磚的 value 一律 >= 2，永遠不可能等於 0。
//
// 【冰塊的 id 一律由格號推導：index i → -(i + 1)】
// 理由有三：
//   1. spawnTile 與 gridFromValues 配發的 id 一律 >= 1，負號就是一道
//      「結構上不可能撞號」的隔離牆，不必去搶 App 的 nextId。
//   2. 契約把簽章寫死成 placeIce(grid, n, count, rng)，拿不到也回不了 nextId；
//      若改用「猜一個正數起點」遲早與 spawnTile 撞號，渲染層的 id → DOM 對照表就會錯位。
//   3. 冰塊在任何情況下都不移動（computeMove / shuffleTiles / sacrificeTiles 都讓它留在原位），
//      所以「格號 → id」這個對應在冰塊的一生中都成立，重建盤面時也必定還原成同一個 id。
function _g2iceIdAt(index) {
  return -(Math.floor(_g2num(index, 0)) + 1);
}

function _g2makeIce(index) {
  return { id: _g2iceIdAt(index), value: 0, ice: true };
}

// 是不是冰塊。null / undefined 安全。
function isIce(tile) {
  return !!(tile && tile.ice);
}

const UNDO_LIMIT = 3;      // 經典模式每局 3 次；閃電模式 0 次（由 App 判斷）
const MAX_LEVEL = 17;      // 2^17 = 131072，配色表必須涵蓋到這一階

// 動畫時序的唯一真相。CSS 的使用點一律 var(--slide-ms) 等，不得硬寫數字。
const SLIDE_MS = 110;
const POP_MS = 180;
const SPAWN_MS = 140;

// --------------------------------------------------------------------------
// 手勢門檻（純數值，判定邏輯見本檔最後一節）
// --------------------------------------------------------------------------
const SWIPE = {
  AXIS_LOCK: 10,           // px，超過就鎖軸，整段手勢不再換方向
  MIN_DISTANCE: 24,        // px，觸控/筆
  MIN_DISTANCE_MOUSE: 32,  // px，滑鼠精準度高，門檻拉高
  FLICK_DISTANCE: 12,      // px，快速輕掃只要走一半
  FLICK_VELOCITY: 0.35,    // px/ms
  AXIS_RATIO: 1.4,         // 主軸須大於副軸 1.4 倍，斜滑不觸發
  MAX_DURATION: 1500,      // ms，超時且未達門檻 → 視為猶豫，放棄
  VELOCITY_WINDOW: 80      // ms，速度取樣視窗
};

// --------------------------------------------------------------------------
// 私有小工具（CORE 段一律 _g2 前綴）
// --------------------------------------------------------------------------
// 把任意輸入轉成有限數字，轉不出來就回 fallback。
// 盤面資料可能來自 localStorage、手勢資料來自 DOM 事件，兩邊都可能餵進 undefined / NaN。
function _g2num(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return (typeof n === 'number' && isFinite(n)) ? n : fallback;
}

// 盤面邊長防呆：只接受 2 以上的整數，其餘一律回 0（= 無效）
function _g2normSize(n) {
  const v = _g2num(n, 0);
  return v >= 2 ? Math.floor(v) : 0;
}

// 方向防呆：只接受 0~3，其餘一律回 -1（= 無效）
function _g2normDir(dir) {
  const d = _g2num(dir, -1);
  return (d === 0 || d === 1 || d === 2 || d === 3) ? d : -1;
}

// valuesFromRows 的單格解析：'.' 與 0 都是空格，轉不出數字的一律當空格。
// '#' 與 -1（ICE_VALUE）都代表冰塊，讓測試與除錯可以直接把含冰塊的盤面畫出來：
//   valuesFromRows(['2 # 2 2']) -> [2, -1, 2, 2]
function _g2cellValue(token) {
  if (token === null || token === undefined) return 0;
  if (token === '.' || token === '') return 0;
  if (token === '#') return ICE_VALUE;
  const v = _g2num(token, 0);
  if (v === ICE_VALUE) return ICE_VALUE;
  return v > 0 ? Math.floor(v) : 0;
}

// 漏傳 rng 時的保險絲。CORE 段刻意完全不碰 Math.random（否則測試無法做確定性斷言），
// 真的漏傳就臨時用時鐘播一顆 mulberry32，至少不會每局都長一樣。
const _g2FALLBACK = { rng: null };

function _g2rngOf(rng) {
  if (typeof rng === 'function') return rng;
  if (!_g2FALLBACK.rng) {
    _g2FALLBACK.rng = createRng(((Date.now() >>> 0) ^ 0x9E3779B9) >>> 0);
  }
  return _g2FALLBACK.rng;
}

// --------------------------------------------------------------------------
// 可注入的亂數
// --------------------------------------------------------------------------
// mulberry32：32 位元狀態、序列夠長、實作只有四行，同種子必定得到同一串序列。
// App 實戰時傳 Math.random 進 spawnTile；測試傳 createRng(seed) 做確定性斷言。
// 種子接受數字；傳字串或其他型別時用逐字元雜湊折成 32 位元整數，一樣可重現。
function createRng(seed) {
  let state;
  if (typeof seed === 'number' && isFinite(seed)) {
    state = seed >>> 0;
  } else {
    const text = String(seed === undefined || seed === null ? '' : seed);
    let h = 0x811C9DC5;
    for (let i = 0; i < text.length; i++) {
      h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    }
    state = h >>> 0;
  }
  return function () {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --------------------------------------------------------------------------
// 盤面建立與格式互轉
// --------------------------------------------------------------------------
// 盤面是長度 n*n 的普通陣列，元素是 Tile 物件（{ id, value }）或 null，
// index = row * n + col（row 0 在最上、col 0 在最左）。
// 【關鍵】grid 存的是「磚塊物件的參考」而不是數字 ——
// 移動演算法搬的是物件參考，id 自然跟著走，完全不需要事後配對 id。
function createInitialGrid(n) {
  const size = _g2normSize(n);
  const cells = size * size;
  const grid = new Array(cells);
  for (let i = 0; i < cells; i++) grid[i] = null;
  return grid;
}

// 盤面 → 純數字陣列（空格為 0、冰塊為 ICE_VALUE）。存檔與快照都用這個格式。
function gridToValues(grid) {
  if (!grid || typeof grid.length !== 'number') return [];
  const out = new Array(grid.length);
  for (let i = 0; i < grid.length; i++) {
    const tile = grid[i];
    if (isIce(tile)) {
      out[i] = ICE_VALUE;
      continue;
    }
    out[i] = (tile && _g2num(tile.value, 0) > 0) ? tile.value : 0;
  }
  return out;
}

// 純數字陣列 → 盤面。依 index 順序由 startId 開始配發 id，回傳用掉之後的 nextId。
// 載入存檔與悔棋還原都走這裡；磚塊身分因此重新配發，但 nextId 永遠只增不減。
// ICE_VALUE(-1) 還原成冰塊，它的 id 由格號推導（見上方 🧊 冰塊磚一節），
// 不消耗 nextId —— 冰塊的 id 一律是負數，與一般磚不同號源。
function gridFromValues(values, startId) {
  const list = (values && typeof values.length === 'number') ? values : [];
  let nextId = Math.floor(_g2num(startId, 1));
  if (!(nextId >= 1)) nextId = 1;
  const grid = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const value = _g2num(list[i], 0);
    if (value === ICE_VALUE) {
      grid[i] = _g2makeIce(i);
    } else if (value >= 2) {
      grid[i] = { id: nextId, value: Math.floor(value) };
      nextId += 1;
    } else {
      grid[i] = null;
    }
  }
  return { grid: grid, nextId: nextId };
}

// 測試構造局面用。接受「以空白或逗號分隔數字」的字串陣列、單一多行字串，或數字陣列的陣列。
// '0' 與 '.' 都代表空格。例：
//   valuesFromRows(['2 2 4 0', '0 0 0 0', '. . . .', '4 0 0 2'])
//   -> [2,2,4,0, 0,0,0,0, 0,0,0,0, 4,0,0,2]
function valuesFromRows(rows) {
  const out = [];
  let list;
  if (typeof rows === 'string') {
    list = rows.split('\n');
  } else if (Array.isArray(rows)) {
    list = rows;
  } else {
    return out;
  }
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if (Array.isArray(row)) {
      for (let k = 0; k < row.length; k++) out.push(_g2cellValue(row[k]));
      continue;
    }
    const text = String(row === undefined || row === null ? '' : row).trim();
    if (text === '') continue;
    const tokens = text.split(/[\s,]+/);
    for (let k = 0; k < tokens.length; k++) {
      if (tokens[k] === '') continue;
      out.push(_g2cellValue(tokens[k]));
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// 線表：把「往某方向推」化簡成「每條線往索引 0 靠攏」
// --------------------------------------------------------------------------
// buildLines(n, dir) 回傳 n 條線，每條 n 個格號，排序一律「靠牆端 → 遠端」。
// 例如 n=4、dir=UP，第 0 條線是 [0, 4, 8, 12]（最上面那格排第一）；
// dir=RIGHT，第 0 條線是 [3, 2, 1, 0]（最右邊那格排第一）。
// 有了這層抽象，computeMove 只要寫一份「往線頭靠攏」的邏輯，四個方向共用。
//
// 線表是純函數的產物，computeMove 每一步都要用，所以內部做快取；
// 快取內容視為唯讀，對外的 buildLines() 一律回傳全新的複本。
const _g2LINE_CACHE = new Map();

function _g2makeLines(n, dir) {
  const lines = new Array(n);
  for (let i = 0; i < n; i++) {
    const line = new Int16Array(n);
    for (let k = 0; k < n; k++) {
      let row;
      let col;
      if (dir === DIR.UP) {
        row = k;
        col = i;
      } else if (dir === DIR.DOWN) {
        row = n - 1 - k;
        col = i;
      } else if (dir === DIR.LEFT) {
        row = i;
        col = k;
      } else {
        row = i;
        col = n - 1 - k;
      }
      line[k] = row * n + col;
    }
    lines[i] = line;
  }
  return lines;
}

function _g2lines(n, dir) {
  const key = n + ':' + dir;
  let lines = _g2LINE_CACHE.get(key);
  if (!lines) {
    lines = _g2makeLines(n, dir);
    _g2LINE_CACHE.set(key, lines);
  }
  return lines;
}

function buildLines(n, dir) {
  const size = _g2normSize(n);
  const d = _g2normDir(dir);
  if (size === 0 || d === -1) return [];
  const cached = _g2lines(size, d);
  const out = new Array(size);
  for (let i = 0; i < size; i++) out[i] = Int16Array.from(cached[i]);
  return out;
}

// --------------------------------------------------------------------------
// 移動：整份 2048 的心臟
// --------------------------------------------------------------------------
// computeMove(grid, n, dir) -> MoveResult，【絕對不 mutate 傳入的 grid】。
// 產物就是渲染層需要的全部指令：
//   next       移動後的新盤面（合併後的 value 已經加倍）
//   moves      [{ id, from, to, dying }]，只收「位置真的有變」或「dying」的磚
//   merges     [{ keepId, to, value }]，keepId 是存活下來、面值加倍的那顆
//   gained     本次得分 = 所有合併後新面值的總和
//   changed    盤面有沒有任何變化（false 代表撞牆：不消耗回合、不生成新磚）
//   mergeCount 合併組數（加時閃電的連鎖加成用）
//   maxMerged  本次合出的最大面值（成就與音效用）
//
// 演算法：每條線從靠牆端往遠端掃，把磚一顆顆「寫」到線上的下一個空位；
// 若下一個要寫的位置的前一顆與自己同值、且那顆不是這一步剛合出來的，就合併。
// 搬的是磚塊物件的參考，id 自然跟著走 ——
// 「移動前存舊盤面、移動後比對數字來配對 id」是 2048 實作翻車第一名：
// 同一列有多個相同數字時必然配錯。
//
// 【合併的存活者】永遠是靠牆端那顆（先被寫進 next 的那顆）：位移較短、視覺上是被撞上的
// 一方，彈跳感最自然，而且它在 next 裡已就定位，不必二次搬移。
//
// 【合併鎖】lastLocked 是 per-line 的區域變數，隨函式結束而消滅，
// 結構上不可能忘記清。絕對不可改存成 tile.mergedThisTurn 這種持久欄位。
//   [2,2,2,2] -> [4,4]（不是 [8]）　[2,2,2] -> [4,2]　[2,2,4] -> [4,4]　[4,2,2] -> [4,4]
//
// 【冰塊】爬塔模式的 🧊 冰塊不動、不合併，等於在線上立了一道牆，
// 把一條線切成互不相通的區段，兩側的磚各自往自己那段的線頭靠攏：
//   [2, 冰, 2, 2] 往線頭靠攏 -> [2, 冰, 4, 空]（不是 [4, 冰, 2, 空]）
// 盤面上沒有冰塊時，走的路徑與加入爬塔模式之前逐欄位完全相同。
function computeMove(grid, n, dir) {
  const size = _g2normSize(n);
  const d = _g2normDir(dir);
  const result = {
    next: createInitialGrid(size),
    moves: [],
    merges: [],
    gained: 0,
    changed: false,
    mergeCount: 0,
    maxMerged: 0
  };
  if (size === 0 || d === -1 || !grid) return result;

  const next = result.next;
  const moves = result.moves;
  const merges = result.merges;
  const lines = _g2lines(size, d);

  for (let li = 0; li < size; li++) {
    const line = lines[li];
    // writeIdx：這條線上「下一顆磚要落在線的第幾格」
    let writeIdx = 0;
    // 合併鎖：上一顆寫進去的磚是不是這一步剛合出來的。只活在這條線的迴圈裡。
    let lastLocked = false;

    for (let read = 0; read < size; read++) {
      const from = line[read];
      const tile = grid[from];
      if (!tile) continue;

      if (isIce(tile)) {
        // 冰塊不動也不合併，它把這條線切成互不相通的區段：
        // 放回原位、把寫入指標推到冰塊「之後」，再清掉合併鎖 ——
        // 少清合併鎖的話，冰塊另一側的第一顆磚會被上一段的鎖誤擋一次合併。
        next[from] = tile;
        writeIdx = read + 1;
        lastLocked = false;
        continue;
      }

      const prevTo = writeIdx > 0 ? line[writeIdx - 1] : -1;
      const prev = prevTo >= 0 ? next[prevTo] : null;

      // prev 有可能就是剛放回原位的冰塊（writeIdx 指到冰塊的下一格時）。
      // 冰塊 value 為 0、一般磚 value >= 2，本來就不會相等；
      // 這裡多寫一道 !isIce(prev)，日後就算有人動了冰塊的面值也不會炸成「磚跨過冰塊合併」。
      if (prev && !isIce(prev) && !lastLocked && prev.value === tile.value) {
        // 合併：存活者是靠牆端的 prev（沿用它的 id），自己滑過去之後消失。
        // 這裡建立新的 Tile 物件而不是改 prev.value，才不會回頭汙染傳入的 grid。
        const value = prev.value * 2;
        next[prevTo] = { id: prev.id, value: value };
        moves.push({ id: tile.id, from: from, to: prevTo, dying: true });
        merges.push({ keepId: prev.id, to: prevTo, value: value });
        result.gained += value;
        result.mergeCount += 1;
        if (value > result.maxMerged) result.maxMerged = value;
        result.changed = true;
        lastLocked = true;
        continue;
      }

      // 沒合併：直接搬物件參考到線上的下一個空位
      const to = line[writeIdx];
      next[to] = tile;
      if (to !== from) {
        moves.push({ id: tile.id, from: from, to: to, dying: false });
        result.changed = true;
      }
      writeIdx += 1;
      lastLocked = false;
    }
  }

  return result;
}

// --------------------------------------------------------------------------
// 生成新磚
// --------------------------------------------------------------------------
// 【注意】這是 CORE 段唯一允許 mutate 傳入 grid 的函式：成功時直接把新磚寫進 grid[index]。
// rng 必須由外部注入（App 實戰傳 Math.random，測試傳 createRng(seed)），
// 本函式內部不碰 Math.random，否則測試沒辦法寫確定性斷言。
// 不論 spawn4Rate 是多少，每次成功生成固定消耗 rng 兩次（先選格子、再決定面值），
// 讓不同尺寸設定下的亂數序列長度一致、好對照。
// 沒有空格時回 null（此時不消耗 rng，也不動 grid）。
function spawnTile(grid, n, nextId, spawn4Rate, rng) {
  const size = _g2normSize(n);
  if (size === 0 || !grid) return null;
  const cells = size * size;

  // 只挑 null 的格子。冰塊是「非 null 的 Tile」，所以這一行天然就把它排除掉了 ——
  // 新磚永遠不會蓋在冰塊上，不需要也不可以另外加 isIce 判斷（加了反而會生在冰塊上）。
  const empties = [];
  for (let i = 0; i < cells; i++) {
    if (!grid[i]) empties.push(i);
  }
  if (empties.length === 0) return null;

  const roll = _g2rngOf(rng);

  let pick = Math.floor(roll() * empties.length);
  if (!(pick >= 0)) pick = 0;
  if (pick >= empties.length) pick = empties.length - 1;
  const index = empties[pick];

  // spawn4Rate 為 0 時 roll() < 0 恆為 false，不必特別分支
  const value = (roll() < _g2num(spawn4Rate, 0)) ? 4 : 2;

  let id = Math.floor(_g2num(nextId, 1));
  if (!(id >= 1)) id = 1;

  const tile = { id: id, value: value };
  grid[index] = tile;
  return { index: index, tile: tile, nextId: id + 1 };
}

// --------------------------------------------------------------------------
// 盤面查詢
// --------------------------------------------------------------------------
// 有冰塊時的逐線判定：模擬 computeMove 的寫入指標，
// 只要任一方向的任一條線上「有磚滑得動或合得起來」就代表盤面還能動。
// 冰塊把線切成互不相通的區段，所以指標與「上一顆磚」都要在冰塊處重置。
function _g2canMoveWithIce(grid, size) {
  for (let d = 0; d < 4; d++) {
    const lines = _g2lines(size, d);
    for (let li = 0; li < size; li++) {
      const line = lines[li];
      let writeIdx = 0;
      let lastValue = 0;      // 同一區段裡上一顆磚的面值；0 代表區段才剛開始
      for (let read = 0; read < size; read++) {
        const tile = grid[line[read]];
        if (!tile) continue;
        if (isIce(tile)) {
          writeIdx = read + 1;
          lastValue = 0;
          continue;
        }
        // 走到這裡代表前面沒有可用空位時 writeIdx 會等於 read；不等就表示這顆磚滑得動
        if (writeIdx !== read) return true;
        // 與同區段的前一顆同值 → 合得起來（回 true 就結束，所以不必維護合併鎖）
        if (lastValue > 0 && lastValue === tile.value) return true;
        lastValue = _g2num(tile.value, 0);
        writeIdx += 1;
      }
    }
  }
  return false;
}

// 還走得動嗎：有空格、或有相鄰同值即可。只看右鄰與下鄰就涵蓋全部相鄰配對。
//
// 【有冰塊時這條捷徑不成立】冰塊把盤面切成互不相通的區段，
// 被冰塊封死的區段裡的空格是永遠填不進去的，「有空格就能動」會把死局判成活局；
// 相鄰同值也可能隔著冰塊，同樣不算數。所以只要盤面上有冰塊就改走逐線判定。
// 沒有冰塊的盤面一律走原本的快速路徑，行為與加入爬塔模式之前逐欄位相同。
function canMove(grid, n) {
  const size = _g2normSize(n);
  if (size === 0 || !grid) return false;
  const cells = size * size;

  for (let i = 0; i < cells; i++) {
    if (isIce(grid[i])) return _g2canMoveWithIce(grid, size);
  }

  for (let i = 0; i < cells; i++) {
    if (!grid[i]) return true;
  }
  // 走到這裡代表全滿，以下每一格都保證不是 null
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const i = row * size + col;
      const value = grid[i].value;
      if (col + 1 < size && grid[i + 1].value === value) return true;
      if (row + 1 < size && grid[i + size].value === value) return true;
    }
  }
  return false;
}

// 盤面上的最大面值，空盤回 0。冰塊不算（它的 value 是 0，本來就不會是最大值，
// 但這裡明寫一條，日後就算有人改了冰塊的面值也不會污染「目前最大磚」與過關判定）。
function maxTile(grid) {
  if (!grid || typeof grid.length !== 'number') return 0;
  let best = 0;
  for (let i = 0; i < grid.length; i++) {
    const tile = grid[i];
    if (!tile) continue;
    if (isIce(tile)) continue;
    const value = _g2num(tile.value, 0);
    if (value > best) best = value;
  }
  return best;
}

// 有沒有達標
function isWin(grid, target) {
  const goal = _g2num(target, Infinity);
  return maxTile(grid) >= goal;
}

// 結束了嗎（= 不能再動）
function isGameOver(grid, n) {
  return !canMove(grid, n);
}

// 面值 → 階級：2->1, 4->2, 8->3 …；0 或非 2 的冪一律回 0（含 1、負數、小數）。
// 用除法迴圈而不是位元運算，2^31 以上也不會出錯。
function levelOf(value) {
  let v = _g2num(value, 0);
  if (v < 2) return 0;
  let level = 0;
  while (v > 1) {
    if (v % 2 !== 0) return 0;
    v /= 2;
    level += 1;
  }
  return level;
}

// --------------------------------------------------------------------------
// 爬塔盤面操作（純函式，不碰 DOM）
// --------------------------------------------------------------------------
// 樓層設定查詢：1~5 回 TOWER_FLOORS 的該一項，超出範圍或不是整數一律回 null。
function towerFloor(floor) {
  const f = Math.floor(_g2num(floor, 0));
  if (!(f >= 1) || f > TOWER_FLOORS.length) return null;
  return TOWER_FLOORS[f - 1];
}

// 在盤面上灑冰塊，回傳實際放下去的格號陣列（依放置順序）。
//
// 【注意】這是 CORE 段第二個、也是最後一個允許 mutate 傳入 grid 的函式
// （另一個是 spawnTile）：成功放置時直接把冰塊寫進 grid[index]。
//
// 規則：
//   - 避開四個角落 —— 角落是玩家堆大磚的地方，堵住太惡意
//   - 避開所有已經有東西的格子（含已經在盤上的冰塊）
//   - 可用格不足時就有幾格放幾顆，不會丟例外
//   - rng 一律外部注入（每放一顆固定消耗 rng 一次），CORE 段不碰 Math.random
function placeIce(grid, n, count, rng) {
  const placed = [];
  const size = _g2normSize(n);
  if (size === 0 || !grid) return placed;

  let want = Math.floor(_g2num(count, 0));
  if (!(want > 0)) return placed;

  const cells = size * size;
  // 四個角落：左上、右上、左下、右下
  const corners = [0, size - 1, cells - size, cells - 1];

  const spots = [];
  for (let i = 0; i < cells; i++) {
    if (grid[i]) continue;
    if (corners.indexOf(i) !== -1) continue;
    spots.push(i);
  }
  if (want > spots.length) want = spots.length;

  const roll = _g2rngOf(rng);
  for (let k = 0; k < want; k++) {
    let pick = Math.floor(roll() * spots.length);
    if (!(pick >= 0)) pick = 0;
    if (pick >= spots.length) pick = spots.length - 1;
    const index = spots.splice(pick, 1)[0];
    grid[index] = _g2makeIce(index);
    placed.push(index);
  }
  return placed;
}

// 過關獻祭：移除所有 value < target / 4 的小磚，每顆 +SACRIFICE_GOLD 金幣。
// 目標磚（value >= target）與其餘大磚一律留在原位、冰塊也原封不動 ——
// 「過關不清盤」是爬塔模式的靈魂，清盤會讓五層退化成五場獨立短局。
// 回傳 { grid, removed, gold }，removed 是被消掉的格號（依格號遞增）。
// 【不 mutate 傳入的 grid】：回傳的是新陣列，留下來的磚沿用原本的物件參考（id 不變）。
function sacrificeTiles(grid, n, target) {
  const size = _g2normSize(n);
  const result = { grid: createInitialGrid(size), removed: [], gold: 0 };
  if (size === 0 || !grid) return result;

  const cells = size * size;
  const next = result.grid;
  // target 非法（0 / NaN）時門檻為 0，等於一顆都不消，比亂消安全
  const threshold = _g2num(target, 0) / 4;

  for (let i = 0; i < cells; i++) {
    const tile = grid[i] || null;
    next[i] = tile;
    if (!tile || isIce(tile)) continue;
    const value = _g2num(tile.value, 0);
    if (value > 0 && value < threshold) {
      next[i] = null;
      result.removed.push(i);
    }
  }
  result.gold = result.removed.length * SACRIFICE_GOLD;
  return result;
}

// 🎲 重新洗牌：保留所有磚的數值與 id，只把位置隨機重排；冰塊留在原位。
// 【不 mutate 傳入的 grid】：回傳新盤面，磚塊沿用原本的物件參考。
// rng 一律外部注入（Fisher-Yates 洗「可用格號」，非冰塊的格子有幾個就洗幾次）。
function shuffleTiles(grid, n, rng) {
  const size = _g2normSize(n);
  if (size === 0 || !grid) return createInitialGrid(size);

  const cells = size * size;
  const next = new Array(cells);
  const spots = [];   // 可以重新分配的格號（冰塊以外的全部格子）
  const tiles = [];   // 要重新分配的磚（依格號遞增蒐集）

  for (let i = 0; i < cells; i++) {
    const tile = grid[i] || null;
    if (isIce(tile)) {
      next[i] = tile;
      continue;
    }
    next[i] = null;
    spots.push(i);
    if (tile) tiles.push(tile);
  }

  const roll = _g2rngOf(rng);
  for (let i = spots.length - 1; i > 0; i--) {
    let j = Math.floor(roll() * (i + 1));
    if (!(j >= 0)) j = 0;
    if (j > i) j = i;
    const swap = spots[i];
    spots[i] = spots[j];
    spots[j] = swap;
  }

  for (let k = 0; k < tiles.length; k++) next[spots[k]] = tiles[k];
  return next;
}

// --------------------------------------------------------------------------
// 手勢判定（純函式，不碰 DOM，node --test 可直接測門檻邏輯）
// --------------------------------------------------------------------------
// 位移是否足以鎖軸。回傳 'x' / 'y'，位移還沒超過 AXIS_LOCK 時回 null（= 尚未鎖軸）。
// 一旦鎖了軸，整段手勢就不再換方向 —— 手指在途中拐彎不該讓盤面換方向推。
function lockSwipeAxis(dx, dy) {
  const ax = Math.abs(_g2num(dx, 0));
  const ay = Math.abs(_g2num(dy, 0));
  // 位移還不夠遠 → 還不能判斷意圖
  if (ax < SWIPE.AXIS_LOCK && ay < SWIPE.AXIS_LOCK) return null;
  // 主軸必須明顯大於副軸（AXIS_RATIO 倍）才鎖定。
  // 正 45 度這種曖昧的斜滑一律回 null，讓呼叫端繼續等使用者滑出明確方向 ——
  // 這裡若貿然鎖成離目前較大的那一軸，使用者接著往另一軸滑就會被這個錯誤的鎖擋掉。
  if (ax >= ay * SWIPE.AXIS_RATIO) return 'x';
  if (ay >= ax * SWIPE.AXIS_RATIO) return 'y';
  return null;
}

// 把一段手勢解析成方向。
//
// gesture 欄位（全部可省略，缺的一律當 0 / undefined 處理）：
//   dx, dy       number  起點到現在的總位移（px），螢幕座標：dy > 0 是往下
//   axis         'x'|'y'|null  已鎖定的軸；沒給就現場用 lockSwipeAxis(dx, dy) 算
//   vx, vy       number  最近 SWIPE.VELOCITY_WINDOW 毫秒內的取樣速度（px/ms）
//   duration     number  整段手勢至今的時間（ms）
//   pointerType  string  'touch' | 'pen' | 'mouse'，只有 'mouse' 會套用較高的距離門檻
//   phase        string  'move' | 'up' | 'end'；或直接給 releasing: true
//   releasing    boolean 是否已放開手指。輕掃（flick）只在放手當下判定，
//                        拖曳途中一律只看距離門檻，避免快速抖動誤觸發
//   fired        boolean 這段手勢是否已經觸發過（一次手勢只能觸發一次）
//   cancelled    boolean 是否已作廢（第二指按下、pointercancel、lostpointercapture）
//
// 回傳 null（不觸發）或 { dir, name, reason }：
//   dir    DIR 的四個值之一
//   name   DIR_NAMES[dir]
//   reason 'distance'（慢速拖曳走足夠距離）或 'flick'（快速輕掃，靠尾段速度）
// 【刻意回物件而不是裸數字】DIR.UP 是 0，回裸數字會讓呼叫端的 if (dir) 漏掉往上滑。
function resolveSwipe(gesture) {
  if (!gesture || typeof gesture !== 'object') return null;
  if (gesture.cancelled === true) return null;
  if (gesture.fired === true) return null;

  const dx = _g2num(gesture.dx, 0);
  const dy = _g2num(gesture.dy, 0);

  const axis = (gesture.axis === 'x' || gesture.axis === 'y')
    ? gesture.axis
    : lockSwipeAxis(dx, dy);
  if (axis !== 'x' && axis !== 'y') return null;

  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const major = axis === 'x' ? ax : ay;
  const minor = axis === 'x' ? ay : ax;

  // 斜滑不觸發：主軸必須大於副軸 AXIS_RATIO 倍
  if (major < minor * SWIPE.AXIS_RATIO) return null;

  const minDistance = gesture.pointerType === 'mouse'
    ? SWIPE.MIN_DISTANCE_MOUSE
    : SWIPE.MIN_DISTANCE;

  // 是否已經放手。輕掃只在放手當下判定 ——
  // 拖曳途中就用尾段速度判定的話，12px 的快速手指抖動就會誤觸發一次移動。
  const releasing = gesture.releasing === true
    || gesture.phase === 'up'
    || gesture.phase === 'end';

  let reason = null;
  if (major >= minDistance) {
    // 慢速拖曳：走滿距離就算數，走多久都認（pointermove 期間就會即時觸發）
    reason = 'distance';
  } else if (releasing && _g2num(gesture.duration, 0) <= SWIPE.MAX_DURATION) {
    // 快速輕掃：距離只要一半，但尾段速度要夠。
    // 【一定要用尾段取樣速度】整段平均速度會被「先猶豫後甩」拉低，用平均會漏判。
    const speed = Math.abs(_g2num(axis === 'x' ? gesture.vx : gesture.vy, 0));
    if (major >= SWIPE.FLICK_DISTANCE && speed >= SWIPE.FLICK_VELOCITY) {
      reason = 'flick';
    }
  }
  // 超時又沒達門檻 → 視為猶豫，直接放棄（落在上面的 else if 之外）
  if (!reason) return null;

  const dir = axis === 'x'
    ? (dx > 0 ? DIR.RIGHT : DIR.LEFT)
    : (dy > 0 ? DIR.DOWN : DIR.UP);

  return { dir: dir, name: DIR_NAMES[dir], reason: reason };
}
// --------------------------------------------------------------------------
// 儲存鍵、皮膚與 APP 段共用小工具（私有工具一律前綴 _app，避免與 CORE 段撞名）
// --------------------------------------------------------------------------
const SAVE_KEY = 'g2048_save_v1';
const STATS_KEY = 'g2048_stats_v1';
const PREF_KEY = 'g2048_pref_v1';
const HOME_PREF_KEY = 'bobo-home-preferences-v2';

const SKINS = { NUMBER: 'number', EVOLVE: 'evolve' };

// 進化皮膚的圖示表：由微生物一路演化到宇宙。查表一律走 hasOwnProperty，
// 裸中括號會撈到 Object.prototype 上的東西（例如 EVOLVE_GLYPHS['constructor']）。
const EVOLVE_GLYPHS = {
  2: '🦠', 4: '🐟', 8: '🐸', 16: '🦎', 32: '🐕', 64: '🐒', 128: '🧑',
  256: '🏛️', 512: '🚀', 1024: '🪐', 2048: '🌌', 4096: '🕳️', 8192: '♾️'
};
// 超出 EVOLVE_GLYPHS 值域（16384 以上）時的兜底圖示
const EVOLVE_FALLBACK_GLYPH = '✨';

// ---- APP 段自有的時間常數 -------------------------------------------------
// 注意：磚塊動畫時序（SLIDE_MS / POP_MS / SPAWN_MS）是 CORE 段的唯一真相，
// 這裡只放「與磚塊動畫無關」的介面時間，且不得複製那三個數字。
const MODAL_FADE_MS = 250;      // 彈窗離場淡出（對應 .modal-overlay 的 opacity transition）
const SHAKE_MS = 240;           // 撞牆微震的保險上限（實際以 animationend 為主）
const TOAST_MS = 2400;          // Toast 停留時間
const TOAST_FADE_MS = 300;      // Toast 淡出時間
const BLITZ_LOW_PCT = 20;   // 閃電模式剩餘時間低於此百分比就轉紅警示
const GAIN_FLOAT_MS = 900;      // 得分浮動字停留時間
const CHAIN_BADGE_MS = 1200;    // 連鎖徽章停留時間
const BLITZ_TICK_MS = 100;      // 閃電模式倒數的取樣間隔
const ACHIEVE_TILES = [512, 1024, 2048, 4096, 8192];   // 會發成就的里程碑磚值

// ---- 爬塔模式的 APP 端常數 -------------------------------------------------
// 樓層表、商店表、冰塊哨兵值與復活步數的唯一真相都在 CORE 段
// （TOWER_FLOORS / SHOP_ITEMS / ICE_VALUE / REVIVE_STEPS），這裡只放介面與局內規則。
const TOWER_SIZE = 4;        // 爬塔固定 4×4，不讓玩家換尺寸
const TOWER_UNDO_BASE = 1;   // 爬塔每局的基礎悔棋次數；商店的 ↩️ 悔棋券再往上加
const TOWER_LOW_PCT = 20;    // 剩餘步數低於此百分比就讓 #step-counter 轉紅（比照閃電模式的時間警示）

// 道具欄位的鍵集合直接由 SHOP_ITEMS 推導，避免「商店改了、存檔欄位忘了改」的兩份真相
const TOWER_ITEM_IDS = SHOP_ITEMS.map((item) => item.id);

// 共用彩帶模組可缺席：new Function(source) 與 require() 兩種測試環境都沒有全域，
// 所以在頂層就固定成 null，呼叫點一律 if (confetti) 守衛。
const confetti = (typeof BoboConfetti !== 'undefined') ? BoboConfetti : null;

// 高解析度時鐘；Node 測試環境沒有 performance 時退回 Date
function _appNow() {
  try {
    if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
      return performance.now();
    }
  } catch (_) {}
  return Date.now();
}

// localStorage 讀取：隱私模式、配額爆掉或 JSON 壞掉一律回退預設值
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

function _appClamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// 盤面大小白名單：只認 SIZE_CONFIG 的「自有屬性」。
// 裸的 SIZE_CONFIG[size] 會讓 'toString' / 'constructor' 這類原型鏈上的 key 通過驗證，
// 被污染的存檔就能塞出一個沒有 target 的設定物件，整局目標與配色全部壞掉。
function _appHasSize(size) {
  return Number.isInteger(size) && Object.prototype.hasOwnProperty.call(SIZE_CONFIG, String(size));
}

// 取得盤面設定；非法尺寸一律退回 4×4，呼叫端不必再自己判斷
function _appSizeCfg(size) {
  return _appHasSize(size) ? SIZE_CONFIG[String(size)] : SIZE_CONFIG['4'];
}

function _appHasMode(mode) {
  return mode === MODES.CLASSIC || mode === MODES.BLITZ || mode === MODES.TOWER;
}

// 爬塔與閃電都固定 4×4；只有經典模式才吃存檔／偏好裡的 size。
function _appModeSize(mode, size) {
  if (mode === MODES.BLITZ) return BLITZ_CONFIG.size;
  if (mode === MODES.TOWER) return TOWER_SIZE;
  return size;
}

// 商店商品查表：SHOP_ITEMS 是陣列，逐項比對 id，天生不會撈到原型鏈上的東西。
function _appShopItem(id) {
  for (let i = 0; i < SHOP_ITEMS.length; i++) {
    if (SHOP_ITEMS[i].id === id) return SHOP_ITEMS[i];
  }
  return null;
}

// 一副全新的道具計數（六個欄位都是 0）
function _appEmptyTowerItems() {
  const items = {};
  for (let i = 0; i < TOWER_ITEM_IDS.length; i++) items[TOWER_ITEM_IDS[i]] = 0;
  return items;
}

// 一局全新的爬塔狀態。存檔的 tower 欄位就是這個形狀（契約第 4 節）。
function _appEmptyTower() {
  return {
    floor: 1,
    steps: 0,
    gold: 0,
    items: _appEmptyTowerItems(),
    seedPending: false,
    meltNext: 0
  };
}

// 讀取道具持有數；查表一律走 hasOwnProperty，被污染的存檔塞不出一個函式當數量。
function _appItemCount(items, id) {
  if (!_appIsPlainObject(items)) return 0;
  if (!Object.prototype.hasOwnProperty.call(items, id)) return 0;
  const n = _appNum(items[id]);
  return n > 0 ? n : 0;
}

// 只接受「有限的非負整數」，其餘一律回 0（存檔驗證與 HUD 都靠它擋髒資料）
function _appNum(value) {
  return (Number.isInteger(value) && value >= 0) ? value : 0;
}

function _appHasSkin(skin) {
  return skin === SKINS.NUMBER || skin === SKINS.EVOLVE;
}

// 進化皮膚的圖示查表（同樣走 hasOwnProperty，超出值域給兜底圖示）
function _appGlyphFor(value) {
  if (Object.prototype.hasOwnProperty.call(EVOLVE_GLYPHS, String(value))) {
    return EVOLVE_GLYPHS[String(value)];
  }
  return EVOLVE_FALLBACK_GLYPH;
}

// 是否為合法的磚值：0（空格）或 2 的冪且不超過 2^MAX_LEVEL。
// allowIce 為 true 時額外放行 ICE_VALUE(-1) —— 這個放寬【只能】給爬塔模式的存檔用，
// 經典／閃電的盤面結構上不可能有冰塊，出現 -1 一律視為被竄改過。
function _appIsTileValue(value, allowIce) {
  if (allowIce === true && value === ICE_VALUE) return true;
  if (!Number.isInteger(value) || value < 0) return false;
  if (value === 0) return true;
  if ((value & (value - 1)) !== 0) return false;
  return levelOf(value) >= 1 && levelOf(value) <= MAX_LEVEL;
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

// 讀一次版面尺寸強迫重排，讓剛移除的 class / hidden 立刻生效，
// 動畫才會真的「重新播一次」而不是被瀏覽器合併掉。
function _appReflow(el) {
  if (!el) return;
  try {
    /* eslint-disable-next-line no-unused-expressions */
    el.offsetWidth;
  } catch (_) {}
}

// 重新觸發 class 動畫（連續兩次合併同一顆磚也要彈第二下）
function _appRetrigger(el, cls) {
  if (!el || !el.classList) return;
  el.classList.remove(cls);
  _appReflow(el);
  el.classList.add(cls);
}

// 重新觸發「靠 hidden 開關」的動畫（display:none → block 會重置 animation）
function _appRestartHidden(el) {
  if (!el) return;
  el.hidden = true;
  _appReflow(el);
  el.hidden = false;
}

function _appSetAttr(el, name, value) {
  if (!el || typeof el.setAttribute !== 'function') return;
  el.setAttribute(name, value);
}

function _appRemoveAttr(el, name) {
  if (!el || typeof el.removeAttribute !== 'function') return;
  el.removeAttribute(name);
}

function _appSetText(el, text) {
  if (!el) return;
  el.textContent = text;
}

// 在 <html> 上開關資料屬性（皮膚、主題）
function _appSetRootAttr(name, value) {
  if (typeof document === 'undefined' || !document.documentElement) return;
  if (value === null) _appRemoveAttr(document.documentElement, name);
  else _appSetAttr(document.documentElement, name, value);
}

// 在 <body> 上開關資料屬性（模式、純圖示）
function _appSetBodyAttr(name, value) {
  if (typeof document === 'undefined' || !document.body) return;
  if (value === null) _appRemoveAttr(document.body, name);
  else _appSetAttr(document.body, name, value);
}

// 把 index 換算成 CSS 變數要的整數欄列
function _appColOf(index, n) {
  return index % n;
}

function _appRowOf(index, n) {
  return Math.floor(index / n);
}

// 磚塊的 aria-label 一律報數字，不受皮膚影響（進化皮膚只是視覺糖）
function _appTileLabel(value, index, n) {
  return `${value}，第 ${_appRowOf(index, n) + 1} 列第 ${_appColOf(index, n) + 1} 行`;
}

// 冰塊沒有面值，報讀時要唸得出「這格動不了」，不能唸成「0」
function _appIceLabel(index, n) {
  return `冰塊，第 ${_appRowOf(index, n) + 1} 列第 ${_appColOf(index, n) + 1} 行，無法移動或合併`;
}

// 毫秒 → 「分:秒.十分之一秒」，閃電模式倒數用
function _appFormatMs(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const tenths = Math.floor(total / 100) % 10;
  const secs = Math.floor(total / 1000) % 60;
  const mins = Math.floor(total / 60000);
  return `${mins}:${String(secs).padStart(2, '0')}.${tenths}`;
}

// 手勢尾段速度：整段平均速度會被「先猶豫後甩」拉低，一定要用最近的取樣視窗。
// 回傳 px/ms。
function _appTailVelocity(samples, now) {
  const zero = { vx: 0, vy: 0 };
  if (!Array.isArray(samples) || samples.length < 2) return zero;
  const last = samples[samples.length - 1];
  let base = samples[0];
  for (let i = samples.length - 2; i >= 0; i--) {
    base = samples[i];
    if (now - samples[i].t >= SWIPE.VELOCITY_WINDOW) break;
  }
  const dt = last.t - base.t;
  if (!(dt > 0)) return zero;
  return { vx: (last.x - base.x) / dt, vy: (last.y - base.y) / dt };
}

// lockSwipeAxis 的回傳正規化成 'x' / 'y' / null，
// 讓 CORE 段回 'horizontal' / 'vertical' 這種寫法也不會整套壞掉。
function _appNormalizeAxis(axis) {
  if (axis === 'x' || axis === 'y') return axis;
  if (axis === 'horizontal') return 'x';
  if (axis === 'vertical') return 'y';
  if (_appIsPlainObject(axis) && (axis.axis === 'x' || axis.axis === 'y')) return axis.axis;
  return null;
}

// resolveSwipe 的回傳正規化成 DIR 的數值（0~3）或 null。
// 允許數字、DIR_NAMES 字串、或帶 dir / direction 欄位的物件三種形態，
// 這樣 CORE 段選了哪一種表示法都不會讓手勢整組失效。
function _appDirFromResolve(result) {
  if (result === null || result === undefined || result === false) return null;
  if (typeof result === 'number') {
    return (Number.isInteger(result) && result >= 0 && result < DIR_NAMES.length) ? result : null;
  }
  if (typeof result === 'string') {
    const idx = DIR_NAMES.indexOf(result);
    return idx >= 0 ? idx : null;
  }
  if (_appIsPlainObject(result)) {
    if (result.dir !== undefined) return _appDirFromResolve(result.dir);
    if (result.direction !== undefined) return _appDirFromResolve(result.direction);
  }
  return null;
}

// --------------------------------------------------------------------------
// 音效合成器（滑動、合併、生成、達標、結束、撞牆）
// 只保留 2048 自己的「音色」；AudioContext 建立／解鎖、背景暫停、節點回收、
// 開關持久化這些瀏覽器樣板全部交給共用模組 assets/js/bobo-audio.js。
// 模組缺席時（測試環境用 new Function 編譯本檔）this.kit 會是 null，
// 所有 play* 安靜退場，遊戲照常能玩，只是沒有聲音。
// --------------------------------------------------------------------------
class _appSoundManager {
  constructor() {
    // 開關存在 g2048_pref_v1 的 sound 欄位；模組會「讀回整包再只改這個欄位」，
    // 不會清掉同一個 key 裡的 skin / size / mode 等其他偏好。
    this.kit = (typeof BoboAudio !== 'undefined' && BoboAudio)
      ? BoboAudio.create({ storageKey: PREF_KEY, storageField: 'sound' })
      : null;
    // 模組缺席時仍要有一個可讀寫的開關，讓 UI 與偏好存檔照常運作
    this.fallbackEnabled = true;
  }

  // this.sound.enabled 是遊戲各處（updateSoundIcon / savePreferences /
  // loadPreferences）讀寫的介面，維持原樣；有模組時一律以模組的即時值為準。
  get enabled() {
    return this.kit ? this.kit.enabled : this.fallbackEnabled;
  }

  set enabled(on) {
    if (this.kit) this.kit.enabled = !!on;
    else this.fallbackEnabled = !!on;
  }

  // 使用者手勢時呼叫：iOS 唯一能建立／解鎖 AudioContext 的時機
  unlock() {
    if (this.kit) this.kit.unlock();
  }

  toggle() {
    if (this.kit) return this.kit.toggle();
    this.fallbackEnabled = !this.fallbackEnabled;
    return this.fallbackEnabled;
  }

  // 滑動：極短的氣音，連刷十次也不會吵
  playSlide() {
    if (this.kit) this.kit.tone({ freq: 320, type: 'triangle', duration: 0.05, gain: 0.07 });
  }

  // 合併：磚越大音越高，讓玩家用耳朵就聽得出滾雪球
  playMerge(level) {
    if (!this.kit) return;
    const step = _appClamp(Number.isFinite(level) ? level : 1, 1, 12);
    const freq = 262 * Math.pow(2, (step - 1) / 6);
    this.kit.tone({ freq, type: 'sine', duration: 0.09, gain: 0.13 });
    this.kit.tone({ freq: freq * 2, type: 'triangle', duration: 0.06, gain: 0.05, delay: 0.02 });
  }

  // 生成：輕巧的點擊
  playSpawn() {
    if (this.kit) this.kit.tone({ freq: 660, type: 'sine', duration: 0.04, gain: 0.05 });
  }

  // 達標：上行大三和弦琶音（改用音訊時鐘排程，取代原本的 setTimeout）
  playTarget() {
    if (!this.kit) return;
    this.kit.chord([523.25, 659.25, 783.99, 1046.5], {
      type: 'sine',
      duration: 0.22,
      gain: 0.15,
      stagger: 0.12
    });
  }

  // 結束：下行小三和弦
  playOver() {
    if (!this.kit) return;
    this.kit.chord([392, 329.63, 261.63], {
      type: 'triangle',
      duration: 0.26,
      gain: 0.13,
      stagger: 0.15
    });
  }

  // 撞牆：悶悶的低頻回饋
  playWall() {
    if (this.kit) this.kit.tone({ freq: 96, type: 'square', duration: 0.07, gain: 0.08 });
  }

  // 加時：短促上滑音
  playBonus() {
    if (this.kit) this.kit.sweep({ from: 520, to: 1040, type: 'sine', duration: 0.16, gain: 0.1 });
  }

  // 爬塔過關：比 playTarget 更長的上行琶音，最後補一顆高音當「登上一階」的落點
  playFloorClear() {
    if (!this.kit) return;
    this.kit.chord([392, 523.25, 659.25, 783.99, 1046.5], {
      type: 'sine',
      duration: 0.24,
      gain: 0.14,
      stagger: 0.1
    });
  }

  // 商店成交：兩顆金屬感的短音，像金幣落進袋子
  playBuy() {
    if (!this.kit) return;
    this.kit.tone({ freq: 988, type: 'triangle', duration: 0.06, gain: 0.1 });
    this.kit.tone({ freq: 1319, type: 'triangle', duration: 0.08, gain: 0.08, delay: 0.05 });
  }

  // 🔨 敲碎：由高往低的短促碎裂聲
  playSmash() {
    if (!this.kit) return;
    this.kit.sweep({ from: 880, to: 140, type: 'square', duration: 0.14, gain: 0.09 });
  }
}

// --------------------------------------------------------------------------
// 主控制器 Game2048
// 設計原則：所有 DOM 查詢集中在 initElements()，其餘方法一律容忍 this.el.xxx 為
// undefined，讓測試能用 Object.create(Game2048.prototype) + Object.assign 灌假依賴，
// 只呼叫單一方法而不需要真的 DOM。
// --------------------------------------------------------------------------
class Game2048 {
  constructor() {
    this.sound = new _appSoundManager();

    // 對局設定
    this.mode = MODES.CLASSIC;
    this.size = 4;
    this.skin = SKINS.NUMBER;
    this.glyphOnly = false;

    // 對局狀態
    this.grid = createInitialGrid(this.size);
    this.nextId = 1;
    this.score = 0;
    this.best = 0;
    this.moveCount = 0;
    this.undosUsed = 0;
    this.hintsUsed = 0;
    this.continued = false;
    this.won = false;
    this.gameOver = false;
    this.startedAt = Date.now();
    this.blitzLeftMs = BLITZ_CONFIG.startMs;
    this.undoSnapshot = null;        // UndoSnapshot | null（存檔欄位叫 undo，這裡不能同名蓋掉 undo() 方法）

    // 本局統計累加器（結算時才一次寫進 localStorage，減少寫入次數）
    this.mergesThisGame = 0;
    this.bestChainThisGame = 0;

    // 隨機來源：實戰用 Math.random，測試可直接覆寫成 createRng(seed)
    this.rng = Math.random;

    // 渲染層狀態
    this.nodes = new Map();          // id -> .tile 元素（唯一的查找來源）
    this.dying = [];                 // 待清垃圾袋，不參與任何查找
    this.pending = null;             // { merges, spawn } 尚未 commit 的這一回合

    // 計時器控制代碼
    this.commitTimer = null;
    this.blitzTimer = null;
    this.blitzTickAt = 0;
    this.shakeTimer = null;
    this.gainTimer = null;
    this.chainTimer = null;

    // 爬塔模式狀態。存檔的 tower 欄位就是 this.tower 這一包（契約第 4 節）；
    // smashing 是「敲碎模式開著沒有」的暫態，不進存檔 —— 重整後理當回到普通操作。
    this.tower = _appEmptyTower();
    this.smashing = false;

    // 介面狀態
    this.statsSize = 4;
    this.confirmAction = null;
    this.gesture = null;
    this.lastFocusedElement = null;
    this.el = {};

    this.init();
  }

  // ------------------------------------------------------------------------
  // 啟動流程：先接上 DOM 與偏好，再嘗試續玩未完成的一局
  // ------------------------------------------------------------------------
  init() {
    this.initElements();
    this.syncMotionTokens();
    this.loadPreferences();
    this.initTheme();
    this.bindEvents();

    if (!this.loadGameState()) {
      this.startNewGame({ silent: true });
    }
  }

  // ------------------------------------------------------------------------
  // DOM 元素快取（全檔唯一查詢 DOM 的地方）
  // ------------------------------------------------------------------------
  initElements() {
    if (typeof document === 'undefined') {
      this.el = {};
      return;
    }
    const byId = (id) => document.getElementById(id);
    this.el = {
      // 頂部工具列
      skinBtn: byId('skin-btn'),
      themeBtn: byId('theme-btn'),
      soundBtn: byId('sound-btn'),
      statsBtn: byId('stats-btn'),
      helpBtn: byId('help-btn'),

      // 標題（文字由 HTML 固定，JS 只補上動態 title 提示，不覆蓋內容）
      titleText: byId('title-text'),
      titleBadge: byId('title-badge'),

      // 模式與尺寸
      modeTabs: byId('mode-tabs'),
      modeTabBtns: document.querySelectorAll('#mode-tabs .mode-tab-btn'),
      sizeBar: byId('size-bar'),
      sizeBtns: document.querySelectorAll('#size-bar .size-btn'),

      // HUD
      scoreEl: byId('score'),
      bestEl: byId('best'),
      targetEl: byId('target'),
      goalLabel: byId('goal-label'),
      blitzBar: byId('blitz-bar'),
      blitzTime: byId('blitz-time'),
      blitzFill: byId('blitz-fill'),
      chainBadge: byId('chain-badge'),
      gainFloat: byId('gain-float'),

      // 爬塔 HUD（經典與閃電模式整列隱藏）
      towerBar: byId('tower-bar'),
      floorBadge: byId('floor-badge'),
      stepCounter: byId('step-counter'),
      goldCounter: byId('gold-counter'),
      reviveCounter: byId('revive-counter'),

      // 盤面
      boardFrame: byId('board-frame'),
      boardGrid: byId('board-grid'),
      tileLayer: byId('tile-layer'),
      boardOverlay: byId('board-overlay'),

      // 底部動作列
      undoBtn: byId('undo-btn'),
      undoBadge: byId('undo-badge'),
      restartBtn: byId('restart-btn'),
      glyphBtn: byId('glyph-btn'),

      // 結算彈窗
      resultModal: byId('result-modal'),
      resultEmoji: byId('result-emoji'),
      resultTitleText: byId('result-title-text'),
      resultCloseBtn: byId('result-close-btn'),
      resultScore: byId('result-score'),
      resultBest: byId('result-best'),
      resultMaxtile: byId('result-maxtile'),
      resultDetail: byId('result-detail'),
      resultContinueBtn: byId('result-continue-btn'),
      resultAgainBtn: byId('result-again-btn'),

      // 確認彈窗
      confirmModal: byId('confirm-modal'),
      confirmTitle: byId('confirm-title'),
      confirmCloseBtn: byId('confirm-close-btn'),
      confirmText: byId('confirm-text'),
      confirmCancelBtn: byId('confirm-cancel-btn'),
      confirmOkBtn: byId('confirm-ok-btn'),

      // 戰績彈窗
      statsModal: byId('stats-modal'),
      statsSizeTabs: byId('stats-size-tabs'),
      statsSizeBtns: document.querySelectorAll('#stats-size-tabs .size-btn'),
      statPlays: byId('stat-plays'),
      statBest: byId('stat-best'),
      statMaxtile: byId('stat-maxtile'),
      statMilestone: byId('stat-milestone'),
      statHits: byId('stat-hits'),
      statStreak: byId('stat-streak'),
      statFewest: byId('stat-fewest'),
      statsResetBtn: byId('stats-reset-btn'),
      statsOkBtn: byId('stats-ok-btn'),

      // 層間商店彈窗（商品卡片由 renderShop() 依 SHOP_ITEMS 生成，HTML 只有空容器）
      shopModal: byId('shop-modal'),
      shopTitle: byId('shop-title'),
      shopGold: byId('shop-gold'),
      shopItems: byId('shop-items'),
      shopCloseBtn: byId('shop-close-btn'),
      shopNextBtn: byId('shop-next-btn'),

      // 說明彈窗
      helpModal: byId('help-modal'),
      helpCloseBtn: byId('help-close-btn'),
      helpOkBtn: byId('help-ok-btn'),

      // Toast 與彩帶
      toastContainer: byId('toast-container'),
      confettiCanvas: byId('confetti-canvas')
    };

    // role="grid" 必須可聚焦，鍵盤玩家才有地方按方向鍵；
    // 這是 JS 擁有的屬性，HTML 不需要（也不該）硬寫。
    if (this.el.tileLayer && typeof this.el.tileLayer.tabIndex !== 'undefined') {
      this.el.tileLayer.tabIndex = 0;
    }

    // 爬塔專屬的兩塊介面（🔨 敲碎鍵與爬塔戰績面板）由 JS 生成，
    // index.html 完全不必知道它們的存在 —— 它們只在爬塔模式出現，
    // 而且用的 class 全部是既有的（.action-btn / .stats-grid 那一套），不新增樣式。
    this.buildTowerControls();
  }

  // ------------------------------------------------------------------------
  // 爬塔專屬介面的動態組裝
  // ------------------------------------------------------------------------
  // 底部動作列的 🔨 敲碎鍵。用 display 直接開關而不是 hidden 屬性 ——
  // .action-btn 自己就宣告了 display:flex，作者樣式一定壓得過 [hidden] 的 UA 規則。
  buildTowerControls() {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
    const bar = (typeof document.querySelector === 'function')
      ? document.querySelector('.thumb-action-bar')
      : null;
    if (bar && typeof bar.appendChild === 'function') {
      const btn = document.createElement('button');
      btn.className = 'action-btn';
      btn.type = 'button';
      // 預設收起：refreshSmashUi() 會在爬塔模式把它打開，
      // 但在那之前的一瞬間不該讓經典模式的玩家看到一顆用不到的鍵。
      if (btn.style) btn.style.display = 'none';
      _appSetAttr(btn, 'aria-label', '敲碎：點掉盤面上任意一顆磚');
      _appSetAttr(btn, 'aria-pressed', 'false');
      const icon = document.createElement('span');
      icon.className = 'btn-icon';
      _appSetAttr(icon, 'aria-hidden', 'true');
      icon.textContent = '🔨';
      const text = document.createElement('span');
      text.textContent = '敲碎';
      const badge = document.createElement('span');
      badge.className = 'btn-badge';
      btn.appendChild(icon);
      btn.appendChild(text);
      btn.appendChild(badge);
      bar.appendChild(btn);
      this.el.smashBtn = btn;
      this.el.smashBadge = badge;
    }

    // 戰績彈窗的爬塔面板：與經典的尺寸分頁互斥，同一時間只露一組（契約第 4 節）
    const body = (this.el.statsModal && typeof this.el.statsModal.querySelector === 'function')
      ? this.el.statsModal.querySelector('.modal-body')
      : null;
    if (body) {
      this.el.statsClassicGrid = (typeof body.querySelector === 'function')
        ? body.querySelector('.stats-grid')
        : null;
      if (typeof body.appendChild === 'function') {
        const panel = document.createElement('div');
        panel.className = 'stats-grid';
        const fields = [
          ['towerPlays', '爬塔場次'],
          ['towerClears', '登頂次數'],
          ['towerFloor', '最深樓層'],
          ['towerGold', '單局最多金幣'],
          ['towerSteps', '單層最少步數']
        ];
        for (let i = 0; i < fields.length; i++) {
          const item = document.createElement('div');
          item.className = 'stat-item';
          const label = document.createElement('div');
          label.className = 'stat-label';
          label.textContent = fields[i][1];
          const val = document.createElement('div');
          val.className = 'stat-val';
          val.textContent = '--';
          item.appendChild(label);
          item.appendChild(val);
          panel.appendChild(item);
          this.el[fields[i][0]] = val;
        }
        body.appendChild(panel);
        this.el.towerStats = panel;
      }
    }
    this.showTowerStats(false);
  }

  // 三塊互斥的區域：非爬塔看尺寸分頁 + 經典戰績格，爬塔看爬塔面板
  showTowerStats(on) {
    const swap = (el, visible, shown) => {
      if (!el || !el.style) return;
      el.style.display = visible ? shown : 'none';
    };
    swap(this.el && this.el.statsSizeTabs, !on, 'flex');
    swap(this.el && this.el.statsClassicGrid, !on, 'grid');
    swap(this.el && this.el.towerStats, !!on, 'grid');
  }

  // 把 JS 的時序常數推進 CSS 變數，確保兩邊永遠同一組數字。
  // JS 的 setTimeout(commit, SLIDE_MS) 與 CSS 的 transition 只要差一點，
  // 就會出現「磚還在滑、盤面已重畫」。
  syncMotionTokens() {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (!root || !root.style || typeof root.style.setProperty !== 'function') return;
    root.style.setProperty('--slide-ms', SLIDE_MS + 'ms');
    root.style.setProperty('--pop-ms', POP_MS + 'ms');
    root.style.setProperty('--spawn-ms', SPAWN_MS + 'ms');
  }

  prefersReducedMotion() {
    try {
      return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_) {
      return false;
    }
  }

  // ------------------------------------------------------------------------
  // 偏好設定（g2048_pref_v1）
  // ------------------------------------------------------------------------
  loadPreferences() {
    const pref = _appReadJson(PREF_KEY, {});
    if (!_appIsPlainObject(pref)) return;
    if (_appHasMode(pref.mode)) this.mode = pref.mode;
    if (_appHasSize(pref.size)) this.size = pref.size;
    if (_appHasSkin(pref.skin)) this.skin = pref.skin;
    if (typeof pref.glyphOnly === 'boolean') this.glyphOnly = pref.glyphOnly;
    if (typeof pref.sound === 'boolean' && this.sound) this.sound.enabled = pref.sound;
    // 閃電模式固定 4×4，偏好裡存了別的尺寸也要拉回來
    if (this.mode === MODES.BLITZ) this.size = BLITZ_CONFIG.size;
    this.statsSize = this.size;
  }

  savePreferences() {
    _appWriteJson(PREF_KEY, {
      sound: !!(this.sound && this.sound.enabled),
      skin: this.skin,
      glyphOnly: !!this.glyphOnly,
      size: this.size,
      mode: this.mode
    });
  }

  // ------------------------------------------------------------------------
  // 主題（與首頁共用 bobo-home-preferences-v2）
  // ------------------------------------------------------------------------
  initTheme() {
    if (typeof document === 'undefined') return;
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
    _appSetRootAttr('data-theme', theme);
    const meta = (typeof document.querySelector === 'function')
      ? document.querySelector('meta[name="theme-color"]')
      : null;
    if (meta) _appSetAttr(meta, 'content', theme === 'dark' ? '#0f172a' : '#f5f7fb');
    this.updateThemeIcon(theme);
  }

  currentTheme() {
    if (typeof document === 'undefined' || !document.documentElement) return 'light';
    const root = document.documentElement;
    const value = (typeof root.getAttribute === 'function') ? root.getAttribute('data-theme') : null;
    return value === 'dark' ? 'dark' : 'light';
  }

  // 讀寫首頁偏好時「先讀回整包再只改 theme」：
  // 直接覆寫整包會清掉使用者在首頁排的 order 與 hidden。
  toggleTheme() {
    const next = this.currentTheme() === 'dark' ? 'light' : 'dark';
    this.applyTheme(next);
    const home = _appReadJson(HOME_PREF_KEY, {});
    const merged = _appIsPlainObject(home) ? home : {};
    merged.theme = next;
    _appWriteJson(HOME_PREF_KEY, merged);
    return next;
  }

  updateThemeIcon(theme) {
    const btn = this.el && this.el.themeBtn;
    if (!btn) return;
    const dark = theme === 'dark';
    btn.innerHTML = dark
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/></svg>';
    // DOM 契約表要求 theme-btn 同步 aria-pressed：按下 = 目前是深色
    _appSetAttr(btn, 'aria-pressed', dark ? 'true' : 'false');
    _appSetAttr(btn, 'title', dark ? '切換為淺色模式' : '切換為深色模式');
    _appSetAttr(btn, 'aria-label', dark ? '切換為淺色模式' : '切換為深色模式');
    if (btn.classList) btn.classList.toggle('active', dark);
  }

  // ------------------------------------------------------------------------
  // 事件綁定
  // ------------------------------------------------------------------------
  bindEvents() {
    if (typeof document === 'undefined' || !this.el) return;

    if (this.el.skinBtn) this.el.skinBtn.addEventListener('click', () => this.toggleSkin());
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

    if (this.el.modeTabBtns && this.el.modeTabBtns.forEach) {
      this.el.modeTabBtns.forEach((btn) => {
        btn.addEventListener('click', () => this.setMode(btn.dataset ? btn.dataset.mode : null));
      });
    }
    if (this.el.sizeBtns && this.el.sizeBtns.forEach) {
      this.el.sizeBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
          const raw = btn.dataset ? btn.dataset.size : null;
          this.setSize(parseInt(raw, 10));
        });
      });
    }

    if (this.el.undoBtn) this.el.undoBtn.addEventListener('click', () => this.undo());
    if (this.el.smashBtn) this.el.smashBtn.addEventListener('click', () => this.toggleSmash());
    if (this.el.restartBtn) this.el.restartBtn.addEventListener('click', () => this.requestRestart());
    if (this.el.glyphBtn) this.el.glyphBtn.addEventListener('click', () => this.toggleGlyphOnly());

    // 彈窗按鈕
    if (this.el.resultCloseBtn) this.el.resultCloseBtn.addEventListener('click', () => this.closeModal(this.el.resultModal));
    if (this.el.resultContinueBtn) this.el.resultContinueBtn.addEventListener('click', () => this.continueGame());
    if (this.el.resultAgainBtn) {
      this.el.resultAgainBtn.addEventListener('click', () => {
        this.closeModal(this.el.resultModal);
        this.startNewGame();
      });
    }
    if (this.el.confirmCloseBtn) this.el.confirmCloseBtn.addEventListener('click', () => this.cancelConfirm());
    if (this.el.confirmCancelBtn) this.el.confirmCancelBtn.addEventListener('click', () => this.cancelConfirm());
    if (this.el.confirmOkBtn) this.el.confirmOkBtn.addEventListener('click', () => this.acceptConfirm());
    if (this.el.statsOkBtn) this.el.statsOkBtn.addEventListener('click', () => this.closeModal(this.el.statsModal));
    if (this.el.statsResetBtn) this.el.statsResetBtn.addEventListener('click', () => this.resetStats());
    if (this.el.statsSizeBtns && this.el.statsSizeBtns.forEach) {
      this.el.statsSizeBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
          const raw = btn.dataset ? btn.dataset.statsize : null;
          this.renderStats(parseInt(raw, 10));
        });
      });
    }
    if (this.el.helpCloseBtn) this.el.helpCloseBtn.addEventListener('click', () => this.closeModal(this.el.helpModal));
    if (this.el.helpOkBtn) this.el.helpOkBtn.addEventListener('click', () => this.closeModal(this.el.helpModal));
    // 商店的三個出口（叉叉、遮罩、footer）全部導向 goNextFloor()：
    // 商店是「過關 → 下一層」中間的一站，關掉它就等於踏上階梯，沒有「跳過」這個選項。
    if (this.el.shopCloseBtn) this.el.shopCloseBtn.addEventListener('click', () => this.goNextFloor());
    if (this.el.shopNextBtn) this.el.shopNextBtn.addEventListener('click', () => this.goNextFloor());

    // 點遮罩關閉彈窗
    if (typeof document.querySelectorAll === 'function') {
      document.querySelectorAll('.modal-overlay').forEach((modal) => {
        modal.addEventListener('click', (event) => {
          if (event.target !== modal) return;
          if (modal === this.el.confirmModal) this.cancelConfirm();
          else if (modal === this.el.shopModal) this.goNextFloor();
          else this.closeModal(modal);
        });
      });
    }

    this.bindBoardGestures();
    document.addEventListener('keydown', (event) => this.handleKeydown(event));

    // 切到背景與離開頁面時保存進度
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.flushPending();
        this.saveGameState();
      } else {
        // 回前景時把倒數的取樣基準點拉回現在，背景那段時間不算進倒數
        this.blitzTickAt = _appNow();
      }
    });
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', () => {
        this.flushPending();
        this.saveGameState();
      });
    }
  }

  // ------------------------------------------------------------------------
  // 滑動手勢（Pointer Events）
  // 門檻一律取用 CORE 段的 SWIPE / lockSwipeAxis / resolveSwipe，這裡不另定一套。
  // ------------------------------------------------------------------------
  bindBoardGestures() {
    const frame = this.el && this.el.boardFrame;
    if (frame && typeof frame.addEventListener === 'function') {
      frame.addEventListener('pointerdown', (event) => this.onPointerDown(event));
      frame.addEventListener('pointermove', (event) => this.onPointerMove(event));
      frame.addEventListener('pointerup', (event) => this.onPointerUp(event));
      // pointercancel 與 lostpointercapture 都一律視為中止
      frame.addEventListener('pointercancel', (event) => this.onPointerCancel(event));
      frame.addEventListener('lostpointercapture', (event) => this.onPointerCancel(event));
    }
    // touchmove 的 preventDefault 必須綁 document 而非 board：
    // touch 事件的 target 鎖在 touchstart 當下的節點，那顆磚被重繪移除後就不會冒泡到 board，
    // 綁在 board 上會讓頁面在滑動途中突然開始捲動。
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    }

    // 🔨 敲碎模式靠點擊磚塊，用事件委派綁在磚層上 ——
    // 磚塊 DOM 每一步都在生生滅滅，綁在個別磚塊上等於每顆都要記得解綁。
    const layer = this.el && this.el.tileLayer;
    if (layer && typeof layer.addEventListener === 'function') {
      layer.addEventListener('click', (event) => this.onBoardClick(event));
    }
  }

  // 手勢進行中才擋掉頁面捲動；沒在滑的時候頁面要能正常捲動
  onTouchMove(event) {
    const g = this.gesture;
    if (!g) return;
    if (g.pointerType === 'touch' && event && event.cancelable) event.preventDefault();
  }

  onPointerDown(event) {
    if (!event) return;
    // 第二根手指按下 → 整段手勢作廢（那是縮放意圖，不是要推格子）
    if (this.gesture) {
      if (event.pointerId !== this.gesture.pointerId) this.endGesture();
      return;
    }
    if (typeof event.button === 'number' && event.button > 0) return;
    if (this.isInputBlocked()) return;

    // 使用者手勢是解鎖 AudioContext 的唯一時機
    if (this.sound) this.sound.unlock();

    const now = _appNow();
    const x = Number(event.clientX) || 0;
    const y = Number(event.clientY) || 0;
    this.gesture = {
      pointerId: event.pointerId,
      pointerType: event.pointerType === 'mouse' || event.pointerType === 'pen' ? event.pointerType : 'touch',
      x0: x,
      y0: y,
      startedAt: now,
      axis: null,
      fired: false,
      samples: [{ x, y, t: now }]
    };

    // pointer capture 綁在 #board-frame，不要綁 e.target ——
    // 磚塊 DOM 會在 commit 時重建，綁在磚塊上會中途失去捕獲。
    const frame = this.el && this.el.boardFrame;
    try {
      if (frame && typeof frame.setPointerCapture === 'function') frame.setPointerCapture(event.pointerId);
    } catch (_) {}
  }

  onPointerMove(event) {
    const g = this.gesture;
    if (!g || !event || event.pointerId !== g.pointerId) return;

    const now = _appNow();
    const x = Number(event.clientX) || 0;
    const y = Number(event.clientY) || 0;
    g.samples.push({ x, y, t: now });
    // 只保留速度視窗內的取樣（外加一顆當基準點）
    while (g.samples.length > 2 && now - g.samples[1].t > SWIPE.VELOCITY_WINDOW) g.samples.shift();

    if (g.fired) return;

    const dx = x - g.x0;
    const dy = y - g.y0;
    // 超過 AXIS_LOCK 就鎖軸，整段手勢不再換方向
    if (!g.axis && (Math.abs(dx) >= SWIPE.AXIS_LOCK || Math.abs(dy) >= SWIPE.AXIS_LOCK)) {
      g.axis = _appNormalizeAxis(lockSwipeAxis(dx, dy));
    }

    // 拖曳期間就達到門檻要立刻觸發，慢速拖曳才有即時回饋
    const dir = this.resolveGesture(g, x, y, now, 'move');
    if (dir === null) return;
    g.fired = true;
    this.applyMove(dir);
  }

  onPointerUp(event) {
    const g = this.gesture;
    if (!g || !event || event.pointerId !== g.pointerId) return;

    if (!g.fired) {
      const now = _appNow();
      const x = Number(event.clientX) || 0;
      const y = Number(event.clientY) || 0;
      g.samples.push({ x, y, t: now });
      if (!g.axis) g.axis = _appNormalizeAxis(lockSwipeAxis(x - g.x0, y - g.y0));
      // 放開時改用最近 VELOCITY_WINDOW 的取樣速度判定輕掃
      const dir = this.resolveGesture(g, x, y, now, 'up');
      if (dir !== null) {
        g.fired = true;
        this.applyMove(dir);
      }
    }
    this.endGesture();
  }

  onPointerCancel(event) {
    const g = this.gesture;
    if (!g) return;
    if (event && event.pointerId !== undefined && event.pointerId !== g.pointerId) return;
    this.endGesture();
  }

  endGesture() {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    const frame = this.el && this.el.boardFrame;
    try {
      if (frame && typeof frame.releasePointerCapture === 'function'
        && (typeof frame.hasPointerCapture !== 'function' || frame.hasPointerCapture(g.pointerId))) {
        frame.releasePointerCapture(g.pointerId);
      }
    } catch (_) {}
  }

  // 把手勢狀態整理成 resolveSwipe 需要的資料包。
  // 欄位刻意寫滿（總位移、鎖定軸、耗時、尾段速度、輸入裝置、階段），
  // 讓門檻判定完全由 CORE 段的 resolveSwipe 決定，APP 段不重複一套數字。
  buildGesture(g, x, y, now, phase) {
    const dx = x - g.x0;
    const dy = y - g.y0;
    const duration = Math.max(0, now - g.startedAt);
    const vel = _appTailVelocity(g.samples, now);
    const axis = g.axis;
    return {
      dx,
      dy,
      x0: g.x0,
      y0: g.y0,
      x,
      y,
      axis,
      duration,
      elapsed: duration,
      pointerType: g.pointerType,
      vx: vel.vx,
      vy: vel.vy,
      velocity: axis === 'y' ? Math.abs(vel.vy) : Math.abs(vel.vx),
      speed: Math.sqrt(vel.vx * vel.vx + vel.vy * vel.vy),
      phase,
      fired: g.fired
    };
  }

  resolveGesture(g, x, y, now, phase) {
    if (typeof resolveSwipe !== 'function') return null;
    let result = null;
    try {
      result = resolveSwipe(this.buildGesture(g, x, y, now, phase));
    } catch (_) {
      return null;
    }
    return _appDirFromResolve(result);
  }

  // ------------------------------------------------------------------------
  // 鍵盤：方向鍵 / WASD 推格、Z 悔棋、R 重開、Esc 關窗
  // ------------------------------------------------------------------------
  handleKeydown(event) {
    if (!event || typeof document === 'undefined') return;
    const openModal = (typeof document.querySelector === 'function')
      ? document.querySelector('.modal-overlay.open')
      : null;

    if (event.key === 'Escape') {
      if (openModal) {
        if (openModal === this.el.confirmModal) this.cancelConfirm();
        else if (openModal === this.el.shopModal) this.goNextFloor();
        else this.closeModal(openModal);
        return;
      }
      // 沒有彈窗開著時，Esc 就是「取消敲碎模式」的退路
      if (this.smashing) this.setSmashing(false);
      return;
    }

    if (event.key === 'Tab' && openModal) {
      this.trapFocus(event, openModal);
      return;
    }
    if (openModal) return;

    const target = event.target;
    const tag = (target && target.tagName) ? target.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (target && target.isContentEditable) return;

    const dir = this.keyToDir(event.key);
    if (dir !== null) {
      // 只有焦點在棋盤內或 body 上才攔截方向鍵；
      // 焦點在按鈕 / 連結 / role="tab" 分頁上時交還瀏覽器，
      // 否則會破壞頁面捲動與分頁的左右鍵切換。
      if (!this.isBoardFocus(target)) return;
      event.preventDefault();
      this.applyMove(dir);
      return;
    }

    if (event.key === 'z' || event.key === 'Z') {
      event.preventDefault();
      this.undo();
      return;
    }
    if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      this.requestRestart();
    }
  }

  keyToDir(key) {
    if (key === 'ArrowUp' || key === 'w' || key === 'W') return DIR.UP;
    if (key === 'ArrowRight' || key === 'd' || key === 'D') return DIR.RIGHT;
    if (key === 'ArrowDown' || key === 's' || key === 'S') return DIR.DOWN;
    if (key === 'ArrowLeft' || key === 'a' || key === 'A') return DIR.LEFT;
    return null;
  }

  // 焦點在棋盤內、在 <body> 上、或根本沒有焦點元素時才視為「在玩棋盤」
  isBoardFocus(target) {
    if (typeof document === 'undefined') return false;
    if (!target) return true;
    if (target === document.body || target === document.documentElement) return true;
    if (typeof target.closest === 'function' && target.closest('#board-frame')) return true;
    return false;
  }

  // ------------------------------------------------------------------------
  // 盤面渲染
  // ------------------------------------------------------------------------
  // 背景格與 --n：尺寸換算全部交給 CSS，JS 不量任何像素
  renderBoardShell() {
    if (typeof document === 'undefined' || !this.el) return;
    const n = this.size;
    const frame = this.el.boardFrame;
    if (frame && frame.style && typeof frame.style.setProperty === 'function') {
      frame.style.setProperty('--n', String(n));
    }
    const gridEl = this.el.boardGrid;
    if (!gridEl) return;
    gridEl.innerHTML = '';
    const frag = (typeof document.createDocumentFragment === 'function')
      ? document.createDocumentFragment()
      : null;
    for (let i = 0; i < n * n; i++) {
      const cell = document.createElement('div');
      cell.className = 'cell-bg';
      if (frag) frag.appendChild(cell);
      else gridEl.appendChild(cell);
    }
    if (frag) gridEl.appendChild(frag);
  }

  // 整盤重建（開新局、悔棋、換尺寸、讀檔後用）
  renderAll() {
    this.nodes = new Map();
    this.dying = [];
    if (typeof document === 'undefined' || !this.el || !this.el.tileLayer) return;
    this.el.tileLayer.innerHTML = '';
    for (let i = 0; i < this.grid.length; i++) {
      const tile = this.grid[i];
      if (tile) this.createTile(tile, i, false);
    }
  }

  // 建立一顆磚：外層 .tile 只負責位移，內層 .tile-face 只負責縮放。
  // JS 一律不得寫 element.style.transform，位置只透過 --col / --row 交給 CSS。
  createTile(tile, index, isNew) {
    if (typeof document === 'undefined' || !this.el || !this.el.tileLayer || !tile) return null;
    const el = document.createElement('div');
    el.className = 'tile';

    const face = document.createElement('div');
    face.className = 'tile-face';
    const glyph = document.createElement('span');
    glyph.className = 'tile-glyph';
    _appSetAttr(glyph, 'aria-hidden', 'true');
    const num = document.createElement('span');
    num.className = 'tile-num';
    face.appendChild(glyph);
    face.appendChild(num);
    el.appendChild(face);

    // 直接掛參考，之後更新不必再 querySelector（假 DOM 也能跑）
    el._glyphEl = glyph;
    el._numEl = num;

    // .is-new / .is-merged 由 animationend 收掉；
    // 這裡只綁一次，之後這顆磚重複彈跳都共用同一個監聽器。
    if (typeof el.addEventListener === 'function') {
      el.addEventListener('animationend', (event) => {
        const name = event && event.animationName;
        if (!el.classList) return;
        if (name === 'tileSpawn') el.classList.remove('is-new');
        else if (name === 'tilePop') el.classList.remove('is-merged');
        else {
          el.classList.remove('is-new');
          el.classList.remove('is-merged');
        }
      });
    }

    // 敲碎模式要從 DOM 反查是哪一顆磚；id 直接掛在節點上，不必去 grid 裡比對面值
    el._tileId = tile.id;

    // 冰塊走另一條上色路徑：它沒有面值，也沒有生成彈跳（它是關卡地形，不是新磚）
    if (isIce(tile)) {
      this.paintIce(el, index);
    } else {
      this.paintTile(el, tile.value, index);
      if (isNew && el.classList) el.classList.add('is-new');
    }
    this.el.tileLayer.appendChild(el);
    this.nodes.set(tile.id, el);
    return el;
  }

  // 🧊 冰塊：標成 data-ice 交給 CSS（配色、雪花與 not-allowed 游標全在樣式表），
  // data-value 也寫成 'ice' —— 數字配色表只認 2~2048，用哨兵字串就不會誤命中。
  paintIce(el, index) {
    if (!el) return;
    _appSetAttr(el, 'data-ice', 'true');
    _appSetAttr(el, 'data-value', 'ice');
    _appSetAttr(el, 'data-level', 'ice');
    _appSetAttr(el, 'aria-label', _appIceLabel(index, this.size));
    if (el._numEl) el._numEl.textContent = '';
    if (el._glyphEl) el._glyphEl.textContent = '🧊';
    this.placeTile(el, index);
  }

  // 更新一顆磚的面值與位置（數字、圖示、配色、可及性標籤一次到位）
  paintTile(el, value, index) {
    if (!el) return;
    const n = this.size;
    _appSetAttr(el, 'data-value', String(value));
    _appSetAttr(el, 'data-level', String(levelOf(value)));
    _appSetAttr(el, 'aria-label', _appTileLabel(value, index, n));
    if (el._numEl) el._numEl.textContent = String(value);
    if (el._glyphEl) el._glyphEl.textContent = _appGlyphFor(value);
    this.placeTile(el, index);
  }

  // 只搬位置，不動面值：t=0 的 moves 走這條
  placeTile(el, index) {
    if (!el) return;
    const n = this.size;
    if (el.style && typeof el.style.setProperty === 'function') {
      el.style.setProperty('--col', String(_appColOf(index, n)));
      el.style.setProperty('--row', String(_appRowOf(index, n)));
    }
    // aria-label 的數字沿用目前顯示的面值（合併後的新數字要等 commit 才換）。
    // 冰塊的 data-value 是哨兵字串 'ice'，套進數字模板會唸成「ice，第 1 列」，
    // 所以它的標籤由 paintIce 自己包辦，這裡一律跳過。
    const shown = (typeof el.getAttribute === 'function') ? el.getAttribute('data-value') : null;
    if (shown !== null && shown !== undefined && shown !== 'ice') {
      _appSetAttr(el, 'aria-label', _appTileLabel(shown, index, n));
    }
  }

  setLocked(on) {
    const layer = this.el && this.el.tileLayer;
    if (layer && layer.classList) layer.classList.toggle('is-locked', !!on);
  }

  // ------------------------------------------------------------------------
  // 移動：邏輯時間軸（t=0 立刻更新模型）與視覺時間軸（t=SLIDE_MS 才換數字）分開
  // ------------------------------------------------------------------------
  applyMove(dir) {
    if (!Number.isInteger(dir) || dir < 0 || dir >= DIR_NAMES.length) return false;
    if (this.isInputBlocked()) return false;
    // 敲碎模式下滑動一律不生效：這時候整個盤面都是「可點擊的目標」，
    // 手指在磚上滑一下就推一步的話，玩家會分不清自己到底在敲還是在走。
    if (this.smashing) {
      this.showToast('🔨 敲碎模式中：點一顆磚敲掉它，或再按一次 🔨 取消');
      return false;
    }

    // 上一回合若還有未 commit 的，先強制執行完 —— 連續快速滑動要「快轉」而不是鎖住
    this.flushPending();

    const plan = computeMove(this.grid, this.size, dir);
    if (!plan || !plan.changed) {
      this.bumpWall();
      return false;
    }

    // 悔棋快照要在模型更新前拍（還有次數的模式才拍；閃電模式 undoLimit() 為 0，天然不拍）
    if (this.undosUsed < this.undoLimit()) this.pushUndo();

    // 里程碑要比對「移動前 vs 移動後」的最大磚，所以必須在模型更新前先拍下來
    const beforeMax = maxTile(this.grid);

    // ---- 模型：邏輯真相立刻更新（value 已經是加倍後的值）----
    this.grid = plan.next;
    this.score += plan.gained;
    this.moveCount += 1;
    this.mergesThisGame += plan.mergeCount;
    if (plan.mergeCount > this.bestChainThisGame) this.bestChainThisGame = plan.mergeCount;

    // 爬塔：這一步算進本層步數，合併同時換成金幣（合出 2^n 給 n-1 枚）
    this.grantTowerStep(plan);

    // ---- DOM：所有 moves 寫 --col / --row，transition 接管 ----
    const moves = Array.isArray(plan.moves) ? plan.moves : [];
    for (let i = 0; i < moves.length; i++) {
      const mv = moves[i];
      const node = this.nodes.get(mv.id);
      if (!node) continue;
      this.placeTile(node, mv.to);
      if (!mv.dying) continue;
      // 被合併掉的那顆：邏輯上立刻不存在，DOM 移除延到 commit
      if (node.classList) node.classList.add('is-dying');
      _appSetAttr(node, 'aria-hidden', 'true');
      this.nodes.delete(mv.id);
      this.dying.push(node);
    }

    // ---- 新磚：現在就決定位置並放進 grid，DOM 延到 commit 才生 ----
    const cfg = this.sizeConfig();
    let spawn = null;
    const spawned = spawnTile(this.grid, this.size, this.nextId, cfg.spawn4Rate, this.rng);
    if (spawned) {
      this.nextId = spawned.nextId;
      // ✨ 種子磚：這一次生成改成「目前最大磚 ÷ 4」。
      // 直接改剛生出來的那顆的 value —— 它是 spawnTile 現做的新物件，
      // 也已經在 this.grid 裡了，改它不會污染到任何別的盤面。
      this.consumeSeed(spawned.tile);
      spawn = { index: spawned.index, tile: spawned.tile };
    }

    // 閃電模式：合併就加時，連鎖另外給獎勵
    const bonusMs = this.grantBlitzTime(plan);

    this.pending = {
      merges: Array.isArray(plan.merges) ? plan.merges : [],
      spawn,
      beforeMax,
      gained: plan.gained,
      mergeCount: plan.mergeCount,
      maxMerged: plan.maxMerged,
      bonusMs
    };
    this.setLocked(true);
    this.playMoveSound(plan);

    if (typeof setTimeout === 'function') {
      // 單一 commit 時點。不用 per-node transitionend：它在被中斷、display:none、
      // 背景分頁時都可能不觸發，25 個節點等於 25 個潛在洩漏點。
      this.commitTimer = setTimeout(() => this.commit(), SLIDE_MS);
    } else {
      this.commit();
    }
    return true;
  }

  // 強制把還沒到期的 commit 提前執行完（連續快速滑動的關鍵）
  flushPending() {
    if (this.commitTimer !== null && this.commitTimer !== undefined) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
    if (this.pending) this.commit();
  }

  commit() {
    if (this.commitTimer !== null && this.commitTimer !== undefined) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;

    // 1) 被合併掉的節點真正移除
    for (let i = 0; i < this.dying.length; i++) {
      const node = this.dying[i];
      if (node && typeof node.remove === 'function') node.remove();
    }
    this.dying = [];

    // 2) 存活者此刻才換成新數字並彈一下 ——
    //    t=0 就換的話，畫面會變成「一個 4 停在那裡、另一個 2 慢慢滑過來撞它」。
    for (let i = 0; i < pending.merges.length; i++) {
      const mg = pending.merges[i];
      const node = this.nodes.get(mg.keepId);
      if (!node) continue;
      this.paintTile(node, mg.value, mg.to);
      _appRetrigger(node, 'is-merged');
    }

    // 3) 新磚現在才生 DOM
    if (pending.spawn) this.createTile(pending.spawn.tile, pending.spawn.index, true);

    this.setLocked(false);
    this.showGain(pending.gained);
    this.showChain(pending.mergeCount, pending.bonusMs);
    this.refreshHud();
    this.saveGameState();
    const celebrated = this.checkMilestone(pending.beforeMax);
    this.checkAchievements(celebrated);
    this.checkGameOver();
  }

  playMoveSound(plan) {
    if (!this.sound) return;
    if (plan.mergeCount > 0) this.sound.playMerge(levelOf(plan.maxMerged));
    else this.sound.playSlide();
  }

  // 撞牆微震：不消耗回合，只給一點觸覺回饋
  bumpWall() {
    if (this.sound) this.sound.playWall();
    const frame = this.el && this.el.boardFrame;
    if (!frame || !frame.classList) return;
    if (this.shakeTimer !== null && this.shakeTimer !== undefined) {
      clearTimeout(this.shakeTimer);
      this.shakeTimer = null;
    }
    _appRetrigger(frame, 'is-shaking');
    const clear = () => {
      if (frame.classList) frame.classList.remove('is-shaking');
      if (this.shakeTimer !== null && this.shakeTimer !== undefined) {
        clearTimeout(this.shakeTimer);
        this.shakeTimer = null;
      }
    };
    if (typeof frame.addEventListener === 'function') {
      frame.addEventListener('animationend', clear, { once: true });
    }
    // 背景分頁不會觸發 animationend，一定要補一道保險
    if (typeof setTimeout === 'function') this.shakeTimer = setTimeout(clear, SHAKE_MS);
  }

  // ------------------------------------------------------------------------
  // 悔棋（只存 1 份快照：3 次悔棋 = 可以用 3 次單步回退，不是可以連退 3 步）
  // ------------------------------------------------------------------------
  pushUndo() {
    const tower = this.towerState();
    this.undoSnapshot = {
      values: gridToValues(this.grid),
      score: this.score,
      moveCount: this.moveCount,
      nextId: this.nextId,
      // 爬塔另外記步數與金幣：退回盤面卻沒退回這兩個數字的話，
      // 玩家就能用「走一步 → 悔棋」無限刷金幣、又不花步數。
      towerSteps: tower.steps,
      towerGold: tower.gold
    };
  }

  // 本局的悔棋上限：經典 UNDO_LIMIT 固定 3 次；爬塔是「基礎 1 次 ＋ 買到的悔棋券」，
  // 與經典分開算；閃電模式一律 0（不提供悔棋）。
  undoLimit() {
    if (this.mode === MODES.CLASSIC) return UNDO_LIMIT;
    if (this.mode === MODES.TOWER) return TOWER_UNDO_BASE + this.towerItemCount('undo');
    return 0;
  }

  undo() {
    const limit = this.undoLimit();
    if (limit <= 0) {
      this.showToast('⚡ 加時閃電模式不提供悔棋唷');
      return false;
    }
    if (this.gameOver) {
      this.showToast('這局已經結束，按「🔄 重開」再來一場吧');
      return false;
    }
    this.flushPending();
    if (this.undosUsed >= limit) {
      this.showToast(this.mode === MODES.TOWER
        ? `這局的悔棋已經用完（目前上限 ${limit} 次，層間商店可以補）`
        : `這局的悔棋已經用完（上限 ${limit} 次）`);
      return false;
    }
    const snap = this.undoSnapshot;
    if (!snap) {
      this.showToast('先走一步才能悔棋唷');
      return false;
    }

    // 磚塊會整批重建，所以 id 一律往前配發新的。
    // nextId 永不回收：拿存檔裡的值與目前值取大者當起點，跨 session 也不會撞號。
    // （冰塊的 id 由格號推導、不吃 nextId，所以重建後冰塊一定回到同一個身分。）
    const startId = Math.max(this.nextId, Number.isInteger(snap.nextId) ? snap.nextId : 1);
    const rebuilt = gridFromValues(snap.values, startId);
    this.grid = rebuilt.grid;
    this.nextId = rebuilt.nextId;
    this.score = snap.score;
    this.moveCount = snap.moveCount;
    if (this.mode === MODES.TOWER) {
      const tower = this.towerState();
      if (Number.isInteger(snap.towerSteps)) tower.steps = Math.max(0, snap.towerSteps);
      if (Number.isInteger(snap.towerGold)) tower.gold = Math.max(0, snap.towerGold);
    }
    this.undosUsed += 1;
    this.undoSnapshot = null;   // 必須先走一步才能再悔

    this.setSmashing(false);
    this.renderAll();
    this.refreshHud();
    this.saveGameState();
    this.showToast(`↩️ 已悔棋（本局第 ${this.undosUsed} 次，剩 ${limit - this.undosUsed} 次）`);
    return true;
  }

  // ------------------------------------------------------------------------
  // 閃電模式倒數
  // ------------------------------------------------------------------------
  startBlitzTimer() {
    this.stopBlitzTimer();
    if (this.mode !== MODES.BLITZ) return;
    this.blitzTickAt = _appNow();
    if (typeof setInterval !== 'function') return;
    this.blitzTimer = setInterval(() => this.tickBlitz(), BLITZ_TICK_MS);
  }

  stopBlitzTimer() {
    if (this.blitzTimer !== null && this.blitzTimer !== undefined) {
      clearInterval(this.blitzTimer);
      this.blitzTimer = null;
    }
  }

  tickBlitz() {
    if (this.mode !== MODES.BLITZ || this.gameOver) {
      this.stopBlitzTimer();
      return;
    }
    const now = _appNow();
    const delta = Math.max(0, now - this.blitzTickAt);
    this.blitzTickAt = now;
    // 切到背景時不扣時間，回來才繼續（在背景被時間吃光太不講理）
    if (typeof document !== 'undefined' && document.hidden) return;
    this.blitzLeftMs = Math.max(0, this.blitzLeftMs - delta);
    this.refreshBlitzHud();
    if (this.blitzLeftMs <= 0) this.endGame('timeup');
  }

  // 合出 2^n 磚 → +(n-1) * perLevelMs；同一步合併達 chainThreshold 組再加 chainBonusMs
  grantBlitzTime(plan) {
    if (this.mode !== MODES.BLITZ) return 0;
    const merges = Array.isArray(plan.merges) ? plan.merges : [];
    let add = 0;
    for (let i = 0; i < merges.length; i++) {
      const level = levelOf(merges[i].value);
      if (level > 1) add += (level - 1) * BLITZ_CONFIG.perLevelMs;
    }
    if (plan.mergeCount >= BLITZ_CONFIG.chainThreshold) add += BLITZ_CONFIG.chainBonusMs;
    if (add <= 0) return 0;
    this.blitzLeftMs = Math.min(BLITZ_CONFIG.maxMs, this.blitzLeftMs + add);
    if (this.sound) this.sound.playBonus();
    return add;
  }

  // ------------------------------------------------------------------------
  // HUD
  // ------------------------------------------------------------------------
  sizeConfig() {
    return _appSizeCfg(this.size);
  }

  // 本局目標：經典模式看尺寸，閃電模式固定沿用 4×4 的 2048 當軟目標，
  // 爬塔則是「這一層」的目標磚（每過一層就往上跳一階）。
  currentTarget() {
    if (this.mode === MODES.BLITZ) return _appSizeCfg(BLITZ_CONFIG.size).target;
    if (this.mode === MODES.TOWER) {
      const cfg = this.towerFloorConfig();
      return cfg ? cfg.target : TOWER_FLOORS[TOWER_FLOORS.length - 1].target;
    }
    return this.sizeConfig().target;
  }

  // 爬塔沒有里程碑：它自己的樓層就是一階一階的階段目標，
  // 再疊一層里程碑只會讓 HUD 同時出現兩個「下一個目標」互相打架。
  currentMilestone() {
    if (this.mode === MODES.TOWER) return 0;
    if (this.mode === MODES.BLITZ) return _appSizeCfg(BLITZ_CONFIG.size).milestone;
    return this.sizeConfig().milestone;
  }

  // 里程碑是否已經達成。不存進存檔，直接從盤面推導 ——
  // 與 won 旗標同一套做法，少一個欄位就少一條存檔驗證規則。
  milestoneReached() {
    return maxTile(this.grid) >= this.currentMilestone();
  }

  // HUD 目標欄要顯示的「下一個目標」：還沒過里程碑就先顯示里程碑。
  currentGoal() {
    const milestone = this.currentMilestone();
    if (milestone > 0 && !this.milestoneReached()) {
      return { value: milestone, isMilestone: true };
    }
    return { value: this.currentTarget(), isMilestone: false };
  }

  refreshHud() {
    if (!this.el) return;
    _appSetText(this.el.scoreEl, String(this.score));
    // 沒用過悔棋時，分數超過紀錄就即時顯示成新的最佳
    const liveBest = (this.undosUsed === 0) ? Math.max(this.best, this.score) : this.best;
    _appSetText(this.el.bestEl, String(liveBest));
    const goal = this.currentGoal();
    _appSetText(this.el.targetEl, String(goal.value));
    _appSetText(this.el.goalLabel, goal.isMilestone ? '里程碑' : '目標');
    _appSetAttr(this.el.targetEl, 'title', goal.isMilestone
      ? `階段目標 ${goal.value}，最終目標 ${this.currentTarget()}`
      : `本局目標 ${goal.value}`);
    _appSetAttr(this.el.titleBadge, 'title', `本局目標 ${this.currentTarget()}`);
    this.refreshUndoUi();
    this.refreshBlitzHud();
    this.refreshTowerHud();
  }

  refreshUndoUi() {
    if (!this.el) return;
    const limit = this.undoLimit();
    const left = Math.max(0, limit - this.undosUsed);
    _appSetText(this.el.undoBadge, String(left));
    const btn = this.el.undoBtn;
    if (!btn) return;
    const usable = left > 0 && !!this.undoSnapshot && !this.gameOver;
    if (typeof btn.disabled === 'boolean' || btn.disabled === undefined) btn.disabled = !usable;
    _appSetAttr(btn, 'aria-disabled', usable ? 'false' : 'true');
  }

  refreshBlitzHud() {
    if (!this.el) return;
    const blitz = this.mode === MODES.BLITZ;
    if (this.el.blitzBar) this.el.blitzBar.hidden = !blitz;
    if (!blitz) return;
    _appSetText(this.el.blitzTime, _appFormatMs(this.blitzLeftMs));
    const pct = _appClamp((this.blitzLeftMs / BLITZ_CONFIG.maxMs) * 100, 0, 100);
    const fill = this.el.blitzFill;
    if (fill && fill.style) {
      fill.style.width = pct.toFixed(1) + '%';
    }
    // 剩餘時間低於 20% 時整條轉紅並脈動（樣式在 2048.css 的 .blitz-bar.is-low）
    const bar = this.el.blitzBar;
    if (bar && bar.classList && typeof bar.classList.toggle === 'function') {
      bar.classList.toggle('is-low', pct < BLITZ_LOW_PCT);
    }
  }

  // 爬塔 HUD：樓層徽章、步數、金幣、復活權（契約第 3 節的四格）
  refreshTowerHud() {
    if (!this.el) return;
    const tower = this.mode === MODES.TOWER;
    if (this.el.towerBar) this.el.towerBar.hidden = !tower;
    this.refreshSmashUi();
    if (!tower) return;

    const state = this.towerState();
    const cfg = this.towerFloorConfig() || TOWER_FLOORS[0];
    _appSetText(this.el.floorBadge, `🏔️ ${cfg.name}`);
    _appSetAttr(this.el.floorBadge, 'title', `${cfg.name}：合出 ${cfg.target} 就過關`);

    const used = _appClamp(state.steps, 0, cfg.maxSteps);
    _appSetText(this.el.stepCounter, `步數 ${used} / ${cfg.maxSteps}`);
    _appSetAttr(this.el.stepCounter, 'title', `本層還剩 ${cfg.maxSteps - used} 步`);
    // 剩餘步數低於 20% 就轉紅（比照閃電模式的時間警示）
    const leftPct = cfg.maxSteps > 0 ? ((cfg.maxSteps - used) / cfg.maxSteps) * 100 : 0;
    const stepEl = this.el.stepCounter;
    if (stepEl && stepEl.classList && typeof stepEl.classList.toggle === 'function') {
      stepEl.classList.toggle('is-low', leftPct < TOWER_LOW_PCT);
    }

    _appSetText(this.el.goldCounter, `🪙 ${state.gold}`);
    _appSetAttr(this.el.goldCounter, 'title', `目前持有 ${state.gold} 金幣`);

    const revives = this.towerItemCount('revive');
    const reviveEl = this.el.reviveCounter;
    if (reviveEl) {
      reviveEl.hidden = !(revives > 0);
      _appSetText(reviveEl, `❤️ ×${revives}`);
      _appSetAttr(reviveEl, 'title', `步數用完時自動續 ${REVIVE_STEPS} 步，目前持有 ${revives} 張`);
    }
  }

  // 🔨 敲碎鍵：只在爬塔模式露臉，徽章顯示剩餘次數，沒有道具就 disabled
  refreshSmashUi() {
    const btn = this.el && this.el.smashBtn;
    const tower = this.mode === MODES.TOWER;
    if (this.el && this.el.smashBadge) _appSetText(this.el.smashBadge, String(this.towerItemCount('smash')));
    if (!btn) return;
    // .action-btn 自帶 display:flex，壓得過 [hidden]，所以用 display 開關才可靠
    if (btn.style) btn.style.display = tower ? 'flex' : 'none';
    const left = this.towerItemCount('smash');
    const usable = tower && left > 0 && !this.gameOver;
    if (typeof btn.disabled === 'boolean' || btn.disabled === undefined) btn.disabled = !usable;
    _appSetAttr(btn, 'aria-disabled', usable ? 'false' : 'true');
    _appSetAttr(btn, 'title', left > 0
      ? `敲碎：點掉盤面上任意 1 顆磚（含冰塊），不消耗步數。剩 ${left} 次`
      : '敲碎：目前沒有道具，層間商店可以買');
  }

  // 得分浮動字：+16。靠 hidden 開關重播動畫，不需要額外的 class。
  showGain(amount) {
    const el = this.el && this.el.gainFloat;
    if (!el) return;
    if (!(amount > 0)) {
      el.hidden = true;
      return;
    }
    _appSetText(el, '+' + amount);
    if (this.gainTimer !== null && this.gainTimer !== undefined) {
      clearTimeout(this.gainTimer);
      this.gainTimer = null;
    }
    _appRestartHidden(el);
    if (typeof setTimeout !== 'function') return;
    this.gainTimer = setTimeout(() => {
      this.gainTimer = null;
      el.hidden = true;
    }, GAIN_FLOAT_MS);
  }

  // 連鎖徽章：只有閃電模式達到門檻才亮
  showChain(mergeCount, bonusMs) {
    const el = this.el && this.el.chainBadge;
    if (!el) return;
    if (this.mode !== MODES.BLITZ || !(mergeCount >= BLITZ_CONFIG.chainThreshold)) {
      el.hidden = true;
      return;
    }
    const secs = (bonusMs / 1000).toFixed(1);
    _appSetText(el, `⚡ ${mergeCount} 連鎖 +${secs} 秒`);
    if (this.chainTimer !== null && this.chainTimer !== undefined) {
      clearTimeout(this.chainTimer);
      this.chainTimer = null;
    }
    _appRestartHidden(el);
    if (typeof setTimeout !== 'function') return;
    this.chainTimer = setTimeout(() => {
      this.chainTimer = null;
      el.hidden = true;
    }, CHAIN_BADGE_MS);
  }

  // ------------------------------------------------------------------------
  // 控制項狀態（選取狀態一律同步 aria-pressed / aria-selected，不能只切 CSS class）
  // ------------------------------------------------------------------------
  syncControlState() {
    if (!this.el) return;

    _appSetBodyAttr('data-mode', this.mode);
    _appSetRootAttr('data-skin', this.skin);
    if (this.glyphOnly) _appSetBodyAttr('data-glyph-only', 'true');
    else _appSetBodyAttr('data-glyph-only', null);

    if (this.el.modeTabBtns && this.el.modeTabBtns.forEach) {
      this.el.modeTabBtns.forEach((btn) => {
        const on = !!(btn.dataset && btn.dataset.mode === this.mode);
        if (btn.classList) btn.classList.toggle('active', on);
        _appSetAttr(btn, 'aria-selected', on ? 'true' : 'false');
        if (typeof btn.tabIndex !== 'undefined') btn.tabIndex = on ? 0 : -1;
      });
    }
    if (this.el.sizeBtns && this.el.sizeBtns.forEach) {
      this.el.sizeBtns.forEach((btn) => {
        const on = !!(btn.dataset && parseInt(btn.dataset.size, 10) === this.size);
        if (btn.classList) btn.classList.toggle('active', on);
        _appSetAttr(btn, 'aria-pressed', on ? 'true' : 'false');
      });
    }

    const skinOn = this.skin === SKINS.EVOLVE;
    if (this.el.skinBtn) {
      _appSetAttr(this.el.skinBtn, 'aria-pressed', skinOn ? 'true' : 'false');
      _appSetAttr(this.el.skinBtn, 'title', skinOn ? '皮膚：進化（點一下換回數字）' : '皮膚：數字（點一下換成進化）');
      if (this.el.skinBtn.classList) this.el.skinBtn.classList.toggle('active', skinOn);
    }
    if (this.el.glyphBtn) {
      _appSetAttr(this.el.glyphBtn, 'aria-pressed', this.glyphOnly ? 'true' : 'false');
      _appSetAttr(this.el.glyphBtn, 'title', this.glyphOnly ? '純圖示模式：開啟' : '純圖示模式：關閉');
    }
    this.updateSoundIcon();
    this.updateThemeIcon(this.currentTheme());
    this.refreshUndoUi();
    this.refreshTowerHud();
  }

  updateSoundIcon() {
    const btn = this.el && this.el.soundBtn;
    if (!btn) return;
    const on = !!(this.sound && this.sound.enabled);
    btn.innerHTML = on ? '<span>🔊</span>' : '<span>🔇</span>';
    _appSetAttr(btn, 'aria-pressed', on ? 'true' : 'false');
    _appSetAttr(btn, 'title', on ? '音效開關（目前開啟）' : '音效開關（目前靜音）');
    if (btn.classList) btn.classList.toggle('active', on);
  }

  toggleSkin() {
    this.skin = this.skin === SKINS.EVOLVE ? SKINS.NUMBER : SKINS.EVOLVE;
    this.syncControlState();
    this.savePreferences();
    this.showToast(this.skin === SKINS.EVOLVE ? '🧬 已換成進化皮膚' : '🔢 已換回數字皮膚');
  }

  toggleGlyphOnly() {
    this.glyphOnly = !this.glyphOnly;
    this.syncControlState();
    this.savePreferences();
    this.showToast(this.glyphOnly ? '🎭 純圖示模式開啟（只看圖示）' : '🔢 已顯示數字');
  }

  setMode(mode) {
    if (!_appHasMode(mode) || mode === this.mode) return false;
    this.mode = mode;
    this.size = _appModeSize(mode, this.size);
    this.statsSize = this.size;
    this.savePreferences();
    this.startNewGame({ silent: true });
    let hint = '🎯 經典無盡：慢慢想，還有 3 次悔棋';
    if (mode === MODES.BLITZ) hint = '⚡ 加時閃電：合併就加時，時間就是資源';
    else if (mode === MODES.TOWER) hint = `🏔️ 爬塔：五層、過關不清盤，先在 ${TOWER_FLOORS[0].name} 合出 ${TOWER_FLOORS[0].target}`;
    this.showToast(hint);
    return true;
  }

  setSize(size) {
    if (this.mode === MODES.TOWER) {
      this.showToast('🏔️ 爬塔固定 4×4 唷');
      return false;
    }
    if (this.mode === MODES.BLITZ) {
      this.showToast('⚡ 加時閃電固定 4×4 唷');
      return false;
    }
    if (!_appHasSize(size) || size === this.size) return false;
    this.size = size;
    this.statsSize = size;
    this.savePreferences();
    this.startNewGame({ silent: true });
    const cfg = this.sizeConfig();
    this.showToast(`${cfg.label}：${cfg.hint}`);
    return true;
  }

  // ------------------------------------------------------------------------
  // 開新局 / 結束局
  // ------------------------------------------------------------------------
  startNewGame(options) {
    const opts = options || {};
    this.cancelPending();
    this.stopBlitzTimer();
    this.clearGameState();

    this.size = _appModeSize(this.mode, this.size);
    const cfg = this.sizeConfig();
    this.grid = createInitialGrid(this.size);
    this.nextId = 1;
    this.score = 0;
    this.moveCount = 0;
    this.undosUsed = 0;
    this.hintsUsed = 0;
    this.undoSnapshot = null;
    this.continued = false;
    this.won = false;
    this.gameOver = false;
    this.startedAt = Date.now();
    this.blitzLeftMs = BLITZ_CONFIG.startMs;
    this.mergesThisGame = 0;
    this.bestChainThisGame = 0;
    this.tower = _appEmptyTower();
    this.setSmashing(false);
    this.best = this.bestScoreOfCurrentBucket();

    // 爬塔從 1F 起步：先灑冰塊再放起手磚，順序反過來的話
    // 起手磚會先佔掉非角落的格子，冰塊的落點就被擠成只剩角落旁邊那幾格。
    if (this.mode === MODES.TOWER) {
      this.setupTowerFloor(TOWER_FLOORS[0], true);
    } else {
      for (let i = 0; i < cfg.startTiles; i++) {
        const spawned = spawnTile(this.grid, this.size, this.nextId, cfg.spawn4Rate, this.rng);
        if (!spawned) break;
        this.nextId = spawned.nextId;
      }
    }

    this.renderBoardShell();
    this.renderAll();
    this.syncControlState();
    this.refreshHud();
    this.hideOverlay();
    if (this.mode === MODES.BLITZ) this.startBlitzTimer();
    this.saveGameState();
    if (!opts.silent) this.showToast('🆕 新的一局開始囉');
    return true;
  }

  cancelPending() {
    if (this.commitTimer !== null && this.commitTimer !== undefined) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
    this.pending = null;
    this.dying = [];
    this.setLocked(false);
  }

  requestRestart() {
    if (this.moveCount === 0 && !this.gameOver) {
      this.startNewGame();
      return;
    }
    this.openConfirm(
      '要重新開始嗎？',
      `目前分數 ${this.score}，重開後這局的進度就不見囉。`,
      () => this.startNewGame()
    );
  }

  // 第一次合出里程碑磚：慶祝一下並記進戰績。
  // 只在「本步之前還沒達成、本步之後達成了」時觸發，所以一局最多一次；
  // 重整續玩時因為 milestoneReached() 是從盤面推導的，也不會重複觸發。
  // 回傳「這一步剛達成的里程碑值」，沒達成回 0 ——
  // 讓成就那邊知道同一個數字已經慶祝過了，不要再跳一則重複的訊息。
  checkMilestone(beforeMax) {
    if (this.mode !== MODES.CLASSIC) return 0;
    const milestone = this.currentMilestone();
    if (!(milestone > 0)) return 0;
    if (beforeMax >= milestone) return 0;
    if (maxTile(this.grid) < milestone) return 0;

    const stats = this.loadStats();
    const bucket = stats.classic[this.bucketKey()];
    if (bucket) {
      bucket.milestoneHits = (bucket.milestoneHits || 0) + 1;
      this.saveStats(stats);
    }
    this.showToast(`🎯 里程碑達成：合出了 ${milestone}！下一站 ${this.currentTarget()}`);
    this.fireConfetti();
    return milestone;
  }

  checkGameOver() {
    if (this.gameOver) return;
    // 爬塔有自己的一整套判定（過關 → 獻祭 → 商店 / 步數用完 → 復活權），走另一條路
    if (this.mode === MODES.TOWER) {
      this.checkTowerProgress();
      return;
    }
    const target = this.currentTarget();
    // 達標先判：在滿盤的最後一步湊出目標磚是常見情況，順序反了就永遠不會慶祝
    if (this.mode === MODES.CLASSIC && !this.won && isWin(this.grid, target)) {
      this.won = true;
      this.recordTargetHit();
      this.showTargetModal(target);
      return;
    }
    if (isGameOver(this.grid, this.size)) this.endGame('over');
  }

  endGame(reason) {
    if (this.gameOver) return;
    this.gameOver = true;
    this.cancelPending();
    this.stopBlitzTimer();
    this.setSmashing(false);
    this.clearGameState();
    this.endGesture();

    // recordResult 回的是整包 { bucket, blitz, tower, reason }，
    // 攤平之後再交給結算彈窗 —— 整包塞進 bucket 欄位的話，
    // 彈窗讀到的 bucket.plays 會是 undefined（「累積 undefined 局」）。
    const result = this.recordResult(reason);
    this.best = this.bestScoreOfCurrentBucket();
    this.refreshHud();
    let overlay = '🏁 沒有可以移動的方向了';
    if (reason === 'timeup') overlay = '⏱️ 時間到！';
    else if (reason === 'steps') overlay = '🪜 步數用完了';
    else if (reason === 'towerclear') overlay = '👑 登頂成功！';
    this.showOverlay(overlay);
    if (this.sound) {
      if (reason === 'towerclear') this.sound.playFloorClear();
      else this.sound.playOver();
    }
    this.showResultModal({
      reason: reason,
      bucket: result.bucket,
      blitz: result.blitz,
      tower: result.tower
    });
  }

  // 達標後續玩：已經寫進戰績的達標紀錄絕不回頭取消 ——
  // 「續玩失敗就不算達標」會讓玩家永遠不敢按續玩，這個按鈕等於白做。
  continueGame() {
    this.closeModal(this.el ? this.el.resultModal : null);
    this.continued = true;
    this.hideOverlay();
    this.refreshHud();
    this.saveGameState();
    this.showToast('🚀 續玩開始！紀錄已經寫進去了，放手衝吧');
  }

  // ------------------------------------------------------------------------
  // 🏔️ 爬塔模式
  // ------------------------------------------------------------------------
  // 一層的生命週期：
  //   setupTowerFloor（灑冰塊、步數歸零）
  //     → 一直滑，每步 steps++、合併換金幣
  //     → 合出樓層目標磚 → clearTowerFloor（獻祭換金幣、拆冰塊、開商店）
  //     → goNextFloor（關掉商店就是踏上階梯）→ 回到 setupTowerFloor
  //   步數用完 → 有 ❤️ 就自動續 REVIVE_STEPS 步，沒有就結束
  //
  // 【過關不清盤】是這個模式的靈魂：clearTowerFloor 只消小磚、不重建盤面，
  // 目標磚與所有大磚原地留著被帶上樓。清盤會讓五層退化成五場獨立短局。
  // ------------------------------------------------------------------------

  // 爬塔狀態的唯一入口。測試會用 Object.create(prototype) 灌半套依賴進來，
  // 所以這裡順手補齊缺席的欄位，每個方法才能安心直接用。
  towerState() {
    if (!_appIsPlainObject(this.tower)) this.tower = _appEmptyTower();
    if (!_appIsPlainObject(this.tower.items)) this.tower.items = _appEmptyTowerItems();
    return this.tower;
  }

  // 目前這一層的設定；樓層被竄改成 7F 之類的值時回 null，呼叫端各自兜底
  towerFloorConfig() {
    return towerFloor(this.towerState().floor);
  }

  towerItemCount(id) {
    return _appItemCount(this.towerState().items, id);
  }

  // 一步的爬塔結算：步數 +1，合併換金幣（合出 2^n 給 n-1 枚）。
  // 【刻意用階級而不是面值】才會「養大磚遠比亂消划算」——
  // 合出 8 得 2 枚、合出 256 得 7 枚，鼓勵玩家把磚疊起來而不是見同值就消。
  grantTowerStep(plan) {
    if (this.mode !== MODES.TOWER) return 0;
    const state = this.towerState();
    state.steps += 1;
    const merges = Array.isArray(plan && plan.merges) ? plan.merges : [];
    let gold = 0;
    for (let i = 0; i < merges.length; i++) {
      const level = levelOf(merges[i].value);
      if (level > 1) gold += level - 1;
    }
    if (gold > 0) state.gold += gold;
    return gold;
  }

  // ✨ 種子磚：把剛生出來的那顆改成「目前最大磚 ÷ 4」，一次性。
  // 最大磚不到 8 時 ÷4 會掉到 2 以下，統一夾回 2（一顆合法的最小磚）。
  consumeSeed(tile) {
    if (this.mode !== MODES.TOWER || !tile) return false;
    const state = this.towerState();
    if (!state.seedPending) return false;
    state.seedPending = false;
    const seeded = Math.floor(maxTile(this.grid) / 4);
    tile.value = seeded >= 2 ? seeded : 2;
    return true;
  }

  // 一層的模型初始化（不碰 DOM）。fresh 代表這是全新的一局：盤面清空並補起手磚；
  // 換層時 fresh 為 false —— 盤面要原封不動地帶上樓。
  setupTowerFloor(cfg, fresh) {
    const floor = cfg || TOWER_FLOORS[0];
    const state = this.towerState();
    state.floor = floor.floor;
    state.steps = 0;
    // 換層之後不得再退回上一層：那份快照裡還有已經被獻祭掉的小磚與拆掉的冰塊
    this.undoSnapshot = null;
    if (fresh) this.grid = createInitialGrid(this.size);
    // 上一層的冰塊不會跟著上樓。正常流程裡 clearTowerFloor 已經拆過了，
    // 這裡再拆一次當保險 —— 少拆一次就會出現「樓層設定 1 顆、盤面卻有 2 顆」。
    else this.removeTowerIce();

    // 🧊 融冰：本次少放幾顆，用掉就歸零（買了卻遇到無冰樓層也一樣消耗掉）
    const want = Math.max(0, floor.ice - Math.max(0, _appNum(state.meltNext)));
    state.meltNext = 0;
    // placeIce 會 mutate grid（與 spawnTile 同一個例外），避開角落與已有磚的格子
    const placed = (want > 0) ? placeIce(this.grid, this.size, want, this.rng) : [];

    if (fresh) {
      const sizeCfg = this.sizeConfig();
      for (let i = 0; i < sizeCfg.startTiles; i++) {
        const spawned = spawnTile(this.grid, this.size, this.nextId, sizeCfg.spawn4Rate, this.rng);
        if (!spawned) break;
        this.nextId = spawned.nextId;
      }
    }
    return { floor: floor, ice: placed.length };
  }

  // 踏進新的一層：模型 + 畫面 + 存檔一次到位
  startTowerFloor(cfg) {
    const result = this.setupTowerFloor(cfg, false);
    const floor = result.floor;
    this.setSmashing(false);
    this.renderAll();
    this.refreshHud();
    this.saveGameState();
    const iceText = result.ice > 0 ? `、${result.ice} 顆冰塊` : '';
    this.showToast(`🏔️ ${floor.name}：目標 ${floor.target}、${floor.maxSteps} 步${iceText}`);
    // 極端情況下換層瞬間就走不動了（盤面塞滿又剛好灑了冰塊），要立刻收局
    if (isGameOver(this.grid, this.size)) this.endGame('over');
    return true;
  }

  // 拆掉盤面上所有冰塊（過關結算的第 4 步）。回傳拆掉幾顆。
  removeTowerIce() {
    let removed = 0;
    for (let i = 0; i < this.grid.length; i++) {
      const tile = this.grid[i];
      if (!isIce(tile)) continue;
      this.grid[i] = null;
      const node = this.nodes.get(tile.id);
      if (node) {
        this.nodes.delete(tile.id);
        if (typeof node.remove === 'function') node.remove();
      }
      removed += 1;
    }
    return removed;
  }

  // 每一步之後的爬塔判定。順序寫死：先看過關，再看步數，最後才看塞死 ——
  // 「用最後一步湊出目標磚」是爬塔最常見的畫面，順序反了就永遠不會過關。
  checkTowerProgress() {
    if (this.mode !== MODES.TOWER || this.gameOver) return false;
    const state = this.towerState();
    const cfg = this.towerFloorConfig();
    if (!cfg) return false;

    if (maxTile(this.grid) >= cfg.target) {
      this.clearTowerFloor(cfg);
      return true;
    }

    if (state.steps >= cfg.maxSteps) {
      if (this.towerItemCount('revive') > 0) {
        state.items.revive = this.towerItemCount('revive') - 1;
        // 「續 REVIVE_STEPS 步」＝ 把已用步數往回推到「剛好還剩 30 步」，
        // steps 因此永遠落在 [0, maxSteps]，HUD 的分母不必為了復活多開一個欄位。
        state.steps = Math.max(0, cfg.maxSteps - REVIVE_STEPS);
        if (this.sound) this.sound.playBonus();
        this.refreshHud();
        this.saveGameState();
        this.showToast(`❤️ 復活權啟動：續 ${REVIVE_STEPS} 步（還剩 ${this.towerItemCount('revive')} 張）`);
      } else {
        this.endGame('steps');
        return true;
      }
    }

    if (isGameOver(this.grid, this.size)) {
      this.endGame('over');
      return true;
    }
    return false;
  }

  // 過關結算（契約第 1 節的五個步驟）。【盤面不重置】。
  clearTowerFloor(cfg) {
    const state = this.towerState();
    const res = sacrificeTiles(this.grid, this.size, cfg.target);
    if (res && Array.isArray(res.grid)) this.grid = res.grid;
    const removed = (res && Array.isArray(res.removed)) ? res.removed.length : 0;
    const gold = (res && res.gold > 0) ? res.gold : 0;
    state.gold += gold;

    this.removeTowerIce();
    this.setSmashing(false);
    this.undoSnapshot = null;
    this.renderAll();
    this.recordFloorCleared(cfg);
    this.refreshHud();
    if (this.sound) this.sound.playFloorClear();
    this.fireConfetti();
    this.showToast(removed > 0
      ? `🏔️ ${cfg.name} 過關！獻祭 ${removed} 顆小磚換到 ${gold} 金幣`
      : `🏔️ ${cfg.name} 過關！盤面很乾淨，沒有小磚可以獻祭`);

    // 5F 合出 1024 就是全塔通關，沒有下一層也沒有商店
    if (!towerFloor(cfg.floor + 1)) {
      this.finishTower();
      return true;
    }
    this.saveGameState();
    this.openShop();
    return true;
  }

  // 通關
  finishTower() {
    this.won = true;
    this.fireConfetti();
    this.endGame('towerclear');
    return true;
  }

  // 關掉商店＝踏上階梯。商店的三個出口都走這裡，沒有「跳過」這個選項。
  goNextFloor() {
    if (this.el && this.el.shopModal) this.closeModal(this.el.shopModal);
    if (this.mode !== MODES.TOWER || this.gameOver) return false;
    const next = towerFloor(this.towerState().floor + 1);
    if (!next) {
      this.finishTower();
      return false;
    }
    return this.startTowerFloor(next);
  }

  // ---- 層間商店 -----------------------------------------------------------
  openShop() {
    const next = towerFloor(this.towerState().floor + 1);
    if (this.el && this.el.shopTitle) {
      _appSetText(this.el.shopTitle, next ? `🛖 通往 ${next.name} 的補給站` : '🛖 層間補給站');
    }
    this.renderShop();
    // 沒有商店彈窗可用時（測試的假 DOM）也不能把流程卡住，直接上樓
    if (!this.el || !this.el.shopModal) {
      this.goNextFloor();
      return false;
    }
    this.openModal(this.el.shopModal, this.el.shopNextBtn);
    return true;
  }

  // 商品卡片一律由 SHOP_ITEMS 生成，HTML 不得預先寫死 ——
  // 兩份商品清單遲早會各改各的，價格與效果對不上是最難查的那種 bug。
  renderShop() {
    const state = this.towerState();
    if (this.el && this.el.shopGold) _appSetText(this.el.shopGold, `🪙 ${state.gold} 金幣`);
    const box = this.el && this.el.shopItems;
    if (!box || typeof document === 'undefined' || typeof document.createElement !== 'function') return 0;
    box.innerHTML = '';

    let buyable = 0;
    for (let i = 0; i < SHOP_ITEMS.length; i++) {
      const item = SHOP_ITEMS[i];
      const owned = this.towerItemCount(item.id);
      const full = Number.isFinite(item.max) && owned >= item.max;
      const poor = state.gold < item.price;
      if (!full && !poor) buyable += 1;

      const card = document.createElement('div');
      card.className = 'shop-card';
      _appSetAttr(card, 'data-item', item.id);

      const icon = document.createElement('span');
      icon.className = 'icon';
      _appSetAttr(icon, 'aria-hidden', 'true');
      icon.textContent = item.icon;

      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = item.name;

      const desc = document.createElement('span');
      desc.className = 'desc';
      desc.textContent = item.desc;

      const price = document.createElement('span');
      price.className = 'price';
      price.textContent = `🪙 ${item.price} 金幣`;

      const btn = document.createElement('button');
      btn.className = 'shop-buy-btn';
      btn.type = 'button';
      if (btn.dataset) {
        btn.dataset.buy = item.id;
        btn.dataset.price = String(item.price);
      }
      let label = '購買';
      if (full) label = `已滿 ${owned}/${item.max}`;
      else if (poor) label = '金幣不足';
      else if (owned > 0) label = `再買一個（持有 ${owned}）`;
      btn.textContent = label;
      btn.disabled = full || poor;
      _appSetAttr(btn, 'aria-label', `購買${item.name}，${item.price} 金幣：${item.desc}`);
      if (typeof btn.addEventListener === 'function') {
        btn.addEventListener('click', () => this.buyShopItem(item.id));
      }

      card.appendChild(icon);
      card.appendChild(title);
      card.appendChild(desc);
      card.appendChild(price);
      card.appendChild(btn);
      box.appendChild(card);
    }
    return buyable;
  }

  buyShopItem(id) {
    if (this.mode !== MODES.TOWER) return false;
    const item = _appShopItem(id);
    if (!item) return false;
    const state = this.towerState();
    const owned = this.towerItemCount(item.id);
    if (Number.isFinite(item.max) && owned >= item.max) {
      this.showToast(`${item.icon} ${item.name} 已經到上限 ${item.max} 張了`);
      return false;
    }
    if (state.gold < item.price) {
      this.showToast(`🪙 金幣不夠：${item.name} 要 ${item.price}，目前只有 ${state.gold}`);
      return false;
    }
    state.gold -= item.price;
    state.items[item.id] = owned + 1;
    this.applyShopEffect(item);
    if (this.sound) this.sound.playBuy();
    this.renderShop();
    this.refreshHud();
    this.saveGameState();
    this.showToast(`${item.icon} 買到「${item.name}」：${item.desc}`);
    return true;
  }

  // 🎲 / ✨ / 🧊 買下就生效或進入待用狀態；🔨 / ↩️ / ❤️ 的持有數本身就是效果
  applyShopEffect(item) {
    const state = this.towerState();
    if (item.id === 'shuffle') {
      // 保留所有磚的數值與 id，只換位置；冰塊留在原位（shuffleTiles 保證）
      this.grid = shuffleTiles(this.grid, this.size, this.rng);
      this.renderAll();
    } else if (item.id === 'seed') {
      state.seedPending = true;
    } else if (item.id === 'melt') {
      state.meltNext = Math.max(0, _appNum(state.meltNext)) + 1;
    }
    return true;
  }

  // ---- 🔨 敲碎模式 --------------------------------------------------------
  // 進入時 #tile-layer 加 .is-smashing（樣式在 2048.css），點一顆磚就消耗一次並退出。
  // 【敲碎不消耗步數】：它是花 25 金幣買來的補救手段，不該再被收一次步數的稅。
  setSmashing(on) {
    const want = !!on
      && this.mode === MODES.TOWER
      && !this.gameOver
      && this.towerItemCount('smash') > 0;
    this.smashing = want;
    const layer = this.el && this.el.tileLayer;
    if (layer && layer.classList && typeof layer.classList.toggle === 'function') {
      layer.classList.toggle('is-smashing', want);
    }
    _appSetAttr(this.el && this.el.smashBtn, 'aria-pressed', want ? 'true' : 'false');
    return want;
  }

  toggleSmash() {
    if (this.mode !== MODES.TOWER) {
      this.showToast('🔨 敲碎是爬塔模式的道具唷');
      return false;
    }
    if (this.gameOver) return false;
    if (this.smashing) {
      this.setSmashing(false);
      this.showToast('🔨 已取消敲碎');
      return false;
    }
    if (this.towerItemCount('smash') <= 0) {
      this.showToast('🔨 目前沒有敲碎道具，層間商店可以買');
      return false;
    }
    // 還在飛的磚先落地，免得玩家點到一顆「畫面上還在、邏輯上已經沒了」的節點
    this.flushPending();
    this.setSmashing(true);
    this.showToast('🔨 敲碎模式：點一顆磚把它敲掉（含冰塊，不消耗步數）');
    return true;
  }

  // 事件委派：磚塊 DOM 每一步都在生生滅滅，id 直接掛在節點上最省事
  onBoardClick(event) {
    if (!this.smashing) return false;
    const target = event && event.target;
    const node = (target && typeof target.closest === 'function') ? target.closest('.tile') : null;
    if (!node) return false;
    const id = node._tileId;
    if (!Number.isInteger(id)) return false;
    return this.smashTile(id);
  }

  smashTile(id) {
    if (this.mode !== MODES.TOWER || this.gameOver) return false;
    if (this.towerItemCount('smash') <= 0) {
      this.setSmashing(false);
      return false;
    }
    this.flushPending();

    let index = -1;
    for (let i = 0; i < this.grid.length; i++) {
      const tile = this.grid[i];
      if (tile && tile.id === id) {
        index = i;
        break;
      }
    }
    if (index < 0) return false;

    const tile = this.grid[index];
    const ice = isIce(tile);
    // 【不准敲掉最後一顆磚】空盤面的 canMove 會因為「有空格」回 true，
    // 但四個方向都推不動任何東西，也永遠不會生新磚 —— 整局卡死又不判結束。
    if (!ice) {
      let others = 0;
      for (let i = 0; i < this.grid.length; i++) {
        const other = this.grid[i];
        if (other && !isIce(other) && i !== index) others += 1;
      }
      if (others === 0) {
        this.showToast('🔨 盤面只剩這一顆磚了，敲掉就沒得玩囉');
        return false;
      }
    }
    this.grid[index] = null;
    const node = this.nodes.get(id);
    if (node) {
      this.nodes.delete(id);
      if (typeof node.remove === 'function') node.remove();
    }
    const state = this.towerState();
    state.items.smash = Math.max(0, this.towerItemCount('smash') - 1);
    this.setSmashing(false);
    if (this.sound) this.sound.playSmash();
    this.refreshHud();
    this.saveGameState();
    this.showToast(ice ? '🔨 冰塊碎了！這格自由了' : `🔨 敲掉了一顆 ${tile.value}`);
    return true;
  }

  showOverlay(text) {
    const el = this.el && this.el.boardOverlay;
    if (!el) return;
    _appSetText(el, text);
    el.hidden = false;
  }

  hideOverlay() {
    const el = this.el && this.el.boardOverlay;
    if (!el) return;
    el.hidden = true;
    _appSetText(el, '');
  }

  isInputBlocked() {
    if (this.gameOver) return true;
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return false;
    return !!document.querySelector('.modal-overlay.open');
  }

  // ------------------------------------------------------------------------
  // 持久化：存快照，不存 replay（2048 有隨機生成，replay 需要 seeded RNG 且脆弱）
  // ------------------------------------------------------------------------
  serializeState() {
    const state = {
      v: 1,
      mode: this.mode,
      size: this.size,
      values: gridToValues(this.grid),
      nextId: this.nextId,
      score: this.score,
      moveCount: this.moveCount,
      undosUsed: this.undosUsed,
      hintsUsed: this.hintsUsed,
      continued: !!this.continued,
      blitzLeftMs: this.blitzLeftMs,
      startedAt: this.startedAt,
      undo: this.undoSnapshot ? {
        values: this.undoSnapshot.values.slice(),
        score: this.undoSnapshot.score,
        moveCount: this.undoSnapshot.moveCount,
        nextId: this.undoSnapshot.nextId,
        towerSteps: _appNum(this.undoSnapshot.towerSteps),
        towerGold: _appNum(this.undoSnapshot.towerGold)
      } : null
    };
    // tower 欄位只在爬塔模式有意義；經典／閃電的存檔不該多帶一包用不到的狀態，
    // 也免得日後有人拿經典存檔的 tower 欄位去推論樓層。
    if (this.mode === MODES.TOWER) {
      const tower = this.towerState();
      const items = {};
      for (let i = 0; i < TOWER_ITEM_IDS.length; i++) {
        items[TOWER_ITEM_IDS[i]] = this.towerItemCount(TOWER_ITEM_IDS[i]);
      }
      state.tower = {
        floor: tower.floor,
        steps: tower.steps,
        gold: tower.gold,
        items: items,
        seedPending: !!tower.seedPending,
        meltNext: _appNum(tower.meltNext)
      };
    }
    return state;
  }

  // 悔棋快照的格式驗證（長度、值域、整數）。
  // allowIce 由呼叫端依存檔的 mode 決定：只有爬塔的快照能出現 ICE_VALUE。
  validUndoSnapshot(snap, cells, allowIce) {
    if (snap === null || snap === undefined) return true;
    if (!_appIsPlainObject(snap)) return false;
    if (!Array.isArray(snap.values) || snap.values.length !== cells) return false;
    for (let i = 0; i < snap.values.length; i++) {
      if (!_appIsTileValue(snap.values[i], allowIce)) return false;
    }
    if (!Number.isFinite(snap.score) || snap.score < 0) return false;
    if (!Number.isInteger(snap.moveCount) || snap.moveCount < 0) return false;
    if (!Number.isInteger(snap.nextId) || snap.nextId < 1) return false;
    return true;
  }

  // 爬塔存檔那一包的格式驗證。任一欄位不合就整包丟棄（與其他欄位同一個標準）。
  validTowerState(tower) {
    if (!_appIsPlainObject(tower)) return false;
    if (!Number.isInteger(tower.floor) || !towerFloor(tower.floor)) return false;
    const cfg = towerFloor(tower.floor);
    if (!Number.isInteger(tower.steps) || tower.steps < 0 || tower.steps > cfg.maxSteps) return false;
    if (!Number.isInteger(tower.gold) || tower.gold < 0) return false;
    if (!_appIsPlainObject(tower.items)) return false;
    for (let i = 0; i < TOWER_ITEM_IDS.length; i++) {
      const id = TOWER_ITEM_IDS[i];
      if (!Object.prototype.hasOwnProperty.call(tower.items, id)) continue;
      const owned = tower.items[id];
      if (!Number.isInteger(owned) || owned < 0) return false;
      const item = _appShopItem(id);
      if (item && Number.isFinite(item.max) && owned > item.max) return false;
    }
    if (tower.seedPending !== undefined && typeof tower.seedPending !== 'boolean') return false;
    if (tower.meltNext !== undefined && (!Number.isInteger(tower.meltNext) || tower.meltNext < 0)) return false;
    return true;
  }

  // 任一欄位不合就整包丟棄回新局並回傳 false（被污染的存檔不得半套載入）
  deserializeState(data) {
    if (!_appIsPlainObject(data) || data.v !== 1) return false;
    if (!_appHasMode(data.mode)) return false;

    const size = _appModeSize(data.mode, data.size);
    if (!_appHasSize(size)) return false;
    const cells = size * size;

    // 【冰塊的 -1 只放行給爬塔】經典／閃電的盤面結構上不可能有冰塊，
    // 那兩個模式的存檔出現 -1 就是被竄改過，整包拒收。
    const allowIce = data.mode === MODES.TOWER;
    if (!Array.isArray(data.values) || data.values.length !== cells) return false;
    for (let i = 0; i < data.values.length; i++) {
      if (!_appIsTileValue(data.values[i], allowIce)) return false;
    }
    if (!Number.isInteger(data.nextId) || data.nextId < 1) return false;
    if (!Number.isFinite(data.score) || data.score < 0) return false;
    if (!Number.isInteger(data.moveCount) || data.moveCount < 0) return false;
    if (!Number.isInteger(data.undosUsed) || data.undosUsed < 0) return false;
    if (data.hintsUsed !== undefined && (!Number.isInteger(data.hintsUsed) || data.hintsUsed < 0)) return false;
    if (data.continued !== undefined && typeof data.continued !== 'boolean') return false;
    if (!this.validUndoSnapshot(data.undo, cells, allowIce)) return false;
    if (data.mode === MODES.TOWER && !this.validTowerState(data.tower)) return false;

    let blitzLeftMs = BLITZ_CONFIG.startMs;
    if (data.mode === MODES.BLITZ) {
      if (!Number.isFinite(data.blitzLeftMs)) return false;
      if (data.blitzLeftMs <= 0 || data.blitzLeftMs > BLITZ_CONFIG.maxMs) return false;
      blitzLeftMs = data.blitzLeftMs;
    }

    // 盤面整批重建，id 一律重新配發；nextId 取「重建後的值」與「存檔值」的大者，
    // 保證單調遞增、永不重用。
    const built = gridFromValues(data.values, 1);
    this.mode = data.mode;
    this.size = size;
    this.grid = built.grid;
    this.nextId = Math.max(built.nextId, data.nextId);
    this.score = data.score;
    this.moveCount = data.moveCount;
    this.undosUsed = data.undosUsed;
    this.hintsUsed = Number.isInteger(data.hintsUsed) ? data.hintsUsed : 0;
    this.continued = !!data.continued;
    this.blitzLeftMs = blitzLeftMs;
    this.startedAt = Number.isFinite(data.startedAt) ? data.startedAt : Date.now();
    this.undoSnapshot = _appIsPlainObject(data.undo) ? {
      values: data.undo.values.slice(),
      score: data.undo.score,
      moveCount: data.undo.moveCount,
      nextId: data.undo.nextId,
      towerSteps: _appNum(data.undo.towerSteps),
      towerGold: _appNum(data.undo.towerGold)
    } : null;

    // 爬塔狀態：驗證已經在上面過了，這裡只做「缺欄位補 0」的正規化
    if (data.mode === MODES.TOWER) {
      const saved = data.tower;
      const items = _appEmptyTowerItems();
      for (let i = 0; i < TOWER_ITEM_IDS.length; i++) {
        items[TOWER_ITEM_IDS[i]] = _appItemCount(saved.items, TOWER_ITEM_IDS[i]);
      }
      this.tower = {
        floor: saved.floor,
        steps: saved.steps,
        gold: saved.gold,
        items: items,
        seedPending: saved.seedPending === true,
        meltNext: _appNum(saved.meltNext)
      };
    } else {
      this.tower = _appEmptyTower();
    }
    this.smashing = false;
    this.gameOver = false;
    // 續玩中的存檔已經達過標，won 要跟著回來，否則一讀檔又會再彈一次達標視窗
    this.won = !!data.continued || (this.mode === MODES.CLASSIC && isWin(this.grid, _appSizeCfg(size).target));
    this.mergesThisGame = 0;
    this.bestChainThisGame = 0;
    return true;
  }

  saveGameState() {
    if (this.gameOver) return false;
    return _appWriteJson(SAVE_KEY, this.serializeState());
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
    this.statsSize = this.size;
    this.best = this.bestScoreOfCurrentBucket();
    this.setSmashing(false);
    this.renderBoardShell();
    this.renderAll();
    this.syncControlState();
    this.refreshHud();
    this.hideOverlay();
    if (this.mode === MODES.BLITZ) this.startBlitzTimer();
    this.showToast(this.mode === MODES.TOWER
      ? '📥 已為您接回上次未完成的爬塔'
      : '📥 已為您接回上次未完成的牌局');
    return true;
  }

  clearGameState() {
    _appRemoveKey(SAVE_KEY);
  }

  // ------------------------------------------------------------------------
  // 戰績（g2048_stats_v1，依「模式 × 尺寸」分桶）
  // ------------------------------------------------------------------------
  emptyBucket() {
    return {
      plays: 0,
      bestScore: 0,
      practiceBestScore: 0,
      bestTile: 0,
      milestoneHits: 0,
      targetHits: 0,
      fewestMovesToTarget: 0,
      fastestMs: 0,
      streak: 0,
      bestStreak: 0
    };
  }

  emptyBlitz() {
    return { plays: 0, bestScore: 0, longestSurvivalMs: 0, bestChain: 0 };
  }

  emptyGlobal() {
    return { totalMerges: 0, totalMoves: 0, totalPlays: 0, achievements: [] };
  }

  // 爬塔戰績桶（契約第 4 節）。
  // bestFloorSteps 是「單層最少過關步數」，0 代表還沒有紀錄 ——
  // 與 fewestMovesToTarget 同一套約定，免得「0 步過關」被當成最佳紀錄。
  emptyTower() {
    return { plays: 0, clears: 0, deepestFloor: 0, bestGold: 0, bestFloorSteps: 0 };
  }

  loadStats() {
    const raw = _appReadJson(STATS_KEY, {});
    const source = _appIsPlainObject(raw) ? raw : {};
    const savedClassic = _appIsPlainObject(source.classic) ? source.classic : {};
    // 無原型物件：縱深防禦，就算日後有人繞過尺寸白名單，classic[key] 也只會是 undefined，
    // 不會撈到 Object.prototype 上的內建函式再被種出 plays: NaN。
    const classic = Object.create(null);
    Object.keys(SIZE_CONFIG).forEach((key) => {
      const bucket = this.emptyBucket();
      const saved = Object.prototype.hasOwnProperty.call(savedClassic, key) ? savedClassic[key] : null;
      if (_appIsPlainObject(saved)) {
        Object.keys(bucket).forEach((field) => {
          if (Number.isFinite(saved[field])) bucket[field] = saved[field];
        });
      }
      classic[key] = bucket;
    });

    const blitz = this.emptyBlitz();
    if (_appIsPlainObject(source.blitz)) {
      Object.keys(blitz).forEach((field) => {
        if (Number.isFinite(source.blitz[field])) blitz[field] = source.blitz[field];
      });
    }

    const tower = this.emptyTower();
    if (_appIsPlainObject(source.tower)) {
      Object.keys(tower).forEach((field) => {
        if (Number.isFinite(source.tower[field])) tower[field] = source.tower[field];
      });
    }

    const global = this.emptyGlobal();
    if (_appIsPlainObject(source.global)) {
      ['totalMerges', 'totalMoves', 'totalPlays'].forEach((field) => {
        if (Number.isFinite(source.global[field])) global[field] = source.global[field];
      });
      if (Array.isArray(source.global.achievements)) {
        global.achievements = source.global.achievements.filter((x) => typeof x === 'string');
      }
    }

    return { classic, blitz, tower, global };
  }

  saveStats(stats) {
    if (!_appIsPlainObject(stats)) return false;
    // Object.create(null) 的 classic 要攤成一般物件，JSON.stringify 才吃得下
    const classic = {};
    Object.keys(SIZE_CONFIG).forEach((key) => {
      classic[key] = _appIsPlainObject(stats.classic[key]) ? stats.classic[key] : this.emptyBucket();
    });
    return _appWriteJson(STATS_KEY, {
      classic,
      blitz: stats.blitz,
      tower: _appIsPlainObject(stats.tower) ? stats.tower : this.emptyTower(),
      global: stats.global
    });
  }

  bucketKey() {
    return String(_appHasSize(this.size) ? this.size : 4);
  }

  // 爬塔的戰績桶沒有 bestScore 欄位（契約第 4 節只給五個欄位），
  // 所以爬塔一律回 0；HUD 的「最佳」在爬塔就等於即時分數，不會顯示假紀錄。
  bestScoreOfCurrentBucket() {
    if (this.mode === MODES.TOWER) return 0;
    const stats = this.loadStats();
    if (this.mode === MODES.BLITZ) return stats.blitz.bestScore || 0;
    const bucket = stats.classic[this.bucketKey()];
    return bucket ? (bucket.bestScore || 0) : 0;
  }

  // 達標的那一刻就立即寫進戰績並 flush，之後續玩塞死也不回頭取消。
  recordTargetHit() {
    const stats = this.loadStats();
    const clean = (this.undosUsed || 0) === 0;
    if (this.mode === MODES.CLASSIC) {
      const bucket = stats.classic[this.bucketKey()];
      if (bucket) {
        bucket.targetHits += 1;
        if (clean) {
          bucket.streak += 1;
          if (bucket.streak > bucket.bestStreak) bucket.bestStreak = bucket.streak;
          if (bucket.fewestMovesToTarget === 0 || this.moveCount < bucket.fewestMovesToTarget) {
            bucket.fewestMovesToTarget = this.moveCount;
          }
          const spent = Math.max(0, Date.now() - this.startedAt);
          if (bucket.fastestMs === 0 || spent < bucket.fastestMs) bucket.fastestMs = spent;
        }
      }
    }
    const key = 'target-' + this.mode + '-' + this.bucketKey();
    if (stats.global.achievements.indexOf(key) < 0) stats.global.achievements.push(key);
    this.saveStats(stats);
    if (this.sound) this.sound.playTarget();
    this.fireConfetti();
  }

  // 遊戲結束時結算：undosUsed === 0 才動正式紀錄，否則只更新 practiceBestScore
  recordResult(reason) {
    const stats = this.loadStats();
    const clean = (this.undosUsed || 0) === 0;
    const best = maxTile(this.grid);
    const survived = Math.max(0, Date.now() - this.startedAt);

    stats.global.totalPlays += 1;
    stats.global.totalMoves += this.moveCount;
    stats.global.totalMerges += this.mergesThisGame;

    let bucket = null;
    if (this.mode === MODES.TOWER) {
      const state = this.towerState();
      stats.tower.plays += 1;
      if (reason === 'towerclear') stats.tower.clears += 1;
      if (state.floor > stats.tower.deepestFloor) stats.tower.deepestFloor = state.floor;
      if (state.gold > stats.tower.bestGold) stats.tower.bestGold = state.gold;
    } else if (this.mode === MODES.BLITZ) {
      stats.blitz.plays += 1;
      if (this.score > stats.blitz.bestScore) stats.blitz.bestScore = this.score;
      if (survived > stats.blitz.longestSurvivalMs) stats.blitz.longestSurvivalMs = survived;
      if (this.bestChainThisGame > stats.blitz.bestChain) stats.blitz.bestChain = this.bestChainThisGame;
    } else {
      bucket = stats.classic[this.bucketKey()];
      if (bucket) {
        bucket.plays += 1;
        if (clean) {
          if (this.score > bucket.bestScore) bucket.bestScore = this.score;
          if (best > bucket.bestTile) bucket.bestTile = best;
          // 這局沒達標就斷連勝（達標的那一刻已經先加過了）
          if (!this.won) bucket.streak = 0;
        } else if (this.score > bucket.practiceBestScore) {
          bucket.practiceBestScore = this.score;
        }
      }
    }

    this.saveStats(stats);
    // reason 只影響結算文案，不影響紀錄本身
    return { bucket, blitz: stats.blitz, tower: stats.tower, reason: reason || 'over' };
  }

  // 過關的那一刻就記下這一層用了幾步；一局爬五層就有五次機會刷新紀錄，
  // 所以不能等到結算才寫（那時候只剩最後一層的步數）。
  recordFloorCleared(cfg) {
    if (this.mode !== MODES.TOWER) return null;
    const used = Math.max(0, this.towerState().steps);
    const stats = this.loadStats();
    if (cfg && cfg.floor > stats.tower.deepestFloor) stats.tower.deepestFloor = cfg.floor;
    if (used > 0 && (stats.tower.bestFloorSteps === 0 || used < stats.tower.bestFloorSteps)) {
      stats.tower.bestFloorSteps = used;
    }
    this.saveStats(stats);
    return stats.tower;
  }

  // 里程碑成就：第一次合出 512 / 1024 / 2048 / 4096 / 8192 各給一次
  checkAchievements(skipToastFor) {
    const best = maxTile(this.grid);
    if (!(best >= ACHIEVE_TILES[0])) return;
    const stats = this.loadStats();
    let added = null;
    for (let i = 0; i < ACHIEVE_TILES.length; i++) {
      const value = ACHIEVE_TILES[i];
      if (best < value) break;
      const key = 'tile-' + value;
      if (stats.global.achievements.indexOf(key) >= 0) continue;
      stats.global.achievements.push(key);
      added = value;
    }
    if (added === null) return;
    this.saveStats(stats);
    // 里程碑剛慶祝過同一個數字的話就不要再跳一則（同一件事跳兩則很吵）
    if (added === skipToastFor) return;
    this.showToast(`🏅 新成就：合出了 ${added}！`);
  }

  resetStats() {
    _appRemoveKey(STATS_KEY);
    this.best = this.bestScoreOfCurrentBucket();
    this.refreshHud();
    this.renderStats(this.statsSize);
    this.showToast('🗑️ 戰績紀錄已清除');
  }

  renderStats(size) {
    const key = _appHasSize(size) ? size : (_appHasSize(this.statsSize) ? this.statsSize : 4);
    this.statsSize = key;
    const stats = this.loadStats();
    const bucket = stats.classic[String(key)] || this.emptyBucket();
    if (!this.el) return bucket;

    if (this.el.statsSizeBtns && this.el.statsSizeBtns.forEach) {
      this.el.statsSizeBtns.forEach((btn) => {
        const on = !!(btn.dataset && parseInt(btn.dataset.statsize, 10) === key);
        if (btn.classList) btn.classList.toggle('active', on);
        // 分頁選取狀態也要對輔助科技暴露，只有底色看得出來是不夠的
        _appSetAttr(btn, 'aria-pressed', on ? 'true' : 'false');
      });
    }

    _appSetText(this.el.statPlays, String(bucket.plays));
    _appSetText(this.el.statBest, bucket.bestScore > 0
      ? String(bucket.bestScore)
      : (bucket.practiceBestScore > 0 ? `${bucket.practiceBestScore}（練習）` : '--'));
    _appSetText(this.el.statMaxtile, bucket.bestTile > 0 ? String(bucket.bestTile) : '--');
    _appSetText(this.el.statMilestone, String(bucket.milestoneHits || 0));
    _appSetText(this.el.statHits, String(bucket.targetHits));
    _appSetText(this.el.statStreak, String(bucket.bestStreak));
    _appSetText(this.el.statFewest, bucket.fewestMovesToTarget > 0 ? `${bucket.fewestMovesToTarget} 步` : '--');

    // 爬塔模式改看爬塔面板：尺寸分頁與經典戰績格整組收起，換上五格爬塔紀錄。
    // 爬塔沒有「3×3 / 4×4 / 5×5」的分桶，留著分頁只會讓人以為可以切。
    const tower = stats.tower || this.emptyTower();
    this.showTowerStats(this.mode === MODES.TOWER);
    _appSetText(this.el.towerPlays, String(tower.plays));
    _appSetText(this.el.towerClears, String(tower.clears));
    _appSetText(this.el.towerFloor, tower.deepestFloor > 0 ? `${tower.deepestFloor}F` : '--');
    _appSetText(this.el.towerGold, tower.bestGold > 0 ? String(tower.bestGold) : '--');
    _appSetText(this.el.towerSteps, tower.bestFloorSteps > 0 ? `${tower.bestFloorSteps} 步` : '--');
    return bucket;
  }

  // ------------------------------------------------------------------------
  // 彈窗：hidden 屬性管可及性、.open class 管進場動畫，兩軌並行
  // ------------------------------------------------------------------------
  // 彈窗開啟時把背景對鍵盤與輔助科技一起關掉，讓 focus trap 不是唯一防線。
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
      if (on) _appSetAttr(el, 'aria-hidden', 'true');
      else _appRemoveAttr(el, 'aria-hidden');
    });
  }

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

  // focus trap：只比對 first / last 是不夠的。
  // 點到彈窗內的純文字時焦點會掉到 <body>，那時 active 既不是 first 也不是 last，
  // 兩個分支都不成立就會讓 Tab 溜到背景頁面去按按鈕。
  trapFocus(event, modal) {
    const focusable = this.focusableIn(modal);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = (typeof document !== 'undefined') ? document.activeElement : null;
    const inside = !!(active && typeof modal.contains === 'function' && modal.contains(active));
    if (!inside) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  openModal(modal, focusTarget) {
    if (!modal) return;
    // 取消上一次關閉排定、尚未觸發的隱藏計時器；
    // 否則在淡出期間重開同一個彈窗，舊 timer 會在開啟後才把它設成 hidden，
    // 畫面上彈窗消失但 .open 還在，滑動與鍵盤會全部被當成「有彈窗開著」而失效。
    if (modal._hideTimer !== null && modal._hideTimer !== undefined) {
      clearTimeout(modal._hideTimer);
      modal._hideTimer = null;
    }
    if (typeof document !== 'undefined') this.lastFocusedElement = document.activeElement;
    // 開窗前先把還在飛的磚結算掉，免得彈窗蓋著時 commit 又改了畫面
    this.flushPending();
    modal.hidden = false;
    _appSetAttr(modal, 'aria-hidden', 'false');
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
    _appSetAttr(modal, 'aria-hidden', 'true');
    if (modal._hideTimer !== null && modal._hideTimer !== undefined) clearTimeout(modal._hideTimer);
    if (typeof setTimeout === 'function') {
      modal._hideTimer = setTimeout(() => {
        modal._hideTimer = null;
        // 雙保險：期間又被重新開啟就不要動 hidden
        if (modal.classList && modal.classList.contains('open')) return;
        modal.hidden = true;
      }, MODAL_FADE_MS);
    } else {
      modal.hidden = true;
    }
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

  openConfirm(title, text, onConfirm) {
    if (!this.el || !this.el.confirmModal) {
      if (typeof onConfirm === 'function') onConfirm();
      return;
    }
    this.confirmAction = typeof onConfirm === 'function' ? onConfirm : null;
    _appSetText(this.el.confirmTitle, title);
    _appSetText(this.el.confirmText, text);
    this.openModal(this.el.confirmModal, this.el.confirmCancelBtn);
  }

  acceptConfirm() {
    const action = this.confirmAction;
    this.confirmAction = null;
    this.closeModal(this.el ? this.el.confirmModal : null);
    if (typeof action === 'function') action();
  }

  cancelConfirm() {
    this.confirmAction = null;
    this.closeModal(this.el ? this.el.confirmModal : null);
  }

  openStatsModal() {
    if (!this.el || !this.el.statsModal) return;
    this.renderStats(this.statsSize);
    this.openModal(this.el.statsModal, this.el.statsOkBtn);
  }

  openHelpModal() {
    if (!this.el) return;
    this.openModal(this.el.helpModal, this.el.helpOkBtn);
  }

  // 達標彈窗：與結算彈窗共用同一個 DOM，差別只在「繼續挑戰」按鈕露不露臉
  showTargetModal(target) {
    if (!this.el || !this.el.resultModal) return;
    const best = maxTile(this.grid);
    _appSetText(this.el.resultEmoji, '🎉');
    _appSetText(this.el.resultTitleText, `達標！合出了 ${target}`);
    _appSetText(this.el.resultScore, String(this.score));
    _appSetText(this.el.resultBest, String(Math.max(this.best, this.score)));
    _appSetText(this.el.resultMaxtile, String(best));

    const parts = [`${this.sizeConfig().label}`, `共 ${this.moveCount} 步`];
    if ((this.undosUsed || 0) > 0) parts.push(`本局悔棋 ${this.undosUsed} 次 · 不列入排行榜`);
    else parts.push('紀錄已寫入，續玩失敗也不會被收回');
    _appSetText(this.el.resultDetail, parts.join(' · '));

    if (this.el.resultContinueBtn) this.el.resultContinueBtn.hidden = false;
    this.openModal(this.el.resultModal, this.el.resultContinueBtn || this.el.resultAgainBtn);
  }

  showResultModal(info) {
    if (!this.el || !this.el.resultModal) return;
    const data = info || {};
    const bucket = data.bucket || null;
    const blitz = data.blitz || null;
    const best = maxTile(this.grid);

    const tower = this.mode === MODES.TOWER;
    const towerStats = data.tower || null;
    const timeup = data.reason === 'timeup';
    const cleared = data.reason === 'towerclear';
    const outOfSteps = data.reason === 'steps';

    let emoji = this.won ? '🏆' : '😿';
    if (cleared) emoji = '👑';
    else if (timeup) emoji = '⏱️';
    else if (outOfSteps) emoji = '🪜';
    _appSetText(this.el.resultEmoji, emoji);

    let title = this.won ? '這局很精彩！' : '沒有路可以走了';
    if (cleared) title = '登頂！五層全部通關';
    else if (timeup) title = '時間到！';
    else if (outOfSteps) title = '步數用完了';
    _appSetText(this.el.resultTitleText, title);

    _appSetText(this.el.resultScore, String(this.score));
    // 爬塔沒有最高分紀錄（契約的 tower 桶沒有這個欄位），欄位就顯示本局分數
    _appSetText(this.el.resultBest, tower ? String(this.score) : String(this.bestScoreOfCurrentBucket()));
    _appSetText(this.el.resultMaxtile, String(best));

    const parts = [];
    if (tower) {
      const state = this.towerState();
      const cfg = this.towerFloorConfig();
      parts.push(cleared ? '🏔️ 爬塔通關' : `🏔️ 爬到 ${cfg ? cfg.name : state.floor + 'F'}`);
      parts.push(`共 ${this.moveCount} 步`);
      parts.push(`🪙 ${state.gold} 金幣`);
      if ((this.undosUsed || 0) > 0) parts.push(`本局悔棋 ${this.undosUsed} 次`);
      if (towerStats && towerStats.clears > 0) parts.push(`累積登頂 ${towerStats.clears} 次`);
      else if (towerStats && towerStats.plays > 0) parts.push(`累積 ${towerStats.plays} 局`);
    } else if (this.mode === MODES.BLITZ) {
      parts.push('⚡ 加時閃電');
      parts.push(`共 ${this.moveCount} 步`);
      if (this.bestChainThisGame >= BLITZ_CONFIG.chainThreshold) parts.push(`最高 ${this.bestChainThisGame} 連鎖`);
      if (blitz && blitz.longestSurvivalMs > 0) parts.push(`最久撐了 ${_appFormatMs(blitz.longestSurvivalMs)}`);
    } else {
      parts.push(this.sizeConfig().label);
      parts.push(`共 ${this.moveCount} 步`);
      if ((this.undosUsed || 0) > 0) parts.push(`本局悔棋 ${this.undosUsed} 次 · 不列入排行榜`);
      if (bucket) parts.push(`累積 ${bucket.plays} 局`);
    }
    _appSetText(this.el.resultDetail, parts.join(' · '));

    // 已經結束的局不能再續玩
    if (this.el.resultContinueBtn) this.el.resultContinueBtn.hidden = true;
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
    if (typeof setTimeout !== 'function') return;
    setTimeout(() => {
      if (toast.style) {
        toast.style.opacity = '0';
        toast.style.transition = `opacity ${TOAST_FADE_MS}ms ease`;
      }
      setTimeout(() => {
        if (typeof toast.remove === 'function') toast.remove();
      }, TOAST_FADE_MS);
    }, TOAST_MS);
  }

  // 彩帶走共用模組，且必須可缺席（測試環境沒有 BoboConfetti）
  fireConfetti() {
    if (!confetti) return;
    if (this.prefersReducedMotion()) return;
    const canvas = this.el ? this.el.confettiCanvas : null;
    try {
      const options = { canvas };
      if (typeof confetti.burst === 'function') confetti.burst(options);
      else if (typeof confetti.fire === 'function') confetti.fire(options);
      else if (typeof confetti.play === 'function') confetti.play(options);
      else if (typeof confetti === 'function') confetti(options);
    } catch (_) {}
  }
}

// --------------------------------------------------------------------------
// 瀏覽器啟動
// --------------------------------------------------------------------------
let gameInstance = null;
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    gameInstance = new Game2048();
  });
}

// --------------------------------------------------------------------------
// Node 單元測試匯出
// --------------------------------------------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DIR, DIR_NAMES, MODES, SIZE_CONFIG, BLITZ_CONFIG, UNDO_LIMIT, MAX_LEVEL,
    SLIDE_MS, POP_MS, SPAWN_MS,
    TOWER_FLOORS, SHOP_ITEMS, ICE_VALUE, REVIVE_STEPS,
    createRng, createInitialGrid, buildLines, computeMove, spawnTile, canMove,
    maxTile, isWin, isGameOver, levelOf, gridToValues, gridFromValues, valuesFromRows,
    isIce, placeIce, towerFloor, sacrificeTiles, shuffleTiles,
    SWIPE, lockSwipeAxis, resolveSwipe,
    SAVE_KEY, STATS_KEY, PREF_KEY, SKINS, EVOLVE_GLYPHS, Game2048
  };
}
