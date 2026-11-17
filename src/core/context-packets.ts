import { readFile,stat } from "fs/promises";
import { join,isAbsolute } from "path";
import type { ContextEvent,RecordingContext } from "./recording-context-types";

export interface ContextQuery {startSec?:number;endSec?:number;episodeId?:string;eventIds?:string[];offset?:number;limit?:number}
export function makeContextPacket(recording:RecordingContext,query:ContextQuery={}) {
  const {session,events,episodes,relations,interests}=recording;
  const episode=query.episodeId?episodes.find(e=>e.id===query.episodeId):undefined;
  if(query.episodeId&&!episode)throw new Error("context:unknown-episode");
  if(query.eventIds!==undefined&&(!Array.isArray(query.eventIds)||!query.eventIds.length||query.eventIds.length>50||query.eventIds.some(id=>typeof id!=="string"||!events.some(e=>e.id===id))))throw new Error("context:unknown-event-id");
  const requested=query.eventIds?events.filter(e=>query.eventIds!.includes(e.id)):undefined;
  const start=query.startSec??episode?.startSec??(requested?Math.min(...requested.map(e=>e.startSec)):0),end=query.endSec??episode?.endSec??(requested?Math.max(...requested.map(e=>e.endSec)):Math.min(session.source.durationSec,start+120));
  const offset=query.offset??0,limit=query.limit??60;
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<start||end>session.source.durationSec+.1||!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw new Error("context:invalid-packet-range");
  const found=requested??events.filter(e=>(!episode||episode.eventIds.includes(e.id))&&e.endSec>=start&&e.startSec<=end);
  const selected=found.slice(offset,offset+limit),ids=new Set(selected.map(e=>e.id));
  const matchingRelations=relations.filter(r=>ids.has(r.from)||ids.has(r.to));
  const linked=matchingRelations.slice(0,200);
  const refIds=new Set(linked.flatMap(r=>[r.from,r.to]).filter(id=>!ids.has(id)));
  const relatedEvents=events.filter(e=>refIds.has(e.id)).slice(0,50);
  const active=episodes.filter(e=>e.endSec>=start&&e.startSec<=end);
  return {schemaVersion:session.schemaVersion,sessionId:session.id,background:session.background,backgroundEvidence:session.backgroundEvidence,clock:session.clock,
    range:{startSec:start,endSec:end},totalEvents:found.length,offset,nextOffset:offset+selected.length<found.length?offset+selected.length:null,
    events:selected,relations:linked,omittedRelations:matchingRelations.length-linked.length,relatedEvents,omittedRelatedEvents:Math.max(0,refIds.size-relatedEvents.length),
    episodes:active.slice(0,30).map(e=>({...e,eventIds:e.eventIds.filter(id=>ids.has(id)).concat(e.eventIds.filter(id=>!ids.has(id))).slice(0,100),totalEventRefs:e.eventIds.length,omittedEventRefs:Math.max(0,e.eventIds.length-100),evidenceRefs:e.evidenceRefs.slice(0,100),relationIds:e.relationIds.slice(0,100),summary:e.summary.slice(-2000)})),omittedEpisodes:Math.max(0,active.length-30),interests:interests.filter(i=>active.some(e=>e.id===i.episodeId)).slice(0,20),warnings:session.warnings};
}
export function compactEvent(e:ContextEvent):string {
  const t=`${e.startSec.toFixed(2)}–${e.endSec.toFixed(2)}`;
  if(e.kind==="utterance")return `[${e.id} ${t}] ${e.speaker.role} / ${e.activity}：${e.text}`;
  if(e.kind==="screen")return `[${e.id} ${t}] 画面观察 ${e.mode}：${e.description} ${e.visibleText}`;
  return `[${e.id} ${t}] ${e.kind}：${e.text}`;
}
export function contextMarkdown(recording:RecordingContext):string {
  const {session,episodes,events,relations,interests}=recording;
  const lines=["# 录播结构化上下文","",`字幕模型：${session.models.subtitle}；主分析：${session.models.analysis??session.models.subtitle} / ${session.models.reasoningEffort}`,"",
    `背景：${JSON.stringify(session.background)}`,`时钟：${JSON.stringify(session.clock)}`,"",
    "说明：游戏画面与主播互动可以同时发生；声音簇不是角色身份；candidate 关系尚未核实。","",
    ...session.warnings.map(w=>`- 注意：${w}`),"","## 话题与互动"];
  const map=new Map(events.map(e=>[e.id,e]));
  for(const episode of episodes) {
    lines.push("",`### ${episode.id} ${episode.title}`,`${episode.startSec.toFixed(2)}–${episode.endSec.toFixed(2)} 秒 · ${episode.kind} · ${episode.state}`,episode.summary,"");
    for(const id of episode.eventIds){const e=map.get(id);if(e)lines.push(compactEvent(e));
      for(const r of relations.filter(r=>r.from===id)){const target=map.get(r.to);lines.push(`  → ${r.type} ${r.to} [${r.status}/${r.confidence}] ${r.reason}`);if(target)lines.push(`    ${compactEvent(target)}`);}}
    if(episode.openQuestions.length)lines.push(`未解问题：${episode.openQuestions.join("；")}`);
  }
  lines.push("","## 兴趣点候选");
  for(const i of interests)lines.push(`- ${i.id} → ${i.episodeId}：${i.whyInteresting}；依据 ${i.setupEventIds.concat(i.payoffEventIds).join(", ")}；待核 ${i.reviewNeeded.join("；")||"无额外标记（不代表人工听校）"}`);
  return lines.join("\n")+"\n";
}
export async function readRecordingContext(dir:string,query:ContextQuery={}) {
  if(!isAbsolute(dir))throw new Error("context:absolute-directory-required");
  const file=join(dir,"recording-context.json"),info=await stat(file);
  if(!info.isFile()||info.size>128*1024*1024)throw new Error("context:context-file-too-large");
  const value=JSON.parse(await readFile(file,"utf8")) as RecordingContext;
  if(value?.session?.schemaVersion!=="hotclip-context-v1"||!Array.isArray(value.events)||!Array.isArray(value.episodes)||!Array.isArray(value.relations)||!Array.isArray(value.interests))throw new Error("context:incompatible-context-file");
  return makeContextPacket(value,query);
}
