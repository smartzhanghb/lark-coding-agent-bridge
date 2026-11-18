import type { LarkChannel, MentionInfo, NormalizedMessage, SendInput, SendOptions, StreamInput } from '@larksuite/channel';

const HEADER_ID = 'bridge_reply_at';
const VALID_USER = /^ou_[A-Za-z0-9_-]+$/;

/** Only current human question authors; never quoted authors or incoming @s. */
export function replyRecipients(messages: readonly NormalizedMessage[], botId?: string): MentionInfo[] {
  const found = new Map<string, MentionInfo>();
  for (const msg of messages) {
    const kind = (msg.raw as { sender?: { sender_type?: string } } | undefined)?.sender?.sender_type;
    if (msg.chatType === 'p2p' || kind === 'app' || kind === 'bot' || msg.senderId === botId || !VALID_USER.test(msg.senderId)) continue;
    found.set(msg.senderId, { key: msg.senderId, openId: msg.senderId, ...(msg.senderName ? { name: msg.senderName } : {}) });
  }
  return [...found.values()];
}

export function mentionCard(card: object, recipients: readonly MentionInfo[]): object {
  if (!recipients.length) return card;
  const md = recipients.map((r) => `<at id="${r.openId}"></at>`).join(' ');
  const value = card as { schema?: string; body?: { elements?: unknown[] }; elements?: unknown[] };
  if (value.schema === '2.0') {
    const elements = (value.body?.elements ?? []).filter((e) => (e as { element_id?: string })?.element_id !== HEADER_ID);
    return { ...value, body: { ...value.body, elements: [{ tag: 'markdown', element_id: HEADER_ID, content: md }, ...elements] } };
  }
  const elements = (value.elements ?? []).filter((e) => (e as { text?: { content?: string } })?.text?.content !== md);
  return { ...value, elements: [{ tag: 'div', text: { tag: 'lark_md', content: md } }, ...elements] };
}

/** Per-request facade: no shared channel mutation, so concurrent users stay separate. */
export function withReplyMentions(channel: LarkChannel, messages: readonly NormalizedMessage[]): LarkChannel {
  const recipients = replyRecipients(messages, channel.botIdentity?.openId);
  const chatId = messages[0]?.chatId;
  if (!recipients.length || !chatId) return channel;
  const cardPrefix = recipients.map((r) => `<at id="${r.openId}"></at>`).join(' ') + '\n\n';
  const optsWithMentions = (opts?: SendOptions): SendOptions => ({
    ...opts, mentions: [...new Map([...recipients, ...(opts?.mentions ?? [])].map((m) => [m.openId ?? m.key, m])).values()],
  });
  const createdCards = new Set<string>();
  return new Proxy(channel, {
    get(target, key) {
      if (key === 'createCard' && typeof target.createCard === 'function') return async (card: object) => {
        const result = await target.createCard(mentionCard(card, recipients));
        createdCards.add(result.cardId);
        return result;
      };
      if (key === 'send') return async (to: string, input: SendInput, opts?: SendOptions) => {
        if (to !== chatId) return target.send(to, input, opts);
        if ('card' in input) return target.send(to, { card: mentionCard(input.card, recipients) }, opts);
        if ('text' in input || 'markdown' in input) return target.send(to, input, optsWithMentions(opts));
        if ('cardId' in input && createdCards.has(input.cardId)) return target.send(to, input, opts);
        await target.send(to, { text: '请查看回复内容。' }, optsWithMentions(opts));
        return target.send(to, input, opts);
      };
      if (key === 'stream') return (to: string, input: StreamInput, opts?: SendOptions) => {
        if (to !== chatId) return target.stream(to, input, opts);
        if ('card' in input) return target.stream(to, { card: {
          initial: mentionCard(input.card.initial, recipients),
          producer: (ctrl) => input.card.producer(new Proxy(ctrl, { get(c, k) {
            if (k === 'update') return (next: object | ((current: object) => object)) =>
              c.update(typeof next === 'function' ? (current) => mentionCard(next(current), recipients) : mentionCard(next, recipients));
            const value = Reflect.get(c, k, c);
            return typeof value === 'function' ? value.bind(c) : value;
          } })),
        } }, opts);
        let prefixed = false;
        return target.stream(to, { markdown: (ctrl) => input.markdown(new Proxy(ctrl, { get(c, k) {
          if (k === 'setContent') return (text: string) => { prefixed = true; return c.setContent(cardPrefix + text); };
          if (k === 'append') return (text: string) => { const prefix = prefixed ? '' : cardPrefix; prefixed = true; return c.append(prefix + text); };
          const value = Reflect.get(c, k, c);
          return typeof value === 'function' ? value.bind(c) : value;
        } })) }, opts);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
