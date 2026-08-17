import { Database, Flame, ShieldCheck, Snowflake } from "lucide-react";
import type { MemoryKind, MemoryScope, MemoryStatusResult, RuntimeStatus, TopicDescriptor, WarmMemory } from "./api";

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
  return (
    <aside className="memory-summary">
      <section className="memory-scope-card">
        <span>Active scope</span>
        <strong>{scope.id}</strong>
        <small>
          {runtime.memoryBackend ?? "memory"} metadata · {runtime.memoryColdBackend ?? "local"} Cold
        </small>
      </section>
      <div className="memory-tier-grid">
        <div>
          <Flame size={16} />
          <span>Hot</span>
          <strong>{status?.records.hot ?? 0}</strong>
          <small>active cues</small>
        </div>
        <div>
          <Database size={16} />
          <span>Warm</span>
          <strong>{status?.records.warm ?? 0}</strong>
          <small>searchable cards</small>
        </div>
        <div>
          <Snowflake size={16} />
          <span>Cold</span>
          <strong>{status?.coldTopics ?? 0}</strong>
          <small>full pages</small>
        </div>
      </div>
      <section className="memory-health-card">
        <div>
          <ShieldCheck size={16} />
          <strong>Policy protected</strong>
        </div>
        <p>Sensitive data is gated before capture, embedding, storage and injection.</p>
        <dl>
          <div><dt>Active</dt><dd>{status?.records.active ?? 0}</dd></div>
          <div><dt>Candidate</dt><dd>{status?.records.candidate ?? 0}</dd></div>
          <div><dt>Disputed</dt><dd>{status?.records.disputed ?? 0}</dd></div>
          <div><dt>Topics</dt><dd>{status?.topics ?? 0}</dd></div>
        </dl>
      </section>
      <nav className="memory-kind-filter">
        {kinds.map((item) => (
          <button
            key={item.value}
            className={kind === item.value ? "active" : ""}
            onClick={() => onKindChange(item.value)}
          >
            {item.label}
            <span>
              {item.value === "all"
                ? records.length + topics.length
                : records.filter((record) => record.kind === item.value).length
                  + topics.filter((topic) => topic.kind === item.value).length}
            </span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
