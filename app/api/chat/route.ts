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
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "");
}

function safeText(value: unknown) {
  if (typeof value !== "string") return "";
  return value.replace(/\r/g, "");
}

function safeContextValue(value: unknown) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  // keep it readable and safe to log or insert
  return trimmed.replace(/[\r\n\t]/g, " ").slice(0, 240);
}

function applyTopBenefitSubstitution(reply: string, topBenefit: string) {
  if (!reply || typeof reply !== "string") return reply;
  if (!topBenefit) return reply;

  // Replace common placeholder variants if they appear verbatim
  return reply
    .replaceAll("${TopBenefit}", topBenefit)
    .replaceAll("${topBenefit}", topBenefit);
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
    access: "public",
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

    // NEW: accept TopBenefit context from the client
    const incomingTopBenefit = body?.topBenefit;
    const topBenefit = safeContextValue(incomingTopBenefit);

    // Optional: transcript tracking (created by /api/transcript/start)
    const incomingTranscriptId = body?.transcriptId;
    const transcriptId = safeId(incomingTranscriptId);

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

    const threadId =
      typeof incomingThreadId === "string" && incomingThreadId.startsWith("thread_")
        ? incomingThreadId
        : null;

    const thread = threadId
      ? await openai.beta.threads.retrieve(threadId)
      : await openai.beta.threads.create();

    console.log("New user message", {
      threadId: thread.id,
      inputMode,
      transcriptId: transcriptId || null,
      topBenefit: topBenefit || null,
    });

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

    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: message,
      metadata: {
        inputMode,
      },
    });

    // Create run and wait for completion
    const run = await openai.beta.threads.runs.createAndPoll(thread.id, {
      assistant_id: assistantId,
      metadata: {
        last_user_input_mode: inputMode,
        ...(topBenefit ? { top_benefit: topBenefit } : {}),
      },
      // Optional extra context. This does not override your assistant instructions.
      // It just gives the assistant the value to use when referencing the ranked benefit.
      additional_instructions: topBenefit
        ? `Context for this session: The participant's top ranked benefit is: "${topBenefit}". When referring to the ranked benefit, use that exact wording.`
        : undefined,
    } as any);

    if (run.status !== "completed") {
      return NextResponse.json(
        {
          error: run.last_error?.message || `Run ended with status ${run.status}`,
        },
        { status: 500 }
      );
    }

    const msgs = await openai.beta.threads.messages.list(run.thread_id, {
      limit: 20,
    });

    const lastAssistantMsg = msgs.data.find((m) => m.role === "assistant");

    let reply =
      lastAssistantMsg?.content?.[0]?.type === "text"
        ? lastAssistantMsg.content[0].text.value
        : "No assistant reply found.";

    // NEW: guarantee placeholder substitution on the way out
    reply = applyTopBenefitSubstitution(reply, topBenefit);

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
