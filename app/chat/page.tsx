"use client";

import { FormEvent, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

type ChatRole = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
};

type StreamEvent =
  | { type: "token"; token: string }
  | { type: "done" }
  | { type: "error"; message: string };

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const canSend = useMemo(() => input.trim().length > 0 && !isStreaming, [input, isStreaming]);

  async function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSend) return;

    const trimmedInput = input.trim();
    const userMessage: ChatMessage = { id: createId(), role: "user", content: trimmedInput };
    const assistantMessageId = createId();
    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
    };

    const nextMessages = [...messages, userMessage];
    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput("");
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages.map(({ role, content }) => ({ role, content })),
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Stream failed with status ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !readerDone });

        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const dataLines = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim());

          for (const data of dataLines) {
            if (!data) continue;
            const payload = JSON.parse(data) as StreamEvent;

            if (payload.type === "token") {
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantMessageId
                    ? { ...msg, content: `${msg.content}${payload.token}` }
                    : msg
                )
              );
            }

            if (payload.type === "error") {
              throw new Error(payload.message);
            }
          }
        }
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        return;
      }

      const message = error instanceof Error ? error.message : "Unknown error";
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessageId ? { ...msg, content: `Error: ${message}` } : msg
        )
      );
    } finally {
      abortRef.current = null;
      setIsStreaming(false);
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-4 p-4">
      <section className="flex-1 space-y-3 overflow-y-auto rounded-md border border-zinc-200 p-4">
        {messages.length === 0 && (
          <p className="text-sm text-zinc-500">Start a conversation by sending a message.</p>
        )}

        {messages.map((message) => (
          <article
            key={message.id}
            className={
              message.role === "user"
                ? "ml-auto w-fit max-w-[85%] rounded-md bg-zinc-900 px-3 py-2 text-zinc-100"
                : "mr-auto w-fit max-w-[85%] rounded-md bg-zinc-100 px-3 py-2 text-zinc-900"
            }
          >
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide opacity-70">
              {message.role}
            </p>
            <div className="prose prose-sm max-w-none prose-pre:overflow-x-auto">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {message.content || (message.role === "assistant" && isStreaming ? "..." : "")}
              </ReactMarkdown>
            </div>
          </article>
        ))}
      </section>

      <form onSubmit={handleSend} className="flex gap-2">
        <input
          suppressHydrationWarning
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Type your message..."
          className="flex-1 rounded-md border border-zinc-300 px-3 py-2"
          disabled={isStreaming}
        />
        <button
          type="submit"
          disabled={!canSend}
          className="rounded-md bg-zinc-900 px-4 py-2 text-zinc-100 disabled:opacity-50"
        >
          Send
        </button>
        <button
          type="button"
          onClick={handleStop}
          disabled={!isStreaming}
          className="rounded-md border border-zinc-400 px-4 py-2 disabled:opacity-50"
        >
          Stop
        </button>
      </form>
    </main>
  );
}
