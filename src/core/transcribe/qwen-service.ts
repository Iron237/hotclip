import { spawn } from "child_process";
import { readFile, open, mkdir, stat } from "fs/promises";
import { join, isAbsolute } from "path";
import { homedir } from "os";

let startup: Promise<void> | undefined;
/** Optional local installation descriptor, never downloaded or guessed. */
export async function ensureConfiguredQwenService(url: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const u=new URL(url);
  if(u.hostname!=="127.0.0.1"||u.port!=="8766") return;
  if(startup) return startup;
  startup=(async()=>{
    const dir=process.platform==="win32"?join(process.env.APPDATA??join(homedir(),"AppData","Roaming"),"hotclip"):join(process.env.XDG_CONFIG_HOME??join(homedir(),".config"),"hotclip");
    const config=await readFile(join(dir,"qwen-service.json"),"utf8").then(JSON.parse).catch(()=>null) as null|{python:string;script:string;modelPath:string;alignerPath:string;device:string};
    if(!config) return;
    if(!["cpu","mps","cuda:0"].includes(config.device)) throw new Error("qwen:invalid-service-config");
    for(const p of [config.python,config.script,config.modelPath,config.alignerPath]) if(typeof p!=="string"||!isAbsolute(p)||!await stat(p).catch(()=>null)) throw new Error("qwen:invalid-local-installation");
    // A second process might have started it while the descriptor was read.
    if(await fetch(url+"/health",{signal:AbortSignal.timeout(1000)}).then(r=>r.ok,()=>false)) return;
    await mkdir(dir,{recursive:true});
    const log=await open(join(dir,"qwen-service.log"),"a");
    let failure:Error|undefined;
    try {
      const child=spawn(config.python,["-u",config.script,"--model","1.7B","--device",config.device,"--model-path",config.modelPath,"--aligner-path",config.alignerPath],{detached:true,windowsHide:true,stdio:["ignore",log.fd,log.fd]});
      child.once("error",e=>{failure=e;});
      child.once("exit",code=>{if(code!==0) failure=new Error(`qwen:service-exited-${code}`);});
      child.unref();
    } finally { await log.close(); }
    for(let attempt=0;attempt<180;attempt++) {
      signal?.throwIfAborted();
      if(failure) throw failure;
      if(await fetch(url+"/health",{signal:AbortSignal.timeout(1000)}).then(r=>r.ok,()=>false)) return;
      await new Promise(r=>setTimeout(r,1000));
    }
    throw new Error("qwen:service-start-timeout");
  })();
  try { await startup; } finally { startup=undefined; }
}
