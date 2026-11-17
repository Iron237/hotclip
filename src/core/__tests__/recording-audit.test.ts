import { describe,it,expect } from "vitest";
import { applyAuditCorrections,validateAuditScan,auditBounds,type AuditLine,type AuditCandidate } from "../recording-audit";
const lines:AuditLine[]=[{id:"s0",startSec:1,endSec:3,raw:"念了给你上剑",text:"念了给你上剑",uncertain:false,correctionReason:""},{id:"s1",startSec:4,endSec:6,raw:"不用上舰",text:"不用上舰",uncertain:false,correctionReason:""},{id:"s2",startSec:6.2,endSec:8,raw:"回游戏了",text:"回游戏了",uncertain:false,correctionReason:""}];
const candidate:AuditCandidate={title:"回应上舰",firstId:"s0",lastId:"s1",why:"请求与回应",kind:"聊天互动",score:4,evidenceIds:["s0","s1"],notes:[]};
describe("full recording audit",()=>{
 it("preserves all unmodified speech and timing when applying sparse corrections",()=>{
  const result=applyAuditCorrections({patches:[{id:"s0",before:lines[0].text,after:"念了给你上舰",reason:"订阅语境"}],uncertainIds:["s2"]},lines);
  expect(result).toHaveLength(3);expect(result[0].raw).toBe(lines[0].raw);expect(result[0].text).toBe("念了给你上舰");expect(result[0].startSec).toBe(1);expect(result[1]).toEqual(lines[1]);expect(result[2].uncertain).toBe(true);
 });
 it("rejects edits to absent lines or a fabricated before-text",()=>{
  expect(()=>applyAuditCorrections({patches:[{id:"s0",before:"伪造",after:"上舰",reason:""}],uncertainIds:[]},lines)).toThrow();
  expect(()=>applyAuditCorrections({patches:[],uncertainIds:["missing"]},lines)).toThrow();
 });
 it("requires full scan coverage and evidence inside each candidate",()=>{
  const section={firstId:"s0",lastId:"s2",kind:"mixed",title:"互动与游戏",summary:"概览"};
  expect(validateAuditScan({overview:"概览",sections:[section],candidates:[candidate]},lines,lines).candidates).toHaveLength(1);
  expect(()=>validateAuditScan({overview:"",sections:[{...section,lastId:"s1"}],candidates:[]},lines,lines)).toThrow("coverage");
  expect(()=>auditBounds({...candidate,evidenceIds:["s2"]},lines,10)).toThrow("evidence");
 });
 it("preserves the natural gap without padding into the next game topic",()=>{
  const bounds=auditBounds(candidate,lines,10);expect(bounds.endSec).toBeCloseTo(6.1);expect(bounds.boundaryReview).toBe(true);expect(bounds.endSec).toBeLessThan(lines[2].startSec);
 });
});
