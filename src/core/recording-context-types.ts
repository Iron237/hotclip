export type Confidence = "high" | "medium" | "low";
export const ACTIVITIES = ["read_chat","reply_to_chat","game_dialogue","read_game_text","comment_game","smalltalk","thank_gift","unknown"] as const;
export type Activity = typeof ACTIVITIES[number];
export interface RecordingBackground {
  streamerName?: string; roomId?: string; title?: string; gameName?: string; gameChapter?: string; notes?: string;
}
export interface ContextSession {
  schemaVersion: "hotclip-context-v1"; id:string;
  background:RecordingBackground;
  backgroundEvidence:Array<{field:string;value:string;source:"user"|"recorder_metadata"}>;
  source:{path:string;size:number;mtimeMs:number;durationSec:number;recordingStartTime:string|null};
  clock:{unit:"seconds";origin:"source-media-start";chatOffsetSec:number;chatScale:number;alignment:"user-supplied"|"sidecar-relative-unverified"|"no-chat"};
  models:{subtitle:string;analysis?:string;visual:string;reasoningEffort:string};
  warnings:string[];
}
export interface UtteranceEvent {
  id:string; kind:"utterance"; startSec:number; endSec:number;
  textRaw:string; textLexicon:string; text:string; subtitleText:string;
  firstWord:number; lastWord:number;
  audioOrigin:"mixed-or-unknown";
  speaker:{id:string|null;role:"host"|"game"|"unknown";cluster:number|null;confidence:Confidence;basis:string};
  activity:Activity; addressee:"audience"|"game-character"|"unknown";
  topic:string; uncertain:boolean; evidenceRefs:string[];
}
export interface ChatEvent {
  id:string;kind:"chat"|"sc"|"gift"|"guard"|"follow"|"like";
  startSec:number;endSec:number;sourceTimeSec:number;text:string;sender:string|null;evidenceRefs:string[];
}
export interface ScreenEvent {
  id:string;kind:"screen";startSec:number;endSec:number;
  mode:"cutscene"|"combat"|"menu"|"loading"|"unknown";
  visibleText:string;visibleCharacters:string[];description:string;confidence:Confidence;
  evidenceRefs:string[];
}
export type ContextEvent=UtteranceEvent|ChatEvent|ScreenEvent;
export interface ContextRelation {
  id:string;from:string;to:string;type:"reads"|"replies_to"|"reacts_to"|"quotes";
  status:"supported"|"candidate";confidence:Confidence;reason:string;
}
export interface ContextEpisode {
  id:string;title:string;kind:"audience-interaction"|"game-story"|"game-commentary"|"mixed"|"smalltalk"|"unknown";
  state:"open"|"responding"|"resolved"|"suspended";
  eventIds:string[];relationIds:string[];startSec:number;endSec:number;
  summary:string;openQuestions:string[];resolutionEventId:string|null;
  evidenceRefs:string[];
}
export interface InterestCandidate {
  id:string;episodeId:string;kind:"question-answer"|"unexpected-reply"|"story-or-opinion"|"game-reaction"|"unknown";
  whyInteresting:string;triggerEventIds:string[];setupEventIds:string[];payoffEventIds:string[];
  resolutionEventId:string|null;requiredContextEventIds:string[];
  interestLevel:Confidence;evidenceConfidence:Confidence;reviewNeeded:string[];
}
export interface RecordingContext {
  session:ContextSession;events:ContextEvent[];relations:ContextRelation[];episodes:ContextEpisode[];
  interests:InterestCandidate[];
}
