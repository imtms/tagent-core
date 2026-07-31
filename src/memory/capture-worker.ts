import type { ExtractorPort, JobQueuePort, SourceLoaderPort } from "./ports.js";
import type { PolicyGatePort } from "./policy/policy-engine.js";
import type { MemoryService } from "./memory-service.js";
import type { MemoryLifecycle } from "./lifecycle.js";
import type { MemoryProvenance, SourceReference, WarmMemory } from "./types.js";

const leaseMs = 30_000;

export class MemoryCaptureWorker {
  constructor(private readonly jobs:JobQueuePort,private readonly source:SourceLoaderPort,private readonly extractor:ExtractorPort,private readonly policy:PolicyGatePort,private readonly service:MemoryService,private readonly lifecycle?:MemoryLifecycle,private readonly owner=`memory-worker:${process.pid}`,private readonly onEvent?:(event:{type:string;sourceRefs:SourceReference[];data:Record<string,unknown>})=>void){}
  async runOnce(){
    const job=await this.jobs.claim(this.owner,leaseMs);if(!job)return false;
    const leaseToken=job.leaseToken,fencingToken=job.fencingToken;
    if(!leaseToken||fencingToken===undefined)throw new Error("Capture job claim did not return fencing credentials");
    let leaseLost=false;
    const heartbeat=setInterval(()=>{void this.jobs.renew(job.id,this.owner,leaseToken,fencingToken,leaseMs).then((ok)=>{if(!ok)leaseLost=true;}).catch(()=>{leaseLost=true;});},Math.floor(leaseMs/3));heartbeat.unref?.();
    const finish=async(operation:()=>Promise<boolean>)=>{if(leaseLost)return false;return operation();};
    try{
      const scope=job.request.access.scopes[0];let content=job.request.content??"";if(!content)content=await this.source.load(job.request.access,job.request.sourceRefs);
      const decision=await this.policy.evaluate("source_egress",job.request.access,{text:content,scope});
      if(decision.action!=="allow"&&decision.action!=="transform"){await finish(()=>this.jobs.fail(job.id,this.owner,leaseToken,fencingToken,"source_policy_rejected",false));return true;}
      const proposal=applyProvenance(await this.extractor.extract(decision.payload.text,job.request.sourceRefs,scope),job.request.provenance);
      if(leaseLost)return true;
      const integrated=this.lifecycle?await this.lifecycle.integrate(job.request.access,proposal):proposal;
      if(leaseLost)return true;
      const persisted=await this.service.persistExtracted(job.request.access,integrated.records,integrated.topics,proposal.nodes,proposal.edges);
      const completed=await finish(()=>this.jobs.complete(job.id,this.owner,leaseToken,fencingToken,{proposalCount:proposal.records.length,persistedCount:persisted.length}));
      if(completed)this.onEvent?.({type:proposal.records.length?"memory.capture.completed":"memory.capture.empty",sourceRefs:job.request.sourceRefs,data:{jobId:job.id,attempts:job.attempts,proposalCount:proposal.records.length,persistedCount:persisted.length,latencyMs:Date.now()-job.createdAt,errorCode:proposal.records.length?undefined:"zero_proposals"}});
      return true;
    }catch(error){const errorCode=error instanceof Error?error.name:"capture_error";const failed=await finish(()=>this.jobs.fail(job.id,this.owner,leaseToken,fencingToken,errorCode,true));if(failed)this.onEvent?.({type:"memory.capture.failed",sourceRefs:job.request.sourceRefs,data:{jobId:job.id,attempts:job.attempts,errorCode,latencyMs:Date.now()-job.createdAt}});return true;}finally{clearInterval(heartbeat);}
  }
}

function applyProvenance(proposal:{records:WarmMemory[];topics:any[];nodes:any[];edges:any[]},provenance?:MemoryProvenance){
  if(!provenance)return proposal;
  return{...proposal,records:proposal.records.map((record)=>({...record,provenance,status:provenance.evidenceClass==="assistant_inference"?"quarantined":record.status,confidence:Math.min(record.confidence,trustCeiling(provenance))}))};
}
function trustCeiling(provenance:MemoryProvenance){return provenance.trustLevel==="high"?1:provenance.trustLevel==="medium"?.85:provenance.trustLevel==="low"?.6:.3;}
