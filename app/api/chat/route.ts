import OpenAI from "openai";
import { NextResponse } from "next/server";
import { put } from "@vercel/blob";

export const runtime = "nodejs";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function safeId(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // keep IDs/path segments simple
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "");
}

function safeText(value: unknown) {
  if (typeof value !== "string") return "";
  // keep text readable in a file, avoid odd control chars
  return value.replace(/\r/g, "");
}

async function writeTranscriptMessage(args: {
  transcriptId: string;
  role: "user" | "assistant";
  text: string;
  inputMode?: "text" | "audio";
  threadId?: string;
}) {
  const transcriptId = safeId(args.transcriptId);
  if (!transcriptId) return;

  const ts = new Date().toISOString();
  const now = Date.now();

  const path = `chat-transcripts/${transcriptId}/messages/${now}-${args.role}.txt`;

  const content =
    `Timestamp: ${ts}\n` +
    (args.threadId ? `ThreadId: ${args.threadId}\n` : "") +
    (args.inputMode ? `InputMode: ${args.inputMode}\n` : "") +
    `Role: ${args.role}\n\n` +
    safeText(args.text) +
    `\n`;

  await put(path, content, {
    access: "private",
    contentType: "text/plain; charset=utf-8",
    addRandomSuffix: false,
    allowOverwrite: false,
  });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const message = body?.message;
    const incomingThreadId = body?.threadId;
    const rawInputMode = body?.inputMode;

    // Optional: transcript tracking (created by /api/transcript/start)
    const incomingTranscriptId = body?.transcriptId;
    const transcriptId = safeId(incomingTranscriptId);

    // Normalise inputMode to "text" | "audio"
    const inputMode: "text" | "audio" =
      rawInputMode === "audio" ? "audio" : "text";

    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "No message provided" }, { status: 400 });
    }

    const assistantId = process.env.OPENAI_ASSISTANT_ID;
    if (!assistantId) {
      return NextResponse.json(
        { error: "Assistant ID missing in env vars" },
        { status: 500 }
      );
    }

    // Only accept a real thread id string like "thread_abc123"
    const threadId =
      typeof incomingThreadId === "string" && incomingThreadId.startsWith("thread_")
        ? incomingThreadId
        : null;

    // Create a thread if we don't have a valid one yet
    const thread = threadId
      ? await openai.beta.threads.retrieve(threadId)
      : await openai.beta.threads.create();

    console.log("New user message", {
      threadId: thread.id,
      inputMode,
      transcriptId: transcriptId || null,
    });

    // Store the user message as a separate blob file (if transcriptId provided)
    if (transcriptId) {
      try {
        await writeTranscriptMessage({
          transcriptId,
          role: "user",
          text: message,
          inputMode,
          threadId: thread.id,
        });
      } catch (e) {
        console.error("Transcript write (user) failed:", e);
      }
    }

    // Add user message to OpenAI thread, tagged with inputMode in metadata
    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: message,
      metadata: {
        inputMode,
      },
    });

    // Create run and wait for completion (official helper)
    const run = await openai.beta.threads.runs.createAndPoll(thread.id, {
      assistant_id: assistantId,
      metadata: {
        last_user_input_mode: inputMode,
      },
    });

    if (run.status !== "completed") {
      return NextResponse.json(
        {
          error: run.last_error?.message || `Run ended with status ${run.status}`,
        },
        { status: 500 }
      );
    }

    // Fetch latest assistant reply
    const msgs = await openai.beta.threads.messages.list(run.thread_id, {
      limit: 20,
    });

    const lastAssistantMsg = msgs.data.find((m) => m.role === "assistant");

    const reply =
      lastAssistantMsg?.content?.[0]?.type === "text"
        ? lastAssistantMsg.content[0].text.value
        : "No assistant reply found.";

    // Store the assistant reply as a separate blob file (if transcriptId provided)
    if (transcriptId) {
      try {
        await writeTranscriptMessage({
          transcriptId,
          role: "assistant",
          text: reply,
          threadId: run.thread_id,
        });
      } catch (e) {
        console.error("Transcript write (assistant) failed:", e);
      }
    }

    return NextResponse.json({
      reply,
      threadId: run.thread_id,
      transcriptId: transcriptId || null,
    });
  } catch (err: any) {
    console.error("Chat route error:", err);
    return NextResponse.json(
      { error: err?.message || "Server error" },
      { status: 500 }
    );
  }
}
