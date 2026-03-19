# 抖音文案一键提取

把抖音分享文本粘进网页，服务端会自动完成：

1. 解析抖音分享链接
2. 下载源视频到本地任务目录
3. 抽取音频并调用本地 Qwen ASR 服务
4. 返回纯文案和 SRT 字幕文件

## 目录

- `server.js`: Node 服务，负责解析链接、创建任务、调用 Python bridge
- `public/`: 前端页面
- `python/`: 音频抽取、ASR 调用和导出逻辑
- `runs/`: 每次任务生成的输出目录
- `one_click_start.py`: 本机一键启动
- `start_all.bat`: Windows 启动入口

## 运行要求

- Node.js
- Python
- 本机可用的 Qwen ASR 环境
- `QWEN_GRADIO_URL=http://127.0.0.1:8000`

## 一键启动

```bat
start_all.bat
```

默认会：

- 检查并启动本地 Qwen ASR 服务
- 启动网页服务 `http://127.0.0.1:3000`
- 自动打开浏览器

## 手动启动

```powershell
node server.js
```

## 健康检查

```powershell
F:\qwen_asr\qwen_asr_env\Scripts\python.exe .\python\bridge.py --health-check
```

网页接口：

- `POST /api/jobs`
- `GET /api/jobs/:jobId`
- `GET /api/download/:jobId/:kind`
- `GET /api/health`
