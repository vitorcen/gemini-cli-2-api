# Gemini Proxy 数据格式转换与事件规范（更新版）

本文档基于 **Codex 客户端** 与 **Google Gemini API**，记录 `a2a-server` 在两者之间的数据/事件转换规范，并补充了流式事件顺序、usage 字段映射、工具安全约束与写文件最佳实践等关键行为，便于测试与排障。

---

## 目录（快速导航）

1. [核心差异](#1-核心差异)
2. [第一部分：Codex 客户端发送格式](#2-第一部分codex-客户端发送格式)
3. [第二部分：a2a → Gemini API 转换](#3-第二部分a2a--gemini-api-转换)
4. [第三部分：Gemini API → a2a 转换](#4-第三部分gemini-api--a2a-转换)
5. [第四部分：a2a → Codex 客户端转换](#5-第四部分a2a--codex-客户端转换)
6. [完整示例：read_file 工具四阶段转换](#6-完整示例read_file-工具四阶段转换)
7. [SSE 事件规范与完成信号](#7-sse-事件规范与完成信号)
8. [usage 字段映射（OpenAI 风格）](#8-usage-字段映射openai-风格)
9. [写文件最佳实践：优先使用 apply_patch](#9-写文件最佳实践优先使用-apply_patch)
10. [Shell 安全闸（pipeline/重定向）](#10-shell-安全闸piperedirect)
11. [循环检测（可选护栏）](#11-循环检测可选护栏)
12. [测试对齐清单](#12-测试对齐清单)
13. [故障排查指引](#13-故障排查指引)

---

## 1. 核心差异

**🔴 最关键的格式差异：**

| 方向 | Codex/OpenAI 格式 | Gemini API 格式 |
|------|------------------|-----------------|
| 工具调用参数 | `arguments`: JSON **字符串** | `args`: JSON **对象** |
| 工具响应结果 | `output`: 纯字符串 | `response`: JSON 对象 |

**示例对比：**

```json
// Codex 格式
{
  "type": "function_call",
  "name": "read_file",
  "arguments": "{\"file_path\":\"/tmp/test.txt\"}",  // ← 字符串
  "call_id": "call_abc123"
}

// Gemini 格式
{
  "functionCall": {
    "name": "read_file",
    "args": {                                         // ← 对象
      "file_path": "/tmp/test.txt"
    }
  }
}
```

---

## 2. 第一部分：Codex 客户端发送格式

### 2.1 主对话格式

Codex 客户端通过 OpenAI Responses API 格式发送请求：

```json
POST /v1/responses

{
  "model": "gemini-2.0-flash-exp",
  "stream": true,
  "input": [
    // 输入项数组，见下文
  ],
  "tools": [
    // 工具定义数组，见下文
  ]
}
```

### 2.2 输入项类型 (`input` 数组)

#### 2.2.1 用户消息

```json
{
  "type": "message",
  "role": "user",
  "content": [
    {
      "type": "input_text",
      "text": "请读取 /tmp/test.txt 文件"
    }
  ]
}
```

#### 2.2.2 工具调用（模型发出）

```json
{
  "type": "function_call",
  "name": "read_file",
  "arguments": "{\"file_path\":\"/tmp/test.txt\"}",  // ← JSON 字符串
  "call_id": "call_abc123"
}
```

**字段说明：**
- `type` (string): 固定值 `"function_call"`
- `name` (string): 工具名称
- `arguments` (string): **JSON 字符串**（不是对象！）
- `call_id` (string): 调用 ID，用于关联响应

#### 2.2.3 工具响应（工具执行结果）

```json
{
  "type": "function_call_output",
  "call_id": "call_abc123",
  "output": "文件内容：Hello World"  // ← 纯字符串
}
```

**字段说明：**
- `type` (string): 固定值 `"function_call_output"`
- `call_id` (string): 对应的工具调用 ID
- `output` (string): **纯字符串**（即使是结构化数据也要序列化）

---

### 2.3 工具定义格式 (`tools` 数组)

Codex 客户端发送的工具定义遵循 OpenAI Function Calling 格式：

```json
{
  "type": "function",
  "function": {
    "name": "tool_name",
    "description": "工具描述",
    "parameters": {
      "type": "object",
      "properties": {
        "param1": {
          "type": "string",
          "description": "参数1描述"
        }
      },
      "required": ["param1"]
    }
  }
}
```

---

### 2.4 所有 Codex 工具完整定义

以下工具定义来源：`codex-rs/core/src/tools/spec.rs`

#### 2.4.1 shell / local_shell

执行 shell 命令。

```json
{
  "type": "function",
  "function": {
    "name": "shell",
    "description": "Runs a shell command and returns its output.",
    "parameters": {
      "type": "object",
      "properties": {
        "command": {
          "type": "array",
          "items": { "type": "string" },
          "description": "The command to execute"
        },
        "workdir": {
          "type": "string",
          "description": "The working directory to execute the command in"
        },
        "timeout_ms": {
          "type": "number",
          "description": "The timeout for the command in milliseconds"
        },
        "with_escalated_permissions": {
          "type": "boolean",
          "description": "Whether to request escalated permissions. Set to true if command needs to be run without sandbox restrictions"
        },
        "justification": {
          "type": "string",
          "description": "Only set if with_escalated_permissions is true. 1-sentence explanation of why we want to run this command."
        }
      },
      "required": ["command"]
    }
  }
}
```

**调用示例：**
```json
{
  "type": "function_call",
  "name": "shell",
  "arguments": "{\"command\":[\"ls\",\"-la\"],\"workdir\":\"/tmp\"}",
  "call_id": "call_001"
}
```

#### 2.4.2 read_file

读取文件内容，支持行范围和缩进模式。

```json
{
  "type": "function",
  "function": {
    "name": "read_file",
    "description": "Reads a local file with 1-indexed line numbers, supporting slice and indentation-aware block modes.",
    "parameters": {
      "type": "object",
      "properties": {
        "file_path": {
          "type": "string",
          "description": "Absolute path to the file"
        },
        "offset": {
          "type": "number",
          "description": "The line number to start reading from. Must be 1 or greater."
        },
        "limit": {
          "type": "number",
          "description": "The maximum number of lines to return."
        },
        "mode": {
          "type": "string",
          "description": "Optional mode selector: \"slice\" for simple ranges (default) or \"indentation\" to expand around an anchor line."
        },
        "indentation": {
          "type": "object",
          "properties": {
            "anchor_line": {
              "type": "number",
              "description": "Anchor line to center the indentation lookup on (defaults to offset)."
            },
            "max_levels": {
              "type": "number",
              "description": "How many parent indentation levels (smaller indents) to include."
            },
            "include_siblings": {
              "type": "boolean",
              "description": "When true, include additional blocks that share the anchor indentation."
            },
            "include_header": {
              "type": "boolean",
              "description": "Include doc comments or attributes directly above the selected block."
            },
            "max_lines": {
              "type": "number",
              "description": "Hard cap on the number of lines returned when using indentation mode."
            }
          }
        }
      },
      "required": ["file_path"]
    }
  }
}
```

**调用示例：**
```json
{
  "type": "function_call",
  "name": "read_file",
  "arguments": "{\"file_path\":\"/tmp/test.txt\",\"offset\":1,\"limit\":100}",
  "call_id": "call_002"
}
```

#### 2.4.3 grep_files

搜索文件内容匹配的文件路径。

```json
{
  "type": "function",
  "function": {
    "name": "grep_files",
    "description": "Finds files whose contents match the pattern and lists them by modification time.",
    "parameters": {
      "type": "object",
      "properties": {
        "pattern": {
          "type": "string",
          "description": "Regular expression pattern to search for."
        },
        "include": {
          "type": "string",
          "description": "Optional glob that limits which files are searched (e.g. \"*.rs\" or \"*.{ts,tsx}\")."
        },
        "path": {
          "type": "string",
          "description": "Directory or file path to search. Defaults to the session's working directory."
        },
        "limit": {
          "type": "number",
          "description": "Maximum number of file paths to return (defaults to 100)."
        }
      },
      "required": ["pattern"]
    }
  }
}
```

**调用示例：**
```json
{
  "type": "function_call",
  "name": "grep_files",
  "arguments": "{\"pattern\":\"TODO\",\"include\":\"*.ts\",\"path\":\"/project\"}",
  "call_id": "call_003"
}
```

#### 2.4.4 list_dir

列出目录内容。

```json
{
  "type": "function",
  "function": {
    "name": "list_dir",
    "description": "Lists entries in a local directory with 1-indexed entry numbers and simple type labels.",
    "parameters": {
      "type": "object",
      "properties": {
        "dir_path": {
          "type": "string",
          "description": "Absolute path to the directory to list."
        },
        "offset": {
          "type": "number",
          "description": "The entry number to start listing from. Must be 1 or greater."
        },
        "limit": {
          "type": "number",
          "description": "The maximum number of entries to return."
        },
        "depth": {
          "type": "number",
          "description": "The maximum directory depth to traverse. Must be 1 or greater."
        }
      },
      "required": ["dir_path"]
    }
  }
}
```

**调用示例：**
```json
{
  "type": "function_call",
  "name": "list_dir",
  "arguments": "{\"dir_path\":\"/tmp\",\"limit\":50}",
  "call_id": "call_004"
}
```

#### 2.4.5 apply_patch

应用代码补丁。

```json
{
  "type": "custom",
  "name": "apply_patch",
  "description": "Use the `apply_patch` tool to edit files...",
  "parameters": {
    "type": "object",
    "properties": {
      "input": {
        "type": "string",
        "description": "Patch body between *** Begin Patch and *** End Patch."
      }
    },
    "required": ["input"]
  }
}
```

**调用示例：**
```json
{
  "type": "custom_tool_call",
  "name": "apply_patch",
  "input": "*** Begin Patch\\n*** Add File: /tmp/new.txt\\n+Hello\\n*** End Patch",
  "call_id": "call_005"
}
```

#### 2.4.6 view_image

附加本地图片到对话上下文。

```json
{
  "type": "function",
  "function": {
    "name": "view_image",
    "description": "Attach a local image (by filesystem path) to the conversation context for this turn.",
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Local filesystem path to an image file"
        }
      },
      "required": ["path"]
    }
  }
}
```

**调用示例：**
```json
{
  "type": "function_call",
  "name": "view_image",
  "arguments": "{\"path\":\"/tmp/screenshot.png\"}",
  "call_id": "call_006"
}
```

#### 2.4.7 update_plan

更新任务计划状态。

```json
{
  "type": "function",
  "function": {
    "name": "update_plan",
    "description": "Update the assistant plan/status for this task.",
    "parameters": {
      "type": "object",
      "properties": {
        "explanation": {
          "type": "string"
        },
        "plan": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "step": { "type": "string" },
              "status": {
                "type": "string",
                "enum": ["pending", "in_progress", "completed"]
              }
            },
            "required": ["step", "status"]
          }
        }
      }
    }
  }
}
```

**调用示例：**
```json
{
  "type": "function_call",
  "name": "update_plan",
  "arguments": "{\"plan\":[{\"step\":\"Read file\",\"status\":\"completed\"}]}",
  "call_id": "call_007"
}
```

---

## 3. 第二部分：a2a → Gemini API 转换

### 3.1 请求格式转换

`a2a-server` 将 Codex 格式转换为 Gemini API 格式：

```typescript
// messageConverter.ts: convertOpenAIMessagesToGemini()
```

**转换规则：**

| Codex 字段 | Gemini 字段 | 转换操作 |
|-----------|------------|----------|
| `type: "function_call"` | `parts[].functionCall` | 结构重组 |
| `arguments` (string) | `args` (object) | **JSON.parse()** |
| `type: "function_call_output"` | `parts[].functionResponse` | 结构重组 |
| `output` (string) | `response` (object) | 包装为对象 |

### 3.2 工具调用转换示例

**输入（Codex 格式）：**
```json
{
  "type": "function_call",
  "name": "read_file",
  "arguments": "{\"file_path\":\"/tmp/test.txt\",\"limit\":100}",
  "call_id": "call_abc"
}
```

**输出（Gemini 格式）：**
```json
{
  "role": "model",
  "parts": [
    {
      "functionCall": {
        "name": "read_file",
        "args": {
          "file_path": "/tmp/test.txt",
          "limit": 100
        }
      }
    }
  ]
}
```

**关键代码：**
```typescript
// messageConverter.ts: handleAssistantMessage()
for (const toolCall of msg.tool_calls) {
  this.toolCallMap.set(toolCall.id, toolCall.function.name);
  parts.push({
    functionCall: {
      name: toolCall.function.name,
      args: JSON.parse(toolCall.function.arguments),  // ← 字符串转对象
    },
  });
}
```

### 3.3 工具响应转换示例

**输入（Codex 格式）：**
```json
{
  "type": "function_call_output",
  "call_id": "call_abc",
  "output": "File content: Hello World"
}
```

**输出（Gemini 格式）：**
```json
{
  "role": "user",
  "parts": [
    {
      "functionResponse": {
        "name": "read_file",
        "response": {
          "status": "success",
          "content": "File content: Hello World"
        }
      }
    }
  ]
}
```

**关键代码：**
```typescript
// messageConverter.ts: structureToolResponse()
if (name === 'read_file') {
  return {
    status: 'success',
    content: content,
    bytes: content.length,
  };
}
```

### 3.4 工具定义转换

**输入（Codex 格式）：**
```json
{
  "type": "function",
  "function": {
    "name": "read_file",
    "description": "Reads a local file...",
    "parameters": { /* schema */ }
  }
}
```

**输出（Gemini 格式）：**
```json
{
  "functionDeclarations": [
    {
      "name": "read_file",
      "description": "Reads a local file...",
      "parameters": { /* schema */ }
    }
  ]
}
```

**关键代码：**
```typescript
// messageConverter.ts: convertOpenAIToolsToGemini()
return [{ functionDeclarations }];
```

---

## 4. 第三部分：Gemini API → a2a 转换

### 4.1 Gemini 返回格式

Gemini API 通过流式响应返回工具调用：

```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "functionCall": {
              "name": "read_file",
              "args": {
                "file_path": "/tmp/test.txt"
              }
            }
          }
        ],
        "role": "model"
      },
      "finishReason": "STOP"
    }
  ]
}
```

**关键字段：**
- `candidates[0].content.parts[0].functionCall` - 工具调用
- `functionCall.name` (string) - 工具名称
- `functionCall.args` (object) - **JSON 对象**（不是字符串！）

### 4.2 解析 Gemini 响应

**关键代码：**
```typescript
// responsesRoute.ts: handleStreamingResponse()
if (part?.functionCall) {
  const name = part.functionCall.name;
  const rawArgs = part.functionCall.args || {};

  // 规范化参数（可能需要处理 shell 命令等特殊情况）
  const normalizedArgs = normalizeFunctionArgs(name, rawArgs);

  // 转换为 JSON 字符串（准备发送给 Codex）
  const argsText = JSON.stringify(normalizedArgs);  // ← 对象转字符串

  // ...
}
```

---

## 5. 第四部分：a2a → Codex 客户端转换

### 5.1 SSE 事件格式

`a2a-server` 通过 Server-Sent Events (SSE) 向 Codex 客户端发送响应。

**关键事件序列：**

1. **response.created** - 响应创建
2. **response.output_item.added** - 添加工具调用项
3. **response.function_call_arguments.delta** - 发送工具参数
4. **response.function_call_arguments.done** - 参数发送完毕
5. **response.output_item.done** - 工具调用项完成
6. **response.done** - 整个响应完成

### 5.2 工具调用事件示例

**从 Gemini 解析：**
```json
{
  "functionCall": {
    "name": "read_file",
    "args": {
      "file_path": "/tmp/test.txt",
      "limit": 100
    }
  }
}
```

**发送给 Codex（SSE 事件）：**

```
event: response.output_item.added
data: {"type":"response.output_item.added","item":{"type":"function_call","id":"call_001","call_id":"call_001","name":"read_file"}}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","call_id":"call_001","delta":"{\"file_path\":\"/tmp/test.txt\",\"limit\":100}"}

event: response.function_call_arguments.done
data: {"type":"response.function_call_arguments.done","call_id":"call_001"}

event: response.output_item.done
data: {"type":"response.output_item.done","item":{"type":"function_call","id":"call_001","call_id":"call_001","name":"read_file","arguments":"{\"file_path\":\"/tmp/test.txt\",\"limit\":100}","status":"requires_action"}}
```

**关键转换：**
```typescript
// responsesRoute.ts
const argsText = JSON.stringify(normalizedArgsPreview);  // ← args 对象转字符串

writeEvent({
  type: 'response.function_call_arguments.delta',
  call_id: callId,
  delta: argsText  // ← 发送 JSON 字符串
});
```

---

## 6. 完整示例：read_file 工具四阶段转换

### 阶段 1：Codex 客户端 → a2a-server

**Codex 发送（POST /v1/responses）：**
```json
{
  "model": "gemini-2.0-flash-exp",
  "stream": true,
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "请读取 /tmp/config.json 文件的前50行"
        }
      ]
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "Reads a local file...",
        "parameters": {
          "type": "object",
          "properties": {
            "file_path": { "type": "string" },
            "offset": { "type": "number" },
            "limit": { "type": "number" }
          },
          "required": ["file_path"]
        }
      }
    }
  ]
}
```

### 阶段 2：a2a-server → Gemini API

**a2a 转换并发送给 Gemini：**
```json
{
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "请读取 /tmp/config.json 文件的前50行"
        }
      ]
    }
  ],
  "tools": [
    {
      "functionDeclarations": [
        {
          "name": "read_file",
          "description": "Reads a local file...",
          "parameters": {
            "type": "object",
            "properties": {
              "file_path": { "type": "string" },
              "offset": { "type": "number" },
              "limit": { "type": "number" }
            },
            "required": ["file_path"]
          }
        }
      ]
    }
  ]
}
```

**Gemini 返回工具调用：**
```json
{
  "candidates": [
    {
      "content": {
        "parts": [
          {
            "functionCall": {
              "name": "read_file",
              "args": {
                "file_path": "/tmp/config.json",
                "offset": 1,
                "limit": 50
              }
            }
          }
        ],
        "role": "model"
      }
    }
  ]
}
```

### 阶段 3：Gemini API → a2a-server

**a2a 解析 Gemini 响应：**
```typescript
const part = chunk.candidates[0].content.parts[0];
if (part.functionCall) {
  const name = part.functionCall.name;  // "read_file"
  const args = part.functionCall.args;  // { file_path: "/tmp/config.json", offset: 1, limit: 50 }

  // 转换为 JSON 字符串
  const argsText = JSON.stringify(args);
  // 结果: "{\"file_path\":\"/tmp/config.json\",\"offset\":1,\"limit\":50}"
}
```

### 阶段 4：a2a-server → Codex 客户端

**a2a 发送 SSE 事件给 Codex：**

```
event: response.output_item.added
data: {"type":"response.output_item.added","item":{"type":"function_call","id":"call_xyz789","call_id":"call_xyz789","name":"read_file"}}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","call_id":"call_xyz789","delta":"{\"file_path\":\"/tmp/config.json\",\"offset\":1,\"limit\":50}"}

event: response.function_call_arguments.done
data: {"type":"response.function_call_arguments.done","call_id":"call_xyz789"}

event: response.output_item.done
data: {"type":"response.output_item.done","item":{"type":"function_call","id":"call_xyz789","call_id":"call_xyz789","name":"read_file","arguments":"{\"file_path\":\"/tmp/config.json\",\"offset\":1,\"limit\":50}","status":"requires_action"}}

event: response.done
data: {"type":"response.done","response":{"id":"resp_001","status":"requires_action","output":[{"type":"function_call","call_id":"call_xyz789","name":"read_file","arguments":"{\"file_path\":\"/tmp/config.json\",\"offset\":1,\"limit\":50}"}]}}
```

**Codex 执行工具并返回结果：**
```json
{
  "input": [
    {
      "type": "function_call_output",
      "call_id": "call_xyz789",
      "output": "1→{\n2→  \"api_key\": \"test123\",\n3→  \"endpoint\": \"https://api.example.com\"\n4→}\n"
    }
  ]
}
```

---

## 总结

### 关键转换点

| 转换方向 | 字段名 | 源类型 | 目标类型 | 转换方法 |
|---------|-------|--------|---------|----------|
| Codex → Gemini | `arguments` → `args` | string | object | `JSON.parse()` |
| Gemini → Codex | `args` → `arguments` | object | string | `JSON.stringify()` |
| Codex → Gemini | `output` → `response` | string | object | 包装为 `{result: ...}` |
| Gemini → Codex | `response` → `output` | object | string | 提取并可能序列化 |

### 调试检查清单

当遇到工具调用问题时，检查以下几点：

1. ✅ Codex 的 `arguments` 是否是**有效的 JSON 字符串**？
2. ✅ Gemini 的 `args` 是否被正确**解析为对象**？
3. ✅ 参数名称是否匹配工具定义？
4. ✅ 必填参数是否都提供了？
5. ✅ 数据类型是否符合 schema（string/number/boolean/array/object）？
6. ✅ SSE 事件中的 `arguments` 是否又被正确**转换回字符串**？

---

**文档来源：**
- Codex 工具定义：`codex-rs/core/src/tools/spec.rs`
- Codex 数据模型：`codex-rs/protocol/src/models.rs`
- Gemini API 文档：https://ai.google.dev/gemini-api/docs/function-calling
- a2a 转换逻辑：`packages/a2a-server/src/http/adapters/messageConverter.ts`
- a2a 路由处理：`packages/a2a-server/src/http/openai/responsesRoute.ts`

---

## 7. SSE 事件规范与完成信号

所有流式响应必须以 `response.completed` 事件结束；不同路径的最小事件序列如下：

- 文本路径（无工具调用）
  - `response.created`
  - 若有文本分片：`response.output_text.delta`（可多次）
  - `response.output_text.done`（包含 `output_text` 聚合文本）
  - `response.done`（`status: 'completed'`，并在 `response.output[0]` 回填完整文本消息）
  - `response.completed`（同上）

- 工具路径（有 function_call）
  - `response.created`
  - `response.output_item.added`（`type:function_call`，含 `name/call_id`）
  - `response.function_call_arguments.delta`（一次性 JSON 字符串）
  - `response.function_call_arguments.done`
  - `response.output_item.done`（`status:'requires_action'`，含 `arguments/name`）
  - `response.done`（`status:'requires_action'`，在 `response.output[0]` 汇总 `type:function_call`）
  - `response.completed`（`status:'requires_action'`）

- 异常路径（上游流式报错/中断）
  - `response.created`
  - `response.failed`（`status:'failed'`，含 error.message）
  - `response.done`（`status:'failed'`）
  - `response.completed`（`status:'failed'`）

备注：SSE 连接在 `response.completed` 之后关闭，避免客户端“等待未完成信号”导致的重试或挂起。

---

## 8. usage 字段映射（OpenAI 风格）

为兼容 OpenAI Responses API，`usage` 字段采用如下映射：

- `input_tokens` ← `usageMetadata.promptTokenCount`
- `output_tokens` ← `usageMetadata.candidatesTokenCount`
- `total_tokens` ← `usageMetadata.totalTokenCount`（若无，则按 input+output 相加）

该 `usage` 同时出现在 `response.done` 与 `response.completed` 的 `response.usage` 中，便于客户端在终止事件解析统计。

---

## 9. 写文件最佳实践：优先使用 apply_patch

在沙箱/受限环境中，使用 shell 的 heredoc/重定向写入大文本容易触发解析歧义或安全策略（例如被当作“超长文件名”）。

推荐策略：

- 写/改文件一律使用 `apply_patch` 工具；
- `apply_patch` 的补丁分隔符（如 `*** Begin Patch`/`*** End Patch`、`*** Add/Update/Delete File:`）应按原样提供；
- 代理会对分隔符行前导的 `+` 做容错清理，但不会改动正文内容行（以保留统一 diff 语义）。

---

## 10. Shell 安全闸（pipe/redirect）

为降低误判与安全风险，代理对 `local_shell` 的命令做最小化约束：

- 仅当 `command` 为数组形式 `['bash','-lc', '<script>']` 时，才允许 `<script>` 中包含管道/控制符（如 `|`/`||`/`;`/`&`/`&&`/`>`/`>>`/`<`/`<<`）。
- 若检测到包含上述符号但不是 `['bash','-lc', ...]` 形式，则忽略该次 function_call（不向下游发送对应的 function_call 事件）。

说明：此为策略性护栏，建议在模型提示中明确“执行复杂脚本请使用 `bash -lc`”。

---

## 11. 循环检测（可选护栏）

在 `/v1/responses` 入口，代理可对近期 `Responses` 历史进行轻量判定：

- 连续 2 次相同参数的工具调用均返回错误（包含 `error|Error|failed` 关键词），判定为“失败循环”。
- 连续 3 次相同参数的工具调用均成功，判定为“重复循环”。

命中时直接以文本提示短路：

```
[System] Detected an infinite loop ...
```

代理会立刻发送：`response.created` → `response.output_text.delta` → `response.output_text.done` → `response.done(status:completed)` → `response.completed`，避免继续消耗上游配额。该逻辑建议做成可配置开关，以便在不同环境下选择开启或关闭。

---

## 12. 测试对齐清单

- 非流式 Responses 形状：`id/object/model/output/usage`。
- 文本流：delta/done 完整，最终 done/completed 携带完整文本与 usage。
- 工具流：added → args.delta → args.done → item.done(requires_action) → done(requires_action) → completed。
- 错误流：failed → done(failed) → completed(failed)。
- 大参数：函数参数以单条 JSON 字符串 delta 下发。
- Shell 安全：非 `bash -lc` 的管道/重定向被忽略；`bash -lc` 形式通过。
- 写文件：apply_patch 分隔符容错（仅分隔行去 `+`），正文不改。
- 循环检测：若开启，短路文本提示必须出现在 delta/done/completed 中。

---

## 13. 故障排查指引

- 看不到 `response.completed` → 检查流式结束路径是否按本规范发送最终事件；客户端常因缺失 completed 出现重试或挂起。
- 客户端报“missing input_tokens” → 确认 usage 映射是否为 `input_tokens/output_tokens/total_tokens`。
- 写文件通过 shell 失败/沙箱报错 → 改用 `apply_patch`，避免 heredoc/重定向；必要时检查安全闸是否拦截了不安全命令。
- 工具参数不生效 → 确认 `args`（对象）与 `arguments`（字符串）在双向转换中正确 `JSON.parse/JSON.stringify`。
