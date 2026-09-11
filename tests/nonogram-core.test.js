const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const GAME_DIR = path.join(__dirname, '..', 'games', 'nonogram');
const CORE_PATH = path.join(GAME_DIR, 'nonogram-core.js');
const JS_PATH = path.join(GAME_DIR, 'nonogram.js');
const HTML_PATH = path.join(GAME_DIR, 'index.html');
const CSS_PATH = path.join(GAME_DIR, 'nonogram.css');

// 即使核心檔尚未完成，也只讓「斷言失敗」而不是整份測試檔炸掉
let moduleLoadError = null;
let core = {};
try {
  // eslint-disable-next-line global-require
  core = require(CORE_PATH) || {};
} catch (err) {
  moduleLoadError = err;
}

const SIZES = [8, 10, 12];

test('nonogram-core.js 可被 Node 載入並導出必要 API', () => {
  assert.equal(moduleLoadError, null, `載入失敗: ${moduleLoadError && moduleLoadError.message}`);
  [
    'getClues',
    'buildCluesFromSolution',
    'createRandomSolution',
    'solveByLineLogic',
    'classifyDifficulty',
    'ratePuzzle',
    'generatePuzzle',
    'countSolutions'
  ].forEach(name => {
    assert.equal(typeof core[name], 'function', `缺少導出函式: ${name}`);
  });
  assert.deepEqual(core.DIFFICULTY_LEVELS, ['easy', 'medium', 'hard']);
});

test('getClues 正確推導線索，空行回傳 [0]', () => {
  assert.deepEqual(core.getClues([0, 0, 0]), [0]);
  assert.deepEqual(core.getClues([1, 1, 0, 1]), [2, 1]);
  assert.deepEqual(core.getClues([1, 1, 1]), [3]);
  assert.deepEqual(core.getClues([0, 1, 0, 1, 0]), [1, 1]);
});

test('buildCluesFromSolution 同時推導列與行線索', () => {
  const solution = [
    [1, 0, 1],
    [1, 1, 0],
    [0, 0, 1]
  ];
  const { rowClues, colClues } = core.buildCluesFromSolution(solution);
  assert.deepEqual(rowClues, [[1, 1], [2], [1]]);
  assert.deepEqual(colClues, [[2], [1], [1, 1]]);
});

test('solveByLineLogic 對全填盤面一輪解完', () => {
  const size = 5;
  const solution = Array.from({ length: size }, () => new Array(size).fill(1));
  const { rowClues, colClues } = core.buildCluesFromSolution(solution);
  const rating = core.solveByLineLogic(rowClues, colClues);

  assert.equal(rating.solved, true);
  assert.equal(rating.passes, 1);
  assert.equal(rating.firstYield, 1);
});

test('solveByLineLogic 不會猜測：2x2 對角題目判定為無法純邏輯解出', () => {
  const rowClues = [[1], [1]];
  const colClues = [[1], [1]];
  const rating = core.solveByLineLogic(rowClues, colClues);

  assert.equal(rating.solved, false, '雙解題目不應被線解判定為已解完');
  assert.equal(core.classifyDifficulty(rating, 2), null, '無法線解的題目難度必須是 null');
  assert.equal(core.countSolutions(rowClues, colClues, 3), 2, '這題本來就有兩組解');
});

test('ratePuzzle 分辨「非唯一解」與「唯一解但需猜測」', () => {
  // 兩組解：線解解不完，且 unique 為 false
  const ambiguous = core.ratePuzzle([[1], [1]], [[1], [1]]);
  assert.equal(ambiguous.solved, false);
  assert.equal(ambiguous.unique, false);
  assert.equal(ambiguous.difficulty, null);

  // 線解可解的題目必定唯一解，不必再跑回溯
  const solution = [
    [1, 1, 1],
    [1, 0, 0],
    [1, 0, 0]
  ];
  const { rowClues, colClues } = core.buildCluesFromSolution(solution);
  const rated = core.ratePuzzle(rowClues, colClues);
  assert.equal(rated.solved, true);
  assert.equal(rated.unique, true);
  assert.ok(core.DIFFICULTY_LEVELS.includes(rated.difficulty));
});

