"""
小红书帖子数据抓取模块

使用 httpx 直接请求小红书 API，依赖 Cookie 认证。
"""

import re
import httpx

DETAIL_API = "https://www.xiaohongshu.com/explorer/api/note/{note_id}"
COMMENT_API = "https://www.xiaohongshu.com/api/sns/web/v2/comment/page"
MAX_COMMENTS = 500

HEADERS_TEMPLATE = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Referer": "https://www.xiaohongshu.com/",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
}


def _extract_note_id(url: str) -> str:
    """从帖子URL中提取note_id。"""
    # 标准链接: /explore/xxx 或 /discovery/item/xxx
    m = re.search(r"/explore/([a-f0-9]{24})", url)
    if m:
        return m.group(1)
    m = re.search(r"/discovery/item/([a-f0-9]{24})", url)
    if m:
        return m.group(1)
    # 纯note_id
    m = re.search(r"([a-f0-9]{24})", url)
    if m:
        return m.group(1)
    raise ValueError(f"无法从URL中提取note_id: {url}")


async def _resolve_short_link(url: str) -> str:
    """解析 xhslink.com 短链，跟随重定向拿到真实URL。"""
    async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
        resp = await client.get(url, headers=HEADERS_TEMPLATE)
        if resp.status_code in (301, 302, 307, 308):
            location = resp.headers.get("Location", "")
            if location:
                return location
        # 尝试从响应体中提取
        body = resp.text
        m = re.search(r"window\.location\.href\s*=\s*['\"]([^'\"]+)['\"]", body)
        if m:
            return m.group(1)
    raise RuntimeError("短链解析失败，请检查链接是否有效")


async def fetch_post(url: str, cookie: str) -> dict:
    """
    根据小红书帖子URL获取内容和评论。

    Args:
        url: 帖子链接（支持 /explore/xxx 和 xhslink.com 短链）
        cookie: 小红书登录Cookie

    Returns:
        {
            "post_content": "帖子正文",
            "images": ["https://..."],
            "comments": ["评论1", "评论2", ...],
            "comment_count": 123
        }
    """
    headers = dict(HEADERS_TEMPLATE)
    if cookie:
        headers["Cookie"] = cookie

    # 1. 处理短链
    if "xhslink.com" in url:
        url = await _resolve_short_link(url)

    # 2. 提取note_id
    note_id = _extract_note_id(url)

    async with httpx.AsyncClient(timeout=60) as client:
        # 3. 请求帖子详情
        detail_url = DETAIL_API.format(note_id=note_id)
        resp = await client.get(detail_url, headers=headers)

        if resp.status_code != 200:
            raise RuntimeError(f"Cookie可能已过期（HTTP {resp.status_code}）")

        try:
            data = resp.json()
        except Exception:
            raise RuntimeError("API返回格式异常，无法解析JSON")

        if not data.get("success"):
            msg = data.get("msg", "未知错误")
            raise RuntimeError(f"API返回失败: {msg}")

        note_map = data.get("data", {}).get("note_detail_map", {})
        note_info = note_map.get(note_id, {})
        if not note_info:
            raise RuntimeError("帖子不存在或已删除")

        note = note_info.get("note", {})
        post_content = note.get("desc", "")
        images = [img.get("url_default", "") for img in note.get("image_list", []) if img.get("url_default")]

        # 4. 请求评论（分页）
        total_comment_count = data.get("data", {}).get("total_comment_count", 0)
        comments = await _fetch_all_comments(client, headers, note_id)

    return {
        "post_content": post_content,
        "images": images,
        "comments": comments,
        "comment_count": total_comment_count,
    }


async def _fetch_all_comments(client: httpx.AsyncClient, headers: dict, note_id: str) -> list[str]:
    """分页拉取评论，最多 MAX_COMMENTS 条。"""
    all_comments = []
    cursor = ""

    while len(all_comments) < MAX_COMMENTS:
        params = {
            "note_id": note_id,
            "cursor": cursor,
            "top_comment_id": "",
            "image_scenes": "",
        }
        resp = await client.get(COMMENT_API, params=params, headers=headers)

        if resp.status_code != 200:
            break

        try:
            data = resp.json()
        except Exception:
            break

        comment_list = data.get("data", {}).get("comments", [])
        if not comment_list:
            break

        for c in comment_list:
            content = c.get("content", "").strip()
            if content:
                all_comments.append(content)
            # 提取子评论
            for sub in c.get("sub_comments", []):
                sub_content = sub.get("content", "").strip()
                if sub_content:
                    all_comments.append(sub_content)

        cursor = data.get("data", {}).get("cursor", "")
        if not cursor:
            break

        # 防止超过上限
        if len(all_comments) >= MAX_COMMENTS:
            all_comments = all_comments[:MAX_COMMENTS]
            break

    return all_comments
