/**
 * Build step for the badge database. Reads the hand-edited, comment-friendly
 * badges.jsonc, rewrites eligible animated badge URLs to their AVIF equivalents, and
 * writes the result as plain badges.json (the file the userscript caches).
 */
const fs = require("fs");
const CDN_PREFIX = "https://cdn.awc.moe/";	//Only badges hosted here have known AVIF counterparts
const PLACEHOLDER_URL = "https://cdn.awc.moe/static/web/images/badge-placeholder.png";
//const AVIF_CONCURRENCY = 10;

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

/* ---------------- CDN OPTIMIZATION ---------------- */
/*
Disabled check that an .avif file really exists on the CDN before switching to it. Without it,
the build assumes every CDN .png/.gif has a matching .avif, and the userscript falls back to the original file at runtime if one is missing.

async function checkAVIF(url) {
	let response = await fetch(url, {
		method: "HEAD",
		redirect: "follow"
	});
	if(response.status === 405 || response.status === 501) {
		response = await fetch(url, {
			method: "GET",
			redirect: "follow"
		});
	}

	const contentType = response.headers.get("content-type")?.toLowerCase();
	return response.ok && contentType?.startsWith("image/avif");
}*/

/**
 * Works out the AVIF URL for a CDN-hosted PNG or GIF.
 *
 * @param {string} url Current animated image URL.
 * @returns {{url: string, originalExtension: string}|null} The AVIF URL plus the extension it replaced (lowercase, without the dot),
 * or null if the URL is not on the AWC CDN or is not a .png/.gif.
 */
function getAVIFURL(url) {
	if(!url.startsWith(CDN_PREFIX)) { return null; }

	const match = url.match(/\.(png|gif)$/i);
	if(!match) { return null; }

	return {
		url: url.replace(/\.(png|gif)$/i, ".avif"),
		originalExtension: match[1].toLowerCase()
	}
}

/* ---------------- MAIN ---------------- */
/**
 * Converts badges.jsonc to badges.json, switching eligible animated badges to AVIF
 * and printing summary statistics.
 */
async function main() {
	const data = parseJSONC(fs.readFileSync("badges.jsonc", "utf8"));

	let cdnAnimatedCount = 0;
	//let avifAvailableCount = 0;
	//let avifUnavailableCount = 0;
	let pngToAvifCount = 0;
	let gifToAvifCount = 0;

	//const candidates = [];

	for(const challenge of data.challenges) {
		if(!challenge.animated || challenge.animated === PLACEHOLDER_URL) { continue; }	//Skip badges with no animation, and any using the placeholder url

		const avif = getAVIFURL(challenge.animated);
		if(!avif) { continue; }	//Not CDN-hosted or not a PNG/GIF

		//candidates.push({ challenge, avif });
		cdnAnimatedCount++;

		if(avif.originalExtension === "gif") {	//PNG is the script's default assumption
			gifToAvifCount++;
			challenge.animatedOriginalExtension = ".gif";	//Include original extension in case of image load failure fallback
		} else { pngToAvifCount++; }
		challenge.animated = avif.url;
	}

	/*
	Disabled polling of AWC.moe badge caches in sets of AVIF_CONCURRENCY.

	for(let i = 0; i < candidates.length; i += AVIF_CONCURRENCY) {
		const batch = candidates.slice(i, i + AVIF_CONCURRENCY);

		await Promise.all(batch.map(async ({ challenge, avif }) => {
			try {
				const available = await checkAVIF(avif.url);
				if(available) {
					avifAvailableCount++;
					if(avif.originalExtension === "gif") {
						gifToAvifCount++;
						challenge.animatedOriginalExtension = ".gif";
					}
					else { pngToAvifCount++; }
					challenge.animated = avif.url;
				}
				else {
					avifUnavailableCount++;
					console.warn(`AVIF unavailable for "${challenge.name}": ${avif.url}`);
				}
			}
			catch(error) {
				avifUnavailableCount++;
				console.warn(`Failed to check AVIF for "${challenge.name}": ${avif.url}`);
			}
		}));
	}
	*/

	const output = JSON.stringify(data, null, 2);
	fs.writeFileSync("badges.json", output);

	console.log(`Generated badges.json (${data.challenges.length} challenges, ${output.length} bytes)`);
	console.log(`\nCDN optimization:`);
	console.log(`\tCDN animated badges: ${cdnAnimatedCount}`);
	//console.log(`\tAVIF available: ${avifAvailableCount}`);
	//console.log(`\tAVIF unavailable: ${avifUnavailableCount}`);
	console.log(`\tPNG → AVIF: ${pngToAvifCount}`);
	console.log(`\tGIF → AVIF: ${gifToAvifCount}`);
}

main().catch(error => {	//Report any failure and exit non-zero so CI treats the build as failed
	console.error(error);
	process.exit(1);
});
