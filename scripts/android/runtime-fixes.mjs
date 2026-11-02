/**
 * Android runtime fixes, preloaded (`--import`) before the server.
 *
 * nodejs-mobile 24.20 (Android) segfaults the whole process inside
 * `Intl.Segmenter#segment()` (seen on a HarmonyOS 4.3 / Android 12 tablet,
 * word granularity: SIGSEGV in libnode.so, likely missing ICU break-iterator
 * data). A crash cannot be caught, so the native class is replaced with a
 * small pure-JS approximation. It only affects server-side code; the
 * WebView UI keeps its own working Intl.Segmenter.
 */

const GRAPHEME = /\P{M}\p{M}*(?:‍\P{M}\p{M}*)*|\p{M}+/gsu;
const WORD = /[\p{L}\p{N}_](?:[\p{L}\p{M}\p{N}_]|['’.](?=[\p{L}\p{N}]))*|\s+|[\s\S]/gu;
const SENTENCE = /[^.!?。！？]*(?:[.!?。！？]+["'’”)\]]*\s*|$)/gu;

class LhSegmenter {
	#locale;
	#granularity;
	constructor(locales, options = {}) {
		const g = options?.granularity ?? "grapheme";
		if (g !== "grapheme" && g !== "word" && g !== "sentence") {
			throw new RangeError(`Value ${g} out of range for Intl.Segmenter options property granularity`);
		}
		this.#granularity = g;
		const list = Array.isArray(locales) ? locales : locales === undefined ? [] : [locales];
		this.#locale = typeof list[0] === "string" ? list[0] : "en";
	}
	static supportedLocalesOf(locales) {
		return Array.isArray(locales) ? locales.filter((l) => typeof l === "string") : typeof locales === "string" ? [locales] : [];
	}
	resolvedOptions() {
		return { locale: this.#locale, granularity: this.#granularity };
	}
	segment(input) {
		const text = String(input);
		const granularity = this.#granularity;
		const re = granularity === "word" ? WORD : granularity === "sentence" ? SENTENCE : GRAPHEME;
		const list = [];
		for (const m of text.matchAll(re)) {
			if (m[0] === "") continue;
			const seg = { segment: m[0], index: m.index, input: text };
			if (granularity === "word") seg.isWordLike = /^[\p{L}\p{N}_]/u.test(m[0]);
			list.push(seg);
		}
		return {
			containing(index = 0) {
				const i = Number(index) || 0;
				return list.find((s) => i >= s.index && i < s.index + s.segment.length);
			},
			[Symbol.iterator]() {
				return list[Symbol.iterator]();
			},
		};
	}
}

Object.defineProperty(LhSegmenter.prototype, Symbol.toStringTag, { value: "Intl.Segmenter", configurable: true });
Object.defineProperty(Intl, "Segmenter", { value: LhSegmenter, writable: true, configurable: true, enumerable: false });
