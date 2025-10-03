# API 接口实现分析与测试方案

## 【Taste】🟡Passable

实现基本可用，但距离生产级别完整 API 还有明显差距。

---

## 【Fatal Issues】致命缺陷

### 1. **OpenAI 接口 (openaiProxy.ts)**

#### 🔴 缺失 Tools/Function Calling
- **标准要求**: `tools` 参数 + `tool_choice` + `tool_calls` 响应
- **当前实现**: 完全缺失
- **影响**: 无法支持任何需要工具调用的场景（如 LangChain, AutoGPT 等）

#### 🔴 消息处理过于简化
```typescript
// 现在：直接拼接所有消息为单个文本
const mergedUserText = (body.messages || [])
  .filter((m) => m && (m.role === 'system' || m.role === 'user'))
  .map((m) => (m.role === 'system' ? `(system) ${m.content}` : m.content))
  .join('\n\n');
```
- **问题**: 丢失 assistant 历史消息，多轮对话完全不可用
- **标准**: 应保持完整的 messages 数组，包括 assistant 回复

#### 🔴 缺失关键参数
- `n` (生成多个回复)
- `stop` (停止序列)
- `presence_penalty` / `frequency_penalty`
- `logit_bias`
- `user` (用户标识)

---

### 2. **Claude 接口 (claudeProxy.ts)**

#### 🟡 工具调用实现不完整
```typescript
// 当前有两个路径：
// 1. 理想路径：结构化 functionCall
// 2. 降级路径：解析 [tool_code] 标记
```
- **问题**: Gemini 的 functionCall 格式与 Claude tools 不完全对应
- **缺失**:
  - 工具定义传递到 Gemini (request.tools → Gemini tools)
  - 工具结果回传处理 (tool_result content type)
  - `tool_choice` 参数支持

#### 🔴 System Prompt 处理有误
```typescript
// 当前实现：硬编码注入到 contents
const systemInstruction = {
  role: 'user',
  parts: [{ text: `System Instructions:\n${systemContent}\n\nIMPORTANT: Follow these instructions for all responses.` }]
};
```
- **问题**: Gemini 2.0+ 有原生 systemInstruction，应该使用
- **副作用**: 浪费 token，且可能被模型忽略

#### 🔴 流式响应状态机有 bug
```typescript
let currentBlockType: 'text' | 'tool_use' | null = null;
let currentContentIndex = -1;

// 问题：没有正确处理交错的 text 和 tool_use
// 当 Gemini 返回 text + functionCall 时，状态管理混乱
```

---

### 3. **Gemini 接口 (geminiProxy.ts)**

#### 🟡 工具调用支持缺失
- 请求中 `tools.functionDeclarations` 未传递给底层
- 响应中 `functionCall` 未映射到标准格式

#### 🟢 相对完整
- SSE 流式正确
- 参数映射正确
- 增量文本处理正确

---

## 【核心数据结构问题】

### ❌ 破坏性转换：消息历史丢失

```typescript
// OpenAI: 支持完整对话历史
messages: [
  {role: "user", content: "Hi"},
  {role: "assistant", content: "Hello!"},
  {role: "user", content: "What did I say?"}
]

// 当前实现：只保留 user/system，丢弃 assistant
// 结果：模型无法知道之前说过什么
```

**正确做法**: 映射为 Gemini Contents 数组
```typescript
contents: [
  {role: "user", parts: [{text: "Hi"}]},
  {role: "model", parts: [{text: "Hello!"}]},
  {role: "user", parts: [{text: "What did I say?"}]}
]
```

---

## 【与标准接口的差距对比】

### OpenAI Chat Completions API

| 特性 | 标准要求 | 当前实现 | 优先级 |
|------|---------|---------|--------|
| 基础消息 | ✅ messages 数组 | 🔴 仅拼接文本 | P0 |
| 工具调用 | ✅ tools + tool_calls | 🔴 完全缺失 | P0 |
| 流式响应 | ✅ SSE delta 格式 | ✅ 正确 | ✅ |
| 函数参数 | ✅ function_call | 🔴 缺失 | P0 |
| 多回复 | ✅ n 参数 | 🔴 缺失 | P1 |
| 停止序列 | ✅ stop | 🔴 缺失 | P1 |
| Token 惩罚 | ✅ penalties | 🔴 缺失 | P2 |
| 使用统计 | ✅ usage | ✅ 正确 | ✅ |

### Claude Messages API

| 特性 | 标准要求 | 当前实现 | 优先级 |
|------|---------|---------|--------|
| 消息格式 | ✅ messages | ✅ 基本正确 | ✅ |
| 系统提示 | ✅ system 字段 | 🟡 硬编码注入 | P0 |
| 工具定义 | ✅ tools 数组 | 🔴 未传递 | P0 |
| 工具使用 | ✅ tool_use block | 🟡 半成品 | P0 |
| 工具结果 | ✅ tool_result | 🔴 缺失 | P0 |
| 流式事件 | ✅ 7 种事件类型 | 🟡 部分实现 | P1 |
| 思维链 | ✅ thinking block | 🔴 缺失 | P2 |

