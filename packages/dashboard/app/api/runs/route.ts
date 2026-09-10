import { NextResponse } from "next/server";
import { findRunsForVaults, listRuns } from "@/lib/runs";
import { parseVaultList } from "@/lib/vaults";

/**
 * `GET /api/runs` lists every run. `GET /api/runs?vaults=<comma or newline
 * separated ids>` instead returns the prior runs that covered any of those
 * vaults, which is what `/portfolio`'s history section asks for — filtering
 * server-side so the browser makes one request rather than one per run.
 *
 * The two forms return different keys (`runs` vs `matches`) so a caller can
 * never mistake a filtered answer for the full list.
 */
export async function GET(req: Request) {
  const param = new URL(req.url).searchParams.get("vaults");
  if (param === null) {
    return NextResponse.json({ runs: await listRuns() });
  }
  const parsed = parseVaultList(param.replace(/,/g, "\n"));
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  return NextResponse.json({ matches: await findRunsForVaults(parsed.vaults) });
}
