import { readFile, writeFile, rename, mkdir } from "fs/promises";
import { createHash } from "crypto";
import { join } from "path";
import { codexReview } from "./codex-review";
import { CHAT_MODELS } from "./chat-review";

export async function optionalJson<T>(file:string):Promise<T|undefined> {
  try { return JSON.parse(await readFile(file,"utf8")) as T; }
  catch(error) { if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error; }
}
/** Content-addressed model results: changed prompts, schema, model or images invalidate reuse. */
export function checkpointReviewer(root:string):typeof codexReview {
  return async (prompt,schema,kind="subtitle",images=[],signal)=>{
    const imageHashes=await Promise.all(images.map(async p=>createHash("sha256").update(await readFile(p)).digest("hex")));
    const key=createHash("sha256").update(JSON.stringify([prompt,schema,CHAT_MODELS[kind],"high",imageHashes])).digest("hex");
    const dir=join(root,"model-cache"),file=join(dir,`${key}.json`);
    const previous=await optionalJson<{result:unknown}>(file);
    if(previous)return previous.result;
    const result=await codexReview(prompt,schema,kind,images,signal);
    await mkdir(dir,{recursive:true});
    await writeFile(`${file}.tmp`,JSON.stringify({result}),"utf8");await rename(`${file}.tmp`,file);
    return result;
  };
}
