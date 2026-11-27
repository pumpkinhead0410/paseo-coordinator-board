import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationReader } from "../server/conversation";
import { PreferenceStore } from "../server/preferences";
import { NoteStore } from "../server/notes";
import { claimQuotaNotice } from "../server/quota-notice";
import { deliverQuotaNotice } from "../client/quota-delivery";

const warning = "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h49m33s.";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(),"quota-notice-"));
  const prefs = new PreferenceStore(join(dir,"scope"));
  prefs.change(s => { s.projects = ["p"]; });
  const notes = new NoteStore(join(dir,"notes"));
  const agent = {id:"worker",title:"fix workflow",status:"idle",provider:"antigravity",updatedAt:"a",pendingPermissions:[]};
  const project = {projectKey:"p"};
  const list = entries => ({entries,pageInfo:{hasMore:false}});
  const tail = {type:"assistant_message",text:warning,messageId:"agent_message_chunk:157"};
  const page = {epoch:"e",entries:[
    {seqEnd:1,item:{type:"tool_call",name:"read_file",status:"completed",detail:{type:"read",filePath:"server/reporting.ts"}}},
    {seqEnd:2,timestamp:"2026-11-27T01:00:00Z",item:tail},
  ]};
  const sdk = {workspaces:{list:()=>list([])}, agents:{list:()=>list([{agent,project}]),ref:()=>({timeline:{refetch:async()=>page}})}};
  const poll = () => claimQuotaNotice(sdk,new PreferenceStore(join(dir,"scope")),notes,new ConversationReader());
  return {agent,project,tail,page,poll,prefs,notes,sdk};
}
test("one toast across overlapping polls and restart, another for a new terminal event",async()=>{
  const {poll,tail,page} = fixture();
  const shown = [];
  const receive = () => deliverQuotaNotice(poll, msg=>shown.push(msg));
  await Promise.all([receive(),receive()]);
  await receive();
  expect(shown).toHaveLength(1);
  for (const s of ["fix workflow","worker","reporting.ts","2h49m33s","03:49:33","커밋","인계"]) expect(shown[0]).toContain(s);
  tail.messageId="agent_message_chunk:194";
  page.entries[1].seqEnd++;
  await receive();
  expect(shown).toHaveLength(2);
});
test("only current managed unfinished and explicitly interrupted sessions qualify",async()=>{
  for (const change of [
    f=>f.project.projectKey="other", f=>f.tail.type="user_message", f=>f.tail.text="인용: "+warning,
    f=>f.tail.text="429 Too Many Requests",f=>f.tail.text="authentication failed",
    f=>{f.agent.activeTurn={id:"running"};f.agent.attentionReason="error";},
    f=>f.agent.pendingPermissions=[{id:"permission"}],f=>f.agent.status="running",f=>f.agent.status="closed",
    f=>f.notes.update({kind:"done",sessionId:"worker",expectedRevision:0,text:"completed"}),
    f=>f.page.entries.push({seqEnd:3,item:{type:"user_message",text:"resume"}}),
  ]) {
    const f=fixture();change(f);expect(await f.poll()).toBeNull();
  }
});
test("linked workers follow board membership and resume without a notice",async()=>{
  const f=fixture();
  f.project.projectKey="outside";
  f.prefs.change(s=>{s.sessionLinks.worker={sessionId:"worker",title:"Worker",workspaceTitle:"w",sourceProjectTitle:"Other",sourceProjectId:"outside",targetProjectId:"p",targetProjectTitle:"Managed"};});
  expect(await f.poll()).toContain("Managed");
  f.tail.messageId="new";
  f.agent.status="running";
  expect(await f.poll()).toBeNull();
});
test("reprojection of a terminal turn does not notify again, but a new identical turn does",async()=>{
  const f=fixture();f.page.entries[1].turnId="a";
  expect(await f.poll()).not.toBeNull();
  f.page.entries[1].seqEnd++;
  expect(await f.poll()).toBeNull();
  f.page.entries[1].turnId="b";
  expect(await f.poll()).not.toBeNull();
});

