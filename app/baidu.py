"""百度服务适配：按服务限速、有限重试、超时与短期内存缓存。"""

import asyncio
import hashlib
import logging
import math
import os
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from urllib.parse import quote_plus

import httpx

from .models import MeetingRequest, Place, Point
from .planner import distance_km, make_result

logger = logging.getLogger("uvicorn.error")


class MapServiceError(Exception):
    def __init__(self, message: str, status_code: int = 502):
        self.message = message
        self.status_code = status_code
        super().__init__(message)


class MapQuotaError(MapServiceError):
    """配额错误必须中止本次推荐，不能作为单个候选失败而被忽略。"""

    def __init__(self, message: str):
        super().__init__(message, 429)


class ServiceQueue:
    """同类服务共用队列；地点检索额外在每次完成后冷却。"""

    def __init__(self):
        self.lock = asyncio.Lock()
        self.next_start = 0.0
        self.daily_block_until = 0.0


def normalized_city(city: str) -> str:
    return city.strip().removesuffix("市")


def as_place(raw: dict) -> Place | None:
    """地区型或门址型搜索结果可能没有完整坐标，需要过滤。"""
    try:
        loc = raw["location"]
        return Place(uid=raw.get("uid", ""), name=raw["name"],
                     lat=float(loc["lat"]), lng=float(loc["lng"]),
                     address=raw.get("address", ""), city=raw.get("city", ""))
    except (KeyError, TypeError, ValueError):
        return None


