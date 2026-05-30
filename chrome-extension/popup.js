/**
 * popup.js - 动态注入方案（多平台支持）。
 * 所有代码通过 scripting.executeScript 注入到 MAIN world 执行。
 */

const analyzeBtn = document.getElementById('analyzeBtn');
const statusText = document.getElementById('statusText');
const apiKeyInput = document.getElementById('apiKey');
const badge = document.getElementById('badge');

let currentTabId = null;
let currentPlatform = null;  // 'xiaohongshu' | 'douyin' | null

const PLATFORM_NAMES = { xiaohongshu: '小红书', douyin: '抖音' };

(async () => {
  const stored = await chrome.storage.local.get(['deepseek_api_key']);
  if (stored.deepseek_api_key) {
    apiKeyInput.value = stored.deepseek_api_key;
  }

  apiKeyInput.addEventListener('change', () => {
    chrome.storage.local.set({ deepseek_api_key: apiKeyInput.value.trim() });
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    currentTabId = tab.id;
    const url = tab.url || '';
    if (url.includes('xiaohongshu.com/explore')) {
      currentPlatform = 'xiaohongshu';
    } else if (url.includes('douyin.com')) {
      currentPlatform = 'douyin';
    }
  }

  if (currentPlatform) {
    badge.innerHTML = '<span class="status-badge active"><span class="status-dot active"></span>' +
      PLATFORM_NAMES[currentPlatform] + '帖子页</span>';
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = '开始分析';
  } else {
    badge.innerHTML = '<span class="status-badge inactive"><span class="status-dot inactive"></span>请先打开小红书或抖音帖子</span>';
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = '当前页面不支持';
  }
})();

analyzeBtn.addEventListener('click', async () => {
  if (!currentPlatform) return;
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    setStatus('请先输入 DeepSeek API Key', 'error');
    return;
  }
  chrome.storage.local.set({ deepseek_api_key: apiKey });

  analyzeBtn.disabled = true;
  analyzeBtn.textContent = '分析中...';

  try {
    // ===== Step 0: SPA导航检测——如果切换了帖子，清空旧数据 =====
    // 小红书拦截器由 injected.js 在 document_start 自动注入，无需手动注入
    if (currentPlatform === 'xiaohongshu') {
      await chrome.scripting.executeScript({
        target: { tabId: currentTabId },
        world: 'MAIN',
        func: checkAndResetIfNewPost
      });
    } else {
      await chrome.scripting.executeScript({
        target: { tabId: currentTabId },
        world: 'MAIN',
        func: resetCommentState,
        args: [currentPlatform]
      });
    }

    // ===== Step 1: 抖音手动注入拦截器（document_start太早，抖音JS会覆盖fetch） =====
    // 小红书拦截器由 injected.js 在 document_start 自动注入
    if (currentPlatform === 'douyin') {
      setStatus('注入拦截器...', '');
      await chrome.scripting.executeScript({
        target: { tabId: currentTabId },
        world: 'MAIN',
        func: injectInterceptor,
        args: [currentPlatform]
      });
    }

    // ===== Step 2: 加载评论 =====
    // 小红书用 API 翻页（绕过DOM滚动问题），抖音用滚动
    if (currentPlatform === 'xiaohongshu') {
      setStatus('获取评论...', '');
      const [firstRes] = await chrome.scripting.executeScript({
        target: { tabId: currentTabId },
        world: 'MAIN',
        func: fetchFirstCommentPage
      });
      console.log('[popup] fetchFirstPage result:', firstRes?.result, 'comments:', firstRes?.result);

      if (!firstRes || !firstRes.result) {
        setStatus('首屏评论获取失败，请重试', 'error');
        analyzeBtn.disabled = false;
        analyzeBtn.textContent = '开始分析';
        return;
      }

      setStatus('开始翻页...', '');
      await sleep(1000);

      let prevCount = 0;
      let staleCount = 0;
      const MAX_STALE = 5;   // 连续5轮不涨才停止
      const MAX_PAGES = 150; // 最多150页（3000条）

      for (let i = 0; i < MAX_PAGES; i++) {
        await chrome.scripting.executeScript({
          target: { tabId: currentTabId },
          world: 'MAIN',
          func: fetchNextCommentPage
        });

        await sleep(1500);  // 等页面发API + 拦截器处理

        // 每2轮检查进度
        if (i % 2 === 0) {
          const [res] = await chrome.scripting.executeScript({
            target: { tabId: currentTabId },
            world: 'MAIN',
            func: getProgress,
            args: [currentPlatform]
          });
          const { count, total } = res.result;
          const pct = total > 0 ? Math.round(count / total * 100) : 0;
          setStatus(`已收集 ${count} / ${total} (${pct}%)`, '');

          // 达到总数或连续不涨则停止
          if (total > 0 && count >= total) break;
          if (count === prevCount) {
            staleCount++;
            if (staleCount >= MAX_STALE) break;
          } else {
            staleCount = 0;
          }
          prevCount = count;
        }
      }
    } else {
      // 抖音：与小红书用同一套翻页逻辑（全页面滚动触发懒加载）
      setStatus('滚动加载评论...', '');
      let prevCountDy = 0;
      let staleCountDy = 0;
      const MAX_STALE_DY = 5;
      const MAX_PAGES_DY = 150;

      for (let i = 0; i < MAX_PAGES_DY; i++) {
        await chrome.scripting.executeScript({
          target: { tabId: currentTabId },
          world: 'MAIN',
          func: fetchNextCommentPage
        });
        await sleep(1500);

        if (i % 2 === 0) {
          const [res] = await chrome.scripting.executeScript({
            target: { tabId: currentTabId },
            world: 'MAIN',
            func: getProgress,
            args: [currentPlatform]
          });
          const { count, total } = res.result;
          const pct = total > 0 ? Math.round(count / total * 100) : 0;
          console.log('[popup] 抖音翻页:', count, '/', total, '(' + pct + '%) 轮:', i);
          setStatus(`已收集 ${count} / ${total} (${pct}%)`, '');

          if (total > 0 && count >= total) break;
          if (count === prevCountDy) {
            staleCountDy++;
            if (staleCountDy >= MAX_STALE_DY) break;
          } else {
            staleCountDy = 0;
          }
          prevCountDy = count;
        }
      }
    }

    // ===== Step 3: 读取所有数据 =====
    setStatus('抓取页面内容...', '');
    const [dataRes] = await chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      world: 'MAIN',
      func: extractAllData,
      args: [currentPlatform]
    });
    const pageData = dataRes.result;

    if (!pageData.comments.length) {
      setStatus('未抓取到评论，请确认页面已完全加载', 'error');
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = '开始分析';
      return;
    }

    // ===== Step 4: 发给后端分析 =====
    setStatus(`抓取完成！${pageData.comment_count}条评论，正在AI分析...`, '');
    const analyzeResp = await fetch('http://localhost:8000/analyze-direct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: currentPlatform,
        post_content: pageData.post_content,
        images: pageData.images,
        comments: pageData.comments,
        deepseek_api_key: apiKey
      })
    });
    const result = await analyzeResp.json();

    if (result.success) {
      await fetch('http://localhost:8000/store-result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result: result.data })
      });
      chrome.tabs.create({ url: 'http://localhost:8000/' });
      setStatus('分析完成！结果已展示在新标签页中', 'success');
    } else {
      setStatus(result.error || '分析失败', 'error');
    }
  } catch (err) {
    setStatus(`错误: ${err.message}`, 'error');
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = '开始分析';
  }
});

