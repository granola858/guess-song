(() => {
  'use strict';

  const KEY = 'bobo-home-preferences-v2';
  const LEGACY = 'bobo-mini-games-pinned-cards';
  const root = document.documentElement;
  const body = document.body;
  const grid = document.getElementById('game-grid');
  const cards = [...grid.querySelectorAll('.game-card')];
  const ids = new Set(cards.map((c) => c.dataset.id));
  const defaults = cards.map((c) => c.dataset.id);
  const byId = new Map(cards.map((c) => [c.dataset.id, c]));
  const hrefId = new Map(cards.map((c) => [c.querySelector('a').getAttribute('href'), c.dataset.id]));

  let filter = 'all';
  let query = '';
  let dragged = null;
  let timer;
  const gameStats = new Map(); // id -> play count

  const safe = (v) => (Array.isArray(v) ? v.filter((id, i, a) => ids.has(id) && a.indexOf(id) === i) : []);

  const load = () => {
    let s = {};
    try {
      s = JSON.parse(localStorage.getItem(KEY) || '{}');
    } catch (_) {}

    let order = [...safe(s.order), ...defaults.filter((id) => !safe(s.order).includes(id))];
    if (!safe(s.order).length) {
      try {
        const pins = JSON.parse(localStorage.getItem(LEGACY) || '[]')
          .map((h) => hrefId.get(h))
          .filter(Boolean);
        order = [...new Set([...pins, ...order])];
      } catch (_) {}
    }

    return {
      theme: ['dark', 'light'].includes(s.theme) ? s.theme : root.dataset.theme,
      order,
      hidden: safe(s.hidden)
    };
  };

  let prefs = load();

  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch (e) {
      console.warn('首頁偏好無法儲存。', e);
    }
  };

  const title = (c) => c.querySelector('h3').textContent.trim();

  const toast = (m) => {
    const t = document.getElementById('toast');
    t.textContent = m;
    t.classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(() => t.classList.remove('show'), 2200);
  };

  const applyOrder = (customOrder = null) => {
    const list = customOrder || prefs.order;
    list.forEach((id) => {
      const c = byId.get(id);
      if (c) grid.insertBefore(c, document.getElementById('empty-state'));
    });
    [...grid.querySelectorAll('.game-card')].forEach((c, i) => c.style.setProperty('--index', i));
  };

  const render = () => {
    const hidden = new Set(prefs.hidden);
    let shown = 0;

    // 若為熱門排行，依遊玩次數由高到低排序卡片
    if (filter === 'popular') {
      const sortedIds = [...ids].sort((a, b) => (gameStats.get(b) || 0) - (gameStats.get(a) || 0));
      applyOrder(sortedIds);
    } else {
      applyOrder(prefs.order);
    }

    cards.forEach((c) => {
      const matchFilter = filter === 'all' || filter === 'popular' || c.dataset.category.split(' ').includes(filter);
      const matchSearch =
        !query ||
        c.dataset.search.toLocaleLowerCase('zh-Hant').includes(query) ||
        title(c).toLocaleLowerCase('zh-Hant').includes(query);
      c.hidden = hidden.has(c.dataset.id) || !matchFilter || !matchSearch;
      if (!c.hidden) shown++;
    });

    document.getElementById('visible-count').textContent = shown;
    document.getElementById('empty-state').classList.toggle('show', !shown);

    const list = document.getElementById('hidden-list');
    list.replaceChildren();
    prefs.hidden.forEach((id) => {
      const c = byId.get(id);
      if (!c) return;
      const b = document.createElement('button');
      b.className = 'restore-button';
      b.dataset.restore = id;
      b.textContent = `＋ ${title(c)}`;
      list.append(b);
    });

    document.getElementById('hidden-panel').hidden = !(body.classList.contains('editing') && prefs.hidden.length);
  };

  const theme = (t) => {
    prefs.theme = t;
    root.dataset.theme = t;
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
      metaThemeColor.content = t === 'dark' ? '#14121e' : '#fff8ed';
    }
    const b = document.getElementById('theme-toggle');
    const next = t === 'dark' ? '淺色' : '深色';
    b.ariaLabel = `切換${next}模式`;
    b.title = `切換${next}模式`;
    save();
  };

  const edit = (on) => {
    body.classList.toggle('editing', on);
    const b = document.getElementById('edit-toggle');
    b.setAttribute('aria-pressed', String(on));
    b.querySelector('.edit-label').textContent = on ? '完成編輯' : '編輯首頁';
    if (!on) {
      clearPending();
      if (dragged) endDrag(false);
    }
    render();
  };

  const persistOrder = () => {
    prefs.order = [...grid.querySelectorAll('.game-card')].map((c) => c.dataset.id);
    save();
  };

  const move = (c, d) => {
    const visible = [...grid.querySelectorAll('.game-card:not([hidden])')];
    const i = visible.indexOf(c);
    const target = visible[i + d];
    if (!target) return;
    d < 0 ? grid.insertBefore(c, target) : grid.insertBefore(target, c);
    persistOrder();
    toast(`${title(c)}已向${d < 0 ? '前' : '後'}移動`);
    c.querySelector(d < 0 ? '.move-prev' : '.move-next').focus();
  };

  // ─── 拖曳排序（Pointer Events：滑鼠、觸控與觸控筆共用同一套流程）───
  const HOLD_MS = 260; // 觸控長按多久才啟動拖曳
  const HOLD_TOLERANCE = 8; // 長按期間手指位移超過此值視為捲動頁面
  const MOUSE_THRESHOLD = 5; // 滑鼠移動超過此距離才算拖曳
  const EDGE = 84; // 靠近視窗上下緣多少距離開始自動捲動
  const EDGE_SPEED = 16;

  let pending = null; // 尚未成立的拖曳意圖
  let ghost = null; // 跟隨指標的浮動分身
  let dragPointer = null; // 目前拖曳中的指標 ID，避免多指觸控互相干擾
  let dragCols = 1; // 拖曳開始時的格線欄數
  let pointerX = 0;
  let pointerY = 0;
  let originX = 0;
  let originY = 0;
  let scrollFrame = 0;

  // 以卡片實際位置推算欄數（比解析 grid-template-columns 可靠）
  const columns = () => {
    const rects = [...grid.querySelectorAll('.game-card:not([hidden])')].map((c) => c.getBoundingClientRect());
    if (!rects.length) return 1;
    return rects.filter((r) => Math.abs(r.top - rects[0].top) < 4).length;
  };

  const clearPending = () => {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  };

  // 拖到視窗上下緣時自動捲動，方便在手機上把卡片移到很遠的位置
  const autoScroll = () => {
    if (!dragged) return (scrollFrame = 0);
    const overTop = pointerY - EDGE;
    const overBottom = pointerY - (innerHeight - EDGE);
    let dy = 0;
    if (overTop < 0) dy = Math.max(-EDGE_SPEED, (overTop / EDGE) * EDGE_SPEED);
    else if (overBottom > 0) dy = Math.min(EDGE_SPEED, (overBottom / EDGE) * EDGE_SPEED);
    if (dy) {
      scrollBy(0, dy);
      moveDrag(pointerX, pointerY); // 捲動後重新判斷手指下方的落點
    }
    scrollFrame = requestAnimationFrame(autoScroll);
  };

  const startDrag = (c, x, y, id) => {
    clearPending();
    dragged = c;
    dragPointer = id;
    dragCols = columns();
    originX = pointerX = x;
    originY = pointerY = y;

    const r = c.getBoundingClientRect();
    ghost = c.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    ghost.style.width = `${r.width}px`;
    ghost.style.height = `${r.height}px`;
    ghost.style.left = `${r.left}px`;
    ghost.style.top = `${r.top}px`;
    document.body.append(ghost);

    c.classList.add('dragging');
    body.classList.add('dragging-active');
    if (navigator.vibrate) navigator.vibrate(12);
    scrollFrame = requestAnimationFrame(autoScroll);
  };

  const moveDrag = (x, y) => {
    pointerX = x;
    pointerY = y;
    ghost.style.transform = `translate3d(${x - originX}px, ${y - originY}px, 0) scale(1.04) rotate(1.2deg)`;

    const over = document.elementFromPoint(x, y);
    const target = over && over.closest ? over.closest('.game-card') : null;
    if (!target || target === dragged || target.hidden || target.parentElement !== grid) return;

    // 多欄時以左右中線判斷前後，單欄（手機）時改用上下中線
    const r = target.getBoundingClientRect();
    const after = dragCols > 1 ? x > r.left + r.width / 2 : y > r.top + r.height / 2;
    const ref = after ? target.nextElementSibling : target;
    if (ref === dragged || dragged.nextElementSibling === ref) return;
    grid.insertBefore(dragged, ref);
  };

  const endDrag = (notify = true) => {
    if (scrollFrame) cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    if (ghost) ghost.remove();
    ghost = null;
    body.classList.remove('dragging-active');
    const c = dragged;
    dragged = null;
    dragPointer = null;
    if (!c) return;
    c.classList.remove('dragging');
    persistOrder();
    if (notify) toast('遊戲順序已儲存');
  };

  const beginPointer = (c, e) => {
    if (!body.classList.contains('editing') || dragged || e.button > 0) return;
    if (e.target.closest('.mini-button')) return;

    const x = e.clientX;
    const y = e.clientY;
    const id = e.pointerId;

    if (e.target.closest('.drag-handle')) {
      // 拖曳把手已設定 touch-action: none，觸控可直接開始
      e.preventDefault();
      return startDrag(c, x, y, id);
    }

    if (e.pointerType === 'touch') {
      pending = { card: c, x, y, id, touch: true, timer: setTimeout(() => startDrag(c, x, y, id), HOLD_MS) };
    } else {
      pending = { card: c, x, y, id, touch: false, timer: 0 };
    }
  };

  addEventListener(
    'pointermove',
    (e) => {
      if (dragged) {
        if (e.pointerId === dragPointer) moveDrag(e.clientX, e.clientY);
        return;
      }
      if (!pending || e.pointerId !== pending.id) return;
      const dist = Math.hypot(e.clientX - pending.x, e.clientY - pending.y);
      if (pending.touch) {
        if (dist > HOLD_TOLERANCE) clearPending(); // 判定為捲動頁面，取消長按
      } else if (dist > MOUSE_THRESHOLD) {
        startDrag(pending.card, pending.x, pending.y, pending.id);
        moveDrag(e.clientX, e.clientY);
      }
    },
    { passive: true }
  );

  const finish = (e) => {
    if (pending && e.pointerId === pending.id) clearPending();
    if (dragged && e.pointerId === dragPointer) endDrag();
  };
  addEventListener('pointerup', finish);
  addEventListener('pointercancel', finish);

  // 拖曳中阻擋頁面捲動與長按選單，並停用瀏覽器原生拖曳
  addEventListener('touchmove', (e) => dragged && e.preventDefault(), { passive: false });
  addEventListener('contextmenu', (e) => dragged && e.preventDefault());
  grid.addEventListener('dragstart', (e) => body.classList.contains('editing') && e.preventDefault());

  // 初始化每張卡片的結構（按鈕控制器與遊玩次數標籤）
  cards.forEach((c) => {
    c.append(document.getElementById('controls-template').content.cloneNode(true));
    c.querySelector('.move-prev').onclick = () => move(c, -1);
    c.querySelector('.move-next').onclick = () => move(c, 1);
    c.querySelector('.hide-card').onclick = () => {
      prefs.hidden = [...new Set([...prefs.hidden, c.dataset.id])];
      save();
      render();
      toast(`已隱藏「${title(c)}」`);
    };

    // 將 card-top 整理為 card-tags（包含 card-badge 與 card-play-tag）
    const cardTop = c.querySelector('.card-top');
    const existingBadge = cardTop?.querySelector('.card-badge');
    if (cardTop && existingBadge) {
      const tagsWrapper = document.createElement('span');
      tagsWrapper.className = 'card-tags';

      const playTag = document.createElement('span');
      playTag.className = 'card-play-tag';
      playTag.title = '累積遊玩次數';
      playTag.innerHTML = `
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 23c-4.97 0-9-4.03-9-9 0-4.13 2.85-7.7 6.94-8.68.42-.1.82.21.82.64v2.1c0 .36.24.67.59.76 1.83.47 3.23 1.9 3.61 3.73.08.38.41.65.8.65h.05c.48 0 .85-.43.77-.9-.4-2.39-1.84-4.47-3.92-5.59-.39-.21-.49-.71-.22-1.04 1.77-2.18 4.41-3.67 7.37-3.67.31 0 .61.02.91.05.41.05.7.4.65.81C20.67 8.04 17.8 13.5 17.8 14c0 .66.54 1.2 1.2 1.2.5 0 .95-.31 1.12-.78.43-1.18.68-2.45.68-3.77 0-.41.34-.75.75-.75h.05c.38 0 .7.28.74.66.42 3.66-.75 7.3-3.18 9.87C17.39 22.06 14.8 23 12 23z"/>
        </svg>
        <span class="play-num" id="stat-game-${c.dataset.id}">--</span> 次
      `;

      cardTop.replaceChild(tagsWrapper, existingBadge);
      tagsWrapper.append(existingBadge, playTag);
    }

    // 拖曳排序：滑鼠按住卡片、觸控長按卡片或直接按住拖曳把手皆可啟動
    c.addEventListener('pointerdown', (e) => beginPointer(c, e));
  });

  // 工具列與篩選按鈕事件
  document.getElementById('theme-toggle').onclick = () => theme(root.dataset.theme === 'dark' ? 'light' : 'dark');
  document.getElementById('edit-toggle').onclick = () => edit(!body.classList.contains('editing'));
  document.getElementById('game-search').oninput = (e) => {
    query = e.target.value.trim().toLocaleLowerCase('zh-Hant');
    render();
  };
  document.querySelectorAll('.filter-button').forEach((b) => {
    b.onclick = () => {
      filter = b.dataset.filter;
      document.querySelectorAll('.filter-button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      render();
    };
  });
  document.getElementById('hidden-list').onclick = (e) => {
    const b = e.target.closest('[data-restore]');
    if (!b) return;
    const id = b.dataset.restore;
    prefs.hidden = prefs.hidden.filter((x) => x !== id);
    save();
    render();
    toast(`「${title(byId.get(id))}」已回到遊戲櫃`);
  };
  document.getElementById('restore-all').onclick = () => {
    prefs.hidden = [];
    save();
    render();
    toast('所有遊戲都回來了');
  };
  document.getElementById('random-game').onclick = () => {
    const available = cards.filter((c) => !c.hidden);
    if (!available.length) return toast('目前沒有符合條件的遊戲');
    const c = available[Math.floor(Math.random() * available.length)];
    c.scrollIntoView({ behavior: 'smooth', block: 'center' });
    c.animate(
      [
        { transform: 'translateY(0)' },
        { transform: 'translateY(-10px)', boxShadow: '0 0 0 5px var(--accent)' },
        { transform: 'translateY(0)' }
      ],
      { duration: 700 }
    );
    toast(`今天就玩「${title(c)}」！`);
  };
  addEventListener('scroll', () => document.getElementById('site-header').classList.toggle('scrolled', scrollY > 4), {
    passive: true
  });

  // 載入並渲染統計數據
  const initStats = () => {
    if (typeof Stats === 'undefined') return;

    const homeViewsEl = document.getElementById('stat-home-views');
    const totalPlaysEl = document.getElementById('stat-total-plays');

    // 1. 先載入本機快取數據，實現秒開無白畫面
    const cachedHomeViews = Stats.getCached('home-views', 0);
    if (homeViewsEl && cachedHomeViews > 0) {
      homeViewsEl.textContent = Stats.formatNumber(cachedHomeViews);
    }

    let initialTotalPlays = 0;
    defaults.forEach((id) => {
      const cached = Stats.getCached(`game-${id}`, 0);
      gameStats.set(id, cached);
      initialTotalPlays += cached;
      const el = document.getElementById(`stat-game-${id}`);
      if (el && cached > 0) {
        el.textContent = Stats.formatNumber(cached);
      }
    });

    if (totalPlaysEl && initialTotalPlays > 0) {
      totalPlaysEl.textContent = Stats.formatNumber(initialTotalPlays);
    }

    // 2. 其餘工作等瀏覽器閒下來再做：這些數字是輔助資訊，
    //    不該和首屏的版面與互動搶資源
    idle(() => syncStatsFromApi(homeViewsEl, totalPlaysEl));
  };

  // 瀏覽器閒置時執行；不支援 requestIdleCallback 的環境退回 setTimeout
  const idle = (fn) =>
    typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 200);

  const syncStatsFromApi = (homeViewsEl, totalPlaysEl) => {
    // 向 API 記錄首頁造訪並獲取最新人次
    Stats.recordHomeVisit().then((res) => {
      if (res && typeof res.value === 'number' && homeViewsEl) {
        Stats.animateCount(homeViewsEl, res.value);
      }
    });

    // 批次讀取各遊戲最新遊玩數（快取新鮮時不會發出任何請求）
    Stats.getMultipleGames(defaults).then((statsMap) => {
      let totalPlays = 0;
      defaults.forEach((id) => {
        const count = typeof statsMap[id] === 'number' ? statsMap[id] : (gameStats.get(id) || 0);
        gameStats.set(id, count);
        totalPlays += count;
        const el = document.getElementById(`stat-game-${id}`);
        if (el) {
          Stats.animateCount(el, count);
        }
      });
      if (totalPlaysEl) {
        Stats.animateCount(totalPlaysEl, totalPlays);
      }
      // 若當前在熱門排行篩選，重新觸發渲染排序
      if (filter === 'popular') {
        render();
      }
    });
  };

  // ─── 捲動位置記憶 ────────────────────────────────────────────────────
  // 從首頁點進遊戲、再按遊戲裡的「回首頁」是一次全新的導頁（不是上一頁），
  // 瀏覽器不會幫忙還原捲動位置，玩家每次都被丟回最上面。
  // 這裡自己把位置記在 sessionStorage（只活在這個分頁，關掉就沒了）。
  const SCROLL_KEY = 'bobo-home-scroll';

  const saveScroll = () => {
    try {
      sessionStorage.setItem(SCROLL_KEY, String(Math.round(scrollY)));
    } catch (_) {}
  };

  const restoreScroll = () => {
    let y = 0;
    try {
      y = Number(sessionStorage.getItem(SCROLL_KEY)) || 0;
    } catch (_) {}
    if (!(y > 0)) return;
    // html { scroll-behavior: smooth } 會讓還原變成一段可見的捲動動畫，
    // 所以還原期間暫時關掉，跳完再還回去。
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    const jump = () => scrollTo(0, Math.min(y, Math.max(0, document.body.scrollHeight - innerHeight)));
    jump();
    // 字型與卡片動畫會讓版面在載入後再微調一次高度，下一幀補跳一次才會準
    requestAnimationFrame(() => {
      jump();
      root.style.scrollBehavior = previous;
    });
  };

  addEventListener('pagehide', saveScroll);
  // pagehide 在部分行動瀏覽器切到背景時不會觸發，visibilitychange 補一道
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveScroll();
  });

  applyOrder();
  theme(prefs.theme);
  render();
  initStats();
  restoreScroll();

  // 當使用者點擊「回首頁」或從上一頁返回（bfcache）時，重新同步最新數據
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      // bfcache 會自己還原捲動位置，這裡不要再跳一次跟它打架
      initStats();
    }
  });
})();
