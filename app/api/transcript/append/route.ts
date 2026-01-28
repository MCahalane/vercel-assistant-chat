import { list, put } from "@vercel/blob";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type Role = "user" | "assistant";

function cleanTextBlock(s: string) {
  return (s || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function normaliseRole(raw: unknown): Role | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();

  if (v === "user") return "user";
  if (v === "assistant") return "assistant";

  if (v === "you") return "user";
  if (v === "ai") return "assistant";
  if (v === "bot") return "assistant";

  return null;
}

function formatLine(args: { ts: string; role: Role; text: string }) {
  const safeText = cleanTextBlock(args.text);
  if (!safeText) return "";
  return `[${args.ts}] ${args.role}: ${safeText}\n`;
}

async function readExistingText(url: string): Promise<string> {
  const r = await fetch(url, { cache: "no-store" as RequestCache });
  if (!r.ok) return "";
  return await r.text();
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function safeLine(value: unknown) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.replace(/[\r\n\t]+/g, " ").slice(0, 200);
}

function buildMetadataHeader(metadata: Record<string, any>) {
  let jsonLine = "{}";
  try {
    jsonLine = JSON.stringify(metadata);
  } catch {
    jsonLine = '{"metadata":"unserializable"}';
  }

  return `Metadata:\n${jsonLine}\n\n`;
}

function extractParticipantId(body: any): string {
  try {
    const direct = safeLine(
      body?.participantId ??
        body?.ParticipantID ??
        body?.participantID ??
        body?.ParticipantId
    );
    if (direct) return direct;

    const md = body?.metadata;
    if (isPlainObject(md)) {
      const fromMd = safeLine(
        md.participantId ??
          md.ParticipantID ??
          md.participantID ??
          md.ParticipantId
      );
      if (fromMd) return fromMd;
    }

    const fullText = typeof body?.fullText === "string" ? body.fullText : "";
    if (fullText) {
      const match = fullText.match(/^\s*ParticipantID:\s*(.+)\s*$/m);
      if (match && match[1]) {
        const parsed = safeLine(match[1]);
        if (parsed) return parsed;
      }
    }

    return "";
  } catch {
    return "";
  }
}

function buildFinalHeader(args: {
  transcriptId: string;
  participantId?: string;
  metadata?: Record<string, any>;
}) {
  const lines: string[] = [];
  lines.push("Chat transcript");
  lines.push(`TranscriptId: ${args.transcriptId}`);

  if (args.participantId && args.participantId.trim()) {
    lines.push(`ParticipantID: ${args.participantId.trim()}`);
  }

  lines.push("");

  const metaBlock = args.metadata ? buildMetadataHeader(args.metadata) : "";
  return lines.join("\n") + "\n" + metaBlock;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const transcriptId = body?.transcriptId;
    if (!transcriptId || typeof transcriptId !== "string") {
      return NextResponse.json(
        { ok: false, error: "Missing transcriptId" },
        { status: 400 }
      );
    }

    const path = `chat-transcripts/${transcriptId}.txt`;

    const mode =
      typeof body?.mode === "string" ? body.mode.trim().toLowerCase() : "append";

    const participantId = extractParticipantId(body);

    // FINALIZE MODE
    if (mode === "finalize") {
      const fullText = body?.fullText;

      if (!fullText || typeof fullText !== "string") {
        return NextResponse.json(
          { ok: false, error: "Missing fullText for finalize" },
          { status: 400 }
        );
      }

      const safeTranscript = cleanTextBlock(fullText);
      if (!safeTranscript) {
        console.log("TRANSCRIPT FINALIZE", {
          transcriptId,
          fullTextType: typeof fullText,
          fullTextLen: typeof fullText === "string" ? fullText.length : null,
          safeTranscriptLen: 0,
          participantIdIncluded: !!(participantId && participantId.trim()),
          metadataKeys: isPlainObject(body?.metadata) ? Object.keys(body.metadata) : null,
          wrote: false,
          reason: "safeTranscript empty after cleanTextBlock",
        });

        return NextResponse.json({ ok: true, skipped: true });
      }

      const metadata = isPlainObject(body?.metadata) ? body.metadata : undefined;

      const finalMetadata =
        metadata && isPlainObject(metadata)
          ? {
              ...metadata,
              ParticipantID:
                safeLine(metadata.ParticipantID) ||
                safeLine(metadata.participantId) ||
                participantId ||
                "",
            }
          : metadata;

      const header = buildFinalHeader({
        transcriptId,
        participantId,
        metadata: finalMetadata,
      });

      const transcriptBody = safeTranscript.endsWith("\n")
        ? safeTranscript
        : safeTranscript + "\n";

      const finalText = header + transcriptBody;

      console.log("TRANSCRIPT FINALIZE", {
        transcriptId,
        fullTextType: typeof fullText,
        fullTextLen: typeof fullText === "string" ? fullText.length : null,
        safeTranscriptLen: safeTranscript.length,
        finalTextLen: finalText.length,
        participantIdIncluded: !!(participantId && participantId.trim()),
        metadataKeys: finalMetadata ? Object.keys(finalMetadata) : null,
        wrote: true,
      });

      await put(path, finalText, {
        access: "public",
        contentType: "text/plain; charset=utf-8",
        addRandomSuffix: false,
        allowOverwrite: true,
      });

      return NextResponse.json({
        ok: true,
        mode: "finalize",
        metadataIncluded: !!finalMetadata,
        participantIdIncluded: !!(participantId && participantId.trim()),
      });
    }

    // APPEND MODE (LEGACY)
    const ts = typeof body?.ts === "string" ? body.ts : new Date().toISOString();

    let newLine = "";

    if (typeof body?.line === "string" && body.line.trim()) {
      const safe = cleanTextBlock(body.line);
      if (!safe) {
        return NextResponse.json({ ok: true, skipped: true });
      }
      newLine = safe.endsWith("\n") ? safe : safe + "\n";
    } else {
      const role = normaliseRole(body?.role);
      const text = body?.text;

      if (!role) {
        return NextResponse.json(
          {
            ok: false,
            error: "Invalid role",
            receivedRole: body?.role ?? null,
            hint: 'Expected role "user" or "assistant".',
          },
          { status: 400 }
        );
      }

      if (!text || typeof text !== "string") {
        return NextResponse.json(
          { ok: false, error: "Missing text" },
          { status: 400 }
        );
      }

      newLine = formatLine({ ts, role, text });
      if (!newLine) {
        return NextResponse.json({ ok: true, skipped: true });
      }
    }

    const existing = await list({ prefix: path, limit: 5 });
    const match = existing.blobs.find((b) => b.pathname === path);

    let currentText = "";

    if (match?.url) {
      try {
        currentText = await readExistingText(match.url);
      } catch {
        currentText = "";
      }
    }

    if (!currentText) {
      const headerLines: string[] = [];
      headerLines.push("Chat transcript started");
      headerLines.push(`TranscriptId: ${transcriptId}`);
      if (participantId && participantId.trim()) {
        headerLines.push(`ParticipantID: ${participantId.trim()}`);
      }
      headerLines.push(`StartedAt: ${new Date().toISOString()}`);
      headerLines.push("");
      headerLines.push("");

      currentText = headerLines.join("\n");
    }

    const updatedText = currentText + newLine;

    await put(path, updatedText, {
      access: "public",
      contentType: "text/plain; charset=utf-8",
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    return NextResponse.json({
      ok: true,
      mode: "append",
      participantIdIncluded: !!(participantId && participantId.trim()),
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to write transcript" },
      { status: 500 }
    );
  }
}