// ===== 注入到页面的函数（会在 MAIN world 执行，通过 args 接收平台参数） =====

function injectInterceptor(platform) {
  const prefix = platform === 'douyin' ? '__dy' : '__xhs';
  const initKey = prefix + '_init__';
  const commentsKey = prefix + '_comments__';
  const totalKey = prefix + '_total__';

  if (window[initKey]) {
    // 已初始化：只清空旧数据（不重新包装fetch，避免双层wrapper）
    window[commentsKey] = [];
    window[totalKey] = 0;
    if (window[prefix + '_seen__']) window[prefix + '_seen__'].clear();
    if (platform === 'xiaohongshu') window.__xhs_api_info__ = null;
    return;
  }
  window[initKey] = true;
  window[commentsKey] = [];
  window[totalKey] = 0;
  const seen = new Set();
  window[prefix + '_seen__'] = seen;  // 暴露引用，供外部清空

  const add = (text) => {
    if (!text || !text.trim()) return;
    const k = text.trim();
    if (seen.has(k)) return;
    seen.add(k);
    window[commentsKey].push(k);
  };

  let collect, urlMatch;

  if (platform === 'douyin') {
    urlMatch = (url) =>
      url.includes('/aweme/v1/web/comment/list/') ||
      url.includes('/aweme/v1/web/comment/list/reply/');
    collect = (items) => {
      (items || []).forEach(c => {
        if (c.content) add(c.content);
        else if (c.text) add(c.text);
      });
    };
  } else {
    // 小红书：记录API调用信息，用于后续主动翻页
    window.__xhs_api_info__ = null;
    urlMatch = (url) =>
      url.includes('/api/sns/web') && url.includes('comment');
    collect = (items) => {
      (items || []).forEach(c => {
        if (c.content) add(c.content);
        (c.sub_comments || c.sub_comment_list || []).forEach(s => {
          if (s.content) add(s.content);
        });
      });
    };
  }

  // 拦截 fetch
  const _fetch = window.fetch;
  window.fetch = function (...args) {
    const input = args[0];
    const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    const init = args[1] || {};

    // 记录XHS评论API调用信息，供主动翻页使用
    if (platform === 'xiaohongshu' && urlMatch(url)) {
      const parsedUrl = new URL(url, window.location.origin);
      const cursor = parsedUrl.searchParams.get('cursor') || '';
      window.__xhs_api_info__ = {
        url: url.split('?')[0],  // base URL without query
        method: (init.method || 'GET').toUpperCase(),
        headers: { ...init.headers },
        body: init.body ? (typeof init.body === 'string' ? init.body : JSON.stringify(init.body)) : null,
        lastCursor: cursor,
      };
      console.log('[fetch拦截] 捕获API调用, headers keys:', Object.keys(init.headers || {}));
    }

    return _fetch.apply(this, args).then(r => {
      if (urlMatch(url)) {
        r.clone().json().then(d => {
          const data = d?.data || d;
          if (platform === 'xiaohongshu') {
            window[totalKey] = data.total_comment_count || data.total_count || window[totalKey];
            // 更新cursor
            if (window.__xhs_api_info__) {
              window.__xhs_api_info__.lastCursor = data.cursor || '';
            }
          }
          collect(data.comments);
        }).catch(() => {});
      }
      return r;
    });
  };

  // 拦截 XHR
  const X = XMLHttpRequest.prototype;
  const _open = X.open, _send = X.send, _setRH = X.setRequestHeader;
  let _u = '';
  X.open = function (m, u, ...r) {
    _u = typeof u === 'string' ? u : '';
    this.__xhs_req_headers__ = {};  // 记录本次请求头
    return _open.apply(this, [m, u, ...r]);
  };
  X.setRequestHeader = function (name, value) {
    this.__xhs_req_headers__ = this.__xhs_req_headers__ || {};
    this.__xhs_req_headers__[name] = value;
    return _setRH.apply(this, arguments);
  };
  X.send = function (...a) {
    const url = _u;
    const headers = { ...(this.__xhs_req_headers__ || {}) };
    this.addEventListener('load', function () {
      if (urlMatch(url)) {
        // 记录API信息（XHR版），用于后续翻页
        if (platform === 'xiaohongshu') {
          const parsedUrl = new URL(url, window.location.origin);
          const cursor = parsedUrl.searchParams.get('cursor') || '';
          window.__xhs_api_info__ = {
            url: url.split('?')[0],
            method: 'GET',
            headers: headers,
            body: null,
            lastCursor: cursor,
          };
          console.log('[XHR拦截] 捕获API调用, headers keys:', Object.keys(headers));
        }
        try {
          const d = JSON.parse(this.responseText);
          const data = d?.data || d;
          if (platform === 'xiaohongshu') {
            window[totalKey] = data.total_comment_count || data.total_count || window[totalKey];
            if (window.__xhs_api_info__) {
              window.__xhs_api_info__.lastCursor = data.cursor || '';
            }
          }
          collect(data.comments);
        } catch (e) { }
      }
    });
    return _send.apply(this, a);
  };

  // 小红书：暴露主动翻页函数，不依赖页面自然加载时机
  if (platform === 'xiaohongshu') {
    const noteIdMatch = window.location.href.match(/\/explore\/([a-f0-9]{24})/);
    const noteId = noteIdMatch ? noteIdMatch[1] : '';

    // 主动发起首屏评论请求（解决拦截器注入晚于首屏API的问题）
    window.__xhs_fetchFirstPage__ = async function () {
      if (!noteId) return false;
      const apiUrl = 'https://www.xiaohongshu.com/api/sns/web/v2/comment/page?' +
        new URLSearchParams({
          note_id: noteId, cursor: '', top_comment_id: '', image_scenes: '',
        }).toString();
      try {
        await window.fetch(apiUrl, { method: 'GET', headers: { 'Accept': 'application/json' } });
        return true;
      } catch (e) { return false; }
    };

    window.__xhs_fetchNextPage__ = async function () {
      const info = window.__xhs_api_info__;
      if (!info || !info.lastCursor) return false;
      const nextUrl = info.url + '?' + new URLSearchParams({
        note_id: noteId, cursor: info.lastCursor,
        top_comment_id: '', image_scenes: '',
      }).toString();
      try {
        await window.fetch(nextUrl, {
          method: info.method, headers: info.headers, body: info.body,
        });
        return true;
      } catch (e) { return false; }
    };
  }
}

