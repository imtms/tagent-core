import type { AccessContext } from "./types.js";
import type { MemoryCaptureWorker } from "./capture-worker.js";
import type { MemoryConsolidator } from "./consolidator.js";
import type { MemoryLifecycle } from "./lifecycle.js";
import type { ColdStorageReconciler } from "./reconciler.js";

export class LocalMemoryWorker {
  private running=false; private captureTimer?:ReturnType<typeof setInterval>; private maintenanceTimer?:ReturnType<typeof setInterval>;
  constructor(private readonly capture:MemoryCaptureWorker,private readonly lifecycle:MemoryLifecycle,private readonly consolidator:MemoryConsolidator,private readonly reconciler:ColdStorageReconciler,private readonly access:AccessContext,private readonly captureIntervalMs:number,private readonly maintenanceIntervalMs:number){}
  start(){if(this.captureTimer)return;this.captureTimer=setInterval(()=>void this.captureTick(),this.captureIntervalMs);this.maintenanceTimer=setInterval(()=>void this.maintenanceTick(),this.maintenanceIntervalMs);this.captureTimer.unref?.();this.maintenanceTimer.unref?.();void this.captureTick();void this.maintenanceTick();}
  stop(){if(this.captureTimer)clearInterval(this.captureTimer);if(this.maintenanceTimer)clearInterval(this.maintenanceTimer);this.captureTimer=undefined;this.maintenanceTimer=undefined;}
  async captureTick(){if(this.running)return false;this.running=true;try{let count=0;while(count<20&&await this.capture.runOnce())count++;return count>0;}finally{this.running=false;}}
  async maintenanceTick(){if(this.running)return false;this.running=true;try{await this.lifecycle.promote(this.access);const candidates=await this.lifecycle.topicCandidates(this.access);for(const topic of candidates.slice(0,20))await this.consolidator.consolidate(this.access,topic.topicId);await this.reconciler.verify(this.access,candidates.map((x)=>x.topicId));await this.reconciler.cleanupStaged();return true;}finally{this.running=false;}}
}
