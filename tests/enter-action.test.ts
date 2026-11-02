import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enterAction } from "../components/enter-submits";

const k = (o: Partial<Parameters<typeof enterAction>[0]> = {}) => ({ key: "Enter", code: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, ...o });

describe("enterAction", () => {
	it("desktop keeps send / shift-newline / mod-send", () => {
		assert.equal(enterAction(k(), false), "send");
		assert.equal(enterAction(k({ code: "" }), false), "send");
		assert.equal(enterAction(k({ shiftKey: true }), false), "newline");
		assert.equal(enterAction(k({ ctrlKey: true }), false), "send");
		assert.equal(enterAction(k({ metaKey: true, shiftKey: true }), false), "send");
		assert.equal(enterAction(k({ key: "a" }), false), "none");
	});
	it("touch: soft Enter is a newline, hardware Enter still sends", () => {
		assert.equal(enterAction(k({ code: "" }), true), "newline");
		assert.equal(enterAction(k({ code: "Unidentified" }), true), "newline");
		assert.equal(enterAction(k({ code: "Enter" }), true), "send");
		assert.equal(enterAction(k({ code: "NumpadEnter" }), true), "send");
		assert.equal(enterAction(k({ code: "", ctrlKey: true }), true), "send");
	});
});
