import assert from 'node:assert/strict';
import test from 'node:test';
import { scanObservation, createSearchHandler } from '../lib/search-host.js';
import { historyTool } from '../lib/agent.js';
import { revealMessage } from '../src/client.js';

const signal = new AbortController().signal;
const header = { id: 'session-a', cwd: '/a' };
const part = (type, text) => ({ type, text });
const events = [
  { seq: 3, surfaceOp: 'append', type: 'user/message', data: { id: 'u', source: {kind: 'user'}, content: [part('text', '早期：配置器')] } },
  { seq: 8, surfaceOp: 'append', type: 'assistant/message', data: {turn: 1, step: 2, message: {id:'a', content: [part('reasoning','隐藏词'), part('text','完成配置器')]}} },
];
const observation = { events, header, [Symbol.dispose]() {} };
const ctx = {
  workspaceRegistry: { archivedSessionIds: [] },
  sessionQuery: {
    listSessions: async () => [{header}, {header:{ id:'private', cwd:'/b' }}],
    observeSession: async id => { assert.equal(id, header.id); return observation; },
  },
};

test('global endpoint returns distinct message anchors and excludes reasoning', async () => {
  const service = createSearchHandler(ctx);
  try {
    const response = await service.fetch(new Request('http://local/search', {method:'POST', body: JSON.stringify({
      requestId: 'abcdef0123456789', version:1, action:'start', mode:'title-body', scope:'ordinary-unarchived',
      query:'配置器', sessionIds:[header.id], catalog:[{id:header.id,title:'工作'}],
    })}));
    const result = await response.json();
    assert.deepEqual(result.items[0].hits.map(x=>x.message.seq), [3,8]);
    assert.ok(!JSON.stringify(result).includes('隐藏词'));
    assert.deepEqual((await scanObservation(observation,'隐藏词',signal)).hits, []);
  } finally { service.dispose(); }
});
test('agent searches only caller workspace and returns visible message IDs', async () => {
  const tool = historyTool(ctx);
  const exec = {agent:{session:{header}}, signal};
  const result = JSON.parse(await tool.execute({query:'配置器'},exec));
  assert.equal(result.incomplete,false);
  assert.deepEqual(result.hits.map(row=>row.messageId), ['u','a']);
  assert.deepEqual(JSON.parse(await tool.execute({query:'隐藏词'},exec)).hits,[]);
});
test('selecting second result loads older history and scrolls only its row', async () => {
  const {hits} = await scanObservation(observation, '配置器', signal);
  const nodes = [{key:'first',data:{seq:3}}];
  const scroll = {scrollTop: 0, scrollHeight: 1200, clientHeight: 400,
    getBoundingClientRect:()=>({top:0,bottom:400,width:600}),querySelector:()=>null};
  const {mock} = await import('node:test');
  mock.method(globalThis.performance,'now',()=>0);
  globalThis.window = {innerHeight:400,innerWidth:600};
  let time = 0;
  const frames = [];
  globalThis.requestAnimationFrame = callback => { time += 100; frames.push(scroll.scrollTop); callback(time); };
  const rows = ['first','second'].map(key => ({
    dataset:{chatNodeKey:key}, getClientRects:()=>[{}], isConnected:true, getBoundingClientRect:()=>({top:key==="first"?50:700,height:100}),
  }));
  const target = {id:header.id,root:{closest:()=>scroll,querySelectorAll:()=>rows,querySelector:()=>null}};
  const face = {
    getSnapshot:()=>({openState:'open',openError:null,loadingOlder:false}),
    loadThrough:async seq=>{
      assert.equal(seq,8);
      nodes.push({key:'second',kind:'assistant-step',data:{finalNode:{seq,messageId:'a'}}});
    },
  };
  const adapter = {face:()=>face,nodes:()=>({values:()=>nodes}),forSession:()=>target};
  assert.equal(await revealMessage(target,hits[1].message,()=>true,adapter),true);
  assert.deepEqual(frames,[0,412.5]);
  assert.equal(scroll.scrollTop,550);
  mock.restoreAll();
  delete globalThis.window;
  delete globalThis.requestAnimationFrame;
});
