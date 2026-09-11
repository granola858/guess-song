#!/usr/bin/env node
// 波波小遊戲 driver — 零依賴的 Chrome DevTools Protocol 驅動器。
//
// 為什麼不用 playwright/puppeteer：這個專案是純靜態站，package.json 只有
// tailwind 一條相依。為了跑一次瀏覽器而拉進 ~300MB 的瀏覽器下載不划算。
// Node 22+ 內建 WebSocket、Windows 上本來就裝了 Chrome，兩者湊起來就夠用。
//
// 用法（路徑相對於專案根目錄 mini-games/）：
//   node .claude/skills/run-mini-games/driver.mjs <script.txt>
//   node .claude/skills/run-mini-games/driver.mjs -            # 從 stdin 讀
//   node .claude/skills/run-mini-games/driver.mjs -c "goto /games/2048/" -c "ss a.png"
//
// 任何一行指令失敗 → 印出錯誤並以 exit code 1 結束，所以可直接當 smoke test 用。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SKILL_DIR, '..', '..', '..');

const CHROME_CANDIDATES = [
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const c of CHROME_CANDIDATES) {
    if (c && !c.includes('undefined') && fs.existsSync(c)) return c;
  }
  throw new Error('找不到 Chrome/Edge，請設定 CHROME_PATH 環境變數');
}

// ---------------------------------------------------------------- 靜態伺服器
// 不能用 file://：遊戲全部靠 localStorage 存進度，file:// 的 opaque origin
// 在 Chrome 會讓 localStorage 讀寫直接丟例外。
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
};

function startServer(root) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        let rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
        if (rel.endsWith('/')) rel += 'index.html';
        const file = path.join(root, rel);
        if (!file.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
        const stat = await fsp.stat(file).catch(() => null);
        if (stat?.isDirectory()) { res.writeHead(302, { Location: rel + '/' }).end(); return; }
        if (!stat) { res.writeHead(404).end('not found: ' + rel); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
      } catch (err) {
        res.writeHead(500).end(String(err));
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ----------------------------------------------------------------------- CDP
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      } else {
        for (const h of this.handlers.get(msg.method) || []) h(msg.params, msg.sessionId);
      }
    });
  }
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
    });
  }
}

