import type { Message } from "../domain/index.js";

export interface MessageSource {
  id: number;
  role: Message["role"];
  content: string;
}

export interface DurableUserMessage {
  id: number;
  content: string;
}

export interface MessageSourceRepository {
  getMessageSource(id: number): MessageSource | undefined;
  listDurableUserMessages(): DurableUserMessage[];
}