test('每個尺寸與難度組合都能生成題目，且全部不需猜測、皆為唯一解', () => {
  const SAMPLES = 10;

  SIZES.forEach(size => {
    core.DIFFICULTY_LEVELS.forEach(difficulty => {
      for (let i = 0; i < SAMPLES; i++) {
        const puzzle = core.generatePuzzle(size, difficulty);
        const label = `${size}x${size} ${difficulty} #${i}`;

        assert.equal(puzzle.solution.length, size, `${label} 盤面尺寸不符`);
        assert.equal(puzzle.rating.solved, true, `${label} 必須純靠推理解完，不可需要猜測`);

        // 線索必須與解答一致
        const derived = core.buildCluesFromSolution(puzzle.solution);
        assert.deepEqual(derived.rowClues, puzzle.rowClues, `${label} 列線索與解答不符`);
        assert.deepEqual(derived.colClues, puzzle.colClues, `${label} 行線索與解答不符`);

        // 難度必須落在指定等級
        const rated = core.ratePuzzle(puzzle.rowClues, puzzle.colClues);
        assert.equal(rated.difficulty, difficulty, `${label} 難度分級不符`);

        // 交叉驗證：線解可解 ⇒ 唯一解
        assert.equal(core.countSolutions(puzzle.rowClues, puzzle.colClues, 2), 1, `${label} 不是唯一解`);
      }
    });
  });
});

test('三級難度互斥：可線解的題目恰好落在一個等級', () => {
  SIZES.forEach(size => {
    for (let i = 0; i < 40; i++) {
      const solution = core.createRandomSolution(size, 'medium');
      const { rowClues, colClues } = core.buildCluesFromSolution(solution);
      const rating = core.solveByLineLogic(rowClues, colClues);
      const difficulty = core.classifyDifficulty(rating, size);

      if (!rating.solved) {
        assert.equal(difficulty, null, `${size} 無法線解卻被分級為 ${difficulty}`);
        continue;
      }
      assert.ok(core.DIFFICULTY_LEVELS.includes(difficulty), `${size} 可線解卻分不出難度`);
    }
  });
});

test('生成偏置涵蓋三個等級且方向正確', () => {
  const profiles = core.GENERATION_PROFILES;
  assert.deepEqual(Object.keys(profiles).sort(), ['easy', 'hard', 'medium']);
  // 簡單靠聚集（正偏置），困難靠零碎（負偏置），中等維持原本的無偏置隨機
  assert.ok(profiles.easy.neighborBias > 0, '簡單題應使用正向聚集偏置');
  assert.equal(profiles.medium.neighborBias, 0, '中等題應維持無偏置隨機');
  assert.ok(profiles.hard.neighborBias < 0, '困難題應使用負向打散偏置');
});

test('index.html 在 nonogram.js 之前載入核心檔，並提供難度切換 UI', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const coreIndex = html.indexOf('nonogram-core.js');
  const mainIndex = html.indexOf('src="nonogram.js"');

  assert.ok(coreIndex !== -1, 'index.html 未載入 nonogram-core.js');
  assert.ok(mainIndex !== -1, 'index.html 未載入 nonogram.js');
  assert.ok(coreIndex < mainIndex, 'nonogram-core.js 必須在 nonogram.js 之前載入');

  assert.match(html, /id="difficulty-toggle"/, '缺少難度切換容器');
  ['easy', 'medium', 'hard'].forEach(level => {
    assert.ok(html.includes(`data-difficulty="${level}"`), `缺少難度按鈕: ${level}`);
  });
  assert.match(html, /id="level-toggle"/, '盤面大小切換容器不應被移除');
});

test('nonogram.js 改用核心模組並以「尺寸 x 難度」槽位保存進度', () => {
  const js = fs.readFileSync(JS_PATH, 'utf8');

  assert.ok(!js.includes('function propagateConstraints'), '純邏輯應已搬到 nonogram-core.js');
  assert.ok(!js.includes('generateUniquePuzzle'), '應改用 NonogramCore.generatePuzzle');
  assert.match(js, /NonogramCore\.generatePuzzle\(/, '未透過核心模組生成題目');
  assert.match(js, /NonogramCore\.ratePuzzle\(/, 'Seed 載入未透過核心模組判定難度');
  assert.match(js, /function getSlotKey\(/, '缺少槽位 key helper');
  assert.match(js, /function switchSlot\(/, '缺少槽位切換函式');
  assert.ok(js.includes('dirtySlotKeys'), 'dirty 追蹤未改成槽位 key');
});

test('nonogram.css 具備控制區樣式', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  ['.control-stack', '.control-group', '.control-label'].forEach(selector => {
    assert.ok(css.includes(selector), `nonogram.css 缺少 ${selector} 樣式`);
  });
});
