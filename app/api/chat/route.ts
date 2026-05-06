import { NextResponse } from "next/server";
import { answerQuestion } from "@/lib/rag";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const collectionName = typeof body.collectionName === "string" ? body.collectionName : "";
    const question = typeof body.question === "string" ? body.question.trim() : "";

    if (!collectionName || !question) {
      return NextResponse.json(
        { error: "Both collectionName and question are required." },
        { status: 400 }
      );
    }

    const result = await answerQuestion(collectionName, question);

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to answer question.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}