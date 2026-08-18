import { ChevronDown, ShieldCheck } from "lucide-react";
import type { GateProfile } from "./api";
import { ICON_SIZE } from "./icon-size";

const gateProfileOptions = [
  { value: "off", label: "Off", description: "direct delivery" },
  { value: "relaxed", label: "Relaxed", description: "open research" },
  { value: "strict", label: "Strict", description: "code & closed work" },
] as const satisfies readonly { value: GateProfile; label: string; description: string }[];

export function GateProfileControl({
  profile,
  note,
  appliesToNextRun,
  onChange,
}: {
  profile: GateProfile;
  note: string;
  appliesToNextRun: boolean;
  onChange: (profile: GateProfile) => void;
}) {
  return <label className="gate-profile-control">
    <span className="gate-profile-heading"><ShieldCheck size={ICON_SIZE.xs} /><span>Gate</span></span>
    <span className="gate-profile-select">
      <select
        value={profile}
        aria-label="Gate acceptance style"
        aria-describedby="gate-profile-note"
        onChange={(event) => onChange(event.target.value as GateProfile)}
      >
        {gateProfileOptions.map((option) => <option value={option.value} key={option.value}>
          {option.label} · {option.description}
        </option>)}
      </select>
      <ChevronDown size={ICON_SIZE.xs} aria-hidden="true" />
    </span>
    <span id="gate-profile-note" className="sr-only">{note}{appliesToNextRun ? " This applies only if the input creates a new TaskRun." : ""}</span>
  </label>;
}
