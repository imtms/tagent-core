export interface PanelTab<T extends string> {
  value: T;
  label: string;
  meta?: string;
}

export function PanelTabs<T extends string>({
  label,
  value,
  tabs,
  onChange,
}: {
  label: string;
  value: T;
  tabs: readonly PanelTab<T>[];
  onChange: (value: T) => void;
}) {
  return <nav className="panel-tabs" aria-label={label}>
    {tabs.map((tab) => <button
      className="control"
      type="button"
      aria-current={tab.value === value ? "page" : undefined}
      key={tab.value}
      onClick={() => onChange(tab.value)}
    ><span>{tab.label}</span>{tab.meta && <small data-mono>{tab.meta}</small>}</button>)}
  </nav>;
}
