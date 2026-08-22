import { useEffect, useState } from "react";
import { Check, Pencil, RotateCcw, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import type { PreferenceRecord, WarmMemory } from "./api";
import { ICON_SIZE } from "./icon-size";
import { Markdown } from "./LazyMarkdown";
import { PanelTabs, type PanelTab } from "./PanelTabs";
import {
  formatMemoryDate,
  memoryContent,
  memorySignal,
  memoryTextRepeats,
  memoryTitle,
  memoryTitleRepeatsContent,
  memoryTopicDescriptor,
  type MemoryTopicDetail,
} from "./memory-display";

type RecordDetailSection = "overview" | "metadata" | "controls";
type TopicDetailSection = "overview" | "metadata" | "controls";

export function RecordDetail({
  record,
  onForget,
  onRestore,
  onGovern,
  onCorrect,
  onFeedback,
  busy = false,
}: {
  record: WarmMemory;
  onForget: () => void;
  onRestore: () => void;
  onGovern: (action: "approve" | "reject" | "resolve", resolution?: "accept" | "reject") => void;
  onCorrect: (title: string, content: string, reason: string) => void;
  onFeedback: (signal: "helpful" | "confirmed" | "harmful") => void;
  busy?: boolean;
}) {
  const [correcting, setCorrecting] = useState(false);
  const [title, setTitle] = useState(memoryTitle(record));
  const [content, setContent] = useState(memoryContent(record));
  const [reason, setReason] = useState("");
  const [section, setSection] = useState<RecordDetailSection>(() => record.status === "active" ? "overview" : "controls");
  useEffect(() => {
    setCorrecting(false);
    setTitle(memoryTitle(record));
    setContent(memoryContent(record));
    setReason("");
    setSection(record.status === "active" ? "overview" : "controls");
  }, [record.id, record.updatedAt]);
  const canSaveCorrection = content.trim() && (record.kind === "preference" || title.trim());
  const hasValidity = ("validFrom" in record && Boolean(record.validFrom || record.validTo)) || Boolean(record.supersedesId || record.expiresAt);
  const repeatedContent = memoryTitleRepeatsContent(record);
  const tabs = [
    { value: "overview", label: "Overview" },
    { value: "metadata", label: "Metadata" },
    { value: "controls", label: "Controls", meta: record.status === "active" ? undefined : "Action" },
  ] satisfies readonly PanelTab<RecordDetailSection>[];

  return (
    <div className="memory-detail-content">
      <span className="memory-kind">{record.kind}</span>
      <h3>{repeatedContent ? memoryContent(record) : memoryTitle(record)}</h3>
      <small data-mono>{record.tier} · {record.status} · {Math.round(record.confidence * 100)}% confidence · {Math.round(memorySignal(record) * 100)}% {record.kind === "preference" ? "strength" : "importance"}</small>
      <PanelTabs label="Memory record views" value={section} tabs={tabs} onChange={setSection} />

      <section hidden={section !== "overview"} aria-label="Memory record overview">
        {!repeatedContent && <div className="memory-detail-body"><Markdown>{memoryContent(record)}</Markdown></div>}
        {record.summary && record.summary !== memoryContent(record) && <div><span className="eyebrow">Summary</span><p>{record.summary}</p></div>}
      </section>

      <section hidden={section !== "metadata"} aria-label="Memory metadata and provenance">
        <div className="section-heading"><strong>Metadata and provenance</strong><small>{record.scope.type}:{record.scope.id}</small></div>
        <div className="memory-disclosure-body">
          <section><span data-meta>Record identity</span><div data-mono>{record.id}</div></section>
          {record.kind === "preference" && <section><span data-meta>Preference semantics</span><div>{(record as PreferenceRecord).applicability} · {(record as PreferenceRecord).origin}</div></section>}
          {record.provenance && <section><span data-meta>Source authority</span><div>{record.provenance.evidenceClass.replaceAll("_", " ")} · {record.provenance.trustLevel} trust · {record.provenance.verificationState}{record.provenance.sourceReliability === undefined ? "" : ` · ${Math.round(record.provenance.sourceReliability * 100)}% reliability`}</div></section>}
          {record.semantic && <section><span data-meta>Canonical meaning</span><div data-mono>{record.semantic.subject} · {record.semantic.predicate} · {record.semantic.object} · {record.semantic.polarity}</div></section>}
          {record.lifecycle && <section><span data-meta>Lifecycle</span><div><div>{formatCount(record.lifecycle.confirmationCount, "confirmation")} · {formatCount(record.lifecycle.recallCount ?? 0, "recall")}{record.lifecycle.previousStatus ? ` · restored from ${record.lifecycle.previousStatus}` : ""}{record.lifecycle.deleteReason ? ` · ${record.lifecycle.deleteReason}` : ""}</div><small data-mono>First seen {formatMemoryDate(record.lifecycle.firstSeenAt)} · last seen {formatMemoryDate(record.lifecycle.lastSeenAt)}{record.lifecycle.lastRecalledAt ? ` · last recalled ${formatMemoryDate(record.lifecycle.lastRecalledAt)}` : ""}{record.lifecycle.purgeAfter ? ` · purge after ${formatMemoryDate(record.lifecycle.purgeAfter)}` : ""}</small></div></section>}
          {record.topicIds.length > 0 && <section><span data-meta>Topic routes</span><div className="memory-tags">{record.topicIds.map((topic) => <code key={topic}>{topic}</code>)}</div></section>}
          {record.entityIds.length > 0 && <section><span data-meta>Entities</span><div className="memory-tags">{record.entityIds.map((entity) => <code key={entity}>{entity}</code>)}</div></section>}
          {record.sourceRefs.length > 0 && <section><span data-meta>Provenance</span><div className="memory-source-list">{record.sourceRefs.map((source, index) => <code key={`${source.sourceType}-${source.sourceId}-${index}`}>{source.sourceType}:{source.sourceId}{source.revision ? `@${source.revision}` : ""}</code>)}</div></section>}
          {hasValidity && <section><span data-meta>Validity</span><div data-mono>{"validFrom" in record && record.validFrom ? `from ${formatMemoryDate(record.validFrom)}` : ""}{"validTo" in record && record.validTo ? ` · to ${formatMemoryDate(record.validTo)}` : ""}{record.supersedesId ? ` · supersedes ${record.supersedesId}` : ""}{record.expiresAt ? ` · expires ${formatMemoryDate(record.expiresAt)}` : ""}</div></section>}
        </div>
      </section>

      <section hidden={section !== "controls"} aria-label="Memory controls">
        <div className="section-heading"><strong>Memory controls</strong><small>{record.status === "deleted" ? "Recovery" : "Review, correct, rate or forget"}</small></div>
        <div>
          <div className="memory-inline-actions">
            {record.status === "candidate" && <><button className="control" disabled={busy} onClick={() => onGovern("approve")}><Check size={ICON_SIZE.sm} />Approve</button><button className="control" disabled={busy} onClick={() => onGovern("reject")}>Reject</button></>}
            {record.status === "disputed" && <><button className="control" disabled={busy} onClick={() => onGovern("resolve", "accept")}><Check size={ICON_SIZE.sm} />Resolve as valid</button><button className="control" disabled={busy} onClick={() => onGovern("resolve", "reject")}>Quarantine</button></>}
            {!['active', 'candidate', 'disputed', 'deleted'].includes(record.status) && <button className="control" disabled={busy} onClick={() => onGovern("approve")}><Check size={ICON_SIZE.sm} />Reactivate</button>}
            {record.status !== "deleted" && <button className="control" disabled={busy} onClick={() => setCorrecting((value) => !value)}><Pencil size={ICON_SIZE.sm} />Correct</button>}
            {record.status !== "deleted" && <><button className="control" disabled={busy} onClick={() => onFeedback("confirmed")}><Check size={ICON_SIZE.sm} />Confirm</button><button className="control" disabled={busy} onClick={() => onFeedback("helpful")}><ThumbsUp size={ICON_SIZE.sm} />Helpful</button><button className="control" disabled={busy} onClick={() => onFeedback("harmful")}><ThumbsDown size={ICON_SIZE.sm} />Wrong</button></>}
            {record.status === "deleted" ? <button className="control" disabled={busy} onClick={onRestore}><RotateCcw size={ICON_SIZE.sm} />Restore</button> : <button className="control" data-tone="danger" disabled={busy} onClick={onForget}><Trash2 size={ICON_SIZE.sm} />Forget</button>}
          </div>
          {correcting && <div className="goal-form-columns">
            {record.kind !== "preference" && <label className="goal-field"><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>}
            <label className="goal-field"><span>{record.kind === "preference" ? "Preference value" : "Content"}</span><textarea rows={4} value={content} onChange={(event) => setContent(event.target.value)} /></label>
            <label className="goal-field"><span>Correction reason <small>optional</small></span><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why this memory changed" /></label>
            <div className="memory-inline-actions"><button className="control" disabled={busy} onClick={() => setCorrecting(false)}>Cancel</button><button className="control" data-variant="primary" disabled={busy || !canSaveCorrection} onClick={() => onCorrect(title.trim(), content.trim(), reason.trim())}>Save correction</button></div>
          </div>}
        </div>
      </section>
      <small data-mono>Created {formatMemoryDate(record.createdAt)} · updated {formatMemoryDate(record.updatedAt)}</small>
    </div>
  );
}

export function TopicDetail({ topic, onForget, onRestore, busy = false }: { topic: MemoryTopicDetail; onForget: () => void; onRestore: () => void; busy?: boolean }) {
  const descriptor = memoryTopicDescriptor(topic);
  const fullTopic = "revision" in topic ? topic : null;
  const repeatedDescription = memoryTextRepeats(descriptor.title, descriptor.description);
  const [section, setSection] = useState<TopicDetailSection>(() => descriptor.status === "deleted" ? "controls" : "overview");
  useEffect(() => setSection(descriptor.status === "deleted" ? "controls" : "overview"), [descriptor.topicId, descriptor.updatedAt]);
  const tabs = [
    { value: "overview", label: "Overview" },
    { value: "metadata", label: "Metadata" },
    { value: "controls", label: "Controls", meta: descriptor.status === "deleted" ? "Action" : undefined },
  ] satisfies readonly PanelTab<TopicDetailSection>[];
  return (
    <div className="memory-detail-content">
      <span className="memory-kind">{fullTopic ? "cold" : "topic"} · {descriptor.kind}</span>
      <h3>{repeatedDescription ? descriptor.description : descriptor.title}</h3>
      <small data-mono>{fullTopic ? `revision ${fullTopic.revision.revision} · ${fullTopic.revision.tokenCount.toLocaleString()} tokens · ${descriptor.status} · full page` : `descriptor · ${descriptor.status} · no cold page`}</small>
      <PanelTabs label="Memory topic views" value={section} tabs={tabs} onChange={setSection} />

      <section hidden={section !== "overview"} aria-label="Memory topic overview">
        {!repeatedDescription && <p>{descriptor.description}</p>}
        {fullTopic ? <div className="cold-document"><span className="eyebrow">Canonical document</span><div><Markdown>{fullTopic.body}</Markdown></div></div> : <p data-meta>This Topic is indexed as a descriptor. A canonical Cold page has not been published yet.</p>}
      </section>

      <section hidden={section !== "metadata"} aria-label="Memory topic metadata and storage">
        <div className="section-heading"><strong>Metadata and storage</strong><small>{fullTopic ? `revision ${fullTopic.revision.revision}` : "descriptor only"}</small></div>
        <div className="memory-disclosure-body">
          <section><span data-meta>Topic identity</span><div data-mono>{descriptor.topicId} · {descriptor.scope.type}:{descriptor.scope.id}</div></section>
          {descriptor.aliases.length > 0 && <section><span data-meta>Aliases</span><div className="memory-tags">{descriptor.aliases.map((alias) => <code key={alias}>{alias}</code>)}</div></section>}
          {descriptor.entityIds.length > 0 && <section><span data-meta>Entities</span><div className="memory-tags">{descriptor.entityIds.map((entity) => <code key={entity}>{entity}</code>)}</div></section>}
          {descriptor.relatedTopicIds.length > 0 && <section><span data-meta>Related topics</span><div className="memory-tags">{descriptor.relatedTopicIds.map((related) => <code key={related}>{related}</code>)}</div></section>}
          {descriptor.lifecycle && <section><span data-meta>Lifecycle</span><div>{descriptor.lifecycle.previousStatus ? `Restorable from ${descriptor.lifecycle.previousStatus}` : descriptor.status}{descriptor.lifecycle.deleteReason ? ` · ${descriptor.lifecycle.deleteReason}` : ""}{descriptor.lifecycle.purgeAfter ? ` · purge after ${formatMemoryDate(descriptor.lifecycle.purgeAfter)}` : ""}</div></section>}
          {fullTopic ? <section><span data-meta>Revision storage</span><div><div data-mono>{fullTopic.revision.id}{fullTopic.revision.state ? ` · ${fullTopic.revision.state}` : ""}{fullTopic.revision.byteLength === undefined ? "" : ` · ${fullTopic.revision.byteLength.toLocaleString()} bytes`}</div><small data-mono>{fullTopic.revision.objectKey ?? "Managed object"} · sha256:{fullTopic.revision.checksum}</small></div></section> : <section><span data-meta>Cold storage</span><div>No canonical page published</div></section>}
        </div>
      </section>

      <section hidden={section !== "controls"} aria-label="Memory topic controls">
        <div className="section-heading"><strong>Topic controls</strong><small>{descriptor.status === "deleted" ? "Recovery" : "Review or forget"}</small></div>
        <div className="memory-inline-actions">{descriptor.status === "deleted" ? <button className="control" disabled={busy} onClick={onRestore}><RotateCcw size={ICON_SIZE.sm} />Restore</button> : <button className="control" data-tone="danger" disabled={busy} onClick={onForget}><Trash2 size={ICON_SIZE.sm} />Forget</button>}</div>
      </section>
      <small data-mono>{fullTopic ? `Published ${formatMemoryDate(fullTopic.revision.publishedAt ?? fullTopic.revision.createdAt)}` : `Updated ${formatMemoryDate(descriptor.updatedAt)}`}</small>
    </div>
  );
}

function formatCount(value: number, singular: string): string {
  return `${value.toLocaleString()} ${singular}${value === 1 ? "" : "s"}`;
}
