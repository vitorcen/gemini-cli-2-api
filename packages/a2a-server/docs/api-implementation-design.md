# API Bridge 实现详细设计文档

## 【架构概览】

```
┌─────────────────┐
│  External Apps  │  (claude-code-router, LangChain, etc.)
│  OpenAI/Claude  │
│     Clients     │
└────────┬────────┘
         │ HTTP/SSE
         ▼
┌─────────────────────────────────────────┐
│         API Bridge (a2a-server)         │
│  ┌───────────┬───────────┬───────────┐  │
│  │  OpenAI   │  Claude   │  Gemini   │  │
│  │  Proxy    │  Proxy    │  Proxy    │  │
│  └─────┬─────┴─────┬─────┴─────┬─────┘  │
│        │           │           │        │
│        │  ┌────────▼────────┐  │        │
│        └──►  Message/Tool   ◄──┘        │
│           │   Converters    │           │
│           └────────┬────────┘           │
└────────────────────┼────────────────────┘
                     │
                     ▼
        ┌────────────────────────┐
        │    Gemini CLI Core     │
        │  ┌──────────────────┐  │
        │  │  GeminiClient    │  │
        │  │  - startChat()   │  │
        │  │  - sendMessage() │  │
        │  │  - setTools()    │  │
        │  └──────────────────┘  │
        └────────┬───────────────┘
                 │
                 ▼
        ┌─────────────────┐
        │   Gemini API    │
        │  gemini-2.5-*   │
        └─────────────────┘
```

---

## 【核心设计原则】Linus Good Taste

### 1. 消除特殊情况

**❌ Bad Taste（当前实现）**:
```typescript
// 多个 if-else 处理不同消息类型
if (role === 'system') {
  // 特殊处理 1
} else if (role === 'user') {
  // 特殊处理 2
} else if (role === 'assistant') {
  // 特殊处理 3
}
```

**✅ Good Taste（新设计）**:
```typescript
// 统一的数据转换管道
const converters = {
  'openai': new OpenAIMessageConverter(),
  'claude': new ClaudeMessageConverter(),
  'gemini': new GeminiMessageConverter()
};

// 所有 API 使用同一套流程
messages → converter.toGemini() → GeminiClient → converter.fromGemini() → response
```

### 2. 数据结构设计

**核心思想**: 保持信息完整性，避免破坏性转换

```typescript
// ❌ 错误：拼接文本丢失结构
const text = messages.map(m => m.content).join('\n');

// ✅ 正确：保持完整对话历史
const contents: Content[] = messages.map(convertMessage);
```

---

## 【数据模型】

### 统一消息格式

```typescript
// Gemini 原生格式（作为中间格式）
interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

interface Part {
  text?: string;
  functionCall?: FunctionCall;
  functionResponse?: FunctionResponse;
  thought?: boolean;
}
```

### 工具定义映射

```typescript
// OpenAI → Gemini
{
  type: 'function',
  function: {
    name: 'get_weather',
    parameters: {...}
  }
}
→
{
  name: 'get_weather',
  description: '...',
  parameters: {...}
}

// Claude → Gemini
{
  name: 'get_weather',
  input_schema: {...}
}
→
{
  name: 'get_weather',
  description: '...',
  parameters: {...}  // input_schema 直接作为 parameters
}
```

---

## 【实现详情】

### Phase 1: OpenAI 多轮对话修复

**问题分析**:
```typescript
// 当前代码（openaiProxy.ts:43-46）
const mergedUserText = (body.messages || [])
  .filter((m) => m && (m.role === 'system' || m.role === 'user'))
  .map((m) => (m.role === 'system' ? `(system) ${m.content}` : m.content))
  .join('\n\n');
```

**致命缺陷**:
1. 过滤掉了 `assistant` 角色 → 丢失对话历史
2. 拼接为单个文本 → 无法维持多轮状态
3. 每次都是单次请求 → 模型无记忆

**修复方案**:

