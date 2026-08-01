import type { AccessContext } from "./types.js";
import type { MemoryCaptureWorker } from "./capture-worker.js";
import type { MemoryConsolidator } from "./consolidator.js";
import type { MemoryLifecycle } from "./lifecycle.js";
import type { ColdStorageReconciler } from "./reconciler.js";

export class LocalMemoryWorker {
  private captureRunning=false;private maintenanceRunning=false;private captureTimer?:ReturnType<typeof setInterval>;private maintenanceTimer?:ReturnType<typeof setInterval>;private captureTask?:Promise<boolean>;private maintenanceTask?:Promise<boolean>;
  constructor(private readonly capture:MemoryCaptureWorker,private readonly lifecycle:MemoryLifecycle,private readonly consolidator:MemoryConsolidator,private readonly reconciler:ColdStorageReconciler,private readonly access:AccessContext,private readonly captureIntervalMs:number,private readonly maintenanceIntervalMs:number,private readonly onHeartbeat?:()=>void,private readonly onConsolidation?:()=>void){}
  start(){if(this.captureTimer)return;const capture=()=>{this.captureTask=this.captureTick().catch(error=>{console.error("Memory capture tick failed",error);return false;});};const maintenance=()=>{this.maintenanceTask=this.maintenanceTick().catch(error=>{console.error("Memory maintenance tick failed",error);return false;});};this.captureTimer=setInterval(capture,this.captureIntervalMs);this.maintenanceTimer=setInterval(maintenance,this.maintenanceIntervalMs);this.captureTimer.unref?.();this.maintenanceTimer.unref?.();capture();maintenance();}
  async stop(){if(this.captureTimer)clearInterval(this.captureTimer);if(this.maintenanceTimer)clearInterval(this.maintenanceTimer);this.captureTimer=undefined;this.maintenanceTimer=undefined;await Promise.allSettled([this.captureTask,this.maintenanceTask].filter((task):task is Promise<boolean>=>Boolean(task)));}
  async captureTick(){if(this.captureRunning)return false;this.captureRunning=true;this.onHeartbeat?.();try{let count=0;while(count<20&&await this.capture.runOnce())count++;return count>0;}finally{this.captureRunning=false;}}
  async maintenanceTick(){if(this.maintenanceRunning)return false;this.maintenanceRunning=true;this.onHeartbeat?.();try{await this.lifecycle.promote(this.access);const candidates=await this.lifecycle.topicCandidates(this.access);for(const topic of candidates.slice(0,20))await this.consolidator.consolidate(this.access,topic.topicId);await this.reconciler.verify(this.access,candidates.map(x=>x.topicId));await this.reconciler.cleanupStaged();this.onConsolidation?.();return true;}finally{this.maintenanceRunning=false;}}
}
