---
name: run-mini-games
description: 啟動、操作、截圖波波小遊戲（mini-games）這個純前端遊戲合輯。用真的 Chrome 開遊戲、按方向鍵、點格子、抓 console 錯誤、存截圖。當使用者要求 run / start / 跑起來 / 開遊戲 / 截圖 / screenshot / 驗證改動有沒有真的生效 / 冒煙測試 smoke test 時使用。
---

# 跑波波小遊戲

純靜態站，**沒有 build 步驟**：17 款遊戲各自一個 `games/<slug>/` 資料夾，配上根目錄的 `index.html` 首頁。
驅動方式是 `.claude/skills/run-mini-games/driver.mjs` —— 一支零依賴的 Chrome DevTools Protocol 驅動器，
用你機器上現成的 Chrome 加上 Node 內建的 `WebSocket`，**不需要 playwright / puppeteer，也不需要 npm install**。

> 本文所有路徑都相對於專案根目錄 `mini-games/`，指令也請在該目錄下執行。

## 前置需求

只有兩項，這台機器上都已滿足，**不需要安裝任何東西**：

- **Node.js ≥ 22**（需要內建的全域 `WebSocket`）。實測版本 v24.19.0。
- **Chrome 或 Edge**。driver 會自動去這些位置找：
  `C:\Program Files\Google\Chrome\Application\chrome.exe`、
  `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，
  以及 Linux 的 `/usr/bin/google-chrome`。找不到就設 `CHROME_PATH` 環境變數。

專案本身沒有執行期相依，`npm install` 不是跑遊戲的前置條件。

## 跑起來：agent 路徑

### 全站冒煙測試（改完 code 先跑這個）

```bash
npm run smoke
```

把首頁 + 全部 17 款遊戲逐一開起來，點盤面第一格、按四個方向鍵，檢查有沒有 console 錯誤、
未捕捉例外、或本站資源 404，並把每一頁的截圖存到 `.claude/skills/run-mini-games/_shots/<slug>.png`。
**任一款掛掉就 exit 1**，錯誤訊息會帶 `檔名:行號`。

```
✅ index            /index.html
✅ 2048             /games/2048/index.html
❌ lights-out       /games/lights-out/index.html   uncaught: Error: 崩潰
    at HTMLDivElement.<anonymous> (http://127.0.0.1:8977/games/lights-out/lights-out.js:118:126)

17/18 通過
```

只跑幾款、或不想存截圖（比較快）：

```bash
node .claude/skills/run-mini-games/smoke.mjs 2048 loop --no-shots
```

這一層是 `npm test` 抓不到的：`tests/` 只做靜態檢查（檔案在不在、`new Function(src)` 能不能編譯），
**真正的 runtime 崩潰只有把瀏覽器開起來才看得到**。

### pre-push hook（已啟用）

`.githooks/pre-push` 會在每次 `git push` 前擋一道：先跑 `npm test`，再跑冒煙測試（`--no-shots`），
任一關沒過就中止推送。純推 tag 的那次會自動略過（發版流程先推分支、再推 tag，分支那次已經驗過了）。

clone 下來要重新啟用一次（hook 本身有進版控，但 `core.hooksPath` 是本機設定）：

```bash
git config core.hooksPath .githooks
```

真的要硬推：`git push --no-verify`。

### 單一遊戲：寫指令腳本

寫一個純文字檔，一行一個指令，餵給 driver：

```bash
node .claude/skills/run-mini-games/driver.mjs myscript.txt
```

`myscript.txt` 長這樣（實測可跑；2048 每局隨機生成，分數會從 0 往上跑，兩次實測分別是 24 和 36）：

```
goto /games/2048/
wait #tile-layer .tile
count #tile-layer .tile
key ArrowLeft 3
key ArrowUp 3
key ArrowRight 3
key ArrowDown 3
text #score
eval JSON.stringify([...document.querySelectorAll('#tile-layer .tile')].map(t=>t.textContent.trim()))
errors
ss .claude/skills/run-mini-games/_shots/2048.png
```

短指令也可以直接塞在命令列，或從 stdin 灌進去：

```bash
node .claude/skills/run-mini-games/driver.mjs -c "goto /games/loop/" -c "probe"
printf 'goto /games/reversi/\nprobe\n' | node .claude/skills/run-mini-games/driver.mjs -
```

### 指令一覽

| 指令 | 說明 |
|---|---|
| `goto <path>` | 開頁面，如 `/games/2048/`。會等 load 事件再多等 250ms 讓 `init()` 跑完 |
| `probe` | **先用這個**。倒出該頁所有 id、看得見的按鈕（含 `data-*`）、以及子元素最多的幾個容器 |
| `wait <selector>` | 等元素出現，5 秒逾時 |
| `click <selector>` | 在元素中心發**真的**滑鼠事件（mouseMoved → mousePressed → mouseReleased） |
| `key <Key> [n]` | 按鍵 n 次，如 `key ArrowLeft 3`。支援方向鍵 / Enter / Escape / Space / 單一字元 |
| `type <text>` | 逐字輸入到目前焦點元素 |
| `eval <js>` | 執行 JS 並印出 JSON 結果 |
| `assert <js>` | 結果為 falsy 就整個腳本失敗（exit 1） |
| `text <sel>` / `count <sel>` | 取 textContent／算數量 |
| `ss <file.png>` | 截圖，相對路徑以專案根目錄為基準 |
| `errors` | **有本站錯誤就讓腳本失敗**；外站資源失敗只印警告 |
| `logs` / `storage` | 印出 console 訊息／localStorage 內容 |
| `theme light\|dark` | 切換 `prefers-color-scheme`（見下方 Gotchas） |
| `sleep <ms>` / `echo <text>` / `quit` | 雜項 |

### 直接引用 Driver 寫腳本

要跑迴圈或做複雜判斷時，直接 import：

```js
// Windows 上絕對路徑一定要寫成 file:/// URL，否則 Node 會噴 ERR_UNSUPPORTED_ESM_URL_SCHEME
import { Driver } from 'file:///D:/Workspace/Frontend/mini-games/.claude/skills/run-mini-games/driver.mjs';

const d = new Driver({ quiet: true });
await d.start();                 // 起靜態站 + 開 Chrome，d.base 是 http://127.0.0.1:<隨機port>
await d.theme('light');
await d.goto('/games/2048/');
await d.key('ArrowLeft', 3);
console.log(await d.text('#score'), d.errors);
await d.screenshot('.claude/skills/run-mini-games/_shots/x.png');
await d.stop();                  // 一定要收，否則 Chrome 會留在背景
```

想看著它跑（會真的彈出視窗）：`new Driver({ headless: false })`。

## 跑起來：人類路徑

`.vscode/launch.json` 有「開啟首頁 (index.html)」設定，按 F5 就用預設瀏覽器開。
或直接雙擊 `index.html`。

**但 agent 不要走這條**：`file://` 是 opaque origin，Chrome 會讓 `localStorage` 讀寫直接丟例外，
而這個專案每一款遊戲都靠 localStorage 存進度（見 `.agents/AGENTS.md` 的持久化規範），
用 `file://` 開會看到一堆假錯誤。driver 內建的靜態伺服器就是為了避開這件事。

## 單元測試

```bash
npm test
```

`node --test` 跑 `tests/` 底下的檔案，實測 190 多個測試、不到 1 秒跑完。
純靜態檢查：檔案存在、CSS/JS 引用路徑對不對、`new Function(src)` 能不能編譯、
localStorage 讀寫有沒有包在 try/catch 裡。**不會開瀏覽器**，所以 `npm test` 全綠不代表遊戲能玩。

## 盤面 selector 速查表

實測抓出來的（用 `probe` 產生）。改遊戲邏輯要驗證時，直接拿這欄去 `click`：

| 遊戲 | 盤面容器 | 格子 |
|---|---|---|
| 2048 | `#tile-layer` | `.tile`（磚塊，動態生成）／`#board-grid` 是 16 格底板 |
| minesweeper | `#minesweeper-grid` | `button.cell` × 256（標準 16×16） |
| nonogram | `#board` | `div.cell` × 64 + `div.clue-cell` 提示格 |
| color-nonogram | `#board` | `div.cell` × 64 |
| meowdoku | `#board` | `div.cell` × 36 |
| lights-out | `#board` | `div.card` × 16 |
| loop | `#grid-board` | `div.cell-tile` × 25，另有 `#cell-<r>-<c>` id |
| battleship | `#enemy-grid` | `div.cell` × 100 |
| pair | `#game-container` | `div.card` × 20 |
| reversi | `#board` | `div.cell` × 64（**不要點 `.board-row`**，見 Gotchas） |
| make24 | `#keypad-grid` | `button.btn-key` |
| sic-bo | `#bet-table` | `button.bet-cell` × 50（六組注格全在同一個容器內，事件委派） |
| 1a2b / color-text / puzzle / slap | 無格狀盤面 | 按鈕與輸入框驅動，用 `probe` 查 |

## Gotchas

這些是實際撞到才知道的：

- **headless Chrome 的 `prefers-color-scheme` 預設是 dark**。不先下 `theme light`，
  截圖全部會是深色版，很容易誤判成「主題壞掉」。
- **猜歌資料庫（`guess-song`）已下架**，整個資料夾連同首頁卡片一起移除。
  它是全站唯一的 React/Vite 子專案，拿掉之後這裡全部都是原生靜態頁，
  `npm install` 也不再是任何一款遊戲的前置條件。
- **首頁 17 張卡、`games/` 17 個資料夾，兩邊數量一致**。
  smoke.mjs 除了讀首頁連結還會補掃 `games/` 目錄，所以無論卡片在不在首頁都會測到。
- **reversi 的 `.board-row` 是 `display: contents`**，`getBoundingClientRect()` 回 0×0。
  用座標點它會失敗（driver 會報「元素沒有尺寸」）。要點 `#board .cell`。
- **2048 磚塊的 `textContent` 含皮膚 emoji**：進化皮膚下會讀到 `"🐟4"` 而不是 `"4"`。
  要比對數字請用 `data-*` 或把 emoji 濾掉。
- **首頁的 `stats.js` 會打第三方計數器** `countapi.mileshilliard.com`，沒紀錄的 key 一律回 404。
  driver 把非本站 origin 的資源錯誤歸類成警告（`d.warnings`）而不是錯誤，所以不會讓 smoke 變紅。
- **動畫需要時間**：`key` 之間內建 150ms、`click` 後 120ms。連續操作後要讀盤面，
  記得先 `sleep 300` 再 `eval`，否則會讀到動畫中間狀態。
- **Windows 上 ESM 絕對路徑要用 `file:///`**，直接寫 `D:/...` 會噴
  `ERR_UNSUPPORTED_ESM_URL_SCHEME`。

## Troubleshooting

| 症狀 | 原因與解法 |
|---|---|
| `等不到元素：#board .cell` | selector 猜錯了。先跑 `probe` 看那一頁真正的結構，不要沿用別款遊戲的慣例（每款都不一樣） |
| `元素沒有尺寸（可能被隱藏）：...` | 元素是 `display:contents` 或還沒渲染。reversi 的 `.board-row` 就是前者；其餘情況前面加 `wait` |
| `Chrome 沒有寫出 DevToolsActivePort，啟動失敗` | 上一次的 Chrome 卡在背景，見下方「清掉殘留的 Chrome」 |
| `找不到 Chrome/Edge` | 設 `CHROME_PATH` 指到 chrome.exe |
| `ERR_UNSUPPORTED_ESM_URL_SCHEME` | import 用了 `D:/...`，改成 `file:///D:/...` |
| 截圖整片深色，以為主題爛掉 | 先 `theme light`。headless 預設就是 dark |
| smoke 全綠但畫面其實是壞的 | smoke 只驗「沒噴錯」。版面跑掉不會被抓到，要自己開截圖用眼睛看 |

### 清掉殘留的 Chrome

正常收尾（`d.stop()`）不會留東西，但腳本中途爆掉時可能留下背景 Chrome。
driver 開的 Chrome 都帶著 `bobo-cdp-*` 臨時 profile，**只殺這些就好**：

```powershell
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -like '*bobo-cdp-*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Remove-Item "$env:TEMP\bobo-cdp-*" -Recurse -Force -ErrorAction SilentlyContinue
```

> **千萬不要用 `taskkill /IM chrome.exe`** —— 那會把使用者自己開著的瀏覽器分頁全部殺掉。

## 檔案

```
.claude/skills/run-mini-games/
  SKILL.md      這份文件
  driver.mjs    CDP 驅動器（靜態伺服器 + Chrome 啟動 + 指令直譯器，可被 import）
  smoke.mjs     全站冒煙測試，import driver.mjs 的 Driver
  _shots/       截圖產物（已加進 .gitignore）

.githooks/pre-push  推送前自動跑 npm test + 冒煙測試
```
