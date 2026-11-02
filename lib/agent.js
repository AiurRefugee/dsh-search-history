import { defineTool } from '@deepseek-ai/dsh-tools';
import { scanObservation } from './search-host.js';

export function historyTool(ctx) {
  return defineTool({
    name: 'search_chat_history',
    description: 'Find visible user and assistant messages from saved conversations across all workspaces. Returns snippets, session IDs and message locations. Use session_id to narrow the search.',
    parameters: {
      query: { type: 'string', required: true, description: 'Literal text, up to 500 characters.' },
      session_id: { type: 'string', description: 'Optional session to search across all workspaces.' },
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
