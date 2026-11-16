import { beforeEach,expect,it,vi } from "vitest";
vi.mock("../codex-review",()=>({codexReview:vi.fn()}));
import { codexReview } from "../codex-review";
import { selectChatTopics } from "../chat-topics";
import type { IndexedWord,ReviewedTurn } from "../chat-review";
const words:IndexedWord[]=Array.from({length:370},(_,id)=>({id,text:"聊天",startSec:id*10,endSec:id*10+5}));
const turns:ReviewedTurn[]=words.map(w=>({firstWord:w.id,lastWord:w.id,text:"聊天",role:"host",topic:"话题",reason:"完整",uncertain:false}));
beforeEach(()=>vi.clearAllMocks());
it("keeps late topics in a long recording and translates local ids to source ids",async()=>{
  const call=vi.mocked(codexReview);
  call.mockResolvedValueOnce({clips:[{firstTurn:190,lastTurn:199,title:"early",reason:"完整"}]});
  call.mockResolvedValueOnce({clips:[{firstTurn:190,lastTurn:199,title:"late",reason:"完整"}]});
  call.mockResolvedValueOnce({clips:[]});
  call.mockResolvedValueOnce({ids:[1]});
  const result=await selectChatTopics(turns,words,1,"完整聊天",async()=>{});
  expect(result).toEqual([{firstTurn:350,lastTurn:359,title:"late",reason:"完整"}]);
  expect(call).toHaveBeenCalledTimes(4);
});
it("rejects fabricated candidate ids rather than exporting unrelated spans",async()=>{
  const call=vi.mocked(codexReview);
  for(let i=0;i<3;i++) call.mockResolvedValueOnce({clips:[{firstTurn:0,lastTurn:0,title:"one",reason:"完整"}]});
  call.mockResolvedValueOnce({ids:[999]});
  await expect(selectChatTopics(turns,words,1,"聊天",async()=>{})).rejects.toThrow("invalid-ranking");
});
