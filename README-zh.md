# Gemini CLI - A2A API 中转服务

基于 `@google/gemini-cli@0.8.0-preview.1` 改造的 API 中转服务，将 Claude/OpenAI API 请求转发到 Google Gemini。

## 特性

🔄 **多协议支持**
- Claude Messages API (`/v1/messages`)
- OpenAI Chat Completions API (`/v1/chat/completions`)
- Gemini Native API (`/v1beta/models/*:generateContent`)

🚀 **无缝集成**
- 兼容 Claude CLI
- 兼容 OpenAI SDK
- 支持流式响应
- 支持工具调用（Function Calling）

🎯 **真实测试**
- 端到端集成测试
- 真实 API 调用验证
- Token 使用统计

## 安装

### 全局安装（推荐）

通过 npm 全局安装：

```bash
npm install -g @vitorcen/gemini-cli-2-api
```

## 使用方法

### 启动服务器

**前台模式**（终端显示日志，Ctrl+C 停止）：
```bash
gemini-cli-2-api
```

**后台服务模式**（后台运行）：
```bash
gemini-cli-2-api start
```

### 管理服务器

```bash
gemini-cli-2-api status   # 检查服务器状态
gemini-cli-2-api stop     # 停止后台服务
gemini-cli-2-api -h       # 显示帮助
```

服务器运行在 **41242** 端口，启用 `USE_CCPA=1`。

**启动流程：**
1. 清理 41242 端口的现有进程（如果有）
2. 等待 3 秒进行端口清理
3. 登录 CCPA（约 30 秒）
4. 服务器就绪

**总启动时间：** 约 30-35 秒

## 快速开始（开发模式）

### 1. 安装依赖

```bash
cd /mnt/c/Work/mcp/gemini-cli
npm install
npm run build --workspaces
```

### 2. 启动服务

```bash
cd packages/a2a-server
USE_CCPA=1 CODER_AGENT_PORT=41242 npm start
```

等待约 **30 秒** 直到服务启动完成。

### 3. 使用 Claude CLI 调用 Gemini

**切换到 Gemini**：
```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:41242
claude --model gemini-2.5-pro "Hello, Gemini!"
```

**恢复 Claude**：
```bash
unset ANTHROPIC_BASE_URL
claude --model sonnet "Hello, Claude!"
```

## API 端点

### Claude Messages API

```bash
curl http://localhost:41242/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-pro",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Hello"}
    ]
  }'
```

**流式响应**：
```bash
curl http://localhost:41242/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-flash-latest",
    "stream": true,
    "messages": [...]
  }'
```

### OpenAI Chat Completions API

```bash
curl http://localhost:41242/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-pro",
    "messages": [
      {"role": "user", "content": "Hello"}
    ]
  }'
```

### Gemini Native API

```bash
curl http://localhost:41242/v1beta/models/gemini-2.5-pro:generateContent \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [
      {
        "role": "user",
        "parts": [{"text": "Hello"}]
      }
    ]
  }'
```

## 工具调用（Function Calling）

### Claude 格式

```json
{
  "model": "gemini-2.5-pro",
  "messages": [
    {"role": "user", "content": "What is the weather in Tokyo?"}
  ],
  "tools": [{
    "name": "get_weather",
    "description": "Get weather for a city",
    "input_schema": {
      "type": "object",
      "properties": {
        "location": {"type": "string"}
      },
      "required": ["location"]
    }
  }]
}
```

### OpenAI 格式

```json
{
  "model": "gemini-2.5-pro",
  "messages": [
    {"role": "user", "content": "What is the weather in Tokyo?"}
  ],
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Get weather for a city",
      "parameters": {
        "type": "object",
        "properties": {
          "location": {"type": "string"}
        },
        "required": ["location"]
      }
    }
  }]
}
```

## 工作目录支持

通过 `X-Working-Directory` header 指定工作目录：

```bash
curl http://localhost:41242/v1/messages \
  -H "Content-Type: application/json" \
  -H "X-Working-Directory: /path/to/project" \
  -d '{...}'
```

Claude Code 会自动传递此 header。

## 运行测试

### 方式 1：自动启动服务器

```bash
cd packages/a2a-server
npx vitest run src/http/claudeProxy.test.ts --no-coverage --silent=false
```

### 方式 2：使用已启动的服务器（推荐）

**终端 1 - 启动服务器**：
```bash
cd packages/a2a-server
USE_CCPA=1 CODER_AGENT_PORT=41242 npm start
```

**终端 2 - 运行测试**：
```bash
cd packages/a2a-server
USE_EXISTING_SERVER=1 npx vitest run src/http/*.test.ts --no-coverage --silent=false
```