// 小红书专用：检测是否切换到新帖子，只在切换时清空数据
// 如果还是同一个帖子，保留已收集的评论（拦截器在document_start就开始收集了）
function checkAndResetIfNewPost() {
  const m = window.location.href.match(/\/explore\/([a-f0-9]{24})/);
  const currentNoteId = m ? m[1] : '';
  const lastNoteId = window.__xhs_last_note_id__ || '';

  if (lastNoteId && currentNoteId !== lastNoteId) {
    // 已有一个旧帖子，且切换到不同帖子 → 清空旧数据
    console.log('[checkAndReset] SPA切换帖子:', lastNoteId, '→', currentNoteId, '清空数据');
    window.__xhs_comments__ = [];
    window.__xhs_total__ = 0;
    window.__xhs_seen__ && window.__xhs_seen__.clear();
    window.__xhs_api_info__ = null;
    window.__xhs_last_note_id__ = currentNoteId;
  } else if (currentNoteId === lastNoteId) {
    // 同一帖子，保留已收集的评论
    console.log('[checkAndReset] 同一帖子，保留', window.__xhs_comments__.length, '条已收集评论');
  } else {
    // 首次运行，记录当前帖子
    console.log('[checkAndReset] 首次运行, 记录帖子:', currentNoteId);
    window.__xhs_last_note_id__ = currentNoteId;
  }
}

