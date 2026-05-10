import { NextResponse } from "next/server";
import { ingestDocument } from "@/lib/rag";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Upload a PDF, TXT, or CSV file." }, { status: 400 });
    }

    const result = await ingestDocument(file);

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to ingest document.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}