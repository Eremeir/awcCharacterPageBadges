const fs = require("fs");
const PLACEHOLDER_URL = "https://cdn.awc.moe/static/web/images/badge-placeholder.png";
const URL_CONCURRENCY = 10;
const URL_TIMEOUT = 10000;
const MAX_RETRIES = 2;

/* ---------------- JSONC STRIPPER ---------------- */
/**
 * Parses JSON that contains comments (JSONC).
 *
 * Block comments are removed first. Line comments are then removed one line at a time, tracking whether the scan is inside a string.
 *
 * @param {string} text Raw JSONC source.
 * @returns {any} The parsed JSON.
 */
function parseJSONC(text) {	//Strip comments from JSONC
	text = text.replace(/\/\*[\s\S]*?\*\//g, "");	//Remove block comments /* ... */
	const lines = text.split("\n").map(line => {	//Remove line comments outside of strings
		let inString = false;
		let result = "";
		for(let i = 0; i < line.length; i++) {
			if(line[i] === '"' && line[i - 1] !== "\\") inString = !inString;	//Toggle on unescaped quotes
			if(!inString && line[i] === "/" && line[i + 1] === "/") { break; }	//Rest of the line is a comment
			result += line[i];
		}
		return result;
	});
	return JSON.parse(lines.join("\n"));
}

/* ---------------- URL CHECKING ---------------- */
/**
 * Requests a URL, retrying on network errors or timeouts.
 *
 * Uses a HEAD request to avoid downloading the image, falling back to GET if necessary.
 * Only retries on thrown errors, HTTP errors are considered a final response.
 *
 * @param {string} url The URL to check.
 * @returns {Promise<{ok: boolean, status?: number, contentType?: string, error?: string}>}
 *   On a response: `ok`, `status` and the lowercased `contentType`. If every attempt
 *   threw: `ok: false` and an `error` message ("timeout" for aborted requests).
 */
async function checkURL(url) {
	for(let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		const controller = new AbortController();	//Use a fresh controller per attempt, since an aborted signal cannot be reused
		const timeout = setTimeout(() => { controller.abort(); }, URL_TIMEOUT);

		try {
			let response = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });

			if(response.status === 405 || response.status === 501) {	//HEAD unsupported
				response = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
			}

			const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
			return { ok: response.ok, status: response.status, contentType };
		}
		catch(error) {
			if(attempt === MAX_RETRIES) {	//Report only after the final attempt; earlier failures just loop and retry
				return { ok: false, error: error.name === "AbortError" ? "timeout" : error.message };
			}
		}
		finally { clearTimeout(timeout); }	//Always cancel the timer so it cannot abort a later request
	}
}

/* ---------------- MAIN ---------------- */
/**
 * Collects every unique badge URL from the database, checks them in batches, and
 * reports failures and statistics. Exits with code 1 if any URL failed.
 */
async function main() {
	const data = parseJSONC(fs.readFileSync("badges.jsonc", "utf8"));
	const urls = new Map();	//URL -> { challenge, type }
	const httpStatusCounts = new Map();	//HTTP status -> how many URLs returned it
	let imageURLCount = 0;
	let animatedURLCount = 0;
	let placeholderCount = 0;
	let httpSuccessCount = 0;
	let httpFailureCount = 0;
	let nonImageCount = 0;

	let challengeCount = data.challenges.length;
	for(const challenge of data.challenges) {
		if(challenge.image === PLACEHOLDER_URL || challenge.animated === PLACEHOLDER_URL) { placeholderCount++; }
		if(challenge.image && challenge.image !== PLACEHOLDER_URL) {	//The placeholder is counted above but never requested
			imageURLCount++;
			urls.set(challenge.image, {challenge: challenge.id, type: "image"});
		}
		if(challenge.animated && challenge.animated !== PLACEHOLDER_URL) {
			animatedURLCount++;
			urls.set(challenge.animated, {challenge: challenge.id, type: "animated"});
		}
	}

	const entries = [...urls.entries()];
	console.log(`Checking ${entries.length} unique URLs...`);

	let errors = 0;
	let checked = 0;
	//Process in fixed-size batches: each batch runs concurrently and must finish before the next begins
	for(let i = 0; i < entries.length; i += URL_CONCURRENCY) {
		const batch = entries.slice(i, i + URL_CONCURRENCY);

		await Promise.all(
			batch.map(async ([url, info]) => {
				const result = await checkURL(url);
				checked++;
				//Network-level failures have no status, so they are left out of the tally
				if(result.status !== undefined) { httpStatusCounts.set(result.status, (httpStatusCounts.get(result.status) ?? 0) + 1); }

				if(result.ok) {
					httpSuccessCount++;
				} else {
					httpFailureCount++;
					console.error(`FAIL ${info.type} on ${info.challenge}: ${url}`);
					errors++;

					if(result.status !== undefined) {
						console.error(`\tHTTP ${result.status}`);
					} else { console.error(`\t${result.error}`); }
					return;	//Skip the content-type check; there is no usable response
				}
				if(!result.contentType.startsWith("image/")) {	//A successful response can still be wrong through being the wrong format
					nonImageCount++;
					console.error(
						`FAIL ${info.type} on ${info.challenge}: ` +
						`expected image, got ${result.contentType || "unknown"}`
					);
					console.error(`\t${url}`);
					errors++;
				}
			})
		);
	}
	console.log(`\nStatistics:`);
	console.log(`\tChallenges:           ${challengeCount}`);
	console.log(`\tImage URLs:           ${imageURLCount}`);
	console.log(`\tAnimated URLs:        ${animatedURLCount}`);
	console.log(`\tPlaceholder URLs:     ${placeholderCount}`);
	console.log(`\tUnique URLs checked:  ${checked}`);
	console.log(`\tHTTP success:         ${httpSuccessCount}`);
	console.log(`\tHTTP failures:        ${httpFailureCount}`);
	console.log(`\tNon-image responses:  ${nonImageCount}`);
	console.log(`\tHTTP status:`);
	for(const [status, count] of [...httpStatusCounts.entries()].sort((a, b) => a[0] - b[0])) { console.log(`\t\t${status}: ${count}`); }
	if(errors > 0) {
		console.error(`URL validation failed with ${errors} error(s).`);
		process.exit(1);
	}
	console.log("\nURL validation passed.");
}

main().catch(error => {	//Report any unexpected failure and exit non-zero so CI treats the run as failed
	console.error(error);
	process.exit(1);
});