### Gemini API

| 特性 | 标准要求 | 当前实现 | 优先级 |
|------|---------|---------|--------|
| 基础生成 | ✅ generateContent | ✅ 正确 | ✅ |
| 流式生成 | ✅ streamGenerateContent | ✅ 正确 | ✅ |
| 工具声明 | ✅ functionDeclarations | 🔴 缺失 | P0 |
| 工具调用 | ✅ functionCall | 🔴 未处理 | P0 |
| 系统指令 | ✅ systemInstruction | 🔴 未使用 | P0 |
| 思维模式 | ✅ thought parts | 🔴 缺失 | P2 |

---

## 【兼容性问题】

### 对 claude-code-router 的影响

```typescript
// router 期待标准 Claude API：
const response = await fetch(`/v1/messages`, {
  method: 'POST',
  body: JSON.stringify({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 4096,
    messages: [...],
    tools: [...]  // ❌ 当前实现不支持
  })
});
```

**致命问题**:
1. ❌ 工具调用完全不可用 → agent 功能失效
2. ❌ 多轮对话上下文丢失 → 无法维持会话
3. ❌ system prompt 处理不当 → 行为不可预测

---

## 【单元测试验证方案】

### 测试文件结构
```
packages/a2a-server/src/http/__tests__/
├── openaiProxy.test.ts
├── claudeProxy.test.ts
├── geminiProxy.test.ts
└── fixtures/
    ├── openai-requests.json
    ├── claude-requests.json
    └── gemini-requests.json
```

### 1. OpenAI 接口测试

```typescript
// packages/a2a-server/src/http/__tests__/openaiProxy.test.ts

describe('OpenAI Proxy', () => {

  describe('Multi-turn Conversations', () => {
    it('should preserve assistant messages in context', async () => {
      const request = {
        model: 'gpt-4',
        messages: [
          { role: 'user', content: 'My name is Alice' },
          { role: 'assistant', content: 'Nice to meet you, Alice!' },
          { role: 'user', content: 'What is my name?' }
        ]
      };

      const response = await POST('/v1/chat/completions', request);

      // 应该能正确回答 "Alice"，因为保留了对话历史
      expect(response.choices[0].message.content).toContain('Alice');
    });
  });

  describe('Function Calling', () => {
    it('should support tools parameter', async () => {
      const request = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'What is the weather in SF?' }],
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: {
              type: 'object',
              properties: {
                location: { type: 'string' }
              },
              required: ['location']
            }
          }
        }]
      };

      const response = await POST('/v1/chat/completions', request);

      expect(response.choices[0].finish_reason).toBe('tool_calls');
      expect(response.choices[0].message.tool_calls).toBeDefined();
      expect(response.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
    });
  });

  describe('Streaming with Tools', () => {
    it('should stream tool_calls incrementally', async () => {
      const request = {
        model: 'gpt-4',
        stream: true,
        messages: [{ role: 'user', content: 'Call get_weather for NYC' }],
        tools: [/* ... */]
      };

      const chunks = await streamPOST('/v1/chat/completions', request);

      // 验证流式工具调用格式
      const toolCallChunks = chunks.filter(c => c.choices[0].delta.tool_calls);
      expect(toolCallChunks.length).toBeGreaterThan(0);
    });
  });
});
```

### 2. Claude 接口测试

```typescript
// packages/a2a-server/src/http/__tests__/claudeProxy.test.ts

describe('Claude Proxy', () => {

  describe('Tool Use', () => {
    it('should pass tools to Gemini and map responses', async () => {
      const request = {
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        tools: [{
          name: 'get_weather',
          description: 'Get weather info',
          input_schema: {
            type: 'object',
            properties: {
              location: { type: 'string' }
            },
            required: ['location']
          }
        }],
        messages: [{ role: 'user', content: 'Weather in NYC?' }]
      };

      const response = await POST('/v1/messages', request);

      expect(response.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool_use',
            name: 'get_weather',
            input: expect.objectContaining({
              location: expect.stringContaining('NYC')
            })
          })
        ])
      );
    });

    it('should handle tool_result in messages', async () => {
      const request = {
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: 'What is the weather?'
          },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_123',
                name: 'get_weather',
                input: { location: 'NYC' }
              }
            ]
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_123',
                content: 'Sunny, 72F'
              }
            ]
          }
        ]
      };

      const response = await POST('/v1/messages', request);

      expect(response.content[0].type).toBe('text');
      expect(response.content[0].text).toContain('sunny');
    });
  });

  describe('Streaming Events', () => {
    it('should emit correct SSE event sequence', async () => {
      const request = {
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }]
      };

      const events = await streamPOST('/v1/messages', request);

      // 验证事件顺序
      expect(events[0].type).toBe('message_start');
      expect(events[1].type).toBe('content_block_start');
      expect(events.filter(e => e.type === 'content_block_delta').length).toBeGreaterThan(0);
      expect(events[events.length - 2].type).toBe('message_delta');
      expect(events[events.length - 1].type).toBe('message_stop');
    });
  });
});
```

