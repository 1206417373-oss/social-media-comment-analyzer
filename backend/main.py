"""
社交媒体用户评论分析 - FastAPI 后端服务

提供统一的 API 接口，调用各平台爬虫获取内容，
并通过 DeepSeek AI 进行5层框架分析。
"""

import os
import json
import re
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from dotenv import load_dotenv

# 确保从 backend/.env 加载（无论从哪个目录启动）
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

print("XHS_COOKIE前20字符:", os.getenv("XHS_COOKIE", "未读取到")[:20])

app = FastAPI(title="社交媒体用户评论分析 API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 支持的平台列表
SUPPORTED_PLATFORMS = {"xiaohongshu", "douyin", "weibo"}

# DeepSeek API 配置
DEEPSEEK_ENDPOINT = "https://api.deepseek.com/v1/chat/completions"
DEEPSEEK_MODEL = "deepseek-chat"

# 内存变量：插件分析结果暂存
_latest_result: dict | None = None

# index.html 绝对路径
INDEX_HTML_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "index.html")

# ===== 数据模型 =====

class AnalyzeRequest(BaseModel):
    url: str = Field(..., description="帖子URL")
    platform: str = Field(..., description="平台标识: xiaohongshu, douyin, weibo")
    deepseek_api_key: str = Field(..., description="用户的DeepSeek API Key")

class AnalyzeDirectRequest(BaseModel):
    platform: str = Field(..., description="平台标识: xiaohongshu, douyin, weibo")
    post_content: str = Field(default="", description="帖子正文")
    images: list[str] = Field(default=[], description="图片URL列表")
    comments: list[str] = Field(default=[], description="评论列表")
    deepseek_api_key: str = Field(..., description="用户的DeepSeek API Key")

class StoreResultRequest(BaseModel):
    result: dict = Field(..., description="完整的分析结果数据")

class AnalyzeResponse(BaseModel):
    success: bool
    data: dict | None = None
    error: str | None = None

# ===== Prompt 模板 =====

SYSTEM_PROMPT = (
    "你是一名专业的用户运营分析师，擅长从社交媒体评论中提炼用户需求。"
    "请严格按照JSON格式返回分析结果，不要输出任何其他内容、markdown或代码块。"
)

USER_PROMPT_TEMPLATE = """请用以下5层框架分析{platform}帖子的评论内容，严格返回如下JSON结构：

{{
  "sentiment": {{"positive": 数字, "negative": 数字, "neutral": 数字}},
  "who": {{
    "user_type": ["标签1","标签2"],
    "说明": "从评论行为可推断的用户特征，只写有评论依据的，可包括：是否老粉、是否有购买意向、是否有KOC潜质"
  }},
  "what": {{
    "keywords": ["关键词1","关键词2"],
    "topics": ["主题1","主题2"],
    "hot_questions": ["高频问题1","高频问题2"]
  }},
  "why": {{
    "core_needs": ["核心需求1","核心需求2"],
    "pain_points": [
      {{"point": "痛点描述", "evidence": ["原始评论1","原始评论2"]}}
    ]
  }},
  "action_signals": {{
    "purchase_intent": ["有购买意向的原始评论"],
    "compare_behavior": ["有比价/比较行为的原始评论"],
    "churn_risk": ["有流失风险信号的原始评论"]
  }},
  "so_what": {{
    "activity": "活动策划建议：基于用户痛点，建议策划什么活动，30字以内",
    "push_strategy": "推送策略建议：什么内容推给什么用户、什么时机，30字以内",
    "user_tag": "用户标签建议：建议给这批用户打什么标签、如何分层，30字以内",
    "content_topic": "内容选题建议：平台应产出什么内容承接需求，30字以内"
  }}
}}

帖子正文：{post_content}
帖子包含{image_count}张图片，图片URL：{image_urls}
用户评论：{comments_text}"""

# ===== 辅助函数 =====

def _validate_platform(platform: str):
    """验证平台是否支持，返回平台中文名。"""
    platform_map = {
        "xiaohongshu": "小红书",
        "douyin": "抖音",
        "weibo": "微博",
    }
    if platform not in SUPPORTED_PLATFORMS:
        raise ValueError("不支持的平台或URL格式")
    return platform_map[platform]


async def _crawl_post(url: str, platform: str) -> dict:
    """根据平台调用对应爬虫获取数据。"""
    if platform == "xiaohongshu":
        from crawlers.xiaohongshu import fetch_post
        cookie = os.getenv("XHS_COOKIE", "")
        if not cookie:
            raise RuntimeError("请先在 .env 中配置 XHS_COOKIE")
        print(f"[爬虫诊断] Cookie长度: {len(cookie)}, 前30字符: {cookie[:30]}")
        return await fetch_post(url, cookie)

    elif platform == "douyin":
        from crawlers.douyin import fetch_post
        cookie = os.getenv("DOUYIN_COOKIE", "")
        if not cookie:
            raise RuntimeError("请先在 .env 中配置 DOUYIN_COOKIE")
        print(f"[爬虫诊断] Cookie长度: {len(cookie)}, 前30字符: {cookie[:30]}")
        return await fetch_post(url, cookie)

    raise ValueError(f"平台 '{platform}' 的爬虫尚未实现")


