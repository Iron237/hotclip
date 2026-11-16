import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { ensureModel, SEGMENTATION_MODEL, SPEAKER_EMBEDDING_MODEL } from "./models";
import { runDiarization, type SpeakerTurn } from "./diarize";
import { resolveFfmpegPath } from "./binaries";
const execFileAsync=promisify(execFile);

/** Bounded audio windows. IDs are scoped to a window, NOT persistent identities. */
export async function chatSpeakerTurns(video:string,duration:number,modelsRoot:string,signal?:AbortSignal):Promise<SpeakerTurn[]> {
  await ensureModel(modelsRoot,SEGMENTATION_MODEL,undefined,signal);
  await ensureModel(modelsRoot,SPEAKER_EMBEDDING_MODEL,undefined,signal);
  const temp=await mkdtemp(join(tmpdir(),"hotclip-speakers-"));
  const turns:SpeakerTurn[]=[];
  try {
    for(let start=0,batch=0;start<duration;start+=300,batch++) {
      signal?.throwIfAborted();
      const wav=join(temp,`${batch}.wav`);
      await execFileAsync(resolveFfmpegPath(),["-nostdin","-hide_banner","-loglevel","error","-ss",String(start),"-t",String(Math.min(300,duration-start)),"-i",video,"-vn","-ac","1","-ar","16000","-y",wav],{windowsHide:true,signal});
      const local=await runDiarization(wav,modelsRoot,{signal});
      if(local.some(t=>t.speaker>=1000||t.speaker<0||t.startSec<0||t.endSec>Math.min(300,duration-start)+.1)) throw new Error("chat-speakers:invalid-output");
      turns.push(...local.map(t=>({...t,startSec:t.startSec+start,endSec:t.endSec+start,speaker:batch*1000+t.speaker})));
      await rm(wav,{force:true});
    }
  } finally { await rm(temp,{recursive:true,force:true}); }
  return turns;
}