```typescript
// packages/a2a-server/src/http/adapters/messageConverter.ts

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function convertOpenAIMessagesToGemini(
  messages: OpenAIMessage[]
): { contents: Content[]; systemInstruction?: string } {
  const contents: Content[] = [];
  let systemInstruction = '';

  for (const msg of messages) {
    if (msg.role === 'system') {
      // 收集系统提示
      systemInstruction += msg.content + '\n\n';
    } else if (msg.role === 'user') {
      contents.push({
        role: 'user',
        parts: [{ text: msg.content }]
      });
    } else if (msg.role === 'assistant') {
      // ✅ 关键：保留 assistant 消息
      contents.push({
        role: 'model',  // Gemini 使用 'model'
        parts: [{ text: msg.content }]
      });
    }
  }

  return {
    contents,
    systemInstruction: systemInstruction.trim() || undefined
  };
}
```

**使用方式**:

```typescript
// packages/a2a-server/src/http/openaiProxy.ts (重构)

import { convertOpenAIMessagesToGemini } from './adapters/messageConverter.js';

app.post('/v1/chat/completions', async (req, res) => {
  const body = req.body;
  const { contents, systemInstruction } = convertOpenAIMessagesToGemini(
    body.messages
  );

  // ✅ 使用多轮对话而非单次请求
  const geminiClient = config.getGeminiClient();
  const chat = await geminiClient.startChat(
    contents.slice(0, -1)  // 历史消息
  );

  // systemInstruction 会自动被 GeminiClient 处理
  // 发送最后一条用户消息
  const lastMessage = contents[contents.length - 1];
  const response = await chat.sendMessage(lastMessage.parts[0].text);

  // ... 返回 OpenAI 格式响应
});
```

**测试验证**:

```typescript
// test/openai/conversation.test.ts

test('preserve assistant messages', async () => {
  const response = await POST('/v1/chat/completions', {
    model: 'gemini-2.5-flash',
    messages: [
      { role: 'user', content: 'My name is Alice' },
      { role: 'assistant', content: 'Nice to meet you, Alice!' },
      { role: 'user', content: 'What is my name?' }
    ]
  });

  console.log('Response:', response.data.choices[0].message.content);

  // 应该包含 "Alice"，证明保留了上下文
  expect(response.data.choices[0].message.content).toMatch(/Alice/i);
});
```

**预期输出**:
```
Response: Your name is Alice.
✓ preserve assistant messages (180ms)
```

---

### Phase 2: OpenAI 工具调用实现

**数据流**:

```
OpenAI Request
  tools: [{
    type: 'function',
    function: {
      name: 'get_weather',
      parameters: {...}
    }
  }]
        ↓
  convertOpenAIToolsToGemini()
        ↓
Gemini Format
  functionDeclarations: [{
    name: 'get_weather',
    parameters: {...}
  }]
        ↓
  chat.setTools([{functionDeclarations}])
        ↓
  Gemini API Call
        ↓
  Response with functionCall
        ↓
  convertGeminiFunctionCallToOpenAI()
        ↓
OpenAI Response
  tool_calls: [{
    id: 'call_123',
    type: 'function',
    function: {
      name: 'get_weather',
      arguments: '{"location":"SF"}'
    }
  }]
```

**实现**:

```typescript
// packages/a2a-server/src/http/adapters/toolConverter.ts

import { v4 as uuidv4 } from 'uuid';

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: object;
  };
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: object;
}

export interface GeminiFunctionCall {
  name: string;
  args: Record<string, any>;
}

/**
 * OpenAI tools → Gemini functionDeclarations
 */
export function convertOpenAIToolsToGemini(
  tools: OpenAITool[]
): GeminiFunctionDeclaration[] {
  return tools
    .filter(tool => tool.type === 'function')
    .map(tool => ({
      name: tool.function.name,
      description: tool.function.description || '',
      parameters: tool.function.parameters
    }));
}

/**
 * Gemini functionCall → OpenAI tool_calls
 */
export function convertGeminiFunctionCallToOpenAI(
  functionCall: GeminiFunctionCall
): OpenAIToolCall {
  return {
    id: `call_${uuidv4()}`,
    type: 'function',
    function: {
      name: functionCall.name,
      arguments: JSON.stringify(functionCall.args)
    }
  };
}

/**
 * OpenAI tool message → Gemini functionResponse
 */
export function convertOpenAIToolResultToGemini(
  toolCallId: string,
  content: string
): {
  functionResponse: {
    name: string;
    response: { result: string };
  };
} {
  return {
    functionResponse: {
      name: 'unknown',  // 需要从上下文中查找
      response: { result: content }
    }
  };
}
```

