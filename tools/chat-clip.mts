import { readFile } from "fs/promises";
import { resolve } from "path";
import { clipChatVideo } from "../src/core/chat-clip";
import { modelsRoot, cacheDir, renderCacheDir, evidenceCacheDir } from "../src/core/appenv";
const args=JSON.parse(await readFile(process.argv[2],"utf8"));
const result=await clipChatVideo(args.videoPath,{...args,modelsRoot:modelsRoot(),cacheDir:cacheDir(),renderCacheDir:renderCacheDir(),evidenceCacheDir:evidenceCacheDir(),fontsDir:resolve(import.meta.dirname,"../resources/fonts")});
console.log(JSON.stringify(result,null,2));
