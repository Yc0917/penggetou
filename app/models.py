"""统一使用百度 BD-09 经纬度；出行时间在算法内部以秒计算。"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Point(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class Place(Point):
    uid: str = Field(default="", max_length=128)
    name: str = Field(min_length=1, max_length=120)
    address: str = Field(default="", max_length=300)
    city: str = Field(default="", max_length=60)


class Participant(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=20)
    origin: Place
    max_minutes: int = Field(default=60, ge=5, le=180)


class MeetingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    city: str = Field(min_length=2, max_length=30)
    activity: Literal["coffee", "food"] = "coffee"
    participants: list[Participant] = Field(min_length=2, max_length=6)
