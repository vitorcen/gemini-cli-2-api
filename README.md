# Gemini CLI - A2A API Proxy Server

[中文](README-zh.md)

An API proxy server based on `@google/gemini-cli@0.8.0-preview.1` that forwards Claude/OpenAI API requests to Google Gemini.

## Features

🔄 **Multi-Protocol Support**
- Claude Messages API (`/v1/messages`)
- OpenAI Chat Completions API (`/v1/chat/completions`)
- Gemini Native API (`/v1beta/models/*:generateContent`)

🚀 **Seamless Integration**
- Compatible with Claude CLI
- Compatible with OpenAI SDK
- Streaming response support
- Function calling support

🎯 **Real Integration Testing**
- End-to-end integration tests
- Real API call validation
- Token usage statistics

## Installation

### Global Installation (Recommended)

Install the package globally via npm:

```bash
npm install -g @vitorcen/gemini-cli-2-api
```

## Usage

### Start Server

**Foreground Mode** (view logs in terminal, Ctrl+C to stop):
```bash
gemini-cli-2-api
```

**Background Service Mode** (runs in background):
```bash
gemini-cli-2-api start
```

### Manage Server

```bash
gemini-cli-2-api status   # Check server status
gemini-cli-2-api stop     # Stop background service
gemini-cli-2-api -h       # Show help
```

The server runs on port **41242** with `USE_CCPA=1` enabled.

**Startup Process:**
1. Kill existing process on port 41242 (if any)
2. Wait 3 seconds for port cleanup
3. Login to CCPA (~30 seconds)
4. Server ready

**Total startup time:** ~30-35 seconds

## Quick Start (Development)

### 1. Install Dependencies

```bash
cd /mnt/c/Work/mcp/gemini-cli
npm install
npm run build --workspaces
```

### 2. Start Server

```bash
cd packages/a2a-server
USE_CCPA=1 CODER_AGENT_PORT=41242 npm start
```

Wait approximately **30 seconds** for the server to start.

### 3. Use Claude CLI with Gemini

**Switch to Gemini**:
```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:41242 claude --model gemini-2.5-pro -c
```

**Restore Claude**:
```bash
unset ANTHROPIC_BASE_URL && claude -c
```

### 4. Use Codex with Gemini (Experimental)

**Switch to Gemini**:
```bash
CODEX_EXPERIMENTAL=1 OPENAI_BASE_URL="http://127.0.0.1:41242/v1" codex -m gemini-flash-latest
```

**Restore Codex**:
```bash
unset OPENAI_BASE_URL && codex
```

## API Endpoints

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

**Streaming Response**:
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

## Function Calling

### Claude Format

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

### OpenAI Format

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

## Working Directory Support

Specify working directory via `X-Working-Directory` header:

```bash
curl http://localhost:41242/v1/messages \
  -H "Content-Type: application/json" \
  -H "X-Working-Directory: /path/to/project" \
  -d '{...}'
```

Claude Code automatically passes this header.

## Running Tests

### Method 1: Auto-start Server

```bash
cd packages/a2a-server
npx vitest run src/http/claudeProxy.test.ts --no-coverage --silent=false
```

### Method 2: Use Existing Server (Recommended)

**Terminal 1 - Start Server**:
```bash
cd packages/a2a-server
USE_CCPA=1 CODER_AGENT_PORT=41242 npm start
```

**Terminal 2 - Run Tests**:
```bash
cd packages/a2a-server
USE_EXISTING_SERVER=1 npx vitest run src/http/*.test.ts --no-coverage --silent=false
```

See detailed test guide: [TEST_GUIDE.md](packages/a2a-server/TEST_GUIDE.md)

## Test Coverage

### claudeProxy.test.ts (6 tests)
- ✅ Non-streaming messages
- ✅ Streaming messages
- ✅ System prompts
- ✅ Streaming tool calls
- ✅ X-Working-Directory header
- ✅ 128KB large payload

### openaiProxy.test.ts (5 tests)
- ✅ Multi-turn conversation with context
- ✅ System message handling
- ✅ Tool calling support
- ✅ Tool result handling
- ✅ Parallel tool calls

### geminiProxy.test.ts (6 tests)
- ✅ Basic generateContent
- ✅ Multi-turn conversation
- ✅ tools/functionDeclarations
- ✅ functionResponse handling
- ✅ systemInstruction support
- ✅ 128KB large payload

