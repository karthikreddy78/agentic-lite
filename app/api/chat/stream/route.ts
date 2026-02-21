import OpenAI from "openai";
import { z } from "zod";

export const runtime = "nodejs";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

const bodySchema = z.object({
  messages: z.array(messageSchema).min(1),
});

const encoder = new TextEncoder();

function formatSse(data: unknown) {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          stream: true,
          messages: parsed.data.messages,
        });

        for await (const chunk of completion) {
          const token = chunk.choices[0]?.delta?.content;
          if (token) {
            controller.enqueue(formatSse({ type: "token", token }));
          }
        }

        controller.enqueue(formatSse({ type: "done" }));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown stream error";
        controller.enqueue(formatSse({ type: "error", message }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
