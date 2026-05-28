/**
 * popup.js - 动态注入方案。
 * 所有代码通过 scripting.executeScript 注入到 MAIN world 执行。
 */

const analyzeBtn = document.getElementById('analyzeBtn');
const statusText = document.getElementById('statusText');
const apiKeyInput = document.getElementById('apiKey');
const badge = document.getElementById('badge');

let currentTabId = null;
let isXhsPage = false;

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
    isXhsPage = tab.url && tab.url.includes('xiaohongshu.com/explore');
  }

  if (isXhsPage) {
    badge.innerHTML = '<span class="status-badge active"><span class="status-dot active"></span>小红书帖子页</span>';
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = '开始分析';
  } else {
    badge.innerHTML = '<span class="status-badge inactive"><span class="status-dot inactive"></span>请先打开一个小红书帖子</span>';
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = '当前页面不支持';
  }
})();

analyzeBtn.addEventListener('click', async () => {
  if (!isXhsPage) return;
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
      func: injectInterceptor
    });

    // ===== Step 2: 滚动加载评论 =====
    setStatus('滚动加载评论...', '');
    let prevCount = 0;
    for (let i = 0; i < 80; i++) {
      await chrome.scripting.executeScript({
        target: { tabId: currentTabId },
        world: 'MAIN',
        func: scrollToLoadComments
      });
      await sleep(1000);

      if (i % 10 === 0) {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: currentTabId },
          world: 'MAIN',
          func: getProgress
        });
        const { count, total } = res.result;
        const totalStr = total > 0 ? ` / ${total}` : '';
        setStatus(`已收集 ${count}${totalStr} 条评论...`, '');

        // 有数据且连续两轮不增长，提前退出
        if (i > 20 && count > 0 && count === prevCount) break;
        prevCount = count;
      }
    }

    // ===== Step 3: 读取所有数据 =====
    setStatus('抓取页面内容...', '');
    const [dataRes] = await chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      world: 'MAIN',
      func: extractAllData
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
        platform: 'xiaohongshu',
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

// ===== 注入到页面的函数（会在 MAIN world 执行） =====

function injectInterceptor() {
  if (window.__xhs_init__) return;
  window.__xhs_init__ = true;
  window.__xhs_comments__ = [];
  window.__xhs_total__ = 0;
  const seen = new Set();

  const add = (text) => {
    if (!text || !text.trim()) return;
    const k = text.trim();
    if (seen.has(k)) return;
    seen.add(k);
    window.__xhs_comments__.push(k);
  };

  const collect = (items) => {
    (items || []).forEach(c => {
      if (c.content) add(c.content);
      (c.sub_comments || c.sub_comment_list || []).forEach(s => {
        if (s.content) add(s.content);
      });
    });
  };

  // 拦截 fetch
  const _fetch = window.fetch;
  window.fetch = function (...args) {
    const input = args[0];
    const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    return _fetch.apply(this, args).then(r => {
      if (url.includes('/api/sns/web') && url.includes('comment')) {
        r.clone().json().then(d => {
          const data = d?.data || d;
          window.__xhs_total__ = data.total_comment_count || data.total_count || window.__xhs_total__;
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
      if (url.includes('/api/sns/web') && url.includes('comment')) {
        try {
          const d = JSON.parse(this.responseText);
          const data = d?.data || d;
          window.__xhs_total__ = data.total_comment_count || data.total_count || window.__xhs_total__;
          collect(data.comments);
        } catch (e) { }
      }
    });
    return _send.apply(this, a);
  };
}

function scrollToLoadComments() {
  // 先滚窗口到底部，让评论区进入视口触发首次加载
  window.scrollTo(0, document.body.scrollHeight);

  // 再尝试滚评论区容器
  const container = document.querySelector(
    '.comment-container, [class*="comment"][class*="container"], [class*="comments"], [class*="comment-wrapper"], [class*="note-comment"]'
  );
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
}

function getProgress() {
  return {
    count: window.__xhs_comments__?.length || 0,
    total: window.__xhs_total__ || 0
  };
}

function extractAllData() {
  let postContent = '';
  for (const sel of ['#detail-desc', '.note-content', '[class*="desc"]']) {
    const el = document.querySelector(sel);
    if (el && el.innerText && el.innerText.trim().length > 5) {
      postContent = el.innerText.trim(); break;
    }
  }

  const images = [];
  document.querySelectorAll('.swiper-slide img, [class*="slide"] img').forEach(img => {
    const src = img.src || img.getAttribute('data-src') || '';
    if (src && src.startsWith('http')) images.push(src);
  });

  // 拦截器收集的评论
  let comments = [...new Set(window.__xhs_comments__ || [])];

  // DOM 兜底：如果拦截器没抓到，从 DOM 里提取
  if (!comments.length) {
    const seen = new Set();
    const addDom = (el) => {
      const t = (el.innerText || el.textContent || '').trim();
      if (t && t.length > 1 && !seen.has(t)) { seen.add(t); comments.push(t); }
    };
    // 主评论
    document.querySelectorAll(
      '[class*="comment-item"], [class*="commentItem"], [class*="comment"]:not([class*="container"]):not([class*="wrapper"])'
    ).forEach(addDom);
    // 查找评论区内的所有文本段落
    const container = document.querySelector(
      '.comment-container, [class*="comment"][class*="container"], [class*="comments"], [class*="comment-wrapper"]'
    );
    if (container) {
      container.querySelectorAll('p, span, div').forEach(el => {
        // 只取短文本（评论通常不长）
        const t = (el.innerText || '').trim();
        if (t.length > 2 && t.length < 500 && el.children.length === 0 && !seen.has(t)) {
          seen.add(t); comments.push(t);
        }
      });
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
