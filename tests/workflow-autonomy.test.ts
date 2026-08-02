import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/store.js";
import { WorkflowService, type WorkflowSpec } from "../src/learning/workflow-service.js";
import { requiredServiceScope } from "../src/auth.js";

const stores: Store[]=[];
afterEach(()=>stores.splice(0).forEach(store=>store.close()));
const fixture=()=>{const store=new Store(":memory:");stores.push(store);const session=store.createSession();return{store,session,service:new WorkflowService(store,"secret")}};
const spec:WorkflowSpec={name:"Review safely",intent:"review a safe change",cueTerms:["review"],applicability:["review change"],nonApplicability:[],preconditions:[],inputContract:[],outputContract:[],steps:[{stepId:"inspect",instruction:"Inspect the change",required:true}],verification:[{check:"review",required:true,successCondition:"passes"}],requiredCapabilities:[],riskClass:"low"};
function approveAndExecuteActivation(service:WorkflowService,workflowId:string){const request=service.requestActivation(workflowId);service.decideApproval(request.id,"approved","human","reviewed");return service.executeApproval(request.id,"human");}

describe("tiered autonomy governance",()=>{
  it("allows observation and distillation while retaining evolved workflows as candidates",()=>{
    const{store,session,service}=fixture();
    for(let index=0;index<2;index++){const run=store.createRun(session.id,"review change");store.upsertPlanItem(run.id,{key:"inspect",title:"Inspect the change",status:"done",required:true,position:1});store.upsertCheck(run.id,{key:"review",title:"review",status:"passed",required:true,command:"test",evidence:"fresh",stale:false});store.finalizeRun(run.id,"completed");service.projectRun(store.getRun(run.id)!,"completed");}
    const job=service.runNextDistillationJob("test-worker");expect(job?.status).toBe("candidate");expect(job?.activeRevisionId).toBeNull();
    expect(service.listAutonomyAudit(session.id).some(item=>item.category==="observe")).toBe(true);
    expect(service.listAutonomyAudit(session.id).some(item=>item.action==="workflow_candidate_created")).toBe(true);
  });

  it("blocks activation without approval, then executes only after separate human approval",()=>{
    const{session,service}=fixture();const workflow=service.teach(session.id,spec,"message:1");
    expect(()=>service.activate(workflow.id)).toThrow("Human approval");
    const request=service.requestActivation(workflow.id,workflow.revision!.id,"system","candidate ready");
    expect(service.getWorkflow(workflow.id)?.status).toBe("candidate");
    service.decideApproval(request.id,"approved","human","evidence reviewed");
    expect(service.getWorkflow(workflow.id)?.status).toBe("candidate");
    service.executeApproval(request.id,"human");
    expect(service.getWorkflow(workflow.id)?.status).toBe("active");expect(service.getApproval(request.id)?.status).toBe("executed");
  });

  it("never executes rejected, revoked, or expired approvals",()=>{
    const{store,session,service}=fixture();const workflow=service.teach(session.id,spec,"message:1");
    const rejected=service.requestActivation(workflow.id);service.decideApproval(rejected.id,"rejected","human","no");expect(()=>service.executeApproval(rejected.id,"human")).toThrow("Approved request");
    const revoked=service.requestActivation(workflow.id,undefined,"system","retry");service.decideApproval(revoked.id,"approved","human","yes");service.revokeApproval(revoked.id,"human","withdrawn");expect(()=>service.executeApproval(revoked.id,"human")).toThrow("Approved request");
    const expiring=service.requestActivation(workflow.id,undefined,"system","expires",60_000);store.db.prepare("UPDATE autonomy_approval_requests SET expires_at=? WHERE id=?").run(Date.now()-1,expiring.id);expect(()=>service.executeApproval(expiring.id,"human")).toThrow("Approved request");expect(service.getApproval(expiring.id)?.status).toBe("expired");
  });

  it("requires a second approval to apply an approved revision proposal",()=>{
    const{session,service}=fixture();const workflow=service.teach(session.id,spec,"message:1");approveAndExecuteActivation(service,workflow.id);
    const proposal=service.createProposal(workflow.id,workflow.revision!.id,{nonApplicability:["production deletion"]},"correction") as {id:string};
    service.decideProposal(proposal.id,"approved","governor","valid candidate");
    expect(()=>service.applyProposal(proposal.id,"governor")).toThrow("Human approval");
    const approval=service.requestProposalApplication(proposal.id,"governor");service.decideApproval(approval.id,"approved","human","diff reviewed");service.executeApproval(approval.id,"human");
    expect(service.listProposals(session.id)[0]).toMatchObject({status:"applied"});
    expect(service.getWorkflow(workflow.id)?.activeRevisionId).toBe(workflow.revision!.id);
  });

  it("separates learning governance from human approval permissions",()=>{
    expect(requiredServiceScope("POST","/api/workflows/w/activation-request")).toBe("workflows:govern");
    expect(requiredServiceScope("POST","/api/workflows/w/activate")).toBe("workflows:approve");
    expect(requiredServiceScope("POST","/api/autonomy-approvals/a/approve")).toBe("workflows:approve");
    expect(requiredServiceScope("POST","/api/workflow-proposals/p/apply")).toBe("workflows:approve");
  });
});
