import { readFile,mkdir,writeFile,stat } from "node:fs/promises";
import { join } from "node:path";
import { QwenLocalEngine } from "../src/core/transcribe/qwen-local";
import { probeMedia } from "../src/core/probe";
const args=JSON.parse((await readFile(process.argv[2],"utf8")).replace(/^\ufeff/,""));
await mkdir(args.outDir,{recursive:true});
const save=(name:string,v:unknown)=>writeFile(join(args.outDir,name),JSON.stringify(v,null,2),"utf8");
const info=await stat(args.videoPath);
if(args.expectedBytes&&info.size!==args.expectedBytes)throw new Error("source copy incomplete");
await save("source.json",{videoPath:args.videoPath,size:info.size,mtimeMs:info.mtimeMs,media:await probeMedia(args.videoPath)});
let latest=0;
try {
 const result=await new QwenLocalEngine().transcribe(args.videoPath,{language:"zh",cacheDir:join(args.outDir,"asr-cache"),onProgress:p=>{
   if((p.completedWindows??0)>=latest+10||p.fraction===1||p.stage!=="transcribing"){
     latest=p.completedWindows??0;console.error(JSON.stringify(p));
     void save("asr-progress.json",{...p,updatedAt:new Date().toISOString()});
   }
 }});
 await save("asr-raw.json",result);console.log(JSON.stringify({outDir:args.outDir,durationSec:result.durationSec,segments:result.segments.length}));
}catch(error){await save("asr-error.json",{error:String(error),at:new Date().toISOString()});throw error;}
