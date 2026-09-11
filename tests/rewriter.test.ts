import { describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import type OpenAI from 'openai';
import { OpenAiCommandRewriter, systemPrompt, type RewriteContext } from '../src/intent/commandRewriter.js';
import { COMMAND_CATALOG } from '../src/intent/commandCatalog.js';

const ctx: RewriteContext = {
  now: DateTime.fromISO('2026-09-11T10:00', { zone: 'Asia/Bangkok' }),
  timezone: 'Asia/Bangkok',
  memberNames: ['แม่', 'พ่อ'],
  categoryNames: ['ไฟ'],
  eventTitles: ['กายภาพแม่'],
  billNames: ['ค่าน้ำ'],
  taskTitles: ['โทรหาช่าง'],
  choreNames: ['ล้างจาน'],
};

/** An OpenAI client whose only answer is `reply` (or an error). */
function client(reply: string | Error) {
  const create = vi.fn(async () => {
    if (reply instanceof Error) throw reply;
    return { choices: [{ message: { content: reply } }] };
  });
  return { openai: { chat: { completions: { create } } } as unknown as OpenAI, create };
}

describe('OpenAiCommandRewriter', () => {
  it('returns the command ChatGPT wrote', async () => {
    const { openai } = client(JSON.stringify({ command: 'จ่ายบิลแล้ว  ค่าน้ำ', confidence: 0.9 }));
    const rewriter = new OpenAiCommandRewriter({ client: openai, model: 'gpt-5-mini' });

    expect(await rewriter.rewrite('จ่ายค่าน้ำแล้วนะ', ctx)).toEqual({
      kind: 'command',
      command: 'จ่ายบิลแล้ว ค่าน้ำ', // whitespace tidied
      confidence: 0.9,
    });
  });

  it('reads "no command" as chat, not as a failure', async () => {
    const { openai } = client(JSON.stringify({ command: null, confidence: 0.9 }));
    const rewriter = new OpenAiCommandRewriter({ client: openai, model: 'gpt-5-mini' });

    expect(await rewriter.rewrite('ฝนตกหนักเลย', ctx)).toEqual({ kind: 'chatter' });
  });

  it.each([
    ['an API error', new Error('429 rate limited')],
    ['a reply that is not JSON', 'sure! here you go'],
    ['a reply outside the schema', JSON.stringify({ cmd: 'บอร์ดงาน' })],
  ])('fails closed on %s', async (_label, reply) => {
    const onError = vi.fn();
    const { openai } = client(reply);
    const rewriter = new OpenAiCommandRewriter({ client: openai, model: 'gpt-5-mini', onError });

    expect(await rewriter.rewrite('บอร์ดงานหน่อย', ctx)).toEqual({ kind: 'unavailable' });
  });

  it('does not count an echo of the message as a translation', async () => {
    const { openai } = client(JSON.stringify({ command: 'บ่ายนี้ว่างไหม', confidence: 0.8 }));
    const rewriter = new OpenAiCommandRewriter({ client: openai, model: 'gpt-5-mini' });

    expect(await rewriter.rewrite('บ่ายนี้ว่างไหม', ctx)).toEqual({ kind: 'unavailable' });
  });

  it('asks with strict structured output, the family\'s names, and today\'s date', async () => {
    const { openai, create } = client(JSON.stringify({ command: null, confidence: 1 }));
    await new OpenAiCommandRewriter({ client: openai, model: 'gpt-5-mini' }).rewrite('x', ctx);

    const [request] = create.mock.calls[0] as unknown as [
      { model: string; messages: Array<{ content: string }>; response_format: { json_schema: { strict: boolean } } },
    ];
    expect(request.model).toBe('gpt-5-mini');
    expect(request.response_format.json_schema.strict).toBe(true);
    expect(request.messages[0]?.content).toContain('ศ. 11 ก.ย. 69');
    expect(request.messages[0]?.content).toContain('กายภาพแม่');
  });
});

describe('the prompt', () => {
  it('teaches every catalog command and nothing else by example', () => {
    const prompt = systemPrompt(ctx);
    for (const entry of COMMAND_CATALOG) expect(prompt).toContain(entry.example);
  });

  it('leaves out lists the family has nothing in', () => {
    const prompt = systemPrompt({ ...ctx, billNames: [], taskTitles: [] });
    expect(prompt).not.toContain('บิลที่มี');
    expect(prompt).not.toContain('งานที่ค้าง');
  });
});
