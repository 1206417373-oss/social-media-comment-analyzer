"""
小红书帖子数据抓取模块

通过网页请求方式获取帖子详情，解析 window.__INITIAL_STATE__ 提取内容。
评论通过分页API获取。
"""

import re
import json
import httpx

COMMENT_API = "https://www.xiaohongshu.com/api/sns/web/v2/comment/page"
MAX_COMMENTS = 500

COMMON_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
}

PAGE_HEADERS = {
    **COMMON_HEADERS,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": "https://www.xiaohongshu.com/",
    "Connection": "keep-alive",
    "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
}

API_HEADERS = {
    **COMMON_HEADERS,
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://www.xiaohongshu.com/",
    "Connection": "keep-alive",
    "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "X-Requested-With": "XMLHttpRequest",
}


def _extract_note_id(url: str) -> str:
    """从帖子URL中提取note_id。"""
    m = re.search(r"/explore/([a-f0-9]{24})", url)
    if m:
        return m.group(1)
    m = re.search(r"/discovery/item/([a-f0-9]{24})", url)
    if m:
        return m.group(1)
    m = re.search(r"([a-f0-9]{24})", url)
    if m:
        return m.group(1)
    raise ValueError(f"无法从URL中提取note_id: {url}")


async def _resolve_short_link(url: str) -> str:
    """解析 xhslink.com 短链，跟随重定向拿到真实URL。"""
    async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
        resp = await client.get(url, headers=PAGE_HEADERS)
        if resp.status_code in (301, 302, 307, 308):
            location = resp.headers.get("Location", "")
            if location:
                return location
        body = resp.text
        m = re.search(r"window\.location\.href\s*=\s*['\"]([^'\"]+)['\"]", body)
        if m:
            return m.group(1)
    raise RuntimeError("短链解析失败，请检查链接是否有效")


def _parse_initial_state(html: str) -> dict:
    """从HTML中提取 window.__INITIAL_STATE__ 的JSON数据。"""
    m = re.search(r"window\.__INITIAL_STATE__\s*=\s*({.*?})\s*;", html, re.DOTALL)
    if not m:
        m = re.search(r"window\.__INITIAL_STATE__\s*=\s*({.*?})\s*</script>", html, re.DOTALL)
    if not m:
        raise RuntimeError("无法从页面中提取 __INITIAL_STATE__ 数据")
    raw = m.group(1)
    # 替换 JSON 中未转义的 undefined
    raw = raw.replace("undefined", "null")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise RuntimeError("解析 __INITIAL_STATE__ JSON 失败")


def _extract_note_from_state(state: dict, note_id: str) -> dict:
    """从 __INITIAL_STATE__ 中提取note数据。"""
    note_detail_map = state.get("note", {}).get("noteDetailMap", {})
    note_data = note_detail_map.get(note_id, {})
    if not note_data:
        raise RuntimeError("帖子不存在或已删除")
    note = note_data.get("note", {})
    post_content = note.get("desc", "")
    images = [img.get("url_default", "") for img in note.get("image_list", []) if img.get("url_default")]
    return {"post_content": post_content, "images": images}


async def fetch_post(url: str, cookie: str) -> dict:
    """
    根据小红书帖子URL获取内容和评论。

    Args:
        url: 帖子链接（支持 /explore/xxx 或 xhslink.com 短链）
        cookie: 小红书登录Cookie

    Returns:
        {
            "post_content": "帖子正文",
            "images": ["https://..."],
            "comments": ["评论1", "评论2", ...],
            "comment_count": 123
        }
    """
    page_headers = dict(PAGE_HEADERS)
    if cookie:
        page_headers["Cookie"] = cookie

    # 1. 处理短链
    if "xhslink.com" in url:
        url = await _resolve_short_link(url)

    # 2. 提取note_id
    note_id = _extract_note_id(url)

    async with httpx.AsyncClient(timeout=60) as client:
        # 3. GET 帖子页面，解析 HTML 中的 __INITIAL_STATE__
        page_url = f"https://www.xiaohongshu.com/explore/{note_id}"
        resp = await client.get(page_url, headers=page_headers)

        if resp.status_code != 200:
            _log_failure("帖子页面", resp)
            raise RuntimeError(f"访问帖子页面失败（HTTP {resp.status_code}）")

        html = resp.text
        try:
            state = _parse_initial_state(html)
            note_info = _extract_note_from_state(state, note_id)
        except RuntimeError:
            raise
        except Exception:
            raise RuntimeError("解析帖子页面数据失败")

        # 4. 请求评论（分页）
        api_headers = dict(API_HEADERS)
        if cookie:
            api_headers["Cookie"] = cookie
        total_comment_count, comments = await _fetch_all_comments(client, api_headers, note_id)

    return {
        "post_content": note_info["post_content"],
        "images": note_info["images"],
        "comments": comments,
        "comment_count": total_comment_count,
    }


def _log_failure(context: str, resp) -> None:
    """请求失败时打印诊断信息到终端。"""
    try:
        body_preview = resp.text[:500]
    except Exception:
        body_preview = "(无法读取响应体)"
    print(f"\n{'='*60}")
    print(f"[爬虫诊断] {context}")
    print(f"  HTTP状态码: {resp.status_code}")
    print(f"  --- Response Headers ---")
    for key, value in resp.headers.items():
        print(f"    {key}: {value}")
    print(f"  --- Response Body (前500字符) ---")
    print(f"    {body_preview}")
    print(f"{'='*60}\n")


async def _fetch_all_comments(client: httpx.AsyncClient, headers: dict, note_id: str) -> tuple[int, list[str]]:
    """分页拉取评论，返回 (total_count, comments_list)，最多 MAX_COMMENTS 条。"""
    all_comments = []
    cursor = ""
    total_count = 0

    while len(all_comments) < MAX_COMMENTS:
        params = {
            "note_id": note_id,
            "cursor": cursor,
            "top_comment_id": "",
            "image_scenes": "",
        }
        resp = await client.get(COMMENT_API, params=params, headers=headers)

        if resp.status_code != 200:
            _log_failure("评论API", resp)
            break

        try:
            data = resp.json()
        except Exception:
            break

        total_count = data.get("data", {}).get("total_count", total_count)

        comment_list = data.get("data", {}).get("comments", [])
        if not comment_list:
            break

        for c in comment_list:
            content = c.get("content", "").strip()
            if content:
                all_comments.append(content)
            for sub in c.get("sub_comments", []):
                sub_content = sub.get("content", "").strip()
                if sub_content:
                    all_comments.append(sub_content)

        cursor = data.get("data", {}).get("cursor", "")
        if not cursor:
            break

        if len(all_comments) >= MAX_COMMENTS:
            all_comments = all_comments[:MAX_COMMENTS]
            break

    return total_count, all_comments
