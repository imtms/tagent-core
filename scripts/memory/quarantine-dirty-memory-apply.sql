\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE IF NOT EXISTS memory.quarantine_log (
  id bigserial PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  reason text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at bigint NOT NULL,
  UNIQUE(entity_type,entity_id,reason)
);

CREATE TEMP TABLE dirty_records AS
SELECT r.*,
  CASE
    WHEN provenance->>'evidenceClass'='task_outcome' THEN 'task_outcome_control_plane'
    WHEN title ~* '^(Goal|Outcome):|^(TaskRun )?(completed|blocked|failed)|^Verified check|^Published artifact' OR content ~* '^(Goal|Outcome):|^(TaskRun )?(completed|blocked|failed)|^Verified check|^Published artifact' THEN 'control_plane_wrapper'
    WHEN title ~* '(PASS|FAIL|bytes|字节|文件大小|已发布|制品)' OR content ~* '(PASS|FAIL|[0-9]+[ ]*(bytes|字节)|file:///|已发布制品|已存在)' THEN 'runtime_metadata'
    WHEN content ~ '(不仍|不与.{0,80}(存在|发生).{0,30}(冲突|风险)|不评价.{0,80}(混乱|杂乱))' THEN 'malformed_negation'
    WHEN content ~ '^(问题[:：]|为什么|为何|怎么|如何|是否|请|帮我|检查|审计|排查|修复|分析)' OR title ~ '^Fact: 问题' OR content ~ '(组织架构如下).*(分析并记录)' THEN 'question_or_request'
  END reason
FROM memory.records r
WHERE scope_type='workspace' AND scope_id='personal-memory-v1' AND status='active';
DELETE FROM dirty_records WHERE reason IS NULL;

INSERT INTO memory.quarantine_log(entity_type,entity_id,reason,snapshot,created_at)
SELECT 'record',id::text,reason,to_jsonb(dirty_records),(extract(epoch FROM clock_timestamp())*1000)::bigint FROM dirty_records
ON CONFLICT DO NOTHING;

UPDATE memory.records r SET status='quarantined',updated_at=(extract(epoch FROM clock_timestamp())*1000)::bigint
FROM dirty_records d WHERE r.id=d.id;
DELETE FROM memory.embeddings WHERE ref_id IN (SELECT id::text FROM dirty_records);

INSERT INTO memory.topics(topic_id,kind,scope_type,scope_id,title,description,aliases,entity_ids,related_topic_ids,current_cold_revision,embedding_text,status,updated_at)
VALUES('workspace.personal-memory-v1.knowledge.company-org-structure','fact','workspace','personal-memory-v1','某公司组织架构','某公司的直接汇报关系',ARRAY['组织架构','公司架构','汇报关系','共同上级','实习生E','实习生F'],ARRAY[]::text[],ARRAY[]::text[],NULL,'某公司组织架构 直接汇报关系 首席执行官 运营总监 战略总监 主管C 主管D 研究员A 研究员B 实习生E 实习生F','active',(extract(epoch FROM clock_timestamp())*1000)::bigint)
ON CONFLICT(topic_id) DO UPDATE SET title=excluded.title,description=excluded.description,aliases=excluded.aliases,embedding_text=excluded.embedding_text,status='active',updated_at=excluded.updated_at;

UPDATE memory.records SET topic_ids=ARRAY['workspace.personal-memory-v1.knowledge.company-org-structure'],updated_at=(extract(epoch FROM clock_timestamp())*1000)::bigint
WHERE scope_type='workspace' AND scope_id='personal-memory-v1' AND status='active'
  AND source_refs @> '[{"sourceType":"message","sourceId":"45"}]'::jsonb
  AND content ~ '(管理|汇报给|直属上级)';

UPDATE memory.topics t SET status='quarantined',updated_at=(extract(epoch FROM clock_timestamp())*1000)::bigint
WHERE scope_type='workspace' AND scope_id='personal-memory-v1' AND status='active'
  AND topic_id<>'workspace.personal-memory-v1.knowledge.company-org-structure'
  AND NOT EXISTS (
    SELECT 1 FROM memory.records r WHERE r.status='active' AND t.topic_id=ANY(r.topic_ids)
    UNION ALL SELECT 1 FROM memory.preferences p WHERE p.status='active' AND t.topic_id=ANY(p.topic_ids)
  );

UPDATE memory.topics SET title='User identity and preferred name',description='用户姓名或称呼是 TMs',aliases=ARRAY['我是谁','我叫什么','我的名字','用户姓名','用户称呼','名字','姓名','称呼','who am i','what is my name','my name'],embedding_text='用户身份 姓名 名字 称呼 TMs who am i my name',status='active',updated_at=(extract(epoch FROM clock_timestamp())*1000)::bigint
WHERE topic_id='workspace.personal-memory-v1.fact.user-profile.identity';

SELECT count(*) AS quarantined_records FROM dirty_records;
SELECT count(*) AS canonical_org_records FROM memory.records WHERE status='active' AND 'workspace.personal-memory-v1.knowledge.company-org-structure'=ANY(topic_ids);
COMMIT;
