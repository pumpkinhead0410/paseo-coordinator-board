# 작업자 완료 알림 실험 재현

[연구 결과](board-worker-finish-notifications.md)에 사용한 입력입니다. 운영 데몬 연결 없이 설치된 0.17.4 패키지를 읽습니다. 첫 코드 블록을 임시 폴더의 `probe.mjs`로 저장하고, `node probe.mjs /절대경로/cli/node_modules/@getpaseo`를 실행합니다. 두 번째 인자에 보드 개발 의존성의 `node_modules/@getpaseo` 절대경로를 주면 0.16.2의 큐 스키마도 검사합니다. Node.js 24에서 확인했습니다. 스키마·프로덕션 함수·저장소의 단언이 어긋나면 프로세스가 실패합니다. 관찰 입력과 큐 응답은 대역이며 임시 영수증만 로컬에 기록합니다.

```js
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.argv[2]; // installed @getpaseo directory inside cli/node_modules
const S = join(root, 'server/dist/server/server');
const imp = file => import(join(S, file));
const { createAgentCommand } = await imp('agent/create-agent/create.js');
const { createPaseoToolCatalog } = await imp('agent/tools/paseo-tools.js');
const { createFinishSubscriptions, createJsonFinishSubscriptionStore } = await imp('agent/finish-subscriptions/index.js');
const { publishAgentStream } = await imp('plugins/lifecycle/index.js');
const { AgentCreateRequestSchema } = await import(join(root, 'protocol/dist/messages.js'));
const { AgentManager } = await imp('agent/agent-manager.js');
const parent = { id:'parent', cwd:'/tmp', workspaceId:'ws', config:{title:'parent'} };
const child = { id:'child', config:{}, provider:'dummy' };
const trace = [];
const logger = {child(){return this},trace(){},info(){},error(){},warn(){}};
const deps = { logger, agentStorage:{get:async()=>null},
  providerSnapshotManager:{resolveCreateConfig:async()=>({})},
  agentManager:{getPluginTools:()=>[],getAgent:id=>id==='parent'?parent:child,
    createAgent:async(config,id,opts)=>{trace.push(['create',id,opts.metadata]);return child},
    tryRunOutOfBand:async()=>false,reloadStalePluginSession:async()=>{},
    async *streamAgent(id,prompt,opts,start){trace.push(['turn',opts.clientMessageId]);start.bind({start:{status:'started'},turnStartedPromise:Promise.resolve()})}
  },
  finishSubscriptions:{register:async()=>{trace.push(['register']);return {accept:()=>trace.push(['accept']),reject:()=>trace.push(['reject'])}}}
};
const base = {workspaceId:'ws',initialPrompt:'work',notifyOnFinish:true,callerAgentId:'parent'};
const input = {...base,kind:'session',agentId:'child',config:{provider:'dummy',cwd:'/tmp'},
  metadata:{receipt:true},clientMessageId:'06cf3d08-8cb7-4a0d-9e88-606561127848'};
const messages = [];
const catalog = createPaseoToolCatalog({...deps,callerAgentId:'parent',
  finishSubscriptions:()=>deps.finishSubscriptions,
  agentMessages:()=>({enqueue(m){messages.push(m);m.onDispatch();return {dispatched:Promise.resolve(),messageId:'m'+messages.length,status:'queued'}}})
});
const wire=AgentCreateRequestSchema.parse({type:'agent.create.request',requestId:'r',config:{provider:'codex',cwd:'/tmp'},notifyOnFinish:true});
assert(!('notifyOnFinish' in wire));
assert.equal((await createAgentCommand(deps,input)).initialPromptStarted,true);
assert.deepEqual(trace.map(x=>x[0]),['create','turn']);
assert.equal(trace[1][1],input.clientMessageId);
trace.length=0;
await createAgentCommand(deps,{...input,initialPrompt:''});
assert.deepEqual(trace.map(x=>x[0]),['create']);
const send=()=>catalog.executeTool('send_agent_prompt',{agentId:'child',prompt:'work',messageId:input.clientMessageId});
await send();await send();
assert.equal(messages.length,2);assert(messages.every(x=>!x.messageId));
assert.deepEqual(trace.map(x=>x[0]),['create','register','accept','register','accept']);
trace.length=0;
await createAgentCommand(deps,{...base,kind:'mcp',provider:'codex/model',metadata:{receipt:true},agentId:'child'});
assert.deepEqual(trace.map(x=>x[0]),['create','register','turn','accept']);
assert.equal(trace[0][1],undefined);assert.equal(trace[0][2],undefined);
await assert.rejects(catalog.executeTool('create_agent',{title:'task',provider:'codex/model',initialPrompt:'work',workspaceId:'ws',idempotencyKey:'k'}),/idempotencyKey/);
console.log('A wire flag absent; B native registration but no caller-chosen id/metadata; C two sends -> two enqueues');
const hooks=[];
for (const type of ['turn_completed','turn_failed','turn_canceled','permission_requested','permission_resolved'])
  publishAgentStream({emit:(name,data)=>hooks.push([name,data])},child,{type,request:{id:'p'},requestId:'p'});
assert.deepEqual(hooks.map(x=>x[0]),['agent.turn.after','agent.turn.after','agent.turn.after','agent.permission.before','agent.permission.after']);
assert.equal(hooks[0][1].turnId,null);
console.log('D hooks:',hooks.map(x=>x[1].outcome?.kind??x[0]).join(', '),'turnId=null');
const settled = await AgentManager.prototype.waitForAgentEvent.call({getAgent:()=>({lifecycle:'idle'}),runs:{getPendingRun:()=>null},peekPendingPermission:()=>null,getLastAssistantMessage:async()=>'last'},'child',{waitForActive:true});
assert.equal(settled.lastMessage,'last');console.log('post-create idle wait returns last snapshot without a turn key');
const src = join(S,'agent/create-agent/create.js');
const original=await readFile(src,'utf8');
const old='const notification = input.kind === "mcp" &&';
assert(original.includes(old));
const proposed=original.replace(old,'const notification = (input.kind === "mcp" || input.kind === "session") &&')
  .replace(/from "(\.[^"]+)"/g,(_,p)=>'from "'+new URL(p,pathToFileURL(src)).href+'"');
const proto=await import('data:text/javascript;base64,'+Buffer.from(proposed).toString('base64'));
trace.length=0;
assert((await proto.createAgentCommand(deps,input)).initialPromptStarted);
assert.deepEqual(trace.map(x=>x[0]),['create','register','turn','accept']);
assert.equal(trace[0][1],'child');assert.deepEqual(trace[0][2],input.metadata);assert.equal(trace[2][1],input.clientMessageId);
console.log('E in-memory branch prototype: stable child + metadata -> register -> stable first prompt -> accept');

const home=await mkdtemp(join(tmpdir(),'finish-probe-'));
const final={title:'child',labels:{'paseo.parent-agent-id':'parent'},pendingPermissions:[]};
const terminal={status:'idle',final,lastMessage:'ok'};
const permission={status:'permission',final:{...final,pendingPermissions:[{id:'perm'}]}};
const intent={callerAgentId:'parent',childAgentId:'child',requireParentOwnership:true};
const tick=()=>new Promise(r=>setTimeout(r,2));
async function until(predicate){for(let i=0;i<500;i++){if(await predicate())return;await tick()}assert.fail('timeout')}
const out=[];
let active=true, sequence=[], hold=false;
const never=new Promise(()=>{});
async function runtime(){
  const store=createJsonFinishSubscriptionStore(home);
  const fs=createFinishSubscriptions({store,serverId:'self',logger,retryDelayMs:1,callerIsActive:async()=>active,
    open:async()=>({next:async()=>sequence.shift()??never,close:async()=>{}}),
    messages:()=>({enqueue(m){out.push(m);return {dispatched:hold?never:Promise.resolve()}}})});
  await fs.start();return {fs,store};
}
let {fs,store}=await runtime();
sequence=[permission,permission,terminal];
const first=await fs.register(intent,true);
assert(!out.length);first.accept();
await until(async()=>(await store.list()).length===0);
assert.deepEqual(out.map(x=>x.source.event),['permission-required','finished']);
assert(out.every(x=>x.activeTurnBehavior==='queue' && x.unarchive===false));
sequence=[{...terminal,final:{...final,labels:{}}}];await fs.register(intent);
await until(async()=>(await store.list()).length===0);assert.equal(out.length,2);
active=false;await fs.register(intent);await until(async()=>(await store.list()).length===0);assert.equal(out.length,2);active=true;
sequence=[terminal];hold=true;await fs.register(intent);await until(()=>out.length===3);
assert.equal((await store.list()).length,1);
await fs.close();hold=false;sequence=[terminal];({fs,store}=await runtime());
await until(async()=>(await store.list()).length===0);
assert.equal(out.length,4);assert(out.slice(-2).every(x=>x.messageId===undefined));
await fs.close();
console.log('native observer: permission repeated + terminal = 2 enqueues; detach/inactive = 0; restart before dispatched ACK = 2 enqueue attempts total');
const { MessageReceipts } = await imp('message-receipts/index.js');
const receipts = new MessageReceipts(home);
let writes=0;
const fixed={agentId:'parent',messageId:'stable-event',request:{prompt:'event'},
  async send(mark){await mark();writes++}};
await Promise.all([receipts.send(fixed),receipts.send(fixed)]);
await new MessageReceipts(home).send(fixed);assert.equal(writes,1);
await assert.rejects(receipts.send({...fixed,request:{prompt:'other'}}),/key_conflict/);
await assert.rejects(receipts.send({...fixed,messageId:'unfinished',send:async mark=>{await mark();throw Error('shutdown')}}),/shutdown/);
await assert.rejects(new MessageReceipts(home).send({...fixed,messageId:'unfinished'}),/outcome_unknown/);
console.log('SDK receipt: concurrent + completed replay dispatch once; pending restart = outcome_unknown');
const { createPaseoApi } = await import(join(root,'client/dist/index.js'));
const sdkCalls=[];
const sdk=createPaseoApi({getLastServerInfoMessage:()=>null,sendAgentMessage:async(...a)=>sdkCalls.push(a),waitForFinish:async()=>({final:null,status:'idle',lastMessage:'ok'})});
const handle=sdk.agents.ref('parent');
const result=await handle.waitForFinish(100);
assert.equal(result.status,'idle');assert.equal(sdkCalls.length,0);
await handle.send('work finished',{sourceAgentId:'plugin:coordinator-board',messageId:'stable-event',activeTurnBehavior:'queue'});
assert.equal(sdkCalls.length,1);console.log('SDK wait -> no send; hook transport -> one send with source + key + queue');
await sdk.dispose();
const { createAgentMessageDelivery } = await imp('agent/agent-messages/delivery.js');
let busy=true, wake;
const turns=[];
const delivery=createAgentMessageDelivery({
  isRunning:()=>busy, subscribe(cb){wake=cb;return ()=>{}},
  schedule:(ms,cb)=>{const id=setTimeout(cb,Math.min(ms,8));return ()=>clearTimeout(id)},
  dispatch:async request=>{assert(request.admit());turns.push(request);return 'turn_started'},
  onError:e=>{throw e}
});
const combined = createPaseoApi({getLastServerInfoMessage:()=>null,
  sendAgentMessage:async(id,prompt,opts)=>delivery.enqueue({recipientId:id,prompt,messageId:opts.messageId,
    activeTurnBehavior:opts.activeTurnBehavior,source:{kind:'agent-message',agentId:opts.sourceAgentId}})});
const hookParent=combined.agents.ref('parent');
let queued;
publishAgentStream({emit:(name,data)=>{if(name==='agent.turn.after')
  queued=hookParent.send(data.outcome.kind,{sourceAgentId:'plugin:coordinator-board',messageId:'hook-first',activeTurnBehavior:'queue'})}},
  child,{type:'turn_completed',turnId:'first'});
await queued;await new Promise(r=>setTimeout(r,24));
assert.equal(turns.length,0);busy=false;wake('parent');
await until(()=>turns.length===1);
assert(turns[0].idleOnly);assert.deepEqual(turns[0].messageIds,['hook-first']);
await delivery.close();await combined.dispose();
console.log('D hook -> SDK send -> real queue: busy dispatch 0, idle dispatch 1');
trace.length=0;
const cannotStart={...deps,agentManager:{...deps.agentManager,tryRunOutOfBand:async()=>{throw Error('start refused')}}};
const bad=await proto.createAgentCommand(cannotStart,input);
assert.equal(bad.initialPromptStarted,false);
assert.deepEqual(trace.map(x=>x[0]),['create','register','accept']);
console.log('E guard-only prototype accepted registration despite failed session startup');

({fs,store}=await runtime());
sequence=[terminal];
const prior=await fs.register(intent,true);
const newer=await fs.register(intent,true);
const before=out.length;
prior.accept();newer.accept();
await until(async()=>(await store.list()).length===0);
assert.equal(out.length-before,1);await fs.close();
console.log('two overlapping pending native registrations for same pair -> 1 terminal enqueue');
const reports=[];
const reporter=createPaseoToolCatalog({...deps,callerAgentId:'child',
  agentMessages:()=>({enqueue(m){reports.push(m);return {dispatched:Promise.resolve(),status:'queued',messageId:'explicit'}}})});
await reporter.executeTool('send_agent_prompt',{agentId:'parent',prompt:'first assignment report',notifyOnFinish:false});
assert.equal(reports.length,1);assert.equal(reports[0].source.agentId,'child');
assert.equal(reports[0].recipientId,'parent');
console.log('G explicit report: one child -> parent enqueue with no reverse subscription');
const urgentBatches=[];
const busyQueue=createAgentMessageDelivery({isRunning:()=>true,
  dispatch:async batch=>{assert(batch.admit());urgentBatches.push(batch);return 'steered'},onError:e=>{throw e}});
const baseMessage={recipientId:'parent',source:{kind:'agent-message',agentId:'child'},prompt:'update'};
const queuedReport=busyQueue.enqueue({...baseMessage,messageId:'queued-report',activeTurnBehavior:'queue'});
const urgent=busyQueue.enqueue({...baseMessage,messageId:'later-steer',activeTurnBehavior:'steer'});
await Promise.all([queuedReport.dispatched,urgent.dispatched]);
assert.equal(urgentBatches.length,1);assert.equal(urgentBatches[0].idleOnly,false);
assert.deepEqual(urgentBatches[0].messageIds,['queued-report','later-steer']);
await busyQueue.close();
console.log('busy parent + later explicit steer: queued report rides together in one non-idle-only batch');
({fs,store}=await runtime());
const beforePending=out.length;
await fs.register(intent,true);
assert.equal((await store.list()).length,1);
await fs.close();sequence=[terminal];
({fs,store}=await runtime());
await until(async()=>(await store.list()).length===0);
assert.equal(out.length-beforePending,1);
await fs.close();
console.log('restart between register and accept + settled idle input -> one finished enqueue without dispatch confirmation');
if(process.argv[3]){
  const {ActiveTurnBehaviorSchema}=await import(join(process.argv[3],'protocol/dist/messages.js'));
  assert(!ActiveTurnBehaviorSchema.safeParse('queue').success);
  console.log('0.16.2 protocol rejects explicit queue');
}
const {DaemonClient}=await import(join(root,'client/dist/daemon-client.js'));
const legacyHost={lastServerInfoMessage:{features:{}}};
const routeBehavior=behavior=>DaemonClient.prototype.activeTurnBehaviorForHost.call(legacyHost,{sourceAgentId:'child',activeTurnBehavior:behavior});
assert.equal(routeBehavior('queue'),undefined);assert.throws(()=>routeBehavior('steer'),/Update/);
const drained=[];
const closing=createAgentMessageDelivery({isRunning:()=>true,dispatch:async batch=>{
  assert(batch.admit());drained.push(batch);return 'steered'},onError:e=>{throw e}});
closing.enqueue(baseMessage);
await closing.close();
assert.deepEqual(drained.map(b=>[b.idleOnly,b.activeTurnBehavior,b.unarchive]),[[false,'steer',true]]);
const {openFinishObservation}=await imp('agent/finish-subscriptions/internal/observation-stream.js');
const obs=await openFinishObservation({use:(_id,use)=>use({
  observe:async()=>()=>{},wait:async()=>({...terminal,final:{...final,status:'idle'}})
})},intent,new AbortController().signal);
assert.equal((await obs.next()).reason,undefined);await obs.close();
console.log('old-host behavior queue omitted / steer rejected; normal close drains non-idle-only; settled-only observation lacks cancellation reason');
```