// 抖音：清空旧评论数据
function resetCommentState(platform) {
  const prefix = platform === 'douyin' ? '__dy' : '__xhs';
  // 只在已初始化时才清空（首次运行由injectInterceptor自己初始化）
  if (window[prefix + '_init__']) {
    window[prefix + '_comments__'] = [];
    window[prefix + '_total__'] = 0;
    if (window[prefix + '_seen__']) window[prefix + '_seen__'].clear();
  }
  if (platform === 'xiaohongshu') window.__xhs_api_info__ = null;
  window.__scroll_tick__ = 0;
}

// 小红书专用：主动调用评论API（兜底） + 滚动评论区触发页面自然加载
async function fetchFirstCommentPage() {
  if (!window.__xhs_comments__) window.__xhs_comments__ = [];
  if (!window.__xhs_seen__) window.__xhs_seen__ = new Set();

  // 如果拦截器已有评论，直接成功
  if (window.__xhs_comments__.length > 0) {
    console.log('[fetchFirstPage] 已有', window.__xhs_comments__.length, '条评论（拦截器预捕获）');
    return true;
  }

  // ★ 主动调用首屏API兜底（防止页面还没触发评论加载）
  const noteIdMatch = window.location.href.match(/\/explore\/([a-f0-9]{24})/);
  const noteId = noteIdMatch ? noteIdMatch[1] : '';
  if (noteId) {
    console.log('[fetchFirstPage] 主动请求首屏评论API, noteId:', noteId);
    try {
      const apiUrl = 'https://www.xiaohongshu.com/api/sns/web/v2/comment/page?' +
        new URLSearchParams({ note_id: noteId, cursor: '', top_comment_id: '', image_scenes: '' }).toString();
      await window.fetch(apiUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        credentials: 'include'
      });
    } catch (e) {
      console.error('[fetchFirstPage] API请求异常:', e.message);
    }
  }

  // 滚动评论区触发页面自然加载
  const containers = document.querySelectorAll('[class*="comment"], [class*="note-scroll"]');
  for (const el of containers) {
    if (el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
  }

  // 最多等10秒（页面自然加载 + 主动API双重保障）
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (window.__xhs_comments__.length > 0) {
      console.log('[fetchFirstPage] 收集到', window.__xhs_comments__.length, '条评论');
      return true;
    }
  }
  console.warn('[fetchFirstPage] 超时');
  return false;
}

