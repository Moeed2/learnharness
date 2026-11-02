"use strict";

// OAuth loopback callback response. Desktop and web: the original plain-text
// acknowledgement, byte for byte. Android only (LH_ANDROID=1): a small HTML
// page that hands the user back to the app through a deep link, because a
// browser tab opened from the app never closes itself.
const TEXT = "Return to LearnHarness to view the sign-in result. You may close this tab.";
const APP_LINK = "learnharness://auth-done";

function plainCallback() {
	return { status: 200, headers: { "content-type": "text/plain; charset=utf-8" }, body: TEXT };
}

/** @param {{ failed?: boolean, nonce: string }} options */
function androidCallback({ failed = false, nonce }) {
	const link = `${APP_LINK}?status=${failed ? "error" : "ok"}`;
	const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LearnHarness</title>`
		+ `<meta http-equiv="refresh" content="0;url=${link}"><style>body{font:18px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;text-align:center}a{display:inline-block;margin-top:24px;padding:14px 28px;border-radius:10px;background:#111;color:#fff;text-decoration:none}</style></head>`
		+ `<body><p>${failed ? "Sign-in did not complete." : "Sign-in finished."}</p><a href="${link}">Return to LearnHarness</a>`
		+ `<script nonce="${nonce}">setTimeout(function(){location.href=${JSON.stringify(link)}},50)</script></body></html>`;
	return {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`,
		},
		body,
	};
}

/** Pick the response. `android` comes from LH_ANDROID=1 (see createChatGPT). */
function callbackResponse({ android = false, failed = false, nonce = "" } = {}) {
	return android ? androidCallback({ failed, nonce }) : plainCallback();
}

module.exports = { callbackResponse, APP_LINK };
