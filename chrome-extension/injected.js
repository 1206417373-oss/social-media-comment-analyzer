/**
 * injected.js — MAIN world。
 * 只负责拦截 fetch/XHR 收集评论数据，存入 window.__xhs_comments__.
 * 不滚动、不发消息。
 */
(function init() {
  if (window.__xhs_interceptor_ready__) return;
  window.__xhs_interceptor_ready__ = true;
  window.__xhs_comments__ = window.__xhs_comments__ || [];
  window.__xhs_total__ = 0;
  window.__xhs_seen__ = window.__xhs_seen__ || new Set();

  function add(text) {
    if (!text || !text.trim()) return;
    const k = text.trim();
    if (window.__xhs_seen__.has(k)) return;
    window.__xhs_seen__.add(k);
    window.__xhs_comments__.push(k);
  }

  function collect(items) {
    (items || []).forEach(c => {
      if (c.content) add(c.content);
      (c.sub_comments || c.sub_comment_list || []).forEach(s => {
        if (s.content) add(s.content);
      });
    });
  }

  // fetch 拦截
  const _fetch = window.fetch;
  window.fetch = function(...args) {
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

  // XHR 拦截
  const X = XMLHttpRequest.prototype;
  const _open = X.open, _send = X.send;
  let _u = '';
  X.open = function(m, u, ...r) { _u = typeof u === 'string' ? u : ''; return _open.apply(this, [m, u, ...r]); };
  X.send = function(...a) {
    const url = _u;
    this.addEventListener('load', function() {
      if (url.includes('/api/sns/web') && url.includes('comment')) {
        try {
          const d = JSON.parse(this.responseText);
          const data = d?.data || d;
          window.__xhs_total__ = data.total_comment_count || data.total_count || window.__xhs_total__;
          collect(data.comments);
        } catch(e) {}
      }
    });
    return _send.apply(this, a);
  };
  console.log('[XHS插件] 拦截器已注入 (MAIN)');
})();
