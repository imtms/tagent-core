import { afterEach, describe, expect, it } from "vitest";
import { WorkflowService } from "@tagent/learning";
import type { WorkflowSpec } from "@tagent/learning/domain";
import { Store } from "@tagent/persistence-sqlite";
import { workflowPersistence } from "./support/test-persistence.js";

const stores: Store[] = [];
const make = () => { const store = new Store(":memory:"); stores.push(store); return { store, service: new WorkflowService(workflowPersistence(store), "test-evaluator-secret") }; };
afterEach(() => stores.splice(0).forEach((store) => store.close()));
const spec: WorkflowSpec = { name:"Evolution",intent:"verify software change",cueTerms:["verify","change"],applicability:["verify change"],nonApplicability:[],preconditions:[],inputContract:[],outputContract:[],steps:[{stepId:"test",instruction:"Run tests",required:true}],verification:[{check:"tests",required:true,successCondition:"pass"}],requiredCapabilities:[],riskClass:"low" };
const activate=(store:Store,service:WorkflowService,workflowId:string)=>{const revisionId=service.getWorkflow(workflowId,true)!.revision!.id;store.db.prepare("UPDATE workflow_definitions SET status='active',active_revision_id=?,updated_at=? WHERE id=?").run(revisionId,Date.now(),workflowId);};

function completedRun(store:Store,sessionId:string,workflowId:string,revisionId:string,index:number,success=true){
  const run=store.createRun(sessionId,`evaluation ${index}`);
  store.db.prepare(`INSERT INTO workflow_bindings (id,run_id,attempt,workflow_id,revision_id,selector_version,relevance_score,selected_reason_json,application_mode,created_at) VALUES (?,?,?,?,?,'evaluator',1,'[]','adopted',?)`).run(`binding-${run.id}`,run.id,1,workflowId,revisionId,Date.now());
  store.upsertCheck(run.id,{key:"tests",title:"tests",status:success?"passed":"failed",required:true,command:"test",evidence:"actual",stale:false});
  store.finalizeRun(run.id,success?"completed":"failed"); return run;
}
function trustedGates(store:Store,service:WorkflowService,sessionId:string,workflowId:string,baselineRevisionId:string,candidateRevisionId:string){
  const baseline=Array.from({length:5},(_,i)=>completedRun(store,sessionId,workflowId,baselineRevisionId,i));
  const candidate=Array.from({length:5},(_,i)=>completedRun(store,sessionId,workflowId,candidateRevisionId,10+i));
  const input={workflowId,candidateRevisionId,baselineRevisionId,datasetId:"fixed-dataset-v1",baselineRunIds:baseline.map(run=>run.id),candidateRunIds:candidate.map(run=>run.id)};
  const shadow=service.executeEvaluation({...input,kind:"shadow"}); const replay=service.executeEvaluation({...input,kind:"offline_replay"}); return {shadow,replay};
}

describe("trusted workflow evaluation and real canary",()=>{
  it("derives immutable receipts from actual bound runs and rejects tampering",()=>{
    const {store,service}=make(); const session=store.createSession(); const workflow=service.teach(session.id,spec,"message:1"); activate(store,service,workflow.id);
    const candidate=service.revise(workflow.id,{steps:[...spec.steps,{stepId:"build",instruction:"Build",required:true}]},"user_correction",["message:2"],"add build");
    const {shadow}=trustedGates(store,service,session.id,workflow.id,workflow.revision!.id,candidate.id);
    expect(shadow.status).toBe("passed"); expect(service.verifyEvaluationReceipt(shadow.id)).toBe(true);
    const receipt=store.db.prepare("SELECT evaluator_id evaluatorId,dataset_hash datasetHash,baseline_revision_id baselineRevisionId,candidate_revision_id candidateRevisionId,evaluation_run_ids_json runIds,check_results_json checks FROM workflow_evaluations WHERE id=?").get(shadow.id) as any;
    expect(receipt).toMatchObject({evaluatorId:"tagent.workflow-evaluator",baselineRevisionId:workflow.revision!.id,candidateRevisionId:candidate.id});
    expect(JSON.parse(receipt.runIds)).toHaveLength(10); expect(JSON.parse(receipt.checks)).toHaveLength(10);
    store.db.prepare("UPDATE workflow_evaluations SET success_rate=0 WHERE id=?").run(shadow.id);
    expect(service.verifyEvaluationReceipt(shadow.id)).toBe(false);
    expect(()=>service.requestPromotion(workflow.id,candidate.id)).toThrow("Trusted shadow");
  });

  it("uses stable buckets, binds real runs, and records durable canary outcomes",()=>{
    const {store,service}=make(); const session=store.createSession(); const workflow=service.teach(session.id,spec,"message:1"); activate(store,service,workflow.id);
    const candidate=service.revise(workflow.id,{steps:[...spec.steps,{stepId:"build",instruction:"Build",required:true}]},"user_correction",["message:2"],"add build");
    trustedGates(store,service,session.id,workflow.id,workflow.revision!.id,candidate.id); service.requestPromotion(workflow.id,candidate.id,25,0.02,"test");const promotion={id:"promotion-fixture"};store.db.prepare("INSERT INTO workflow_promotions (id,workflow_id,revision_id,previous_revision_id,status,canary_percent,max_failure_delta,reason,created_at,updated_at) VALUES (?,?,?,?,'canary',25,0.02,'fixture',?,?)").run(promotion.id,workflow.id,candidate.id,workflow.revision!.id,Date.now(),Date.now());
    const variants:{candidate:string[];baseline:string[]}={candidate:[],baseline:[]};
    for(let i=0;i<200&&(variants.candidate.length<5||variants.baseline.length<5);i++){
      const run=store.createRun(session.id,"verify change"); service.recall(session.id,"verify change",run.id,1); service.recall(session.id,"verify change",run.id,1);
      const binding=store.db.prepare("SELECT variant,bucket,assignment_hash assignmentHash FROM workflow_canary_bindings WHERE run_id=?").get(run.id) as any;
      const repeated=store.db.prepare("SELECT variant,bucket,assignment_hash assignmentHash FROM workflow_canary_bindings WHERE run_id=?").get(run.id) as any;
      expect(repeated).toEqual(binding); variants[binding.variant as "candidate"|"baseline"].push(run.id);
    }
    expect(variants.candidate.length).toBeGreaterThanOrEqual(5); expect(variants.baseline.length).toBeGreaterThanOrEqual(5);
    for(const runId of [...variants.baseline.slice(0,5),...variants.candidate.slice(0,5)]){
      const candidateVariant=variants.candidate.includes(runId); store.upsertCheck(runId,{key:"tests",title:"tests",status:candidateVariant?"failed":"passed",required:true,command:"test",evidence:"actual",stale:false}); store.finalizeRun(runId,candidateVariant?"failed":"completed"); service.recordCanaryOutcome(store.getRun(runId)!);
    }
    expect(store.db.prepare("SELECT status FROM workflow_promotions WHERE id=?").get(promotion.id)).toEqual({status:"canary"});
    expect(store.db.prepare("SELECT COUNT(*) count FROM workflow_canary_bindings WHERE promotion_id=? AND outcome_recorded_at IS NOT NULL").get(promotion.id)).toEqual({count:10});
  });
});