Playbooks 0.120.1과 0.185.2는 설치본의 `server`와 `shared`를 임시 디렉터리에 복사하고 그 버전과 호환되는 Zod를 사용할 수 있게 한 후 다음 파일을 같은 디렉터리에서 `bun bus-probe.ts`로 실행합니다.

```ts
import assert from "node:assert/strict";
import { checkTypes } from "./server/bus";
import { OVERSIGHT_TYPES } from "./server/oversight-events";
import { JOB_TYPES } from "./server/job-events";
import { FANOUT_TYPES } from "./server/fanout-events";
const defs=[...OVERSIGHT_TYPES,...JOB_TYPES,...FANOUT_TYPES];
checkTypes(defs,["step.completed"],{});
assert.throws(()=>checkTypes(defs,["agent.turn.after"],{}),/no event type matches/);
console.log(defs.length,"types; step.completed accepted; agent.turn.after rejected");
```

## 실행 대조

- 보드 기준 `32a744c`의 별도 임시 복사본에서 배정·운영·병합 알림 관련 기존 테스트 49개가 통과했습니다. 범위에는 동시 배정, 응답 유실 후 재시도, 권한과 작업 위치 검사가 포함됩니다.
- 같은 소스에서 타입 검사, CI 지정 Bun 1.4.0의 기존 테스트 299개, 릴리스 ZIP 생성 및 Python zipfile 무결성 검사를 통과했습니다. 첫 샌드박스 실행에서는 Selector 자식 프로세스가 빈 입력을 받아 11건이 실패했고 같은 Bun·소스를 샌드박스 밖에서 실행해 299건 통과를 확인했습니다. 문서에는 새 제품 동작이 포함되지 않습니다.
