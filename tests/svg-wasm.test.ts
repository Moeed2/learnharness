/**
 * Android SVG path: @resvg/resvg-wasm (same engine as resvg-js) with font
 * buffers read from system font dirs instead of loadSystemFonts.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { genericFamilies, listFontFiles, renderSvgWasm, selectFontFiles } from "../src/agent/subagents/svg-wasm.ts";

const MB = 1024 * 1024;

function emptyFontDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "lh-fonts-"));
}

describe("selectFontFiles", () => {
	const f = (file: string, size = 1000) => ({ file: `/system/fonts/${file}`, size });

	it("keeps outline text fonts, drops emoji, unknown and non-font files", () => {
		const out = selectFontFiles([
			f("Roboto-Regular.ttf"),
			f("NotoColorEmoji.ttf"),
			f("NotoSerif-Bold.ttf"),
			f("DroidSansMono.ttf"),
			f("NotoSansCJK-Regular.ttc"),
			f("fonts.xml"),
			f("SomeRandom.ttf"),
		]).map((x) => path.basename(x.file));
		assert.deepEqual(out, ["Roboto-Regular.ttf", "NotoSerif-Bold.ttf", "DroidSansMono.ttf", "NotoSansCJK-Regular.ttc"]);
	});

	it("loads Latin first and skips what does not fit the byte budget", () => {
		const out = selectFontFiles(
			[f("NotoSansCJK-Regular.ttc", 30 * MB), f("Roboto-Regular.ttf", 1 * MB), f("NotoSansSC-Regular.otf", 30 * MB)],
			40 * MB,
		);
		assert.deepEqual(
			out.map((x) => path.basename(x.file)),
			["Roboto-Regular.ttf", "NotoSansCJK-Regular.ttc"],
		);
	});
});

describe("genericFamilies", () => {
	it("only names families whose files were selected", () => {
		assert.deepEqual(genericFamilies([{ file: "/x/Roboto-Regular.ttf", size: 1 }]), {
			defaultFontFamily: "Roboto",
			sansSerifFamily: "Roboto",
		});
		assert.deepEqual(genericFamilies([]), {});
		assert.equal(
			genericFamilies([
				{ file: "/x/NotoSerif-Regular.ttf", size: 1 },
				{ file: "/x/DroidSansMono.ttf", size: 1 },
			]).monospaceFamily,
			"Droid Sans Mono",
		);
	});
});

describe("listFontFiles", () => {
	it("skips missing directories", () => {
		assert.deepEqual(listFontFiles(["/nonexistent-dir-lh"]), []);
	});
});

describe("renderSvgWasm", () => {
	it("renders a rect at fitTo width", async () => {
		const dir = emptyFontDir();
		try {
			const svg =
				'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="20" height="20" fill="#ff0000"/></svg>';
			const png = Buffer.from(await renderSvgWasm(svg, { width: 80, fontDirs: [dir] }));
			assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
			assert.equal(png.readUInt32BE(16), 80);
			assert.equal(png.readUInt32BE(20), 40);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("draws text from font buffers supplied through the font dir", async () => {
		const ttf = ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans.ttf"].find((p) =>
			fs.existsSync(p),
		);
		if (!ttf) return; // no host font to borrow; covered by the device diagnostics probe
		const dir = emptyFontDir();
		try {
			fs.copyFileSync(ttf, path.join(dir, "Roboto-Regular.ttf")); // ranked as Roboto
			const withText =
				'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="30"><text x="4" y="22" font-size="20" fill="#000">Hello</text></svg>';
			const blank = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="30"/>';
			const a = Buffer.from(await renderSvgWasm(withText, { width: 120, fontDirs: [dir] }));
			const b = Buffer.from(await renderSvgWasm(blank, { width: 120, fontDirs: [dir] }));
			assert.notDeepEqual(a, b, "text must change the rendered image");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects unparsable SVG so the caller can fall back to the WebView", async () => {
		const dir = emptyFontDir();
		try {
			await assert.rejects(renderSvgWasm("<not-svg", { width: 10, fontDirs: [dir] }));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
