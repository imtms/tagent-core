import type { Message, Session, SessionId, SessionSettingsUpdate } from "../domain/index.js";

export interface SessionRepository {
  createSession(title?: string, requestId?: string): Session;
  listSessions(): Session[];
  getSession(id: SessionId): Session | undefined;
  updateSession(id: SessionId, settings: SessionSettingsUpdate): Session | undefined;
  renameSession(id: SessionId, title: string): Session | undefined;
  listMessages(sessionId: SessionId, limit?: number, beforeId?: number): Message[];
  listRecentMessages(sessionId: SessionId, limit?: number): Message[];
  appendMessage(sessionId: SessionId, role: Message["role"], content: string): Message;
}
