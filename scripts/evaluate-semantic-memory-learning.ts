import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Store } from "../src/store/store.js";
import { SemanticJudge } from "../src/learning/semantic-judge.js";
import { RuleBasedExtractor } from "../src/memory/adapters/rule-extractor.js";

const baseUrl=(process.env.TAGENT_LEARNING_SEMANTIC_JUDGE_BASE_URL||process.env.TAGENT_ROUTER_API_BASE||process.env.TAGENT_API_BASE||"https://one.tms.im/v1").replace(/\/$/,"");
const apiKey=process.env.TAGENT_LEARNING_SEMANTIC_JUDGE_API_KEY||process.env.OPENAI_API_KEY;
const model=process.env.TAGENT_LEARNING_SEMANTIC_JUDGE_MODEL||process.env.TAGENT_ROUTER_MODEL||process.env.TAGENT_MODEL||"gpt-5.6-luna";
if(!apiKey)throw new Error("OPENAI_API_KEY or TAGENT_LEARNING_SEMANTIC_JUDGE_API_KEY is required");

const memorySamples=[
 {id:"m1",label:true,text:"上线窗口固定在每月第二个周二。"},
 {id:"m2",label:true,text:"团队代码审查由 Alice 负责。"},
 {id:"m3",label:true,text:"API 流量上限是每分钟 120 次。"},
 {id:"m4",label:true,text:"服务的公开端口是 3220。"},
 {id:"m5",label:true,text:"这个项目长期使用 PostgreSQL 作为主数据库。"},
 {id:"m6",label:true,text:"生产环境位于 eu-west-1 区域。"},
 {id:"m7",label:false,text:"帮我检查一下数据库是否正常。"},
 {id:"m8",label:false,text:"为什么刚才的测试失败了？"},
 {id:"m9",label:false,text:"把 3220 更新到最新并重启。"},
 {id:"m10",label:false,text:"你可以考虑以后换成 PostgreSQL。"},
 {id:"m11",label:false,text:"如果团队使用 Rust，性能可能会更好。"},
 {id:"m12",label:false,text:"请回复上一条消息。"},
];
const correctionSamples=[
 {id:"c1",label:true,text:"你前面的结论和实际情况正好相反，数据库应当是 PostgreSQL。"},
 {id:"c2",label:true,text:"这里需要调整一下：端口应为 3220，不是 3210。"},
 {id:"c3",label:true,text:"我表达得不够清楚，我想要的是简短结论，不是完整教程。"},
 {id:"c4",label:true,text:"前一个方案先不要用了，按保守归因处理。"},
 {id:"c5",label:true,text:"The earlier answer reverses the relationship; Alice reports to Bob."},
 {id:"c6",label:false,text:"请说明 PostgreSQL 和 SQLite 的区别。"},
 {id:"c7",label:false,text:"这个方案看起来不错，可以继续。"},
 {id:"c8",label:false,text:"完成后再生成一份报告。"},
 {id:"c9",label:false,text:"我喜欢简洁的回答。"},
 {id:"c10",label:false,text:"为什么选择这个实现？"},
];
const clusterSamples=[
 {id:"k1",label:true,left:"发布前验证版本",right:"validate build before shipping"},
 {id:"k2",label:true,left:"修复数据库迁移失败",right:"resolve the failed database schema migration"},
 {id:"k3",label:true,left:"审查拉取请求并给出结论",right:"review the pull request and summarize findings"},
 {id:"k4",label:false,left:"发布前验证版本",right:"设计新的数据库 schema"},
 {id:"k5",label:false,left:"修复登录错误",right:"撰写登录功能使用文档"},
 {id:"k6",label:false,left:"审查拉取请求",right:"部署生产版本"},
];

