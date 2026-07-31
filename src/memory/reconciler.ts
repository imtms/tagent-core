import type { BlobStorePort, TopicCatalogPort } from "./ports.js";
import type { AccessContext } from "./types.js";
export class ColdStorageReconciler { constructor(private readonly topics:TopicCatalogPort,private readonly blobs:BlobStorePort){} async verify(access:AccessContext,topicIds:string[]){const missing:string[]=[];for(const topicId of topicIds){const revision=await this.topics.getCurrentRevision(topicId,access.scopes);if(revision&&!(await this.blobs.exists(revision.objectKey)))missing.push(topicId);}return{checked:topicIds.length,missing};}}