// 翻页：全页面滚动触发页面自然加载（页面自己的请求带正确XHS签名）
function fetchNextCommentPage() {
  try {
    var all = document.querySelectorAll('*');
    var count = 0;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el === document.body || el === document.documentElement) continue;
      if (el.clientHeight === 0) continue;
      if (el.scrollHeight <= el.clientHeight) continue;
      el.scrollTop = el.scrollHeight;
      count++;
    }
    console.log('[scrollPage] 本轮滚动', count, '个元素');
    return { ok: true, scrolled: count };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function scrollToLoadComments(platform) {
  const tick = (window.__scroll_tick__ || 0) + 1;
  window.__scroll_tick__ = tick;

  if (platform === 'douyin') {
    // 抖音：评论区在页面内或侧边面板，滚 window + 评论区容器
    window.scrollTo(0, document.body.scrollHeight);
    const dySelectors = ['.comment-mainContent', '[class*="comment"][class*="list"]', '[class*="CommentListContainer"]', '[class*="comment-container"]'];
    for (const sel of dySelectors) {
      const c = document.querySelector(sel);
      if (c) { c.scrollTop = c.scrollHeight; break; }
    }
  } else {
    // 小红书：帖子是浮层，绝对不能滚 window（会滚到背后的首页）
    // 策略：扫描页面上所有可滚动元素，逐个滚到底
    let scrolledAny = false;

    // 1. 优先滚已知的评论区容器
    const xhsSelectors = [
      '.comment-container', '[class*="comment-container"]', '[class*="comment-list"]',
      '[class*="CommentList"]', '[class*="comment-wrapper"]', '[class*="comments"]',
      '.note-scroller', '[class*="note-scroller"]', '[class*="detail-scroll"]',
    ];
    for (const sel of xhsSelectors) {
      const c = document.querySelector(sel);
      if (c && c.scrollHeight > c.clientHeight + 10) {
        if (tick % 5 === 0) c.scrollTop = Math.max(0, c.scrollTop - 200);
        c.scrollTop = c.scrollHeight;
        scrolledAny = true;
      }
    }

    // 2. 兜底：扫描全部可滚动元素（排除 body/html 和不可见的）
    if (!scrolledAny) {
      const all = document.querySelectorAll('*');
      for (const el of all) {
        if (el === document.body || el === document.documentElement) continue;
        if (el.scrollHeight <= el.clientHeight + 10) continue;
        // 跳过隐藏元素
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (el.offsetHeight === 0) continue;

        if (tick % 5 === 0) el.scrollTop = Math.max(0, el.scrollTop - 200);
        el.scrollTop = el.scrollHeight;
        scrolledAny = true;
      }
    }
  }
}

