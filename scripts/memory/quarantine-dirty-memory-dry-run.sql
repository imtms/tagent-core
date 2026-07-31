\set ON_ERROR_STOP on
\pset pager off
\echo '=== Unambiguous control-plane / malformed records proposed for quarantine ==='
WITH candidates AS (
  SELECT id::text,kind,status,title,content,topic_ids,
    CASE
      WHEN provenance->>'evidenceClass'='task_outcome' THEN 'task_outcome_control_plane'
      WHEN title ~* '^(Goal|Outcome):|^(TaskRun )?(completed|blocked|failed)|^Verified check|^Published artifact' OR content ~* '^(Goal|Outcome):|^(TaskRun )?(completed|blocked|failed)|^Verified check|^Published artifact' THEN 'control_plane_wrapper'
      WHEN title ~* '(PASS|FAIL|bytes|字节|文件大小|已发布|制品)' OR content ~* '(PASS|FAIL|[0-9]+[ ]*(bytes|字节)|file:///|已发布制品|已存在)' THEN 'runtime_metadata'
      WHEN content ~ '(不仍|不与.{0,80}(存在|发生).{0,30}(冲突|风险)|不评价.{0,80}(混乱|杂乱))' THEN 'malformed_negation'
      WHEN content ~ '^(问题[:：]|为什么|为何|怎么|如何|是否|请|帮我|检查|审计|排查|修复|分析)' OR title ~ '^Fact: 问题' OR content ~ '(组织架构如下).*(分析并记录)' THEN 'question_or_request'
    END reason
  FROM memory.records
  WHERE scope_type='workspace' AND scope_id='personal-memory-v1' AND status='active'
)
SELECT reason,count(*) count FROM candidates WHERE reason IS NOT NULL GROUP BY reason ORDER BY reason;

WITH candidates AS (
  SELECT id::text,kind,title,content,topic_ids,
    CASE
      WHEN provenance->>'evidenceClass'='task_outcome' THEN 'task_outcome_control_plane'
      WHEN title ~* '^(Goal|Outcome):|^(TaskRun )?(completed|blocked|failed)|^Verified check|^Published artifact' OR content ~* '^(Goal|Outcome):|^(TaskRun )?(completed|blocked|failed)|^Verified check|^Published artifact' THEN 'control_plane_wrapper'
      WHEN title ~* '(PASS|FAIL|bytes|字节|文件大小|已发布|制品)' OR content ~* '(PASS|FAIL|[0-9]+[ ]*(bytes|字节)|file:///|已发布制品|已存在)' THEN 'runtime_metadata'
      WHEN content ~ '(不仍|不与.{0,80}(存在|发生).{0,30}(冲突|风险)|不评价.{0,80}(混乱|杂乱))' THEN 'malformed_negation'
      WHEN content ~ '^(问题[:：]|为什么|为何|怎么|如何|是否|请|帮我|检查|审计|排查|修复|分析)' OR title ~ '^Fact: 问题' OR content ~ '(组织架构如下).*(分析并记录)' THEN 'question_or_request'
    END reason
  FROM memory.records
  WHERE scope_type='workspace' AND scope_id='personal-memory-v1' AND status='active'
)
SELECT reason,id,kind,left(title,100) title,left(content,180) content,topic_ids FROM candidates WHERE reason IS NOT NULL ORDER BY reason,id;

\echo '=== Organization direct relationships to canonicalize ==='
SELECT id,left(content,160) content,topic_ids
FROM memory.records
WHERE scope_type='workspace' AND scope_id='personal-memory-v1' AND status='active'
  AND source_refs @> '[{"sourceType":"message","sourceId":"45"}]'::jsonb
  AND content ~ '(管理|汇报给|直属上级)'
ORDER BY created_at;

\echo '=== Suspected test residence data (REVIEW ONLY; not modified) ==='
SELECT id,status,left(title,100) title,left(content,160) content,topic_ids
FROM memory.records
WHERE scope_type='workspace' AND scope_id='personal-memory-v1'
  AND (title ~* '(Sway|乔哲|前滩|邻居|隔壁)' OR content ~* '(Sway|乔哲|前滩|邻居|隔壁)')
ORDER BY status,created_at;
