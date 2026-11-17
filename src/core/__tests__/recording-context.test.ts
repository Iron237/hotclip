import { describe,expect,it } from "vitest";
import { parseContextChat,normalizeChat,textSimilarity } from "../context-danmaku";
import { selectChatEvidence,validateStructure,applyStructure,type StructureAnalysis } from "../context-understanding";
import { makeContextPacket } from "../context-packets";
import { validateInterests } from "../context-interests";
import { validateBackground } from "../structure-recording";
import type { ChatEvent,UtteranceEvent,RecordingContext,ContextSession } from "../recording-context-types";

function u(id:string,time:number,text:string):UtteranceEvent{return {id,kind:"utterance",startSec:time,endSec:time+3,text,textRaw:text,textLexicon:text,subtitleText:text,firstWord:0,lastWord:1,audioOrigin:"mixed-or-unknown",speaker:{id:null,role:"unknown",cluster:20,confidence:"low",basis:"unknown"},activity:"unknown",addressee:"unknown",topic:"",uncertain:false,evidenceRefs:["asr:0-1"]};}
function d(id:string,time:number,text:string):ChatEvent{return {id,kind:"chat",startSec:time,endSec:time,sourceTimeSec:time,text,sender:"anon",evidenceRefs:["xml:d:1"]};}
const session:ContextSession={schemaVersion:"hotclip-context-v1",id:"s",background:{gameName:"终末地"},backgroundEvidence:[],source:{path:"/test.mp4",size:1,mtimeMs:1,durationSec:300,recordingStartTime:null},clock:{unit:"seconds",origin:"source-media-start",chatOffsetSec:0,chatScale:1,alignment:"sidecar-relative-unverified"},models:{subtitle:"gpt-6.1-terra",visual:"gpt-6.1-sol",reasoningEffort:"high"},warnings:[]};
function analysis():StructureAnalysis{return {annotations:[{eventId:"u1",role:"host",activity:"read_chat",addressee:"audience",topic:"哥哥请求",confidence:"medium",reason:"主播读请求"}],relations:[{from:"u1",to:"d1",type:"reads",confidence:"high",reason:"文本对应"}],episodes:[{title:"哥哥请求",kind:"audience-interaction",state:"open",eventIds:["u1"],summary:"观众请求主播回应",openQuestions:["会如何回应"],resolutionEventId:null,continuationOf:null}]};}
describe("recording context ingestion",()=>{
  it("preserves recorder metadata, unicode entities and event types",()=>{
    const xml='<i><BililiveRecorderRecordInfo roomid="20602" name="主播A" title="终末地" start_time="2026-11-17T01:40:00+08:00"/><d p="2.5,1,25,0,0,0,private_uid">哥&#x54E5;&amp;姐姐</d><sc ts="3" uid="paid_uid">请求</sc><gift ts="4" giftname="礼物"/><guard uid="bad"/></i>';
    const parsed=parseContextChat(xml,"xml");
    expect(parsed.background.streamerName).toBe("主播A");expect(parsed.recordingStartTime).toContain("+08:00");
    expect(parsed.items.map(i=>i.kind)).toEqual(["chat","sc","gift"]);expect(parsed.items[0].text).toBe("哥哥&姐姐");expect(parsed.invalid).toBe(1);
    const mapped=normalizeChat(parsed,10,1,1,"scope");expect(mapped.events[0].startSec).toBe(3.5);expect(mapped.events[0].sourceTimeSec).toBe(2.5);
    expect(JSON.stringify(mapped.events)).not.toContain("private_uid");expect(mapped.events[0].sender).toMatch(/^viewer_/);
  });
  it("rejects epoch timestamps instead of silently placing them at video zero",()=>{
    const parsed=parseContextChat('{"type":"chat","timestamp":1790000000,"content":"hello"}\n{"type":"chat","recvTimeSec":4,"content":"valid"}\n{broken',"jsonl");
    expect(parsed.items).toHaveLength(1);expect(parsed.invalid).toBe(2);
    expect(normalizeChat(parsed,3,0,1,"s").outside).toBe(1);
    expect(()=>normalizeChat(parsed,100,0,10,"s")).toThrow("clock");
  });
  it("does not infer an unknown game/streamer biography from arbitrary fields",()=>{
    expect(validateBackground({gameName:"终末地"})).toEqual({gameName:"终末地"});
    expect(()=>validateBackground({secret:"bad"})).toThrow();expect(()=>validateBackground({notes:4})).toThrow();
  });
});
describe("evidence grounded interaction structure",()=>{
  it("rejects the later similar request instead of attaching it to an earlier reading",()=>{
    const core=[u("u1",159,"能不能念一句哥哥给大家听听")],future=d("d1",201,"能不能念一句哥哥给大家听听");
    expect(()=>validateStructure(analysis(),core,[future],[])).toThrow("future");
  });
  it("requires exact core coverage and real event ids",()=>{
    const core=[u("u1",159,"请求")],chat=d("d1",150,"请求");
    const missing=analysis();missing.episodes=[];expect(()=>validateStructure(missing,core,[chat],[])).toThrow("missing-episode");
    const wrong=analysis();wrong.relations[0].to="invented";expect(()=>validateStructure(wrong,core,[chat],[])).toThrow("reference");
    const closed=analysis();closed.episodes[0].state="resolved";expect(()=>validateStructure(closed,core,[chat],[])).toThrow("without-evidence");
  });
  it("keeps game-reading activity distinct from actual speaker and audio origin",()=>{
    const core=[u("u1",159,"游戏台词")],a=analysis();a.annotations[0].activity="read_game_text";a.relations=[];
    const episodes:RecordingContext["episodes"]=[],relations:RecordingContext["relations"]=[];
    applyStructure(validateStructure(a,core,[],[]),core,[],episodes,relations,0);
    expect(core[0].speaker.role).toBe("host");expect(core[0].activity).toBe("read_game_text");expect(core[0].audioOrigin).toBe("mixed-or-unknown");
  });
  it("supports text-matched reads but keeps semantic-only replies as candidates",()=>{
    const core=[u("u1",159,"能不能念一句哥哥给大家听听")],chat=d("d1",150,"能不能念一句哥哥给大家听听");
    const episodes:RecordingContext["episodes"]=[],relations:RecordingContext["relations"]=[],a=analysis();
    applyStructure(a,core,[chat],episodes,relations,0);expect(relations[0].status).toBe("supported");
    a.relations[0].type="replies_to";applyStructure(a,core,[chat],episodes,relations,1);expect(relations[1].status).toBe("candidate");expect(relations[1].confidence).toBe("medium");
  });
  it("keeps a matching older question when large chat bursts require sampling",()=>{
    const core=[u("u1",100,"请认真念一句哥哥给大家听听")];
    const chat=Array.from({length:300},(_,i)=>d(`d${i}`,20+i*.3,`哈哈${i}`));chat[0]=d("match",30,core[0].text);
    const selected=selectChatEvidence(core,chat,20);expect(selected.events.length).toBeLessThanOrEqual(20);expect(selected.events.some(e=>e.id==="match")).toBe(true);expect(selected.omitted).toBeGreaterThan(0);
    expect(textSimilarity("哥哥","哥哥")).toBe(0);
  });
  it("retrieves an older paid request that the host reads several minutes later",()=>{
    const core=[u("u1",500,"请认真念一句哥哥给大家听听")],sc={...d("paid",50,core[0].text),kind:"sc" as const};
    expect(selectChatEvidence(core,[sc]).events.map(e=>e.id)).toEqual(["paid"]);
  });
});
describe("bounded context access",()=>{
  const recording:RecordingContext={session,events:[d("d1",150,"能不能念哥哥"),u("u1",159,"能不能念哥哥"),u("u2",170,"回应")],relations:[{id:"r1",from:"u1",to:"d1",type:"reads",confidence:"medium",status:"supported",reason:"quote"}],episodes:[],interests:[]};
  it("returns linked evidence even when outside the primary time/page range",()=>{
    const page=makeContextPacket(recording,{startSec:158,endSec:180,limit:1});
    expect(page.events[0].id).toBe("u1");expect(page.relatedEvents[0].id).toBe("d1");expect(page.nextOffset).toBe(1);
    expect(makeContextPacket(recording,{eventIds:["d1"]}).events.map(e=>e.id)).toEqual(["d1"]);
    expect(()=>makeContextPacket(recording,{eventIds:["fake"]})).toThrow();
  });
  it("refuses an interest candidate with invented payoff evidence",()=>{
    const r={...recording,episodes:[{id:"ep1",title:"聊天",kind:"smalltalk" as const,state:"resolved" as const,eventIds:["u1","u2"],relationIds:[],startSec:159,endSec:173,summary:"回应",openQuestions:[],resolutionEventId:"u2",evidenceRefs:["u2"]}]};
    expect(()=>validateInterests({interests:[{episodeId:"ep1",kind:"question-answer",whyInteresting:"互动",setupEventIds:["u1"],triggerEventIds:["d1"],payoffEventIds:["invented"],requiredContextEventIds:[],resolutionEventId:"u2",interestLevel:"high",evidenceConfidence:"medium",reviewNeeded:[]}]},r,new Set(["ep1"]))).toThrow("evidence");
  });
  it("queries an episode without mixing unrelated simultaneous game speech into its primary events",()=>{
    const r={...recording,events:[...recording.events,u("game",160,"游戏剧情")],episodes:[{id:"ep1",title:"聊天",kind:"smalltalk" as const,state:"resolved" as const,eventIds:["u1","u2"],relationIds:["r1"],startSec:159,endSec:173,summary:"回应",openQuestions:[],resolutionEventId:"u2",evidenceRefs:["u2"]}]};
    const page=makeContextPacket(r,{episodeId:"ep1"});
    expect(page.events.map(e=>e.id)).toEqual(["u1","u2"]);expect(page.relatedEvents.map(e=>e.id)).toEqual(["d1"]);
  });
});
