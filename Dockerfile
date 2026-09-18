# 与本地验证环境保持一致；魔搭要求监听 7860 端口。
FROM python:3.13-slim

WORKDIR /home/user/app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock

# 只复制运行文件；密钥通过平台环境变量注入。
COPY app ./app
COPY static ./static

EXPOSE 7860
# 单进程保留百度请求限流队列，关闭访问日志以避免记录搜索词。
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7860", "--workers", "1", "--no-access-log"]
