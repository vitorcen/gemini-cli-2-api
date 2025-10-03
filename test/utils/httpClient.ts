import { BASE_URL } from '../setup';

export interface HTTPResponse<T = any> {
  status: number;
  data: T;
  headers: Headers;
}

export async function POST<T = any>(
  endpoint: string,
  body: any
): Promise<HTTPResponse<T>> {
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  return {
    status: response.status,
    data,
    headers: response.headers,
  };
}

export interface SSEEvent {
  type?: string;
  data: any;
  raw: string;
}

export async function streamPOST(
  endpoint: string,
  body: any
): Promise<SSEEvent[]> {
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...body, stream: true }),
  });

  const events: SSEEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let currentEvent: Partial<SSEEvent> = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        // 空行表示事件结束
        if (currentEvent.data !== undefined) {
          events.push(currentEvent as SSEEvent);
          currentEvent = {};
        }
        continue;
      }

      if (trimmed.startsWith('event: ')) {
        currentEvent.type = trimmed.slice(7);
      } else if (trimmed.startsWith('data: ')) {
        const dataStr = trimmed.slice(6);
        currentEvent.raw = dataStr;

        if (dataStr === '[DONE]') {
          // OpenAI 结束标记
          continue;
        }

        try {
          currentEvent.data = JSON.parse(dataStr);
        } catch {
          currentEvent.data = dataStr;
        }
      }
    }
  }

  // 处理最后一个事件
  if (currentEvent.data !== undefined) {
    events.push(currentEvent as SSEEvent);
  }

  return events;
}

export async function GET(endpoint: string): Promise<HTTPResponse> {
  const response = await fetch(`${BASE_URL}${endpoint}`);
  const data = await response.json();

  return {
    status: response.status,
    data,
    headers: response.headers,
  };
}
