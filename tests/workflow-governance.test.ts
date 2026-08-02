import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/store.js";
import { WorkflowService, type WorkflowSpec } from "../src/learning/workflow-service.js";
import { requiredServiceScope } from "../src/auth.js";

const stores: Store[]=[]; const fixture=()=>{const store=new Store(":memory:");stores.push(store);return{store,workflows:new WorkflowService(store)}};
afterEach(()=>stores.splice(0).forEach(store=>store.close()));
const spec:WorkflowSpec={name:"Verify change",intent:"verify a change",cueTerms:["verify"],applicability:["verify change"],nonApplicability:[],preconditions:[],inputContract:[],outputContract:[],steps:[{stepId:"check",instruction:"Run check",required:true}],verification:[{check:"target check",required:true,successCondition:"passes"}],requiredCapabilities:[],riskClass:"low"};
const activate=(workflows:WorkflowService,workflowId:string)=>{const approval=workflows.requestActivation(workflowId,undefined,"test");workflows.decideApproval(approval.id,"approved","test");workflows.executeApproval(approval.id,"test");};

describe("workflow safety and governance",()=>{
  it("separates teaching and governance credentials",()=>{
    expect(requiredServiceScope("POST","/api/sessions/s1/workflows/teach")).toBe("workflows:teach");
    expect(requiredServiceScope("POST","/api/workflows/w1/activate")).toBe("workflows:approve");
    expect(requiredServiceScope("POST","/api/workflow-proposals/p1/apply")).toBe("workflows:approve");
  });
  it("projects transition outcomes through an idempotent outbox",()=>{
    const{store,workflows}=fixture();const session=store.createSession();const run=store.createRun(session.id,"failed setup");
    store.transitionRun(run.id,["running"],"failed","run.failed",{reason:"runtime_initialization_failed"},"setup failed",1);
    expect(store.listPendingLearningProjections()).toHaveLength(1);
    workflows.drainProjectionOutbox();workflows.drainProjectionOutbox();
    expect(store.db.prepare("SELECT lifecycle,outcome FROM experience_observations WHERE run_id=?").get(run.id)).toEqual({lifecycle:"run.failed",outcome:"failed"});
    expect(store.db.prepare("SELECT COUNT(*) count FROM experience_observations WHERE run_id=?").get(run.id)).toEqual({count:1});
    expect(store.db.prepare("SELECT status FROM learning_projection_outbox WHERE run_id=?").get(run.id)).toEqual({status:"completed"});
  });
  it("records structured application and requires explicit verification mapping",()=>{
    const{store,workflows}=fixture();const session=store.createSession();const run=store.createRun(session.id,"verify change");
    const workflow=workflows.teach(session.id,spec,"message:1");activate(workflows,workflow.id);
    const recalled=workflows.recall(session.id,"verify change",run.id,1);const bindingId=recalled.workflows[0].bindingId;
    workflows.recordApplication({bindingId,status:"partial",executedStepIds:["check"],skippedSteps:[{stepId:"optional",reason:"not applicable"}],correctionObserved:true,repeatedToolCalls:2,continuationCount:1});
    store.upsertCheck(run.id,{key:"other",title:"Other required check",status:"passed",required:true,command:"test",evidence:"ok",stale:false});
    store.finalizeRun(run.id,"completed");workflows.recordRunApplications(store.getRun(run.id)!);
    expect(store.db.prepare("SELECT application_status status,attribution_level attribution,executed_step_ids_json steps,skipped_steps_json skipped,correction_observed correction,repeated_tool_calls repeats,continuation_count continuations FROM workflow_application_receipts WHERE binding_id=?").get(bindingId)).toMatchObject({status:"partial",attribution:"adopted",steps:'["check"]',correction:1,repeats:2,continuations:1});
    workflows.recordApplication({bindingId,status:"adopted",executedStepIds:["check"],verificationMapping:[{verificationCheck:"target check",runCheckKey:"other"}]});
    workflows.recordRunApplications(store.getRun(run.id)!);
    expect(store.db.prepare("SELECT attribution_level attribution FROM workflow_application_receipts WHERE binding_id=?").get(bindingId)).toEqual({attribution:"verified_contribution"});
  });
  it("requires a non-empty proposal patch, real diff, and changing spec hash on create, approve, and apply",()=>{
    const{store,workflows}=fixture();const session=store.createSession();const run=store.createRun(session.id,"verify change");
    const workflow=workflows.teach(session.id,spec,"message:1");activate(workflows,workflow.id);
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
