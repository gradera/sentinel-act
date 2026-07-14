"use client";

import * as React from "react";

/** §7 FR-27: while a question is in flight, the input MUST be disabled —
 *  no second question can be submitted (and therefore no second
 *  concurrent classify/retrieve/synthesize call) until the current turn's
 *  response (or error) comes back. `pending` is owned by the parent
 *  (`chat-panel.tsx`), which is the one making the actual fetch call. */
export function ChatInput({ pending, onSubmit }: { pending: boolean; onSubmit: (question: string) => void }) {
  const [value, setValue] = React.useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || pending) {
      return;
    }
    onSubmit(trimmed);
    setValue("");
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-end gap-2">
      <label htmlFor="assistant-question" className="sr-only">
        Ask the assistant a question
      </label>
      <textarea
        id="assistant-question"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            handleSubmit(e);
          }
        }}
        disabled={pending}
        rows={2}
        placeholder="Ask a question about the Regulatory Knowledge Graph…"
        className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={pending || value.trim().length === 0}
        className="h-9 shrink-0 rounded-md border border-input bg-secondary px-4 text-sm font-medium text-secondary-foreground hover:bg-secondary/80 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Asking…" : "Ask"}
      </button>
    </form>
  );
}
