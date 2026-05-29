"""
抖音帖子数据抓取模块

通过 Douyin Web API 获取帖子详情和评论数据。
API 签名使用 execjs 调用 MediaCrawler 的 libs/douyin.js。
"""

import os
import re
import json
import random
import urllib.parse
import execjs
import httpx

# 常量
DETAIL_API = "https://www.douyin.com/aweme/v1/web/aweme/detail/"
COMMENT_API = "https://www.douyin.com/aweme/v1/web/comment/list/"
MAX_COMMENTS = 500

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

# douyin.js 签名模块（模块级编译，只加载一次）
_DOUYIN_JS_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "libs", "douyin.js"
)
_DOUYIN_SIGN = execjs.compile(open(_DOUYIN_JS_PATH, encoding="utf-8-sig").read())

# 通用请求头基础
COMMON_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
}

API_HEADERS = {
    **COMMON_HEADERS,
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://www.douyin.com/",
    "Origin": "https://www.douyin.com",
    "Connection": "keep-alive",
    "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
}


def _generate_web_id() -> str:
    """生成19位随机webid（与浏览器端一致）。"""

    def e(t):
        if t is not None:
            return str(t ^ (int(16 * random.random()) >> (t // 4)))
        else:
            return "".join(
                [
                    str(int(1e7)),
                    "-",
                    str(int(1e3)),
                    "-",
                    str(int(4e3)),
                    "-",
                    str(int(8e3)),
                    "-",
                    str(int(1e11)),
                ]
            )

    web_id = "".join(e(int(x)) if x in "018" else x for x in e(None))
    return web_id.replace("-", "")[:19]


def _get_a_bogus(uri: str, params_str: str, user_agent: str) -> str:
    """
    调用 douyin.js 生成 a_bogus 签名。
    uri: 例如 "/aweme/v1/web/comment/list/"
    params_str: URL query string
    """
    js_func = "sign_reply" if "/reply" in uri else "sign_datail"
    return _DOUYIN_SIGN.call(js_func, params_str, user_agent)


def _build_params(uri: str, aweme_id: str, cursor: int = 0) -> dict:
    """构建带 a_bogus 签名的API请求参数。"""
    common = {
        "device_platform": "webapp",
        "aid": "6383",
        "channel": "channel_pc_web",
        "version_code": "190600",
        "version_name": "19.6.0",
        "update_version_code": "170400",
        "pc_client_type": "1",
        "cookie_enabled": "true",
        "browser_language": "zh-CN",
        "browser_platform": "Win32",
        "browser_name": "Chrome",
        "browser_version": "131.0.0.0",
        "browser_online": "true",
        "engine_name": "Blink",
        "os_name": "Windows",
        "os_version": "10",
        "cpu_core_num": "8",
        "device_memory": "8",
        "engine_version": "131.0.0.0",
        "platform": "PC",
        "screen_width": "1920",
        "screen_height": "1080",
        "effective_type": "4g",
        "round_trip_time": "50",
        "webid": _generate_web_id(),
    }

    if "comment/list" in uri:
        params = {
            "aweme_id": aweme_id,
            "cursor": cursor,
            "count": 20,
            "item_type": 0,
        }
    else:
        # detail API
        params = {"aweme_id": aweme_id}

    params.update(common)
    query_string = urllib.parse.urlencode(params)
    a_bogus = _get_a_bogus(uri, query_string, USER_AGENT)
    params["a_bogus"] = a_bogus
    return params


def _extract_aweme_id(url: str) -> str:
    """
    从抖音URL中提取 aweme_id。
    支持格式：
        https://www.douyin.com/video/7525082444551310602
        https://www.douyin.com/note/7525082444551310602
        https://www.douyin.com/user/xxx?modal_id=7525082444551310602
        v.douyin.com/xxxxx (短链，需先解析)
        纯数字ID
    """
    # 纯数字ID
    if url.isdigit():
        return url

    # /video/ 或 /note/ 路径
    m = re.search(r"/(video|note)/(\d+)", url)
    if m:
        return m.group(2)

    # modal_id 查询参数
    parsed = urllib.parse.urlparse(url)
    qs = urllib.parse.parse_qs(parsed.query)
    modal_id = qs.get("modal_id", [None])[0]
    if modal_id and modal_id.isdigit():
        return modal_id

    raise ValueError(f"无法从URL中提取aweme_id: {url}")


async def _resolve_short_link(url: str) -> str:
    """解析 v.douyin.com 短链，跟随重定向获取真实URL。"""
    async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
        resp = await client.get(
            url,
            headers={
                **COMMON_HEADERS,
                "Accept": "text/html,application/xhtml+xml,*/*",
            },
        )
        if resp.status_code in (301, 302, 307, 308):
            location = resp.headers.get("Location", "")
            if location:
                return location
    raise RuntimeError("抖音短链解析失败，请检查链接是否有效")


def _log_failure(context: str, resp) -> None:
    """请求失败时打印诊断信息。"""
    try:
        body_preview = resp.text[:500]
    except Exception:
        body_preview = "(无法读取响应体)"
    dashes = "=" * 60
    print(f"\n{dashes}")
    print(f"[抖音爬虫诊断] {context}")
    print(f"  HTTP状态码: {resp.status_code}")
    print(f"  --- Response Headers ---")
    for key, value in resp.headers.items():
        print(f"    {key}: {value}")
    print(f"  --- Response Body (前500字符) ---")
    print(f"    {body_preview}")
    print(f"{dashes}\n")


async def _fetch_all_comments(
    client: httpx.AsyncClient, headers: dict, aweme_id: str
) -> tuple:
    """分页拉取评论，返回 (total_count, [comment_text, ...])，最多 MAX_COMMENTS 条。"""
    all_comments = []
    cursor = 0
    total_count = 0

    while len(all_comments) < MAX_COMMENTS:
        params = _build_params("/aweme/v1/web/comment/list/", aweme_id, cursor)
        resp = await client.get(COMMENT_API, params=params, headers=headers)

        if resp.status_code != 200:
            _log_failure("评论API", resp)
            break

        try:
            data = resp.json()
        except Exception:
            break

        comment_list = data.get("comments", [])
        if not comment_list:
            break

        for c in comment_list:
            content = c.get("content", "").strip() or c.get("text", "").strip()
            if content:
                all_comments.append(content)

        has_more = data.get("has_more", 0)
        if not has_more:
            break

        cursor = data.get("cursor", cursor + len(comment_list))

    return total_count, all_comments


async def fetch_post(url: str, cookie: str, max_comments: int = MAX_COMMENTS) -> dict:
    """
    根据抖音帖子URL获取内容和评论。

    Args:
        url: 帖子链接（支持 /video/xxx、/note/xxx、v.douyin.com 短链、modal_id）
        cookie: 抖音登录Cookie
        max_comments: 最大评论数（默认500）

    Returns:
        {
            "post_content": "帖子正文",
            "images": ["https://..."],
            "comments": ["评论1", "评论2", ...],
            "comment_count": 123
        }
    """
    # 1. 处理短链
    if "v.douyin.com" in url:
        url = await _resolve_short_link(url)

    # 2. 提取 aweme_id
    aweme_id = _extract_aweme_id(url)

    headers = dict(API_HEADERS)
    if cookie:
        headers["Cookie"] = cookie

    async with httpx.AsyncClient(timeout=60) as client:
        # 3. 获取帖子详情
        detail_params = _build_params("/aweme/v1/web/aweme/detail/", aweme_id)
        resp = await client.get(DETAIL_API, params=detail_params, headers=headers)

        if resp.status_code != 200:
            _log_failure("帖子详情API", resp)
            raise RuntimeError(f"获取抖音帖子详情失败（HTTP {resp.status_code}）")

        # 检测CDN拦截（返回空body或非JSON响应）
        if not resp.text or not resp.text.strip():
            raise RuntimeError(
                "抖音API请求被CDN拦截（返回空响应）。"
                "抖音后端爬虫受反爬机制限制，建议使用Chrome插件方式："
                "在Chrome中打开抖音帖子页 → 点击插件图标 → 开始分析"
            )

        try:
            detail_data = resp.json()
        except Exception:
            # 可能是HTML反爬页面
            if "<html" in resp.text[:200].lower() or resp.text.startswith("<!DOCTYPE"):
                raise RuntimeError(
                    "抖音API返回了HTML页面（反爬验证）。"
                    "建议使用Chrome插件方式进行分析。"
                )
            raise RuntimeError(
                f"解析帖子详情JSON失败。"
                f"建议使用Chrome插件方式：在Chrome中打开抖音帖子页 → 点击插件图标 → 开始分析"
            )

        aweme_detail = detail_data.get("aweme_detail", {})
        if not aweme_detail:
            raise RuntimeError("帖子不存在或已删除")

        # 提取正文和图片
        post_content = aweme_detail.get("desc", "")

        images = []
        for img in aweme_detail.get("images", []):
            url_list = img.get("url_list", [])
            if url_list:
                images.append(url_list[0])

        # 如果没有 images（视频帖），尝试从封面提取
        if not images:
            cover = aweme_detail.get("video", {}).get("cover", {})
            cover_urls = cover.get("url_list", [])
            if cover_urls:
                images.append(cover_urls[0])

        total_comment_count = aweme_detail.get("statistics", {}).get(
            "comment_count", 0
        )

        # 4. 分页拉取评论
        _, comments = await _fetch_all_comments(client, headers, aweme_id)

    return {
        "post_content": post_content,
        "images": images,
        "comments": comments,
        "comment_count": total_comment_count or len(comments),
    }
