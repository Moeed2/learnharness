import { listDocuments } from "@/src/server";

export const dynamic = "force-dynamic";
export function GET() {
	return Response.json({ documents: listDocuments() }, { headers: { "Cache-Control": "no-store" } });
}
