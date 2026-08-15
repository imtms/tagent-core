import { afterEach, describe, expect, it } from "vitest";
import { DistillationWorker, WorkflowLearningService } from "@tagent/learning";
import { Store } from "@tagent/persistence-sqlite";
import { workflowPersistence } from "./support/test-persistence.js";

const stores:Store[]=[];afterEach(()=>stores.splice(0).forEach(store=>store.close()));
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

describe("automatic distillation worker operations",()=>{
  it("starts on a schedule, processes queued work, and exposes readiness and metrics",async()=>{
    const store=new Store(":memory:");stores.push(store);const service=new WorkflowLearningService(workflowPersistence(store));const session=store.createSession();
    for(let i=0;i<2;i++){const run=store.createRun(session.id,"verify release");service.recordExperience({scopeId:session.id,runId:run.id,attempt:1,sourceType:"task_experience",taskSignature:"verify release",procedureSummary:"1. Run tests",checksPassed:["tests"]});}
    service.enqueueDistillation(session.id,"verify release");const worker=new DistillationWorker(service,5,"test-worker");worker.start();
    for(let i=0;i<40&&(store.db.prepare("SELECT status FROM workflow_distillation_jobs").get() as {status:string}).status!=="completed";i++)await sleep(5);
    const snapshot=worker.snapshot();expect(snapshot).toMatchObject({running:true,ready:true,owner:"test-worker",metrics:{completed:1}});await worker.close();expect(worker.snapshot().ready).toBe(false);
  });

  it("lists dead letters and repairs them for retry",()=>{
    const store=new Store(":memory:");stores.push(store);const service=new WorkflowLearningService(workflowPersistence(store));const session=store.createSession();service.enqueueDistillation(session.id,"broken");
    const job=store.db.prepare("SELECT id FROM workflow_distillation_jobs").get() as {id:string};store.db.prepare("UPDATE workflow_distillation_jobs SET status='dead_letter',attempts=3,error='bad input'").run();
    expect(service.listDeadLetterJobs()).toHaveLength(1);service.retryDistillationJob(job.id,{taskSignature:"repaired task"});
    expect(store.db.prepare("SELECT status,attempts,error,task_signature taskSignature FROM workflow_distillation_jobs WHERE id=?").get(job.id)).toEqual({status:"queued",attempts:0,error:"",taskSignature:"repaired task"});
  });
});
