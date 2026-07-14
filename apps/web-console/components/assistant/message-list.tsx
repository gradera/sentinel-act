import type { ChatMessage } from "@sentinel-act/assistant-core";
import { ChatMessageView } from "./chat-message";

export function MessageList({ messages, pending }: { messages: ChatMessage[]; pending: boolean }) {
  if (messages.length === 0 && !pending) {
    return (
      <p className="rounded-md border border-dashed border-muted-foreground/40 p-4 text-sm text-muted-foreground">
        Ask a question about an obligation, circular, review, or category — e.g. &quot;What custody obligations came
        into effect last quarter?&quot; or &quot;Who reviewed obligation ob-1042 and what did they decide?&quot;
      </p>
    );
  }

  return (
    <div className="space-y-3" aria-live="polite">
      {messages.map((message, i) => (
        // ChatMessage has no server-issued id (§4.1) — index + createdAt is
        // stable enough for this list, which only ever appends.
        <ChatMessageView key={`${message.createdAt}-${i}`} message={message} />
      ))}

      {pending ? (
        <div className="flex justify-start">
          <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground" role="status">
            Thinking…
          </div>
        </div>
      ) : null}
    </div>
  );
}
