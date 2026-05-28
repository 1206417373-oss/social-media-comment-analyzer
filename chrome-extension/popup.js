/**
 * 弹窗逻辑：检测页面状态、配置API Key、触发分析。
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
    // Step 1: 从页面提取数据
    setStatus('正在抓取页面数据...', '');
    let extractResult;
    try {
      extractResult = await chrome.tabs.sendMessage(currentTabId, { action: 'extract' });
    } catch (err) {
      setStatus(`抓取失败: 请刷新小红书页面后重试 (${err.message})`, 'error');
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = '开始分析';
      return;
    }

    if (!extractResult || !extractResult.success) {
      setStatus('页面数据抓取失败，请确认当前在小红书帖子详情页', 'error');
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = '开始分析';
      return;
    }
    const pageData = extractResult.data;

    // Step 2: 发送给后端分析
    setStatus(`抓取完成！${pageData.comments.length}条评论，正在AI分析...`, '');
    const result = await chrome.runtime.sendMessage({
      action: 'analyze',
      payload: {
        url: pageData.url,
        post_content: pageData.post_content,
        images: pageData.images,
        comments: pageData.comments
      }
    });

    if (result.success) {
      setStatus('分析完成！结果已展示在页面中', 'success');
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

function setStatus(msg, cls) {
  statusText.textContent = msg;
  statusText.className = 'status-text ' + cls;
}
