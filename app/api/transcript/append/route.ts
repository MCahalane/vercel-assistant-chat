import { list, put } from "@vercel/blob";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type Role = "user" | "assistant";

function cleanLine(s: string) {
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

  // Friendly aliases we’ve seen in UIs
  if (v === "you") return "user";
  if (v === "ai") return "assistant";
  if (v === "bot") return "assistant";

  return null;
}

function formatLine(args: { ts: string; role: Role; text: string }) {
  const safeText = cleanLine(args.text);
  if (!safeText) return "";
  return `[${args.ts}] ${args.role}: ${safeText}\n`;
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

    // Support both payload styles:
    // 1) { transcriptId, role, text, ts }
    // 2) { transcriptId, line }
    const ts = typeof body?.ts === "string" ? body.ts : new Date().toISOString();

    let newLine = "";

    // Style (2): raw pre-formatted line
    if (typeof body?.line === "string" && body.line.trim()) {
      const safe = cleanLine(body.line);
      if (!safe) {
        return NextResponse.json({ ok: true, skipped: true });
      }
      newLine = safe.endsWith("\n") ? safe : safe + "\n";
    } else {
      // Style (1): role + text
      const role = normaliseRole(body?.role);
      const text = body?.text;

      if (!role) {
        return NextResponse.json(
          {
            ok: false,
            error: "Invalid role",
            receivedRole: body?.role ?? null,
            hint: 'Expected role "user" or "assistant" (or "You"/"AI" aliases).',
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

    // Find the existing blob (created in /start) so we can append
    const existing = await list({ prefix: path, limit: 5 });
    const match = existing.blobs.find((b) => b.pathname === path);

    let currentText = "";

    if (match?.url) {
      try {
        const r = await fetch(match.url);
        if (r.ok) {
          currentText = await r.text();
        }
      } catch {
        // If fetch fails, we still write just the new line
      }
    } else {
      // If missing for any reason, create a minimal header
      currentText =
        `Chat transcript started\n` +
        `TranscriptId: ${transcriptId}\n` +
        `StartedAt: ${new Date().toISOString()}\n\n`;
    }

    const updatedText = currentText + newLine;

    await put(path, updatedText, {
      access: "public",
      contentType: "text/plain; charset=utf-8",
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to append transcript line" },
      { status: 500 }
    );
  }
}