async def _call_deepseek(api_key: str, platform_name: str, post_data: dict) -> dict:
    """调用DeepSeek API进行5层框架分析。"""
    post_content = post_data.get("post_content", "（无正文）")
    images = post_data.get("images", [])
    comments = post_data.get("comments", [])
    image_urls = ", ".join(images) if images else "无图片"

    user_prompt = USER_PROMPT_TEMPLATE.format(
        platform=platform_name,
        post_content=post_content[:3000],
        image_count=len(images),
        image_urls=image_urls,
        comments_text="\n".join(comments)[:5000],
    )

    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            DEEPSEEK_ENDPOINT,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": DEEPSEEK_MODEL,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": 0.3,
                "max_tokens": 4096,
            },
        )

        if resp.status_code != 200:
            err_detail = resp.text
            try:
                err_json = resp.json()
                err_detail = err_json.get("error", {}).get("message", resp.text)
            except Exception:
                pass
            raise RuntimeError(f"AI分析失败：{err_detail}")

        data = resp.json()
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        if not content:
            raise RuntimeError("AI分析失败：返回内容为空")

    # 提取JSON
    json_str = content.strip()
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", json_str)
    if m:
        json_str = m.group(1).strip()

    try:
        return json.loads(json_str)
    except json.JSONDecodeError:
        # 尝试修复单引号等问题
        fixed = json_str.replace("'", '"').replace("None", "null").replace("True", "true").replace("False", "false")
        return json.loads(fixed)


# ===== API 接口 =====

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/debug/cookie")
async def debug_cookie(platform: str = "xiaohongshu"):
    """调试接口：查看Cookie是否正确加载。"""
    if platform == "xiaohongshu":
        cookie = os.getenv("XHS_COOKIE", "")
    elif platform == "douyin":
        cookie = os.getenv("DOUYIN_COOKIE", "")
    elif platform == "weibo":
        cookie = os.getenv("WEIBO_COOKIE", "")
    else:
        return {"error": f"未知平台: {platform}"}
    return {
        "platform": platform,
        "cookie_length": len(cookie),
        "cookie_start": cookie[:30] if cookie else "(空)",
    }


@app.get("/")
async def serve_index():
    """直接serve index.html，供插件打开使用。"""
    if os.path.exists(INDEX_HTML_PATH):
        return FileResponse(INDEX_HTML_PATH)
    return {"error": "index.html not found"}


@app.post("/store-result")
async def store_result(req: StoreResultRequest):
    """存储插件分析结果到内存。"""
    global _latest_result
    _latest_result = req.result
    return {"success": True}


@app.get("/latest-result")
async def get_latest_result():
    """返回最新的分析结果，返回后不清除（由 clear-result 清除）。"""
    if _latest_result:
        return {"success": True, "data": _latest_result}
    return {"success": False, "data": None}


@app.post("/clear-result")
async def clear_result():
    """清除已展示的分析结果。"""
    global _latest_result
    _latest_result = None
    return {"success": True}


@app.post("/analyze-direct")
async def analyze_direct(req: AnalyzeDirectRequest):
    """跳过爬虫，直接接收已抓取的数据进行AI分析。"""
    try:
        platform_name = _validate_platform(req.platform)
    except ValueError as e:
        return {"success": False, "error": str(e)}

    post_data = {
        "post_content": req.post_content,
        "images": req.images,
        "comments": req.comments,
        "comment_count": len(req.comments),
    }

    try:
        analysis = await _call_deepseek(req.deepseek_api_key, platform_name, post_data)
    except RuntimeError as e:
        return {"success": False, "error": str(e)}

    return {
        "success": True,
        "data": {
            "platform": req.platform,
            "post_content": req.post_content,
            "images": req.images,
            "comments": req.comments,
            "comment_count": len(req.comments),
            "analysis": analysis,
        },
    }


@app.post("/analyze")
async def analyze(req: AnalyzeRequest):
    try:
        platform_name = _validate_platform(req.platform)
    except ValueError as e:
        return {"success": False, "error": str(e)}

    # 1. 爬取帖子数据
    try:
        post_data = await _crawl_post(req.url, req.platform)
    except ValueError as e:
        return {"success": False, "error": str(e)}
    except RuntimeError as e:
        return {"success": False, "error": str(e)}
    except Exception as e:
        return {"success": False, "error": str(e)}

    # 2. 调用DeepSeek分析
    try:
        analysis = await _call_deepseek(req.deepseek_api_key, platform_name, post_data)
    except RuntimeError as e:
        return {"success": False, "error": str(e)}

    return {
        "success": True,
        "data": {
            "post_content": post_data["post_content"],
            "images": post_data.get("images", []),
            "comments": post_data.get("comments", []),
            "comment_count": post_data.get("comment_count", len(post_data.get("comments", []))),
            "analysis": analysis,
        },
    }
