import { writeFile,readFile } from "fs/promises";
import { join } from "path";
import { transcribeCached } from "./pipeline";
import { checkDomainLexicon } from "./domain-lexicon";
import { chatSpeakerTurns } from "./chat-speakers";
import { labelTranscript } from "./diarize";
import { CHAT_LEXICONS, CHAT_MODELS, indexWords, reviewPrompt, validateTurns, REVIEW_SCHEMA, type ReviewedTurn } from "./chat-review";
import { codexReview } from "./codex-review";
import type { SelectedExportOptions } from "./selected-clips";
import { optionalJson } from "./context-checkpoint";
import type { SpeakerTurn } from "./diarize";

export type ChatPreparationOptions = Pick<SelectedExportOptions, "modelsRoot"|"cacheDir"|"asr"|"subtitlePath"|"lexiconProfiles"> & {
  diarize?: boolean; signal?: AbortSignal; onStage?: (stage:string)=>void;
};
/** Shared speech/lexicon/role preparation for clipping and structured context. */
export async function prepareChatTranscript(videoPath:string,options:ChatPreparationOptions,root:string,resume=false) {
  const stage=(s:string)=>{options.onStage?.(s);console.error(`chat: ${s}`);};
  const save=(name:string,value:unknown)=>writeFile(join(root,name),JSON.stringify(value,null,2),"utf8");
    stage("Qwen transcription");
    const raw = await transcribeCached(videoPath, options.modelsRoot, options.cacheDir, undefined, options.signal, options.subtitlePath, { ...options.asr, engineId: options.asr?.engineId ?? "qwen3" });
    await save("asr-raw.json", raw);
    const checked = checkDomainLexicon(raw, options.lexiconProfiles ?? CHAT_LEXICONS);
    await save("lexicon-audit.json", checked);
    let labeled=checked.transcript;
    const speakerWarnings:string[]=[];
    let speakerEvidence="semantic-context-only";
    if(options.diarize!==false) {
      stage("Audio speaker clustering (pyannote + 3D-Speaker)");
      try {
        const cached=resume?await optionalJson<{turns:SpeakerTurn[]}>(join(root,"speaker-turns.json")):undefined;
        const speakerTurns=cached?.turns??await chatSpeakerTurns(videoPath,raw.durationSec,options.modelsRoot,options.signal);
        await save("speaker-turns.json",{method:"pyannote-segmentation-3.0 + 3D-Speaker ERes2Net",scope:"5-minute windows; ids not cross-window identities",turns:speakerTurns});
        labeled=labelTranscript(checked.transcript,speakerTurns);
        speakerEvidence=speakerTurns.length?"acoustic-clusters-plus-semantic-roles":"semantic-context-only";
        if(!speakerTurns.length) speakerWarnings.push("No acoustic speaker turns detected");
      } catch(error) {
        if(options.signal?.aborted) throw error;
        speakerWarnings.push(`Audio speaker clustering failed: ${String(error)}`);
      }
    }
    const words = indexWords(labeled), rawWords = indexWords(raw);
    if (!words.length) throw new Error("chat:no-speech");
    const turns: ReviewedTurn[] = [];
    for (let offset = 0, batch = 0; offset < words.length; batch++) {
      options.signal?.throwIfAborted();
      const target = words[offset].startSec + 120;
      let stop = offset + 1;
      while (stop < words.length && words[stop].endSec < target && stop-offset < 1800) stop++;
      // Prefer a real gap close to the nominal window boundary.
      let best = stop, distance = Infinity;
      for (let j = Math.max(offset+1, stop-80); j < Math.min(words.length, stop+80); j++) {
        const d = Math.abs(words[j].startSec-target);
        if (d < 15 && d < distance && words[j].startSec-words[j-1].endSec >= .35) { best=j; distance=d; }
      }
      stop = Math.min(words.length, Math.max(offset+1, best));
      const core = words.slice(offset,stop);
      const context = words.filter(w => (w.id<offset||w.id>=stop)&&w.endSec >= core[0].startSec-45 && w.startSec <= core.at(-1)!.endSec+45);
      stage(`Terra high cross-window subtitle review ${batch+1}`);
      const prompt = reviewPrompt(core, context, checked.audit.filter(a => a.endSec>=core[0].startSec && a.startSec<=core.at(-1)!.endSec));
      let cached:unknown;
      if(resume) {
        let previousPrompt="";
        try {previousPrompt=await readFile(join(root,`review-${batch}.prompt.txt`),"utf8");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
        if(previousPrompt===prompt)cached=await optionalJson(join(root,`review-${batch}.retry.json`))??await optionalJson(join(root,`review-${batch}.json`));
      }
      await writeFile(join(root, `review-${batch}.prompt.txt`), prompt, "utf8");
      let result = cached??await codexReview(prompt, REVIEW_SCHEMA, "subtitle", [], options.signal);
      await save(`review-${batch}.json`,result);
      let valid: ReviewedTurn[];
      try { valid = validateTurns(result,core); }
      catch (error) {
        stage(`Terra review ${batch+1} structural repair`);
        result = await codexReview(`${prompt}\n前次输出结构校验失败 ${String(error)}。重新输出，确保逐字覆盖所有 core 的 ID。前次输出仅供纠错：${JSON.stringify(result)}`, REVIEW_SCHEMA, "subtitle", [], options.signal);
        await save(`review-${batch}.retry.json`,result);
        valid = validateTurns(result,core);
      }
      turns.push(...valid); offset=stop;
    }
    await save("reviewed-turns.json", { models: CHAT_MODELS, speakerEvidence, turns });
    return {raw,checked,words,rawWords,turns,speakerEvidence,speakerWarnings};
}
