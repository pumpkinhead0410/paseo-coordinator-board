import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDisplayUsage } from "../server/display-usage";

import {expect,test} from "bun:test";
import {readAccountUsage} from "../server/usage-routing";
import {resolveRoute, type CatalogModel} from "../shared/dispatch";
import {preferCapacity, type AccountUsage} from "../shared/usage-routing";

const now = Date.parse("2026-11-22T06:00:00Z");
function report(providerId:string, remaining:number, id="weekly"):AccountUsage {
  return {providerId,label:providerId,plan:null,fetchedAt:new Date(now).toISOString(),status:"available",balances:[],
    windows:[{id,label:id,summary:true,resetsAt:null,remainingPct:remaining}]};
}
const left={provider:"runner-a"}, right={provider:"runner-b"};
const available=[report(left.provider,40),report(right.provider,60)];

test("headroom compares like quotas, handles arbitrary providers and keeps stable preference on ties",()=>{
  expect(preferCapacity([left,right],available,now)).toBe(right);
  expect(preferCapacity([left,right],[available[0],report(right.provider,40)],now)).toBe(left);
  for(const revised of [
    [available[0],report(right.provider,90,"monthly")],
    [available[0],{...available[1],fetchedAt:"2026-11-22T05:40:00Z"}],
    [{...available[0],status:"error" as const},available[1]],
    [available[0],{...available[1],windows:[{...available[1].windows[0],resetsAt:"2026-11-22T05:55:00Z"}]}],
    [available[0],available[1],available[1]],
    [available[1]],
  ]) expect(preferCapacity([left,right],revised,now)).toBe(left);
  const withWindows = available.map((p,index)=>({...p,windows:[...p.windows,{...p.windows[0],id:"5h",remainingPct:index ? 3 : 10}]}));
  expect(preferCapacity([left,right],withWindows,now)).toBe(left);
  const exhaustedShortWindow = {...available[1],windows:[
    ...available[1].windows,{...available[1].windows[0],id:"5h",summary:false,remainingPct:0},
  ]};
  expect(preferCapacity([left,right],[available[0],exhaustedShortWindow],now)).toBe(left);
});

test("host usage reads retain unknown values and normalize only published numbers and balances",async()=>{
  const checkout={
    requestId:"test",fetchedAt:"2026-11-22T06:00:00Z",providers:[{
      providerId:"custom",displayName:"Studio",planLabel:"Pro",status:"available",
      windows:[{id:"weekly",label:"Week",usedPct:35},{id:"broken",label:"Unknown",remainingPct:101}],
      balances:[{id:"credits",label:"Credits",unit:"credits",used:30,limit:100}],
      details:[{id:"irrelevant",label:"Private label",value:"private value"}],
    }],
  };
  const data=await readAccountUsage({providers:{listUsage:async()=>checkout}} as never);
  expect(data[0]).toMatchObject({providerId:"custom",windows:[{remainingPct:65},{remainingPct:null}],balances:[{remaining:70,limit:100}]});
  expect(JSON.stringify(data)).not.toContain("private value");
  expect(await readAccountUsage({providers:{listUsage:async()=>{throw Error("host offline");}}} as never)).toEqual([]);
});

test("routing preserves explicit choices, required capabilities and host-specific provider IDs",()=>{
  const catalog:CatalogModel[]=[
    {provider:"codex",model:"gpt-6.2-sol",label:"Codex",efforts:["high"],isDefault:true},
    {provider:"arbitrary",model:"image-worker",label:"Custom",efforts:[],isDefault:true},
  ];
  const fresh = [report("codex",10),report("arbitrary",80)].map(r=>({...r,fetchedAt:new Date().toISOString()}));
  expect(resolveRoute("C",{},catalog,false,fresh)?.provider).toBe("arbitrary");
  expect(resolveRoute("A",{},catalog,false,fresh)?.provider).toBe("arbitrary");
  expect(resolveRoute("C",{},catalog,true,fresh)?.provider).toBe("codex");
  const pinned={provider:"codex",model:"gpt-6.2-sol",effort:"high"};
  expect(resolveRoute("C",{C:[pinned]},catalog,false,fresh)).toEqual(pinned);
  expect(resolveRoute("C",{},catalog,false,fresh.map(r=>({...r,providerId:r.providerId+"-2"})))?.provider).toBe("codex");
});

test("a scoped Fable or feature window cannot exhaust Opus, but an exhausted Fable route yields to Opus",()=>{
  const opus={provider:"claude",model:"claude-opus-5"};
  const fable={provider:"claude",model:"claude-fable-5"};
  const codex={provider:"codex",model:"sol"};
  const limits=report("claude",65);
  limits.windows.push({...limits.windows[0],id:"weekly_model_fable",summary:false,remainingPct:0});
  limits.windows.push({...limits.windows[0],id:"image-tool:weekly",summary:false,remainingPct:0});
  const reports=[limits,report("codex",30)];
  expect(preferCapacity([opus,codex],reports,now)).toBe(opus);
  expect(preferCapacity([fable,codex],reports,now)).toBe(codex);
  expect(preferCapacity([fable,opus,codex],reports,now)).toBe(opus);
});

test("host readings fill only configured provider gaps and preserve the original observation time",async()=>{
  const folder=mkdtempSync(join(tmpdir(),"board-usage-"));
  try {
    const write=(rows:unknown[])=>writeFileSync(join(folder,"account-usage.json"),JSON.stringify({version:1,reports:rows}));
    const host=report("custom",0), paid=report("native",70);
    const installed=[{id:"custom"},{id:"native"}];
    write([host,paid,report("absent",50),{...host,fetchedAt:"invalid"},{...host,windows:[{...host.windows[0],remainingPct:120}]}]);
    const empty={...host,status:"unavailable" as const,windows:[]};
    expect(await readDisplayUsage(folder,installed,[paid,empty])).toEqual([host]);
    expect(await readDisplayUsage(folder,installed,[host,paid])).toEqual([]);
    const expired={...host,windows:[{...host.windows[0],resetsAt:"2000-01-01T00:00:00Z"}]};
    expect(await readDisplayUsage(folder,installed,[expired,paid])).toEqual([host]);
    const credit={...host,windows:[],balances:[{id:"credits",label:"Credits",remaining:0,unit:"credits",limit:null,resetsAt:null}]};
    expect(await readDisplayUsage(folder,installed,[credit,paid])).toEqual([]);
    writeFileSync(join(folder,"account-usage.json"),"{");
    expect(await readDisplayUsage(folder,installed,[])).toEqual([]);
    writeFileSync(join(folder,"account-usage.json")," ".repeat(131073));
    expect(await readDisplayUsage(folder,installed,[])).toEqual([]);
    rmSync(join(folder,"account-usage.json"));writeFileSync(join(folder,"other"),JSON.stringify({version:1,reports:[host]}));
    symlinkSync(join(folder,"other"),join(folder,"account-usage.json"));
    expect(await readDisplayUsage(folder,installed,[])).toEqual([]);
  } finally {rmSync(folder,{recursive:true,force:true});}
});

test("usage lookup failures expose only actionable categories",async()=>{
  const providers=["HTTP 401","HTTP 429","private detail"].map((error,index)=>({
    providerId:String(index),status:"error",error,windows:[],balances:[],
  }));
  const data=await readAccountUsage({providers:{listUsage:async()=>({providers})}} as never);
  expect(data.map(r=>r.issue)).toEqual(["login","rate-limit",undefined]);
  expect(JSON.stringify(data)).not.toContain("private detail");
});