### 3. Gemini 接口测试

```typescript
// packages/a2a-server/src/http/__tests__/geminiProxy.test.ts

describe('Gemini Proxy', () => {

  describe('Function Declarations', () => {
    it('should pass functionDeclarations to Gemini client', async () => {
      const request = {
        contents: [{ role: 'user', parts: [{ text: 'Get weather' }] }],
        generationConfig: { temperature: 0.7 },
        tools: [{
          functionDeclarations: [{
            name: 'get_weather',
            description: 'Get weather',
            parameters: {
              type: 'object',
              properties: {
                location: { type: 'string' }
              }
            }
          }]
        }]
      };

      const response = await POST('/v1beta/models/gemini-2.0-flash:generateContent', request);

      expect(response.candidates[0].content.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            functionCall: expect.objectContaining({
              name: 'get_weather',
              args: expect.any(Object)
            })
          })
        ])
      );
    });
  });

  describe('System Instruction', () => {
    it('should use native systemInstruction field', async () => {
      const mockClient = {
        generateContent: jest.fn()
      };

      const request = {
        systemInstruction: 'You are a helpful assistant',
        contents: [{ role: 'user', parts: [{ text: 'Hi' }] }]
      };

      await POST('/v1beta/models/gemini-2.0-flash:generateContent', request);

      expect(mockClient.generateContent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          systemInstruction: 'You are a helpful assistant'
        }),
        expect.anything(),
        expect.anything()
      );
    });
  });
});
```

### 4. 集成测试（真实客户端）

```typescript
// packages/a2a-server/src/http/__tests__/integration.test.ts

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

describe('Real Client Integration', () => {

  it('should work with official OpenAI SDK', async () => {
    const client = new OpenAI({
      baseURL: 'http://localhost:41242/v1',
      apiKey: 'dummy'
    });

    const response = await client.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Say "test"' }]
    });

    expect(response.choices[0].message.content).toBeTruthy();
  });

  it('should work with official Anthropic SDK', async () => {
    const client = new Anthropic({
      baseURL: 'http://localhost:41242',
      apiKey: 'dummy'
    });

    const response = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Say "test"' }]
    });

    expect(response.content[0].type).toBe('text');
  });
});
```

### 5. 测试工具函数

```typescript
// packages/a2a-server/src/http/__tests__/utils.ts

import { EventEmitter } from 'events';

export async function streamPOST(url: string, body: any): Promise<any[]> {
  const response = await fetch(`http://localhost:41242${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true })
  });

  const events: any[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value);
    const lines = text.split('\n').filter(Boolean);

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        events.push(JSON.parse(data));
      } else if (line.startsWith('event: ')) {
        const eventType = line.slice(7);
        const dataLine = lines[lines.indexOf(line) + 1];
        if (dataLine?.startsWith('data: ')) {
          events.push({
            type: eventType,
            ...JSON.parse(dataLine.slice(6))
          });
        }
      }
    }
  }

  return events;
}
```

---

## 【修复优先级】

### P0 - 阻塞性问题（必须立即修复）
1. **OpenAI 消息历史保留** - 当前多轮对话完全不可用
2. **OpenAI 工具调用支持** - 缺失核心功能
3. **Claude 工具定义传递** - 无法与 Gemini tools 集成
4. **Claude System Prompt** - 使用原生 systemInstruction
5. **Gemini 工具支持** - 传递 functionDeclarations

### P1 - 重要缺失（尽快修复）
1. OpenAI stop/penalties 参数
2. Claude 工具结果处理
3. 流式响应错误处理增强

### P2 - 增强功能（可后续优化）
1. Thinking/reasoning 模式
2. 多回复生成 (n 参数)
3. 性能优化和缓存

---

## 【测试覆盖率目标】

- **单元测试**: 80%+ 代码覆盖
- **集成测试**: 100% 关键路径
- **兼容性测试**: 真实 SDK 全场景

### 运行测试
```bash
# 单元测试
npm test

# 集成测试（需要启动服务）
npm run test:integration

# 覆盖率报告
npm run test:coverage
```

---

## 【总结】

**核心问题**: 数据结构设计过于简化，破坏了关键信息

**根本原因**:
- 将多轮对话压缩为单个文本 → 丢失上下文
- 未映射工具调用协议 → 功能不可用
- 硬编码替代原生特性 → 性能和准确性损失

**解决思路**:
1. **重新设计消息映射** - 保持完整 contents 数组
2. **实现工具协议转换** - OpenAI/Claude tools ↔ Gemini functionDeclarations
3. **使用 Gemini 原生特性** - systemInstruction, thought parts
4. **完善测试覆盖** - 确保后续改动不破坏兼容性

按照 Linus 的 Good Taste 原则：**当前实现有太多 special cases（拼接、硬编码、降级解析），应该通过正确的数据结构设计来消除这些特例**。
