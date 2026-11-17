import { readFile,writeFile,readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveFfmpegPath } from "../src/core/binaries";
const root=process.argv[2],index=Number(process.argv[3]);
const source=JSON.parse(await readFile(join(root,"source.json"),"utf8"));
const pcm=join(root,`inspect-window-${index}.f32le`);
await promisify(execFile)(resolveFfmpegPath(),["-nostdin","-hide_banner","-loglevel","error","-ss",String(index*28),"-i",source.videoPath,"-t","28","-vn","-ac","1","-ar","16000","-f","f32le","-y",pcm],{windowsHide:true});
const data=await readFile(pcm);
const response=await fetch("http://127.0.0.1:8766/transcribe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pcm:data.toString("base64"),sampleRate:16000,language:"zh"})});
const result:any=await response.json();await writeFile(join(root,`inspect-window-${index}.json`),JSON.stringify(result,null,2),"utf8");
let end=0;const errors=[];
for(const w of result.words??[]){if(w.start<end-.025||w.start<0||w.end<w.start||w.end>28.1)errors.push({word:w,previousEnd:end});end=w.end;}
console.log(JSON.stringify({index,text:result.text,errors,last:result.words?.at(-1)},null,2));
