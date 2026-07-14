"use client";

import * as React from "react";
import type { AssistantQueryRequest, AssistantQueryResponse, ChatMessage } from "@sentinel-act/assistant-core";
import { assistantFetch } from "@/lib/console/assistant-fetch";
import { ChatInput } from "./chat-input";
import { MessageList } from "./message-list";

/** ChatPanel — Spec 12's client-side half of §5.6. Owns the conversation
 *  transcript (no server-side session/history in v1, §13 Open Question 4
 *  — "the client resends the trailing window of its own transcript"),
 *  the in-flight flag (FR-27), and error display. Talks to exactly one
 *  endpoint: `POST /api/assistant/query`. */
export function ChatPanel() {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit(question: string) {
    setError(null);
    const userMessage: ChatMessage = { role: "user", content: question, createdAt: new Date().toISOString() };
    // conversationHistory sent to the server is the transcript BEFORE this
    // turn — the server truncates to its own trailing window regardless
    // (§7 NFR-5), the client does not need to pre-truncate.
    const conversationHistory = messages;
    setMessages((prev) => [...prev, userMessage]);
    setPending(true);

    try {
      const body: AssistantQueryRequest = { question, conversationHistory };
      const res = await assistantFetch("/api/assistant/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const parsed = await res.json().catch(() => null);
      if (!res.ok) {
        setError((parsed && typeof parsed.error === "string" ? parsed.error : null) ?? `The assistant could not answer (${res.status}).`);
        return;
      }
      const response = parsed as AssistantQueryResponse;
      setMessages((prev) => [...prev, response.message]);
    } catch {
      setError("Network error — the assistant did not respond, please retry.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      <MessageList messages={messages} pending={pending} />

      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <ChatInput pending={pending} onSubmit={(q) => void handleSubmit(q)} />
    </div>
  );
}
