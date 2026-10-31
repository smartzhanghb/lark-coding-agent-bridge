# Automatic group reply mentions

Version `0.8.0-workspaces.3` mentions the human authors of the current group request automatically. There is no new account permission or setting. Direct chats are unchanged. Repeated authors in a debounced batch are deduplicated; quoted authors, incoming mention targets, the bridge itself and known bot senders are not added.

Text/Markdown messages use SDK structured mentions. Card replies use the card-native `<at id="ou_..."></at>` syntax, retained in initial cards and subsequent snapshots. Native Markdown streams include the card-native mention in each full-content update. Thread reply options are preserved. Empty agent responses still do not create a reply. A per-request facade avoids sharing recipients between simultaneous runs.

## Direct result tools

Both agent adapters export `LARK_REPLY_CONTEXT` to the child process. It contains the current `chatId`, group `chatType` and deduplicated human `userIds`. Its source is the bridge-built context, not message text, quotations or attachments. The variable is cleared for private chats and non-IM contexts.

This variable is notification routing metadata, **not an authorization credential**. Business tools must still use their existing identity and write-permission checks. They should ignore a context whose chat or current sender does not match. Tools that use a separate process to send results must add mentions themselves; this feature does not intercept arbitrary tool network traffic.

The local AgentData-DOP handler adopts this context for direct cards and file results. Cards contain a native mention. Files are sent first, followed by one short text notification containing `<at user_id="ou_..."></at>`. Private/unknown contexts add no notification. It uses a ContextVar to keep simultaneous requests separate and resets it even on exceptions.

## Validation

Tests exercise the actual incoming-message handler and notification facade, including group/p2p distinction, current-author selection, batch deduplication, bot exclusion, card updates, streaming updates, preserved thread options, concurrent request isolation and prompt-injection boundaries. Business tests cover direct card and file payloads, mismatched context, invalid IDs and cleanup after failure.

Tests capture outbound requests; they do not send live group messages. Client display and push-notification behavior still require a real group request. In particular, native Markdown streaming adds the mention via a card update, so tests do not establish push behavior for every Feishu client.
