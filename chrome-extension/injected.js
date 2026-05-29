/**
 * injected.js — 在 document_start 注入 MAIN world。
 * 在页面JS执行前包装 fetch/XHR，确保捕获首屏评论API请求。
 */
(function init() {
  if (window.__xhs_interceptor_ready__) return;
  window.__xhs_interceptor_ready__ = true;

  // ===== 全局状态 =====
  window.__xhs_comments__ = window.__xhs_comments__ || [];
  window.__xhs_total__ = 0;
  window.__xhs_seen__ = window.__xhs_seen__ || new Set();
  window.__xhs_api_info__ = null;

  const commentsKey = '__xhs_comments__';
  const totalKey = '__xhs_total__';
  const seen = window.__xhs_seen__;

  function add(text) {
    if (!text || !text.trim()) return;
    const k = text.trim();
    if (seen.has(k)) return;
    seen.add(k);
    window[commentsKey].push(k);
  }

  function collect(items) {
    (items || []).forEach(c => {
      if (c.content) add(c.content);
      (c.sub_comments || c.sub_comment_list || []).forEach(s => {
        if (s.content) add(s.content);
      });
    });
    console.log('[自启拦截器] 本轮收集后总数:', window[commentsKey].length, 'seen:', seen.size);
  }

  function isCommentApi(url) {
    return url.includes('/api/sns/web') && url.includes('comment');
  }

  // ===== 拦截 fetch =====
  const _fetch = window.fetch;
  window.fetch = function (...args) {
    const input = args[0];
    const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    const init = args[1] || {};

    if (isCommentApi(url)) {
      const parsedUrl = new URL(url, window.location.origin);
      window.__xhs_api_info__ = {
        url: url.split('?')[0],
        method: (init.method || 'GET').toUpperCase(),
        headers: { ...init.headers },
        body: init.body ? (typeof init.body === 'string' ? init.body : JSON.stringify(init.body)) : null,
        lastCursor: parsedUrl.searchParams.get('cursor') || '',
      };
      console.log('[自启拦截器-fetch] 捕获API请求, headers:', Object.keys(init.headers || {}));
    }

    return _fetch.apply(this, args).then(r => {
      if (isCommentApi(url)) {
        r.clone().json().then(d => {
          const data = d?.data || d;
          window[totalKey] = data.total_comment_count || data.total_count || window[totalKey];
          if (window.__xhs_api_info__) {
            window.__xhs_api_info__.lastCursor = data.cursor || '';
          }
          collect(data.comments);
        }).catch(() => {});
      }
      return r;
    });
  };

  // ===== 拦截 XHR =====
  const X = XMLHttpRequest.prototype;
  const _open = X.open, _send = X.send, _setRH = X.setRequestHeader;
  let _u = '';
  X.open = function (m, u, ...r) {
    _u = typeof u === 'string' ? u : '';
    this.__xhs_req_headers__ = {};
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
      if (isCommentApi(url)) {
        const parsedUrl = new URL(url, window.location.origin);
        window.__xhs_api_info__ = {
          url: url.split('?')[0],
          method: 'GET',
          headers: headers,
          body: null,
          lastCursor: parsedUrl.searchParams.get('cursor') || '',
        };
        console.log('[自启拦截器-XHR] 捕获API请求, headers:', Object.keys(headers));
        try {
          const d = JSON.parse(this.responseText);
          const data = d?.data || d;
          window[totalKey] = data.total_comment_count || data.total_count || window[totalKey];
          if (window.__xhs_api_info__) {
            window.__xhs_api_info__.lastCursor = data.cursor || '';
          }
          collect(data.comments);
        } catch (e) {}
      }
    });
    return _send.apply(this, a);
  };

  console.log('[自启拦截器] 已注入 MAIN world (document_start)');
})();
