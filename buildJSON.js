const fs = require("fs");
const CDN_PREFIX = "https://cdn.awc.moe/";
const PLACEHOLDER_URL = "https://cdn.awc.moe/static/web/images/badge-placeholder.png";
const AVIF_CONCURRENCY = 10;

/* ---------------- JSONC STRIPPER ---------------- */
function parseJSONC(text) {	//Strip comments from JSONC
	text = text.replace(/\/\*[\s\S]*?\*\//g, "");	//Remove block comments /* ... */
	const lines = text.split("\n").map(line => {	//Remove line comments outside of strings
		let inString = false;
		let result = "";
		for(let i = 0; i < line.length; i++) {
			if(line[i] === '"' && line[i - 1] !== "\\") inString = !inString;
			if(!inString && line[i] === "/" && line[i + 1] === "/") break;
			result += line[i];
		}
		return result;
	});
	return JSON.parse(lines.join("\n"));
}

/* ---------------- CDN OPTIMIZATION ---------------- */
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
	return response.status === 200 && contentType?.startsWith("image/avif");
}
function getAVIFURL(url) {
	if(!url.startsWith(CDN_PREFIX)) { return null; }

	const match = url.match(/\.(png|gif)$/i);
	if(!match) { return null; }

	return {
		url: url.replace(/\.(png|gif)$/i, ".avif"),
		originalExtension: match[1].toLowerCase()
	}
}

async function main() {
	const data = parseJSONC(fs.readFileSync("badges.jsonc", "utf8"));

	let cdnAnimatedCount = 0;
	let avifAvailableCount = 0;
	let avifUnavailableCount = 0;
	let pngToAvifCount = 0;
	let gifToAvifCount = 0;

	const candidates = [];

	for(const challenge of data.challenges) {
		if(!challenge.animated || challenge.animated === PLACEHOLDER_URL) { continue; }

		const avif = getAVIFURL(challenge.animated);
		if(!avif) { continue; }

		candidates.push({ challenge, avif });
		cdnAnimatedCount++;
	}

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

	const output = JSON.stringify(data, null, 2);
	fs.writeFileSync("badges.json", output);

	console.log(`Generated badges.json (${data.challenges.length} challenges, ${output.length} bytes)`);
	console.log(`\nCDN optimization:`);
	console.log(`\tCDN animated badges: ${cdnAnimatedCount}`);
	console.log(`\tAVIF available: ${avifAvailableCount}`);
	console.log(`\tAVIF unavailable: ${avifUnavailableCount}`);
	console.log(`\tPNG → AVIF: ${pngToAvifCount}`);
	console.log(`\tGIF → AVIF: ${gifToAvifCount}`);
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
