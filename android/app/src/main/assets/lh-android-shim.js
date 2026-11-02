/*
 * LearnHarness Android shim (step 6: files, folders, downloads).
 * Evaluated by LhJsBridge.kt in the TOP frame of the app origin only, at
 * onPageStarted and again at onPageFinished (idempotent). __LH_TOKEN__ is
 * replaced with a per-process secret so frames that only see the Java object
 * (e.g. sandboxed demo iframes) cannot drive it.
 *
 * Defines ONLY these members of window.lh (merge-friendly: other steps add
 * theirs to the same object; never replace it):
 *   pickFiles(opts?)   -> Promise<{id, files:[{name,path,size}], skipped, error?}>
 *   pickFolder(opts?)  -> Promise<{id, name, files:[{path,size,url}], skipped, error?}>
 *   releaseImport(id)  -> Promise<void>
 *   saveFile(name, blob, mime?) -> Promise<{ok, name?, error?}>
 * It deliberately does NOT define platform, getPathForFile, expandWindow,
 * subscriptionTransport, chatgpt or subscriptions.
 */
(function () {
	"use strict";
	var N = window.__lhAndroidNative;
	var T = "__LH_TOKEN__";
	if (!N || window.__lhFilesShim) return;
	Object.defineProperty(window, "__lhFilesShim", { value: true });

	var lh = window.lh || (window.lh = {});
	var pending = Object.create(null);
	var seq = 0;

	function native(start) {
		return new Promise(function (resolve, reject) {
			var id = "c" + ++seq;
			pending[id] = { resolve: resolve, reject: reject };
			try { start(id); } catch (e) { delete pending[id]; reject(e); }
		});
	}

	// Called from Kotlin via evaluateJavascript.
	Object.defineProperty(window, "__lhNativeCb", {
		value: Object.freeze({
			resolve: function (id, json) {
				var p = pending[id];
				if (!p) return;
				delete pending[id];
				try { p.resolve(JSON.parse(json)); } catch (e) { p.reject(e); }
			},
			progress: function (done, total) {
				window.dispatchEvent(new CustomEvent("lh:import-progress", { detail: { done: done, total: total } }));
			},
			saveUrl: function (url, name, mime) {
				fetch(url).then(function (r) { return r.blob(); }).then(function (b) { return saveBlob(name, b, mime); }).catch(function () {});
			},
		}),
	});

	lh.pickFiles = function (opts) {
		return native(function (id) { N.pickFiles(T, id, JSON.stringify(opts || {})); });
	};
	lh.pickFolder = function (opts) {
		return native(function (id) { N.pickFolder(T, id, JSON.stringify(opts || {})); });
	};
	lh.releaseImport = function (id) {
		try { N.releaseImport(T, String(id)); } catch (e) { /* best effort */ }
		return Promise.resolve();
	};

	// --- saving blobs to Downloads ------------------------------------------
	var CHUNK = 384 * 1024; // multiple of 3: per-chunk base64 concatenates cleanly

	function toBase64(blob) {
		return new Promise(function (resolve, reject) {
			var r = new FileReader();
			r.onload = function () { var s = String(r.result); resolve(s.slice(s.indexOf(",") + 1)); };
			r.onerror = function () { reject(r.error || new Error("read failed")); };
			r.readAsDataURL(blob);
		});
	}

	function saveBlob(name, blob, mime) {
		var id = N.saveBegin(T, String(name || "download"), String(mime || blob.type || "application/octet-stream"));
		if (!id) return Promise.resolve({ ok: false, error: "refused" });
		var chain = Promise.resolve();
		for (var off = 0; off < blob.size; off += CHUNK) {
			(function (start) {
				chain = chain.then(function () {
					return toBase64(blob.slice(start, start + CHUNK)).then(function (b64) {
						if (!N.saveChunk(T, id, b64)) throw new Error("write failed");
					});
				});
			})(off);
		}
		return chain.then(function () {
			return JSON.parse(N.saveEnd(T, id));
		}, function (e) {
			try { N.saveAbort(T, id); } catch (x) { /* ignore */ }
			return { ok: false, error: String((e && e.message) || e) };
		});
	}
	lh.saveFile = function (name, blob, mime) { return saveBlob(name, blob, mime); };

	// `a.download` with a blob:/data: href is the app's only download shape
	// (components/artifacts/download.ts, ai-elements/conversation.tsx). Both
	// call a.click() on an anchor and revoke the blob URL immediately, which a
	// DownloadListener would see too late, so capture the Blob here.
	var blobs = Object.create(null);
	var origCreate = URL.createObjectURL;
	var origRevoke = URL.revokeObjectURL;
	URL.createObjectURL = function (obj) {
		var url = origCreate.call(URL, obj);
		if (typeof Blob !== "undefined" && obj instanceof Blob) blobs[url] = obj;
		return url;
	};
	URL.revokeObjectURL = function (url) {
		delete blobs[url];
		return origRevoke.call(URL, url);
	};

	function captureDownload(a) {
		if (!a || !a.hasAttribute || !a.hasAttribute("download")) return false;
		var href = a.href || "";
		var name = a.getAttribute("download") || "download";
		if (href.indexOf("blob:") === 0 && blobs[href]) {
			saveBlob(name, blobs[href]);
			return true;
		}
		if (href.indexOf("data:") === 0) {
			fetch(href).then(function (r) { return r.blob(); }).then(function (b) { return saveBlob(name, b); }).catch(function () {});
			return true;
		}
		return false;
	}

	var origClick = HTMLAnchorElement.prototype.click;
	HTMLAnchorElement.prototype.click = function () {
		if (captureDownload(this)) return;
		return origClick.apply(this, arguments);
	};
	document.addEventListener("click", function (e) {
		if (e.defaultPrevented || !e.target || !e.target.closest) return;
		var a = e.target.closest("a[download]");
		if (a && captureDownload(a)) e.preventDefault();
	}, true);
})();
