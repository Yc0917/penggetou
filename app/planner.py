"""纯 Python 排序：先判断硬性时间限制，再比较总耗时或最长耗时。"""

import math
from datetime import datetime, timezone

from .models import MeetingRequest, Point


def distance_km(a: Point, b: Point) -> float:
    """直线距离只用于候选召回，不能替代真实公交出行耗时。"""
    lat1, lat2 = math.radians(a.lat), math.radians(b.lat)
    dlat, dlng = lat2 - lat1, math.radians(b.lng - a.lng)
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 6371 * 2 * math.asin(min(1.0, math.sqrt(h)))


def make_result(request: MeetingRequest, candidates: list[dict], *, mode: str,
                searched_count: int, warnings: list[str] | None = None) -> dict:
    """每个候选必须有全员完整路线；缺失路线不能被解释成零耗时。"""
    scored = []
    for candidate in candidates:
        routes = candidate.get("routes", [])
        if len(routes) != len(request.participants) or any(route is None for route in routes):
            continue
        seconds = [route["duration_seconds"] for route in routes]
        excess = [max(0, duration - person.max_minutes * 60)
                  for person, duration in zip(request.participants, seconds)]
        relaxations = [
            {"participant_index": index, "name": request.participants[index].name,
             "extra_minutes": math.ceil(over / 60),
             "required_minutes": math.ceil(seconds[index] / 60)}
            for index, over in enumerate(excess) if over > 0
        ]
        scored.append({
            **candidate,
            "feasible": not any(excess),
            "total_seconds": sum(seconds),
            "longest_seconds": max(seconds),
            "total_minutes": math.ceil(sum(seconds) / 60),
            "longest_minutes": math.ceil(max(seconds) / 60),
            "gap_minutes": math.ceil((max(seconds) - min(seconds)) / 60),
            "relaxations": relaxations,
            "max_excess_seconds": max(excess),
            "total_excess_seconds": sum(excess),
        })
    feasible = [item for item in scored if item["feasible"]]
    efficient = sorted(feasible, key=lambda item: (item["total_seconds"], item["longest_seconds"], item["uid"]))
    balanced = sorted(feasible, key=lambda item: (item["longest_seconds"], item["total_seconds"], item["uid"]))
    # 无解时给出独立的放宽建议，不静默更改用户输入的限制。
    near = sorted((item for item in scored if not item["feasible"]), key=lambda item: (
        item["max_excess_seconds"], item["total_excess_seconds"], item["total_seconds"], item["uid"]))
    return {
        "calculated_at": datetime.now(timezone.utc).isoformat(),
        "mode": mode, "participants": [person.model_dump() for person in request.participants],
        "activity": request.activity, "city": request.city,
        "candidates": scored,
        "rankings": {"balanced": [item["uid"] for item in balanced],
                     "efficient": [item["uid"] for item in efficient]},
        "near_misses": [item["uid"] for item in near[:3]],
        "searched_count": searched_count, "evaluated_count": len(scored),
        "feasible_count": len(feasible), "warnings": warnings or [],
        "scope_note": "推荐仅比较本次召回且路线完整的候选地点，不代表全城最优。",
    }
