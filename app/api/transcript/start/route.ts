import { put } from "@vercel/blob";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

function makeTranscriptId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}${Math.random()
    .toString(16)
    .slice(2)}`;
}

function safeLine(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // keep it simple and safe for a text file (no newlines)
  return trimmed.replace(/[\r\n]+/g, " ");
}

function safeIsoDate(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return null;

  // Normalise to ISO to keep it consistent
  return new Date(ms).toISOString();
}

async function readBodyAny(req: Request): Promise<any | null> {
  // 1) Try JSON
  try {
    return await req.json();
  } catch {
    // ignore
  }

  // 2) Try formData (covers multipart/form-data and sometimes urlencoded in Next)
  try {
    const fd = await req.formData();
    const obj: Record<string, any> = {};
    for (const [k, v] of fd.entries()) {
      obj[k] = typeof v === "string" ? v : v;
    }
    return obj;
  } catch {
    // ignore
  }

  return null;
}

function pickFirstNonEmptyLine(...values: unknown[]) {
  for (const v of values) {
    const s = safeLine(v);
    if (s) return s;
  }
  return null;
}

export async function POST(req: Request) {
  try {
    const transcriptId = makeTranscriptId();

    // Read whatever body format the client used (JSON or formData); may still be null
    const body = await readBodyAny(req);

    // Also allow query params as a fallback
    const url = new URL(req.url);
    const qp = url.searchParams;

    // If client provides a real start time, respect it
    const startedAt =
      safeIsoDate(body?.startedAt) ||
      safeIsoDate(qp.get("startedAt")) ||
      new Date().toISOString();

    // Accept common casings + query param fallback
    const participantId = pickFirstNonEmptyLine(
      body?.participantId,
      body?.ParticipantID,
      body?.participantID,
      body?.ParticipantId,
      qp.get("participantId"),
      qp.get("ParticipantID"),
      qp.get("participantID"),
      qp.get("ParticipantId")
    );

    const prolificId = pickFirstNonEmptyLine(
      body?.prolificId,
      body?.ProlificId,
      qp.get("prolificId"),
      qp.get("ProlificId")
    );

    const threadId = pickFirstNonEmptyLine(
      body?.threadId,
      body?.ThreadId,
      qp.get("threadId"),
      qp.get("ThreadId")
    );

    const path = `chat-transcripts/${transcriptId}.txt`;

    const initialText =
      `Chat transcript started\n` +
      `TranscriptId: ${transcriptId}\n` +
      `StartedAt: ${startedAt}\n` +
      (participantId ? `ParticipantID: ${participantId}\n` : "") +
      (prolificId ? `ProlificId: ${prolificId}\n` : "") +
      (threadId ? `ThreadId: ${threadId}\n` : "") +
      `\n`;

    const result = await put(path, initialText, {
      access: "public",
      contentType: "text/plain; charset=utf-8",
      addRandomSuffix: false,
      allowOverwrite: false,
    });

    return NextResponse.json({
      ok: true,
      transcriptId,
      startedAt,
      path,
      url: result.url,
      participantId: participantId || null,
      prolificId: prolificId || null,
      threadId: threadId || null,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to start transcript" },
      { status: 500 }
    );
  }
}

// This line ensures TypeScript always treats this file as a module.
export {};
