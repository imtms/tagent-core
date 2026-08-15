import type { GraphStorePort, RecordStorePort, TopicCatalogPort, VectorIndexPort } from "./ports.js";
import type { AccessContext, ExtractionProposal, MemoryKind, MemoryLifecycleState, TopicDescriptor, WarmMemory } from "./types.js";
import { canonicalFingerprint, canonicalizeTopic, canonicalSPO, isDurableMemory } from "./quality.js";

interface RetentionPolicy { staleAfterMs:number; deleteAfterMs:number }
export interface LifecycleOptions {
  warmAfterMs?:number; hotTtlMs?:number; coldMinimumRecords?:number; minimumColdConfidence?:number;
  candidateTtlMs?:number; deletedGracePeriodMs?:number; retention?:Partial<Record<MemoryKind,RetentionPolicy>>;
}
const DAY=86_400_000;
const DEFAULT_RETENTION:Record<MemoryKind,RetentionPolicy>={
  fact:{staleAfterMs:365*DAY,deleteAfterMs:730*DAY},preference:{staleAfterMs:365*DAY,deleteAfterMs:730*DAY},
  episode:{staleAfterMs:90*DAY,deleteAfterMs:180*DAY},procedure:{staleAfterMs:180*DAY,deleteAfterMs:365*DAY},
};
export class MemoryLifecycle {
  constructor(private readonly records:RecordStorePort,private readonly vectors:VectorIndexPort|undefined,private readonly graph:GraphStorePort|undefined,private readonly topics:TopicCatalogPort,private readonly options:LifecycleOptions={}){}
  async integrate(access:AccessContext,proposal:ExtractionProposal){
    const existing=await this.records.list(access.scopes,undefined,20_000),working=[...existing]; const accepted:WarmMemory[]=[];
    for(const raw of proposal.records){
      if(!isDurableMemory(raw))continue;
      const now=Date.now(),canonicalTopic=canonicalizeTopic(raw),routed=canonicalTopic?{...raw,topicIds:[canonicalTopic]}:raw;
      const candidate=withLifecycle(routed.tier==="hot"&&!routed.expiresAt&&this.options.hotTtlMs?{...routed,expiresAt:now+this.options.hotTtlMs}:routed,now);
      const duplicate=working.find((item)=>sameMemory(item,candidate));
      if(duplicate){const merged=mergeDuplicate(duplicate,candidate);accepted.push(merged);replaceWorking(working,duplicate,merged);continue;}
      const conflict=working.find((item)=>conflicts(item,candidate));
      if(conflict){const oldLifecycle=state(conflict),superseded:WarmMemory=conflict.kind==="preference"?{...conflict,status:"superseded",lifecycle:{...oldLifecycle,lastSeenAt:now,staleAt:now},updatedAt:now}:{...conflict,status:"superseded",validTo:now,lifecycle:{...oldLifecycle,lastSeenAt:now,staleAt:now},updatedAt:now},replacement:WarmMemory=candidate.kind==="preference"?{...candidate,status:candidate.origin==="inferred"?"candidate":"active",supersedesId:conflict.id}:{...candidate,status:"active",supersedesId:conflict.id};accepted.push(superseded,replacement);replaceWorking(working,conflict,superseded);working.push(replacement);continue;}
      const next=candidate.kind==="preference"&&candidate.origin==="inferred"?{...candidate,status:"candidate" as const}:candidate;accepted.push(next);working.push(next);
    }
    const mergedTopics=mergeTopics(proposal.topics,accepted);
    return{records:accepted,topics:mergedTopics,nodes:proposal.nodes.length,edges:proposal.edges.length};
  }
  async promote(access:AccessContext){
    const now=Date.now(),warmAfter=this.options.warmAfterMs??0,candidateTtl=this.options.candidateTtlMs??90*DAY,grace=this.options.deletedGracePeriodMs??30*DAY;
    const all=await this.records.list(access.scopes,undefined,50_000),updates:WarmMemory[]=[];const removed=new Set<string>();let stale=0,expired=0;
    for(const record of all){
      const lifecycle=state(record),age=now-lifecycle.lastSeenAt,retention={...DEFAULT_RETENTION[record.kind],...this.options.retention?.[record.kind]};
      if(record.expiresAt&&record.expiresAt<=now){updates.push(tombstone(record,now,"hot_ttl_expired",grace));removed.add(record.id);expired++;continue;}
      if(record.tier==="hot"&&record.status==="active"&&now-record.createdAt>=warmAfter){updates.push({...record,tier:"warm",expiresAt:undefined,lifecycle,updatedAt:now});continue;}
      if(record.status==="candidate"&&now-record.createdAt>=candidateTtl){updates.push({...record,status:"quarantined",lifecycle:{...lifecycle,staleAt:now},updatedAt:now});removed.add(record.id);stale++;continue;}
      if(record.status==="active"&&shouldStale(record,age,retention.staleAfterMs,now)){updates.push({...record,status:"stale",lifecycle:{...lifecycle,staleAt:now},updatedAt:now});removed.add(record.id);stale++;continue;}
      if((record.status==="stale"||record.status==="superseded")&&age>=retention.deleteAfterMs){updates.push(tombstone(record,now,record.status==="stale"?"retention_expired":"superseded_retention_expired",grace));removed.add(record.id);expired++;}
    }
    if(updates.length)await this.records.upsertRecords(updates);if(removed.size){const affected=updates.filter((record)=>removed.has(record.id));await this.vectors?.remove([...removed]);await this.topics.invalidateTopics?.([...new Set(affected.flatMap((record)=>record.topicIds))],access.scopes);await this.graph?.removeByEntityIds?.([...new Set(affected.flatMap((record)=>record.entityIds))],access.scopes);}
    const purged=await this.records.purgeDeleted?.(access.scopes,now,1000)??[];if(purged.length)await this.vectors?.remove(purged);
    return{updated:updates.length,stale,expired,purged:purged.length};
  }
  async topicCandidateBatch(access:AccessContext){const [topics,all]=await Promise.all([this.topics.listDescriptors(access.scopes,["fact","preference","episode","procedure"],20_000),this.records.list(access.scopes,undefined,50_000)]);const minimum=this.options.coldMinimumRecords??2,confidence=this.options.minimumColdConfidence??0.7,counts=new Map<string,number>(),evidence=new Map<string,WarmMemory[]>();for(const record of all)for(const topicId of record.topicIds){const rows=evidence.get(topicId)??[];rows.push(record);evidence.set(topicId,rows);if(record.tier==="warm"&&record.status==="active"&&record.confidence>=confidence)counts.set(topicId,(counts.get(topicId)??0)+1);}return{topics:topics.filter((topic)=>(counts.get(topic.topicId)??0)>=minimum),evidence};}
  async topicCandidates(access:AccessContext){return (await this.topicCandidateBatch(access)).topics;}
}
function shouldStale(record:WarmMemory,age:number,staleAfter:number,now:number){if(record.kind!=="preference"&&record.validTo&&record.validTo<=now)return true;if(age<staleAfter)return false;if(record.provenance?.evidenceClass==="user_explicit"&&record.confidence>=.9&&(record.kind==="preference"||record.importance>=.9))return false;return true;}
function tombstone(record:WarmMemory,now:number,reason:string,grace:number):WarmMemory{const lifecycle=state(record);return{...record,status:"deleted",lifecycle:{...lifecycle,previousStatus:record.status==="deleted"?lifecycle.previousStatus:record.status,deletedAt:now,purgeAfter:now+grace,deleteReason:reason},updatedAt:now};}
function state(record:WarmMemory):MemoryLifecycleState{return record.lifecycle??{firstSeenAt:record.createdAt,lastSeenAt:record.updatedAt,confirmationCount:Math.max(1,record.sourceRefs.length)};}
function withLifecycle<T extends WarmMemory>(record:T,now:number):T{return{...record,lifecycle:record.lifecycle??{firstSeenAt:record.createdAt||now,lastSeenAt:record.updatedAt||now,confirmationCount:Math.max(1,record.sourceRefs.length)}};}
function normalized(record:WarmMemory){return(record.kind==="preference"?`${record.dimension}:${record.value}`:`${record.kind}:${record.title}:${record.content}`).toLowerCase().replace(/\s+/g," ").trim();}
function sameMemory(a:WarmMemory,b:WarmMemory){return a.kind===b.kind&&a.scope.type===b.scope.type&&a.scope.id===b.scope.id&&(normalized(a)===normalized(b)||canonicalFingerprint(a)===canonicalFingerprint(b));}
function conflicts(a:WarmMemory,b:WarmMemory){if(a.kind!==b.kind||a.scope.type!==b.scope.type||a.scope.id!==b.scope.id||a.status!=="active")return false;if(a.kind==="preference"&&b.kind==="preference"){if(a.dimension!==b.dimension||a.applicability!==b.applicability||a.value===b.value)return false;if(SINGLE_VALUE_PREFERENCE_DIMENSIONS.has(normalizeDimension(a.dimension)))return true;const left=canonicalSPO(a),right=canonicalSPO(b);return left.subject===right.subject&&left.predicate===right.predicate&&left.object===right.object&&left.polarity!==right.polarity;}if(a.kind!=="preference"&&b.kind!=="preference")return a.kind==="fact"&&b.kind==="fact"&&canonicalSubjectPredicate(a)===canonicalSubjectPredicate(b)&&canonicalFingerprint(a)!==canonicalFingerprint(b);return false;}
function canonicalSubjectPredicate(record:Exclude<WarmMemory,{kind:"preference"}>){return record.semantic?`${record.semantic.subject}|${record.semantic.predicate}`:`${record.title}`.toLowerCase().trim();}
function mergeDuplicate(a:WarmMemory,b:WarmMemory):WarmMemory{const novel=b.sourceRefs.filter((ref)=>!a.sourceRefs.some((old)=>old.sourceType===ref.sourceType&&old.sourceId===ref.sourceId&&old.revision===ref.revision));if(!novel.length)return a;const now=Date.now(),sourceRefs=[...a.sourceRefs,...novel],lifecycle={...state(a),lastSeenAt:now,confirmationCount:state(a).confirmationCount+1,staleAt:undefined};if(a.kind==="preference"&&b.kind==="preference")return{...a,tier:"warm",status:"active",strength:Math.min(1,a.strength+0.08),confidence:Math.min(1,Math.max(a.confidence,b.confidence)+0.05),sourceRefs,lifecycle,updatedAt:now};if(a.kind!=="preference"&&b.kind!=="preference")return{...a,tier:"warm",status:"active",validTo:undefined,confidence:Math.min(1,Math.max(a.confidence,b.confidence)+0.05),importance:Math.max(a.importance,b.importance),sourceRefs,lifecycle,updatedAt:now};return b;}
function mergeTopics(topics:TopicDescriptor[],records:WarmMemory[]){return topics.map((topic)=>({...topic,entityIds:[...new Set([...topic.entityIds,...records.filter((r)=>r.topicIds.includes(topic.topicId)).flatMap((r)=>r.entityIds)])]}));}
function replaceWorking(records:WarmMemory[],old:WarmMemory,next:WarmMemory){const index=records.findIndex((record)=>record.id===old.id);if(index>=0)records[index]=next;else records.push(next);}
function normalizeDimension(value:string){return value.toLowerCase().replace(/[\s_-]/g,"");}
const SINGLE_VALUE_PREFERENCE_DIMENSIONS=new Set(["communication","沟通","language","语言","verbosity","详细程度","technicaldepth","技术深度","answerstructure","回答结构","progressupdatepolicy","进度更新策略","clarificationtolerance","澄清容忍度","uncertaintystyle","不确定性风格","challengelevel","挑战程度"]);
