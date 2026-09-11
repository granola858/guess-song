const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
const homeJs = fs.existsSync(path.join(projectRoot, 'assets', 'js', 'home.js'))
  ? fs.readFileSync(path.join(projectRoot, 'assets', 'js', 'home.js'), 'utf8')
  : '';
const combinedSource = html + '\n' + homeJs;

const cards = [...html.matchAll(/<article class="game-card"\s+data-id="([^"]+)"\s+data-category="([^"]+)"\s+data-search="([^"]+)"[^>]*>[\s\S]*?<a class="card-link" href="([^"]+)"[^>]*>[\s\S]*?<h3>([^<]+)<\/h3>[\s\S]*?<\/article>/g)]
  .map(([, id, category, search, href, title]) => ({ id, category, search, href, title }));

test('首頁列出 17 個具有唯一 ID 的完整遊戲入口', () => {
  // 猜歌資料庫已下架（資料來源不再提供），整個 games/guess-song 連同卡片一起移除。
  assert.equal(cards.length, 17);
  assert.equal(new Set(cards.map(card => card.id)).size, cards.length);
  cards.forEach(card => {
    assert.ok(card.title.trim(), `${card.id} 缺少標題`);
    assert.ok(card.category.trim(), `${card.id} 缺少分類`);
    assert.ok(card.search.trim(), `${card.id} 缺少搜尋文字`);
  });
});

test('每個首頁遊戲連結都指向現有檔案', () => {
  cards.forEach(card => {
    const target = path.join(projectRoot, ...card.href.split('/'));
    assert.ok(fs.existsSync(target), `${card.title} 的連結不存在：${card.href}`);
  });
});

test('首頁遊戲連結一律指向 games/ 底下的獨立資料夾', () => {
  cards.forEach(card => {
    assert.match(card.href, /^games\/[a-z0-9-]+\//, `${card.title} 的連結未收納於 games/：${card.href}`);
  });
});

test('所有首頁 JavaScript 都能通過語法編譯', () => {
  const inlineScripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  inlineScripts.forEach((source, index) => {
    assert.doesNotThrow(() => new Function(source), `第 ${index + 1} 段 inline script 語法錯誤`);
  });

  const externalScriptMatches = [...html.matchAll(/<script\s+src="([^"]+)"/gi)].map(m => m[1]);
  externalScriptMatches.forEach(src => {
    const filePath = path.join(projectRoot, ...src.split('/'));
    assert.ok(fs.existsSync(filePath), `找不到外部 script 檔案: ${src}`);
    const source = fs.readFileSync(filePath, 'utf8');
    assert.doesNotThrow(() => new Function(source), `${src} 語法錯誤`);
  });
});

test('排序、隱藏與主題控制都使用同一份持久化偏好', () => {
  assert.match(combinedSource, /bobo-home-preferences-v2/);
  assert.match(combinedSource, /prefs\.order/);
  assert.match(combinedSource, /prefs\.hidden/);
  assert.match(combinedSource, /prefs\.theme/);
  assert.match(html, /class="card-controls"/);
  assert.match(html, /id="hidden-panel"/);
  assert.match(html, /id="theme-toggle"/);
});

test('搜尋、類型篩選與隨機選擇控制均存在', () => {
  assert.match(html, /id="game-search"/);
  assert.match(html, /data-filter="popular"/);
  assert.match(html, /data-filter="logic"/);
  assert.match(html, /data-filter="party"/);
  assert.match(html, /data-filter="reaction"/);
  assert.match(html, /id="random-game"/);
});

test('卡片排序改用 Pointer Events，觸控與滑鼠皆可拖曳', () => {
  const homeCss = fs.readFileSync(path.join(projectRoot, 'assets', 'css', 'home.css'), 'utf8');

  // 不可再依賴僅支援滑鼠的 HTML5 拖放 API
  assert.doesNotMatch(homeJs, /ondrag(start|over|leave|end)\s*=/);
  assert.doesNotMatch(homeJs, /dataTransfer/);
  assert.doesNotMatch(homeJs, /\.draggable\s*=/);

  // 指標事件、觸控長按與多指隔離
  assert.match(homeJs, /addEventListener\('pointerdown'/);
  assert.match(homeJs, /'pointermove'/);
  assert.match(homeJs, /'pointercancel'/);
  assert.match(homeJs, /pointerType === 'touch'/);
  assert.match(homeJs, /pointerId/);

  // 拖曳中必須阻擋觸控捲動，把手則直接停用 touch-action
  assert.match(homeJs, /addEventListener\('touchmove'[\s\S]{0,80}passive: false/);
  assert.match(homeCss, /\.drag-handle\s*\{[^}]*touch-action:\s*none/);
  assert.match(homeCss, /\.drag-ghost\s*\{/);
});

test('首頁具備全站流量與遊戲遊玩統計元素', () => {
  assert.match(html, /id="hero-stats"/);
  assert.match(html, /id="stat-home-views"/);
  assert.match(html, /id="stat-total-plays"/);
  assert.match(html, /assets\/js\/stats\.js/);
});

test('Stats 模組具備完整的數字格式化與核心方法', () => {
  const Stats = require('../assets/js/stats.js');
  assert.equal(typeof Stats.formatNumber, 'function');
  assert.equal(Stats.formatNumber(0), '0');
  assert.equal(Stats.formatNumber(1234), '1,234');
  assert.equal(Stats.formatNumber(15600), '15.6k');
  assert.equal(Stats.formatNumber(1200000), '1.2M');
  assert.equal(typeof Stats.recordHomeVisit, 'function');
  assert.equal(typeof Stats.recordGamePlay, 'function');
  assert.equal(typeof Stats.getMultipleGames, 'function');
});


test('首頁掃雷卡片文案與遊戲頁預設模式同步', () => {
  const card = html.match(/<article class="game-card" data-id="minesweeper"[\s\S]*?<\/article>/)[0];
  const gameHtml = fs.readFileSync(
    path.join(projectRoot, 'games', 'minesweeper', 'index.html'),
    'utf8'
  );
  const defaultTitle = gameHtml.match(/<span[^>]*id="title-text"[^>]*>([^<]+)<\/span>/)[1];

  assert.match(
    card,
    new RegExp(`<h3>${defaultTitle}</h3>`),
    `卡片標題須與遊戲頁預設模式標題一致：${defaultTitle}`
  );
  assert.match(card, /data-search="[^"]*純粹經典[^"]*"/, '搜尋關鍵字須涵蓋經典玩法');
  assert.match(card, /<p>[^<]*經典[^<]*<\/p>/, '卡片敘述須說明預設的經典玩法');
});
