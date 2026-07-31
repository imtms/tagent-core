import type { BlobStorePort, TopicCatalogPort } from "./ports.js";
import type { AccessContext } from "./types.js";
export class ColdStorageReconciler {
  constructor(private readonly topics:TopicCatalogPort,private readonly blobs:BlobStorePort){}
  async verify(access:AccessContext,topicIds:string[]){const missing:string[]=[];for(const topicId of topicIds){const revision=await this.topics.getCurrentRevision(topicId,access.scopes);if(revision&&!(await this.blobs.exists(revision.objectKey)))missing.push(topicId);}return{checked:topicIds.length,missing};}
  async cleanupStaged(maxAgeMs=300_000){const revisions=await this.topics.listStagedRevisions(Date.now()-maxAgeMs,100);let removed=0;for(const revision of revisions){await this.blobs.delete(revision.objectKey).catch(()=>undefined);await this.topics.abandonRevision(revision.id);removed++;}return{checked:revisions.length,removed};}
}
