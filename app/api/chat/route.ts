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
  return trimmed.replace(/[\r\n\t]/g, " ").slice(0, 240);
}

// ParticipantID: keep it as text safe (do not over sanitize to only [a-zA-Z0-9] because IDs can include hyphens etc).
function safeParticipantId(value: unknown) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.replace(/[\r\n\t]/g, " ").slice(0, 120);
}

function applyTopBenefitSubstitution(reply: string, topBenefit: string) {
  if (!reply || typeof reply !== "string") return reply;
  if (!topBenefit) return reply;

  return reply
    .replaceAll("${TopBenefit}", topBenefit)
    .replaceAll("${topBenefit}", topBenefit)
    .replaceAll("{TopBenefit}", topBenefit)
    .replaceAll("{topBenefit}", topBenefit)
    .replaceAll("${e://Field/TopBenefit}", topBenefit);
}

function applyTopRiskSubstitution(reply: string, topRisk: string) {
  if (!reply || typeof reply !== "string") return reply;
  if (!topRisk) return reply;

  return reply
    .replaceAll("${TopRisk}", topRisk)
    .replaceAll("${topRisk}", topRisk)
    .replaceAll("{TopRisk}", topRisk)
    .replaceAll("{topRisk}", topRisk)
    .replaceAll("${e://Field/TopRisk}", topRisk);
}

function applyParticipantIdSubstitution(reply: string, participantId: string) {
  if (!reply || typeof reply !== "string") return reply;
  if (!participantId) return reply;

  return reply
    .replaceAll("${ParticipantID}", participantId)
    .replaceAll("${participantId}", participantId)
    .replaceAll("{ParticipantID}", participantId)
    .replaceAll("{participantId}", participantId)
    .replaceAll("${e://Field/ParticipantID}", participantId);
}

async function writeTranscriptMessage(args: {
  transcriptId: string;
  role: "user" | "assistant";
  text: string;
  inputMode?: "text" | "audio";
  threadId?: string;
  participantId?: string; // logging only
}) {
  const transcriptId = safeId(args.transcriptId);
  if (!transcriptId) return;

  const ts = new Date().toISOString();
  const now = Date.now();

  const path = `chat-transcripts/${transcriptId}/messages/${now}-${args.role}.txt`;

  const content =
    `Timestamp: ${ts}\n` +
    (args.threadId ? `ThreadId: ${args.threadId}\n` : "") +
    (args.participantId ? `ParticipantID: ${args.participantId}\n` : "") +
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForNoActiveRun(threadId: string, maxWaitMs = 15000) {
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    try {
      const runs = await openai.beta.threads.runs.list(threadId, { limit: 5 });

      const active = runs.data.find((r) =>
        ["queued", "in_progress", "requires_action", "cancelling"].includes(r.status)
      );

      if (!active) return { ok: true as const };

      await sleep(500);
      continue;
    } catch {
      return { ok: true as const };
    }
  }

  return { ok: false as const };
}