// keyDown 需要 windowsVirtualKeyCode，否則遊戲的 e.key 讀得到、但某些
// 用 keyCode 判斷的邏輯會失效。方向鍵是 2048 / 貪食蛇類遊戲的命脈。
const KEYS = {
  ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'],
  ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
  Enter: [13, 'Enter'], Escape: [27, 'Escape'], Tab: [9, 'Tab'],
  Backspace: [8, 'Backspace'], Space: [32, 'Space'], ' ': [32, 'Space'],
};
function keyDescriptor(name) {
  if (KEYS[name]) {
    const [code, domCode] = KEYS[name];
    return { key: name === ' ' ? ' ' : name, code: domCode, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  }
  if (name.length === 1) {
    const upper = name.toUpperCase();
    const vk = upper.charCodeAt(0);
    const code = /[a-z]/i.test(name) ? `Key${upper}` : /[0-9]/.test(name) ? `Digit${name}` : '';
    return { key: name, code, text: name, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  }
  throw new Error(`不認得的按鍵：${name}`);
}

// -------------------------------------------------------------------- Driver
export class Driver {
  constructor(opts = {}) {
    this.root = opts.root || PROJECT_ROOT;
    this.headless = opts.headless !== false;
    this.logs = [];      // console.* 訊息
    this.errors = [];    // console.error + 未捕捉例外 + 本站資源載入失敗
    this.warnings = [];  // 外站資源載入失敗（第三方服務掛掉不該讓測試變紅）
    this.quiet = !!opts.quiet;
  }

  log(...a) { if (!this.quiet) console.log(...a); }

  async start() {
    const { server, port } = await startServer(this.root);
    this.server = server;
    this.base = `http://127.0.0.1:${port}`;

    this.profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'bobo-cdp-'));
    const chrome = findChrome();
    this.chrome = spawn(chrome, [
      ...(this.headless ? ['--headless=new'] : []),
      '--remote-debugging-port=0',
      `--user-data-dir=${this.profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--disable-gpu', '--hide-scrollbars', '--mute-audio',
      '--window-size=1280,900',
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    this.chrome.stderr.on('data', () => {});

    // port 0 → Chrome 把實際 port 寫進 profile 目錄的 DevToolsActivePort。
    const portFile = path.join(this.profile, 'DevToolsActivePort');
    let wsUrl = null;
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(portFile)) {
        const [p, pathPart] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
        if (p && pathPart) { wsUrl = `ws://127.0.0.1:${p.trim()}${pathPart.trim()}`; break; }
      }
      await new Promise(r => setTimeout(r, 100));
    }
    if (!wsUrl) throw new Error('Chrome 沒有寫出 DevToolsActivePort，啟動失敗');

    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('連不上 Chrome DevTools WebSocket')), { once: true });
    });
    this.cdp = new CDP(ws);
    this.ws = ws;

    // 用 browser-level session 開新分頁，再 flatten attach，省去打 /json/list。
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    this.session = sessionId;

    await this.cdp.send('Page.enable', {}, sessionId);
    await this.cdp.send('Runtime.enable', {}, sessionId);
    await this.cdp.send('Log.enable', {}, sessionId);
    await this.cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);

    this.cdp.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args || []).map(a => a.value ?? a.description ?? a.type).join(' ');
      this.logs.push(`[${p.type}] ${text}`);
      if (p.type === 'error') this.errors.push(`console.error: ${text}`);
    });
    this.cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails;
      this.errors.push(`uncaught: ${d.exception?.description || d.text}`);
    });
    this.cdp.on('Log.entryAdded', (p) => {
      if (p.entry.level !== 'error') return;
      const line = `${p.entry.source}: ${p.entry.text} ${p.entry.url || ''}`.trim();
      // 外站資源壞掉不算本專案的錯。首頁的 stats.js 會打第三方計數器
      // countapi，沒紀錄的 key 一律回 404，每次都會噴——歸類成警告。
      const external = p.entry.url && !p.entry.url.startsWith(this.base);
      (external ? this.warnings : this.errors).push(line);
    });
    return this;
  }

  s(method, params) { return this.cdp.send(method, params, this.session); }

  async goto(urlPath) {
    // 每次導頁都重置錯誤蒐集，讓 `errors` 只反映當前頁面。
    this.errors = [];
    this.warnings = [];
    this.logs = [];
    const url = urlPath.startsWith('http') ? urlPath : this.base + (urlPath.startsWith('/') ? urlPath : '/' + urlPath);
    const loaded = new Promise(res => {
      const h = () => res();
      this.cdp.on('Page.loadEventFired', h);
      setTimeout(res, 15000);
    });
    await this.s('Page.navigate', { url });
    await loaded;
    await this.sleep(250); // 讓 DOMContentLoaded 之後的 init() 跑完
    return url;
  }

  async eval(expression, { returnByValue = true } = {}) {
    const r = await this.s('Runtime.evaluate', { expression, returnByValue, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(`eval 失敗: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    }
    return r.result.value;
  }

  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async wait(selector, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.eval(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
      await this.sleep(100);
    }
    throw new Error(`等不到元素：${selector}`);
  }

  async rect(selector) {
    const r = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const b = el.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
    })()`);
    if (!r) throw new Error(`找不到元素：${selector}`);
    if (r.w === 0 || r.h === 0) throw new Error(`元素沒有尺寸（可能被隱藏）：${selector}`);
    return r;
  }

  async click(selector) {
    const { x, y } = await this.rect(selector);
    const base = { x, y, button: 'left', clickCount: 1, buttons: 1 };
    // 發真的滑鼠事件而不是 el.click()：好幾款遊戲綁的是 pointerdown/mousedown，
    // el.click() 只送 click，按鈕會沒反應。
    await this.s('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0 });
    await this.s('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
    await this.s('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
    await this.sleep(120);
  }

  async key(name, repeat = 1) {
    const d = keyDescriptor(name);
    for (let i = 0; i < repeat; i++) {
      await this.s('Input.dispatchKeyEvent', { type: 'keyDown', ...d });
      if (d.text) await this.s('Input.dispatchKeyEvent', { type: 'char', ...d });
      await this.s('Input.dispatchKeyEvent', { type: 'keyUp', ...d, text: undefined });
      await this.sleep(150); // 給動畫/合併動畫留時間
    }
  }

  async type(text) {
    for (const ch of text) await this.key(ch, 1);
  }

  async text(selector) {
    return this.eval(`(document.querySelector(${JSON.stringify(selector)})||{}).textContent ?? null`);
  }

  async count(selector) {
    return this.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  }

  async screenshot(file) {
    const out = path.isAbsolute(file) ? file : path.join(this.root, file);
    await fsp.mkdir(path.dirname(out), { recursive: true });
    const { data } = await this.s('Page.captureScreenshot', { format: 'png' });
    await fsp.writeFile(out, Buffer.from(data, 'base64'));
    return out;
  }

  storage() {
    return this.eval(`JSON.stringify(Object.fromEntries(Object.entries(localStorage)))`);
  }

  // headless Chrome 的 prefers-color-scheme 預設是 dark，截圖會全部變深色。
  // 想拍淺色版就先 theme light。
  async theme(name) {
    await this.s('Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: name }] });
  }

  // 每款遊戲的 DOM 慣例都不一樣（#board / #minesweeper-grid / #tile-layer…）。
  // probe 一次把「可以點什麼、盤面長怎樣」倒出來，省去反覆試 selector。
  probe() {
    return this.eval(`(() => {
      const out = { title: document.title, ids: [], buttons: [], grids: [] };
      out.ids = [...document.querySelectorAll('[id]')].map(e => e.id);
      out.buttons = [...document.querySelectorAll('button,[role=button],a.btn')]
        .filter(e => e.offsetParent !== null)
        .slice(0, 40)
        .map(e => ({
          sel: e.id ? '#' + e.id : e.className ? '.' + String(e.className).trim().split(/\\s+/).join('.') : e.tagName,
          text: (e.textContent || '').trim().slice(0, 24),
          data: Object.keys(e.dataset || {}).length ? JSON.stringify(e.dataset) : undefined,
        }));
      // 盤面 = 子元素最多的那幾個容器
      out.grids = [...document.querySelectorAll('div,main,section,tbody')]
        .filter(e => e.children.length >= 6)
        .sort((a, b) => b.children.length - a.children.length)
        .slice(0, 5)
        .map(e => ({
          sel: e.id ? '#' + e.id : '.' + String(e.className).trim().split(/\\s+/)[0],
          children: e.children.length,
          child: e.firstElementChild.tagName.toLowerCase() +
            (e.firstElementChild.className ? '.' + String(e.firstElementChild.className).trim().split(/\\s+/).join('.') : ''),
        }));
      return JSON.stringify(out, null, 1);
    })()`);
  }

  async stop() {
    try { this.ws?.close(); } catch {}
    try { this.chrome?.kill(); } catch {}
    await new Promise(r => this.server ? this.server.close(r) : r());
    // Chrome 還握著 profile 的檔案 handle，多試幾次再放棄。
    for (let i = 0; i < 5; i++) {
      try { await fsp.rm(this.profile, { recursive: true, force: true }); break; }
      catch { await new Promise(r => setTimeout(r, 200)); }
    }
  }
}

// ------------------------------------------------------------ 指令腳本直譯器
const COMMANDS = {
  async goto(d, arg) { d.log(`  → ${await d.goto(arg)}`); },
  async wait(d, arg) { await d.wait(arg); d.log(`  ✓ 出現 ${arg}`); },
  async sleep(d, arg) { await d.sleep(Number(arg)); },
  async click(d, arg) { await d.click(arg); d.log(`  ✓ 點擊 ${arg}`); },
  async key(d, arg) {
    const [name, n] = arg.split(/\s+/);
    await d.key(name, Number(n) || 1);
    d.log(`  ✓ 按鍵 ${name} x${Number(n) || 1}`);
  },
  async type(d, arg) { await d.type(arg); d.log(`  ✓ 輸入 ${arg}`); },
  async eval(d, arg) { d.log(`  = ${JSON.stringify(await d.eval(arg))}`); },
  async text(d, arg) { d.log(`  = ${JSON.stringify((await d.text(arg) || '').trim().slice(0, 300))}`); },
  async count(d, arg) { d.log(`  = ${await d.count(arg)}`); },
  async ss(d, arg) { d.log(`  📸 ${await d.screenshot(arg)}`); },
  async storage(d) { d.log(`  = ${await d.storage()}`); },
  async theme(d, arg) { await d.theme(arg); d.log(`  ✓ prefers-color-scheme=${arg}`); },
  async probe(d) { d.log(await d.probe()); },
  async logs(d) { d.log(d.logs.length ? d.logs.map(l => '  ' + l).join('\n') : '  (無 console 訊息)'); },
  async errors(d) {
    if (d.warnings.length) d.log(d.warnings.map(w => '  ⚠ 外站資源 ' + w).join('\n'));
    if (!d.errors.length) { d.log('  ✓ 無錯誤'); return; }
    throw new Error(`頁面有 ${d.errors.length} 個錯誤:\n` + d.errors.map(e => '    ' + e).join('\n'));
  },
  async assert(d, arg) {
    const v = await d.eval(arg);
    if (!v) throw new Error(`assert 失敗: ${arg} → ${JSON.stringify(v)}`);
    d.log(`  ✓ assert ${arg}`);
  },
  async echo(d, arg) { d.log(arg); },
  async quit() { return 'quit'; },
};

export async function runScript(driver, lines) {
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sp = line.indexOf(' ');
    const cmd = sp === -1 ? line : line.slice(0, sp);
    const arg = sp === -1 ? '' : line.slice(sp + 1).trim();
    const fn = COMMANDS[cmd];
    if (!fn) throw new Error(`不認得的指令：${cmd}（可用：${Object.keys(COMMANDS).join(', ')}）`);
    driver.log(`> ${line}`);
    if (await fn(driver, arg) === 'quit') return;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let lines = [];
  if (argv[0] === '-c') {
    for (let i = 0; i < argv.length; i += 2) if (argv[i] === '-c') lines.push(argv[i + 1]);
  } else if (argv[0] === '-' || argv.length === 0) {
    lines = (await new Promise(res => {
      let b = ''; process.stdin.setEncoding('utf8');
      process.stdin.on('data', c => b += c); process.stdin.on('end', () => res(b));
    })).split('\n');
  } else {
    lines = fs.readFileSync(argv[0], 'utf8').split('\n');
  }

  const d = new Driver();
  let code = 0;
  try {
    await d.start();
    d.log(`靜態站台: ${d.base}\n`);
    await runScript(d, lines);
    d.log('\n✅ 腳本執行完畢');
  } catch (err) {
    console.error(`\n❌ ${err.message}`);
    if (d.errors?.length) console.error('頁面錯誤:\n' + d.errors.map(e => '  ' + e).join('\n'));
    code = 1;
  } finally {
    await d.stop();
  }
  process.exit(code);
}

// Windows 上 import.meta.url 是 file:///D:/...（三條斜線），手工拼字串會對不起來。
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
