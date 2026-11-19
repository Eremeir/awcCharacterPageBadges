/**
 * Build step for the badge database. Reads the hand-edited, comment-friendly
 * badges.jsonc, rewrites eligible animated badge URLs to their AVIF equivalents, and
 * writes the result as plain badges.json (the file the userscript caches).
 *
 * It also writes badgesIndex.json: a smaller, character-free copy for the awc.moe userscript, with every badge's
 * section and group taken from the comments in badges.jsonc.
 */
const fs = require("fs");
const INDEX_FILE = "badgesIndex.json";
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

/* ---------------- INDEX DATABASE ---------------- */
/*
badgesIndex.json is a compact copy of the database for scripts that need to know where each badge belongs rather than which characters it is for:
	{
		"badges": [ { id, name, image?, animated?, animatedOriginalExtension?, thread, unofficial?, legacy? }, ... ],
		"sections": [ { name, media?, start, end, groups?: [ { name, start, end }, ... ] }, ... ]
	}
*/

/**
 * Turns a comment title into a display name: drops a trailing "BADGES" and a "2018-20XX" year range, and converts ALL CAPS to Title Case.
 * Titles that already have lower case letters are left as written.
 *
 * @param {string} title Comment text, without the comment markers.
 * @returns {string}
 */
function cleanTitle(title) {
	let result = title.replace(/\s+BADGES$/, "").replace(/\s*\d{4}\s*[–-]\s*20XX\b/, "").trim();
	if(!/[a-z]/.test(result)) {
		result = result.toLowerCase().replace(/(^|[\s-])([a-z])/g, (match, separator, letter) => separator + letter.toUpperCase()).replace(/\bOf\b/g, "of");
	}
	return result;
}

/**
 * Reads the layout out of the comments in the raw JSONC, which parseJSONC throws away.
 *
 * A comment on a line of its own is a header. There are three kinds, told apart by their text:
 *	- "/* ---------------- NAME ---------------- *\/" starts a top-level block (e.g. SPECIAL, ANIME BADGES, UNOFFICIAL BADGES).
 *	- A title ending in "BADGES" starts a section (e.g. ANIME GENRE BADGES). Badges with no section of their own belong to the top-level block.
 *	- Any other title (e.g. "/* Action *\/") names a group inside the current section.
 * Each badge belongs to the headers above it. A leading "Anime"/"Manga" on the name is split off as the media.
 *
 * @param {string} text Raw JSONC source.
 * @returns {Array<{id: string, name: string, media: string|null, group: string|null}>} One entry per badge, in file order.
 */
function readLayout(text) {
	const layout = [];
	let top = null;
	let section = null;
	let group = null;

	for(const line of text.split("\n")) {
		const header = /^\s*\/\*\s*(.*?)\s*\*\/\s*$/.exec(line);
		if(header) {
			const topMatch = /^-{3,}\s*(.*?)\s*-{3,}$/.exec(header[1]);
			if(topMatch) { top = cleanTitle(topMatch[1]); section = null; group = null; }
			else if(/\bBADGES$/.test(header[1])) { section = cleanTitle(header[1]); group = null; }
			else { group = cleanTitle(header[1]); }
			continue;
		}

		const id = /^\s*"id"\s*:\s*"([^"]+)"/.exec(line);
		if(id) {
			const title = section ?? top;
			const media = /^(Anime|Manga)\s+(.+)$/.exec(title ?? "");
			layout.push({id: id[1], name: media ? media[2] : title, media: media ? media[1] : null, group});
		}
	}
	return layout;
}

/**
 * Builds the badgesIndex.json contents.
 *
 * Throws, which fails the CI run, if the comments cannot be matched to the badges one for one, if a badge has no section,
 * or if a legacy badge (an ID ending in LGCY) has no current badge to pair with.
 *
 * @param {string} text Raw JSONC source, for the comments.
 * @param {{challenges: object[]}} data The parsed (and AVIF-converted) database.
 * @returns {{badges: object[], sections: object[]}}
 */
function buildIndex(text, data) {
	const challenges = data.challenges;
	const layout = readLayout(text);

	const mismatch = layout.findIndex((entry, i) => entry.id !== challenges[i]?.id);
	if(layout.length !== challenges.length || mismatch !== -1) {
		throw new Error(`Could not match the section comments in badges.jsonc to its badges (found ${layout.length} IDs in the text, ${challenges.length} parsed${mismatch === -1 ? "" : `, first difference at #${mismatch + 1}: "${layout[mismatch].id}" vs "${challenges[mismatch]?.id}"`}).`);
	}
	const unplaced = layout.find(entry => !entry.name);
	if(unplaced) { throw new Error(`Badge "${unplaced.id}" is not under any section comment in badges.jsonc.`); }

	const indexOfID = new Map(challenges.map((challenge, i) => [challenge.id, i]));
	const badges = challenges.map(challenge => {
		const badge = {id: challenge.id, name: challenge.name};
		if(challenge.image) { badge.image = challenge.image; }
		if(challenge.animated) { badge.animated = challenge.animated; }
		if(challenge.animatedOriginalExtension) { badge.animatedOriginalExtension = challenge.animatedOriginalExtension; }
		badge.thread = challenge.thread;
		if(challenge.unofficial) { badge.unofficial = true; }
		return badge;
	});

	badges.forEach((badge, i) => {
		if(!/LGCY$/.test(badge.id)) { return; }
		const current = indexOfID.get(badge.id.replace(/LGCY$/, ""));
		if(current === undefined) { throw new Error(`Legacy badge "${badge.id}" has no current badge "${badge.id.replace(/LGCY$/, "")}" to pair with.`); }
		badges[current].legacy = i;
	});

	const sections = [];
	layout.forEach((entry, i) => {
		let section = sections[sections.length - 1];
		if(!section || section.name !== entry.name || (section.media ?? null) !== entry.media) {
			section = {name: entry.name};
			if(entry.media) { section.media = entry.media; }
			section.start = i;
			sections.push(section);
		}
		section.end = i + 1;

		if(entry.group === null) { return; }
		section.groups ??= [];
		let group = section.groups[section.groups.length - 1];
		if(!group || group.name !== entry.group || group.end !== i) {
			group = {name: entry.group, start: i};
			section.groups.push(group);
		}
		group.end = i + 1;
	});

	return {badges, sections};
}

/* ---------------- MAIN ---------------- */
/**
 * Converts badges.jsonc to badges.json, switching eligible animated badges to AVIF,
 * writes badgesIndex.json, and prints summary statistics.
 */
async function main() {
	const text = fs.readFileSync("badges.jsonc", "utf8");
	const data = parseJSONC(text);

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

	const index = buildIndex(text, data);	//After the AVIF conversion above, so it carries the same animated URLs
	const indexOutput = JSON.stringify(index);	//No indentation: nobody edits it, and it is the one the userscript downloads
	fs.writeFileSync(INDEX_FILE, indexOutput);

	console.log(`Generated badges.json (${data.challenges.length} challenges, ${output.length} bytes)`);
	console.log(`Generated ${INDEX_FILE} (${index.badges.length} badges in ${index.sections.length} sections, ${indexOutput.length} bytes)`);
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
