import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

export const SYNC_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };

export function syncMutationAuthorized(request: Request): boolean {
	if (request.headers.get("x-learnharness-sync") !== "1" || request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return false;
	const origin = request.headers.get("origin");
	return Boolean(origin && origin === subscriptionRequestOrigin(request)
		&& (!request.headers.has("sec-fetch-site") || request.headers.get("sec-fetch-site") === "same-origin"));
}

export async function readSyncCommand(request: Request): Promise<Record<string, unknown>> {
	if (Number(request.headers.get("content-length")) > 65_536) throw new Error("Sync request is too large.");
	const reader = request.body?.getReader();
	if (!reader) throw new Error("Expected a sync command.");
	const chunks: Uint8Array[] = []; let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read(); if (done) break;
			size += value.byteLength;
			if (size > 65_536) throw new Error("Sync request is too large.");
			chunks.push(value);
		}
	} finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
	const command: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (!command || typeof command !== "object" || Array.isArray(command)) throw new Error("Invalid sync command.");
	return command as Record<string, unknown>;
}
