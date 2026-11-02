/** Bind every individual network request, including refresh waits, to its original account. */
export function bindAccountToken(
	accountId: string,
	generation: number,
	current: () => { accountId?: string; connected: boolean; generation: number },
	getToken: () => Promise<string>,
): () => Promise<string> {
	const check = () => {
		const state = current();
		if (!state.connected || state.accountId !== accountId || state.generation !== generation) throw new Error("Google sync account changed or syncing was cancelled.");
	};
	return async () => { check(); const token = await getToken(); check(); return token; };
}
