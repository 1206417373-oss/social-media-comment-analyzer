/**
 * injected.js — 在 document_start 注入 MAIN world。
 * 支持小红书 + 抖音，页面JS执行前包装 fetch/XHR。
 */
(function init() {
  // 仅在XHS生效（抖音用手动注入，避免fetch包装冲突）
  var url = window.location.href;
  if (!url.includes('xiaohongshu.com')) return;
  var isXHS = true;

  var prefix = '__xhs';
  var readyKey = prefix + '_interceptor_ready__';
  if (window[readyKey]) return;
  window[readyKey] = true;

  // ===== 全局状态 =====
  var commentsKey = prefix + '_comments__';
  var totalKey = prefix + '_total__';
  window[commentsKey] = window[commentsKey] || [];
  window[totalKey] = 0;
  var seen = window[prefix + '_seen__'] || new Set();
  window[prefix + '_seen__'] = seen;

  function add(text) {
    if (!text || !text.trim()) return;
    var k = text.trim();
    if (seen.has(k)) return;
    seen.add(k);
    window[commentsKey].push(k);
  }

  function collect(items) {
    (items || []).forEach(function(c) {
      if (c.content) add(c.content);
      else if (c.text) add(c.text);
      // 小红书有子回复
      (c.sub_comments || c.sub_comment_list || []).forEach(function(s) {
        if (s.content) add(s.content);
      });
    });
  }

  function isCommentApi(url) {
    return url.includes('/api/sns/web') && url.includes('comment');
  }

  // ===== 拦截 fetch =====
  var _fetch = window.fetch;
  window.fetch = function () {
    var args = arguments;
    var input = args[0];
    var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');

    return _fetch.apply(this, args).then(function(r) {
      if (isCommentApi(url)) {
        console.log('[fetch拦截] 捕获评论API:', url.substring(0, 120));
        r.clone().json().then(function(d) {
          var data = d && d.data ? d.data : d;
          var count = data.total_comment_count || data.total_count || 0;
          var comments = data.comments || [];
          window[totalKey] = count || window[totalKey];
          console.log('[fetch拦截] total=' + count + ', 本页' + comments.length + '条');
          collect(comments);
        }).catch(function(e) {
          console.error('[fetch拦截] JSON解析失败:', e);
        });
      }
      return r;
    });
  };

  // ===== 拦截 XHR =====
  var X = XMLHttpRequest.prototype;
  var _open = X.open, _send = X.send;
  var _u = '';
  X.open = function(m, u) {
    _u = typeof u === 'string' ? u : '';
    return _open.apply(this, arguments);
  };
  X.send = function() {
    var url = _u;
    var self = this;
    self.addEventListener('load', function() {
      if (isCommentApi(url)) {
        console.log('[XHR拦截] 捕获评论API:', url.substring(0, 120));
        try {
          var d = JSON.parse(self.responseText);
          var data = d && d.data ? d.data : d;
          var count = data.total_comment_count || data.total_count || 0;
          var comments = data.comments || [];
          window[totalKey] = count || window[totalKey];
          console.log('[XHR拦截] total=' + count + ', 本页' + comments.length + '条');
          collect(comments);
        } catch(e) {
          console.error('[XHR拦截] JSON解析失败:', e);
        }
      }
    });
    return _send.apply(this, arguments);
  };

  console.log('[自启拦截器] 已注入 (document_start)');
})();
