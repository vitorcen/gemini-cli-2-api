# Gemini CLI API 服务器测试指南

## 环境要求
- 已构建 gemini-cli 项目 (`npm run build`)
- 已登录 Gemini OAuth (`gemini auth login` 或 `USE_CCPA=1`)

## 启动测试服务器

**重要**: 服务器启动需要约 30 秒等待认证加载

```bash
cd /mnt/c/Work/mcp/gemini-cli/packages/a2a-server
USE_CCPA=1 CODER_AGENT_PORT=41242 node dist/src/http/server.js
```

## 运行测试

```bash
cd /mnt/c/Work/mcp/gemini-cli/test

# 运行所有测试
npm test

# 只运行 OpenAI 测试
npm run test:openai

# 只运行 Claude 测试
npm run test:claude
```

## 当前实现状态

### ✅ 已完成
- **多轮对话支持**: 保留完整 assistant 消息历史
- **OpenAI 工具调用**: tools → Gemini functionDeclarations 转换
- **流式响应**: SSE 格式正确输出
- **工具结果处理**: tool role 消息正确转换为 functionResponse

### ⚠️ 待实现
- **Claude System Prompt**: 当前硬编码注入，应使用原生 systemInstruction
- **Gemini 原生工具传递**: `/v1beta/models/*` 端点工具支持
- **流式工具调用**: 增量 tool_calls delta 事件

## 关键架构

### 消息转换
```typescript
// packages/a2a-server/src/http/adapters/messageConverter.ts
convertOpenAIMessagesToGemini(messages: OpenAIMessage[]): { contents: Content[] }
convertOpenAIToolsToGemini(tools: OpenAITool[]): Tool[]
```

### 工具调用流程
1. **请求**: OpenAI `tools` → Gemini `functionDeclarations`
2. **响应**: Gemini `functionCall` → OpenAI `tool_calls`
3. **结果**: OpenAI `tool` role → Gemini `functionResponse`

## 测试覆盖
- 基础连通性: `basic.test.ts`
- 多轮对话: `openai/conversation.test.ts`
- 工具调用: `openai/tools.test.ts`
