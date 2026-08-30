// Tests for the AI streaming + circuit-context layer:
//   1. SSE parser (parseSseStream) — chunk boundaries, CRLF, multi-line data
//   2. OpenAI delta accumulator — content, tool-call fragments, [DONE]
//   3. Netlist summary (buildNetlistSummary) — net naming, floating pins
//   4. Operating point (buildOperatingPointSummary) — labeled node voltages
//   5. Context preamble (buildContextPreamble) — full state visibility
//   6. Public-API Z.ai provider (ZAI_API_KEY mode) — correct endpoint/auth/
//      streaming behavior with a mocked fetch (the deployment-portability path)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseSseStream, OpenAiDeltaAccumulator, accumulateOpenAiStream } from '../src/lib/ai/sse';
import { buildNetlistSummary, buildOperatingPointSummary, buildContextPreamble, formatSI } from '../src/lib/ai/netlist-summary';
import { getProvider, getAvailableProviders, AIProviderConfigError, _resetSandboxConfigCache } from '../src/lib/ai/provider';
import { buildNodeMap } from '../src/lib/circuit/engine';
import { getPlugin } from '../src/lib/circuit/registry';
import '../src/lib/circuit/components'; // register all built-in component plugins

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.ZAI_API_KEY;
  delete process.env.Z_AI_API_KEY;
  delete process.env.ZAI_MODEL;
  delete process.env.ZAI_BASE_URL;
  delete process.env.ZAI_CONFIG;
  _resetSandboxConfigCache();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetSandboxConfigCache();
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sseReader(text: string): ReadableStreamDefaultReader<Uint8Array> {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(text));
      controller.close();
    },
  });
  return stream.getReader();
}

/** Feed the payload one byte at a time — worst-case chunk fragmentation. */
function byteByByteReader(text: string): ReadableStreamDefaultReader<Uint8Array> {
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < bytes.length) {
        controller.enqueue(bytes.slice(i, i + 1));
        i++;
      } else {
        controller.close();
      }
    },
  });
  return stream.getReader();
}

async function collectEvents(text: string) {
  const events = [];
  for await (const ev of parseSseStream(sseReader(text))) events.push(ev);
  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. SSE parser
// ─────────────────────────────────────────────────────────────────────────────

describe('parseSseStream', () => {
  it('parses basic data events', async () => {
    const events = await collectEvents('data: {"a":1}\n\ndata: {"b":2}\n\n');
    expect(events.length).toBe(2);
    expect(events[0].json).toEqual({ a: 1 });
    expect(events[1].json).toEqual({ b: 2 });
  });

  it('handles events split across arbitrary chunk boundaries', async () => {
    const events = [];
    for await (const ev of parseSseStream(byteByByteReader('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'))) {
      events.push(ev);
    }
    expect(events.length).toBe(2);
    expect(events[0].json.choices[0].delta.content).toBe('hi');
    expect(events[1].data).toBe('[DONE]');
  });

  it('handles CRLF line endings', async () => {
    const events = await collectEvents('data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n');
    expect(events.length).toBe(2);
    expect(events[0].json).toEqual({ a: 1 });
    expect(events[1].json).toEqual({ b: 2 });
  });

  it('joins multi-line data fields', async () => {
    const events = await collectEvents('data: line1\ndata: line2\n\n');
    expect(events.length).toBe(1);
    expect(events[0].data).toBe('line1\nline2');
    expect(events[0].json).toBeUndefined(); // not valid JSON — still delivered
  });

  it('ignores comment/keep-alive lines', async () => {
    const events = await collectEvents(': heartbeat\ndata: {"a":1}\n\n');
    expect(events.length).toBe(1);
    expect(events[0].json).toEqual({ a: 1 });
  });

  it('captures the event: field when present', async () => {
    const events = await collectEvents('event: text_delta\ndata: {"text":"x"}\n\n');
    expect(events[0].event).toBe('text_delta');
  });

  it('flushes a trailing unterminated data line', async () => {
    const events = await collectEvents('data: {"a":9}');
    expect(events.length).toBe(1);
    expect(events[0].json).toEqual({ a: 9 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. OpenAI delta accumulator
// ─────────────────────────────────────────────────────────────────────────────

describe('OpenAiDeltaAccumulator', () => {
  it('accumulates content fragments and reports visible text', () => {
    const acc = new OpenAiDeltaAccumulator();
    expect(acc.consume({ choices: [{ delta: { content: 'Hello' } }] })).toBe(true);
    expect(acc.consume({ choices: [{ delta: { content: ' world' } }] })).toBe(true);
    expect(acc.consume({ choices: [{ delta: {}, finish_reason: 'stop' }] })).toBe(false);
    expect(acc.getContent()).toBe('Hello world');
    expect(acc.getFinishReason()).toBe('stop');
    expect(acc.hasToolCalls()).toBe(false);
  });

  it('reassembles tool-call fragments split across chunks', () => {
    const acc = new OpenAiDeltaAccumulator();
    acc.consume({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'sim', arguments: '' } }] } }] });
    acc.consume({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }] });
    acc.consume({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] });
    acc.consume({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    const calls = acc.getToolCalls()!;
    expect(calls.length).toBe(1);
    expect(calls[0].id).toBe('call_1');
    expect(calls[0].function.name).toBe('sim');
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ a: 1 });
    expect(acc.getFinishReason()).toBe('tool_calls');
  });

  it('keeps reasoning_content out of the visible content', () => {
    const acc = new OpenAiDeltaAccumulator();
    acc.consume({ choices: [{ delta: { reasoning_content: 'thinking...' } }] });
    acc.consume({ choices: [{ delta: { content: 'answer' } }] });
    expect(acc.getContent()).toBe('answer');
  });

  it('captures usage from the final chunk', () => {
    const acc = new OpenAiDeltaAccumulator();
    acc.consume({ choices: [{ delta: { content: 'x' } }] });
    acc.consume({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    expect(acc.getUsage()).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('handles multiple parallel tool calls by index', () => {
    const acc = new OpenAiDeltaAccumulator();
    acc.consume({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'a', arguments: '{}' } }] } }] });
    acc.consume({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'b', arguments: '{"x":2}' } }] } }] });
    const calls = acc.getToolCalls()!;
    expect(calls.map(c => c.function.name)).toEqual(['a', 'b']);
  });
});

