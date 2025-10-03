# A2A Server 测试指南

## 运行测试

### 方式 1：自动启动服务器（默认）

测试会自动启动服务器，等待 35 秒，然后运行测试：

```bash
# 运行单个测试文件
npx vitest run src/http/claudeProxy.test.ts --no-coverage --silent=false

# 运行所有测试
npx vitest run src/http/*.test.ts --no-coverage --silent=false
```

### 方式 2：使用已启动的服务器（推荐）

**优点**：
- 🚀 跳过 35 秒启动等待
- 👀 可以看到服务器实时输出
- 🔧 便于调试问题

**步骤**：

1. **手动启动服务器**（在终端 1）：
```bash
cd /mnt/c/Work/mcp/gemini-cli/packages/a2a-server
USE_CCPA=1 CODER_AGENT_PORT=41242 npm start
```

等待约 30 秒直到看到服务器启动完成。

2. **运行测试**（在终端 2）：
```bash
cd /mnt/c/Work/mcp/gemini-cli/packages/a2a-server

# 使用已有服务器运行测试
USE_EXISTING_SERVER=1 npx vitest run src/http/claudeProxy.test.ts --no-coverage --silent=false

# 运行所有测试
USE_EXISTING_SERVER=1 npx vitest run src/http/*.test.ts --no-coverage --silent=false
```

## 测试套件

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

## Token 使用统计

所有测试都会打印 token 使用情况：

```
📊 Tokens - Input: 4,965, Output: 12
📊 Tokens - Input: 34,106, Output: 23  # 128KB 大负载
```

## 环境变量

| 变量 | 用途 | 示例 |
|------|------|------|
| `USE_EXISTING_SERVER=1` | 使用已启动的服务器 | `USE_EXISTING_SERVER=1 npx vitest run ...` |
| `VERBOSE=1` | 显示服务器日志 | `VERBOSE=1 npx vitest run ...` |
| `--silent=false` | 显示测试 console 输出 | `npx vitest run --silent=false` |
| `--no-coverage` | 跳过代码覆盖率收集 | `npx vitest run --no-coverage` |

## 常见问题

### 端口冲突
```bash
# 清理占用的端口
lsof -ti:41242 | xargs kill -9
```

### 测试超时
某些测试可能因为网络或 API 响应慢而超时，可以增加超时设置。

### 并发冲突
claudeProxy.test.ts 需要串行运行：
```bash
npx vitest run src/http/claudeProxy.test.ts --pool=forks --poolOptions.forks.singleFork=true
```

## 示例输出

```
🔗 Using existing server on http://localhost:41242
✅ Connected to existing server

📝 Testing non-streaming message...
📊 Tokens - Input: 4,965, Output: 12
✅ Response: Hello. How can I help you today?

 ✓ Claude Proxy API > should handle a non-streaming chat message 1713ms

Test Files  1 passed (1)
Tests       6 passed (6)
```
