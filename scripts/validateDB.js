/**
 * Structural validation for badges.jsonc. Checks that every challenge has a unique,
 * well-formed ID, a name, a non-empty list of valid character IDs, at least one HTTPS
 * image URL (with no URL used twice), and a valid forum thread ID.
 *
 * Prints every problem found, then exits with code 1 if there were any (so it can gate
 * CI). On success it prints summary statistics. It does not make network requests;
 * validateURLs.js checks that the URLs actually respond.
 */
const fs = require("fs");
const PLACEHOLDER_URL = "https://cdn.awc.moe/static/web/images/badge-placeholder.png";	//Shared by many badges, so exempt from the uniqueness check

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

const data = parseJSONC(fs.readFileSync("badges.jsonc", "utf8"));

/* ---------------- URL UNIQUENESS ---------------- */
const seenBadgeURLs = new Map();	//URL -> ID of the challenge that first used it

/**
 * Checks that a badge URL has not already been used by another challenge, placeholders excluded.
 *
 * @param {string|undefined} url The URL to check.
 * @param {string} challengeID Challenge being validated, for error messages and tracking.
 * @param {string} type "image" or "animated"; used in the error message only.
 * @returns {boolean} False (after logging an error) if the URL is a duplicate.
 */
function validateUniqueURL(url, challengeID, type) {
	if(!url || url === PLACEHOLDER_URL) { return true; }

	const existing = seenBadgeURLs.get(url);
	if(existing) {
		console.error(`Duplicate ${type} URL on ${challengeID} (already used by ${existing})`);
		return false;
	}
	seenBadgeURLs.set(url, challengeID);
	return true;
}

if(!Array.isArray(data.challenges)) {
	console.error("Database must contain a challenges array.");
	process.exit(1);	//Without a challenges array there's nothing to check
}

/* ---------------- CHALLENGE VALIDATION ---------------- */
const seenIDs = new Set();
let errors = 0;	//Problems are counted rather than aborting on the first, so one run reports everything

for(const challenge of data.challenges) {
	//ID: must exist, be unique, and be a letter followed by letters/digits/underscores/hyphens
	if(typeof challenge.id !== "string" || !challenge.id.trim()) {
		console.error(`Missing or invalid ID: ${challenge.name ?? "(unnamed challenge)"}`);
		errors++;
		continue;``
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

	// Character validation: each must be a positive integer AniList ID, with no repeats within a challenge
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

	//Static image: Must be a string holding a unique HTTPS link
	if(challenge.image !== undefined) {
		if(typeof challenge.image !== "string" || !challenge.image.trim()) {
			console.error(`Invalid image on ${challenge.id}`);
			errors++;
		}
		else if(!/^https:\/\//.test(challenge.image)) {
			console.error(`Image URL must use HTTPS on ${challenge.id}`);
			errors++;
		}
		else if(!validateUniqueURL(challenge.image, challenge.id, "image")) { errors++; }
	}

	//Animated imagez: Must be a string holding a unique HTTPS link
	if(challenge.animated !== undefined && (typeof challenge.animated !== "string" || !challenge.animated.trim())) {
		console.error(`Invalid animated image URL on ${challenge.id}`);
		errors++;
	}
	if(challenge.animated && !/^https:\/\//.test(challenge.animated)) {
		console.error(`Animated image URL must use HTTPS on ${challenge.id}`);
		errors++;
	} else if(challenge.animated && !validateUniqueURL(challenge.animated, challenge.id, "animated")) { errors++; }

	//Enforce having a display field
	if(!challenge.image && !challenge.animated) {
		console.error(`Challenge must have image or animated URL on ${challenge.id}`);
		errors++;
	}

	//Thread ID is used to build the AniList forum link
	if(!Number.isInteger(challenge.thread) || challenge.thread <= 0) {
		console.error(`Invalid thread on ${challenge.id}`);
		errors++;
	}
}

if(errors > 0) {
	console.error(`\nValidation failed with ${errors} error(s).`);
	process.exit(1);
}


/* ---------------- STATISTICS ---------------- */
const uniqueCharacters = new Set();
let placeholderCount = -1;	// Intentional display of the Placeholder Nico Badge

for(const challenge of data.challenges) {
	for(const characterID of challenge.characters) {
		uniqueCharacters.add(characterID);
	}
	if(challenge.image === PLACEHOLDER_URL || challenge.animated === PLACEHOLDER_URL) { placeholderCount++; }
}

const animatedCount = data.challenges.filter(c => c.animated).length;
const unofficialCount = data.challenges.filter(c => c.unofficial).length;
console.log(`Validation passed. Checked ${data.challenges.length} challenges.`);
console.log(`\tUnique characters: ${uniqueCharacters.size}`);
console.log(`\tAnimated badges: ${animatedCount}`);
console.log(`\tPlaceholder badges: ${placeholderCount}`);
console.log(`\tUnofficial badges: ${unofficialCount}`);
