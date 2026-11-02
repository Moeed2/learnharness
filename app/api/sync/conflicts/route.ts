import { syncConflictsResponse } from "@/src/server";
export const dynamic = "force-dynamic";
export function GET() { return syncConflictsResponse(); }
