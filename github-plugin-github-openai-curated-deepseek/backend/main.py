import json
import logging
import os
import time
from collections import deque
from typing import Any, AsyncGenerator

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from openai import AsyncOpenAI, APIConnectionError, APIStatusError, AuthenticationError, RateLimitError
from pydantic import BaseModel, Field, field_validator


DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY")
FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend"))

MODEL_CATALOG = {
    "deepseek-chat": {
        "name": "DeepSeek Chat",
        "description": "适合聊天、写作、总结、信息整理等通用任务。",
        "price": "输入约 0.27 元/百万 tokens，输出约 1.10 元/百万 tokens",
        "input_cny_per_million": 0.27,
        "output_cny_per_million": 1.10,
    },
    "deepseek-reasoner": {
        "name": "DeepSeek Reasoner",
        "description": "适合复杂推理、代码分析、数学和多步骤问题。",
        "price": "输入约 0.55 元/百万 tokens，输出约 2.19 元/百万 tokens",
        "input_cny_per_million": 0.55,
        "output_cny_per_million": 2.19,
    },
}

ERROR_HINTS = {
    400: "请求参数格式不对，请检查问题、系统提示词或回复长度。",
    401: "API Key 无效或已过期，请重新创建并粘贴密钥。",
    402: "账户余额可能不足，请前往 DeepSeek 控制台充值或检查额度。",
    403: "当前 Key 没有权限访问这个模型，请检查模型权限。",
    429: "请求太频繁了，请稍等几秒再试，或降低调用频率。",
    500: "DeepSeek 服务暂时异常，请稍后重试。",
}

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("deepseek-workbench")
recent_latencies: deque[float] = deque(maxlen=200)

app = FastAPI(
    title="DeepSeek API 极简入门工作台",
    description="A beginner-friendly teaching workbench for DeepSeek API calls.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    api_key: str | None = Field(default=None, min_length=1)
    model: str = Field(default="deepseek-chat")
    system_prompt: str = Field(default="你是一个耐心、清晰的中文 AI 助手。", max_length=3000)
    user_prompt: str = Field(..., min_length=1, max_length=12000)
    temperature: float = Field(default=0.7, ge=0, le=2)
    max_tokens: int = Field(default=800, ge=64, le=4096)
    stream: bool = True

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        if value not in MODEL_CATALOG:
            raise ValueError("请选择支持的 DeepSeek 模型。")
        return value


class KeyTestRequest(BaseModel):
    api_key: str | None = Field(default=None, min_length=1)
    model: str = Field(default="deepseek-chat")


class PromptHelpRequest(BaseModel):
    api_key: str | None = Field(default=None, min_length=1)
    idea: str = Field(..., min_length=2, max_length=1000)
    model: str = Field(default="deepseek-chat")


def resolve_key(user_key: str | None) -> str:
    key = user_key or DEEPSEEK_API_KEY
    if not key:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "还没有可用 API Key。你可以在页面粘贴临时 Key，或在后端设置 DEEPSEEK_API_KEY。",
                "hint": "本地演示建议粘贴临时 Key；线上部署建议使用后端环境变量。",
            },
        )
    return key


def client_for(api_key: str) -> AsyncOpenAI:
    return AsyncOpenAI(api_key=api_key, base_url=DEEPSEEK_BASE_URL)


def plain_error(exc: Exception) -> dict[str, Any]:
    if isinstance(exc, AuthenticationError):
        return {"message": ERROR_HINTS[401], "status": 401}
    if isinstance(exc, RateLimitError):
        return {"message": ERROR_HINTS[429], "status": 429}
    if isinstance(exc, APIConnectionError):
        return {"message": "网络连接失败，请检查网络、代理或服务器是否能访问 DeepSeek API。", "status": 503}
    if isinstance(exc, APIStatusError):
        return {
            "message": ERROR_HINTS.get(exc.status_code, f"DeepSeek 返回了 {exc.status_code} 错误。"),
            "status": exc.status_code,
            "raw": getattr(exc, "message", str(exc)),
        }
    return {"message": "调用失败，请稍后重试或检查参数。", "status": 500, "raw": str(exc)}


