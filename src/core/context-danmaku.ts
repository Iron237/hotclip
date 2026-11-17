import { createHash } from "crypto";
import { readFile,stat } from "fs/promises";
import { extname,isAbsolute } from "path";
import { danmakuPathFor } from "./danmaku";
import type { ChatEvent,RecordingBackground } from "./recording-context-types";

const MAX_BYTES=32*1024*1024;
export function decodeXmlText(s:string):string {
  return s.replace(/<[^>]*>/g,"").replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_all,entity:string)=>{
    if(entity[0]==="#") {const n=entity[1].toLowerCase()==="x"?parseInt(entity.slice(2),16):Number(entity.slice(1));return n>0&&n<=0x10ffff?String.fromCodePoint(n):"";}
    return ({amp:"&",lt:"<",gt:">",quot:'"',apos:"'"} as Record<string,string>)[entity.toLowerCase()];
  }).trim();
}
function attrs(s:string):Record<string,string> {
  return Object.fromEntries([...s.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m=>[m[1],decodeXmlText(m[2]??m[3])]));
}
export interface ParsedChat {items:Array<{t:number;kind:ChatEvent["kind"];text:string;uid:string|null;ref:string}>;background:RecordingBackground;recordingStartTime:string|null;invalid:number}
export function parseContextChat(text:string,format:"xml"|"jsonl"):ParsedChat {
  const result:ParsedChat={items:[],background:{},recordingStartTime:null,invalid:0};
  const add=(time:unknown,kind:ChatEvent["kind"],body:string,uid:string|null,ref:string)=>{
    const t=typeof time==="number"?time:typeof time==="string"&&time.trim()?Number(time):NaN;
    if(!Number.isFinite(t)||t<0||t>48*3600||!body.trim()) {result.invalid++;return;}
    result.items.push({t,kind,text:body,uid,ref});
  };
  if(format==="xml") {
    const meta=text.match(/<BililiveRecorderRecordInfo\b([^>]*)>/);
    if(meta){const a=attrs(meta[1]);result.background={streamerName:a.name,roomId:a.roomid,title:a.title};result.recordingStartTime=a.start_time||null;}
    let row=0;
    for(const m of text.matchAll(/<d\b([^>]*)>([\s\S]*?)<\/d>/g)) {
      const p=(attrs(m[1]).p??"").split(",");
      add(p[0],"chat",decodeXmlText(m[2]),p[6]&&p[6]!=="0"?p[6]:null,`xml:d:${++row}`);
    }
    for(const m of text.matchAll(/<(sc|gift|guard)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g)) {
      const a=attrs(m[2]);add(a.ts,m[1] as ChatEvent["kind"],decodeXmlText(m[3]??"")||a.giftname||m[1],a.uid||a.user||null,`xml:${m[1]}:${++row}`);
    }
  } else {
    const types:Record<string,ChatEvent["kind"]>={chat:"chat",sc:"sc",gift:"gift",guard:"guard",social:"follow",like:"like"};
    for(const [i,line] of text.replace(/^\ufeff/,"").split(/\r?\n/).entries()) {
      if(!line.trim())continue;
      try {
        const m=JSON.parse(line);if(!m||typeof m!=="object"||!types[m.type])continue;
        add(m.recvTimeSec??m.timestamp??m._time,types[m.type],String(m.content??m.giftName??m.type),m.userId==null?null:String(m.userId),`jsonl:${i+1}`);
      }catch{result.invalid++;}
    }
  }
  result.items.sort((a,b)=>a.t-b.t);return result;
}
export function normalizeChat(parsed:ParsedChat,duration:number,offset:number,scale:number,scope:string) {
  if(!Number.isFinite(offset)||Math.abs(offset)>48*3600||!Number.isFinite(scale)||scale<.9||scale>1.1)throw new Error("context:invalid-chat-clock");
  let outside=0;
  const events:ChatEvent[]=[];
  for(const [i,item] of parsed.items.entries()) {
    const t=item.t*scale+offset;
    if(t<0||t>duration){outside++;continue;}
    events.push({id:`d${String(i).padStart(6,"0")}`,kind:item.kind,startSec:t,endSec:t,sourceTimeSec:item.t,text:item.text,
      sender:item.uid?"viewer_"+createHash("sha256").update(scope+":"+item.uid).digest("hex").slice(0,12):null,evidenceRefs:[item.ref]});
  }
  return {events,outside};
}
export async function loadContextChat(videoPath:string,explicit:string|undefined,duration:number,offset:number,scale:number,scope:string) {
  if(explicit&&!isAbsolute(explicit))throw new Error("context:chat-path-must-be-absolute");
  let path=explicit;
  if(!path)for(const candidate of [danmakuPathFor(videoPath),danmakuPathFor(videoPath).replace(/\.xml$/, ".jsonl")]) if(await stat(candidate).catch(()=>null)){path=candidate;break;}
  if(!path)return {path:null,fileIdentity:null,events:[] as ChatEvent[],background:{} as RecordingBackground,recordingStartTime:null,warnings:["未找到同名弹幕文件 互动来源可能缺失"]};
  const info=await stat(path);if(!info.isFile()||info.size>MAX_BYTES)throw new Error("context:chat-file-limit-32MiB");
  const format=extname(path).slice(1).toLowerCase();if(format!=="xml"&&format!=="jsonl")throw new Error("context:chat-format-xml-or-jsonl");
  const text=await readFile(path,"utf8");if(Buffer.byteLength(text,"utf8")>MAX_BYTES)throw new Error("context:chat-file-grew-over-limit");
  const parsed=parseContextChat(text,format),normalized=normalizeChat(parsed,duration,offset,scale,scope);
  return {path,fileIdentity:{size:info.size,mtimeMs:info.mtimeMs,sha256:createHash("sha256").update(text).digest("hex")},events:normalized.events,background:parsed.background,recordingStartTime:parsed.recordingStartTime,
    warnings:[...(parsed.invalid?[`${parsed.invalid} 条弹幕无法解析或缺少可靠的相对时间`]:[]),...(normalized.outside?[`${normalized.outside} 条弹幕在时钟映射后超出当前视频范围`]:[])]};
}

export function textSimilarity(a:string,b:string):number {
  const clean=(s:string)=>s.toLowerCase().replace(/[^\p{L}\p{N}]/gu,"");a=clean(a);b=clean(b);
  if(Math.min(a.length,b.length)<4)return 0;
  if(a.includes(b)||b.includes(a))return 1;
  const grams=(s:string)=>new Set(Array.from({length:s.length-1},(_,i)=>s.slice(i,i+2)));
  const x=grams(a),y=grams(b);return 2*[...x].filter(g=>y.has(g)).length/(x.size+y.size);
}
