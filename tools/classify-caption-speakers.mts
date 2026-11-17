import { classifyCaptionSpeakers } from "../src/core/caption-speaker-review";
const root = process.argv[2];
if (!root) throw new Error("Usage: classify-caption-speakers.mts <RunRoot>");
await classifyCaptionSpeakers(root, process.argv.includes("--force"));
