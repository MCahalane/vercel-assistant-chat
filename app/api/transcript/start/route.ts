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

export async function POST(req: Request) {
  try {
    // Optional JSON body, so later we can pass things like prolificId / threadId
    let body: any = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }

    const transcriptId = makeTranscriptId();
    const startedAt = new Date().toISOString();

    const prolificId = safeLine(body?.prolificId);
    const threadId = safeLine(body?.threadId);

    const path = `chat-transcripts/${transcriptId}.txt`;

    const initialText =
      `Chat transcript started\n` +
      `TranscriptId: ${transcriptId}\n` +
      `StartedAt: ${startedAt}\n` +
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
