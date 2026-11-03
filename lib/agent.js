import { defineTool } from '@deepseek-ai/dsh-tools';
import { scanObservation } from './search-host.js';

export function historyTool(ctx) {
  return defineTool({
    name: 'search_chat_history',
    description: 'Search saved conversation text across all workspaces (not just the current cwd). Search user prompts and final assistant text; exclude reasoning, tools and subagent sessions. Returns one excerpt per matching message with sessionId, workspace, messageId, seq and turn. To read the complete user/assistant exchange around a result, call read_chat_history_turn with session_id and message_id. Results are capped at 100; incomplete=true means more matches may exist.',
    parameters: {
      query: { type: 'string', required: true, description: 'Required case-insensitive literal phrase (not regex), 1–500 characters.' },
      session_id: { type: 'string', description: 'Optional session ID; searches that conversation even when it belongs to another workspace.' },
    },
    output: { schema: { type: 'string' }, render: (_, text) => [{ type: 'text', text }] },
    isConcurrencySafe: () => true,
    timeoutMs: 60000,
    async execute(args, exec) {
      const query = args.query.trim();
      if (!query || query.length > 500 || query.includes('\0')) throw new Error('A valid query is required.');
      const hits = [];
      let incomplete = false;
      const records = await ctx.sessionQuery.listSessions(exec.signal);
      const eligible = header => typeof header.cwd === 'string' && header.origin !== 'subagent' &&
        !ctx.workspaceRegistry.archivedSessionIds.includes(header.id) && (!args.session_id || header.id === args.session_id);
      for (const { header } of records) {
        if (!eligible(header)) continue;
        let observation;
        try {
          observation = await ctx.sessionQuery.observeSession(header.id, { signal: exec.signal, projectionMode: 'none' });
          if (observation.header.id !== header.id || !eligible(observation.header)) continue;
          const result = await scanObservation(observation, query, exec.signal);
          incomplete ||= result.limited;
          for (const hit of result.hits) {
            if (hits.length >= 100) return JSON.stringify({ hits, incomplete: true });
            hits.push({ sessionId: header.id, workspace: observation.header.cwd, ...hit.message, snippet: hit.snippet });
          }
        } catch {
          exec.signal.throwIfAborted();
          incomplete = true;
        } finally {
          observation?.[Symbol.dispose]();
        }
      }
      return JSON.stringify({ hits, incomplete });
    },
  });
}


/**
 * Read a complete visible exchange around a search result. A turn consists of
 * the closest preceding user message and the assistant responses before the
 * next user message. No reasoning, tool output or subagent transcript is exposed.
 */
export function readHistoryTurnTool(ctx) {
  return defineTool({
    name: 'read_chat_history_turn',
    description: 'Read the complete visible user/assistant exchange containing a search_chat_history result, across any workspace. Pass the exact sessionId and messageId returned by search_chat_history. Includes the user prompt and all settled assistant text until the next user prompt; excludes reasoning, tool calls and subagent transcripts. Returns truncated=true if the response exceeds its size limit.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Exact sessionId from search_chat_history.' },
      message_id: { type: 'string', required: true, description: 'Exact messageId from search_chat_history, identifying the exchange to read.' },
    },
    output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    timeoutMs: 60000,
    async execute(args, exec) {
      const sessionId = args.session_id;
      const messageId = args.message_id;
      if (typeof sessionId !== 'string' || !sessionId || typeof messageId !== 'string' || !messageId) {
        throw new Error('session_id and message_id are required.');
      }
      const records = await ctx.sessionQuery.listSessions(exec.signal);
      const eligible = h => h && h.id === sessionId && typeof h.cwd === 'string' &&
        h.origin !== 'subagent' && !ctx.workspaceRegistry.archivedSessionIds.includes(h.id);
      if (!records.some(row => eligible(row.header))) throw new Error('Session not found or not accessible.');
      let observation;
      try {
        observation = await ctx.sessionQuery.observeSession(sessionId, { signal: exec.signal, projectionMode: 'none' });
        if (!eligible(observation.header)) throw new Error('Session is no longer accessible.');
        const steps = new Map(), users = [];
        for (const event of observation.events) {
          exec.signal.throwIfAborted();
          const data = event.data;
          if (!data) continue;
          const key = `${data.turn}:${data.step}`;
          if (event.type === 'step/start' || event.type === 'llm/retry') { steps.delete(key); continue; }
          if (event.surfaceOp !== 'append') continue;
          if (event.type === 'user/message' && data.source?.kind === 'user') users.push(event);
          else if (event.type === 'assistant/message') steps.set(key, event);
        }
        const visible = [...users, ...steps.values()].sort((a, b) => a.seq - b.seq)
          .map(event => ({ event, message: event.type === 'user/message' ? event.data : event.data.message }))
          .filter(row => typeof row.message?.id === 'string' && Array.isArray(row.message.content));
        const anchor = visible.findIndex(row => row.message.id === messageId);
        if (anchor < 0) throw new Error('Message not found in visible conversation.');
        let start = anchor;
        while (start > 0 && visible[start].event.type !== 'user/message') start--;
        if (visible[start].event.type !== 'user/message') start = anchor;
        let end = start + 1;
        while (end < visible.length && visible[end].event.type !== 'user/message') end++;
        // If the requested anchor precedes the first user prompt, read that
        // message alone rather than accidentally crossing into another exchange.
        if (anchor >= end) { start = anchor; end = anchor + 1; }
        const limit = 250000;
        let used = 0, truncated = false;
        const messages = [];
        for (const { event, message } of visible.slice(start, end)) {
          const fullText = message.content.filter(part => part?.type === 'text' && typeof part.text === 'string')
            .map(part => part.text).join(event.type === 'user/message' ? '' : '\n');
          const remaining = Math.max(0, limit - used);
          const content = fullText.slice(0, remaining);
          used += content.length;
          if (content.length < fullText.length) truncated = true;
          messages.push({ messageId: message.id, seq: event.seq,
            role: event.type === 'user/message' ? 'user' : 'assistant', content });
          if (used >= limit) { truncated ||= end - start > messages.length; break; }
        }
        // Recheck archive/deletion after the potentially long read.
        const fresh = await ctx.sessionQuery.listSessions(exec.signal);
        if (!fresh.some(row => eligible(row.header))) throw new Error('Session is no longer accessible.');
        return JSON.stringify({ sessionId, workspace: observation.header.cwd, messageId, messages, truncated });
      } finally {
        observation?.[Symbol.dispose]();
      }
    },
  });
}
