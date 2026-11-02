import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";
import { KEYBOARD_ACTIONS } from "../core/keyboard.ts";

const KEYS = new Set(["lh:keymap", "lh:sidebar-open", "lh:session-kind-filter", "lh.graph.camera.v1"]);

export function validateBrowserPreferences(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid browser preferences.");
	const result: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (!KEYS.has(key) || typeof item !== "string" || item.length > 16_384) throw new Error("Invalid browser preference.");
		if (key === "lh:sidebar-open" && item !== "0" && item !== "1") throw new Error("Invalid sidebar preference.");
		if (key === "lh:session-kind-filter" && !["all", "teach", "practice"].includes(item)) throw new Error("Invalid session preference.");
		if (key === "lh:keymap") {
			const map = JSON.parse(item) as unknown;
			if (!map || typeof map !== "object" || Array.isArray(map) || Object.entries(map).some(([id, binding]) => !KEYBOARD_ACTIONS.some((action) => action.id === id)
				|| typeof binding !== "string" || binding.length > 128)) throw new Error("Invalid keyboard preference.");
		}
		if (key === "lh.graph.camera.v1") {
			const camera = JSON.parse(item) as { x?: number; y?: number; k?: number };
			if (!camera || ![camera.x, camera.y, camera.k].every((n) => typeof n === "number" && Number.isFinite(n)) || camera.k! <= 0
				|| Object.keys(camera).some((k) => !["x", "y", "k"].includes(k))) throw new Error("Invalid graph view preference.");
		}
		result[key] = item;
	}
	return result;
}

export function readBrowserPreferences(root = PATHS.data): Record<string, string> {
	try { return validateBrowserPreferences(JSON.parse(fs.readFileSync(path.join(root, "browser-preferences.json"), "utf8"))); }
	catch { return {}; }
}

export function writeBrowserPreferences(value: unknown, root = PATHS.data): Record<string, string> {
	const preferences = validateBrowserPreferences(value);
	fs.mkdirSync(root, { recursive: true });
	const file = path.join(root, "browser-preferences.json");
	if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error("Unsafe browser preference storage.");
	const temp = `${file}.${randomUUID()}.tmp`;
	try { fs.writeFileSync(temp, JSON.stringify(preferences), { mode: 0o600, flag: "wx" }); fs.renameSync(temp, file); }
	finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
	return preferences;
}
