import { randomUUID,createHash } from "node:crypto";
import type { ExtractorPort } from "../ports.js";
import type { ExtractionProposal,GraphEdge,GraphNode,MemoryKind,MemoryScope,SourceReference,TopicDescriptor,WarmMemory } from "../types.js";

interface LlmItem {kind:MemoryKind;subject:string;predicate:string;object:string;polarity?:"positive"|"negative";summary:string;confidence:number;importance?:number;dimension?:string;applicability?:"global"|"workspace"|"project"|"task";origin?:"explicit"|"repeated"|"inferred";validFrom?:number;validTo?:number;status?:"candidate"|"active"|"superseded"|"disputed"}
interface LlmResult {items?:LlmItem[]}
export interface LlmExtractorOptions {baseUrl:string;apiKey:string;model:string;timeoutMs?:number;maxRetries?:number}

/** Structured semantic extractor. It extracts only focus user evidence; context is for coreference resolution. */
export class LlmExtractor implements ExtractorPort {
  private readonly baseUrl:string;
  constructor(private readonly options:LlmExtractorOptions){this.baseUrl=options.baseUrl.replace(/\/$/,"");}
  async extract(content:string,sourceRefs:SourceReference[],scope:MemoryScope):Promise<ExtractionProposal>{
    const result=await this.call(content);const now=Date.now();const records:WarmMemory[]=[];const topics=new Map<string,TopicDescriptor>();const nodes=new Map<string,GraphNode>();const edges:GraphEdge[]=[];
    for(const raw of result.items??[]){const item=validateItem(raw);if(!item)continue;const subject=node(item.subject,item.subject==="用户"?"user":"person",scope);const object=node(item.object,"concept",scope);nodes.set(subject.id,subject);nodes.set(object.id,object);const topicId=`${scope.type}.${scope.id}.${item.kind}.${slug(item.subject)}.${slug(item.dimension??item.predicate)}`.slice(0,180);const text=item.polarity==="negative"?`${item.subject} 不${item.predicate} ${item.object}`:`${item.subject} ${item.predicate} ${item.object}`;const common={id:randomUUID(),tier:"hot" as const,scope,topicIds:[topicId],entityIds:[subject.id,object.id],status:item.status??(item.origin==="inferred"?"candidate":"active"),confidence:item.confidence,sourceRefs,createdAt:now,updatedAt:now};
      if(item.kind==="preference")records.push({...common,kind:"preference",dimension:item.dimension??"general",value:text,summary:item.summary,applicability:item.applicability??"workspace",strength:item.importance??.85,origin:item.origin??"explicit"});
      else records.push({...common,kind:item.kind,title:`${label(item.kind)}: ${item.summary}`.slice(0,100),content:text,summary:item.summary,importance:item.importance??.75,validFrom:item.validFrom,validTo:item.validTo});
      topics.set(topicId,{topicId,kind:item.kind,scope,title:`${item.subject}: ${item.dimension??item.predicate}`,description:item.summary,aliases:[item.subject,item.object,item.predicate,item.dimension??""].filter(Boolean),entityIds:[subject.id,object.id],relatedTopicIds:[],embeddingText:`${item.subject} ${item.predicate} ${item.object} ${item.summary}`,status:"active",updatedAt:now});
      edges.push({id:`${scope.type}:${scope.id}:edge:${stable(`${subject.id}:${item.predicate}:${object.id}`)}`,fromId:subject.id,predicate:item.polarity==="negative"?`not_${item.predicate}`:item.predicate,toId:object.id,scope,confidence:item.confidence,status:item.status??"active"});
    }
    return{records,topics:[...topics.values()],nodes:[...nodes.values()],edges};
  }
  private async call(content:string):Promise<LlmResult>{
    const prompt=`You are a conservative long-term-memory extractor. Return strict JSON only.\nExtract durable facts, preferences, episodes and procedures from the FOCUS user message. CONTEXT is only for resolving names and pronouns. Never treat assistant statements, questions, suggestions, hypotheticals or quoted claims as user facts. Split multi-person statements into separate items. Preserve negation, conditions, temporal changes and current-vs-historical state. For inferred preferences use status=candidate and origin=inferred.\nSchema: {"items":[{"kind":"fact|preference|episode|procedure","subject":"用户 or named entity","predicate":"short relation","object":"value/entity","polarity":"positive|negative","summary":"concise Chinese summary","confidence":0..1,"importance":0..1,"dimension":"food|communication|technology|workflow|general","applicability":"global|workspace|project|task","origin":"explicit|repeated|inferred","status":"candidate|active|superseded|disputed","validFrom":optional epoch ms,"validTo":optional epoch ms}]}\nInput:\n${content}`;
    const retries=Math.max(0,this.options.maxRetries??1);let last:unknown;
    for(let attempt=0;attempt<=retries;attempt++){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),this.options.timeoutMs??60_000);try{const response=await fetch(`${this.baseUrl}/chat/completions`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${this.options.apiKey}`},body:JSON.stringify({model:this.options.model,messages:[{role:"system",content:prompt}],temperature:0,response_format:{type:"json_object"}}),signal:controller.signal});const text=await response.text();if(!response.ok)throw new Error(`Extractor API ${response.status}: ${text.slice(0,500)}`);const parsed=JSON.parse(text) as {choices?:Array<{message?:{content?:string}}>};return JSON.parse(parsed.choices?.[0]?.message?.content??"{}") as LlmResult;}catch(error){last=error;if(attempt===retries)throw error;await new Promise((resolve)=>setTimeout(resolve,500*2**attempt));}finally{clearTimeout(timer);}}throw last;}
}

export class HybridExtractor implements ExtractorPort {constructor(private readonly rule:ExtractorPort,private readonly llm?:ExtractorPort){}async extract(content:string,refs:SourceReference[],scope:MemoryScope){const fast=await this.rule.extract(focusContent(content),refs,scope);const contextualFood=await contextualFoodFallback(this.rule,content,refs,scope);const contextualRelations=contextualRelationshipFallback(content,refs,scope);const deterministic=merge(merge(fast,contextualFood),contextualRelations);if(!this.llm)return deterministic;try{const semantic=await this.llm.extract(content,refs,scope);return merge(deterministic,semantic);}catch(error){if(deterministic.records.length||deterministic.topics.length||deterministic.nodes.length||deterministic.edges.length)return deterministic;throw error;}}}
function merge(a:ExtractionProposal,b:ExtractionProposal):ExtractionProposal{const records=new Map<string,WarmMemory>();for(const r of [...a.records,...b.records]){const key=r.kind==="preference"?`${r.kind}:${r.dimension}:${r.value}`:`${r.kind}:${r.title}:${r.content}`;const old=records.get(key);if(!old||r.confidence>old.confidence)records.set(key,r);}return{records:[...records.values()],topics:unique([...a.topics,...b.topics],x=>x.topicId),nodes:unique([...a.nodes,...b.nodes],x=>x.id),edges:unique([...a.edges,...b.edges],x=>x.id)};}
function validateItem(item:LlmItem){if(!item||!["fact","preference","episode","procedure"].includes(item.kind)||!clean(item.subject)||!clean(item.predicate)||!clean(item.object)||!clean(item.summary)||!Number.isFinite(item.confidence))return undefined;const rawSubject=clean(item.subject);const userSubject=/^(?:我|本人|用户|user)(?:不)?$/i.test(rawSubject);return{...item,subject:userSubject?"用户":rawSubject,predicate:clean(item.predicate),object:clean(item.object),summary:clean(item.summary),polarity:rawSubject.endsWith("不")?"negative":item.polarity,confidence:clamp(item.confidence),importance:clamp(item.importance??.75)};}
function clean(value:unknown){return typeof value==="string"?value.trim().slice(0,500):"";}function clamp(v:number){return Math.max(0,Math.min(1,v));}function stable(v:string){return createHash("sha256").update(v.toLowerCase()).digest("hex").slice(0,24);}function slug(v:string){return v.toLowerCase().replace(/[^\p{L}\p{N}_.-]/gu,"-").replace(/-+/g,"-").replace(/^-|-$/g,"")||"general";}function node(name:string,type:string,scope:MemoryScope):GraphNode{return{id:`${scope.type}:${scope.id}:entity:${stable(`${type}:${name}`)}`,type,canonicalName:name,aliases:[name.toLowerCase()],scope};}function label(k:MemoryKind){return k[0].toUpperCase()+k.slice(1);}function unique<T>(items:T[],key:(x:T)=>string){return[...new Map(items.map(x=>[key(x),x])).values()];}

function focusContent(content:string){const match=/<focus_user>([\s\S]*?)<\/focus_user>/i.exec(content);return match?`user: ${match[1].trim()}`:content;}

async function contextualFoodFallback(rule:ExtractorPort,content:string,refs:SourceReference[],scope:MemoryScope):Promise<ExtractionProposal>{
 const context=/<context>([\s\S]*?)<\/context>/i.exec(content)?.[1]??"";const focus=/<focus_user>([\s\S]*?)<\/focus_user>/i.exec(content)?.[1]??"";
 const prior=/(?:我|用户)(?:爱吃|喜欢吃)\s*([\p{L}]{1,20}?)(?=，|。|！|？|,|\s*我有个朋友|$)/u.exec(context);const friend=/我有个朋友\s*([\p{Script=Han}]{2,6}?)(?:也)?(?:是|爱吃|喜欢吃)/u.exec(context);const pronoun=/^他(?:说|觉得)?\s*([\p{L}]{1,20}?)(?=(?:也)?(?:很好吃|好吃))/u.exec(focus.trim());const selfNegative=/(?:我|用户)(?:不爱吃|不喜欢吃|不吃)\s*([\p{L}]{1,20})?/u.exec(focus);
 const lines:string[]=[];if(prior&&friend)lines.push(`user: ${friend[1]}爱吃${prior[1]}`);if(pronoun&&friend)lines.push(`user: ${friend[1]}觉得${pronoun[1]}很好吃`);if(selfNegative&&(selfNegative[1]||pronoun?.[1]))lines.push(`user: 我不爱吃${selfNegative[1]||pronoun![1]}`);
 return lines.length?rule.extract(lines.join("\n"),refs,scope):{records:[],topics:[],nodes:[],edges:[]};
}


function contextualRelationshipFallback(content:string,refs:SourceReference[],scope:MemoryScope):ExtractionProposal{
 const context=/<context>([\s\S]*?)<\/context>/i.exec(content)?.[1]??"";
 const focus=(/<focus_user>([\s\S]*?)<\/focus_user>/i.exec(content)?.[1]??content).trim();
 const records:WarmMemory[]=[],topics=new Map<string,TopicDescriptor>(),nodes=new Map<string,GraphNode>(),edges:GraphEdge[]=[];const now=Date.now();
 const addFact=(subjectName:string,predicate:string,objectName:string,summary:string,aliases:string[],objectType="place")=>{
  const subject=node(subjectName,"person",scope),object=node(objectName,objectType,scope);nodes.set(subject.id,subject);nodes.set(object.id,object);
  const topicId=`${scope.type}.${scope.id}.fact.${slug(subjectName)}.${slug(predicate)}`.slice(0,180);const text=`${subjectName} ${predicate==="lives_in"?"住在":predicate==="neighbor_of"?"与":""} ${objectName}${predicate==="neighbor_of"?"是邻居":""}`.replace(/\s+/g," ").trim();
  records.push({id:randomUUID(),kind:"fact",tier:"hot",scope,title:predicate==="lives_in"?`${subjectName}的住所`:`${subjectName}与${objectName}的邻居关系`,content:text,summary,topicIds:[topicId],entityIds:[subject.id,object.id],status:"active",confidence:.97,importance:.9,sourceRefs:refs,createdAt:now,updatedAt:now});
  topics.set(topicId,{topicId,kind:"fact",scope,title:predicate==="lives_in"?`${subjectName}的住所`:`${subjectName}的邻居关系`,description:summary,aliases:[subjectName,objectName,...aliases],entityIds:[subject.id,object.id],relatedTopicIds:[],embeddingText:`${subjectName} ${predicate} ${objectName} ${summary}`,status:"active",updatedAt:now});
  edges.push({id:`${scope.type}:${scope.id}:edge:${stable(`${subject.id}:${predicate}:${object.id}`)}`,fromId:subject.id,predicate,toId:object.id,scope,confidence:.97,status:"active"});
 };
 const direct=/^([A-Za-z][A-Za-z0-9_.-]{0,39}|[\p{Script=Han}]{2,8})家(?:住)?在([^，。！？,.!?\s]{1,30})$/u.exec(focus);
 if(direct)addFact(direct[1],"lives_in",direct[2],`${direct[1]}家在${direct[2]}`,["家在","住址","住所","住在"]);
 const priorHomes=[...context.matchAll(/(?:^|\n)user:\s*([A-Za-z][A-Za-z0-9_.-]{0,39}|[\p{Script=Han}]{2,8})家(?:住)?在([^，。！？,.!?\n\s]{1,30})/gmu)].map((m)=>({person:m[1],place:m[2]}));
 const also=/^([A-Za-z][A-Za-z0-9_.-]{0,39}|[\p{Script=Han}]{2,8})家也(?:是|在)?(?:那里|那儿)?$/u.exec(focus);
 if(also&&priorHomes.length){const prior=priorHomes.at(-1)!;addFact(also[1],"lives_in",prior.place,`${also[1]}家也在${prior.place}`,["家也在","住址","住所","住在"]);}
 if(/^(?:他俩|他们俩|两人|两家)(?:住)?(?:在)?隔壁(?:，?是邻居)?$/u.test(focus)){
  const alsoNames=[...context.matchAll(/(?:^|\n)user:\s*([A-Za-z][A-Za-z0-9_.-]{0,39}|[\p{Script=Han}]{2,8})家也(?:是|在)?/gmu)].map((m)=>m[1]);
  const names=[...new Set([...priorHomes.map((x)=>x.person),...alsoNames])];
  if(names.length>=2)addFact(names.at(-2)!,"neighbor_of",names.at(-1)!,`${names.at(-2)}和${names.at(-1)}两家是邻居`,["隔壁","邻居"],"person");
 }
 return{records,topics:[...topics.values()],nodes:[...nodes.values()],edges};
}
