import { readDocument } from "@/src/server";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const document = readDocument((await params).id);
	if (!document) return Response.json({ error: "Document not found or its content is damaged." }, { status: 404 });
	const filename = document.record.name.split("/").pop() ?? "document";
	return new Response(new Uint8Array(document.bytes), {
		headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g, "%27")}`,
			"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
	});
}
