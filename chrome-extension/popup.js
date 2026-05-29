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
    // ===== Step 1: 注入拦截器到 MAIN world =====
    setStatus('注入拦截器...', '');
    await chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      world: 'MAIN',
      func: injectInterceptor,
      args: [currentPlatform]
    });

    // ===== Step 2: 滚动加载评论 =====
    setStatus('滚动加载评论...', '');
    let prevCount = 0;
    let staleCount = 0;  // 连续无增长次数
    const MAX_STALE = 3; // 连续3轮不增长才退出（30秒）
    const MAX_ITER = 80;

    for (let i = 0; i < MAX_ITER; i++) {
      await chrome.scripting.executeScript({
        target: { tabId: currentTabId },
        world: 'MAIN',
        func: scrollToLoadComments,
        args: [currentPlatform]
      });
      await sleep(1000);

      if (i % 10 === 0) {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: currentTabId },
          world: 'MAIN',
          func: getProgress,
          args: [currentPlatform]
        });
        const { count, total } = res.result;
        const totalStr = total > 0 ? ` / ${total}` : '';
        setStatus(`已收集 ${count}${totalStr} 条评论...`, '');

        // 有数据后，连续3轮（30秒）不增长才提前退出
        if (i > 20 && count > 0) {
          if (count === prevCount) {
            staleCount++;
            if (staleCount >= MAX_STALE) break;
          } else {
            staleCount = 0;  // 有新数据，重置计数
          }
        }
        prevCount = count;
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

  if (window[initKey]) return;
  window[initKey] = true;
  window[commentsKey] = [];
  window[totalKey] = 0;
  const seen = new Set();

  const add = (text) => {
    if (!text || !text.trim()) return;
    const k = text.trim();
    if (seen.has(k)) return;
    seen.add(k);
    window[commentsKey].push(k);
  };

  let collect, urlMatch;

  if (platform === 'douyin') {
    // 抖音：拦截评论列表和子回复 API
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
    // 小红书：拦截评论 API
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
    return _fetch.apply(this, args).then(r => {
      if (urlMatch(url)) {
        r.clone().json().then(d => {
          const data = d?.data || d;
          if (platform === 'xiaohongshu') {
            window[totalKey] = data.total_comment_count || data.total_count || window[totalKey];
          }
          collect(data.comments);
        }).catch(() => {});
      }
      return r;
    });
  };

  // 拦截 XHR
  const X = XMLHttpRequest.prototype;
  const _open = X.open, _send = X.send;
  let _u = '';
  X.open = function (m, u, ...r) { _u = typeof u === 'string' ? u : ''; return _open.apply(this, [m, u, ...r]); };
  X.send = function (...a) {
    const url = _u;
    this.addEventListener('load', function () {
      if (urlMatch(url)) {
        try {
          const d = JSON.parse(this.responseText);
          const data = d?.data || d;
          if (platform === 'xiaohongshu') {
            window[totalKey] = data.total_comment_count || data.total_count || window[totalKey];
          }
          collect(data.comments);
        } catch (e) { }
      }
    });
    return _send.apply(this, a);
  };
}

function scrollToLoadComments(platform) {
  // 每隔几次滚动先回滚一点再往下，触发懒加载重新检测
  const tick = (window.__scroll_tick__ || 0) + 1;
  window.__scroll_tick__ = tick;

  // 先滚页面到底
  window.scrollTo(0, document.body.scrollHeight);

  // 评论区容器选择器
  const selectors = platform === 'douyin'
    ? ['.comment-mainContent', '[class*="comment"][class*="list"]', '[class*="CommentListContainer"]', '[class*="comment-container"]']
    : ['.comment-container', '[class*="comment"][class*="container"]', '[class*="comments"]', '[class*="comment-wrapper"]', '[class*="note-comment"]'];

  let container = null;
  for (const sel of selectors) {
    container = document.querySelector(sel);
    if (container) break;
  }

  if (container) {
    // 每5轮做一次"微回滚再滚到底"，强制触发懒加载检测
    if (tick % 5 === 0) {
      container.scrollTop = Math.max(0, container.scrollTop - 200);
    }
    // 滚到底部
    container.scrollTop = container.scrollHeight;
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
  let comments = [...new Set(window[prefix + '_comments__'] || [])];

  // DOM 兜底：如果拦截器没抓到，从 DOM 里提取
  if (!comments.length) {
    const seen = new Set();
    const addDom = (el) => {
      const t = (el.innerText || el.textContent || '').trim();
      if (t && t.length > 1 && !seen.has(t)) { seen.add(t); comments.push(t); }
    };

    if (platform === 'douyin') {
      // 抖音评论区DOM
      document.querySelectorAll(
        '[class*="comment-item"], [class*="CommentItem"], [class*="comment-content"]'
      ).forEach(addDom);
      const container = document.querySelector(
        '.comment-mainContent, [class*="comment"][class*="list"], [class*="CommentListContainer"]'
      );
      if (container) {
        container.querySelectorAll('p, span, div').forEach(el => {
          const t = (el.innerText || '').trim();
          if (t.length > 2 && t.length < 500 && el.children.length === 0 && !seen.has(t)) {
            seen.add(t); comments.push(t);
          }
        });
      }
    } else {
      // 小红书评论区DOM
      document.querySelectorAll(
        '[class*="comment-item"], [class*="commentItem"], [class*="comment"]:not([class*="container"]):not([class*="wrapper"])'
      ).forEach(addDom);
      const container = document.querySelector(
        '.comment-container, [class*="comment"][class*="container"], [class*="comments"], [class*="comment-wrapper"]'
      );
      if (container) {
        container.querySelectorAll('p, span, div').forEach(el => {
          const t = (el.innerText || '').trim();
          if (t.length > 2 && t.length < 500 && el.children.length === 0 && !seen.has(t)) {
            seen.add(t); comments.push(t);
          }
        });
      }
    }
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