test("release or resume during the timeline read cancels delivery", async () => {
  for (const update of [f => f.agent.status = "running", f => f.prefs.change(s => {s.projects=[];})]) {
    const f = fixture();
    f.sdk.agents.ref = () => ({timeline:{refetch:async () => {update(f); return f.page;}}});
    expect(await f.poll()).toBeNull();
  }
});
test("native error recovers only the provider's stated reset and the completed commit", async () => {
  const f=fixture();
  f.page.entries[0].item = {type:"tool_call",status:"completed",name:"shell",detail:{type:"shell",command:"git commit -m update",exitCode:0,output:"[topic b123abc] update"}};
  f.page.entries[1].item = {type:"error",message:"You've hit your usage limit. Try again at 14:00 UTC."};
  const message = await f.poll();
  expect(message).toContain("14:00 UTC");
  expect(message).toContain("b123abc");
  for (const message of ["429 Too Many Requests","401 authentication failed","permission denied"]) {
    f.page.entries[1].seqEnd++;
    f.page.entries[1].item.message=message;
    expect(await f.poll()).toBeNull();
  }
});
test("a verbatim warning requested in the user turn is not an Antigravity incident",async()=>{
  const f=fixture();
  f.page.entries.unshift({seqEnd:0,item:{type:"user_message",text:"인용해주세요: "+warning}});
  expect(await f.poll()).toBeNull();
});
test("an explicit provider limit without a reset keeps recovery unknown",async()=>{
  const f=fixture(); f.tail.text="⚠ Individual quota reached.";
  expect(await f.poll()).toContain("회복: 미확인");
});

test("a coordinator quotation in the current turn is not a provider interruption", async () => {
  const f = fixture();
  f.page.entries.unshift({seqEnd:0, turnId:"current", item:{type:"tool_call", name:"agent_message",
    status:"completed", callId:"paseo-agent-message:quoted", agentMessage:{event:"message", sender:{id:"coord"}, text:warning}}});
  f.page.entries.at(-1).turnId = "current";
  expect(await f.poll()).toBeNull();
});

test("an earlier turn's quotation does not suppress a new interruption", async () => {
  const f = fixture();
  f.page.entries.unshift({seqEnd:0, turnId:"prior", item:{type:"user_message",text:warning}});
  f.page.entries.at(-1).turnId = "current";
  expect(await f.poll()).toContain("사용량 한도");
});

test("an untagged warning cannot inherit a tagged turn's commit", async () => {
  const f = fixture();
  f.page.entries[0].turnId = "prior";
  f.page.entries[0].item = {type:"tool_call",name:"shell",status:"completed",
    detail:{type:"shell",command:"git commit -m prior",exitCode:0,output:"[main 12abcde] prior"}};
  expect(await f.poll()).toContain("마지막 확인 작업: 미확인 · 커밋: 미확인");
});

test("Antigravity history replay keeps the observed input identity and relative reset", async () => {
  const f = fixture();
  const input = {seqEnd:0, item:{type:"tool_call", name:"agent_message", callId:"paseo-agent-message:request",
    status:"completed", agentMessage:{event:"message",sender:{id:"coord"},text:"review"}}};
  f.page.entries.unshift(input);
  const end = f.page.entries.at(-1);
  end.turnId = "acp:request";
  expect(await f.poll()).toContain("03:49:33");
  delete end.turnId;
  end.item.messageId = "replayed";
  for (const entry of f.page.entries) entry.timestamp = "2026-11-27T09:11:22Z";
  expect(await f.poll()).toBeNull();
  input.item.callId = "paseo-agent-message:another";
  const next = await f.poll();
  expect(next).toContain("2h49m33s");
  expect(next).not.toContain("예상");
});
