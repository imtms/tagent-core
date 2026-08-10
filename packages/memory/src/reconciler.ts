import type { BlobStorePort, TopicCatalogPort } from "./ports.js";
import type { AccessContext } from "./types.js";
export class ColdStorageReconciler {
  constructor(private readonly topics:TopicCatalogPort,private readonly blobs:BlobStorePort){}
  async verify(access:AccessContext,topicIds:string[]){const missing:string[]=[];for(let offset=0;offset<topicIds.length;offset+=8)await Promise.all(topicIds.slice(offset,offset+8).map(async(topicId)=>{const revision=await this.topics.getCurrentRevision(topicId,access.scopes);if(revision&&!(await this.blobs.exists(revision.objectKey)))missing.push(topicId);}));return{checked:topicIds.length,missing};}
  async cleanupStaged(maxAgeMs=300_000){const revisions=await this.topics.listStagedRevisions(Date.now()-maxAgeMs,100);let removed=0;for(const revision of revisions){await this.blobs.delete(revision.objectKey).catch(()=>undefined);await this.topics.abandonRevision(revision.id);removed++;}return{checked:revisions.length,removed};}
  async purgeExpired(access:AccessContext,limit=100){if(!this.topics.listPurgeableTopics||!this.topics.purgeTopics)return{checked:0,removed:0};const rows=await this.topics.listPurgeableTopics(access.scopes,Date.now(),limit);let removed=0;for(const row of rows){for(const revision of row.revisions)await this.blobs.delete(revision.objectKey);removed+=await this.topics.purgeTopics([row.topicId],access.scopes);}return{checked:rows.length,removed};}
}
