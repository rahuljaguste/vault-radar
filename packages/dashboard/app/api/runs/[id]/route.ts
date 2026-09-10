import { NextResponse } from "next/server";
import { getRun, isValidRunId } from "@/lib/runs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidRunId(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const run = await getRun(id);
  if (!run) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(run);
}
