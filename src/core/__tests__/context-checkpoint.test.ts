import { afterEach,describe,expect,it,vi } from "vitest";
import { mkdtemp,writeFile,rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
vi.mock("../codex-review",()=>({codexReview:vi.fn()}));
import { codexReview } from "../codex-review";
import { checkpointReviewer } from "../context-checkpoint";
import { structureRecording } from "../structure-recording";
const roots:string[]=[];
async function root(){const r=await mkdtemp(join(tmpdir(),"context-test-"));roots.push(r);return r;}
afterEach(async()=>{vi.resetAllMocks();await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
describe("context checkpoints",()=>{
  it("reuses identical input and invalidates changes to prompt, schema, model and image bytes",async()=>{
    const dir=await root(),file=join(dir,"frame.jpg");await writeFile(file,"first-image");
    vi.mocked(codexReview).mockResolvedValue({result:"observed"});
    const review=checkpointReviewer(dir);
    await review("p",{},"visual",[file]);await review("p",{},"visual",[file]);
    expect(codexReview).toHaveBeenCalledTimes(1);
    await writeFile(file,"changed-image");await review("p",{},"visual",[file]);
    await review("changed",{},"visual",[file]);await review("changed",{type:"object"},"visual",[file]);
    await review("changed",{type:"object"},"subtitle",[file]);
    expect(codexReview).toHaveBeenCalledTimes(5);
  });
  it("does not cache model failures as completed results",async()=>{
    const review=checkpointReviewer(await root());
    vi.mocked(codexReview).mockRejectedValueOnce(new Error("at capacity")).mockResolvedValueOnce({ok:true});
    await expect(review("p",{})).rejects.toThrow("capacity");
    expect(await review("p",{})).toEqual({ok:true});expect(codexReview).toHaveBeenCalledTimes(2);
  });
  it("rejects resume of changed inputs before any model call",async()=>{
    const dir=await root(),video=join(dir,"video.mp4");await writeFile(video,"source");
    await writeFile(join(dir,"source-manifest.json"),JSON.stringify({path:"a different recording"}));
    await expect(structureRecording(video,{outDir:dir,resume:true,modelsRoot:dir,cacheDir:dir})).rejects.toThrow("resume-source-or-options-changed");
    expect(codexReview).not.toHaveBeenCalled();
  });
});
