export const conversationEndSlack = 72;

export type ConversationPinSample = {
  pinned: boolean;
  previousTop: number;
  nextTop: number;
  gap: number;
  viewportResized: boolean;
  settling: boolean;
  programmatic: boolean;
};

export function nextConversationPinState(sample: ConversationPinSample): boolean {
  if (sample.programmatic || sample.viewportResized) return sample.pinned;
  if (sample.gap < conversationEndSlack) return true;
  if (sample.nextTop < sample.previousTop - 2) return false;
  if (sample.settling) return sample.pinned;
  return sample.pinned;
}
