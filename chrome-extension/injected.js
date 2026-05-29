/**
 * injected.js — 在 document_start 注入 MAIN world。
 * 支持小红书 + 抖音，页面JS执行前包装 fetch/XHR。
 */
(function init() {
  // 检测平台
  var url = window.location.href;
  var isXHS = url.includes('xiaohongshu.com');
  var isDY = url.includes('douyin.com');
  if (!isXHS && !isDY) return;

  var prefix = isDY ? '__dy' : '__xhs';
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
    if (isDY) return url.includes('comment/list') || url.includes('comment/list/reply');
    return url.includes('/api/sns/web') && url.includes('comment');
  }

  function getPlatformName() { return isDY ? '抖音' : '小红书'; }

  // ===== 拦截 fetch =====
  var _fetch = window.fetch;
  function makeWrapper() {
    return function () {
      var args = arguments;
      var input = args[0];
      var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');

      return _fetch.apply(this, args).then(function(r) {
        if (isCommentApi(url)) {
          r.clone().json().then(function(d) {
            var data = d && d.data ? d.data : d;
            window[totalKey] = data.total_comment_count || data.total_count || window[totalKey];
            collect(data.comments);
            console.log('[自启拦截器-' + getPlatformName() + '] 收集:', window[commentsKey].length, '/', window[totalKey]);
          }).catch(function() {});
        } else if (isDY && url.includes('/aweme/')) {
          console.log('[DY诊断] 非评论API:', url.substring(0, 120));
        }
        return r;
      });
    };
  }
  window.fetch = makeWrapper();

  // 防覆盖：每2秒检查fetch是否被页面替换，被替换就重新包装
  var checkCount = 0;
  var checkTimer = setInterval(function() {
    if (checkCount++ > 60) { clearInterval(checkTimer); return; } // 2分钟后停止
    if (window.fetch !== window.__our_fetch_ref__) {
      console.log('[自启拦截器] fetch被覆盖，重新包装 (第' + checkCount + '次检查)');
      _fetch = window.fetch;  // 捕获新引用
      var w = makeWrapper();
      window.fetch = w;
      window.__our_fetch_ref__ = w;
    }
  }, 2000);
  window.__our_fetch_ref__ = window.fetch;

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
        try {
          var d = JSON.parse(self.responseText);
          var data = d && d.data ? d.data : d;
          window[totalKey] = data.total_comment_count || data.total_count || window[totalKey];
          collect(data.comments);
        } catch(e) {}
      }
    });
    return _send.apply(this, arguments);
  };

  console.log('[自启拦截器-' + getPlatformName() + '] 已注入 (document_start)');
})();
