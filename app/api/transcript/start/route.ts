import { put } from "@vercel/blob";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

function makeTranscriptId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}${Math.random()
    .toString(16)
    .slice(2)}`;
}

export async function POST() {
  try {
    const transcriptId = makeTranscriptId();
    const startedAt = new Date().toISOString();

    const path = `chat-transcripts/${transcriptId}.txt`;
    const initialText =
      `Chat transcript started\n` +
      `TranscriptId: ${transcriptId}\n` +
      `StartedAt: ${startedAt}\n\n`;

    await put(path, initialText, {
      access: "public",
      contentType: "text/plain; charset=utf-8",
      addRandomSuffix: false,
      allowOverwrite: false,
    });

    return NextResponse.json({
      ok: true,
      transcriptId,
      startedAt,
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