async function injectSurveyContext(args: {
  threadId: string;
  topBenefit: string;
  topRisk: string;
  isNewThread: boolean;
}) {
  const { threadId, topBenefit, topRisk, isNewThread } = args;

  const prefix = isNewThread ? "SURVEY_CONTEXT" : "SURVEY_CONTEXT_UPDATE";

  if (topBenefit) {
    const benefitContextMessage =
      `${prefix} (provided by the survey system, not the participant): ` +
      `The participant ranked "${topBenefit}" as the MOST IMPORTANT potential benefit of AI in future VR environments.\n\n` +
      `INTERVIEWER INSTRUCTION: When you ask Question 4, explicitly name that ranked benefit using the exact wording above. ` +
      `Do not ask the participant to restate the benefit. Treat this ranking as authoritative.` +
      (isNewThread
        ? ""
        : ` If any earlier context in this thread differs, override it with the value above.`);

    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: benefitContextMessage,
      metadata: {
        contextType: "survey_context",
        topBenefit,
        contextUpdate: isNewThread ? "0" : "1",
      },
    });
  }

  if (topRisk) {
    const riskContextMessage =
      `${prefix} (provided by the survey system, not the participant): ` +
      `The participant ranked "${topRisk}" as the MOST CONCERNING potential risk of AI in future VR environments.\n\n` +
      `INTERVIEWER INSTRUCTION: When you ask Question 6, explicitly name that ranked risk using the exact wording above. ` +
      `Do not ask the participant to restate the risk. Treat this ranking as authoritative.` +
      (isNewThread
        ? ""
        : ` If any earlier context in this thread differs, override it with the value above.`);

    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: riskContextMessage,
      metadata: {
        contextType: "survey_context",
        topRisk,
        contextUpdate: isNewThread ? "0" : "1",
      },
    });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const message = body?.message;
    const incomingThreadId = body?.threadId;
    const rawInputMode = body?.inputMode;

    const incomingTopBenefit =
      body?.topBenefit ??
      body?.TopBenefit ??
      body?.top_benefit ??
      body?.topbenefit;
    const topBenefit = safeContextValue(incomingTopBenefit);

    const incomingTopRisk =
      body?.topRisk ?? body?.TopRisk ?? body?.top_risk ?? body?.toprisk;
    const topRisk = safeContextValue(incomingTopRisk);

    const incomingTranscriptId = body?.transcriptId;
    const transcriptId = safeId(incomingTranscriptId);

    const incomingParticipantId =
      body?.participantId ?? body?.ParticipantID ?? body?.participantID;
    const participantId = safeParticipantId(incomingParticipantId);

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

    const existingThreadId =
      typeof incomingThreadId === "string" && incomingThreadId.startsWith("thread_")
        ? incomingThreadId
        : null;

    let thread: { id: string };
    if (existingThreadId) {
      try {
        const t = await openai.beta.threads.retrieve(existingThreadId);
        thread = { id: t.id };
      } catch {
        const t = await openai.beta.threads.create();
        thread = { id: t.id };
      }
    } else {
      const t = await openai.beta.threads.create();
      thread = { id: t.id };
    }

    const isNewThread = !existingThreadId || thread.id !== existingThreadId;

    console.log("New user message", {
      threadId: thread.id,
      inputMode,
      transcriptId: transcriptId || null,
      participantId: participantId || null,
      topBenefit: topBenefit || null,
      topRisk: topRisk || null,
      isNewThread,
    });

    const guard = await waitForNoActiveRun(thread.id, 15000);
    if (!guard.ok) {
      return NextResponse.json(
        {
          error:
            "Please wait a moment. The assistant is still finishing the previous step. Then try sending again.",
        },
        { status: 409 }
      );
    }

    if (topBenefit || topRisk) {
      try {
        await injectSurveyContext({
          threadId: thread.id,
          topBenefit,
          topRisk,
          isNewThread,
        });
      } catch (e) {
        console.error("Survey context injection failed:", e);
      }
    }

    if (transcriptId) {
      try {
        await writeTranscriptMessage({
          transcriptId,
          role: "user",
          text: message,
          inputMode,
          threadId: thread.id,
          participantId: participantId || undefined,
        });
      } catch (e) {
        console.error("Transcript write (user) failed:", e);
      }
    }

    // Send only the participant message to OpenAI. Do not include ParticipantID.
    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: message,
      metadata: {
        inputMode,
        ...(topBenefit ? { topBenefit } : {}),
        ...(topRisk ? { topRisk } : {}),
      },
    });

    const run = await openai.beta.threads.runs.createAndPoll(thread.id, {
      assistant_id: assistantId,
      metadata: {
        last_user_input_mode: inputMode,
        ...(topBenefit ? { topBenefit } : {}),
        ...(topRisk ? { topRisk } : {}),
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

    const msgs = await openai.beta.threads.messages.list(run.thread_id, {
      limit: 20,
    });

    const lastAssistantMsg = msgs.data.find((m) => m.role === "assistant");

    let reply =
      lastAssistantMsg?.content?.[0]?.type === "text"
        ? lastAssistantMsg.content[0].text.value
        : "No assistant reply found.";

    reply = applyTopBenefitSubstitution(reply, topBenefit);
    reply = applyTopRiskSubstitution(reply, topRisk);
    reply = applyParticipantIdSubstitution(reply, participantId);

    if (transcriptId) {
      try {
        await writeTranscriptMessage({
          transcriptId,
          role: "assistant",
          text: reply,
          threadId: run.thread_id,
          participantId: participantId || undefined,
        });
      } catch (e) {
        console.error("Transcript write (assistant) failed:", e);
      }
    }

    return NextResponse.json({
      reply,
      threadId: run.thread_id,
      transcriptId: transcriptId || null,
      participantId: participantId || null,
    });
  } catch (err: any) {
    console.error("Chat route error:", err);

    return NextResponse.json(
      { error: err?.message || "Server error" },
      { status: 500 }
    );
  }
}
