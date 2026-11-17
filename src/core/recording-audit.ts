import { withoutPunctuation } from "./chat-review";

export interface AuditLine { id:string; startSec:number; endSec:number; raw:string; text:string; uncertain:boolean; correctionReason:string }
export interface AuditMarker { id:string;time:string;sec:number;label:string }
export interface AuditCandidate { title:string;firstId:string;lastId:string;why:string;kind:string;score:number;evidenceIds:string[];notes:string[] }
const str={type:"string"},strings={type:"array",items:str};
export const auditObject=(properties:Record<string,unknown>)=>({type:"object",additionalProperties:false,properties,required:Object.keys(properties)});
export const AUDIT_CORRECTION_SCHEMA=auditObject({patches:{type:"array",items:auditObject({id:str,before:str,after:str,reason:str})},uncertainIds:strings});
export function applyAuditCorrections(value:unknown,core:AuditLine[]):AuditLine[] {
  const v=value as {patches:Array<{id:string;before:string;after:string;reason:string}>;uncertainIds:string[]};
  if(!v||!Array.isArray(v.patches)||!Array.isArray(v.uncertainIds))throw new Error("audit:invalid-corrections");
  const map=new Map(core.map(s=>[s.id,s])),seen=new Set<string>();
  if(v.uncertainIds.some(id=>!map.has(id)))throw new Error("audit:unknown-uncertain-id");
  const patches=new Map<string,typeof v.patches[number]>();
  for(const p of v.patches){
    const original=map.get(p.id);
    if(!original||seen.has(p.id)||p.before!==original.text||typeof p.after!=="string"||!p.after.trim()||p.after.length>1200||typeof p.reason!=="string"||p.reason.length>1200)throw new Error("audit:invalid-patch");
    const before=withoutPunctuation(p.before),after=withoutPunctuation(p.after);
    if(Math.abs(before.length-after.length)>Math.max(4,before.length*.25))throw new Error("audit:excessive-rewrite");
    seen.add(p.id);patches.set(p.id,p);
  }
  return core.map(s=>({...s,text:patches.get(s.id)?.after??s.text,correctionReason:patches.get(s.id)?.reason??s.correctionReason,uncertain:v.uncertainIds.includes(s.id)}));
}
export const AUDIT_CANDIDATE_PROPS={title:str,firstId:str,lastId:str,why:str,kind:{type:"string",enum:["聊天互动","笑点反差","幕后往事","游戏反应","视觉名场面","其他"]},score:{type:"integer",minimum:1,maximum:5},evidenceIds:strings,notes:strings};
export const AUDIT_SCAN_SCHEMA=auditObject({overview:str,sections:{type:"array",items:auditObject({firstId:str,lastId:str,kind:{type:"string",enum:["host","game","mixed","unknown","music"]},title:str,summary:str})},candidates:{type:"array",items:auditObject(AUDIT_CANDIDATE_PROPS)}});
export function validateAuditCandidate(c:AuditCandidate,lines:AuditLine[]) {
  const first=lines.findIndex(s=>s.id===c.firstId),last=lines.findIndex(s=>s.id===c.lastId);
  if(first<0||last<first||lines[last].endSec-lines[first].startSec>1200||typeof c.title!=="string"||!c.title.trim()||c.title.length>150||typeof c.why!=="string"||c.why.length>2500||!Number.isInteger(c.score)||c.score<1||c.score>5||!["聊天互动","笑点反差","幕后往事","游戏反应","视觉名场面","其他"].includes(c.kind)||!Array.isArray(c.evidenceIds)||c.evidenceIds.length>200||!c.evidenceIds.length||c.evidenceIds.some(id=>!lines.slice(first,last+1).some(s=>s.id===id))||!Array.isArray(c.notes)||c.notes.some(n=>typeof n!=="string"||n.length>1500))throw new Error("audit:invalid-candidate-evidence");
  return {first,last};
}
export function validateAuditScan(value:unknown,core:AuditLine[],context:AuditLine[]) {
  const v=value as {overview:string;sections:Array<{firstId:string;lastId:string;kind:string;title:string;summary:string}>;candidates:AuditCandidate[]};
  if(!v||typeof v.overview!=="string"||!Array.isArray(v.sections)||!Array.isArray(v.candidates)||v.candidates.length>5)throw new Error("audit:invalid-scan");
  let cursor=0;
  for(const section of v.sections){
    const last=core.findIndex(s=>s.id===section.lastId);
    if(section.firstId!==core[cursor]?.id||last<cursor||!["host","game","mixed","unknown","music"].includes(section.kind)||typeof section.summary!=="string"||typeof section.title!=="string")throw new Error("audit:section-coverage");
    cursor=last+1;
  }
  if(cursor!==core.length)throw new Error("audit:missing-coverage");
  for(const c of v.candidates)validateAuditCandidate(c,context);
  return v;
}
export function auditBounds(c:AuditCandidate,lines:AuditLine[],duration:number) {
  const {first,last}=validateAuditCandidate(c,lines),a=lines[first],b=lines[last];
  const before=lines[first-1]?.endSec??0,after=lines[last+1]?.startSec??duration;
  const lead=Math.min(.8,Math.max(0,(a.startSec-before)/2)),tail=Math.min(1.2,Math.max(0,(after-b.endSec)/2));
  return {startSec:Math.max(0,a.startSec-lead),endSec:Math.min(duration,b.endSec+tail),leadSec:lead,tailSec:tail,
    boundaryReview:lead<.15||tail<.25,uncertainIds:lines.slice(first,last+1).filter(s=>s.uncertain).map(s=>s.id)};
}
