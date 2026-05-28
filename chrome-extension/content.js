/**
 * 从小红书帖子页面DOM中提取内容和评论。
 */

function extractPostContent() {
  const selectors = ['#detail-desc', '.note-content', '[class*="desc"]'];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.innerText && el.innerText.trim().length > 5) {
      return el.innerText.trim();
    }
  }
  return '';
}

function extractImages() {
  const imgs = document.querySelectorAll('.swiper-slide img, [class*="slide"] img');
  const urls = [];
  imgs.forEach(img => {
    const src = img.src || img.getAttribute('data-src') || '';
    if (!src) return;
    // 过滤缩略图（宽度小于100px的）
    if (img.naturalWidth && img.naturalWidth < 100) return;
    urls.push(src);
  });
  return urls;
}

function extractComments() {
  const comments = [];
  const items = document.querySelectorAll('[class*="comment-item"], [class*="commentItem"]');
  items.forEach(item => {
    // 主评论内容
    const contentEl = item.querySelector('[class*="content"], [class*="text"], .comment-content');
    if (contentEl && contentEl.innerText) {
      comments.push(contentEl.innerText.trim());
    } else if (item.innerText) {
      comments.push(item.innerText.trim());
    }

    // 子评论
    const subItems = item.querySelectorAll('[class*="sub-comment"], [class*="reply"]');
    subItems.forEach(sub => {
      if (sub.innerText && sub.innerText.trim()) {
        comments.push(sub.innerText.trim());
      }
    });
  });
  return comments;
}

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'extract') {
    const data = {
      url: window.location.href,
      post_content: extractPostContent(),
      images: extractImages(),
      comments: extractComments(),
      comment_count: 0
    };
    data.comment_count = data.comments.length;
    sendResponse({ success: true, data: data });
  }
  return true;
});
