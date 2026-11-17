import { readFile } from "node:fs/promises";
import { structureRecording } from "../src/core/structure-recording";
import { modelsRoot,cacheDir } from "../src/core/appenv";
if(!process.argv[2])throw new Error("Usage: tsx tools/structure-recording.mts args.json");
const args=JSON.parse((await readFile(process.argv[2],"utf8")).replace(/^\ufeff/,""));
console.log(JSON.stringify(await structureRecording(args.videoPath,{...args,modelsRoot:modelsRoot(),cacheDir:cacheDir()}),null,2));
