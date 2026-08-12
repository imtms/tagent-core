import { memo } from "react";

export const LiveText = memo(function LiveText({ children }: { children: string }) {
  return <div className="markdown live-text">{children}</div>;
});
