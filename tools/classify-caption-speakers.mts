import { classifyCaptionSpeakers } from "../src/core/caption-speaker-review";
import { reviewCaptionVoiceprints } from "../src/core/caption-voiceprints";
import { modelsRoot } from "../src/core/appenv";
const root = process.argv[2];
if (!root) throw new Error("Usage: classify-caption-speakers.mts <RunRoot>");
await classifyCaptionSpeakers(root, process.argv.includes("--force"));
await reviewCaptionVoiceprints(root, modelsRoot());
