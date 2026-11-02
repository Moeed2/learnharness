import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLongPress } from "../lib/long-press";
import { isTouchDevice, TOUCH_QUERY } from "../lib/touch";

describe("createLongPress", () => {
	it("fires after the delay with the start coordinates", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const calls: Array<[number, number]> = [];
		const lp = createLongPress((x, y) => calls.push([x, y]));
		lp.start(10, 20);
		t.mock.timers.tick(499);
		assert.equal(calls.length, 0);
		t.mock.timers.tick(1);
		assert.deepEqual(calls, [[10, 20]]);
		assert.equal(lp.consumeFired(), true);
		assert.equal(lp.consumeFired(), false);
	});

	it("cancels when the finger moves past the slop, tolerates jitter", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		let n = 0;
		const lp = createLongPress(() => n++);
		lp.start(0, 0);
		lp.move(5, 5); // 7.07px: within 8
		t.mock.timers.tick(500);
		assert.equal(n, 1);
		lp.start(0, 0);
		lp.move(9, 0);
		t.mock.timers.tick(1000);
		assert.equal(n, 1);
		assert.equal(lp.consumeFired(), false);
	});

	it("does not fire when released early, keeps the flag after a fire", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		let n = 0;
		const lp = createLongPress(() => n++);
		lp.start(0, 0);
		lp.end();
		t.mock.timers.tick(1000);
		assert.equal(n, 0);
		lp.start(0, 0);
		t.mock.timers.tick(500);
		lp.end(); // pointerup after the fire must not clear the click guard
		assert.equal(lp.consumeFired(), true);
	});

	it("restarting resets the fired flag and cancel clears it", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const lp = createLongPress(() => {});
		lp.start(0, 0);
		t.mock.timers.tick(500);
		lp.start(0, 0);
		assert.equal(lp.consumeFired(), false);
		t.mock.timers.tick(500);
		lp.cancel();
		assert.equal(lp.consumeFired(), false);
	});
});

describe("isTouchDevice", () => {
	it("uses the coarse/no-hover query and is false without matchMedia", () => {
		const seen: string[] = [];
		assert.equal(isTouchDevice((q) => (seen.push(q), { matches: true })), true);
		assert.deepEqual(seen, [TOUCH_QUERY]);
		assert.equal(isTouchDevice(() => ({ matches: false })), false);
		assert.equal(isTouchDevice(() => { throw new Error("x"); }), false);
		assert.equal(isTouchDevice(undefined), false);
	});
});
