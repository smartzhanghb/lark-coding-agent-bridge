import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { AnswerOutbox, answerPackets } from '../../../src/bot/answer-outbox';

const dirs: string[] = [];
const workers: AnswerOutbox[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map(w => w.stop()));
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it('resumes only the unacknowledged answer part after restart, in the original thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'answers-'));
  dirs.push(root);
  const seen: string[] = [];
  const reply = vi.fn(async (req: { path: { message_id: string }; data: { uuid: string; reply_in_thread: boolean } }) => {
    expect(req.path.message_id).toBe('original');
    expect(req.data.reply_in_thread).toBe(true);
    seen.push(req.data.uuid);
    return { data: { message_id: seen.length === 2 ? '' : 'sent' } };
  });
  const channel = { rawClient: { im: { v1: { message: { reply } } } }, addReaction: vi.fn() } as unknown as LarkChannel;
  const worker = new AnswerOutbox(root, channel, () => true);
  const target = { replyTo: 'original', replyInThread: true, authors: ['user'], generation: '0:0',
    scope: 'chat:thread', dm: false, chatId: 'chat', completed: true };
  const parts = answerPackets('已打印'.repeat(1100), []);
  expect(parts).toHaveLength(2);
  await expect(worker.send(target, parts)).rejects.toThrow('receipt');
  const file = join(root, (await readdir(root))[0]!);
  const pending = JSON.parse(await readFile(file, 'utf8'));
  expect(pending.next).toBe(1);
  expect(channel.addReaction).not.toHaveBeenCalled();
  await writeFile(file, JSON.stringify({ ...pending, nextAttempt: 0 }));
  const recovered = new AnswerOutbox(root, channel, () => true);
  workers.push(recovered);
  recovered.start();
  await vi.waitFor(() => expect(channel.addReaction).toHaveBeenCalledOnce());
  expect(seen).toEqual([seen[0], seen[1], seen[1]]);
  expect(seen[0]).not.toEqual(seen[1]);
  expect(await recovered.send(target, parts)).toBe('sent');
  expect(reply).toHaveBeenCalledTimes(3);
  expect(await readFile(file, 'utf8')).not.toContain('已打印');
});
