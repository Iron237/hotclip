import { modelsRoot } from "../src/core/appenv";
import { reviewCaptionVoiceprints } from "../src/core/caption-voiceprints";
const root = process.argv[2];
if (!root)
  throw new Error("Usage: review-caption-voices.mts RUN_ROOT [MODELS_ROOT]");
await reviewCaptionVoiceprints(root, process.argv[3] ?? modelsRoot());
