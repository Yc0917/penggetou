"""本地单进程应用：提供网页、地点搜索与会合推荐接口。"""

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .baidu import BaiduClient, MapServiceError
from .models import MeetingRequest, Point

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


@asynccontextmanager
async def lifespan(application: FastAPI):
    application.state.baidu = BaiduClient(os.getenv("BAIDU_SERVER_AK", "").strip())
    # 本地演示一次只算一个方案，避免多个方案争用地图配额。
    application.state.jobs = asyncio.Semaphore(1)
    yield
    await application.state.baidu.close()


app = FastAPI(title="碰个头", description="多人公平会合地图", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


@app.middleware("http")
async def private_responses(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    elif request.url.path == "/" or request.url.path.startswith("/static/"):
        # 本地开发每次核对文件版本，防止新版页面混用旧版脚本。
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.exception_handler(MapServiceError)
async def map_error(_request, error: MapServiceError):
    return JSONResponse(status_code=error.status_code, content={"detail": error.message})


@app.exception_handler(RequestValidationError)
async def validation_error(_request, _error):
    if _request.url.path == "/api/location":
        return JSONResponse(status_code=422, content={"detail": "定位坐标无效，请重新定位或手动选择出发地点。"})
    return JSONResponse(status_code=422, content={
        "detail": "请检查输入：需要 2～6 位参与者、有效出发地点，以及 5～180 分钟的时间上限。"})


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/api/config")
async def config(request: Request):
    # 浏览器 AK 是公开客户端配置，服务端 AK 永不输出。
    return {"live_ready": bool(request.app.state.baidu.ak),
            "browser_ak": os.getenv("BAIDU_BROWSER_AK", "").strip()}


@app.post("/api/location")
async def location(payload: Point, request: Request):
    # 浏览器坐标放在请求体中，避免精确位置进入访问日志的 URL。
    place = await request.app.state.baidu.locate(payload)
    return {"place": place.model_dump()}


@app.get("/api/places")
async def places(request: Request, q: str = Query(min_length=2, max_length=80),
                 city: str = Query(min_length=2, max_length=30)):
    results = await request.app.state.baidu.search(q.strip(), city.strip())
    return {"places": [place.model_dump() for place in results]}


@app.post("/api/recommend")
async def recommend(payload: MeetingRequest, request: Request):
    jobs = request.app.state.jobs
    if jobs.locked():
        raise HTTPException(429, "正在计算其他方案，请稍后重试。")
    async with jobs:
        try:
            async with asyncio.timeout(90):
                return await request.app.state.baidu.recommend(payload)
        except TimeoutError:
            raise HTTPException(504, "路线计算超时，请稍后重试或减少参与人数。") from None
