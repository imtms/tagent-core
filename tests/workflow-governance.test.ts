import { afterEach, describe, expect, it } from "vitest";
import { WorkflowLearningService } from "@tagent/learning";
import type { WorkflowSpec } from "@tagent/learning/domain";
import {
  decodeIntegrationLearningProjection,
  type IntegrationLearningProjectionRecord,
} from "@tagent/learning/domain";
import { Store } from "@tagent/persistence-sqlite";
import { transitionTaskRun, workflowPersistence } from "./support/test-persistence.js";

const stores: Store[]=[]; const fixture=()=>{const store=new Store(":memory:");stores.push(store);return{store,workflows:new WorkflowLearningService(workflowPersistence(store))}};
afterEach(()=>stores.splice(0).forEach(store=>store.close()));
const spec:WorkflowSpec={name:"Verify change",intent:"verify a change",cueTerms:["verify"],applicability:["verify change"],nonApplicability:[],preconditions:[],inputContract:[],outputContract:[],steps:[{stepId:"check",instruction:"Run check",required:true}],verification:[{check:"target check",required:true,successCondition:"passes"}],requiredCapabilities:[],riskClass:"low"};
const activate=(store:Store,workflows:WorkflowLearningService,workflowId:string)=>{
  const revisionId=workflows.getWorkflow(workflowId,true)!.revision!.id;
  store.db.prepare("UPDATE workflow_definitions SET status='active',active_revision_id=?,updated_at=? WHERE id=?").run(revisionId,Date.now(),workflowId);
};

describe("workflow safety and governance",()=>{
  it("projects transition outcomes through the idempotent integration stream",()=>{
    const{store,workflows}=fixture();const session=store.createSession();const run=store.createRun(session.id,"failed setup");
    store.transitionRun(run.id,["running"],"failed","run.failed",{reason:"runtime_initialization_failed"},"setup failed",1);
    const record=store.db.prepare(`SELECT outbox_sequence as outboxSequence,
      source_event_id as sourceEventId,payload_hash as payloadHash,aggregate_id as aggregateId,
      aggregate_version as aggregateVersion,run_event_ref as runEventRef,attempt_id as attemptId,
      attempt_ordinal as attemptOrdinal,payload_json as payloadJson,
      evidence_snapshot_json as evidenceSnapshotJson FROM integration_outbox`).get() as IntegrationLearningProjectionRecord;
    const projection=decodeIntegrationLearningProjection(record);
    workflows.applyActiveProjection(projection);workflows.applyActiveProjection(projection);
    expect(store.db.prepare("SELECT lifecycle,outcome FROM experience_observations WHERE run_id=?").get(run.id)).toEqual({lifecycle:"run.failed",outcome:"failed"});
    expect(store.db.prepare("SELECT COUNT(*) count FROM experience_observations WHERE run_id=?").get(run.id)).toEqual({count:1});
    expect(store.db.prepare("SELECT COUNT(*) count FROM integration_outbox WHERE aggregate_id=?").get(run.id)).toEqual({count:1});
  });
  it("records structured application and requires explicit verification mapping",()=>{
    const{store,workflows}=fixture();const session=store.createSession();const run=store.createRun(session.id,"verify change");
    const workflow=workflows.teach(session.id,spec,"message:1");activate(store,workflows,workflow.id);
    const recalled=workflows.recall(session.id,"verify change",run.id,1);const bindingId=recalled.workflows[0].bindingId;
    workflows.recordApplication({bindingId,status:"partial",executedStepIds:["check"],skippedSteps:[{stepId:"optional",reason:"not applicable"}],correctionObserved:true,repeatedToolCalls:2,continuationCount:1});
    store.upsertCheck(run.id,{key:"other",title:"Other required check",status:"passed",required:true,command:"test",evidence:"ok",stale:false});
    transitionTaskRun(store,run.id,"complete");workflows.recordRunApplications(store.getRun(run.id)!);
    expect(store.db.prepare("SELECT application_status status,attribution_level attribution,executed_step_ids_json steps,skipped_steps_json skipped,correction_observed correction,repeated_tool_calls repeats,continuation_count continuations FROM workflow_application_receipts WHERE binding_id=?").get(bindingId)).toMatchObject({status:"partial",attribution:"adopted",steps:'["check"]',correction:1,repeats:2,continuations:1});
    workflows.recordApplication({bindingId,status:"adopted",executedStepIds:["check"],verificationMapping:[{verificationCheck:"target check",runCheckKey:"other"}]});
    workflows.recordRunApplications(store.getRun(run.id)!);
    expect(store.db.prepare("SELECT attribution_level attribution FROM workflow_application_receipts WHERE binding_id=?").get(bindingId)).toEqual({attribution:"verified_contribution"});
  });
  it("requires a non-empty proposal patch, real diff, and changing spec hash on create, approve, and apply",()=>{
    const{store,workflows}=fixture();const session=store.createSession();const run=store.createRun(session.id,"verify change");
    const workflow=workflows.teach(session.id,spec,"message:1");activate(store,workflows,workflow.id);
    expect(()=>workflows.createProposal(workflow.id,workflow.revision!.id,{},"empty")).toThrow("non-empty");
    expect(()=>workflows.createProposal(workflow.id,workflow.revision!.id,{name:spec.name},"same")).toThrow("non-empty revision diff");
    workflows.feedback({workflowId:workflow.id,revisionId:workflow.revision!.id,runId:run.id,attempt:1,signal:"corrected",idempotencyKey:"correction:1",note:"exclude production deletion"});
    const proposal=workflows.listProposals(session.id)[0] as {id:string;patchJson:string;baseSpecHash:string;proposedSpecHash:string};
    expect(JSON.parse(proposal.patchJson)).not.toEqual({});expect(proposal.baseSpecHash).not.toBe(proposal.proposedSpecHash);
    store.db.prepare("UPDATE workflow_revision_proposals SET patch_json='{}' WHERE id=?").run(proposal.id);
    expect(()=>workflows.decideProposal(proposal.id,"approved","admin","reviewed")).toThrow("non-empty");
    store.db.prepare("UPDATE workflow_revision_proposals SET patch_json=? WHERE id=?").run(JSON.stringify({nonApplicability:["exclude production deletion"]}),proposal.id);
    workflows.decideProposal(proposal.id,"approved","admin","reviewed");
    store.db.prepare("UPDATE workflow_revision_proposals SET proposed_spec_hash='forged' WHERE id=?").run(proposal.id);
    expect(()=>workflows.requestProposalApplication(proposal.id,"admin")).toThrow("spec hash");
  });
});