const correctionRegex=/\b(?:correction|incorrect|wrong|inaccurate|learned wrong)\b|(?:不太对|不准确|不正确|不对|错了|学错|改为|纠正|不是.{0,20}而是|不要再)/i;
const scope={type:"workspace" as const,id:"evaluation"};
const extractor=new RuleBasedExtractor();
const store=new Store(":memory:");
const judge=new SemanticJudge({baseUrl,apiKey,model,timeoutMs:20_000,maxRetries:0,minimumConfidence:.72,cacheTtlMs:86_400_000,maxCallsPerMinute:120,estimatedInputCostPerMillion:.5,estimatedOutputCostPerMillion:2},store);
const timings:number[]=[];
async function timed<T>(operation:()=>Promise<T>){const started=performance.now();const value=await operation();timings.push(performance.now()-started);return value;}
async function mapLimit<T,R>(items:T[],limit:number,fn:(item:T)=>Promise<R>){const output:R[]=new Array(items.length);let cursor=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(true){const index=cursor++;if(index>=items.length)return;output[index]=await fn(items[index]);}}));return output;}
function metrics(labels:boolean[],predictions:boolean[]){let tp=0,tn=0,fp=0,fn=0;labels.forEach((label,index)=>{const predicted=predictions[index];if(label&&predicted)tp++;else if(!label&&!predicted)tn++;else if(!label&&predicted)fp++;else fn++;});return{n:labels.length,tp,tn,fp,fn,accuracy:(tp+tn)/labels.length,precision:tp/Math.max(1,tp+fp),recall:tp/Math.max(1,tp+fn),falsePositiveRate:fp/Math.max(1,fp+tn)};}
const baselineMemory:boolean[]=[];for(const sample of memorySamples)baselineMemory.push((await extractor.extract(`user: ${sample.text}`,[],scope)).records.length>0);
const baselineCorrections=correctionSamples.map((sample)=>correctionRegex.test(sample.text));
const semanticMemory=(await mapLimit(memorySamples,4,async(sample)=>timed(()=>judge.memoryCapture(`<focus_user>${sample.text}</focus_user>`)))).map((result)=>Boolean(result?.shouldCapture&&result.durable));
const semanticCorrections=(await mapLimit(correctionSamples,4,async(sample)=>timed(()=>judge.userMessage(sample.text,"")))).map((result)=>Boolean(result?.correction));
const semanticClusters=(await mapLimit(clusterSamples,4,async(sample)=>timed(()=>judge.cluster(sample.left,sample.right)))).map((result)=>Boolean(result?.similar));
const beforeCache=judge.snapshot();
const cacheStarted=performance.now();await Promise.all(memorySamples.map((sample)=>judge.memoryCapture(`<focus_user>${sample.text}</focus_user>`)));const cacheElapsedMs=performance.now()-cacheStarted;
const afterCache=judge.snapshot();
const sorted=[...timings].sort((a,b)=>a-b);const percentile=(p:number)=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))]??0;
const report={generatedAt:new Date().toISOString(),provider:{baseUrl:new URL(baseUrl).host,model},datasets:{memory:memorySamples,correction:correctionSamples,cluster:clusterSamples},results:{memory:{baseline:metrics(memorySamples.map(x=>x.label),baselineMemory),semantic:metrics(memorySamples.map(x=>x.label),semanticMemory),baselinePredictions:baselineMemory,semanticPredictions:semanticMemory},correction:{baseline:metrics(correctionSamples.map(x=>x.label),baselineCorrections),semantic:metrics(correctionSamples.map(x=>x.label),semanticCorrections),baselinePredictions:baselineCorrections,semanticPredictions:semanticCorrections},cluster:{semantic:metrics(clusterSamples.map(x=>x.label),semanticClusters),semanticPredictions:semanticClusters}},performance:{uncachedCalls:beforeCache.calls,uncachedP50Ms:percentile(.5),uncachedP95Ms:percentile(.95),uncachedAverageMs:beforeCache.averageLatencyMs,cacheReplayInputs:memorySamples.length,cacheReplayElapsedMs:cacheElapsedMs,cacheHitsAdded:afterCache.cacheHits-beforeCache.cacheHits,providerCallsAdded:afterCache.calls-beforeCache.calls,inputTokens:afterCache.inputTokens,outputTokens:afterCache.outputTokens,estimatedCostUsdAtConfiguredRates:afterCache.estimatedCost,failures:afterCache.failures,timeouts:afterCache.timeouts,lowConfidence:afterCache.lowConfidence}};
const jsonPath=resolve(process.cwd(),"../semantic-memory-learning-evaluation-results.json");await writeFile(jsonPath,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));store.close();
