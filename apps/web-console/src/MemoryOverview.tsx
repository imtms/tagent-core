import { Database, Flame, Snowflake } from "lucide-react";
import type { MemoryKind, MemoryScope, MemoryStatusResult, RuntimeStatus, TopicDescriptor, WarmMemory } from "./api";
import { ICON_SIZE } from "./icon-size";

const kinds: Array<{ value: "all" | MemoryKind; label: string }> = [
  { value: "all", label: "All" },
  { value: "fact", label: "Facts" },
  { value: "preference", label: "Preferences" },
  { value: "episode", label: "Episodes" },
  { value: "procedure", label: "Procedures" },
];

interface MemoryOverviewProps {
  scope: MemoryScope;
  runtime: RuntimeStatus;
  status: MemoryStatusResult | null;
  kind: "all" | MemoryKind;
  onKindChange: (kind: "all" | MemoryKind) => void;
  records: readonly WarmMemory[];
  topics: readonly TopicDescriptor[];
}

export function MemoryOverview({
  scope,
  runtime,
  status,
  kind,
  onKindChange,
  records,
  topics,
}: MemoryOverviewProps) {
  const tiers = [
    { key: "hot", label: "Hot", count: status?.records.hot ?? 0, detail: "active cues", icon: <Flame size={ICON_SIZE.md} /> },
    { key: "warm", label: "Warm", count: status?.records.warm ?? 0, detail: "searchable cards", icon: <Database size={ICON_SIZE.md} /> },
    { key: "cold", label: "Cold", count: status?.coldTopics ?? 0, detail: "full pages", icon: <Snowflake size={ICON_SIZE.md} /> },
  ].filter((item) => item.count > 0);
  const recordStates = [
    { label: "Active", count: status?.records.active ?? 0 },
    { label: "Candidate", count: status?.records.candidate ?? 0 },
    { label: "Disputed", count: status?.records.disputed ?? 0 },
    { label: "Topics", count: status?.topics ?? 0 },
  ].filter((item) => item.count > 0);
  const total = records.length + topics.length;
  const filters = kinds.map((item) => ({
    ...item,
    count: item.value === "all"
      ? total
      : records.filter((record) => record.kind === item.value).length
        + topics.filter((topic) => topic.kind === item.value).length,
  })).filter((item) => item.count > 0 || item.value === kind);
  return (
    <aside className="memory-summary">
      <section className="memory-scope-card">
        <span>Active scope</span>
        <strong>{scope.id}</strong>
        <small>
          {runtime.memoryBackend ?? "memory"} metadata · {runtime.memoryColdBackend ?? "local"} Cold
        </small>
      </section>
      {tiers.length > 0 && <div className="memory-tier-grid">{tiers.map((item) => <div key={item.key}>
        {item.icon}
        <span>{item.label}</span>
        <strong>{item.count}</strong>
        <small>{item.detail}</small>
      </div>)}</div>}
      {recordStates.length > 0 && <dl className="memory-health-ledger" aria-label="Memory record state">
        {recordStates.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.count}</dd></div>)}
      </dl>}
      {total > 0 && <nav className="memory-kind-filter">
        {filters.map((item) => (
          <button
            key={item.value}
            className={kind === item.value ? "active" : ""}
            onClick={() => onKindChange(item.value)}
          >
            {item.label}
            {item.count > 0 && <span>{item.count}</span>}
          </button>
        ))}
      </nav>}
    </aside>
  );
}
