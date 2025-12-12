import OpenAI from "openai";
import { NextResponse } from "next/server";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const message = body?.message;
    const incomingThreadId = body?.threadId;
    const rawInputMode = body?.inputMode;

    // Normalise inputMode to "text" | "audio"
    const inputMode: "text" | "audio" =
      rawInputMode === "audio" ? "audio" : "text";

    if (!message || typeof message !== "string") {
      return NextResponse.json(
        { error: "No message provided" },
        { status: 400 }
      );
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
      typeof incomingThreadId === "string" &&
      incomingThreadId.startsWith("thread_")
        ? incomingThreadId
        : null;

    // Create a thread if we don't have a valid one yet
    const thread = threadId
      ? await openai.beta.threads.retrieve(threadId)
      : await openai.beta.threads.create();

    console.log("New user message", {
      threadId: thread.id,
      inputMode,
    });

    // Add user message, tagged with inputMode in metadata
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
          error:
            run.last_error?.message ||
            `Run ended with status ${run.status}`,
        },
        { status: 500 }
      );
    }

    // Fetch latest assistant reply
    const messages = await openai.beta.threads.messages.list(run.thread_id, {
      limit: 20,
    });

    const lastAssistantMsg = messages.data.find(
      (m) => m.role === "assistant"
    );

    const reply =
      lastAssistantMsg?.content?.[0]?.type === "text"
        ? lastAssistantMsg.content[0].text.value
        : "No assistant reply found.";

    return NextResponse.json({
      reply,
      threadId: run.thread_id,
    });
  } catch (err: any) {
    console.error("Chat route error:", err);
    return NextResponse.json(
      { error: err?.message || "Server error" },
      { status: 500 }
    );
  }
}