查看详细测试指南：[TEST_GUIDE.md](packages/a2a-server/TEST_GUIDE.md)

## 测试覆盖

### claudeProxy.test.ts（6 个测试）
- ✅ 非流式消息
- ✅ 流式消息
- ✅ 系统提示
- ✅ 流式工具调用
- ✅ X-Working-Directory header
- ✅ 128KB 大负载

### openaiProxy.test.ts（5 个测试）
- ✅ 多轮对话保持上下文
- ✅ 系统消息处理
- ✅ 工具调用支持
- ✅ 工具结果处理
- ✅ 并行工具调用

### geminiProxy.test.ts（6 个测试）
- ✅ 基础 generateContent
- ✅ 多轮对话
- ✅ tools/functionDeclarations
- ✅ functionResponse 处理
- ✅ systemInstruction 支持
- ✅ 128KB 大负载

## 架构说明

### 核心组件

```
packages/a2a-server/src/http/
├── claudeProxy.ts       # Claude Messages API → Gemini
├── openaiProxy.ts       # OpenAI Chat API → Gemini
├── geminiProxy.ts       # Gemini Native API (直通)
└── adapters/
    └── messageConverter.ts  # 消息格式转换
```

### 关键特性

**1. 系统指令处理**
- Claude `system` → Gemini `systemInstruction`
- OpenAI `system` role → Gemini `systemInstruction`
- 作为 config 参数传递，不注入 contents

**2. 工具调用映射**
- Claude tools → Gemini functionDeclarations
- OpenAI tools → Gemini functionDeclarations
- 自动清理 `$schema` 等元字段
- 支持多轮工具调用

**3. 流式响应**
- 真流式：previousText delta 替代累积
- SSE 格式输出
- 工具调用增量事件

**4. Thought 过滤**
- 自动过滤 thought parts 节省 context
- 如果过滤后为空，保留原始 parts（移除 thoughtSignature）

**5. 大负载支持**
- 支持 128KB+ 输入
- `maxOutputTokens: 20000` 确保足够输出空间
- 突破 100KB 字符串限制（已在 0.8.0 修复）

## 配置

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CODER_AGENT_PORT` | 服务端口 | `41242` |
| `USE_CCPA` | 使用 OAuth 认证 | `1` |
| `USE_EXISTING_SERVER` | 测试时复用已启动服务器 | - |
| `VERBOSE` | 显示详细日志 | - |

### 支持的模型

- `gemini-2.5-pro`
- `gemini-2.5-flash`
- `gemini-flash-latest`
- `gemini-pro-latest`

## 示例：Claude CLI 工作流

```bash
# 1. 启动中转服务
cd packages/a2a-server
USE_CCPA=1 CODER_AGENT_PORT=41242 npm start

# 2. 配置 Claude CLI 使用中转服务
export ANTHROPIC_BASE_URL=http://127.0.0.1:41242

# 3. 使用 Gemini 模型
claude --model gemini-2.5-pro "Explain quantum computing"
claude --model gemini-flash-latest /path/to/code "Review this code"

# 4. 工具调用示例
claude --model gemini-2.5-pro "What's the weather in Tokyo?"

# 5. 恢复 Claude
unset ANTHROPIC_BASE_URL
claude --model sonnet "Hello Claude"
```

## 示例：OpenAI SDK

```python
import openai

client = openai.OpenAI(
    base_url="http://127.0.0.1:41242/v1",
    api_key="dummy"  # 不需要真实 key
)

response = client.chat.completions.create(
    model="gemini-2.5-pro",
    messages=[
        {"role": "user", "content": "Hello Gemini!"}
    ]
)

print(response.choices[0].message.content)
```

## Token 使用统计

测试输出会显示 token 使用情况：

```
📊 Tokens - Input: 4,965, Output: 12
📊 Tokens - Input: 34,106, Output: 23  # 128KB 负载
```

## 故障排查

### 端口冲突
```bash
lsof -ti:41242 | xargs kill -9
```

### 服务启动慢
等待约 30 秒加载 OAuth 认证。

### 测试失败
使用已启动的服务器运行测试：
```bash
USE_EXISTING_SERVER=1 npx vitest run src/http/*.test.ts
```

## 版本信息

- **Base Version**: `@google/gemini-cli@0.8.0-preview.1`
- **改造内容**:
  - ✅ Claude/OpenAI → Gemini 协议转换
  - ✅ 真实集成测试（移除 Mock）
  - ✅ 128KB 大负载支持
  - ✅ Thought 过滤优化
  - ✅ 工作目录传递
  - ✅ Token 统计

## License

Apache-2.0

Copyright 2025 Google LLC