class BaiduClient:
    def __init__(self, ak: str):
        self.ak = ak
        # 配置 SK 时启用 SN 签名；未配置时兼容原有 IP 白名单方式。
        self.sk = os.getenv("BAIDU_SERVER_SK", "").strip()
        self.http = httpx.AsyncClient(base_url="https://api.map.baidu.com", timeout=12.0)
        # 地点搜索与周边搜索共享百度的地点检索配额。
        self.queues: dict[str, ServiceQueue] = {}
        self.cache: OrderedDict[tuple, tuple[float, dict]] = OrderedDict()
        self.request_number = 0

    async def close(self):
        await self.http.aclose()

    def build_request(self, path: str, params: dict) -> httpx.Request:
        """对实际发送的路径和参数签名，避免编码或参数顺序不一致。"""
        request = self.http.build_request("GET", path, params={**params, "ak": self.ak})
        if self.sk:
            # 按百度协议再次编码后计算 MD5；SK 只参与计算，绝不发送。
            unsigned = request.url.raw_path.decode("ascii")
            signature = hashlib.md5(quote_plus(unsigned + self.sk).encode("utf-8")).hexdigest()
            # 直接追加到原始查询串，确保签名后的参数不再被重新编码。
            request.url = request.url.copy_with(query=request.url.query + b"&sn=" + signature.encode("ascii"))
        return request

    async def get(self, path: str, params: dict, *, no_route_ok: bool = False) -> dict:
        if not self.ak:
            raise MapServiceError("尚未配置百度地图服务端密钥，请先配置 .env 并重启服务。", 503)
        key = (path, tuple(sorted((k, str(v)) for k, v in params.items())))
        service = "place" if path.startswith("/place/") else path
        # 日志只使用固定类别名称，不输出 URL、参数、密钥或地点信息。
        interface = {"/place/v3/region": "place_region", "/place/v3/around": "place_around",
                     "/directionlite/v1/transit": "transit",
                     "/reverse_geocoding/v3/": "reverse_geocoding"}.get(path, "other")
        queue = self.queues.setdefault(service, ServiceQueue())
        # 锁内复查缓存：相同查询一起排队时，只调用一次上游接口。
        async with queue.lock:
            cached = self.cache.get(key)
            if cached and time.monotonic() - cached[0] < 180:
                self.cache.move_to_end(key)
                return cached[1]
            for attempt in range(3):
                if time.time() < queue.daily_block_until:
                    raise MapQuotaError("百度地图该服务今日额度已用完，已停止查询，请次日再试或检查控制台配额。")
                await asyncio.sleep(max(0.0, queue.next_start - time.monotonic()))
                queue.next_start = time.monotonic() + 0.55
                self.request_number += 1
                request_id = self.request_number
                started = time.monotonic()
                response, payload = None, None
                logger.info("baidu_request phase=start pid=%s request=%s time=%s service=%s attempt=%s",
                            os.getpid(), request_id, datetime.now(timezone.utc).isoformat(), interface, attempt + 1)
                try:
                    response = await self.http.send(self.build_request(path, params))
                    # HTTP 429 无法明确区分日额度与短时限流，不盲目重试。
                    if response.status_code == 429:
                        raise MapQuotaError("百度地图限制了请求，已停止本次查询，请稍后重试或检查控制台配额。")
                    response.raise_for_status()
                    payload = response.json()
                except (httpx.HTTPError, ValueError):
                    # 不把含 AK 的 URL、响应正文或第三方异常信息返回给浏览器。
                    raise MapServiceError("地图服务暂时无法连接，请稍后重试。") from None
                finally:
                    # 成功、异常、取消和重试都必须留出冷却期；锁释放后下个调用仍受约束。
                    if service == "place":
                        queue.next_start = max(queue.next_start, time.monotonic() + 1.2)
                    raw_status = str(payload.get("status", "")) if isinstance(payload, dict) else ""
                    safe_status = raw_status if raw_status.isascii() and raw_status.isdigit() and len(raw_status) <= 4 else "unavailable"
                    logger.info("baidu_request phase=end pid=%s request=%s time=%s service=%s http=%s baidu_status=%s duration_ms=%s",
                                os.getpid(), request_id, datetime.now(timezone.utc).isoformat(), interface,
                                response.status_code if response is not None else "unavailable", safe_status,
                                round((time.monotonic() - started) * 1000))
                if not isinstance(payload, dict):
                    raise MapServiceError("地图服务返回了无法识别的数据。")
                status = str(payload.get("status", ""))
                if status in {"4", "302"}:
                    # 按北京时间次日零点恢复；本地重启会清空此内存保护。
                    now = datetime.now(timezone(timedelta(hours=8)))
                    queue.daily_block_until = (now + timedelta(days=1)).replace(
                        hour=0, minute=0, second=0, microsecond=0).timestamp()
                    raise MapQuotaError("百度地图该服务今日额度已用完，已停止查询，请次日再试或检查控制台配额。")
                if status in {"401", "402"}:
                    # 仅已确认的短时限流重试两次；同时满足服务冷却期和重试退避。
                    queue.next_start = max(queue.next_start, time.monotonic() + 2 ** attempt)
                    if attempt < 2:
                        continue
                    raise MapQuotaError("百度地图短时限流，延迟重试后仍未恢复，已停止本次查询，请稍后再试。")
                if no_route_ok and status == "1001":
                    payload = {"result": {"routes": []}}
                elif status != "0":
                    if status in {"101", "200", "201", "202", "203", "210", "211", "240"}:
                        raise MapServiceError("百度地图密钥或服务权限未通过校验，请检查服务端 AK 配置。", 503)
                    raise MapServiceError("地图服务未能完成查询，请检查地点、同城范围和服务权限。")
                self.cache[key] = (time.monotonic(), payload)
                self.cache.move_to_end(key)
                while len(self.cache) > 512:
                    self.cache.popitem(last=False)
                return payload

    async def locate(self, point: Point) -> Place:
        """浏览器提供 WGS84；百度逆地理编码默认返回 BD-09，供后续算路使用。"""
        data = await self.get("/reverse_geocoding/v3/", {
            "location": f"{point.lat:.6f},{point.lng:.6f}",
            "coordtype": "wgs84ll", "output": "json", "extensions_poi": 0,
        })
        try:
            result = data["result"]
            city = result["addressComponent"].get("city")
            if not isinstance(city, str) or not city.strip():
                raise MapServiceError("未能识别定位所在城市，请手动填写城市并选择出发地点。")
            # 使用转换后的原始定位点，不用附近商家的 UID 替换用户实际位置。
            return Place(name="当前位置", city=city.strip(),
                         address=result.get("formatted_address", ""),
                         lat=result["location"]["lat"], lng=result["location"]["lng"])
        except (KeyError, TypeError, ValueError, AttributeError):
            raise MapServiceError("定位地址解析失败，请重新定位或手动选择出发地点。") from None

    async def search(self, query: str, city: str) -> list[Place]:
        data = await self.get("/place/v3/region", {
            "query": query, "region": city, "region_limit": "true",
            "address_result": "false", "output": "json", "page_size": 10, "page_num": 0,
        })
        return [place for raw in data.get("results", []) if (place := as_place(raw))][:8]

    async def around(self, center: Point, radius: int, activity: str) -> list[Place]:
        data = await self.get("/place/v3/around", {
            "query": "咖啡厅" if activity == "coffee" else "餐厅",
            "location": f"{center.lat:.6f},{center.lng:.6f}", "radius": radius,
            "radius_limit": "true", "output": "json", "scope": 1,
            "page_size": 10, "page_num": 0,
        })
        return [place for raw in data.get("results", []) if (place := as_place(raw))]

    async def transit(self, origin: Place, destination: Place) -> dict | None:
        params = {"origin": f"{origin.lat:.6f},{origin.lng:.6f}",
                  "destination": f"{destination.lat:.6f},{destination.lng:.6f}",
                  "coord_type": "bd09ll", "ret_coordtype": "bd09ll", "steps_info": 1}
        if origin.uid:
            params["origin_uid"] = origin.uid
        if destination.uid:
            params["destination_uid"] = destination.uid
        data = await self.get("/directionlite/v1/transit", params, no_route_ok=True)
        result = data.get("result") or {}
        routes = result.get("routes") or []
        if not routes:
            return None
        valid = [route for route in routes if isinstance(route.get("duration"), (int, float))
                 and math.isfinite(route["duration"]) and route["duration"] > 0]
        if not valid:
            raise MapServiceError("路线服务缺少有效耗时，本次结果未纳入推荐。")
        best = min(valid, key=lambda route: route["duration"])
        segments, line_names = [], []
        for step in best.get("steps", []):
            # 兼容接口中单步对象与同一段多个备选步骤的嵌套结构。
            parts = step if isinstance(step, list) else [step]
            part = parts[0] if parts else {}
            if not isinstance(part, dict):
                continue
            vehicle = part.get("vehicle") or {}
            name = vehicle.get("name") or "步行"
            if vehicle.get("name") and name not in line_names:
                line_names.append(name)
            points = []
            for pair in (part.get("path") or "").split(";"):
                try:
                    lng, lat = map(float, pair.split(","))
                    point = Point(lat=lat, lng=lng)
                    points.append([point.lng, point.lat])
                except (TypeError, ValueError):
                    continue
            segments.append({"name": name, "walking": part.get("type") == 5, "points": points})
        return {"duration_seconds": best["duration"], "minutes": math.ceil(best["duration"] / 60),
                "distance_meters": best.get("distance"), "segments": segments,
                "summary": " → ".join(line_names) or "公共交通路线", "source": "baidu"}

    async def recommend(self, request: MeetingRequest) -> dict:
        origins = [person.origin for person in request.participants]
        if any(point.city and normalized_city(point.city) != normalized_city(request.city) for point in origins):
            raise MapServiceError("请在同一个城市选择所有人的出发地点。", 422)
        if any(distance_km(a, b) > 80 for a in origins for b in origins):
            raise MapServiceError("第一版支持出发点相距 80 公里以内的同城会合，请缩小范围。", 422)
        center = Point(lat=sum(point.lat for point in origins) / len(origins),
                       lng=sum(point.lng for point in origins) / len(origins))
        farthest = sorted(origins, key=lambda point: distance_km(point, center), reverse=True)[:2]
        anchors = [center] + [Point(lat=(point.lat + center.lat) / 2,
                                   lng=(point.lng + center.lng) / 2) for point in farthest]
        radius = int(min(6000, max(2000, max(distance_km(point, center) for point in origins) * 600)))
        # 同类服务本就需要排队，顺序调度可在配额失败或超时后立即停止。
        batches = [await self.around(anchor, radius, request.activity) for anchor in anchors]
        # 轮流从多个搜索中心取候选，降低仅搜索几何中心造成的召回偏差。
        unique: dict[str, Place] = {}
        for index in range(max((len(batch) for batch in batches), default=0)):
            for batch in batches:
                if index >= len(batch):
                    continue
                place = batch[index]
                if place.city and normalized_city(place.city) != normalized_city(request.city):
                    continue
                key = place.uid or f"{place.lat:.6f},{place.lng:.6f}:{place.name}"
                if key not in unique:
                    unique[key] = place
        selected = list(unique.items())[:12]
        if not selected:
            return make_result(request, [], mode="live", searched_count=0,
                               warnings=["本次搜索范围内未找到候选地点，可更换活动或调整出发地。"])
        results = []
        for _, place in selected:
            for origin in origins:
                try:
                    results.append(await self.transit(origin, place))
                except MapQuotaError:
                    raise
                except Exception as error:
                    # 普通单条路线失败仍可排除候选；配额不足则停止整个计算。
                    results.append(error)
        candidates, failed, unreachable = [], 0, 0
        for index, (uid, place) in enumerate(selected):
            routes = results[index * len(origins):(index + 1) * len(origins)]
            if any(isinstance(route, BaseException) for route in routes):
                failed += 1
                continue
            if any(route is None for route in routes):
                unreachable += 1
                continue
            candidates.append({**place.model_dump(), "uid": uid, "routes": routes})
        warnings = []
        if failed:
            warnings.append(f"{failed} 个候选地点的路线查询失败，未参与排序，可稍后重试。")
        if unreachable:
            warnings.append(f"{unreachable} 个候选地点没有全员可用的公交方案，未参与排序。")
        if not candidates and failed:
            raise MapServiceError("路线查询未能完整完成，暂时无法判断可行性，请稍后重试。")
        return make_result(request, candidates, mode="live", searched_count=len(selected), warnings=warnings)
