import { z } from "zod";
import { GoogleGenAI } from "@google/genai";

export const runtime = "nodejs";

const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1).max(25_000),
});

const BodySchema = z.object({
  messages: z.array(MessageSchema).min(1).max(50),
});

function sse(data: unknown) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: Request) {
  if (!process.env.GEMINI_API_KEY) {
    return new Response("Missing GEMINI_API_KEY", { status: 500 });
  }

  const json = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({
        error: "Invalid request",
        details: parsed.error.flatten(),
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const messages = parsed.data.messages;

  // Extract system instruction (optional)
  const system = messages.find((m) => m.role === "system")?.content ?? "";

  // Build Gemini chat history from all messages except system and the last user turn
  const nonSystem = messages.filter((m) => m.role !== "system");
  const lastUserIdx = [...nonSystem]
    .reverse()
    .findIndex((m) => m.role === "user");
  const lastUser =
    lastUserIdx >= 0
      ? nonSystem[nonSystem.length - 1 - lastUserIdx].content
      : "";

  const history = nonSystem
    .slice(0, nonSystem.length - 1) // everything before the last turn
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(sse(obj)));

      try {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

        const chat = ai.chats.create({
          model: "gemini-2.5-flash-lite",
          history,
          config: system ? { systemInstruction: system } : undefined,
        });

        send({ type: "meta", model: "gemini-2.5-flash-lite" });

        const geminiStream = await chat.sendMessageStream({
          message: lastUser,
        });

        for await (const chunk of geminiStream) {
          // Official examples show chunk.text for streamed chunks
          const token = (chunk as { text?: string })?.text ?? "";
          if (token) send({ type: "token", token });
        }

        send({ type: "done" });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown error";
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
