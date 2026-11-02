/** Long import/conversion requests start before the extraction registry exists. */
const shared = globalThis as typeof globalThis & { __lhSyncImports?: number };

export async function duringDocumentImport<T>(run: () => Promise<T>): Promise<T> {
	shared.__lhSyncImports = (shared.__lhSyncImports ?? 0) + 1;
	try { return await run(); }
	finally { shared.__lhSyncImports = Math.max(0, (shared.__lhSyncImports ?? 1) - 1); }
}

export function documentImportRunning(): boolean { return (shared.__lhSyncImports ?? 0) > 0; }