describe('accumulateOpenAiStream', () => {
  it('streams text deltas and returns the assembled result', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"VCE is "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"0.08V — saturated."}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const deltas: string[] = [];
    const result = await accumulateOpenAiStream(sseReader(sse), t => deltas.push(t));
    expect(deltas).toEqual(['VCE is ', '0.08V — saturated.']);
    expect(result.content).toBe('VCE is 0.08V — saturated.');
    expect(result.finish_reason).toBe('stop');
    expect(result.usage?.total_tokens).toBe(120);
  });

  it('assembles tool calls from a streamed response', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"simulate.run","arguments":"{\\"dur"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ation\\":0.01}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const result = await accumulateOpenAiStream(sseReader(sse));
    expect(result.tool_calls?.[0].function.name).toBe('simulate.run');
    expect(JSON.parse(result.tool_calls![0].function.arguments)).toEqual({ duration: 0.01 });
    expect(result.finish_reason).toBe('tool_calls');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Netlist summary
// ─────────────────────────────────────────────────────────────────────────────

describe('formatSI', () => {
  it('formats engineering values compactly', () => {
    expect(formatSI(1000)).toBe('1k');
    expect(formatSI(4700)).toBe('4.7k');
    expect(formatSI(1e6)).toBe('1M');
    expect(formatSI(1e-6)).toBe('1µ');
    expect(formatSI(0.67)).toBe('0.67');
    expect(formatSI(0)).toBe('0');
    expect(formatSI(220)).toBe('220');
  });
});

