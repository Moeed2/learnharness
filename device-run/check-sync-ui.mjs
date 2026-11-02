import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
	await page.setViewport({ width: 1440, height: 1000 });
	const hydrated = page.waitForResponse(response => response.url().endsWith('/api/sync'), { timeout: 15000 });
	await page.goto("http://127.0.0.1:3467", { waitUntil: "domcontentloaded" });
	await hydrated;
	await page.waitForSelector('[data-testid="settings-entry"]');
	await page.click('[data-testid="settings-entry"]');
	await page.waitForSelector('[data-testid="settings-nav-sync"]');
	await page.click('[data-testid="settings-nav-sync"]');
	await page.waitForSelector('#sync-relay-url');
	await page.waitForSelector('[data-testid="settings-nav-sync"][aria-current="true"]');
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({ path: "device-run/sync-settings-desktop.png", fullPage: true });
	const text = await page.locator('[data-testid="section-sync"]').map(element => element.innerText).wait();
	console.log(JSON.stringify({ desktop: text, errors }));
	await page.setViewport({ width: 768, height: 1024 });
	await page.waitForSelector('#sync-relay-url');
	await page.screenshot({ path: "device-run/sync-settings-tablet.png", fullPage: true });
	const result = await page.evaluate(async () => {
		const bad = await fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'configure', relayUrl: 'https://invalid.example' }) });
		const good = await fetch('/api/sync');
		return { blockedMutation: bad.status, status: await good.json() };
	});
	console.log(JSON.stringify(result));
} catch (error) {
	console.log(JSON.stringify({ errors }));
	await page.screenshot({ path: "device-run/sync-ui-error.png", fullPage: true });
	console.log((await page.locator('body').map(element => element.innerText).wait()).slice(0, 2000));
	throw error;
} finally { await browser.close(); }
