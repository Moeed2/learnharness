import assert from "node:assert/strict";
import { test } from "node:test";
import { validateBrowserPreferences } from "../src/sync/browser-preferences.ts";

test("portable preferences allow only the four documented non-secret browser keys", () => {
	assert.deepEqual(validateBrowserPreferences({ "lh:sidebar-open": "1", "lh:session-kind-filter": "practice", "lh:keymap": "{}" }), { "lh:sidebar-open": "1", "lh:session-kind-filter": "practice", "lh:keymap": "{}" });
	assert.throws(() => validateBrowserPreferences({ access_token: "secret" }), /preference/i);
	assert.throws(() => validateBrowserPreferences({ "lh:sidebar-open": "yes" }), /preference/i);
	assert.throws(() => validateBrowserPreferences({ "lh.graph.camera.v1": '{"x":0,"y":0,"k":-1}' }), /preference/i);
});
