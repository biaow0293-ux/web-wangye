# DeepSeek API 极简入门工作台

一个让完全不懂代码的人，也能在 5 分钟内学会调用 DeepSeek 大模型，并进行对话、创作、分析的交互式教学网页。

## 项目故事

我自己一开始想用 DeepSeek 做点东西，但发现身边很多非技术朋友根本不知道怎么调 API，官方文档对他们像天书。同时算力和预算也不是无限的，所以我做了这个极简工作台：核心就一件事，让人在 5 分钟内完成第一次 API 调用，并理解背后的逻辑。

## 核心功能

- 分步配置向导：获取密钥、粘贴并测试、选择模型，带卡点提示和可回看教程。
- 可视化请求构造器：把 `messages`、`temperature`、`max_tokens` 翻译成系统提示词、问题、创意程度、回复长度。
- 流式输出体验：通过 SSE 展示逐字生成、首 Token 延迟、总耗时、本轮 tokens 和费用估算。
- 教学与防错：把常见 API 错误翻译成小白能理解的话，成功调用后展示学习要点。
- 用量管理：本地统计累计 tokens、估算费用、月度预算预警。
- 本地记录：使用 `localStorage` 保存历史对话；API Key 使用 Web Crypto 加密并设置 7 天过期提醒。

## 技术架构

```text
浏览器静态页面
  ├─ 配置向导、请求构造器、历史记录、预算预警
  └─ fetch / SSE

FastAPI 后端代理
  ├─ /api/test 测试 DeepSeek Key
  ├─ /api/chat 转发 DeepSeek 流式对话
  ├─ /api/prompt-helper 用 AI 帮用户优化提示词
  └─ /api/metrics 简单延迟观测

DeepSeek API
  └─ OpenAI 兼容接口
```

## 快速开始

1. 安装 Python 3.11+。
2. 安装依赖：

```bash
pip install -r backend/requirements.txt
```

3. 可选：设置后端环境变量。如果不设置，也可以在页面里临时粘贴用户自己的 DeepSeek Key。

```bash
copy .env.example .env
```

PowerShell 示例：

```powershell
$env:DEEPSEEK_API_KEY="sk-your-deepseek-key"
```

4. 启动服务：

```bash
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

5. 打开浏览器访问：

```text
http://localhost:8000
```

## Docker 部署

```bash
docker build -t deepseek-api-workbench .
docker run -p 8000:8000 -e DEEPSEEK_API_KEY=sk-your-key deepseek-api-workbench
```

也可以部署到 Railway、Render 或任意云服务器。Vercel 只适合部署前端；完整体验建议把 FastAPI 代理一起部署。

## 面试展示话术

### Situation

身边的零基础用户想尝试大模型 API，但卡在环境配置、密钥、参数、错误处理和费用理解上。

### Task

做一个把 API 调用过程产品化、教学化的工具，让用户不用写代码也能完成第一次调用。

### Action

- 用分步向导降低开始门槛。
- 用可视化请求预览把抽象 JSON 参数变成可理解的交互。
- 用 FastAPI 代理保护密钥、统一错误翻译，并通过 SSE 提供流式输出。
- 用本地加密、历史记录、费用估算和预算预警，让用户形成成本意识。

### Result

目标是让首次 API 调用从传统的约 30 分钟配置和排错，缩短到 5 分钟以内。后续可以找 5 位零基础用户测试，记录首次成功率、平均完成时间和满意度，并把数据补充到 README。

## 下一步

- 接入 Web Speech API，让用户用语音输入提示词。
- 增加一键分享对话卡片。
- 加入更完整的错误码映射和请求重试策略。
- 将 `/api/metrics` 扩展为 P50/P95/P99 延迟面板。