## Architecture

### Core Components

```
packages/a2a-server/src/http/
├── claudeProxy.ts       # Claude Messages API → Gemini
├── openaiProxy.ts       # OpenAI Chat API → Gemini
├── geminiProxy.ts       # Gemini Native API (passthrough)
└── adapters/
    └── messageConverter.ts  # Message format conversion
```

### Key Features

**1. System Instruction Handling**
- Claude `system` → Gemini `systemInstruction`
- OpenAI `system` role → Gemini `systemInstruction`
- Passed as config parameter, not injected into contents

**2. Tool Calling Mapping**
- Claude tools → Gemini functionDeclarations
- OpenAI tools → Gemini functionDeclarations
- Auto-cleanup of `$schema` and other meta fields
- Multi-turn tool calling support

**3. Streaming Response**
- True streaming: previousText delta instead of accumulation
- SSE format output
- Tool call delta events

**4. Thought Filtering**
- Auto-filter thought parts to save context
- If all parts filtered, keep original parts (remove thoughtSignature)

**5. Large Payload Support**
- Support 128KB+ input
- `maxOutputTokens: 20000` ensures sufficient output space
- Breakthrough 100KB string limit (fixed in 0.8.0)

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CODER_AGENT_PORT` | Server port | `41242` |
| `USE_CCPA` | Use OAuth authentication | `1` |
| `USE_EXISTING_SERVER` | Reuse running server for tests | - |
| `VERBOSE` | Show detailed logs | - |

### Supported Models

- `gemini-2.5-pro`
- `gemini-2.5-flash`
- `gemini-flash-latest`
- `gemini-pro-latest`

## Example: Claude CLI Workflow

```bash
# 1. Start proxy server
cd packages/a2a-server
USE_CCPA=1 CODER_AGENT_PORT=41242 npm start

# 2. Use Gemini models with Claude CLI
ANTHROPIC_BASE_URL=http://127.0.0.1:41242 claude --model gemini-2.5-pro
ANTHROPIC_BASE_URL=http://127.0.0.1:41242 claude --model gemini-flash-latest /path/to/code "Review this code"

# 3. Tool calling example
ANTHROPIC_BASE_URL=http://127.0.0.1:41242 claude --model gemini-2.5-pro "What's the weather in Tokyo?"

# 4. Restore Claude
claude --model sonnet "Hello Claude"
```

## Example: Codex CLI Workflow (Experimental)

```bash
# 1. Start proxy server
cd packages/a2a-server
USE_CCPA=1 CODER_AGENT_PORT=41242 npm start

# 2. Use Gemini models with Codex CLI
OPENAI_BASE_URL="http://127.0.0.1:41242/v1" codex -m gemini-flash-latest

# 3. Restore Codex
unset OPENAI_BASE_URL && codex resume
```

## Example: OpenAI SDK

```python
import openai

client = openai.OpenAI(
    base_url="http://127.0.0.1:41242/v1",
    api_key="dummy"  # No real key needed
)

response = client.chat.completions.create(
    model="gemini-2.5-pro",
    messages=[
        {"role": "user", "content": "Hello Gemini!"}
    ]
)

print(response.choices[0].message.content)
```

## Token Usage Statistics

Test output shows token usage:

```
📊 Tokens - Input: 4,965, Output: 12
📊 Tokens - Input: 34,106, Output: 23  # 128KB payload
```

## Troubleshooting

### Port Conflict
```bash
lsof -ti:41242 | xargs kill -9
```

### Slow Server Startup
Wait approximately 30 seconds for OAuth authentication to load.

### Test Failures
Run tests with existing server:
```bash
USE_EXISTING_SERVER=1 npx vitest run src/http/*.test.ts
```

## Version Info

- **Base Version**: `@google/gemini-cli@0.8.0-preview.1`
- **Modifications**:
  - ✅ Claude/OpenAI → Gemini protocol conversion
  - ✅ Real integration tests (removed Mocks)
  - ✅ 128KB large payload support
  - ✅ Thought filtering optimization
  - ✅ Working directory passthrough
  - ✅ Token statistics

## License

Apache-2.0

Copyright 2025 Google LLC
