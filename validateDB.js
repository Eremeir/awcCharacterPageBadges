const fs = require("fs");
const PLACEHOLDER_URL = "https://cdn.awc.moe/static/web/images/badge-placeholder.png";

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

const data = parseJSONC(fs.readFileSync("badges.jsonc", "utf8"));

if(!Array.isArray(data.challenges)) {
	console.error("Database must contain a challenges array.");
	process.exit(1);
}

const seenIDs = new Set();
let errors = 0;

for(const challenge of data.challenges) {
	if(typeof challenge.id !== "string" || !challenge.id.trim()) {
		console.error(`Missing or invalid ID: ${challenge.name ?? "(unnamed challenge)"}`);
		errors++;
		continue;
	}
	if(seenIDs.has(challenge.id)) {
		console.error(`Duplicate ID: ${challenge.id}`);
		errors++;
	}
	seenIDs.add(challenge.id);
	if(!/^[A-Za-z][A-Za-z0-9_-]*$/.test(challenge.id)) {
		console.error(`Invalid ID format: ${challenge.id}`);
		errors++;
	}

	if(typeof challenge.name !== "string" || !challenge.name.trim()) {
		console.error(`Invalid name on ${challenge.id}`);
		errors++;
	}

	if(!Array.isArray(challenge.characters)) {
		console.error(`Invalid characters array on ${challenge.id}`);
		errors++;
		continue;
	}

	if(challenge.characters.length === 0) {
		console.error(`Empty character list on ${challenge.id}`);
		errors++;
	}

	// Character validation
	const seenCharacters = new Set();
	for(const characterID of challenge.characters) {
		if(!Number.isInteger(characterID) || characterID <= 0) {
			console.error(`Invalid character ID "${characterID}" on ${challenge.id}`);
			errors++;
		}

		if(seenCharacters.has(characterID)) {
			console.error(`Duplicate character ID "${characterID}" on ${challenge.id}`);
			errors++;
		}
		seenCharacters.add(characterID);
	}

	if(typeof challenge.image !== "string" || !challenge.image.trim()) {
		console.error(`Invalid image on ${challenge.id}`);
		errors++;
	}
	else if(!/^https:\/\//.test(challenge.image)) {
		console.error(`Image URL must use HTTPS on ${challenge.id}`);
		errors++;
	}

	if(challenge.animated !== undefined && (typeof challenge.animated !== "string" || !challenge.animated.trim())) {
		console.error(`Invalid animated image URL on ${challenge.id}`);
		errors++;
	}
	if(challenge.animated && !/^https:\/\//.test(challenge.animated)) {
		console.error(`Animated image URL must use HTTPS on ${challenge.id}`);
		errors++;
	}

	if(!Number.isInteger(challenge.thread) || challenge.thread <= 0) {
		console.error(`Invalid thread on ${challenge.id}`);
		errors++;
	}
}

if(errors > 0) {
	console.error(`\nValidation failed with ${errors} error(s).`);
	process.exit(1);
}

const uniqueCharacters = new Set();
let placeholderCount = -1;	// Nico Badge

for(const challenge of data.challenges) {
	for(const characterID of challenge.characters) {
		uniqueCharacters.add(characterID);
	}
	if(challenge.image === PLACEHOLDER_URL || challenge.animated === PLACEHOLDER_URL) { placeholderCount++; }
}

const animatedCount = data.challenges.filter(c => c.animated).length;
const unofficialCount = data.challenges.filter(c => c.unofficial).length;
console.log(`Validation passed. Checked ${data.challenges.length} challenges.`);
console.log(`Unique characters: ${uniqueCharacters.size}`);
console.log(`Animated badges: ${animatedCount}`);
console.log(`Placeholder badges: ${placeholderCount}`);
console.log(`Unofficial badges: ${unofficialCount}`);
