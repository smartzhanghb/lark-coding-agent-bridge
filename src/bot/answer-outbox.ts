import { createHash } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { LarkChannel, MentionInfo } from '@larksuite/channel';
import { writeFileAtomic } from '../platform/atomic-write';
import { log } from '../core/logger';
import { addCompletionReaction } from './reaction';

export interface AnswerTarget {
  replyTo: string;
  replyInThread?: boolean;
  chatId: string;
  scope: string;
  generation: string;
  dm: boolean;
  authors: string[];
  completed: boolean;
}

type Packet = { msg_type: 'interactive' | 'post'; content: string };
type Pending = AnswerTarget & {
  packets: Packet[];
  next: number;
  nextAttempt: number;
  attempts: number;
  uncertainSince?: number;
  held?: boolean;
  receipt?: string;
};
type Entry = Pending | { deliveredAt: number; receipt: string };

// Profiles can briefly have two channels during an explicit credential refresh.
const busy = new Set<string>();
const digest = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

export function answerPackets(text: string, mentions: MentionInfo[], card?: object): Packet[] {
  if (card && Buffer.byteLength(JSON.stringify(card)) < 28_000) {
    return [{ msg_type: 'interactive', content: JSON.stringify(card) }];
  }
  const packets: Packet[] = [];
  // Bound by UTF-8 bytes and keep surrogate pairs intact. Mention only the first part.
  let part = '';
  let bytes = 0;
  const flush = () => {
    const row: object[] = packets.length ? [] : mentions.map(m => ({ tag: 'at', user_id: m.openId }));
    row.push({ tag: 'md', text: part });
    packets.push({ msg_type: 'post', content: JSON.stringify({ zh_cn: { title: '', content: [row] } }) });
    part = '';
    bytes = 0;
  };
  for (const ch of text) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > 8_000) flush();
    part += ch;
    bytes += n;
  }
  if (part) flush();
  return packets;
}

/** Stores only rendered reply packets. No prompt, agent, or tool executor is available here. */
export class AnswerOutbox {
  private timer?: NodeJS.Timeout;
  private scanning?: Promise<void>;

  constructor(private readonly root: string, private readonly channel: LarkChannel,
    private readonly permitted: (target: AnswerTarget) => boolean) {}

  start(): void {
    this.timer = setInterval(() => this.wake(), 30_000);
    this.timer.unref();
    this.wake();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.scanning;
  }

  wake(): void {
    if (!this.timer || this.scanning) return;
    this.scanning = this.drain().catch(err => log.fail('outbound', err, { step: 'scan' }))
      .finally(() => { this.scanning = undefined; });
  }

  async send(target: AnswerTarget, packets: Packet[]): Promise<string> {
    const key = digest(target.replyTo);
    const file = join(this.root, key + '.json');
    if (busy.has(file)) throw new Error('answer delivery in progress');
    busy.add(file);
    try {
      let entry = await this.read(file);
      if (!entry) {
        entry = { ...target, packets, next: 0, nextAttempt: 0, attempts: 0 };
        await this.write(file, entry);
      }
      if ('deliveredAt' in entry) return entry.receipt;
      return await this.deliver(file, key, entry);
    } finally {
      busy.delete(file);
    }
  }

  private async read(file: string): Promise<Entry | undefined> {
    try { return JSON.parse(await readFile(file, 'utf8')) as Entry; }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  private write(file: string, entry: Entry): Promise<void> {
    return writeFileAtomic(file, JSON.stringify(entry));
  }

  private async drain(): Promise<void> {
    let files: string[];
    try { files = await readdir(this.root); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const name of files) {
      if (!this.timer || !/^[a-f0-9]{32}\.json$/.test(name)) continue;
      const file = join(this.root, name);
      if (busy.has(file)) continue;
      busy.add(file);
      try {
        const entry = await this.read(file);
        if (!entry) continue;
        if ('deliveredAt' in entry) {
          if (Date.now() - entry.deliveredAt > 7 * 86_400_000) await rm(file, { force: true });
          continue;
        }
        if (entry.held || Date.now() < entry.nextAttempt) continue;
        await this.deliver(file, name.slice(0, -5), entry);
        if (entry.completed) await addCompletionReaction(this.channel, entry.replyTo);
      } catch (err) {
        log.fail('outbound', err, { step: 'retry' });
      } finally {
        busy.delete(file);
      }
    }
  }

  private async deliver(file: string, key: string, entry: Pending): Promise<string> {
    while (entry.next < entry.packets.length) {
      if (entry.held || !this.permitted(entry) ||
          (entry.uncertainSince && Date.now() - entry.uncertainSince >= 55 * 60_000)) {
        entry.held = true;
        await this.write(file, entry);
        throw new Error('answer held for receipt or access review');
      }
      const packet = entry.packets[entry.next]!;
      const previousUncertainty = entry.uncertainSince;
      entry.uncertainSince ??= Date.now();
      await this.write(file, entry); // A process crash after the HTTP request is ambiguous.
      try {
        const res = await this.channel.rawClient.im.v1.message.reply({
          path: { message_id: entry.replyTo },
          data: { ...packet, reply_in_thread: entry.replyInThread, uuid: digest(key + '/' + entry.next) },
        });
        const receipt = res.data?.message_id;
        if (!receipt?.trim() || res.code) throw new Error('final reply missing message receipt');
        entry.receipt = receipt;
      } catch (err) {
        // These failures preceded transmission. An older ambiguous attempt still counts.
        if (/before secure TLS|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(String(err))) {
          entry.uncertainSince = previousUncertainty;
        }
        entry.attempts++;
        entry.nextAttempt = Date.now() + Math.min(300_000, 15_000 * 2 ** Math.min(5, entry.attempts));
        await this.write(file, entry);
        log.warn('outbound', 'answer-pending', { msgId: entry.replyTo, attempt: entry.attempts });
        throw err;
      }
      entry.next++;
      entry.attempts = 0;
      delete entry.uncertainSince;
      await this.write(file, entry);
    }
    if (!entry.receipt) throw new Error('answer has no deliverable packets');
    await this.write(file, { deliveredAt: Date.now(), receipt: entry.receipt });
    log.info('outbound', 'answer-delivered', { msgId: entry.replyTo, messageId: entry.receipt });
    return entry.receipt;
  }
}
