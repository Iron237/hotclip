import { readFile,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { optionalJson } from "../src/core/context-checkpoint";
import { auditBounds,type AuditLine } from "../src/core/recording-audit";
import { CHAT_MODELS,comparisonCsv } from "../src/core/chat-review";
const root=process.argv[2],dir=join(root,"selection");
const source=JSON.parse(await readFile(join(root,"source.json"),"utf8"));
const scan=JSON.parse(await readFile(join(root,"audit","scan-complete.json"),"utf8"));
const markers=JSON.parse(await readFile(join(root,"bookmarks.json"),"utf8"));
const ranking=JSON.parse(await readFile(join(dir,"ranking.json"),"utf8"));
const ids=[...markers.map((m:any)=>m.id),...ranking.ids.map((_:unknown,i:number)=>`A${String(i+1).padStart(2,"0")}`)];
const lines:AuditLine[]=JSON.parse(await readFile(join(root,"audit","reviewed-lines.json"),"utf8"));
const outputs:any[]=[];
for(const id of ids){
 let item=await optionalJson<any>(join(dir,`${id}.json`));
 while(!item){await delay(3000);item=await optionalJson(join(dir,`${id}.json`));}
 if(item.id!==id||!['matched','probable','not-located'].includes(item.status))throw new Error(`invalid stored result ${id}`);
 if(item.candidate)item.bounds=auditBounds(item.candidate,lines,source.media.durationSec);
 outputs.push(item);
}
for(const a of outputs){if(!a.bounds)continue;a.overlaps=[];
 for(const b of outputs){if(a===b||!b.bounds)continue;const overlap=Math.min(a.bounds.endSec,b.bounds.endSec)-Math.max(a.bounds.startSec,b.bounds.startSec);
  if(overlap>10&&overlap/Math.min(a.bounds.endSec-a.bounds.startSec,b.bounds.endSec-b.bounds.startSec)>.5)a.overlaps.push(b.id);
 }
}
const clock=(s:number)=>{const n=Math.floor(s);return [Math.floor(n/3600),Math.floor(n%3600/60),n%60].map(x=>String(x).padStart(2,'0')).join(':');};
const rows=outputs.map(o=>({编号:o.id,来源:o.source,用户标记:o.marker?.label||"",标记时间:o.marker?.time||"",标题:o.candidate?.title||"未可靠定位",建议开始:o.bounds?clock(o.bounds.startSec):"待定位",建议结束:o.bounds?clock(o.bounds.endSec):"待定位",时长秒:o.bounds?Math.round(o.bounds.endSec-o.bounds.startSec):"",类型:o.candidate?.kind||"待核",推荐:o.candidate?.score||"",内容与看点:o.candidate?.why||o.markerExplanation,定位:o.status==='matched'?'已对应':o.status==='probable'?'可能对应':'未定位',画面:o.visualChecked?'定点画面已核':'未核画面',待核:[...(o.candidate?.notes||[]),...(o.bounds?.boundaryReview?['气口较短，出片前复核边界']:[]),...(o.bounds?.uncertainIds.length?[`含${o.bounds.uncertainIds.length}句ASR待核`]:[]),...(o.needsExpansion?['边界或话题范围需复核']:[]),...(o.overlaps?.length?[`与${o.overlaps.join('、')}有明显重叠，可合并或择一`]:[])].join('；'),标签核对:o.markerExplanation}));
await writeFile(join(dir,'interest-candidates.json'),JSON.stringify({source,models:CHAT_MODELS,reviewedThroughSec:source.media.durationSec,items:outputs},null,2),'utf8');
await writeFile(join(root,'兴趣点待选表.csv'),comparisonCsv(rows),'utf8');
const esc=(s:unknown)=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\|/g,'／').replace(/[\r\n]+/g,' ').replace(/([\[\]`])/g,'\\$1');
const table=['# 昨日录播兴趣点待选表','',`源片：${source.videoPath}`,`时长 ${clock(source.media.durationSec)}；Qwen3 ASR；Terra high 文字校核；Sol high 主分析及视觉。`,'',`全片 ${scan.blocks} 个分析窗口完成，共 ${scan.segments} 条校核话语、${scan.chatEvents} 条互动事件。保留全部14个人工标记，另选${ranking.ids.length}个新增候选。画面只在8个标记附近定点核查24帧（1280×720），不是逐帧全片观看。`,'','以下均为待选建议，尚未导出视频。最终剪片前会复核选中段原音、字幕、气口；不把“已对应”写成已经人工听校。用户标签和模型标题都保留，以便辨认。','','|编号|来源|标记／标题|建议起止|秒|推荐|内容与看点|待核|','|---|---|---|---|---:|---:|---|---|',...rows.map(r=>`|${r.编号}|${r.来源}|${esc(r.用户标记?`${r.用户标记} → ${r.标题}`:r.标题)}|${r.建议开始}–${r.建议结束}|${r.时长秒}|${r.推荐}|${esc(r.内容与看点)}|${esc([r.定位,r.画面,r.待核].filter(Boolean).join('；'))}|`),'','选择时回复编号即可，例如 M01、M07、A02。详细标签核对、原始 ASR 和修订内容见 CSV 与 audit/ASR与上下文对照.csv。'];
await writeFile(join(root,'兴趣点待选表.md'),table.join('\n'),'utf8');
await writeFile(join(dir,'complete.json'),JSON.stringify({rows:rows.length,userMarkers:markers.length,automatic:ranking.ids.length,models:CHAT_MODELS,exportedVideos:0,completedAt:new Date().toISOString()},null,2),'utf8');
console.log(JSON.stringify({table:join(root,'兴趣点待选表.md'),rows:rows.length}));
