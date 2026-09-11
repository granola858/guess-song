// Nonogram 純邏輯核心：題目生成、線解推理與難度評分。
// 這個檔案不得碰 DOM 或 localStorage，才能同時被瀏覽器與 Node 測試載入。
const NonogramCore = (() => {
  'use strict';

  const DIFFICULTY_LEVELS = ['easy', 'medium', 'hard'];
  const DEFAULT_DIFFICULTY = 'medium';

  // 生成偏置：鄰居已填黑時提高本格填黑機率，用來控制方塊的聚集程度。
  // 正偏置 → 色塊聚成長條，線索少而長，開局靠重疊就能推出大半；
  // 負偏置 → 色塊零碎，線索多而短，必須反覆交叉列與行才推得動。
  const GENERATION_PROFILES = {
    easy: { fillProbability: 0.50, neighborBias: 0.15 },
    medium: { fillProbability: 0.55, neighborBias: 0.00 },
    hard: { fillProbability: 0.55, neighborBias: -0.10 }
  };

  // 難度門檻：passes 是線解掃描輪數，firstYield 是第一輪就確定的格子比例。
  // 兩項條件都滿足才歸該級，其餘一律算中等，確保三級互斥且必有歸屬。
  const RATING_THRESHOLDS = {
    easy: { minFirstYield: 0.8, maxPasses: 2 },
    hard: {
      8: { minPasses: 4, maxFirstYield: 0.45 },
      10: { minPasses: 4, maxFirstYield: 0.45 },
      12: { minPasses: 5, maxFirstYield: 0.45 }
    }
  };
  const DEFAULT_HARD_THRESHOLD = { minPasses: 4, maxFirstYield: 0.45 };

  const MAX_GENERATION_ATTEMPTS = 600;
  const linePatternCache = new Map();

  // --- 基礎工具 (Primitives) ---
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

  function normalizeDifficulty(value) {
    return DIFFICULTY_LEVELS.includes(value) ? value : DEFAULT_DIFFICULTY;
  }

  function getGenerationProfile(difficulty) {
    return GENERATION_PROFILES[normalizeDifficulty(difficulty)];
  }

  // --- 題目生成 (Solution Generation) ---
  function createRandomSolution(targetSize, difficulty) {
    const { fillProbability, neighborBias } = getGenerationProfile(difficulty);
    const solution = [];

    for (let r = 0; r < targetSize; r++) {
      const row = [];
      for (let c = 0; c < targetSize; c++) {
        let probability = fillProbability;
        if (c > 0 && row[c - 1] === 1) probability += neighborBias;
        if (r > 0 && solution[r - 1][c] === 1) probability += neighborBias;
        probability = Math.min(1, Math.max(0, probability));
        row.push(Math.random() < probability ? 1 : 0);
      }
      solution.push(row);
    }

    return solution;
  }

  // --- 單線候選枚舉 (Line Patterns) ---
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

  // --- 線解推理 (Line Solving) ---
  // 只用「同一條線的候選在某格取值一致 ⇒ 該格可確定」這條規則反覆迭代。
  // 這正是玩家手動推理時做的事，涵蓋重疊法、邊界法、封閉線等所有經典技巧，
  // 而且完全不含猜測；傳入 trace 時會記錄每一輪新確定的格子數，供難度評分使用。
  function propagateConstraints(board, rowDomains, colDomains, trace) {
    const targetSize = board.length;
    let changed = true;

    while (changed) {
      changed = false;
      let passGain = 0;

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
            passGain++;
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
            passGain++;
          } else if (board[r][c] !== forcedValue) {
            return false;
          }
        }
      }

      // 一輪掃完列與行都沒有新格子被確定，代表已到不動點，後續不會再有進展。
      if (trace && passGain > 0) trace.push(passGain);
      if (passGain === 0) break;
    }

    return true;
  }

  function isBoardSolved(board) {
    return board.every(row => row.every(cell => cell !== -1));
  }

  function createEmptyBoard(targetSize) {
    return Array.from({ length: targetSize }, () => new Array(targetSize).fill(-1));
  }

  // 只做線解、完全不回溯。solved 為 true 代表這題純靠推理技巧就能解完，不需要猜測。
  function solveByLineLogic(rowClues, colClues) {
    const targetSize = rowClues.length;
    const board = createEmptyBoard(targetSize);
    const rowDomains = rowClues.map(clues => getLinePatterns(targetSize, clues));
    const colDomains = colClues.map(clues => getLinePatterns(targetSize, clues));
    const trace = [];

    const isConsistent = propagateConstraints(board, rowDomains, colDomains, trace);
    const solved = isConsistent && isBoardSolved(board);
    const totalCells = targetSize * targetSize;

    return {
      solved: solved,
      board: board,
      passes: trace.length,
      firstYield: trace.length ? trace[0] / totalCells : 0,
      minGain: trace.length ? Math.min(...trace) : 0,
      trace: trace
    };
  }

  // --- 回溯計數 (Solution Counting) ---
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
      let isContradiction = false;

      if (branch.type === 'row') {
        nextRowDomains[branch.index] = [pattern];
        for (let c = 0; c < pattern.length; c++) {
          if (nextBoard[branch.index][c] !== -1 && nextBoard[branch.index][c] !== pattern[c]) {
            isContradiction = true;
            break;
          }
          nextBoard[branch.index][c] = pattern[c];
        }
      } else {
        nextColDomains[branch.index] = [pattern];
        for (let r = 0; r < pattern.length; r++) {
          if (nextBoard[r][branch.index] !== -1 && nextBoard[r][branch.index] !== pattern[r]) {
            isContradiction = true;
            break;
          }
          nextBoard[r][branch.index] = pattern[r];
        }
      }

      // 這個候選與已知格衝突時只能略過它，不能放棄整條線剩下的兄弟候選，
      // 否則會少算解數，把非唯一解的題目誤判成唯一解。
      if (isContradiction) continue;

      searchSolutions(nextBoard, nextRowDomains, nextColDomains, limit, counter);
    }
  }

  function countSolutions(rowClues, colClues, limit = 2) {
    const targetSize = rowClues.length;
    const board = createEmptyBoard(targetSize);
    const rowDomains = rowClues.map(clues => getLinePatterns(targetSize, clues));
    const colDomains = colClues.map(clues => getLinePatterns(targetSize, clues));
    const counter = { count: 0 };

    searchSolutions(board, rowDomains, colDomains, limit, counter);
    return counter.count;
  }

  // --- 難度評分 (Difficulty Rating) ---
  function classifyDifficulty(rating, targetSize) {
    if (!rating || !rating.solved) return null;

    const easyRule = RATING_THRESHOLDS.easy;
    if (rating.firstYield >= easyRule.minFirstYield && rating.passes <= easyRule.maxPasses) {
      return 'easy';
    }

    const hardRule = RATING_THRESHOLDS.hard[targetSize] || DEFAULT_HARD_THRESHOLD;
    if (rating.passes >= hardRule.minPasses && rating.firstYield <= hardRule.maxFirstYield) {
      return 'hard';
    }

    return 'medium';
  }

  // 回傳這組線索的難度。difficulty 為 null 代表不能只靠推理解完（需要猜測），
  // 此時才需要多花一次回溯計數來分辨「非唯一解」與「唯一解但要猜」。
  function ratePuzzle(rowClues, colClues) {
    const targetSize = rowClues.length;
    const rating = solveByLineLogic(rowClues, colClues);
    const difficulty = classifyDifficulty(rating, targetSize);

    return {
      solved: rating.solved,
      // 線解推到滿盤時每一步都是所有解共有的必然值，因此滿盤必定唯一解。
      unique: rating.solved ? true : countSolutions(rowClues, colClues, 2) === 1,
      difficulty: difficulty,
      passes: rating.passes,
      firstYield: rating.firstYield
    };
  }

  function generatePuzzle(targetSize, difficulty) {
    const targetDifficulty = normalizeDifficulty(difficulty);

    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
      const solution = createRandomSolution(targetSize, targetDifficulty);
      const { rowClues, colClues } = buildCluesFromSolution(solution);
      const rating = solveByLineLogic(rowClues, colClues);

      // 不能純邏輯解完就直接丟棄，確保出到玩家手上的題目一定不需要猜測。
      if (!rating.solved) continue;
      if (classifyDifficulty(rating, targetSize) !== targetDifficulty) continue;

      return { solution, rowClues, colClues, rating };
    }

    throw new Error(`Unable to generate a ${targetDifficulty} ${targetSize}x${targetSize} puzzle.`);
  }

  return {
    DIFFICULTY_LEVELS,
    DEFAULT_DIFFICULTY,
    GENERATION_PROFILES,
    RATING_THRESHOLDS,
    MAX_GENERATION_ATTEMPTS,
    getClues,
    cloneGrid,
    createEmptyPlayerState,
    buildCluesFromSolution,
    areClueLinesEqual,
    isValidMatrix,
    isValidClueSet,
    normalizeDifficulty,
    getGenerationProfile,
    createRandomSolution,
    getLinePatterns,
    propagateConstraints,
    isBoardSolved,
    solveByLineLogic,
    countSolutions,
    classifyDifficulty,
    ratePuzzle,
    generatePuzzle
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = NonogramCore;
}