function getProgress(platform) {
  const prefix = platform === 'douyin' ? '__dy' : '__xhs';
  return {
    count: window[prefix + '_comments__']?.length || 0,
    total: window[prefix + '_total__'] || 0
  };
}

function extractAllData(platform) {
  const prefix = platform === 'douyin' ? '__dy' : '__xhs';
  let postContent = '';
  let images = [];

  if (platform === 'douyin') {
    // ===== 抖音：提取帖子正文 =====
    for (const sel of [
      '.video-info-detail', '.note-detail', '[data-e2e="description"]',
      '.desc-text', '[class*="desc-text"], [class*="video-info"] span'
    ]) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim().length > 5) {
        postContent = el.innerText.trim();
        break;
      }
    }

    // ===== 抖音：提取图片 =====
    const seenSrc = new Set();
    // 笔记帖（swiper轮播图）
    document.querySelectorAll('.swiper-slide img, [class*="note-image"] img, [class*="image-card"] img').forEach(img => {
      const src = img.src || img.getAttribute('data-src') || '';
      if (src && src.startsWith('http') && !seenSrc.has(src)) {
        seenSrc.add(src);
        images.push(src);
      }
    });
    // 如果没找到图片，可能是视频帖，尝试从封面或 og:image 获取
    if (!images.length) {
      const ogImg = document.querySelector('meta[property="og:image"]');
      if (ogImg && ogImg.content) {
        images.push(ogImg.content);
      }
    }
  } else {
    // ===== 小红书：提取帖子正文 =====
    for (const sel of ['#detail-desc', '.note-content', '[class*="desc"]']) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim().length > 5) {
        postContent = el.innerText.trim();
        break;
      }
    }

    // ===== 小红书：提取图片 =====
    document.querySelectorAll('.swiper-slide img, [class*="slide"] img').forEach(img => {
      const src = img.src || img.getAttribute('data-src') || '';
      if (src && src.startsWith('http')) images.push(src);
    });
  }

  // ===== 收集评论（优先从拦截器获取） =====
  // 强力去重：trim + Set + 过滤空短串
  const rawArr = window[prefix + '_comments__'] || [];
  const dedup = new Set();
  for (const c of rawArr) {
    const t = (c || '').trim();
    if (t.length >= 2) dedup.add(t);  // 过滤1字以下的无意义文本
  }
  let comments = [...dedup];
  console.log('[提取数据] 原始条数:', rawArr.length, '去重后:', comments.length);

  // DOM 兜底已关闭：之前因为拦截器没抓到评论就乱抓页面文字
  // 现在页面内容由 fetch/XHR 拦截器+API翻页负责，不依赖DOM
  if (!comments.length) {
    console.log('[提取数据] 拦截器未捕获评论，跳过DOM兜底。window keys:',
      Object.keys(window).filter(k => k.includes('__xhs') || k.includes('__dy')));
  }

  return {
    comments,
    post_content: postContent,
    images,
    comment_count: comments.length,
    url: window.location.href
  };
}

// ===== 工具函数 =====

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function setStatus(msg, cls) {
  statusText.textContent = msg;
  statusText.className = 'status-text ' + cls;
}
