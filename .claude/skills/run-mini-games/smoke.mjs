#!/usr/bin/env node
// 全站冒煙測試：把首頁列出的每一款遊戲真的開起來、戳一下、看有沒有噴錯。
//
//   node .claude/skills/run-mini-games/smoke.mjs              # 全部
//   node .claude/skills/run-mini-games/smoke.mjs 2048 loop    # 只跑指定幾款
//   node .claude/skills/run-mini-games/smoke.mjs --no-shots   # 不存截圖（比較快）
//
// 任一款有 console 錯誤／未捕捉例外／資源 404 就 exit 1。
// 這是 node --test 抓不到的那一層：tests/ 只做靜態檢查（檔案存在、語法能編譯），
// 真正的 runtime 崩潰只有把瀏覽器開起來才看得到。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Driver } from './driver.mjs';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SKILL_DIR, '..', '..', '..');

// 進入點以首頁的卡片連結為準——guess-song 的實際入口是 dist/index.html，
// 光掃 games/ 目錄會掃到那份跑不起來的 Vite dev 版 index.html。
function entries() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const found = new Map();
  for (const m of html.matchAll(/href="(games\/([^"/]+)\/[^"]*)"/g)) {
    if (!found.has(m[2])) found.set(m[2], '/' + m[1]);
  }
  // 沒被首頁連到的遊戲也要跑，否則壞了不會有人發現
  for (const d of fs.readdirSync(path.join(ROOT, 'games'), { withFileTypes: true })) {
    if (d.isDirectory() && !found.has(d.name)) found.set(d.name, `/games/${d.name}/`);
  }
  return [['index', '/index.html'], ...found];
}

async function poke(d) {
  // 不針對個別遊戲寫腳本：點盤面第一格、按幾個方向鍵，通用地把輸入處理器踩一遍。
  const target = await d.eval(`(() => {
    const g = [...document.querySelectorAll('div,main,section,tbody')]
      .filter(e => e.children.length >= 6 && e.getBoundingClientRect().width > 80)
      .sort((a, b) => b.children.length - a.children.length)[0];
    if (!g) return null;
    const c = g.firstElementChild;
    const b = c.getBoundingClientRect();
    return b.width > 0 ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
  })()`);
  if (target) {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await d.s('Input.dispatchMouseEvent',
        { ...target, type, button: 'left', clickCount: 1, buttons: type === 'mouseMoved' ? 0 : 1 });
    }
    await d.sleep(150);
  }
  for (const k of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']) await d.key(k);
  return !!target;
}

const args = process.argv.slice(2);
const shots = !args.includes('--no-shots');
const only = args.filter(a => !a.startsWith('--'));

const d = new Driver({ quiet: true });
await d.start();
await d.theme('light');
console.log(`靜態站台 ${d.base}\n`);

const rows = [];
for (const [slug, url] of entries()) {
  if (only.length && !only.includes(slug)) continue;
  let status = 'ok', detail = '';
  try {
    await d.goto(url);
    await d.sleep(400);
    const body = await d.eval(`document.body.innerText.trim().length`);
    if (!body) throw new Error('頁面沒有可見內容');
    const poked = await poke(d);
    detail = poked ? '' : '（找不到盤面，只按了方向鍵）';
    if (d.warnings.length) detail += ` ⚠外站 ${d.warnings.length} 筆`;
    if (d.errors.length) throw new Error(d.errors.join(' | '));
    if (shots) await d.screenshot(`.claude/skills/run-mini-games/_shots/${slug}.png`);
  } catch (err) {
    status = 'FAIL';
    detail = err.message.slice(0, 300);
  }
  rows.push({ slug, url, status, detail });
  console.log(`${status === 'ok' ? '✅' : '❌'} ${slug.padEnd(16)} ${url.padEnd(34)} ${detail}`);
}

await d.stop();
const failed = rows.filter(r => r.status === 'FAIL');
console.log(`\n${rows.length - failed.length}/${rows.length} 通過`);
if (shots) console.log(`截圖：.claude/skills/run-mini-games/_shots/`);
process.exit(failed.length ? 1 : 0);
