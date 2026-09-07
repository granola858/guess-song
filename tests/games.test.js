const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const gamesRoot = path.join(projectRoot, 'games');

// 自動掃描 games/ 底下所有原生遊戲，新增遊戲不需再手動維護清單。
// guess-song 為 React/Vite 專案，產出物在 dist/，不適用以下原生資源檢查。
const nativeGames = fs.readdirSync(gamesRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name !== 'guess-song')
  .map(entry => entry.name)
  .sort();

const gamePages = nativeGames.map(slug => ({
  slug,
  dir: path.join(gamesRoot, slug),
  htmlPath: path.join(gamesRoot, slug, 'index.html')
}));

// 首頁與各遊戲頁共用同一組檢查，僅路徑基準不同
const allPages = [
  { slug: 'index', dir: projectRoot, htmlPath: path.join(projectRoot, 'index.html') },
  ...gamePages
];

test('games/ 底下每個遊戲資料夾都有 index.html 進入點', () => {
  assert.ok(gamePages.length >= 11, `遊戲數量異常：${gamePages.length}`);
  gamePages.forEach(({ slug, htmlPath }) => {
    assert.ok(fs.existsSync(htmlPath), `games/${slug}/ 缺少 index.html`);
  });
});

test('所有頁面引用的 CSS 檔案皆存在且非空', () => {
  allPages.forEach(({ slug, dir, htmlPath }) => {
    const content = fs.readFileSync(htmlPath, 'utf8');
    const cssMatches = [...content.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/gi)].map(m => m[1]);

    cssMatches.forEach(href => {
      if (href.startsWith('http')) return; // 跳過外部 CDN
      const cssPath = path.resolve(dir, href);
      assert.ok(fs.existsSync(cssPath), `${slug} 引用的 CSS 不存在: ${href}`);
      assert.ok(fs.statSync(cssPath).size > 0, `${href} 是空檔案`);
    });
  });
});

test('所有頁面引用的 JS 檔案皆存在且能通過語法編譯', () => {
  allPages.forEach(({ slug, dir, htmlPath }) => {
    const content = fs.readFileSync(htmlPath, 'utf8');
    const jsMatches = [...content.matchAll(/<script\s+src="([^"]+)"/gi)].map(m => m[1]);

    jsMatches.forEach(src => {
      if (src.startsWith('http')) return; // 跳過外部 CDN
      const jsPath = path.resolve(dir, src);
      assert.ok(fs.existsSync(jsPath), `${slug} 引用的 JS 不存在: ${src}`);
      const source = fs.readFileSync(jsPath, 'utf8');
      assert.doesNotThrow(() => new Function(source), `${src} 語法編譯失敗`);
    });
  });
});

test('所有頁面引用的 Favicon 圖示皆存在', () => {
  allPages.forEach(({ slug, dir, htmlPath }) => {
    const content = fs.readFileSync(htmlPath, 'utf8');
    const iconMatch = content.match(/<link\s+rel="icon"[^>]*href="([^"]+)"/i);
    if (!iconMatch) return;
    const iconPath = path.resolve(dir, iconMatch[1]);
    assert.ok(fs.existsSync(iconPath), `${slug} 的 Favicon 不存在: ${iconMatch[1]}`);
  });
});

test('每個遊戲的 CSS 與 JS 都放在自己的資料夾內', () => {
  gamePages.forEach(({ slug, dir }) => {
    const files = fs.readdirSync(dir);
    assert.ok(files.some(f => f.endsWith('.css')), `games/${slug}/ 沒有專屬 CSS`);
    assert.ok(files.some(f => f.endsWith('.js')), `games/${slug}/ 沒有專屬 JS`);
  });
});

test('Meowdoku 貓咪圖片資源完整且路徑正確', () => {
  const meowdokuDir = path.join(gamesRoot, 'meowdoku');
  const meowdokuJs = fs.readFileSync(path.join(meowdokuDir, 'meowdoku.js'), 'utf8');
  for (let i = 1; i <= 8; i++) {
    const expectedPath = `images/${i}.svg`;
    assert.ok(meowdokuJs.includes(expectedPath), `meowdoku.js 缺少圖片路徑: ${expectedPath}`);
    assert.ok(fs.existsSync(path.join(meowdokuDir, expectedPath)), `找不到圖片: ${expectedPath}`);
  }
});

test('所有遊戲皆具備回首頁按鈕', () => {
  gamePages.forEach(({ slug, htmlPath }) => {
    const content = fs.readFileSync(htmlPath, 'utf8');
    assert.ok(
      /href=["']\.\.\/\.\.\/index\.html["']/.test(content),
      `games/${slug}/ 缺少回首頁連結`
    );
  });
});

test('所有遊戲都會透過共用 Stats 模組記錄遊玩次數', () => {
  gamePages.forEach(({ slug, htmlPath }) => {
    const content = fs.readFileSync(htmlPath, 'utf8');
    assert.match(content, /\.\.\/\.\.\/assets\/js\/stats\.js/, `games/${slug}/ 未引用共用 stats.js`);
    assert.match(content, /Stats\.recordGamePlay\(/, `games/${slug}/ 未呼叫 recordGamePlay`);
  });
});

test('遊戲頁不得再引用已移除的集中式 assets 路徑', () => {
  gamePages.forEach(({ slug, dir }) => {
    fs.readdirSync(dir)
      .filter(f => f.endsWith('.html') || f.endsWith('.js') || f.endsWith('.css'))
      .forEach(file => {
        const content = fs.readFileSync(path.join(dir, file), 'utf8');
        assert.doesNotMatch(content, /["'(]assets\/(css|js|images|favicons)\//,
          `games/${slug}/${file} 仍引用舊的集中式 assets 路徑`);
      });
  });
});

test('Nonogram 按鈕使用標準 click 事件且不包含 bindFastPress 幽靈點擊機制', () => {
  const nonogramJs = fs.readFileSync(path.join(gamesRoot, 'nonogram', 'nonogram.js'), 'utf8');
  assert.ok(!nonogramJs.includes('bindFastPress'), 'nonogram.js 仍殘留 bindFastPress');
  assert.ok(nonogramJs.includes("checkBtn.addEventListener('click'"), 'checkBtn 未綁定標準 click 事件');
  assert.ok(nonogramJs.includes("menuBtn.addEventListener('click'"), 'menuBtn 未綁定標準 click 事件');
});