@app.get("/api/models")
async def models() -> dict[str, Any]:
    return {"models": MODEL_CATALOG}


@app.get("/api/metrics")
async def metrics() -> dict[str, Any]:
    values = sorted(recent_latencies)
    p99 = values[int(len(values) * 0.99) - 1] if values else 0
    return {"calls": len(values), "p99_ms": round(p99 * 1000, 1)}


@app.post("/api/test")
async def test_key(payload: KeyTestRequest) -> dict[str, Any]:
    started = time.perf_counter()
    client = client_for(resolve_key(payload.api_key))
    try:
        result = await client.chat.completions.create(
            model=payload.model,
            messages=[{"role": "user", "content": "请只回复：连接成功"}],
            temperature=0,
            max_tokens=16,
            stream=False,
        )
        latency = time.perf_counter() - started
        recent_latencies.append(latency)
        return {
            "ok": True,
            "message": result.choices[0].message.content or "连接成功",
            "latency_ms": round(latency * 1000),
        }
    except Exception as exc:
        err = plain_error(exc)
        raise HTTPException(status_code=err["status"], detail=err) from exc


@app.post("/api/prompt-helper")
async def prompt_helper(payload: PromptHelpRequest) -> dict[str, str]:
    client = client_for(resolve_key(payload.api_key))
    try:
        result = await client.chat.completions.create(
            model=payload.model,
            messages=[
                {
                    "role": "system",
                    "content": "你是提示词教练。把用户的模糊想法改写成清晰、可执行的中文提示词，只输出提示词本身。",
                },
                {"role": "user", "content": payload.idea},
            ],
            temperature=0.5,
            max_tokens=500,
        )
        return {"prompt": result.choices[0].message.content.strip()}
    except Exception as exc:
        err = plain_error(exc)
        raise HTTPException(status_code=err["status"], detail=err) from exc


async def stream_chat(payload: ChatRequest, request: Request) -> AsyncGenerator[str, None]:
    started = time.perf_counter()
    first_token_at: float | None = None
    output_tokens = 0
    client = client_for(resolve_key(payload.api_key))
    request_body = {
        "model": payload.model,
        "messages": [
            {"role": "system", "content": payload.system_prompt},
            {"role": "user", "content": payload.user_prompt},
        ],
        "temperature": payload.temperature,
        "max_tokens": payload.max_tokens,
        "stream": True,
    }

    yield f"event: meta\ndata: {json.dumps({'started_at': started})}\n\n"
    try:
        stream = await client.chat.completions.create(**request_body)
        async for chunk in stream:
            if await request.is_disconnected():
                logger.info("client disconnected")
                break
            delta = chunk.choices[0].delta.content if chunk.choices else None
            if not delta:
                continue
            output_tokens += max(1, len(delta) // 2)
            if first_token_at is None:
                first_token_at = time.perf_counter()
                yield f"event: timing\ndata: {json.dumps({'first_token_ms': round((first_token_at - started) * 1000)})}\n\n"
            yield f"event: token\ndata: {json.dumps({'text': delta}, ensure_ascii=False)}\n\n"

        total = time.perf_counter() - started
        recent_latencies.append(total)
        input_estimate = max(1, (len(payload.system_prompt) + len(payload.user_prompt)) // 2)
        model_price = MODEL_CATALOG[payload.model]
        cost = (
            input_estimate / 1_000_000 * model_price["input_cny_per_million"]
            + output_tokens / 1_000_000 * model_price["output_cny_per_million"]
        )
        yield f"event: done\ndata: {json.dumps({'total_ms': round(total * 1000), 'input_tokens': input_estimate, 'output_tokens': output_tokens, 'estimated_cost_cny': round(cost, 6)})}\n\n"
    except Exception as exc:
        err = plain_error(exc)
        yield f"event: error\ndata: {json.dumps(err, ensure_ascii=False)}\n\n"


@app.post("/api/chat")
async def chat(payload: ChatRequest, request: Request) -> StreamingResponse:
    return StreamingResponse(stream_chat(payload, request), media_type="text/event-stream")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))


app.mount("/", StaticFiles(directory=FRONTEND_DIR), name="frontend")
