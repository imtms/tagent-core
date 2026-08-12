import { describe, expect, it } from "vitest";
import { conversationEndSlack, nextConversationPinState } from "../apps/web-console/src/conversation-scroll";

const sample = {
  pinned: true,
  previousTop: 600,
  nextTop: 600,
  gap: 180,
  viewportResized: false,
  settling: false,
  programmatic: false,
};

describe("conversation scroll intent", () => {
  it("unpins only for a deliberate upward move and re-pins at the live edge", () => {
    expect(nextConversationPinState({ ...sample, nextTop: 560 })).toBe(false);
    expect(nextConversationPinState({ ...sample, pinned: false, previousTop: 560, nextTop: 590 })).toBe(false);
    expect(nextConversationPinState({ ...sample, pinned: false, gap: conversationEndSlack - 1 })).toBe(true);
  });

  it("does not mistake layout settling or programmatic movement for reading intent", () => {
    expect(nextConversationPinState({ ...sample, nextTop: 520, viewportResized: true })).toBe(true);
    expect(nextConversationPinState({ ...sample, nextTop: 600, settling: true })).toBe(true);
    expect(nextConversationPinState({ ...sample, nextTop: 520, settling: true })).toBe(false);
    expect(nextConversationPinState({ ...sample, nextTop: 520, programmatic: true })).toBe(true);
  });
});
