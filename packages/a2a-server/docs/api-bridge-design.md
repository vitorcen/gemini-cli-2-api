# API Bridge Design Document

## Overview

The a2a-server API Bridge provides compatibility layers that allow clients expecting OpenAI, Claude, or Gemini REST APIs to communicate with a unified Gemini backend. This enables seamless integration with various AI tools and frameworks without requiring client-side modifications.

## Architecture

### Core Components

```
┌─────────────┐     ┌──────────────┐     ┌────────────┐
│   Clients   │────▶│  API Bridge  │────▶│   Gemini   │
│             │     │              │     │   Backend  │
│ - OpenAI    │     │ - Transform  │     │            │
│ - Claude    │     │ - Adapt      │     │  Unified   │
│ - Gemini    │     │ - Stream     │     │  Interface │
└─────────────┘     └──────────────┘     └────────────┘
```

### Supported Endpoints

1. **OpenAI Compatible** (`/v1/chat/completions`)
   - Non-streaming and SSE streaming responses
   - Maps OpenAI message format to Gemini Contents
   - Converts temperature, top_p, max_tokens parameters

2. **Claude Compatible** (`/v1/messages`)
   - Full SSE event stream with proper state machine
   - Tool/function calling support with fallback parsing
   - System prompt injection into conversation history

3. **Gemini Native** (`/v1beta/models/*`)
   - Direct passthrough with minimal transformation
   - Both generateContent and streamGenerateContent
   - Native SSE streaming with `alt=sse` parameter

## Design Principles

### 1. "Good Taste" - Eliminating Edge Cases
Instead of handling every API quirk with special cases, we normalize all requests into a unified internal format. The bridge acts as a universal translator, not a collection of patches.

### 2. "Never Break Userspace" - Backward Compatibility
Each compatibility layer strictly adheres to the expected protocol of its target API. Clients should work without any modifications.

### 3. Pragmatism Over Perfection
- Simple transformations over complex state management
- Direct streaming instead of buffering when possible
- Fallback parsing for non-standard tool calling formats

### 4. Isolation and Modularity
Each API compatibility layer is isolated in its own module with a consistent interface:
```typescript
export function register[API]Endpoints(app: express.Router, config: Config)
```

## Implementation Details

### Request Flow

1. **Middleware Configuration**
   ```typescript
   const apiProxyRouter = express.Router();
   apiProxyRouter.use(express.json({ limit: '50mb' }));
   apiProxyRouter.use(express.urlencoded({ limit: '50mb', extended: true }));
   ```
   - Isolated router prevents middleware conflicts
   - Large payload support for conversation histories
   - Applied only to API proxy endpoints

2. **Message Transformation**
   - **OpenAI → Gemini**: Concatenate system/user messages into single prompt
   - **Claude → Gemini**: Maintain conversation history with role mapping
   - **Gemini → Gemini**: Direct passthrough with minimal overhead

3. **Streaming Architecture**

   **OpenAI SSE Format**:
   ```
   data: {"choices":[{"delta":{"content":"Hello"}}]}
   data: {"choices":[{"delta":{"content":" world"}}]}
   data: [DONE]
   ```

   **Claude SSE Format**:
   ```
   event: message_start
   data: {"type":"message_start","message":{...}}

   event: content_block_start
   data: {"type":"content_block_start","content_block":{"type":"text"}}

   event: content_block_delta
   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}
   ```

   **Gemini SSE Format**:
   ```
   data: {"candidates":[{"content":{"parts":[{"text":"Hello world"}]}}]}
   ```

### Tool Calling Support

The Claude compatibility layer implements sophisticated tool calling with multiple fallback strategies:

1. **Primary Path**: Structured function calls from Gemini
   ```typescript
   if (functionCalls && functionCalls.length > 0) {
     // Convert to Claude tool_use events
   }
   ```

2. **Fallback Path**: Parse tool markers in text output
   ```typescript
   if (accumulatedText.includes('[tool_code]')) {
     // Extract and convert to structured events
   }
   ```

3. **Event Generation**: Proper SSE event sequence
   - `content_block_start` with type: 'tool_use'
   - `content_block_delta` with input_json_delta
   - `content_block_stop` to close the block

### State Management

The Claude proxy maintains a minimal state machine for proper event sequencing:

```typescript
let currentBlockType: 'text' | 'tool_use' | null = null;
let currentContentIndex = -1;
```

This ensures:
- Blocks are properly opened and closed
- Text and tool blocks don't overlap
- Events maintain correct index ordering

## Error Handling

### Common Issues and Solutions

1. **413 Payload Too Large**
   - Root cause: Default Express body parser limit (100kb)
   - Solution: Isolated router with 50MB limit
   - Implementation: Applied only to API proxy endpoints

2. **Stream Not Readable**
   - Root cause: Body parser middleware conflict
   - Solution: Careful middleware ordering and isolation
   - Implementation: Separate routers for framework vs API endpoints

3. **Tool Parsing Failures**
   - Root cause: Model returns unstructured tool syntax
   - Solution: Multiple parsing strategies with fallbacks
   - Implementation: Regex patterns for common formats

## Performance Considerations

1. **Streaming Efficiency**
   - Direct pipe from Gemini to client when possible
   - Minimal buffering for transformation
   - Immediate header flushing for SSE

2. **Memory Management**
   - No full response buffering in streaming mode
   - Incremental text processing for deltas
   - Garbage collection friendly event generation

3. **Latency Optimization**
   - Async generators for non-blocking streams
   - Parallel processing where applicable
   - Early response initialization

## Security Considerations

1. **Input Validation**
   - Type checking on all request bodies
   - Parameter sanitization before forwarding
   - Error messages don't leak internal details

2. **Resource Limits**
   - 50MB request body limit
   - Timeout controls on long-running streams
   - AbortController for cancellation support

3. **Authentication Passthrough**
   - Headers preserved for backend authentication
   - No credential storage in bridge layer
   - Secure error handling for auth failures

## Future Improvements

1. **Enhanced Tool Support**
   - Native tool registration system
   - Tool result caching
   - Parallel tool execution

2. **Advanced Streaming**
   - WebSocket support for bidirectional communication
   - Stream multiplexing for multiple clients
   - Partial response caching

3. **Monitoring and Observability**
   - Request/response logging
   - Performance metrics collection
   - Error rate tracking

## Testing Strategy

1. **Unit Tests**
   - Message transformation logic
   - Parameter mapping
   - Event generation

2. **Integration Tests**
   - Full request/response cycles
   - Streaming scenarios
   - Error conditions

3. **Compatibility Tests**
   - Real client libraries (OpenAI SDK, Anthropic SDK)
   - Popular frameworks (LangChain, LlamaIndex)
   - Tool calling scenarios

## Conclusion

The API Bridge design prioritizes simplicity, reliability, and compatibility. By following Linus Torvalds' philosophy of "good taste" - eliminating edge cases through better design rather than adding special cases - we've created a maintainable and extensible system that serves as a universal translator between AI API protocols.

The key insight is that all these APIs fundamentally do the same thing: send prompts and receive responses. The differences are merely syntactic. By recognizing this, we can build a bridge that's both simple and powerful, handling the complexity at the edges while keeping the core logic clean.