**OpenAI Proxy 重构**:

```typescript
// packages/a2a-server/src/http/openaiProxy.ts

import {
  convertOpenAIToolsToGemini,
  convertGeminiFunctionCallToOpenAI
} from './adapters/toolConverter.js';

app.post('/v1/chat/completions', async (req, res) => {
  const body = req.body;
  const stream = Boolean(body.stream);

  // 消息转换
  const { contents, systemInstruction } = convertOpenAIMessagesToGemini(
    body.messages
  );

  // 工具转换
  const tools = body.tools
    ? convertOpenAIToolsToGemini(body.tools)
    : [];

  // 启动对话
  const geminiClient = config.getGeminiClient();
  const chat = await geminiClient.startChat(
    contents.slice(0, -1)  // 历史
  );

  // 设置工具
  if (tools.length > 0) {
    chat.setTools([{ functionDeclarations: tools }]);
  }

  const lastMessage = contents[contents.length - 1];

  if (stream) {
    // 流式响应
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const streamGen = await chat.sendMessageStream(
      body.model || 'gemini-2.5-flash',
      {
        message: lastMessage.parts[0].text,
        config: {
          temperature: body.temperature,
          topP: body.top_p,
          maxOutputTokens: body.max_tokens
        }
      },
      uuidv4()
    );

    const id = `chatcmpl_${uuidv4()}`;
    const created = Math.floor(Date.now() / 1000);

    let accumulatedText = '';
    let toolCalls: OpenAIToolCall[] = [];
    let firstChunk = true;

    for await (const chunk of streamGen) {
      if (chunk.type === 'retry') continue;

      const chunkValue = chunk.value;
      const content = chunkValue.candidates?.[0]?.content;

      if (!content) continue;

      // 检查是否有工具调用
      const functionCalls = content.parts?.filter(p => p.functionCall);

      if (functionCalls && functionCalls.length > 0) {
        // 工具调用
        for (const part of functionCalls) {
          if (part.functionCall) {
            const toolCall = convertGeminiFunctionCallToOpenAI(
              part.functionCall
            );
            toolCalls.push(toolCall);
          }
        }

        // 发送工具调用块
        const payload = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: body.model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: toolCalls
            },
            finish_reason: null
          }]
        };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } else {
        // 文本响应
        const textParts = content.parts?.filter(p => p.text && !p.thought);
        const chunkText = textParts?.map(p => p.text).join('') || '';

        if (chunkText.length > 0) {
          const delta = chunkText.slice(accumulatedText.length);
          if (delta.length > 0) {
            const payload = {
              id,
              object: 'chat.completion.chunk',
              created,
              model: body.model,
              choices: [{
                index: 0,
                delta: firstChunk
                  ? { role: 'assistant', content: delta }
                  : { content: delta },
                finish_reason: null
              }]
            };
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
            accumulatedText += delta;
            firstChunk = false;
          }
        }
      }
    }

    // 最终块
    const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
    const stopPayload = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: finishReason
      }]
    };
    res.write(`data: ${JSON.stringify(stopPayload)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();

  } else {
    // 非流式响应
    const response = await chat.sendMessage(lastMessage.parts[0].text);

    const content = response.candidates?.[0]?.content;
    const textParts = content?.parts?.filter(p => p.text && !p.thought);
    const text = textParts?.map(p => p.text).join('') || '';

    // 检查工具调用
    const functionCalls = content?.parts?.filter(p => p.functionCall);
    const toolCalls = functionCalls
      ?.map(p => p.functionCall && convertGeminiFunctionCallToOpenAI(p.functionCall))
      .filter(Boolean) || [];

    const result = {
      id: `chatcmpl_${uuidv4()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: toolCalls.length > 0 ? null : text,
          ...(toolCalls.length > 0 && { tool_calls: toolCalls })
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
      }],
      usage: {
        prompt_tokens: response.usageMetadata?.promptTokenCount || 0,
        completion_tokens: response.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: response.usageMetadata?.totalTokenCount || 0
      }
    };

    res.status(200).json(result);
  }
});
```

**测试**:

```typescript
// test/openai/tools.test.ts

test('function calling', async () => {
  const response = await POST('/v1/chat/completions', {
    model: 'gemini-2.5-flash',
    messages: [
      { role: 'user', content: 'What is the weather in San Francisco?' }
    ],
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
  });

  console.log('Finish reason:', response.data.choices[0].finish_reason);
  console.log('Tool calls:', JSON.stringify(
    response.data.choices[0].message.tool_calls,
    null,
    2
  ));

  expect(response.data.choices[0].finish_reason).toBe('tool_calls');
  expect(response.data.choices[0].message.tool_calls).toBeDefined();
  expect(response.data.choices[0].message.tool_calls[0].function.name)
    .toBe('get_weather');

  const args = JSON.parse(
    response.data.choices[0].message.tool_calls[0].function.arguments
  );
  expect(args.location).toMatch(/San Francisco|SF/i);
});
```

---

### Phase 3: Claude 工具协议修复

**当前问题**:

1. **System Prompt 硬编码注入**（claudeProxy.ts:69-84）:
```typescript
// ❌ 错误：手动注入到 contents
const systemInstruction = {
  role: 'user',
  parts: [{ text: `System Instructions:\n${systemContent}` }]
};
contents.unshift(systemInstruction, modelResponse);
```

**问题**:
- 浪费 token
- Gemini 有原生 `systemInstruction` 支持
- 可能被模型忽略

2. **工具未传递给 Gemini**:
```typescript
// ❌ 当前没有调用 chat.setTools()
```

3. **流式状态机混乱**（claudeProxy.ts:142-152）:
```typescript
let currentBlockType: 'text' | 'tool_use' | null = null;
// 问题：text 和 tool_use 交错时处理不正确
```

**修复方案**:

```typescript
// packages/a2a-server/src/http/adapters/claudeConverter.ts

export interface ClaudeTool {
  name: string;
  description?: string;
  input_schema: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

/**
 * Claude tools → Gemini functionDeclarations
 */
export function convertClaudeToolsToGemini(
  tools: ClaudeTool[]
): GeminiFunctionDeclaration[] {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description || '',
    parameters: tool.input_schema  // 直接使用 input_schema
  }));
}

/**
 * Gemini functionCall → Claude tool_use block
 */
export function convertGeminiFunctionCallToClaude(
  functionCall: GeminiFunctionCall,
  index: number
): {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
} {
  return {
    type: 'tool_use',
    id: `toolu_${uuidv4()}`,
    name: functionCall.name,
    input: functionCall.args
  };
}
```

**Claude Proxy 重构**:

```typescript
// packages/a2a-server/src/http/claudeProxy.ts

import {
  convertClaudeToolsToGemini,
  convertGeminiFunctionCallToClaude
} from './adapters/claudeConverter.js';

app.post('/v1/messages', async (req, res) => {
  const body = req.body;
  const stream = Boolean(body.stream);

  // 消息转换
  const contents: Content[] = body.messages.map((msg: any) => {
    const content = typeof msg.content === 'string'
      ? msg.content
      : msg.content.map((c: any) => c.text).join('\n');

    return {
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: content }]
    };
  });

  // ✅ 工具转换
  const tools = body.tools
    ? convertClaudeToolsToGemini(body.tools)
    : [];

  // 启动对话
  const geminiClient = config.getGeminiClient();
  const chat = await geminiClient.startChat(
    contents.slice(0, -1)
  );

  // ✅ 设置工具
  if (tools.length > 0) {
    chat.setTools([{ functionDeclarations: tools }]);
  }

  // ✅ System prompt 由 GeminiClient 自动处理
  // 无需手动注入

  const lastMessage = contents[contents.length - 1];

  if (stream) {
    // Claude SSE 格式
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const streamGen = await chat.sendMessageStream(
      body.model || 'gemini-2.5-flash',
      {
        message: lastMessage.parts[0].text,
        config: {
          temperature: body.temperature,
          topP: body.top_p,
          maxOutputTokens: body.max_tokens
        }
      },
      uuidv4()
    );

    const messageId = `msg_${uuidv4()}`;

    // 发送 message_start
    writeEvent(res, 'message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });

    let contentIndex = -1;
    let currentBlockType: 'text' | 'tool_use' | null = null;
    let accumulatedText = '';

    for await (const chunk of streamGen) {
      if (chunk.type === 'retry') continue;

      const content = chunk.value.candidates?.[0]?.content;
      if (!content) continue;

      // 检查工具调用
      const functionCalls = content.parts?.filter(p => p.functionCall);
      if (functionCalls && functionCalls.length > 0) {
        // 关闭当前文本块
        if (currentBlockType === 'text') {
          writeEvent(res, 'content_block_stop', {
            type: 'content_block_stop',
            index: contentIndex
          });
        }

        // 工具调用块
        for (const part of functionCalls) {
          if (part.functionCall) {
            contentIndex++;
            currentBlockType = 'tool_use';

            const toolUse = convertGeminiFunctionCallToClaude(
              part.functionCall,
              contentIndex
            );

            writeEvent(res, 'content_block_start', {
              type: 'content_block_start',
              index: contentIndex,
              content_block: toolUse
            });

            writeEvent(res, 'content_block_delta', {
              type: 'content_block_delta',
              index: contentIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify(toolUse.input)
              }
            });

            writeEvent(res, 'content_block_stop', {
              type: 'content_block_stop',
              index: contentIndex
            });

            currentBlockType = null;
          }
        }
      } else {
        // 文本块
        const textParts = content.parts?.filter(p => p.text && !p.thought);
        const chunkText = textParts?.map(p => p.text).join('') || '';

        if (chunkText.length > 0) {
          const delta = chunkText.slice(accumulatedText.length);

          if (delta.length > 0) {
            if (currentBlockType !== 'text') {
              // 开始新文本块
              contentIndex++;
              currentBlockType = 'text';

              writeEvent(res, 'content_block_start', {
                type: 'content_block_start',
                index: contentIndex,
                content_block: { type: 'text', text: '' }
              });
            }

            // 发送文本增量
            writeEvent(res, 'content_block_delta', {
              type: 'content_block_delta',
              index: contentIndex,
              delta: { type: 'text_delta', text: delta }
            });

            accumulatedText += delta;
          }
        }
      }
    }

    // 关闭最后一个块
    if (currentBlockType !== null) {
      writeEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: contentIndex
      });
    }

    // message_delta
    writeEvent(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 0 }
    });

    // message_stop
    writeEvent(res, 'message_stop', {
      type: 'message_stop'
    });

    res.end();
  } else {
    // 非流式
    const response = await chat.sendMessage(lastMessage.parts[0].text);

    const content = response.candidates?.[0]?.content;
    const textParts = content?.parts?.filter(p => p.text && !p.thought);
    const text = textParts?.map(p => p.text).join('') || '';

    const functionCalls = content?.parts?.filter(p => p.functionCall);
    const contentBlocks = [];

    if (text) {
      contentBlocks.push({ type: 'text', text });
    }

    if (functionCalls && functionCalls.length > 0) {
      for (let i = 0; i < functionCalls.length; i++) {
        const fc = functionCalls[i].functionCall;
        if (fc) {
          contentBlocks.push(
            convertGeminiFunctionCallToClaude(fc, contentBlocks.length)
          );
        }
      }
    }

    const result = {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: contentBlocks,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: response.usageMetadata?.promptTokenCount || 0,
        output_tokens: response.usageMetadata?.candidatesTokenCount || 0
      }
    };

    res.status(200).json(result);
  }
});

function writeEvent(res: any, event: string, data: any) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
```

---

## 【测试策略】

### 测试金字塔

```
         ▲
        /E2E\         集成测试（真实 SDK）
       /─────\
      /Unit  \        单元测试（转换器）
     /Tests   \
    /──────────\      基础设施测试
   /____________\
```

### 测试覆盖

1. **基础设施**（basic.test.ts）
   - 服务器启动
   - 端点可达

2. **OpenAI**（openai/*.test.ts）
   - 多轮对话
   - 系统提示
   - 工具调用
   - 流式响应

3. **Claude**（claude/*.test.ts）
   - 工具定义
   - SSE 事件序列
   - System prompt

4. **集成**（integration/*.test.ts）
   - 真实 OpenAI SDK
   - 真实 Anthropic SDK

---

## 【性能考虑】

### 内存管理

```typescript
// ✅ 流式处理 - 不缓冲完整响应
for await (const chunk of streamGen) {
  // 立即写入 response
  res.write(...);
}

// ❌ 避免
const allChunks = await collectAll(streamGen);
res.write(allChunks);  // OOM risk
```

### 连接管理

```typescript
// 使用 GeminiClient 的连接池
// 避免每次请求创建新 client
const client = config.getGeminiClient();  // 单例
```

---

## 【监控和调试】

### 日志策略

```typescript
console.log('[OpenAI Proxy] Request:', {
  endpoint: '/v1/chat/completions',
  model: body.model,
  messageCount: body.messages.length,
  hasTools: Boolean(body.tools)
});

console.log('[OpenAI Proxy] Response:', {
  finishReason: result.choices[0].finish_reason,
  hasToolCalls: Boolean(result.choices[0].message.tool_calls),
  usage: result.usage
});
```

### 错误追踪

```typescript
try {
  // ...
} catch (error) {
  console.error('[OpenAI Proxy] Error:', {
    message: (error as Error).message,
    stack: (error as Error).stack,
    request: { model, messages: body.messages.length }
  });

  res.status(500).json({
    error: {
      message: (error as Error).message,
      type: 'server_error'
    }
  });
}
```

---

## 【部署和配置】

### 环境变量

```bash
# Gemini 认证
GEMINI_API_KEY=your_api_key
# 或
USE_CCPA=1  # Login with Google

# 服务端口
CODER_AGENT_PORT=41242

# 模型选择
DEFAULT_MODEL=gemini-2.5-flash
```

### 启动命令

```bash
# 开发模式
npm run dev:a2a-server

# 生产模式
npm run build && npm run start:a2a-server
```

---

## 【后续优化】

### P1（重要但非紧急）

1. **请求缓存** - 相同请求复用结果
2. **速率限制** - 防止滥用
3. **请求验证** - JSON schema 验证

### P2（可选）

1. **WebSocket 支持** - 双向通信
2. **批量请求** - 提高吞吐量
3. **A/B 测试** - 多模型对比

---

## 【FAQ】

**Q: 为什么不直接使用 Gemini API 而要包装？**

A: 兼容现有生态。很多工具（LangChain、claude-code-router）期待 OpenAI/Claude 接口。

**Q: 性能开销有多大？**

A: 仅数据转换（<1ms），流式传输零拷贝。

**Q: 支持哪些 Gemini 模型？**

A: 所有支持 functionDeclarations 的模型：
- gemini-2.5-flash
- gemini-2.5-pro
- gemini-2.0-flash

**Q: 如何调试转换问题？**

A: 启用详细日志：
```bash
DEBUG=1 npm run start:a2a-server
```

---

## 【总结】

**核心思想**: 薄适配层 + 复用 GeminiClient

**关键修复**:
1. ✅ 保留对话历史
2. ✅ 工具协议打通
3. ✅ 使用原生特性（systemInstruction）
4. ✅ 正确的流式状态机

**验证标准**:
- 测试全部通过
- 真实 SDK 可用
- 打印输出符合预期
