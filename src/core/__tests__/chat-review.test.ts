import { describe,expect,it } from "vitest";
import { validateTurns,validateChoices,topicBounds,comparisonCsv,withoutPunctuation,type IndexedWord,type ReviewedTurn } from "../chat-review";
import { buildCaptionAss,HORIZONTAL_LAYOUT } from "../subtitle";
const words:IndexedWord[]=[{id:0,text:"回答",startSec:10,endSec:11},{id:1,text:"完了",startSec:11,endSec:12},{id:2,text:"游戏",startSec:12.2,endSec:13}];
const turn:ReviewedTurn={firstWord:0,lastWord:1,text:"回答完了。",role:"host",topic:"聊天",reason:"完整回答",uncertain:false};
describe("chat subtitle and topic safeguards",()=>{
  it("requires full ordered coverage, rejecting omission and overlap",()=>{
    expect(validateTurns({turns:[turn]},words.slice(0,2))).toEqual([turn]);
    expect(()=>validateTurns({turns:[turn]},words)).toThrow("uncovered");
    expect(()=>validateTurns({turns:[turn,{...turn,firstWord:1,lastWord:2}]},words)).toThrow("invalid-turn");
    expect(()=>validateTurns({turns:[{...turn,text:"这是我编造的另一个非常漫长的故事"}]},words.slice(0,2))).toThrow("rewrite");
  });
  it("does not pad across a new topic spoken by the same host",()=>{
    const b=topicBounds(0,1,words,30);
    expect(b.endSec).toBeCloseTo(12.1);
    expect(b.endSec).toBeLessThan(words[2].startSec);
    expect(b.needsBoundaryReview).toBe(true);
  });
  it("rejects game dialogue and overlapping selections",()=>{
    const turns=[turn,{...turn,firstWord:2,lastWord:2,role:"game" as const}];
    const clip={title:"test",firstTurn:0,lastTurn:1,reason:"test"};
    expect(()=>validateChoices({clips:[clip]},turns,2)).toThrow();
    expect(()=>validateChoices({clips:[{...clip,lastTurn:0},{...clip,lastTurn:0}]},turns,2)).toThrow();
  });
  it("escapes spreadsheet formulas and multiline source text",()=>{
    const csv=comparisonCsv([{字幕:'=SUM(1,2)',上下文:'甲\n"乙"'}]);
    expect(csv).toContain('"\'=SUM(1,2)"');
    expect(csv).toContain('"甲\n""乙"""');
  });
  it("hides punctuation without losing the internal semantic break",()=>{
    expect(withoutPunctuation('所有。人，嗯！')).toBe('所有人嗯');
    expect(withoutPunctuation('3.5，-2；16:9。')).toBe('3.5-216:9');
    const input=[{text:"谢谢大家。",startSec:0,endSec:1},{text:"这样行吧？",startSec:1.2,endSec:2}];
    const normal=buildCaptionAss(input,0,HORIZONTAL_LAYOUT,"keyword");
    const hidden=buildCaptionAss(input,0,HORIZONTAL_LAYOUT,"keyword",{hidePunctuation:true});
    const events=(s:string)=>s.split('\n').filter(l=>l.startsWith('Dialogue:'));
    expect(events(hidden).length).toBe(events(normal).length);
    expect(events(hidden).join('\n')).not.toMatch(/[。？]/);
    expect(events(hidden).map(l=>l.split(',').slice(0,3))).toEqual(events(normal).map(l=>l.split(',').slice(0,3)));
    expect(input[0].text).toBe("谢谢大家。");
  });
});
