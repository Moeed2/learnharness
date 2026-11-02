import { canMoveFolder, placementOf, type SourceOrganization } from "@/src/core";

export interface MoveDestination {
	/** null = outside every folder (top level). */
	parentId: string | null;
	name: string;
	depth: number;
	/** The entry already lives here, so choosing it would be a no-op. */
	current: boolean;
}

/**
 * Destinations for the touch "Move to…" menu, depth-first in name order
 * (top level first). Folders can't be moved into themselves or their
 * descendants (the same rule the drag-drop and the server enforce).
 */
export function moveDestinations(state: SourceOrganization, kind: "source" | "folder", id: string): MoveDestination[] {
	const currentParent = kind === "source"
		? placementOf(state, id)?.folderId ?? null
		: state.folders.find((f) => f.id === id)?.parentId ?? null;
	const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
	const out: MoveDestination[] = [{ parentId: null, name: "Top level", depth: 0, current: currentParent === null }];
	const walk = (parentId: string | null, depth: number, seen: Set<string>) => {
		const kids = state.folders.filter((f) => f.parentId === parentId).sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id));
		for (const f of kids) {
			if (seen.has(f.id)) continue;
			if (kind === "folder" && !canMoveFolder(state, id, f.id)) continue;
			out.push({ parentId: f.id, name: f.name, depth, current: currentParent === f.id });
			walk(f.id, depth + 1, new Set(seen).add(f.id));
		}
	};
	walk(null, 0, new Set());
	return out;
}
