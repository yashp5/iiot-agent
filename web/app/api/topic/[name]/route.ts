import { NextResponse } from "next/server";
import { getAnalysis, getReports, getTelemetry, type TopicName } from "@/lib/mirror";

/*
 * Proxies the mirror node so topic ids stay server-side and chunk reassembly happens once,
 * on the server. The browser polls this route; this route reads the chain.
 */

const READERS: Record<string, (since?: string) => Promise<unknown>> = {
  telemetry: getTelemetry,
  analysis: getAnalysis,
  reports: () => getReports(),
};

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const reader = READERS[name as TopicName];
  if (!reader) {
    return NextResponse.json({ error: `unknown topic '${name}'` }, { status: 404 });
  }

  const since = new URL(request.url).searchParams.get("since") ?? undefined;
  try {
    return NextResponse.json({ records: await reader(since) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "mirror read failed" },
      { status: 502 },
    );
  }
}
