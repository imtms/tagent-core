import type { ExtractorPort, JobQueuePort, SourceLoaderPort } from "./ports.js";
import type { PolicyGatePort } from "./policy/policy-engine.js";
import type { MemoryService } from "./memory-service.js";
export class MemoryCaptureWorker {
  constructor(private readonly jobs:JobQueuePort,private readonly source:SourceLoaderPort,private readonly extractor:ExtractorPort,private readonly policy:PolicyGatePort,private readonly service:MemoryService,private readonly owner=`memory-worker:${process.pid}`){}
  async runOnce(){const job=await this.jobs.claim(this.owner,30_000);if(!job)return false;try{const scope=job.request.access.scopes[0];let content=job.request.content??"";if(!content)content=await this.source.load(job.request.access,job.request.sourceRefs);const decision=await this.policy.evaluate("source_egress",job.request.access,{text:content,scope});if(decision.action!=="allow"&&decision.action!=="transform"){await this.jobs.fail(job.id,"source_policy_rejected",false);return true;}const proposal=await this.extractor.extract(decision.payload.text,job.request.sourceRefs,scope);await this.service.persistExtracted(job.request.access,proposal.records,proposal.topics);await this.jobs.complete(job.id);return true;}catch(error){await this.jobs.fail(job.id,error instanceof Error?error.name:"capture_error",true);return true;}}
}