describe('buildNetlistSummary', () => {
  // A voltage divider: V1(5V) → R1(1k) → R2(2k) → GND
  const dividerDoc = {
    version: 1,
    components: [
      { id: 'V1', type: 'dcVoltage', position: { x: 2, y: 6 }, rotation: 0, parameters: { voltage: 5 } },
      { id: 'R1', type: 'resistor', position: { x: 10, y: 4 }, rotation: 0, parameters: { resistance: 1000 } },
      { id: 'R2', type: 'resistor', position: { x: 10, y: 12 }, rotation: 0, parameters: { resistance: 2000 } },
      { id: 'GND1', type: 'ground', position: { x: 2, y: 14 }, rotation: 0, parameters: {} },
    ],
    wires: [
      { id: 'w1', from: { componentId: 'V1', terminalId: 'p' }, to: { componentId: 'R1', terminalId: 'a' } },
      { id: 'w2', from: { componentId: 'R1', terminalId: 'b' }, to: { componentId: 'R2', terminalId: 'a' } },
      { id: 'w3', from: { componentId: 'R2', terminalId: 'b' }, to: { componentId: 'GND1', terminalId: 'g' } },
      { id: 'w4', from: { componentId: 'V1', terminalId: 'n' }, to: { componentId: 'GND1', terminalId: 'g' } },
    ],
  };

  it('builds a netlist with ground, rail naming, and values', () => {
    const result = buildNetlistSummary(dividerDoc.components as any, dividerDoc.wires as any);
    expect(result.text).toBeTruthy();
    expect(result.componentCount).toBe(3); // ground is not a netlist line
    expect(result.text).toContain('V1 dcVoltage 5V');
    expect(result.text).toContain('R1 resistor 1kΩ');
    expect(result.text).toContain('GND');
    expect(result.text).toContain('+5V(V1)');
    expect(result.floatingPins).toEqual([]);
  });

  it('flags floating pins', () => {
    // Break the ground connection on R2.b — it now dangles.
    const brokenWires = dividerDoc.wires.filter(w => w.id !== 'w3');
    const result = buildNetlistSummary(dividerDoc.components as any, brokenWires as any);
    expect(result.floatingPins).toContain('R2.b');
    expect(result.text).toContain('FLOATING');
  });

  it('names nets from netLabel components', () => {
    const labeled = {
      ...dividerDoc,
      components: [
        ...dividerDoc.components,
        { id: 'L1', type: 'netLabel', position: { x: 10, y: 8 }, rotation: 0, parameters: { net: 'VOUT' } },
      ],
      wires: [
        ...dividerDoc.wires,
        { id: 'w5', from: { componentId: 'L1', terminalId: 'a' }, to: { componentId: 'R1', terminalId: 'b' } },
      ],
    };
    const result = buildNetlistSummary(labeled.components as any, labeled.wires as any);
    expect(result.text).toContain('VOUT');
  });

  it('returns null for an empty canvas', () => {
    const result = buildNetlistSummary([], []);
    expect(result.text).toBeNull();
    expect(result.componentCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Operating point
// ─────────────────────────────────────────────────────────────────────────────

describe('buildOperatingPointSummary', () => {
  const dividerDoc = {
    version: 1,
    components: [
      { id: 'V1', type: 'dcVoltage', position: { x: 2, y: 6 }, rotation: 0, parameters: { voltage: 5 } },
      { id: 'R1', type: 'resistor', position: { x: 10, y: 4 }, rotation: 0, parameters: { resistance: 1000 } },
      { id: 'R2', type: 'resistor', position: { x: 10, y: 12 }, rotation: 0, parameters: { resistance: 2000 } },
      { id: 'GND1', type: 'ground', position: { x: 2, y: 14 }, rotation: 0, parameters: {} },
    ],
    wires: [
      { id: 'w1', from: { componentId: 'V1', terminalId: 'p' }, to: { componentId: 'R1', terminalId: 'a' } },
      { id: 'w2', from: { componentId: 'R1', terminalId: 'b' }, to: { componentId: 'R2', terminalId: 'a' } },
      { id: 'w3', from: { componentId: 'R2', terminalId: 'b' }, to: { componentId: 'GND1', terminalId: 'g' } },
      { id: 'w4', from: { componentId: 'V1', terminalId: 'n' }, to: { componentId: 'GND1', terminalId: 'g' } },
    ],
  };

  it('renders node voltages labeled with member pins', () => {
    // Compute the real node map to index the voltages correctly.
    const plugins = new Map();
    for (const c of dividerDoc.components) {
      const p = getPlugin(c.type);
      if (p) plugins.set(c.type, p);
    }
    const nm = buildNodeMap(dividerDoc.components, dividerDoc.wires, plugins);
    const railNode = nm.terminalNode.get('V1:p');
    const midNode = nm.terminalNode.get('R1:b');

    const summary = buildOperatingPointSummary(
      dividerDoc.components as any,
      dividerDoc.wires as any,
      { nodeVoltage: { 0: 0, [railNode]: 5, [midNode]: 3.333, length: midNode + 1 } as any, time: 0.0012, dt: 1e-4 },
    );
    expect(summary).toBeTruthy();
    expect(summary).toContain('5.000 V');
    expect(summary).toContain('3.333 V');
    expect(summary).toContain('R1.b');
    expect(summary).toContain('bias'); // teaching hint about BJT/MOSFET/op-amp checks
  });

  it('returns null when there is no live sim data', () => {
    expect(buildOperatingPointSummary(dividerDoc.components as any, dividerDoc.wires as any, null)).toBeNull();
    expect(buildOperatingPointSummary(dividerDoc.components as any, dividerDoc.wires as any, { nodeVoltage: [], time: 0, dt: 0 })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Context preamble
// ─────────────────────────────────────────────────────────────────────────────

describe('buildContextPreamble', () => {
  it('reports an empty canvas', () => {
    const p = buildContextPreamble({ doc: { version: 1, components: [], wires: [] } });
    expect(p).toContain('canvas is empty');
  });

  it('includes netlist, sim state, sim error, and selected component', () => {
    const doc = {
      version: 1,
      components: [
        { id: 'V1', type: 'dcVoltage', position: { x: 2, y: 6 }, rotation: 0, parameters: { voltage: 5 } },
        { id: 'R1', type: 'resistor', position: { x: 10, y: 4 }, rotation: 0, parameters: { resistance: 1000 } },
        { id: 'GND1', type: 'ground', position: { x: 2, y: 14 }, rotation: 0, parameters: {} },
      ],
      wires: [
        { id: 'w1', from: { componentId: 'V1', terminalId: 'p' }, to: { componentId: 'R1', terminalId: 'a' } },
        { id: 'w2', from: { componentId: 'V1', terminalId: 'n' }, to: { componentId: 'GND1', terminalId: 'g' } },
      ],
    };
    const p = buildContextPreamble({
      doc,
      simRunning: true,
      simError: 'Singular matrix: no ground path',
      selectedComponentId: 'R1',
    });
    expect(p).toContain('netlist');
    expect(p).toContain('RUNNING');
    expect(p).toContain('SIMULATION ERROR');
    expect(p).toContain('Singular matrix');
    expect(p).toContain('Selected Component');
    expect(p).toContain('R1.b'); // floating pin surfaced (R1.b unwired)
    expect(p).toContain('floating');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Public-API Z.ai provider (the deployment-portability path)
// ─────────────────────────────────────────────────────────────────────────────

describe('ZaiPublicProvider (ZAI_API_KEY mode)', () => {
  function jsonResponse(body: any, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }

  it('chat() calls the public endpoint with the API key', async () => {
    process.env.ZAI_API_KEY = 'zai-key-test';
    process.env.ZAI_BASE_URL = 'https://api.example.test/v4';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: 'OK', role: 'assistant' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = getProvider('zai');
    expect(provider.model).toBe('glm-4.6');
    const result = await provider.chat([{ role: 'user', content: 'hi' }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.test/v4/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer zai-key-test');
    expect(result.content).toBe('OK');
    expect(result.usage?.total_tokens).toBe(2);
  });

  it('chatStream() parses SSE chunks and reports deltas incrementally', async () => {
    process.env.ZAI_API_KEY = 'zai-key-test';
    const enc = new TextEncoder();
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"The base"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" is floating."}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const streamResponse = {
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(enc.encode(sseBody)); c.close(); },
      }),
    } as unknown as Response;
    const fetchMock = vi.fn().mockResolvedValue(streamResponse);
    vi.stubGlobal('fetch', fetchMock);

    const provider = getProvider('zai');
    const deltas: string[] = [];
    const result = await provider.chatStream([{ role: 'user', content: 'debug this' }], undefined, undefined, t => deltas.push(t));

    expect(deltas).toEqual(['The base', ' is floating.']);
    expect(result.content).toBe('The base is floating.');
    expect(result.finish_reason).toBe('stop');
    // The request body must request streaming.
    const init = fetchMock.mock.calls[0][1];
    expect(JSON.parse(init.body).stream).toBe(true);
  });

  it('surfaces 401 as an actionable key error (not retried)', async () => {
    process.env.ZAI_API_KEY = 'bad-key';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { code: '401', message: 'token expired or incorrect' } }, 401));
    vi.stubGlobal('fetch', fetchMock);

    const provider = getProvider('zai');
    await expect(provider.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/ZAI_API_KEY|credentials/i);
    // 401 is non-retryable — exactly one attempt.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('AIProviderConfigError is exported and identifiable', () => {
    const err = new AIProviderConfigError('not configured');
    expect(err.code).toBe('AI_NOT_CONFIGURED');
    expect(err.name).toBe('AIProviderConfigError');
  });

  it('getAvailableProviders reports api-key mode with a key set', () => {
    process.env.ZAI_API_KEY = 'zai-key-test';
    const zai = getAvailableProviders().find(p => p.name === 'zai')!;
    expect(zai.mode).toBe('api-key');
    expect(zai.available).toBe(true);
  });
});
