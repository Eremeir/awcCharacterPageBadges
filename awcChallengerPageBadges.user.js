// ==UserScript==
// @name         AWC Challenger Page Badges
// @namespace    https://github.com/Eremeir
// @version      1.0.2
// @description  Shows the badges a challenger has not earned yet inside their categories on awc.moe, with a switch in the page header
// @author       Eremeir
// @homepageURL  https://github.com/Eremeir/awcCharacterPageBadges
// @supportURL   https://github.com/Eremeir/awcCharacterPageBadges/issues
// @match        https://awc.moe/challenger/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      eremeir.github.io
// @license      Unlicense
// ==/UserScript==

/**
 * AWC Challenger Page Badges
 *
 * On a challenger's page on awc.moe, adds the badges they have not earned yet to the page's own categories, so the page shows the whole collection.
 *
 * Overview of how it works:
 *   1. badgesIndex.json (built by CI from the badge database, with every badge's category already worked out) is fetched from GitHub Pages,
 *      cached in localStorage, and refreshed in the background (via its ETag) once the cache expires.
 *   2. Ownership comes from the page itself: every badge image it shows (including hidden legacy images) is matched to the database by URL
 *      (or, if the site has moved the picture, by forum thread).
 *   3. The script learns the page's layout as it loads: the Special/Anime/Manga boxes, each category's header, and the badge list under it.
 *      Unowned badges are slotted into the matching list in database order, dimmed so they are easy to tell apart.
 *   4. If the challenger has no badges in a category (or in a whole box), the script makes the header and list by copying an existing one.
 *   5. If the layout is not recognised, the unowned badges go in one separate section instead, so nothing is lost.
 *   6. Buttons in the page header turn the unowned badges off and on (off leaves the page as the site made it), turn the 3D tilt on and off,
 *      and open the settings. A collapsible dashboard under the stats shows progress by category, with or without the unowned badges.
 */
(function () {
"use strict";

/* ---------------- CONFIG ---------------- */
const DB_URL = "https://eremeir.github.io/awcCharacterPageBadges/badgesIndex.json";
const GITHUB_URL = "https://github.com/Eremeir/awcCharacterPageBadges";	//The repository both scripts share; also where issues and suggestions go
const GREASYFORK_URL = "https://greasyfork.org/en/scripts/606817-awc-challenger-page-badges";	//This script's Greasy Fork page.
const SISTER_URL = "https://greasyfork.org/en/scripts/569079-awc-character-page-badges";	//The Character Page script's Greasy Fork page.
const CACHE_ENABLED = true;	//Keep the downloaded database in localStorage. Set to false to download it on every page load
const CACHE_KEY = "awc_badges_index_cache";	//localStorage key; stores { etag, timestamp, data }. Rename it (e.g. add _v2) to discard everyone's cached copy after a data-format change
const CACHE_TTL = 2 * 24 * 60 * 60 * 1000;	//2 Days, in milliseconds. Once expired, the cache is used one last time while a background refresh checks for changes
const SEASON_WEEKS = 17;	//How long a seasonal badge stays obtainable after its season starts
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const unreadableWarned = new Set();
const STAFF_AFTER_SUPPORTERS = 1000000;	//Added to a staff badge's place in the order so it falls after every supporter badge
const ADD_MISSING_SWITCHES = true;	//Give the page's own badges a legacy switch when the database has a legacy version of them and the page has no switch (Classic 2017-2019)

/* ---------------- SETTINGS ---------------- */
//Changed from the gear button in the page header; stored by the userscript manager (GM_setValue), so they survive clearing the site's data and script updates.
//The defaults below are used until something is saved. The last state of the Unowned and Tilt buttons and of the dashboard is always kept.
const SETTINGS_KEY = "settings";
const DEFAULT_SETTINGS = {
	mode: "off",	//The Unowned button's last state: "off", "obtainable" (unowned badges that can still be earned) or "all" (also the ones that can no longer be earned)
	tilt: true,	//The Tilt button's last state: the 3D tilt on the page's badges
	dashboardOpen: false,	//Whether the dashboard was left open
	showDashboard: true,	//The progress dashboard under Place / Rank / Points
	dashboardClubs: true,	//Dashboard: split the categories into AWC and MRC sections (off: one combined list)
	dashboardWarn: true,	//Dashboard: a ! after the percentage of a row that has an unowned badge which is open now but will close
	showSupporters: true,	//Unowned Supporter and Staff badges (they can never be earned, so they only appear in the "All" mode)
	showUnofficial: false,	//Unofficial community-made badges
	unofficialOwner: "",	//The AniList username whose page can mark unofficial badges as owned (not case-sensitive)
	unofficialMarks: {}	//Unofficial badges marked as owned: {badge id: link to the person's AniList activity (not checked)}
};
const SETTING_OPTIONS = [	//Order and labels for the settings panel; "requires" greys an option out while the setting it depends on is off
	{key: "showDashboard", label: "Progress dashboard", description: "A collapsible progress panel under Place / Rank / Points"},
	{key: "dashboardClubs", label: "Split into AWC and MRC", description: "Group the dashboard's categories under AWC and MRC sections; off shows one combined list", requires: "showDashboard"},
	{key: "dashboardWarn", label: "Warn about time-limited badges", description: "Adds a ! after a row's percentage when you are missing a badge that is open now but will not be around forever", requires: "showDashboard"},
	{key: "showSupporters", label: "Show supporter badges", description: "Supporter and Staff badges you do not own"},
	{key: "showUnofficial", label: "Show unofficial badges", description: "Unofficial community-made badges which can be marked as owned locally"}
];

/** @returns {string} The lower-cased username in the page's address (/challenger/<name>), or "". */
function pageUsername() {
	const match = /^\/challenger\/([^/]+)/.exec(location.pathname);
	if(!match) { return ""; }
	try { return decodeURIComponent(match[1]).toLowerCase(); } catch { return match[1].toLowerCase(); }
}

/** @returns {boolean} Whether this is the page of the username saved in the settings (names are not case-sensitive), with unofficial badges on. */
function onOwnPage() {
	const owner = String(settings.unofficialOwner ?? "").trim().toLowerCase();
	return settings.showUnofficial && owner !== "" && owner === pageUsername();
}

/** Counts the unofficial badges marked as owned as owned (granted), on the saved username's own page only. */
function applyMarks(scan, data) {
	if(!onOwnPage()) { return scan; }
	for(const group of data.groups) {
		if(group.target.title === "Unofficial" && Object.hasOwn(settings.unofficialMarks, data.badges[group.current].id) && !scan.owned.has(group.current)) { scan.granted.add(group.current); }
	}
	return scan;
}

/** @returns {boolean} Whether a badge group is a Supporter or Staff one the person does not own, which the "Show supporter badges" setting hides. */
function hiddenSupporter(group, owned) {
	return !settings.showSupporters && group.target.title === "Supporter" && !owned;
}

/** @returns {typeof DEFAULT_SETTINGS} Saved settings, with defaults for any that are missing (or newly added). */
function loadSettings() {
	const saved = GM_getValue(SETTINGS_KEY, {});
	const loaded = {...DEFAULT_SETTINGS, ...(saved && typeof saved === "object" ? saved : {})};
	if(!["off", "obtainable", "all"].includes(loaded.mode)) { loaded.mode = DEFAULT_SETTINGS.mode; }
	return loaded;
}
let settings = loadSettings();
function saveSettings() { GM_setValue(SETTINGS_KEY, settings); }

/** Saves a state-like choice (Unowned mode, tilt, dashboard open). */
function remember(key, value) {
	settings[key] = value;
	saveSettings();
}
const THIS_YEAR = new Date().getUTCFullYear();	//Years below run up to now, so a new year needs no edit here
const yearsFrom = first => Array.from({length: THIS_YEAR - first + 1}, (_, i) => first + i);
const LINKED_OWNERSHIP = {	//Owning the badge on the left counts as owning the badges on the right (they are shown as owned, not dimmed, and only while the script is on): "id": ["id", ...]
	"monthly2018DecEasyWreath": ["monthly2018DecEasy"],
	"monthly2018DecHardWreath": ["monthly2018DecHard"],
	"monthly2019FebEasyWreath": ["monthly2019FebEasy"],
	"monthly2019FebHardWreath": ["monthly2019FebHard"],
	"monthly2019DecEasyBonus": ["monthly2019DecEasy"],
	"monthly2019DecHardBonus": ["monthly2019DecHard"]
};
for(const year of yearsFrom(2019)) {	//End of Year: Hard counts as Easy, and Easy as Participation (so Hard counts as both)
	LINKED_OWNERSHIP[`animeYearly${year}Hard`] = [`animeYearly${year}Easy`];
	LINKED_OWNERSHIP[`animeYearly${year}Easy`] = [`animeYearly${year}Part`];
}
const DIM_UNOWNED = true;	//Grey out unowned badges so they can be told apart from earned ones
const HEADED_SECTIONS = ["Anime/Special", "Anime/Seasonal", "Anime/Collection", "Anime/Event"];	//Categories whose groups the page shows under small headings (<h2>) when the script has to make the groups itself. Other categories get one badge row per group, like Genre
const SUBHEADING_MAP = {"Anime/Special": {"Gambler's": "Special", "Zodiac": "Special"}};	//Database groups the page does not give a sub-heading of their own: "Media/Section": {"Group": "Sub-heading they appear under"}
const ROWS_OF = {"Anime/Gacha": 4};	//Categories the page shows in rows of this many badges (one theme per row), in database order, owned badges included: "Media/Section": badges per row
const MANUAL_LEGACY_PAIRS = {};	//Pairs the database does not mark (an id ending in LGCY does that): "current id": "legacy id", e.g. {"kaijuAttack": "kaijuAttackMissing"}. Empty while the database marks every pair itself

/* ---------------- SITE CATEGORIES ---------------- */
const BOXES = ["Special", "Anime", "Manga"];	//The page's three boxes, in order
const MONTHLY_YEARS = yearsFrom(2018);
const CATEGORY_ORDER = {	//Each box's headers in the order the page shows them; used to place a header the page does not have yet
	Special: ["End of Year", "Supporter", "Unofficial"],
	Anime: ["Classic", "Collection", "Event", "Gacha", "Genre", ...MONTHLY_YEARS.map(year => `Monthly ${year}`), "Puzzle", "Seasonal", "Special", "Tier"],
	Manga: ["Collection", "Manga City", "Special", "Tier"]
};
const PLACEHOLDER_URL = "https://cdn.awc.moe/static/web/images/badge-placeholder.png";	//Shared by several badges, so it cannot tell any one of them apart
const SWITCH_ICON = "https://cdn.awc.moe/static/web/images/badge-toggle.svg";	//The site's own legacy-switch icon
const SWITCH_ICON_OLD = "https://cdn.awc.moe/static/web/images/badge-toggle-inverted.svg";	//The same icon while the legacy badge is showing
const LEGACY_CLASSES = "badge-legacy badge-style-legacy";	//Classes of the second (legacy) picture of a pair
const LEGACY_MIN_RATIO = 1.2;	//Legacy-style badges are portrait (520x720, ratio 1.38); new-style badges are square (720x720)

/* ---------------- FETCH DATABASE ---------------- */
/**
 * Returns the database, loading it at most once per page session.
 * The promise is memoised so concurrent callers share a single in-flight request.
 *
 * @returns {Promise<{badges: object[], sections: object[]}>}
 */
function loadDB() {
	if(!dbPromise) {
		dbPromise = loadDBInternal().catch(err => {
			dbPromise = null;	//Retry on failure
			throw err;
		});
	}
	return dbPromise;
}
/**
 * Whether a value has the shape of badgesIndex.json.
 *
 * @param {any} data
 * @returns {boolean}
 */
function isIndex(data) {
	return Array.isArray(data?.badges) && Array.isArray(data?.sections);
}
/**
 * Pulls the ETag out of GM_xmlhttpRequest's raw response header string.
 *
 * @param {string} [headers] Raw headers: one "Name: value" per CRLF-separated line.
 * @returns {string|null} The ETag exactly as sent, or null if there is none.
 */
function parseETag(headers) {
	const match = /^etag:\s*(.+)$/im.exec(headers || "");
	return match ? match[1].trim() : null;
}
/**
 * Reads the cached database record from localStorage.
 *
 * @returns {{etag?: string|null, timestamp: number, data: object}|null} The record, or null if caching is off,
 *   nothing is stored, storage is unreadable, or the stored value does not look like the database.
 */
function readCache() {
	if(!CACHE_ENABLED) { return null; }
	try {
		const record = JSON.parse(localStorage.getItem(CACHE_KEY));
		if(typeof record?.timestamp !== "number" || !isIndex(record.data)) { return null; }
		return record;
	} catch { return null; }	//Corrupt or unavailable storage is treated as a cache miss
}
/**
 * Stores a database record in localStorage. Failures are ignored: the cache is only an optimisation.
 *
 * @param {{etag?: string|null, timestamp: number, data: object}} record
 */
function writeCache({etag, timestamp, data}) {
	if(!CACHE_ENABLED) { return; }
	try {
		localStorage.setItem(CACHE_KEY, JSON.stringify({etag: etag ?? null, timestamp, data}));
	} catch {}
}
/**
 * Downloads badgesIndex.json. When the ETag of an earlier response is supplied it is sent as If-None-Match,
 * so an unchanged file comes back as a tiny 304 instead of a full download.
 *
 * @param {string|null} [etag] ETag of the cached copy, if any.
 * @returns {Promise<{notModified: true}|{data: object, etag: string|null}>}
 */
function fetchDB(etag) {
	return new Promise((resolve, reject) => {
		GM_xmlhttpRequest({	//GM_xmlhttpRequest is used rather than fetch() so the request is not blocked by the page's CORS/CSP rules
			method: "GET",
			url: DB_URL,
			headers: etag ? {"If-None-Match": etag} : {},
			timeout: 15000,
			onload: res => {
				if(res.status === 304) { resolve({notModified: true}); return; }
				if(res.status !== 200) { reject(new Error(`HTTP ${res.status}`)); return; }
				try {
					const data = JSON.parse(res.responseText);
					if(!isIndex(data)) { throw new Error("Unexpected data format"); }
					resolve({data, etag: parseETag(res.responseHeaders)});
				} catch (e) { reject(e); }
			},
			onerror: () => reject(new Error("Network error")),
			ontimeout: () => reject(new Error("Request timed out"))
		});
	});
}
/**
 * Revalidates an expired cache in the background; the caller has already used it.
 * If the file is unchanged only the TTL clock restarts. New data replaces the cache and is swapped into dbPromise
 * (it is used from the next page load on; the page already showing is not rebuilt). Any failure leaves the old cache alone.
 *
 * @param {{etag?: string|null, timestamp: number, data: object}} cached The expired record.
 */
function refreshCache(cached) {
	fetchDB(cached.etag).then(result => {
		if(result.notModified || (result.etag && result.etag === cached.etag)) {
			writeCache({...cached, timestamp: Date.now()});
			console.info("AWC Unowned Badges: Database is up to date.");
			return;
		}
		writeCache({etag: result.etag, timestamp: Date.now(), data: result.data});
		dbPromise = Promise.resolve(result.data);
		console.info("AWC Unowned Badges: Database refreshed in the background.");
	}).catch(err => {
		const hours = Math.round((Date.now() - cached.timestamp) / (60 * 60 * 1000));
		console.warn(`AWC Unowned Badges: Could not refresh the database (${err.message}). Using cached data from ${hours} hours ago.`);
	});
}
/**
 * Loads the database: a fresh cache as is, an expired cache immediately (with a background revalidation),
 * or otherwise a blocking fetch that fills the cache. If that fetch fails, the error is rethrown.
 *
 * @returns {Promise<{badges: object[], sections: object[]}>}
 */
async function loadDBInternal() {
	const cached = readCache();
	if(cached) {
		if(Date.now() - cached.timestamp >= CACHE_TTL) { refreshCache(cached); }
		return cached.data;
	}
	const {data, etag} = await fetchDB();
	writeCache({etag, timestamp: Date.now(), data});
	return data;
}

/* ---------------- BADGE HELPERS ---------------- */
/**
 * Reduces an image URL to a comparable form: origin and path only.
 * The site adds a "?format=auto" query to its badge images, which the database's permalinks do not have.
 *
 * @param {string} url
 * @returns {string}
 */
function normalizeImageURL(url) {
	try {
		const parsed = new URL(url, location.href);
		return parsed.origin + parsed.pathname;
	} catch { return url; }
}

/**
 * The file name of an image address without folders, query or extension, lower-cased ("genre-action-easy").
 * The site and the database can disagree on the folder or the format of a picture while keeping its name.
 *
 * @param {string} url
 * @returns {string}
 */
function fileStem(url) {
	let name = normalizeImageURL(url).split("/").pop() ?? "";
	try { name = decodeURIComponent(name); } catch {}
	return name.replace(/\.[a-z0-9]+$/i, "").toLowerCase();
}

/**
 * Splits a name or file name into lower-case words, ignoring words that say nothing about which badge it is.
 *
 * @param {string} text
 * @returns {string[]}
 */
function nameWords(text) {
	const ignore = new Set(["challenge", "mode", "legacy", "yearly", "end", "of", "year", "placeholder", "the", "static", "animated", "png", "gif", "avif"]);
	return text.toLowerCase().split(/[^a-z0-9]+/).filter(word => word && !ignore.has(word));
}

/**
 * Rebuilds the pre-AVIF URL of an animated badge.
 * buildJSON.js rewrites animated .png/.gif badges to .avif and records the original extension in `animatedOriginalExtension`.
 *
 * @param {{animated?: string, animatedOriginalExtension?: string}} badge
 * @returns {string|undefined} The original URL, or the unchanged `animated` value if it was never converted.
 */
function getOriginalAnimatedURL(badge) {
	if(!badge.animated?.endsWith(".avif")) { return badge.animated; }
	const extension = badge.animatedOriginalExtension ?? ".png";	//Only GIFs get an explicit extension recorded, so assume PNG when none is stored
	return badge.animated.replace(/\.avif$/i, extension);
}

/**
 * The URL used to show a badge as a still picture: its `image`, or for the badges that only exist animated
 * (the End of Year badges), the original (pre-AVIF) animated file.
 *
 * @param {{image?: string, animated?: string, animatedOriginalExtension?: string}} badge
 * @returns {string|undefined}
 */
function getStaticURL(badge) {
	return badge.image ?? getOriginalAnimatedURL(badge);
}

/**
 * Gives an unpaired badge image the site's class for its style, judged from the picture's real dimensions:
 * "badge-style-old" for the tall old style, "badge-style-new" for everything else. Does nothing until the image has loaded.
 * (A paired legacy image keeps "badge-legacy"; the site uses that class only for the second picture of a pair.)
 *
 * @param {HTMLImageElement} img
 * @param {string} [tall="badge-style-old"] The class(es) for a tall picture: LEGACY_CLASSES for the second picture of a pair.
 */
function classifyBadgeImage(img, tall = "badge-style-old") {
	if(!img.naturalWidth || !img.naturalHeight) { return; }
	const old = img.naturalHeight / img.naturalWidth >= LEGACY_MIN_RATIO;
	for(const name of tall.split(" ")) { img.classList.toggle(name, old); }
	img.classList.toggle("badge-style-new", !old);
}

/**
 * Sets the state of a legacy switch the way the site does: data-state "new" or "old", and the matching icon.
 *
 * @param {HTMLElement} button
 * @param {"new"|"old"} state
 */
function setSwitchState(button, state) {
	button.dataset.state = state;
	const icon = button.querySelector("img");
	if(icon) { icon.src = state === "old" ? SWITCH_ICON_OLD : SWITCH_ICON; }
}

/**
 * Lower-cases a header or category title and drops a trailing "Badges", so "Genre Badges" and "Genre" compare equal.
 *
 * @param {string} title
 * @returns {string}
 */
function normTitle(title) {
	return title.toLowerCase().replace(/\s+/g, " ").trim().replace(/\s*badges$/, "").trim();
}

/**
 * Reduces a sub-heading to letters and digits only, so small punctuation differences ("Gambler's" / "Gamblers") do not matter.
 *
 * @param {string} title
 * @returns {string}
 */
function normKey(title) {
	return title.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Works out which box, header and sub-heading on the page a badge belongs under.
 *
 * @param {{name: string, media?: string}} section The badge's section in the database.
 * @param {{name: string}|undefined} group The badge's group within that section, if any.
 * @returns {{box: string, title: string, data: string, sub: string|null, source: string}|null} `title` is the category header ("Monthly 2019"),
 *   `sub` the small heading inside it ("Action", "Staff Picks") or null. Null overall for badges that have no place on the page.
 */
function siteTarget(section, group) {
	if(section.name === "Unofficial") { return {box: "Special", title: "Unofficial", data: "Unofficial", sub: null, source: "Unofficial"}; }
	if(section.name === "End of Year") { return {box: "Special", title: "End of Year", data: "End of Year", sub: null, source: "End of Year"}; }
	if(!section.media) { return null; }
	if(section.media === "Manga" && section.name === "Tier" && /^(Staff|Supporter)$/.test(group?.name ?? "")) {	//Staff and supporter badges are kept with the Manga tiers in the database but have their own category on the page
		return {box: "Special", title: "Supporter", data: "Supporter", sub: group.name, source: "Manga/Tier"};
	}

	const name = section.name;
	let title = name;
	let sub = group?.name ?? null;
	if(name === "Monthly") {	//For Monthly the group is the year, which the page makes a category of its own
		title = `Monthly ${group?.name ?? ""}`.trim();
		sub = null;
	}
	else if(name === "City") { title = "Manga City"; }
	if(sub) { sub = SUBHEADING_MAP[`${section.media}/${section.name}`]?.[sub] ?? sub; }
	return {box: section.media, title, data: name, sub, source: `${section.media}/${section.name}`};
}

/**
 * Where a header belongs among its box's headers; smaller is earlier. Monthly headers go by year, so one the script
 * has not heard of (a new year) still lands after the earlier years. Unknown headers go last.
 *
 * @param {string} box "Special", "Anime" or "Manga".
 * @param {string} title A header title, with or without "Badges".
 * @returns {number}
 */
function categoryRank(box, title) {
	const order = CATEGORY_ORDER[box].map(normTitle);
	const key = normTitle(title);
	const monthly = /^monthly (\d{4})$/.exec(key);
	if(monthly) { return order.indexOf(`monthly ${MONTHLY_YEARS[0]}`) + (Number(monthly[1]) - MONTHLY_YEARS[0]) / 1000; }
	const position = order.indexOf(key);
	return position === -1 ? Infinity : position;
}

/**
 * Prepares the database for display.
 *
 * Pairs each legacy badge with its current badge (the CI build records the pairing on the current one), drops what cannot be shown,
 * works out where each badge belongs on the page, and builds the tables that recognise the page's badges.
 *
 * @param {{badges: object[], sections: object[]}} index
 * @returns {{badges: object[], groups: object[], urlToIndex: Map<string, number>, stemToIndex: Map<string, number>, captionToIndex: Map<string, number>, threadToGroups: Map<number, Set<number>>, subKeyOf: string[], sectionStarts: Map<string, number>, groupOfIndex: Map<number, object>, grants: Map<number, number[]>}}
 *   Each group is one thing to show: { current, legacy (index or null), order, target }. `threadToGroups` maps a forum thread
 *   to the `current` index of every group using it (the backup way to recognise a badge whose image address has changed).
 */
function prepareIndex(index) {
	const {badges, sections} = index;
	const openEvents = index.openEvents ?? {};	//Set by CI from the OPEN_EVENTS repository variable
	const sectionOf = new Array(badges.length);
	const groupOf = new Array(badges.length);
	for(const section of sections) {
		for(let i = section.start; i < section.end; i++) { sectionOf[i] = section; }
		for(const group of section.groups ?? []) {
			for(let i = group.start; i < group.end; i++) { groupOf[i] = group; }
		}
	}

	const indexOfId = new Map(badges.map((badge, i) => [badge.id, i]));
	for(const [currentId, legacyId] of Object.entries(MANUAL_LEGACY_PAIRS)) {
		const current = indexOfId.get(currentId);
		const legacy = indexOfId.get(legacyId);
		if(current !== undefined && legacy !== undefined && badges[current].legacy === undefined) { badges[current].legacy = legacy; }
	}
	const pairedLegacy = new Set();
	badges.forEach(badge => { if(badge.legacy !== undefined) { pairedLegacy.add(badge.legacy); } });

	const targetOf = i => {	//Where badge i belongs; for a category shown in rows, the sub-group is the badge's row
		const target = siteTarget(sectionOf[i], groupOf[i]);
		const size = target && ROWS_OF[target.source];
		return size ? {...target, sub: `row${Math.floor((i - sectionOf[i].start) / size)}`} : target;
	};
	const subKeyOf = badges.map((_, i) => normKey(sectionOf[i] ? (targetOf(i)?.sub ?? "") : ""));	//Which sub-group (genre, "Staff Picks") each badge is in, so a badge row on the page can be matched to its group
	const urlToIndex = new Map();	//Every address the site might show for a badge -> the badge's index
	const stemCount = new Map();	//File name (no folder, extension or query) -> the badge's index, or -1 if several badges share it
	const threadToGroups = new Map();
	const groups = [];
	const sortShift = new Map();	//Badge index -> how far to push its place in the order
	const groupOfIndex = new Map();	//Index of a current or legacy badge -> its group
	badges.forEach((badge, i) => {
		if(!getStaticURL(badge)) { return; }
		for(const url of [badge.image, badge.animated, getOriginalAnimatedURL(badge)]) {	//The site may show the still, the animated file, or the animated file's original format
			if(!url || url === PLACEHOLDER_URL) { continue; }
			if(!urlToIndex.has(normalizeImageURL(url))) { urlToIndex.set(normalizeImageURL(url), i); }
			const stem = fileStem(url);
			stemCount.set(stem, stemCount.has(stem) && stemCount.get(stem) !== i ? -1 : i);
		}
		if(pairedLegacy.has(i) || (badge.unofficial && !settings.showUnofficial)) { return; }	//A legacy badge is shown with its current badge

		const target = targetOf(i);
		if(!target) { return; }
		const legacy = badge.legacy ?? null;
		const closes = closingTime(badge, sectionOf[i], groupOf[i], openEvents);
		const shift = target.title === "Supporter" && target.sub === "Staff" ? STAFF_AFTER_SUPPORTERS : 0;	//Staff badges sort after the supporters in that category
		for(const member of legacy === null ? [i] : [i, legacy]) { if(shift) { sortShift.set(member, shift); } }
		const group = {current: i, legacy, order: (legacy === null ? i : Math.min(i, legacy)) + shift, target, closes, get unobtainable() { return Date.now() >= this.closes; }};
		groups.push(group);
		groupOfIndex.set(i, group);
		if(legacy !== null) { groupOfIndex.set(legacy, group); }
		for(const member of legacy === null ? [i] : [i, legacy]) {
			const thread = badges[member].thread;
			if(!threadToGroups.has(thread)) { threadToGroups.set(thread, new Set()); }
			threadToGroups.get(thread).add(i);
		}
	});
	for(const group of groups) {	//A Staff Picks Combined badge stays open for whoever owns that year's Timed badge (it waits for Hanamaru); without it, both close together
		const year = /^Staff Picks Challenge:\s*(\d{4}) \(Combined\)/.exec(badges[group.current].name)?.[1];
		const timed = year && badges.findIndex(badge => badge.name === `Staff Picks Challenge: ${year} (Timed Mode)`);
		if(timed > -1) { group.opensWith = timed; }
	}
	const stemToIndex = new Map([...stemCount].filter(([, i]) => i !== -1));
	const captionCount = new Map();	//Words of a badge's name (sorted) -> the badge's index, or -1 if several share them; matches the labels the page prints under some badges
	badges.forEach((badge, i) => {
		const key = nameWords(badge.name).sort().join(" ");
		if(key) { captionCount.set(key, captionCount.has(key) ? -1 : i); }
	});
	const captionToIndex = new Map([...captionCount].filter(([, i]) => i !== -1));
	const sectionStarts = new Map(sections.map(section => [`${section.media ?? ""}/${section.name}`.replace(/^\//, ""), section.start]));	//"Anime/Gacha" -> position of its first badge
	const grants = new Map();	//Group (by its current badge) -> the groups its owner is counted as owning
	for(const [ownerId, grantedIds] of Object.entries(LINKED_OWNERSHIP)) {
		const owner = groupOfIndex.get(indexOfId.get(ownerId))?.current;
		const granted = grantedIds.map(id => groupOfIndex.get(indexOfId.get(id))?.current).filter(index => index !== undefined);
		if(owner !== undefined && granted.length) { grants.set(owner, [...(grants.get(owner) ?? []), ...granted]); }
	}
	return {badges, groups, sortShift, groupOfIndex, grants, urlToIndex, stemToIndex, captionToIndex, threadToGroups, subKeyOf, sectionStarts};
}

/* ---------------- READ THE PAGE ---------------- */
/*
The page is laid out as boxes (Anime, Manga, Special). In each box a category is a header (the pill, "Genre Badges") followed by its content
(a "toggle-area" holding small headings, each followed by a ".badge-display" list of badges).
Only the ".badge-display" and ".legacy-toggle" names are relied on. The rest is learnt from the page:
	- a box is the element around the "Click a header to view badges." note, and is named by its title text;
	- a category's header is the nearest "... Badges" text before a badge list, either beside the list or beside something wrapped around it;
	- the category's content is that list, or the wrapper holding it.
*/

/**
 * Whether an element looks like a category header ("Genre Badges").
 *
 * @param {Element} el
 * @returns {boolean}
 */
function isHeaderLike(el) {
	const text = el.textContent.trim();
	return text.length > 0 && text.length < 60 && /badges$/i.test(text) && !el.querySelector(".badge-display") && !el.matches(".badge-display, .badge");
}

/**
 * Whether an element is a small heading inside a category ("Dungeon", "Action").
 *
 * @param {Element|null} el
 * @returns {boolean}
 */
function isSubheading(el) {
	return Boolean(el) && !el.matches(".badge-display") && (/^H[1-6]$/.test(el.tagName) || el.classList.contains("text-primary")) && !el.querySelector(".badge-display");
}

/**
 * Finds the category a badge list belongs to by climbing from the list until something before it is a header.
 *
 * @param {Element} display A ".badge-display" element.
 * @param {Element|null} boundary The box around it; the search never goes up to or past it.
 * @returns {{header: Element, content: Element, parent: Element}|null} `content` is the part of the page the header opens (the list, or what wraps it).
 */
function locateHeader(display, boundary) {
	for(let node = display; node && node !== boundary && node.parentElement; node = node.parentElement) {
		for(let el = node.previousElementSibling; el; el = el.previousElementSibling) {
			if(isHeaderLike(el)) { return {header: el, content: node, parent: node.parentElement}; }
		}
	}
	return null;
}

/**
 * The badge lists inside a category's content.
 *
 * @param {Element} content
 * @returns {Element[]}
 */
function displaysOf(content) {
	return content.matches(".badge-display") ? [content] : [...content.querySelectorAll(".badge-display")];
}

/**
 * The small heading right before a badge list, if it has one.
 *
 * @param {Element} display
 * @returns {Element|null}
 */
function headingOf(display) {
	const before = display.previousElementSibling;
	return isSubheading(before) ? before : null;
}

/**
 * Lists the categories (header and content) inside a box.
 *
 * @param {Element} boxEl
 * @returns {Array<{title: string, header: Element, content: Element, root: Element|null}>}
 */
function findUnits(boxEl) {
	const byHeader = new Map();
	boxEl.querySelectorAll(".badge-display").forEach(display => {
		const found = locateHeader(display, boxEl);
		if(!found || byHeader.has(found.header) || found.content.closest(".awc-un-fallback")) { return; }
		const {header, content, parent} = found;
		const alone = parent !== boxEl && parent.contains(header) && parent.querySelectorAll(".badge-display").length === displaysOf(content).length;	//The parent holds only this category (header, tick box, content), so it can be copied as one piece
		byHeader.set(header, {title: normTitle(header.textContent), header, content, root: alone ? parent : null});
	});
	return [...byHeader.values()];
}

/**
 * Finds the element in a box that holds its title (the bar saying "Anime").
 *
 * @param {Element} el
 * @returns {{title: string, el: Element}|null}
 */
function findBoxTitle(el) {
	for(const child of el.children) {
		if(child.matches(".badge-display")) { continue; }
		const candidates = [child, ...child.querySelectorAll("*")].slice(0, 12);	//The title is at the top, so there is no need to go deep
		for(const candidate of candidates) {
			if([...candidate.children].some(kid => !kid.matches(".awc-un-collapse"))) { continue; }	//Only text (the script's own collapse button may sit inside the title bar)
			const match = BOXES.find(box => box.toLowerCase() === candidate.textContent.trim().toLowerCase());
			if(match) { return {title: match, el: candidate}; }
		}
	}
	return null;
}

/**
 * Whether a category's content is currently collapsed.
 *
 * @param {Element} content
 * @returns {boolean}
 */
function isCollapsed(content) {
	const style = getComputedStyle(content);
	return style.display === "none" || content.hidden || style.visibility === "hidden" || style.maxHeight === "0px";
}

/**
 * Reads the page's boxes and keeps pristine copies of a header, a category's content, a box, a small heading and the
 * legacy switch, to copy when something is missing. The copies are taken before this script changes anything.
 *
 * @returns {{boxes: object[], makeUnit: Function|null, makeBox: Function|null, makeHeading: Function, makeToggle: Function|null}}
 */
function readPage() {
	const boxes = [];
	const notes = [...document.querySelectorAll("body *")].filter(el => !el.children.length && /^click a header to view badges\.?$/i.test(el.textContent.trim()));
	for(const note of notes) {
		let el = note.parentElement;
		for(let depth = 0; el && depth < 3; depth++, el = el.parentElement) {
			const found = findBoxTitle(el);
			if(!found) { continue; }
			if(!boxes.some(box => box.el === el)) { boxes.push({el, title: found.title, titleEl: found.el, units: findUnits(el), holder: null}); }
			break;
		}
	}

	const allUnits = boxes.flatMap(box => box.units);
	const template = allUnits.find(unit => isCollapsed(unit.content)) ?? allUnits[0];	//Prefer a collapsed one, so copies start collapsed too
	let makeUnit = !template?.root ? null : (() => {
		const pathTo = (root, node) => {	//Position of a node inside root, as child indexes, so the same node can be found in a copy
			const path = [];
			for(let el = node; el !== root; el = el.parentElement) { path.unshift([...el.parentElement.children].indexOf(el)); }
			return path;
		};
		const follow = (root, path) => path.reduce((el, index) => el.children[index], root);
		const rootCopy = template.root.cloneNode(true);
		const headerPath = pathTo(template.root, template.header);
		const contentPath = pathTo(template.root, template.content);
		return () => {
			const root = rootCopy.cloneNode(true);
			const header = follow(root, headerPath);
			const content = follow(root, contentPath);
			content.replaceChildren();
			content.removeAttribute("style");
			return {nodes: [root], root, header, content};
		};
	})();

	let headingTemplate = [...document.querySelectorAll(".badge-display")].map(headingOf).find(Boolean)?.cloneNode(true);
	const makeHeading = text => {
		const heading = headingTemplate ? headingTemplate.cloneNode(true) : Object.assign(document.createElement("h2"), {className: "text-primary"});
		stripIds(heading);
		setText(heading, text);
		return heading;
	};

	const toggleCopy = document.querySelector(".badge-display .legacy-toggle")?.cloneNode(true);
	let makeToggle = !toggleCopy ? null : (() => {
		const copy = toggleCopy.cloneNode(true);
		setSwitchState(copy, "new");
		return () => copy.cloneNode(true);
	})();

	const boxCopy = boxes[0]?.el.cloneNode(true);
	boxCopy?.querySelectorAll(".awc-un-collapse").forEach(button => button.remove());	//A copy must not carry the script's buttons: they would be dead copies, and would stop the real ones being added
	let makeBox = !boxCopy ? null : (() => {
		const sourceTitle = boxes[0].title;
		return () => {
			const el = boxCopy.cloneNode(true);
			let holder = null;
			for(const unit of findUnits(el)) {	//Keep the box's frame and note, drop its categories
				const piece = unit.root ?? unit.header;
				holder ??= piece.parentElement;
				if(unit.root) { unit.root.remove(); } else { unit.header.remove(); unit.content.remove(); }
			}
			return {el, titleEl: findBoxTitle(el)?.el ?? null, sourceTitle, holder: holder ?? el};
		};
	})();

	return {boxes, makeUnit, makeBox, makeHeading, makeToggle};
}

/**
 * Replaces the visible text of an element without touching the elements inside it (icons, counters).
 *
 * @param {Element} el
 * @param {string} text
 */
function setText(el, text) {
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	let first = null;
	let node;
	while((node = walker.nextNode())) {
		if(!node.nodeValue.trim()) { continue; }
		if(first) { node.nodeValue = ""; } else { first = node; }
	}
	if(first) { first.nodeValue = text; } else { el.textContent = text; }
}

/** Removes element ids (and the links between elements that use them) from a copy, so the page does not end up with duplicates. */
function stripIds(root) {
	for(const el of [root, ...root.querySelectorAll("*")]) {
		el.removeAttribute("id");
		el.removeAttribute("aria-controls");
	}
}

/* ---------------- TRACKING ---------------- */
let injected = [];	//Everything this script has added to the page, so it can all be taken out again
let applied = false;	//Whether the script's changes are currently on the page
let linkedBadges = [];	//Links added to (or given an address on) the page's own badges, to undo
let reclassed = [];	//The page's own pictures whose classes were changed for a switch added to them, with the classes they had
let regrouped = [];	//Lists that regroupRows() took apart, to put back
let titled = [];	//The page's own pictures that were given a tooltip, with the one they had before
let spoofCount = 0;	//Numbers the tick boxes of made categories, so each is unique

/** Records a node the script has added. */
function track(node) {
	injected.push(node);
	return node;
}

/** Takes everything the script added out of the page. The page is then as the site made it. */
function removeAll() {
	removeTilt();
	for(const {link, figure, href, target, rel} of linkedBadges) {
		if(figure) { link.replaceWith(figure); continue; }
		for(const [name, value] of [["href", href], ["target", target], ["rel", rel]]) { if(value === null) { link.removeAttribute(name); } else { link.setAttribute(name, value); } }
	}
	linkedBadges = [];
	restoreRows();
	for(const {img, className, style} of reclassed) {
		img.className = className;
		if(style === null) { img.removeAttribute("style"); } else { img.setAttribute("style", style); }
	}
	reclassed = [];
	for(const node of injected) { node.remove(); }
	for(const {bar, style} of collapseRestore) { if(style === null) { bar.removeAttribute("style"); } else { bar.setAttribute("style", style); } }
	collapseRestore = [];
	for(const {img, previous} of titled) { if(previous === null) { img.removeAttribute("title"); } else { img.setAttribute("title", previous); } }
	titled = [];
	injected = [];
	appliedScan = null;
	applied = false;
}

/* ---------------- INJECT STYLES ---------------- */
/** Injects the script's stylesheet into the page (once). */
function injectStyles() {
	if(document.querySelector("#awc-un-styles")) { return; }

	const style = document.createElement("style");
	style.id = "awc-un-styles";
	style.textContent = `
		.awc-un-badge.awc-un-dim figure img {	/* Unowned badges, greyed out */
			filter: grayscale(1) opacity(0.45);
			transition: filter 0.2s ease;
		}
		.awc-un-badge.awc-un-dim:hover figure img {
			filter: grayscale(0.4) opacity(0.8);
		}
		/* ---------------- 3D TILT (badges tilt under the pointer and catch the light; the same effect as the character page script) ---------------- */
		.awc-un-tilt {
			isolation: isolate;	/* Blend modes only see the badge, not the page behind it */
			transition: transform 0.3s ease-out, filter 0.3s ease-out;
		}
		.awc-un-tilt-rel {
			position: relative;
		}
		.awc-un-tilt.awc-un-tilting {	/* --rx/--ry (tilt) and --sx/--sy (shadow offset) are set from JS on every mousemove */
			z-index: 1000;
			filter: drop-shadow(var(--sx, 0px) var(--sy, 0px) 24px rgba(0, 0, 0, 0.35));
			transform: perspective(1000px) translateZ(20px) scale(1.24) rotateX(var(--rx, 0deg)) rotateY(var(--ry, 0deg));
			transition: transform 0.08s ease-out, filter 0.08s ease-out;
			will-change: transform;
		}
		.awc-un-badge.awc-un-dim figure.awc-un-tilting img {
			filter: grayscale(0.4);	/* A tilted unowned badge stays tinted but is no longer see-through (the plain hover dims it to 80% opacity) */
		}
		.awc-un-tilt.awc-un-tilting img {
			transform: none !important;	/* The figure moves now, so the page's own hover zoom must not also apply */
		}
		.awc-un-light, .awc-un-shade {	/* A copy of the shown picture (--badge-url) as a silhouette, so light only lands on the badge's own pixels */
			position: absolute;
			background: var(--badge-url) center / 100% 100% no-repeat;
			pointer-events: none;
			opacity: 0;
			transition: opacity 0.15s ease-out;
			mask-repeat: no-repeat;
			mask-size: 100% 100%;
		}
		.awc-un-light {
			filter: brightness(0) invert(1);
			mix-blend-mode: soft-light;
			mask-image: radial-gradient(circle at var(--gx, 50%) var(--gy, 50%), rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.5) 30%, rgba(0,0,0,0.15) 65%, transparent 100%);
		}
		.awc-un-shade {
			filter: brightness(0); mix-blend-mode: multiply;
		}
		.awc-un-tilting .awc-un-light {
			opacity: var(--li, 0);
		}
		.awc-un-tilting .awc-un-shade {
			opacity: var(--si, 0);
		}
		/* ---------------- PROGRESS DASHBOARD ---------------- */
		.awc-un-dashboard {
			max-width: 1000px;
			margin: 10px auto;
			padding: 8px 16px;
			border-radius: 8px;
			background: rgba(0, 0, 0, 0.32);
			color: #f3f7fc;
			font-size: 0.95em;
			font-weight: 600;
			text-align: left;
			--awc-un-accent: #3db4f2;
		}
		.awc-un-dashboard > summary {
			display: flex;
			align-items: center;
			cursor: pointer;
			list-style: none;
			gap: 12px;
		}
		.awc-un-dashboard > summary::-webkit-details-marker {
			display: none;
		}
		.awc-un-dashboard > summary::before {
			content: "\\25B8"; opacity: 0.8;
		}
		.awc-un-dashboard[open] > summary::before {
			content: "\\25BE";
		}
		.awc-un-dashboard .awc-un-dash-title {
			font-weight: 700;
			white-space: nowrap;
		}
		.awc-un-dashboard > summary .awc-un-bar {
			flex: 1;
		}
		.awc-un-dash-figures {
			white-space: nowrap;
			font-variant-numeric: tabular-nums;
		}
		.awc-un-bar {
			overflow: hidden;
			height: 7px;
			border-radius: 4px;
			background: rgba(255, 255, 255, 0.2);
		}
		.awc-un-bar-fill {
			height: 100%;
			border-radius: 4px;
			background: var(--awc-un-accent);
		}
		.awc-un-bar-fill.awc-un-bar-done {	/* A finished category: a full rainbow that drifts slowly */
			background: linear-gradient(90deg, #ff5f6d, #ffb347, #f9f871, #7bd88f, #4fc3f7, #9b8cff, #ff7ad9, #ff5f6d);
			background-size: 200% 100%;
			animation: awc-un-rainbow 6s linear infinite;
		}
		@keyframes awc-un-rainbow { to { background-position: -200% 0; } }
		@media (prefers-reduced-motion: reduce) {
			.awc-un-bar-fill.awc-un-bar-done {
				animation: none;
			}
		}
		.awc-un-club {
			margin: 8px 0 0;
			padding: 6px 8px 4px;
			border-radius: 8px;
		}
		.awc-un-club-awc {
			background: rgba(33, 150, 243, 0.16);
		}
		.awc-un-club-mrc {
			background: rgba(244, 67, 54, 0.16);
		}
		.awc-un-club-tag {
			padding-left: 6px;
			font-size: 0.7em;
			font-weight: 700;
			letter-spacing: 0.12em;
			opacity: 0.75;
		}
		.awc-un-notice {
			font-weight: 500;
			text-align: center;
		}
		.awc-un-collapse {
			position: absolute;
			top: 50%;
			left: 10px;
			display: flex;
			justify-content: center;
			align-items: center;
			width: 30px;
			height: 30px;
			padding: 0;
			border: 0;
			border-radius: 6px;
			background: transparent;
			color: #fff;
			cursor: pointer;
			opacity: 0.7;
			transform: translateY(-50%);
		}
		.awc-un-collapse:hover, .awc-un-collapse:focus-visible {
			outline: none;
			opacity: 1; background: rgba(255, 255, 255, 0.14);
		}
		.awc-un-gear {
			display: flex;
			padding: 4px;
			border: none;
			border-radius: 4px;
			background: none;
			color: rgb(var(--color-text-lighter, 146, 153, 161));
			cursor: pointer;
			transition: color 0.2s ease;
		}
		.awc-un-gear svg {
			transition: transform 0.3s ease;
		}
		.awc-un-gear:hover, .awc-un-gear.awc-un-open {
			color: rgb(var(--color-blue, 61, 180, 242));
		}
		.awc-un-gear.awc-un-open svg {
			transform: rotate(60deg);
		}
		.awc-un-gear-panel {
			position: fixed;
			z-index: 2147483000;
			display: flex;
			overflow-y: auto;
			flex-direction: column;
			box-sizing: border-box;
			width: 350px;
			max-width: calc(100vw - 16px);
			padding: 18px 20px 14px;
			border: 1px solid rgba(255, 255, 255, 0.16);
			border-radius: 10px;
			background: rgb(16, 22, 32);	/* Solid: the page behind must not show through the text */
			color: #e6ebf2;
			font-size: 14px;
			box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
			gap: 14px;
		}
		.awc-un-gear-panel[hidden] {
			display: none;
		}
		.awc-un-gear-panel label {
			display: flex;
			align-items: center;
			white-space: nowrap;
			cursor: pointer;
			gap: 8px;
		}
		.awc-un-gear-panel label.awc-un-sub {
			padding-left: 24px;
		}
		.awc-un-gear-panel label.awc-un-off {
			cursor: default;
			opacity: 0.4;
		}
		.awc-un-owner {
			display: flex;
			flex-direction: column;
			padding-left: 24px;
			gap: 6px;
		}
		.awc-un-owner.awc-un-off {
			pointer-events: none;
			opacity: 0.4;
		}
		.awc-un-owner-row {
			display: flex;
			gap: 8px;
		}
		.awc-un-owner input[type=text] {
			flex: 1;
			min-width: 0;
			padding: 5px 8px;
			border: 1px solid rgba(255, 255, 255, 0.25);
			border-radius: 5px; background: rgba(255, 255, 255, 0.08);
			color: inherit;
			font: inherit;
		}
		.awc-un-purge, .awc-un-mark {
			padding: 4px 9px;
			border: 1px solid rgba(255, 255, 255, 0.3);
			border-radius: 5px; background: rgba(255, 255, 255, 0.1);
			color: inherit;
			font: inherit;
			font-size: 12px;
			white-space: nowrap;
			cursor: pointer;
		}
		.awc-un-purge[hidden] {
			display: none;
		}
		.awc-un-purge:hover {
			border-color: #ff4500;
			color: #ff4500;
		}
		.awc-un-mark {
			display: block;
			margin: 6px auto 0;
		}
		.awc-un-mark:hover {
			border-color: rgb(var(--color-blue, 61, 180, 242));
		}
		.awc-un-dash-warn {
			margin-left: 5px;
			color: #ff4500;
			font-weight: 700;
			cursor: help;
		}
		.awc-un-foot {
			display: flex;
			flex-direction: column;
			padding-top: 12px;
			border-top: 1px solid rgba(255, 255, 255, 0.14);
			color: rgba(230, 235, 242, 0.72);
			font-size: 12px;
			gap: 7px;
		}
		.awc-un-foot-title {
			display: flex;
			justify-content: space-between;
			align-items: baseline;
			color: #e6ebf2;
			font-weight: 600;
		}
		.awc-un-foot-title span {
			color: rgba(230, 235, 242, 0.6);
			font-weight: 400;
		}
		.awc-un-foot-data {
			display: flex;
			justify-content: space-between;
			align-items: center;
			gap: 8px;
			font-variant-numeric: tabular-nums;
		}
		.awc-un-foot-data button {
			padding: 4px 9px;
			border: 1px solid rgba(255, 255, 255, 0.3);
			border-radius: 5px;
			background: rgba(255, 255, 255, 0.1);
			color: inherit;
			font: inherit;
			white-space: nowrap;
			cursor: pointer;
		}
		.awc-un-foot-data button:disabled {
			cursor: default;
			opacity: 0.6;
		}
		.awc-un-foot-links {
			display: flex;
			flex-wrap: wrap;
			gap: 4px 14px;
		}
		.awc-un-foot a {
			color: rgb(var(--color-blue, 61, 180, 242));
			text-decoration: none;
		}
		.awc-un-foot a:hover {
			text-decoration: underline;
		}
		.awc-un-foot-note {
			margin-top: -6px;
			color: rgba(230, 235, 242, 0.45);
			font-size: 11px;
		}
		.awc-un-sister {
			margin-top: 3px;
			padding: 6px 9px;
			border: 1px solid rgba(61, 180, 242, 0.28);
			border-radius: 7px;
			background: rgba(61, 180, 242, 0.1);
			font-size: 11.5px;
			line-height: 1.35;
		}
		.awc-un-sister a {
			font-weight: 600;
		}
		.awc-un-gear-panel input {
			margin: 0;
			cursor: pointer;
			accent-color:
			rgb(var(--color-blue, 61, 180, 242));
		}
		#awc-un-lift {
			position: fixed;
			right: 18px;
			bottom: 24px;
			z-index: 2147483000;
			display: flex;
			justify-content: center;
			align-items: center;
			box-sizing: border-box;
			width: 44px;
			height: 44px;
			border: 2px solid rgb(var(--color-blue, 61, 180, 242));
			border-radius: 50%;
			background: rgb(16, 24, 34);
			color: rgb(var(--color-blue, 61, 180, 242));
			pointer-events: none;
			cursor: pointer;
			opacity: 0;
			transition: opacity 0.2s ease-out, transform 0.15s, background 0.15s, color 0.15s, box-shadow 0.15s;
			box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
		}
		#awc-un-lift.awc-un-lift-show {
			pointer-events: auto;
			opacity: 1;
		}
		#awc-un-lift:hover {
			background: rgb(var(--color-blue, 61, 180, 242));
			color: rgb(11, 22, 34);
			transform: translateY(-2px);
			box-shadow: 0 6px 18px rgba(61, 180, 242, 0.35);
		}
		#awc-un-lift:active {
			transform: none;
		}
		@media (max-width: 860px) {	/* Narrow screens: icons only, and the corner buttons join the header's flow instead of floating over the name */
			.awc-un-label {
				display: none;
			}
			#awc-un-header-switch {
				margin-left: 8px !important;
			}
			#awc-un-header-switch img, #awc-un-tilt-switch img {
				margin-right: 0 !important;
			}
			#awc-un-tilt-switch, #awc-un-settings {
				position: static !important;
				margin: 0 4px !important;
				transform: none !important;
			}
		}
		.awc-un-dash-grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
			margin: 10px 0 2px;
			gap: 4px 18px;
		}
		.awc-un-dash-row {
			display: grid;
			align-items: baseline;
			grid-template-columns: 1fr auto;
			padding: 4px 6px;
			border-radius: 6px;
			cursor: pointer;
			gap: 3px 8px;
		}
		.awc-un-dash-row:hover, .awc-un-dash-row:focus-visible {
			outline: none;
			background: rgba(255, 255, 255, 0.1);
		}
		.awc-un-dash-row .awc-un-bar {
			grid-column: 1 / -1; height: 5px;
		}
		.awc-un-dash-name {
			overflow: hidden;
			text-align: left;
			white-space: nowrap;
			text-overflow: ellipsis;
		}
		.awc-un-fallback {	/* Used only when the page's layout is not recognised */
			margin: 30px 0;
			text-align: center;
		}
		.awc-un-holder {
			display: flex;
			flex-wrap: wrap;
			justify-content: center;
			margin-top: 14px;
			gap: 14px;
		}
		/* :where() adds no specificity, so wherever the site styles these elements itself, its rules win over these fallbacks */
		:where(.awc-un-holder .badge) {
			position: relative;
			width: 250px;
		}
		:where(.awc-un-holder .badge figure) {
			display: flex;
			justify-content: center;
			align-items: center;
			margin: 0;
		}
		:where(.awc-un-holder .badge figure img) {
			display: block;
			max-width: 100%;
			max-height: 250px;
		}
	`;
	document.head.appendChild(style);
}

/* ---------------- BUILD BADGES ---------------- */
/**
 * Whether a badge has a real animated version: both a still and an animated picture, and the animated one is not the shared placeholder.
 *
 * @param {{image?: string, animated?: string}} badge
 * @returns {boolean}
 */
function canAnimate(badge) {
	return Boolean(badge.image && badge.animated && badge.animated !== PLACEHOLDER_URL);
}

/**
 * Shows a badge picture animated, as the page does for badges the challenger has earned. If the AVIF will not load it falls back to the
 * animated file's original format, and if that fails too to the still picture.
 *
 * @param {HTMLImageElement} img
 * @param {object} entry The database entry for this picture.
 */
function showAnimated(img, entry) {
	if(!canAnimate(entry)) { return; }
	img.addEventListener("error", () => {
		if(img.getAttribute("src") === entry.animated && entry.animated.endsWith(".avif")) { img.src = getOriginalAnimatedURL(entry); }
		else if(img.getAttribute("src") !== entry.image) { console.warn(`AWC Unowned Badges: Could not load the animated picture for "${entry.name}"; showing the still one.`); img.src = entry.image; }
	});
	img.src = entry.animated;
}

/**
 * A legacy switch button: a copy of the site's own when the page has one (so it looks and sits the same), otherwise a lookalike.
 *
 * @param {{makeToggle: Function|null}} page From readPage().
 * @returns {HTMLButtonElement}
 */
function createSwitchButton(page) {
	const button = page.makeToggle?.() ?? (() => {
		const made = document.createElement("button");
		made.className = "legacy-toggle";
		made.title = "Toggle legacy badge";
		const icon = document.createElement("img");
		icon.width = 24;
		icon.height = 24;
		icon.draggable = false;
		icon.alt = "";
		made.appendChild(icon);
		return made;
	})();
	setSwitchState(button, "new");
	button.type = "button";
	return button;
}

/**
 * Makes a legacy switch work the way the page's does: its click swaps which of the two pictures shows (the "hidden" class, plus no room taken
 * by the hidden one when the two sit side by side) and sets the button's state ("new" or "old") and icon, with a short fade because copies do not get the page's. The page's own handlers are not on copies, so this one is stopped from leaking to any the page has.
 *
 * @param {HTMLElement} button
 * @param {Array<{img: HTMLImageElement, legacySide: boolean, entry: object}>} versions The new and legacy versions.
 * @param {boolean} startLegacy Whether the legacy version is showing to begin with.
 * @param {(shown: object) => void} [onShow] Called with the version showing, now and after each swap.
 */
function wireSwitch(button, versions, startLegacy, onShow) {
	let showLegacy = startLegacy;
	let busy = false;
	const layout = () => {
		//Where the page's styles lay a legacy picture over the new one, the hidden picture has to keep its room or the other has none.
		//Where both pictures are new-style (Kaiju Attack) they sit side by side, so the hidden one must take no room.
		const stacked = versions.some(version => version.legacySide && version.img.naturalWidth && version.img.naturalHeight / version.img.naturalWidth >= LEGACY_MIN_RATIO);	//Known only once the legacy picture has loaded
		for(const version of versions) {
			if(version.legacySide !== showLegacy && !stacked) { version.img.style.setProperty("display", "none"); } else { version.img.style.removeProperty("display"); }
		}
	};
	const apply = fade => {
		for(const version of versions) { version.img.classList.toggle("hidden", version.legacySide !== showLegacy); }
		layout();
		setSwitchState(button, showLegacy ? "old" : "new");
		const shown = versions.find(version => version.legacySide === showLegacy);
		if(fade && shown.img.animate) { shown.img.animate([{opacity: 0}, {opacity: 1}], {duration: 200, easing: "linear"}); }
		onShow?.(shown);
	};
	for(const version of versions) { version.img.addEventListener("load", layout); }	//A picture's classes can change once its shape is known
	button.addEventListener("click", event => {
		event.preventDefault();
		event.stopPropagation();
		showLegacy = !showLegacy;
		setSwitchState(button, showLegacy ? "old" : "new");
		const incoming = versions.find(version => version.legacySide === showLegacy);
		if(incoming.legacySide) { incoming.img.loading = "eager"; }	//It was held back while hidden; start loading it now
		if(busy) { return; }	//The swap already waiting will use the latest state
		const leaving = versions.find(version => version !== incoming);
		const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
		if(!leaving.img.animate || reduced) { apply(false); return; }
		busy = true;	//The page's own fade does not exist on copies, so fade the old picture out, swap, and fade the new one in
		const fadeOut = leaving.img.animate([{opacity: 1}, {opacity: 0}], {duration: 150, easing: "linear", fill: "forwards"});
		const swap = () => { busy = false; apply(true); fadeOut.cancel(); };
		fadeOut.onfinish = swap;
		fadeOut.oncancel = swap;
	});
	apply(false);
}

/**
 * Gives the page's own badges a legacy switch where the database has a legacy version of the badge but the page has none
 * (the page only has switches for some pairs). The legacy (or current) picture is added next to the page's own and the page's picture is
 * left as it was, apart from the classes the switch needs; removeAll() takes it all back out.
 *
 * @param {object} data From prepareIndex().
 * @param {{makeToggle: Function|null}} page From readPage().
 * @param {object} scan From scanOwned().
 * @returns {number} How many badges were given a switch.
 */
function addMissingSwitches(data, page, scan) {
	if(!ADD_MISSING_SWITCHES) { return 0; }
	const byBadge = new Map();
	for(const item of scan.images) {
		const badge = item.img.closest(".badge-display > *");
		if(!badge?.matches(".badge")) { continue; }
		if(!byBadge.has(badge)) { byBadge.set(badge, []); }
		byBadge.get(badge).push(item);
	}
	let added = 0;
	for(const [badge, items] of byBadge) {
		const figure = items[0].img.closest("figure");
		if(items.length !== 1 || !items[0].exact || badge.querySelector(".legacy-toggle") || figure.querySelectorAll("img").length !== 1) { continue; }
		const {img, index} = items[0];
		const group = data.groupOfIndex.get(index);
		if(!group || group.legacy === null) { continue; }

		const pageIsLegacy = index === group.legacy;
		const otherEntry = data.badges[pageIsLegacy ? group.current : group.legacy];
		const other = document.createElement("img");
		other.className = pageIsLegacy ? "badge-style-new" : LEGACY_CLASSES;
		other.loading = "lazy";
		other.decoding = "async";
		other.alt = otherEntry.name;
		other.title = otherEntry.name;
		other.src = getStaticURL(otherEntry);
		other.addEventListener("load", () => classifyBadgeImage(other, LEGACY_CLASSES));
		reclassed.push({img, className: img.className, style: img.getAttribute("style")});
		if(pageIsLegacy) { img.className = LEGACY_CLASSES; }
		figure.appendChild(track(other));

		const button = createSwitchButton(page);
		badge.prepend(track(button));
		wireSwitch(button, [{img, legacySide: pageIsLegacy}, {img: other, legacySide: !pageIsLegacy}], pageIsLegacy);
		added++;
	}
	return added;
}

/**
 * The label the page prints under a placeholder badge: the name without "Challenge", "Mode" and "PLACEHOLDER" ("2023 Yearly Hard").
 *
 * @param {string} name
 * @returns {string}
 */
function placeholderLabel(name) {
	return name.replace(/[:()]/g, " ").split(/\s+/).filter(word => word && !/^(challenge|mode|placeholder)$/i.test(word)).join(" ");
}

/**
 * Builds a badge for something the challenger has not earned, laid out exactly like the site's own:
 * `.badge > button.legacy-toggle?, a > figure > img(s)`. It shows the still picture. A badge with a legacy partner gets a copy of the site's
 * own legacy switch and one image per version ("badge-style-new" and "badge-legacy"), with the site's "hidden" class on the version that is off.
 * A badge without a partner gets "badge-style-new" or "badge-style-old" from its real dimensions once it loads.
 *
 * @param {{current: number, legacy: number|null}} group
 * @param {object[]} badges The database's badges.
 * @param {{makeToggle: Function|null}} page From readPage().
 * @returns {HTMLElement}
 */
function buildBadge(group, badges, page, granted = false, closed = group.unobtainable) {
	const badge = document.createElement("div");
	badge.className = `badge awc-un-badge${DIM_UNOWNED && !granted ? " awc-un-dim" : ""}${granted ? " awc-un-granted" : ""}${closed ? " awc-un-unobtainable" : ""}`;	//A badge counted as owned is not dimmed

	const versions = [{entry: badges[group.current], legacySide: false}];
	if(group.legacy !== null) { versions.push({entry: badges[group.legacy], legacySide: true}); }

	const legacyButton = versions.length > 1 ? createSwitchButton(page) : null;
	if(legacyButton) { badge.appendChild(legacyButton); }

	const link = document.createElement("a");
	link.target = "_blank";
	link.rel = "noopener noreferrer";	//Isolate tabs
	const figure = document.createElement("figure");
	const difficulty = /\b(Easy|Normal|Hard)\b/.exec(versions[0].entry.name);
	figure.dataset.difficulty = difficulty ? difficulty[1] : "Complete";	//The page uses "Complete" for badges without a difficulty
	link.appendChild(figure);
	badge.appendChild(link);

	for(const version of versions) {
		const img = document.createElement("img");
		img.className = version.legacySide ? `${LEGACY_CLASSES} hidden` : "badge-style-new";
		img.loading = "lazy";	//The page does the same: a hidden image is not fetched until it is shown
		img.decoding = "async";
		img.alt = version.entry.name;
		img.title = version.entry.name;
		img.src = getStaticURL(version.entry);
		if(granted) { showAnimated(img, version.entry); }	//A badge counted as owned looks like an owned one: animated where it can be
		if(versions.length === 1) { img.addEventListener("load", () => classifyBadgeImage(img)); }
		else if(version.legacySide) { img.addEventListener("load", () => classifyBadgeImage(img, LEGACY_CLASSES)); }	//A legacy picture is portrait, except where a pair is new-style on both sides
		version.img = img;
		figure.appendChild(img);
	}
	if(getStaticURL(versions[0].entry) === PLACEHOLDER_URL) {	//The page labels placeholder pictures so they can be told apart
		const caption = document.createElement("figcaption");
		caption.textContent = placeholderLabel(versions[0].entry.name);
		figure.appendChild(caption);
	}

	const showLink = shown => { link.href = `https://anilist.co/forum/thread/${shown.entry.thread}`; };
	if(legacyButton) { wireSwitch(legacyButton, versions, false, showLink); } else { showLink(versions[0]); }
	return badge;
}

/* ---------------- PLACE BADGES ---------------- */
/**
 * Finds the placeholder badge a printed label belongs to ("2023 Yearly Hard"), using the label's words plus the figure's difficulty.
 * An exact match of the words wins; otherwise the one placeholder badge whose name contains the words with the fewest extras
 * (a bare year means that year's Participation badge). Ambiguity gives no match.
 *
 * @param {object} data From prepareIndex().
 * @param {string} caption
 * @param {string|undefined} difficulty The figure's data-difficulty.
 * @returns {number|undefined}
 */
function matchCaption(data, caption, difficulty) {
	const words = new Set(nameWords(caption));
	if(/^(easy|normal|hard)$/i.test(difficulty ?? "")) { words.add(difficulty.toLowerCase()); }
	if(!words.size) { return undefined; }
	const exact = data.captionToIndex.get([...words].sort().join(" "));
	if(exact !== undefined) { return exact; }
	const candidates = [];
	data.badges.forEach((badge, i) => {
		if(getStaticURL(badge) !== PLACEHOLDER_URL) { return; }
		const names = nameWords(badge.name);
		if([...words].every(word => names.includes(word))) { candidates.push({i, extra: names.length - words.size, names}); }
	});
	candidates.sort((a, b) => a.extra - b.extra);
	if(candidates.length === 1 || (candidates.length > 1 && candidates[0].extra < candidates[1].extra)) { return candidates[0].i; }
	const participation = candidates.filter(candidate => candidate.names.includes("participation"));
	if(participation.length === 1 && !["easy", "normal", "hard"].some(word => words.has(word))) { return participation[0].i; }
	return undefined;
}

/**
 * Works out which database badges each of the page's own badges shows.
 *
 * An image is recognised by its address, then by its file name, then by the label printed under it (placeholder pictures), and finally by its forum thread. If the address is not in the database (the site has moved a badge's picture and the database
 * has not caught up), the badge is recognised by its forum thread instead, provided exactly one database badge uses that thread.
 *
 * @param {{urlToIndex: Map<string, number>, stemToIndex: Map<string, number>, captionToIndex: Map<string, number>, threadToGroups: Map<number, Set<number>>}} data
 * @returns {{owned: Set<number>, elements: Map<Element, number>, unmatched: string[], imageCount: number, matched: number, byThread: number, byCaption: number, images: Array<{img: Element, index: number, exact: boolean}>, granted: Set<number>}}
 *   `owned` is every database index found on the page; `elements` maps each of the page's badges to the lowest index it shows.
 */
function scanOwned(data) {
	const owned = new Set();
	const elements = new Map();
	const unmatched = [];
	let imageCount = 0;
	let matched = 0;
	let byThread = 0;
	let byCaption = 0;
	const images = [];	//Every recognised picture and the database index it is
	document.querySelectorAll(".badge-display > *:not(.awc-un-badge)").forEach(badge => {	//Whatever the page puts in a list, wrapped in a ".badge" or not
		let lowest = null;
		badge.querySelectorAll("figure img").forEach(img => {
			const src = img.getAttribute("src");
			if(!src) { return; }
			imageCount++;
			let index = data.urlToIndex.get(normalizeImageURL(src));	//1. the same address
			index ??= data.stemToIndex.get(fileStem(src));	//2. the same file name (moved folder or changed format)
			const exact = index !== undefined;
			const figure = img.closest("figure");
			const caption = figure?.querySelector("figcaption")?.textContent?.trim();
			if(index === undefined && caption) {	//3. the same label (the page prints one under badges whose picture is a placeholder)
				index = matchCaption(data, caption, figure.dataset.difficulty);
				if(index !== undefined) { byCaption++; }
			}
			if(index === undefined) {	//4. the same forum thread: alone, or the best match by name among several
				const thread = Number(/\/thread\/(\d+)/.exec(img.closest("a")?.getAttribute("href") ?? "")?.[1]);
				const candidates = [...(data.threadToGroups.get(thread) ?? [])];
				if(candidates.length === 1) { index = candidates[0]; byThread++; }
				else if(candidates.length > 1) {
					const words = new Set(nameWords(fileStem(src)));
					const scored = candidates.map(candidate => {
						const group = data.groups.find(item => item.current === candidate);
						const names = [data.badges[candidate], group?.legacy == null ? null : data.badges[group.legacy]].filter(Boolean).flatMap(badge => nameWords(badge.name));
						return {candidate, score: names.filter(word => words.has(word)).length};
					}).sort((a, b) => b.score - a.score);
					if(scored[0].score > 0 && scored[0].score > scored[1].score) { index = scored[0].candidate; byThread++; }
				}
			}
			if(index === undefined) { unmatched.push(caption ? `${src} [label: ${caption}]` : src); return; }
			matched++;
			images.push({img, index, exact});
			owned.add(index);
			const place = index + (data.sortShift.get(index) ?? 0);
			if(lowest === null || place < lowest) { lowest = place; }
		});
		if(lowest !== null) { elements.set(badge, lowest); }
	});
	const granted = new Set();	//Groups counted as owned because of another badge (LINKED_OWNERSHIP); a granted badge can grant in turn
	const isOwned = group => owned.has(group.current) || (group.legacy !== null && owned.has(group.legacy)) || granted.has(group.current);
	for(let changed = true; changed;) {
		changed = false;
		for(const [ownerCurrent, grantedCurrents] of data.grants) {
			if(!isOwned(data.groupOfIndex.get(ownerCurrent))) { continue; }
			for(const current of grantedCurrents) {
				const group = data.groupOfIndex.get(current);
				if(!isOwned(group)) { granted.add(group.current); changed = true; }
			}
		}
	}
	return {owned, elements, unmatched, imageCount, matched, byThread, byCaption, images, granted};
}

/**
 * Inserts new badges into a list so they fall in database order among the badges already there.
 * Existing badges are never moved; each new one goes before the first existing badge that comes later in the database.
 *
 * @param {Element} content The list.
 * @param {Array<{el: Element, order: number}>} cards New badges, in ascending order.
 * @param {Map<Element, number>} positions The database position of the badges already on the page.
 */
function insertInOrder(content, cards, positions) {
	for(const card of cards) {
		const later = [...content.children].find(child => positions.has(child) && positions.get(child) > card.order);
		content.insertBefore(card.el, later ?? null);
		positions.set(card.el, card.order);
	}
}

/**
 * The earliest database position among the badges in a list; Infinity if it has none the script knows.
 *
 * @param {Element} display
 * @param {Map<Element, number>} positions
 * @returns {number}
 */
function firstPosition(display, positions) {
	let first = Infinity;
	for(const child of display.children) { if(positions.has(child)) { first = Math.min(first, positions.get(child)); } }
	return first;
}

/**
 * The lists in a category that hold the same kind of badge as this one. The site can split one group over several lists (the End of Year category
 * keeps the Hard badges in a list of their own), so new badges are spread over them by database position instead of all going into the first.
 *
 * @param {object} unit The category.
 * @param {Element} display A list found by displayFor().
 * @param {object} data From prepareIndex().
 * @param {Map<Element, number>} positions
 * @returns {Element[]} The lists, at least the one given.
 */
function siblingDisplays(unit, display, data, positions) {
	const key = displayKey(display, data, positions);
	if(unit.content.matches(".badge-display") || headingOf(display) || key === undefined) { return [display]; }
	return displaysOf(unit.content).filter(candidate => !headingOf(candidate) && displayKey(candidate, data, positions) === key);
}

/**
 * Inserts new badges in database order across several lists: each goes in the last list that starts at or before it, so the lists read as one in order.
 *
 * @param {Element[]} displays
 * @param {Array<{el: Element, order: number}>} cards New badges, in ascending order.
 * @param {Map<Element, number>} positions
 */
function insertAcrossDisplays(displays, cards, positions) {
	for(const card of cards) {
		let chosen = displays[0];
		let chosenFirst = -Infinity;
		for(const candidate of displays) {
			const first = firstPosition(candidate, positions);
			if(first <= card.order && first >= chosenFirst) { chosen = candidate; chosenFirst = first; }
		}
		insertInOrder(chosen, [card], positions);
	}
}

/**
 * Makes a category on the page that the challenger has not earned anything in, by copying an existing one (header, tick box and content).
 * The page opens and closes categories with a tick box and CSS, so the copy only needs its own tick box id to work. It starts closed, and is placed by the page's order of headers.
 *
 * @param {object} page From readPage().
 * @param {{box: string, title: string}} target The category to make.
 * @param {{el: Element, title: string, units: object[], holder: Element|null}} box The box it goes in.
 * @returns {object|null} The new unit, or null if there was nothing to copy.
 */
function spoofUnit(page, target, box) {
	if(!page.makeUnit) { return null; }
	const made = page.makeUnit();
	const copyId = `awc-un-toggle-${++spoofCount}`;
	for(const input of made.root.querySelectorAll("input[type=checkbox]")) {	//Tie the copy's label to the copy's own tick box, closed
		const oldId = input.id;
		for(const label of made.root.querySelectorAll("label[for]")) { if(label.htmlFor === oldId) { label.htmlFor = copyId; } }
		input.id = copyId;
		if(input.name) { input.name = copyId; }
		input.checked = false;
		input.removeAttribute("checked");
	}
	setText(made.header, `${target.title} Badges`);

	const rank = categoryRank(box.title, target.title);
	const byRank = [...box.units].sort((a, b) => categoryRank(box.title, a.title) - categoryRank(box.title, b.title));
	const next = byRank.find(unit => categoryRank(box.title, unit.title) > rank);
	if(next) { (next.root ?? next.header).before(...made.nodes); }
	else if(byRank.length) { (byRank[byRank.length - 1].root ?? byRank[byRank.length - 1].content).after(...made.nodes); }
	else { (box.holder ?? box.el).append(...made.nodes); }
	made.nodes.forEach(track);

	const unit = {title: normTitle(target.title), header: made.header, content: made.content, root: made.nodes.length === 1 ? made.nodes[0] : null};
	box.units.push(unit);
	return unit;
}

/**
 * Makes a whole box (Anime, Manga or Special) that the challenger has nothing in, by copying an existing one.
 *
 * @param {object} page From readPage().
 * @param {string} title The box's name.
 * @returns {object|null}
 */
function spoofBox(page, title) {
	if(!page.makeBox) { return null; }
	const made = page.makeBox();
	stripIds(made.el);
	if(made.titleEl) { setText(made.titleEl, title); }

	const rank = BOXES.indexOf(title);
	const next = page.boxes.filter(box => BOXES.indexOf(box.title) > rank).sort((a, b) => BOXES.indexOf(a.title) - BOXES.indexOf(b.title))[0];
	if(next) { next.el.before(made.el); } else {
		const last = [...page.boxes].sort((a, b) => BOXES.indexOf(a.title) - BOXES.indexOf(b.title)).pop();	//The box that belongs last, not the one found last
		last.el.after(made.el);
	}
	track(made.el);

	const box = {el: made.el, title, titleEl: made.titleEl, units: [], holder: made.holder};
	page.boxes.push(box);
	return box;
}

/**
 * Which sub-group (genre, "Staff Picks") a badge list on the page is for, judged from the first badge in it the script can identify.
 *
 * @param {Element} display
 * @param {{subKeyOf: string[]}} data
 * @param {Map<Element, number>} positions
 * @returns {string|undefined} The group's key ("" for none), or undefined if the list has no badge the script knows.
 */
function displayKey(display, data, positions) {
	for(const child of display.children) { if(positions.has(child)) { return data.subKeyOf[positions.get(child)]; } }
	return undefined;
}

/**
 * Finds the badge list for a sub-group inside a category, making it (with a small heading where the category uses them) if the category lacks it.
 * A list is recognised by its heading, or by the badges already in it.
 *
 * @param {object} unit The category.
 * @param {object} page From readPage().
 * @param {object} data From prepareIndex().
 * @param {string|null} sub The sub-group ("Staff Picks", "Action"), or null for none.
 * @param {{data: string, source: string}} target
 * @param {number} order Database position of the first badge going in.
 * @param {Map<Element, number>} positions
 * @returns {Element} A ".badge-display" list to put the badges in.
 */
function displayFor(unit, page, data, sub, target, order, positions) {
	if(unit.content.matches(".badge-display")) { return unit.content; }
	const key = normKey(sub ?? "");
	const displays = displaysOf(unit.content);
	const found = displays.find(display => headingOf(display) && key && normKey(headingOf(display).textContent) === key)
		?? displays.find(display => displayKey(display, data, positions) === key)
		?? (displays.length === 1 && !key && displayKey(displays[0], data, positions) === undefined ? displays[0] : undefined);
	if(found) { return found; }

	const display = document.createElement("div");	//Same as the page's: <div class="badge-display" data-style="New" data-category="...">
	display.className = "badge-display";
	display.dataset.style = "New";
	display.dataset.category = target.data;
	const headed = sub && (displays.some(headingOf) || (!displays.length && HEADED_SECTIONS.includes(target.source)));
	const nodes = headed ? [page.makeHeading(sub), display] : [display];
	const later = displays.find(candidate => firstPosition(candidate, positions) > order);
	if(later) { (headingOf(later) ?? later).before(...nodes); } else { unit.content.append(...nodes); }
	nodes.forEach(track);
	return display;
}

/**
 * Rearranges a category the page shows in rows (Gacha: four badges per theme) so that its own badges sit in database order, one row each.
 * The page lists them in the order they were earned. The badges are moved, not copied, so they keep working; the original lists are put
 * back exactly by restoreRows().
 *
 * @param {object} unit The category.
 * @param {number} size Badges per row.
 * @param {{elements: Map<Element, number>}} scan From scanOwned().
 * @param {number} sectionStart Database position of the category's first badge.
 */
function regroupRows(unit, size, scan, sectionStart) {
	if(unit.content.matches(".badge-display")) { return; }	//Nothing around the list to hold several rows
	const displays = displaysOf(unit.content);
	if(!displays.length) { return; }
	const rows = new Map();	//Row number -> the page's badges in it
	const stray = [];	//Badges the script cannot place go in a last row
	for(const display of displays) {
		for(const child of display.children) {
			if(scan.elements.has(child)) {
				const row = Math.floor((scan.elements.get(child) - sectionStart) / size);
				if(!rows.has(row)) { rows.set(row, []); }
				rows.get(row).push(child);
			} else { stray.push(child); }
		}
	}
	if(!rows.size && !stray.length) { return; }

	const marker = document.createComment("awc-un");
	displays[0].before(marker);
	regrouped.push({marker, displays, children: displays.map(display => [...display.children])});

	const made = [...rows.keys()].sort((a, b) => a - b).map(row => {
		const display = displays[0].cloneNode(false);
		display.append(...rows.get(row).sort((a, b) => scan.elements.get(a) - scan.elements.get(b)));
		return display;
	});
	if(stray.length) { const display = displays[0].cloneNode(false); display.append(...stray); made.push(display); }
	marker.before(...made);
	made.forEach(track);
	displays.forEach(display => display.remove());
}

/** Puts the page's lists back as they were before regroupRows(). */
function restoreRows() {
	for(const {marker, displays, children} of regrouped) {
		marker.before(...displays);
		displays.forEach((display, i) => display.append(...children[i]));
		marker.remove();
	}
	regrouped = [];
}

/**
 * When a group stops being obtainable for this challenger: its own closing time, except that a Combined Staff Picks badge never closes for someone who owns the Timed one.
 *
 * @param {{closes: number, opensWith?: number}} group From prepareIndex().
 * @param {{owned: Set<number>, granted: Set<number>}} scan From scanOwned().
 * @returns {number} As closingTime().
 */
function closesFor(group, scan) {
	return group.opensWith !== undefined && (scan.owned.has(group.opensWith) || scan.granted.has(group.opensWith)) ? Infinity : group.closes;
}
/** @returns {boolean} Whether the group can no longer be earned by this challenger (see closesFor()). */
function closedFor(group, scan) { return Date.now() >= closesFor(group, scan); }

/**
 * Works out when a badge stops being obtainable, from its section and name, so the database needs no dates of its own.
 *   Event: closed, unless listed in `openEvents`. Supporter/Staff: always closed. Monthly: the first of the next month.
 *   Seasonal: 17 weeks after its season starts (Jan, Apr, Jul or Oct 1st). Staff Picks: the end of Dec 25 of the next year (not the Hanamaru Mode ones, which never close; see closesFor() for the Combined one).
 *   End of Year: the first of the next year. Anything else stays open. All in UTC.
 * A badge in `openEvents` uses that entry instead of any rule. A name the rules cannot read counts as open (and is logged once).
 *
 * @param {object} badge
 * @param {object} section
 * @param {object|undefined} group
 * @param {Record<string, string|null>} openEvents Badge id -> last open day ("YYYY-MM-DD") or null for no end.
 * @returns {number} Milliseconds since 1970 when it closes: 0 if already closed for good, Infinity if it never does.
 */
function closingTime(badge, section, group, openEvents) {
	const DAY = 86400000;
	if(Object.prototype.hasOwnProperty.call(openEvents, badge.id)) {
		const entry = openEvents[badge.id];
		const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(entry ?? "");
		if(entry === null) { return Infinity; }
		if(match) { return Date.UTC(+match[1], +match[2] - 1, +match[3]) + DAY; }
		console.warn(`AWC Unowned Badges: Ignoring the open date "${entry}" for ${badge.id}; use YYYY-MM-DD.`);
	}
	const where = `${section.media ?? ""}/${section.name}`;
	const unreadable = () => {
		if(!unreadableWarned.has(badge.id)) { unreadableWarned.add(badge.id); console.warn(`AWC Unowned Badges: Could not tell when "${badge.name}" closes, so it counts as open.`); }
		return Infinity;
	};
	if(where === "Anime/Event") { return 0; }
	if(where === "Manga/Tier" && /^(Staff|Supporter)$/i.test(group?.name ?? "")) { return 0; }
	if(where === "Anime/Monthly") {
		const match = /^([A-Za-z]+) (\d{4}) Monthly/.exec(badge.name);
		const month = match ? MONTHS.indexOf(match[1].slice(0, 3).toLowerCase()) : -1;
		return month === -1 ? unreadable() : Date.UTC(+match[2], month + 1, 1);
	}
	if(where === "Anime/Seasonal") {
		const match = /^(Winter|Spring|Summer|Fall) (\d{4})/.exec(badge.name);
		return match ? Date.UTC(+match[2], {Winter: 0, Spring: 3, Summer: 6, Fall: 9}[match[1]], 1) + SEASON_WEEKS * 7 * DAY : unreadable();
	}
	if(where === "Anime/Special" && group?.name === "Staff Picks") {
		if(/Hanamaru/i.test(badge.name)) { return Infinity; }	//Since 2023 the Hanamaru Mode badge has no time limit; Timed, Combined and the single early badges close
		const match = /Staff Picks Challenge:\s*(\d{4})/.exec(badge.name);
		return match ? Date.UTC(+match[1] + 1, 11, 26) : unreadable();
	}
	if(section.name === "End of Year") {
		const match = /^(\d{4}) Yearly/.exec(badge.name);
		return match ? Date.UTC(+match[1] + 1, 0, 1) : unreadable();
	}
	return Infinity;
}

/**
 * Links the page's own End of Year badges (which link nowhere) to their year's forum thread from the database. A badge in a link without an
 * address gets the address; otherwise its picture is wrapped in a new link. removeAll() undoes both.
 *
 * @param {object} data From prepareIndex().
 * @param {{images: Array<{img: Element, index: number}>}} scan From scanOwned().
 * @returns {number} How many badges were linked.
 */
function linkEndOfYear(data, scan) {
		const done = new Set();
	for(const {img, index} of scan.images) {
		const target = data.groupOfIndex.get(index)?.target;
		const figure = img.closest("figure");
		if(target?.box !== "Special" || target.title !== "End of Year" || !figure || done.has(figure)) { continue; }
		done.add(figure);
		const existing = figure.closest("a");
		if(existing?.getAttribute("href")) { continue; }
		const href = `https://anilist.co/forum/thread/${data.badges[index].thread}`;
		const link = existing ?? document.createElement("a");
		if(existing) { linkedBadges.push({link, href: existing.getAttribute("href"), target: existing.getAttribute("target"), rel: existing.getAttribute("rel")}); }
		link.href = href;
		link.target = "_blank";
		link.rel = "noopener noreferrer";
		if(!existing) {
			figure.replaceWith(link);
			link.appendChild(figure);
			linkedBadges.push({link, figure});
		}
	}
	return done.size;
}

/**
 * Puts the badges the challenger has not earned onto the page, each under its own category and sub-heading.
 * Anything that cannot be placed (the page's layout was not recognised) is collected and returned.
 *
 * @param {object} page From readPage().
 * @param {object} data From prepareIndex().
 * @param {{owned: Set<number>, elements: Map<Element, number>}} scan From scanOwned().
 * @param {boolean} includeAll Whether to include badges that can no longer be earned.
 * @returns {{placed: number, spoofed: number, leftover: object[]}}
 */
function placeUnowned(page, data, scan, includeAll) {
	const unowned = data.groups.filter(group => !scan.owned.has(group.current) && (group.legacy === null || !scan.owned.has(group.legacy)) && (includeAll || !closedFor(group, scan) || scan.granted.has(group.current)) && !hiddenSupporter(group, scan.granted.has(group.current)));
	const byCategory = new Map();	//"Box/title" -> groups
	for(const group of unowned) {
		const key = `${group.target.box}/${normTitle(group.target.title)}`;
		if(!byCategory.has(key)) { byCategory.set(key, []); }
		byCategory.get(key).push(group);
	}

	const leftover = [];
	let placed = 0;
	let spoofed = 0;
	const positions = new Map(scan.elements);	//Grows as badges are inserted, so later ones fall in order too
	for(const groups of byCategory.values()) {
		const {target} = groups[0];
		let box = page.boxes.find(candidate => candidate.title === target.box);
		const hadBox = Boolean(box);
		box ??= spoofBox(page, target.box);
		let unit = box?.units.find(candidate => candidate.title === normTitle(target.title));
		const hadUnit = Boolean(unit);
		if(box && !unit) { unit = spoofUnit(page, target, box); }
		if(!unit) { leftover.push(...groups); continue; }
		if(!hadBox || !hadUnit) { spoofed++; }

		const bySub = new Map();	//Sub-heading -> groups
		for(const group of groups.sort((a, b) => a.order - b.order)) {
			const sub = group.target.sub ?? "";
			if(!bySub.has(sub)) { bySub.set(sub, []); }
			bySub.get(sub).push(group);
		}
		for(const [sub, members] of bySub) {
			const display = displayFor(unit, page, data, sub || null, target, members[0].order, positions);
			const cards = members.map(group => ({el: track(decorateUnofficial(buildBadge(group, data.badges, page, scan.granted.has(group.current), closedFor(group, scan)), group, data)), order: group.order}));
			const lists = siblingDisplays(unit, display, data, positions);
			if(lists.length > 1) { insertAcrossDisplays(lists, cards, positions); } else { insertInOrder(display, cards, positions); }
			placed += cards.length;
		}
	}
	return {placed, spoofed, leftover};
}

/**
 * Fallback for a page whose layout the script does not recognise: one separate section, after the page's own badges.
 *
 * @param {object[]} groups The badges to show.
 * @param {object} data From prepareIndex().
 * @param {object} page From readPage().
 */
function placeFallback(groups, data, page) {
	const displays = [...document.querySelectorAll(".badge-display")];
	if(!displays.length) { return; }
	let anchor = displays[0].parentElement;
	if(displays.length > 1) {
		const ancestors = new Set();
		for(let node = displays[0]; node; node = node.parentElement) { ancestors.add(node); }
		for(let node = displays[displays.length - 1]; node; node = node.parentElement) {
			if(ancestors.has(node)) { anchor = node; break; }
		}
	}
	const section = document.createElement("div");
	section.className = "awc-un-fallback";
	const heading = document.createElement("h2");
	heading.textContent = `Unowned Badges (${groups.length})`;
	const holder = document.createElement("div");
	holder.className = "awc-un-holder";
	for(const group of groups.sort((a, b) => a.order - b.order)) { holder.appendChild(buildBadge(group, data.badges, page)); }
	section.append(heading, holder);
	anchor.appendChild(track(section));
}

/**
 * Turns the script's changes on for the current page: unowned badges in their categories.
 *
 * @param {object} data From prepareIndex().
 * @param {boolean} [includeAll=false] Whether to include badges that can no longer be earned.
 */
function applyAll(data, includeAll = false) {
	if(applied) { return; }
	applied = true;
	injectStyles();

	const page = readPage();
	if(!page.boxes.length) {	//Nothing to attach to. A profile that has earned nothing gets a short note; for any other page the script cannot tell why, so it does nothing
		if(emptyProfile()) { addEmptyNotice(); } else { console.info("AWC Unowned Badges: No badge boxes found on this page, so nothing was added."); }
		return;
	}
	const scan = applyMarks(scanOwned(data), data);
	console.info(`AWC Unowned Badges: ${scan.imageCount} badge images on the page, ${scan.matched} recognised (${scan.byThread} by forum thread, ${scan.byCaption} by label); ${page.boxes.length} boxes, ${page.boxes.reduce((n, box) => n + box.units.length, 0)} categories read.`);
	if(scan.unmatched.length) { console.info("AWC Unowned Badges: Page images that are not in the database (the database may be missing them):", scan.unmatched); }
	if(scan.imageCount > 0 && scan.matched === 0) {
		console.warn("AWC Unowned Badges: None of the badges on this page could be matched to the database, so the unowned list may be wrong.");
	}

	for(const {img, index} of scan.images) {	//The page's own badges get the database's name as a tooltip, like the unowned ones
		const name = data.badges[index].name;
		if(img.getAttribute("title") === name) { continue; }
		titled.push({img, previous: img.getAttribute("title")});
		img.title = name;
	}

	for(const box of page.boxes) {	//Categories shown in rows: bring the page's own badges into database order first
		for(const unit of box.units) {
			const size = ROWS_OF[Object.keys(ROWS_OF).find(key => key.toLowerCase() === `${box.title}/${unit.title}`.toLowerCase())];
			const first = size ? data.groups.find(group => group.target.source.toLowerCase() === `${box.title}/${unit.title}`.toLowerCase()) : null;
			if(first) { regroupRows(unit, size, scan, data.sectionStarts.get(first.target.source)); }
		}
	}

	const switches = addMissingSwitches(data, page, scan);

	const result = placeUnowned(page, data, scan, includeAll);
	if(result.leftover.length) {
		console.warn(`AWC Unowned Badges: Could not find where ${result.leftover.length} badges belong on this page; showing them in a separate section.`);
		placeFallback(result.leftover, data, page);
	}
	addCollapseButtons(page);	//Boxes made above get theirs here; the page's own already have them (see init)
	appliedScan = scan;
	const linked = linkEndOfYear(data, scan);	//Last, so the page's own badges keep the positions they were found at while the new ones are placed
	console.info(`AWC Unowned Badges: Added ${result.placed} unowned badges (${result.spoofed} categories made new, ${scan.granted.size} counted as owned, ${switches} legacy switches added to the page's own badges, ${linked} End of Year badges linked).`);
}

/* ---------------- PROGRESS DASHBOARD ---------------- */
/** @returns {boolean} Whether the page shows a challenger with 0 points and no badge list at all (nothing earned yet). */
function emptyProfile() {
	if(document.querySelector(".badge-display")) { return false; }
	const stat = [...document.querySelectorAll(".challenger-stat")].find(el => /^points$/i.test(el.querySelector(".challenger-stat-title")?.textContent.trim() ?? ""));
	return stat !== undefined && /^0$/.test(stat.querySelector(".challenger-stat-value")?.textContent.trim() ?? "");
}

/** Says that there is nothing to compare yet, under the stats, for a challenger who has earned nothing. */
function addEmptyNotice() {
	const stats = document.querySelector(".challenger-stats");
	if(!stats) { return; }
	const notice = document.createElement("div");
	notice.className = "awc-un-dashboard awc-un-notice";
	notice.textContent = "Earn a badge first. Once you have one, this page can show the badges you are still missing.";
	stats.after(track(notice));
}

/** @returns {HTMLInputElement|null} The tick box that opens and closes a category. */
function categoryInput(unit) {
	return (unit.header.htmlFor && document.getElementById(unit.header.htmlFor)) ?? unit.root?.querySelector("input[type=checkbox]") ?? null;
}

let collapseRestore = [];	//Header bars given a position for the collapse button, with the style they had
let ownCollapse = [];	//The same, for the page's own boxes: those buttons stay while Unowned is off, so they are tracked apart from the rest

/**
 * Adds a collapse-all button (a symbol, no text) at the left of each box's header bar: the page's own boxes and the ones made here.
 * It only collapses: every category in the box is closed, and nothing is ever opened by it.
 * The page's own boxes get theirs whether or not Unowned is on (removeCollapseButtons() takes those out); the boxes made here lose theirs with the box.
 *
 * @param {object} page From readPage().
 */
function addCollapseButtons(page) {
	for(const box of page.boxes) {
		if(!box.titleEl) { continue; }
		for(const stale of box.el.querySelectorAll(".awc-un-collapse")) {	//Only buttons this script made and still tracks count; anything else is a dead copy
			if(!ownButtons.includes(stale) && !injected.some(node => node.contains(stale))) { stale.remove(); }
		}
		if(box.el.querySelector(".awc-un-collapse")) { continue; }
		const own = !injected.includes(box.el);	//A box this script made is in the list of injected nodes
		let bar = box.titleEl;
		while(bar.parentElement && bar.parentElement !== box.el && !bar.parentElement.querySelector(".badge-display, input[type=checkbox]")) { bar = bar.parentElement; }
		if(getComputedStyle(bar).position === "static") {
			(own ? ownCollapse : collapseRestore).push({bar, style: bar.getAttribute("style")});
			bar.style.position = "relative";
		}
		const button = document.createElement("button");
		button.type = "button";
		button.className = "awc-un-collapse";
		button.title = `Collapse all ${box.title} categories`;
		button.setAttribute("aria-label", button.title);
		button.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 11l6-6 6 6M6 18l6-6 6 6"/></svg>';
		button.addEventListener("click", event => {
			event.preventDefault();
			event.stopPropagation();
			for(const unit of findUnits(box.el)) {
				const input = categoryInput(unit);
				if(input?.checked) {
					input.checked = false;
					input.dispatchEvent(new Event("change", {bubbles: true}));
				}
			}
		});
		bar.appendChild(own ? button : track(button));
		if(own) { ownButtons.push(button); }
	}
}
let ownButtons = [];

/** Takes the collapse buttons off the page's own boxes, and gives their header bars back the style they had. */
function removeCollapseButtons() {
	for(const button of ownButtons) { button.remove(); }
	ownButtons = [];
	for(const {bar, style} of ownCollapse) { if(style === null) { bar.removeAttribute("style"); } else { bar.setAttribute("style", style); } }
	ownCollapse = [];
}

/**
 * Opens a category on the page and scrolls to it.
 *
 * @param {string} boxTitle "Anime", "Manga" or "Special".
 * @param {string[]} titles The category's names (several for Monthly, one per year); the last one that exists is used (the current or latest year).
 */
function jumpToCategory(boxTitle, titles) {
	const box = readPage().boxes.find(candidate => candidate.title === boxTitle);
	const unit = titles.map(title => box?.units.find(candidate => candidate.title === normTitle(title))).filter(Boolean).pop();	//A row can cover several categories (Monthly 2019 to 2026): go to the last, the current or latest year
	if(!unit) { return; }
	const input = categoryInput(unit);
	if(input && !input.checked) {
		input.checked = true;
		input.dispatchEvent(new Event("change", {bubbles: true}));
	}
	const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
	(unit.root ?? unit.header).scrollIntoView({behavior: reduced ? "auto" : "smooth", block: "start"});
}

/**
 * Adds a small, collapsible progress panel after the page's Place/Rank/Points stats: one overall bar, and when expanded a compact bar per category.
 * Counts follow what the page is showing: earned badges (including ones counted as earned because a higher one was) against earned plus the
 * unowned badges currently listed, so in "On" mode the badges that can no longer be earned are left out and in "All" mode they are counted.
 * Monthly's years are added together into one "Monthly" row. Removed with everything else the script added.
 *
 * @param {object} data From prepareIndex().
 * @param {{owned: Set<number>, granted: Set<number>}} scan From scanOwned().
 * @param {boolean} includeAll Whether badges that can no longer be earned count.
 */
function addDashboard(data, scan, includeAll) {
	const stats = document.querySelector(".challenger-stats");
	if(!stats) { return; }
	const rows = new Map();	//"Box/label" -> {box, label, owned, total}
	for(const group of data.groups) {
		const isOwned = scan.owned.has(group.current) || (group.legacy !== null && scan.owned.has(group.legacy)) || scan.granted.has(group.current);
		if(!isOwned && ((closedFor(group, scan) && !includeAll) || hiddenSupporter(group, false))) { continue; }
		const {box, title} = group.target;
		const label = /^Monthly\b/.test(title) ? "Monthly" : title;
		const key = `${box}/${label}`;
		if(!rows.has(key)) { rows.set(key, {box, label, owned: 0, total: 0, titles: [], club: /^(Supporter|Unofficial)$/.test(title) ? "other" : group.target.source.startsWith("Manga/") ? "mrc" : "awc"}); }
		const row = rows.get(key);
		if(!row.titles.includes(title)) { row.titles.push(title); }
		row.total++;
		if(isOwned) { row.owned++; }
		else if(Number.isFinite(closesFor(group, scan)) && !closedFor(group, scan) && !hiddenSupporter(group, false)) { row.closing = (row.closing ?? 0) + 1; }	//Open now, with a close date: it will not be around forever
	}
	const list = [...rows.values()];
	if(!list.length) { return; }
	const total = list.reduce((sum, row) => sum + row.total, 0);
	const owned = list.reduce((sum, row) => sum + row.owned, 0);
	const percent = (a, b) => b ? Math.round(a / b * 100) : 0;
	const bar = (a, b) => {
		const track = document.createElement("div");
		track.className = "awc-un-bar";
		const fill = document.createElement("div");
		fill.className = a === b ? "awc-un-bar-fill awc-un-bar-done" : "awc-un-bar-fill";
		fill.style.width = `${percent(a, b)}%`;
		track.appendChild(fill);
		return track;
	};
	const labelCount = new Map();
	for(const row of list) { labelCount.set(row.label, (labelCount.get(row.label) ?? 0) + 1); }

	const panel = document.createElement("details");
	panel.id = "awc-un-dashboard";
	panel.className = "awc-un-dashboard";
	const rank = stats.style.getPropertyValue("--rank-color");
	if(rank) { panel.style.setProperty("--awc-un-accent", rank); }
	panel.open = settings.dashboardOpen;
	panel.addEventListener("toggle", () => remember("dashboardOpen", panel.open));

	const summary = document.createElement("summary");
	const title = document.createElement("span");
	title.className = "awc-un-dash-title";
	title.textContent = "Badge progress";
	const figures = document.createElement("span");
	figures.className = "awc-un-dash-figures";
	figures.textContent = `${owned} / ${total} · ${percent(owned, total)}%`;
	summary.append(title, bar(owned, total), figures);
	panel.appendChild(summary);

	const makeRow = row => {
		const cell = document.createElement("div");
		cell.className = "awc-un-dash-row";
		cell.tabIndex = 0;
		cell.setAttribute("role", "link");
		const displayName = labelCount.get(row.label) > 1 ? `${row.box} ${row.label}` : row.label;
		cell.title = `Go to ${displayName}`;
		const go = () => jumpToCategory(row.box, row.titles);
		cell.addEventListener("click", go);
		cell.addEventListener("keydown", event => { if(event.key === "Enter" || event.key === " ") { event.preventDefault(); go(); } });
		const name = document.createElement("span");
		name.className = "awc-un-dash-name";
		name.textContent = displayName;
		const numbers = document.createElement("span");
		numbers.className = "awc-un-dash-figures";
		numbers.textContent = `${row.owned}/${row.total} · ${percent(row.owned, row.total)}%`;
		if(settings.dashboardWarn && row.closing) {
			const warn = document.createElement("span");
			warn.className = "awc-un-dash-warn";
			warn.textContent = "!";
			warn.title = `${row.closing} badge${row.closing === 1 ? "" : "s"} you do not have yet will not be available forever`;
			numbers.appendChild(warn);
		}
		cell.append(name, numbers, bar(row.owned, row.total));
		return cell;
	};
	const makeGrid = rows => {
		const grid = document.createElement("div");
		grid.className = "awc-un-dash-grid";
		grid.append(...rows.map(makeRow));
		return grid;
	};
	if(!settings.dashboardClubs) { panel.appendChild(makeGrid(list)); }
	else {
		for(const [club, label] of [["awc", "AWC"], ["mrc", "MRC"], ["other", ""]]) {
			const rows = list.filter(row => row.club === club);
			if(!rows.length) { continue; }
			const block = document.createElement("div");
			block.className = `awc-un-club awc-un-club-${club}`;
			if(label) {
				const tag = document.createElement("div");
				tag.className = "awc-un-club-tag";
				tag.textContent = label;
				block.appendChild(tag);
			}
			block.appendChild(makeGrid(rows));
			panel.appendChild(block);
		}
	}
	stats.after(panel);
	dashboardNode = panel;
}

let dashboardNode = null;	//The dashboard on the page. It is not part of removeAll(): it does not depend on the Unowned button
let appliedScan = null;	//What applyAll() found on the page, so the dashboard can reuse it while Unowned is on

/** Takes the dashboard off the page. */
function removeDashboard() {
	dashboardNode?.remove();
	dashboardNode = null;
}

/**
 * (Re)builds the dashboard for the current settings and mode, loading the database first if it has not been loaded yet.
 * It counts what can still be earned (and, in the "all" mode, everything), whether or not the unowned badges are shown.
 *
 * @param {number} token The init() call this belongs to.
 */
async function refreshDashboard(token) {
	removeDashboard();
	if(!settings.showDashboard || !document.querySelector(".challenger-stats") || !document.querySelector(".badge-display")) { return; }	//Nothing to show it under, or an empty profile: no need to load the database either
	try {
		preparedData ??= prepareIndex(await loadDB());
		if(token !== currentInitToken) { return; }
		removeDashboard();	//A newer refresh may have finished first
		addDashboard(preparedData, appliedScan ?? applyMarks(scanOwned(preparedData), preparedData), mode === "all");
	} catch (err) {
		console.error("AWC Unowned Badges error:", err);
	}
}

/* ---------------- 3D TILT ---------------- */
let tilted = new Map();	//Figure -> what was added to it, so removeTilt() can take it all back
let tiltOn = settings.tilt;	//Whether the tilt button is on

/**
 * Makes one badge tilt under the pointer and catch the light. Nothing in the page is moved: the figure itself is transformed, and two
 * silhouette layers (light and shade) are added inside it, sized to whichever picture is showing. removeTilt() undoes all of it.
 *
 * @param {HTMLElement} figure The badge's figure element.
 */
function addTilt(figure) {
	if(tilted.has(figure)) { return; }
	const controller = new AbortController();
	const {signal} = controller;
	const light = document.createElement("div");
	light.className = "awc-un-light";
	const shade = document.createElement("div");
	shade.className = "awc-un-shade";
	const needsPosition = getComputedStyle(figure).position === "static";	//The layers are placed against the figure
	if(needsPosition) { figure.classList.add("awc-un-tilt-rel"); }
	figure.classList.add("awc-un-tilt");
	figure.append(light, shade);
	tilted.set(figure, {controller, light, shade, needsPosition});

	const norm = v => { const length = Math.hypot(...v); return v.map(c => c / length); };
	const L = norm([0, -0.3, 0.95]);	//Direction toward the light: centred horizontally, slightly above, mostly frontal
	const H = norm([L[0], L[1], L[2] + 1]);	//The surface normal that reflects the light at the viewer
	const DEG = Math.PI / 180;
	const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
	const shown = () => {	//The picture the viewer sees now
		const images = [...figure.querySelectorAll("img")];
		const toggle = figure.closest(".badge")?.querySelector(".legacy-toggle");
		if(toggle && images.length > 1) {	//The switch knows which one is meant, even while the page is still fading or loading them
			const wantsLegacy = toggle.dataset.state === "old";
			const match = images.find(img => /legacy|old/.test(img.className) === wantsLegacy && !img.classList.contains("hidden"));
			if(match) { return match; }
		}
		const visible = images.filter(img => {	//Otherwise look at what the page shows: it may hide one by a class, by visibility or by opacity
			const computed = getComputedStyle(img);
			const opacity = parseFloat(computed.opacity);
			return img.offsetWidth > 0 && !img.classList.contains("hidden") && computed.visibility !== "hidden" && computed.display !== "none" && (Number.isNaN(opacity) || opacity > 0.01);
		});
		return visible[visible.length - 1] ?? images.find(img => !img.classList.contains("hidden")) ?? images[0];
	};
	const syncLayers = () => {	//Sized to the picture showing, so it is redone on every mouse move, picture swap and picture load
		const img = shown();
		if(!img) { return; }
		const computed = getComputedStyle(img);	//A picture can sit inside a bigger box (object-fit: contain), so the silhouette has to be fitted the same way or it spreads past the badge
		const fit = computed.getPropertyValue("object-fit") || "fill";
		const size = fit === "fill" ? "100% 100%" : fit === "none" ? "auto" : fit === "scale-down" ? "contain" : fit;
		const position = computed.getPropertyValue("object-position") || "50% 50%";
		for(const layer of [light, shade]) {
			layer.style.backgroundSize = size;
			layer.style.backgroundPosition = position;
			layer.style.left = `${img.offsetLeft}px`;
			layer.style.top = `${img.offsetTop}px`;
			layer.style.width = `${img.offsetWidth}px`;
			layer.style.height = `${img.offsetHeight}px`;
		}
		figure.style.setProperty("--badge-url", `url("${(img.currentSrc || img.src).replace(/"/g, "%22")}")`);
	};
	const resync = () => { if(figure.classList.contains("awc-un-tilting")) { syncLayers(); } };
	const watcher = new MutationObserver(resync);	//The page swapping the pictures (their classes) while the pointer rests on the badge
	watcher.observe(figure, {subtree: true, attributes: true, attributeFilter: ["class", "src"]});
	for(const img of figure.querySelectorAll("img")) { img.addEventListener("load", resync, {signal}); }
	let rect = null;	//The badge's resting position, taken before it moves (its own transform would distort a later reading)
	let scrollX = 0;
	let scrollY = 0;
	let frame = 0;
	let lastEvent = null;
	let releaseTimer = 0;
	const update = () => {
		frame = 0;
		if(!rect.width || !rect.height) { return; }
		const x = lastEvent.clientX - (rect.left - (window.scrollX - scrollX));
		const y = lastEvent.clientY - (rect.top - (window.scrollY - scrollY));
		const percentX = clamp((x / rect.width) * 2 - 1, -1, 1);
		const percentY = clamp((y / rect.height) * 2 - 1, -1, 1);
		const rotateY = Math.sin(percentX * Math.PI / 2) * 15;
		const rotateX = -Math.sin(percentY * Math.PI / 2) * 15;
		const nx = Math.sin(rotateY * DEG);
		const ny = -Math.sin(rotateX * DEG);
		const d2 = (nx - H[0]) ** 2 + (ny - H[1]) ** 2;
		const spec = 0.15 + 0.85 * Math.exp(-d2 / (2 * 0.22 * 0.22));
		const gx = clamp(50 + (H[0] - nx) * 120, 0, 100);
		const gy = clamp(50 + (H[1] - ny) * 120, 0, 100);
		const delta = ny * L[1];
		const lightAmount = clamp(0.17 + spec * 0.7 + Math.max(delta, 0) * 1.5, 0, 1);
		const shadeAmount = clamp(Math.max(-delta, 0) * 0.8, 0, 0.15);
		syncLayers();	//The viewer may have switched between the new and legacy picture while hovering
		const style = figure.style;
		style.setProperty("--rx", `${rotateX}deg`);
		style.setProperty("--ry", `${rotateY}deg`);
		style.setProperty("--sx", `${-percentX * 10}px`);
		style.setProperty("--sy", `${-percentY * 10}px`);
		style.setProperty("--gx", `${gx}%`);
		style.setProperty("--gy", `${gy}%`);
		style.setProperty("--li", lightAmount.toFixed(3));
		style.setProperty("--si", shadeAmount.toFixed(3));
	};
	figure.addEventListener("mouseenter", event => {
		clearTimeout(releaseTimer);
		rect = figure.getBoundingClientRect();
		scrollX = window.scrollX;
		scrollY = window.scrollY;
		syncLayers();
		figure.classList.add("awc-un-tilting");
		lastEvent = event;
		if(!frame) { frame = requestAnimationFrame(update); }
	}, {signal});
	figure.addEventListener("mousemove", event => {
		lastEvent = event;
		if(rect && !frame) { frame = requestAnimationFrame(update); }
	}, {signal});
	figure.addEventListener("mouseleave", () => {
		figure.classList.remove("awc-un-tilting");	//The page's transition settles it back to flat
		releaseTimer = setTimeout(() => figure.style.removeProperty("--badge-url"), 400);
		if(frame) { cancelAnimationFrame(frame); frame = 0; }
	}, {signal});
	signal.addEventListener("abort", () => { watcher.disconnect(); clearTimeout(releaseTimer); if(frame) { cancelAnimationFrame(frame); } });
}

/** Adds the tilt to every badge in the page's lists, the page's own and the ones added here, unless the person has no pointer to hover with or prefers less motion. */
function applyTilt() {
	injectStyles();	//The tilt can be on while the unowned badges are off, so it cannot rely on them having added the stylesheet
	if(window.matchMedia && (!window.matchMedia("(hover: hover) and (pointer: fine)").matches || window.matchMedia("(prefers-reduced-motion: reduce)").matches)) { return; }
	document.querySelectorAll(".badge-display figure").forEach(addTilt);
}

/** Takes the tilt off every badge. */
function removeTilt() {
	for(const [figure, {controller, light, shade, needsPosition}] of tilted) {
		controller.abort();
		light.remove();
		shade.remove();
		figure.classList.remove("awc-un-tilt", "awc-un-tilting");
		if(needsPosition) { figure.classList.remove("awc-un-tilt-rel"); }
		for(const name of ["--rx", "--ry", "--sx", "--sy", "--gx", "--gy", "--li", "--si", "--badge-url"]) { figure.style.removeProperty(name); }
		if(!figure.getAttribute("style")) { figure.removeAttribute("style"); }
		if(!figure.getAttribute("class")) { figure.removeAttribute("class"); }
	}
	tilted = new Map();
}

/** Puts the tilt on the page as it now is, or takes it off, to match the tilt button. */
function refreshTilt() {
	removeTilt();
	if(tiltOn) { applyTilt(); }
}

/* ---------------- HEADER SWITCH ---------------- */
let headerSwitch = null;	//The unowned-badges button added to the page's header
let scrollTopButton = null;	//The back-to-top button, and what keeps it up to date
let scrollTopWatch = null;
let tiltSwitch = null;	//The tilt button added to the left of the page's header
let tiltHeader = null;	//The header it sits in, and what that header's style attribute was before
const TILT_ICON = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"><path d="M4.5 6.5L19.5 3.5V20.5L4.5 17.5Z"/><ellipse cx="12.2" cy="12" rx="4.1" ry="5"/><path d="M10.3 10.4Q11.3 8.9 12.9 8.6" opacity=".75"/></svg>');	//A badge card tipped in perspective with a round badge on it

/**
 * Finds whatever scrolls the page: the page itself, or (when the site keeps the page height fixed and scrolls an inner panel instead) the
 * biggest inner element that can scroll.
 *
 * @returns {Element|null} The scrolling element, or null if nothing can scroll far enough to need a button.
 */
function findScroller() {
	const root = document.scrollingElement ?? document.documentElement;
	if(root.scrollHeight > root.clientHeight + 80) { return root; }
	let best = null;
	let bestArea = 0;
	for(const el of document.body.querySelectorAll("*")) {
		if(el.scrollHeight <= el.clientHeight + 80 || el.id === "awc-un-lift") { continue; }	//Cheap test first; only the few tall ones get their style read
		const style = getComputedStyle(el);
		if(!/auto|scroll/.test(style.overflowY || style.overflow)) { continue; }
		const area = el.clientWidth * el.clientHeight;
		if(!best || area > bestArea) { best = el; bestArea = area; }
	}
	return best;
}

/** Adds a back-to-top button at the right of the screen, shown whenever the page (or the panel the site scrolls) is long enough to scroll. */
function installScrollTop() {
	if(scrollTopButton) { return; }
	injectStyles();
	const button = document.createElement("button");
	button.id = "awc-un-lift";
	button.type = "button";
	button.style.cssText = "position: fixed !important; right: 18px !important; bottom: 24px !important; width: 44px !important; height: 44px !important; display: flex !important; visibility: visible !important;";	//Also inline, so a page style cannot flatten it to nothing
	button.title = "Jump to the start of the page";
	button.setAttribute("aria-label", "Jump to the start of the page");
	button.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V6M6 11l6-6 6 6"/></svg>';
	let scroller = null;
	button.addEventListener("click", () => {
		const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
		const root = document.scrollingElement ?? document.documentElement;
		(scroller && scroller !== root ? scroller : window).scrollTo({top: 0, behavior: reduced ? "auto" : "smooth"});
	});
	let timer = 0;
	const update = () => {
		timer = 0;
		scroller = findScroller();
		button.classList.toggle("awc-un-lift-show", true);
	};
	const schedule = () => { if(!timer) { timer = setTimeout(update, 200); } };	//Many things change the height (categories opening, badges added); look again shortly after
	window.addEventListener("resize", schedule);
	document.addEventListener("scroll", schedule, true);	//Scroll events do not bubble, so listen on the way down to catch an inner panel's
	document.addEventListener("click", schedule, true);
	const observer = new MutationObserver(schedule);
	observer.observe(document.body, {childList: true, subtree: true});
	scrollTopWatch = () => {
		clearTimeout(timer);
		window.removeEventListener("resize", schedule);
		document.removeEventListener("scroll", schedule, true);
		document.removeEventListener("click", schedule, true);
		observer.disconnect();
	};
	document.documentElement.appendChild(button);	//On the root element rather than the body, so a transform or containment on the body cannot move or clip it
	scrollTopButton = button;
	update();
}

/** Removes the jump-to-start button and stops its watching. */
function removeScrollTop() {
	scrollTopWatch?.();
	scrollTopWatch = null;
	scrollTopButton?.remove();
	scrollTopButton = null;
}

let settingsSync = null;	//Refreshes the settings panel's dependent parts (greyed options, the purge button)
let settingsMenu = null;	//The gear button (and its panel) in the page's header
const GEAR_PATH = "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z";	//The same gear the main script uses

/**
 * Builds the bottom of the settings panel: name and version, how fresh the badge data is (with a button to download it again), the links,
 * and a line pointing to the sister script. A link whose address is not set yet is left out.
 *
 * @param {(key: string) => Promise<void>|void} onChange Called with "refreshData" when the button is pressed.
 * @returns {{element: HTMLElement, update: () => void}} The footer, and a function that refreshes the data line.
 */
function makeFooter(onChange) {
	const make = (tag, className, text) => {
		const el = document.createElement(tag);
		if(className) { el.className = className; }
		if(text !== undefined) { el.textContent = text; }
		return el;
	};
	const link = (href, text) => {
		const a = make("a", "", text);
		a.href = href;
		a.target = "_blank";
		a.rel = "noopener noreferrer";
		return a;
	};
	const footer = make("div", "awc-un-foot");

	const title = make("div", "awc-un-foot-title", GM_info.script.name);
	title.appendChild(make("span", "", `v${GM_info.script.version}`));

	const data = make("div", "awc-un-foot-data");
	const status = make("span");
	status.title = "When the badge list was last checked for changes";
	const refresh = make("button", "", "Refresh");
	refresh.type = "button";
	refresh.title = "Download the badge list again";
	data.append(status, refresh);
	const update = () => {
		const record = readCache();
		const when = record ? new Date(record.timestamp).toLocaleString(undefined, {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"}) : "";
		const count = preparedData ? ` · ${preparedData.badges.length} badges` : "";
		status.textContent = when ? `Badge data: ${when}${count}` : `Badge data: ${preparedData ? "just downloaded" : "not loaded yet"}${count}`;
	};
	refresh.addEventListener("click", async () => {
		refresh.disabled = true;
		refresh.textContent = "Refreshing…";
		try { await onChange("refreshData"); refresh.textContent = "Refresh"; } catch { refresh.textContent = "Failed, retry"; }
		refresh.disabled = false;
		update();
	});

	const links = make("div", "awc-un-foot-links");
	links.appendChild(link(GITHUB_URL, "GitHub"));
	if(GREASYFORK_URL) { links.appendChild(link(GREASYFORK_URL, "Greasy Fork")); }
	links.appendChild(link(`${GITHUB_URL}/issues`, "Issues & suggestions"));
	const discord = make("div", "awc-un-foot-note", "or @Eremeir on the AWC Discord");

	footer.append(title, data, links, discord);
	if(SISTER_URL) {
		const sister = make("div", "awc-un-sister");
		sister.append(link(SISTER_URL, "Try the sister script! ↗"), " · See featuring badges right on AniList character pages!");
		footer.appendChild(sister);
	}
	update();
	return {element: footer, update};
}

/**
 * Adds the settings gear in the corner at the left end of the page's header (the tilt button sits just right of it).
 * Styled like the main script's gear: a plain icon that turns blue and rotates while the panel is open. Each checkbox saves at once and calls onChange(key).
 * The panel closes on an outside click or Escape; those listeners only exist while it is open.
 *
 * @param {(key: string) => void} onChange Called after a setting changes.
 */
function installSettingsMenu(onChange) {
	const anchor = document.querySelector("#challenger-signature") ?? document.querySelector(".challenger-header-link");
	const header = anchor?.closest(".challenger-header") ?? anchor?.parentElement;
	if(!header) { return; }
	injectStyles();
	const menu = document.createElement("div");
	menu.id = "awc-un-settings";
	menu.className = "awc-un-settings";
	const button = document.createElement("button");
	button.type = "button";
	button.className = "awc-un-gear";
	button.title = "Unowned Badges settings";
	button.setAttribute("aria-label", "Unowned Badges settings");
	button.setAttribute("aria-expanded", "false");
	const svgNS = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(svgNS, "svg");	//Built as DOM rather than innerHTML in case the page enforces Trusted Types
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("width", "20");
	svg.setAttribute("height", "20");
	svg.setAttribute("fill", "currentColor");
	const path = document.createElementNS(svgNS, "path");
	path.setAttribute("d", GEAR_PATH);
	svg.appendChild(path);
	button.appendChild(svg);

	const panel = document.createElement("div");
	panel.className = "awc-un-gear-panel";
	panel.hidden = true;
	const boxes = new Map();
	let ownerBlock = null, ownerInput = null, purgeButton = null;
	function makeOwnerBlock() {	//Under "Show unofficial badges": whose page may mark them as owned
		ownerBlock = document.createElement("div");
		ownerBlock.className = "awc-un-owner";
		const caption = document.createElement("span");
		caption.textContent = "Your AniList username";
		caption.title = "On the page with this name, each unofficial badge gets a button to mark it as owned. Marks only show on that page.";
		const row = document.createElement("div");
		row.className = "awc-un-owner-row";
		ownerInput = document.createElement("input");
		ownerInput.type = "text";
		ownerInput.maxLength = 40;
		ownerInput.spellcheck = false;
		ownerInput.autocomplete = "off";
		ownerInput.placeholder = "username";
		ownerInput.value = settings.unofficialOwner;
		ownerInput.addEventListener("keydown", event => { if(event.key !== "Escape") { event.stopPropagation(); } });	//Typing must not trigger the site's shortcuts
		ownerInput.addEventListener("change", () => {
			settings.unofficialOwner = ownerInput.value.trim().replace(/^@/, "");
			ownerInput.value = settings.unofficialOwner;
			saveSettings();
			syncDependents();
			onChange("unofficialOwner");
		});
		purgeButton = document.createElement("button");
		purgeButton.type = "button";
		purgeButton.className = "awc-un-purge";
		purgeButton.textContent = "Purge marks";
		purgeButton.title = "Forget every unofficial badge you marked as owned (and their links)";
		purgeButton.addEventListener("click", () => {
			if(!window.confirm("Forget every unofficial badge you marked as owned, and their links?")) { return; }
			settings.unofficialMarks = {};
			saveSettings();
			syncDependents();
			onChange("unofficialMarks");
		});
		row.append(ownerInput, purgeButton);
		ownerBlock.append(caption, row);
		return ownerBlock;
	}
	for(const option of SETTING_OPTIONS) {
		const label = document.createElement("label");
		label.title = option.description;
		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.checked = Boolean(settings[option.key]);
		checkbox.addEventListener("change", () => {
			settings[option.key] = checkbox.checked;
			saveSettings();
			syncDependents();
			onChange(option.key);
		});
		if(option.requires) { label.classList.add("awc-un-sub"); }
		label.append(checkbox, option.label);
		panel.appendChild(label);
		boxes.set(option.key, {checkbox, label, option});
		if(option.key === "showUnofficial") { panel.appendChild(makeOwnerBlock()); }
	}
	function syncDependents() {
		if(ownerBlock) {
			const enabled = Boolean(settings.showUnofficial);
			ownerInput.disabled = !enabled;
			ownerBlock.classList.toggle("awc-un-off", !enabled);
			purgeButton.hidden = !(settings.unofficialOwner && Object.keys(settings.unofficialMarks).length);	//Only once there is a name and saved data
		}
		for(const {checkbox, label, option} of boxes.values()) {
			if(!option.requires) { continue; }
			const enabled = Boolean(settings[option.requires]);
			checkbox.disabled = !enabled;
			label.classList.toggle("awc-un-off", !enabled);
		}
	}
	syncDependents();
	settingsSync = syncDependents;

	const footer = makeFooter(onChange);
	panel.appendChild(footer.element);

	const onOutsideClick = event => { if(!menu.contains(event.target)) { setOpen(false); } };
	const onKey = event => { if(event.key === "Escape") { setOpen(false); button.focus(); } };
	function setOpen(open) {
		if(open) {	//Fixed to the screen at the gear's position, so a header that clips its overflow cannot cut the panel off
			const box = button.getBoundingClientRect();
			panel.style.top = `${box.bottom + 6}px`;
			panel.style.left = `${Math.max(8, box.left)}px`;
			panel.style.maxHeight = `${Math.max(160, window.innerHeight - box.bottom - 16)}px`;	//Scrolls inside itself on a short screen
			footer.update();
		}
		panel.hidden = !open;
		button.classList.toggle("awc-un-open", open);
		button.setAttribute("aria-expanded", String(open));
		const method = open ? "addEventListener" : "removeEventListener";
		document[method]("click", onOutsideClick);
		document[method]("keydown", onKey);
		if(open) { window.addEventListener("scroll", closeOnScroll, {once: true, passive: true}); }
	}
	const closeOnScroll = () => setOpen(false);
	button.addEventListener("click", () => setOpen(panel.hidden));

	menu.style.cssText = "position: absolute; left: 20px; top: 50%; margin-top: -14px; display: flex;";	//In the corner, out of the header's flow like the tilt button
	if(getComputedStyle(header).position === "static" && !tiltHeader) {
		tiltHeader = {header, style: header.getAttribute("style")};
		header.style.position = "relative";
	}
	menu.append(button, panel);
	header.prepend(menu);
	settingsMenu = menu;
}

/** Removes the header button. */
function removeHeaderSwitch() {
	headerSwitch?.remove();
	headerSwitch = null;
	removeScrollTop();
	settingsMenu?.remove();
	settingsMenu = null;
	settingsSync = null;
	tiltSwitch?.remove();
	tiltSwitch = null;
	if(tiltHeader) {
		if(tiltHeader.style === null) { tiltHeader.header.removeAttribute("style"); } else { tiltHeader.header.setAttribute("style", tiltHeader.style); }
		tiltHeader = null;
	}
}

/**
 * Adds the on/off button to the page's header, next to "Profile Card", built the way the site builds its header links.
 *
 * @param {(mode: string) => void} onChange Called after each click with the new mode ("off", "obtainable" or "all").
 * @param {string} mode The starting mode. Clicking cycles off, obtainable, all, and back to off.
 */
function installHeaderSwitch(onChange, mode) {
	const anchor = document.querySelector("#challenger-signature") ?? document.querySelector(".challenger-header-link");
	if(!anchor) { console.info("AWC Unowned Badges: Could not find the page header, so there is no on/off button."); return; }

	const link = document.createElement("div");
	link.className = "challenger-header-link actionable";
	link.id = "awc-un-header-switch";
	link.style.marginLeft = "25px";
	link.setAttribute("role", "button");
	const icon = document.createElement("img");
	icon.width = 25;
	icon.height = 25;
	icon.src = SWITCH_ICON;
	icon.alt = "";
	icon.draggable = false;
	icon.style.marginRight = "0.4em";
	const label = document.createElement("span");
	label.className = "awc-un-label";	//Hidden on narrow screens, leaving just the icon
	label.style.whiteSpace = "nowrap";
	link.append(icon, label);

	const ORANGERED = "#ff4500";
	const MODES = {	//The "all" filter turns the icon (whatever colour it is) into orangered
		off: {text: "Unowned: Off", color: "#8a8f98", opacity: "0.6", filter: "", tip: "Show the badges you have not earned"},
		obtainable: {text: "Unowned: On", color: "#ffffff", opacity: "1", filter: "", tip: "Also show the badges that can no longer be earned"},
		all: {text: "Unowned: All", color: ORANGERED, opacity: "1", filter: "brightness(0) saturate(100%) invert(21%) sepia(95%) saturate(4019%) hue-rotate(19deg) brightness(124%)", tip: "Hide the badges you have not earned"}
	};
	const refresh = () => {
		label.textContent = MODES[mode].text;
		label.style.color = MODES[mode].color;
		icon.style.opacity = MODES[mode].opacity;
		icon.style.filter = MODES[mode].filter;
		link.title = MODES[mode].tip;
		link.setAttribute("aria-label", `${MODES[mode].text}. ${MODES[mode].tip}`);
	};
	link.addEventListener("click", () => {
		mode = mode === "off" ? "obtainable" : mode === "obtainable" ? "all" : "off";
		refresh();
		onChange(mode);
	});
	refresh();
	anchor.after(link);
	headerSwitch = link;
}

/**
 * Adds the tilt on/off button at the left end of the page's header, built like the other header links.
 *
 * @param {(on: boolean) => void} onChange Called after each click with the new state.
 * @param {boolean} on The starting state.
 */
function installTiltSwitch(onChange, on) {
	const anchor = document.querySelector("#challenger-signature") ?? document.querySelector(".challenger-header-link");
	const header = anchor?.closest(".challenger-header") ?? anchor?.parentElement;
	if(!header) { return; }
	const link = document.createElement("div");
	link.className = "challenger-header-link actionable";
	link.id = "awc-un-tilt-switch";
	link.style.cssText = "position: absolute; left: 60px; top: 50%; transform: translateY(-50%);";	//Out of the header's flow, so the page's own links keep all the room they had
	if(getComputedStyle(header).position === "static") {
		tiltHeader = {header, style: header.getAttribute("style")};
		header.style.position = "relative";
	}
	const icon = document.createElement("img");
	icon.width = 25;
	icon.height = 25;
	icon.src = TILT_ICON;
	icon.alt = "";
	icon.draggable = false;
	icon.style.marginRight = "0.4em";
	const label = document.createElement("span");
	label.className = "awc-un-label";	//Hidden on narrow screens, leaving just the icon
	label.style.whiteSpace = "nowrap";
	link.append(icon, label);
	const refresh = () => {
		label.textContent = on ? "Tilt: On" : "Tilt: Off";
		label.style.color = on ? "#ffffff" : "#8a8f98";
		icon.style.opacity = on ? "1" : "0.6";
		link.title = on ? "Turn off the 3D badge tilt" : "Turn on the 3D badge tilt";
		link.setAttribute("role", "button");
		link.setAttribute("aria-label", `${label.textContent}. ${link.title}`);
	};
	link.addEventListener("click", () => {
		on = !on;
		refresh();
		onChange(on);
	});
	refresh();
	header.prepend(link);
	tiltSwitch = link;
}

/* ---------------- OBSERVE PAGE ---------------- */
const NAVIGATED = new Error("Navigation changed during wait.");

/**
 * Waits until the page has finished showing its badges.
 *
 * The page loads them asynchronously, so this waits for the first ".badge-display" to appear and then
 * for the page to stop changing for a moment (but never longer than a few seconds). If none ever appears
 * (a challenger with no badges) it gives up after the timeout and carries on. It is abandoned if the user navigates away.
 *
 * @param {number} token The init() call this wait belongs to; used to detect navigation away.
 * @param {number} [timeout=10000] Maximum wait for the first badge list, in milliseconds.
 * @returns {Promise<void>}
 */
function waitForBadges(token, timeout = 10000) {
	const settle = 600;	//Quiet time that counts as "finished loading"
	const EMPTY_SETTLE = 2000;	//Quiet time that counts as "finished" when the page shows stats but no badges
	const maxSettle = 3000;	//Give up waiting for quiet this long after the first badge list appears
	return new Promise((resolve, reject) => {
		let settleTimer = 0;
		let maxTimer = 0;
		let done = false;
		const observer = new MutationObserver(check);
		const hardTimer = setTimeout(() => finish(resolve), timeout);

		function finish(callback, arg) {
			if(done) { return; }
			done = true;
			observer.disconnect();
			clearTimeout(settleTimer);
			clearTimeout(maxTimer);
			clearTimeout(hardTimer);
			callback(arg);
		}
		function check() {
			if(token !== currentInitToken) { finish(reject, NAVIGATED); return; }
			const hasBadges = Boolean(document.querySelector(".badge-display"));
			if(!hasBadges && !emptyProfile()) { return; }
			if(!maxTimer) { maxTimer = setTimeout(() => finish(resolve), maxSettle); }
			clearTimeout(settleTimer);
			settleTimer = setTimeout(() => finish(resolve), hasBadges ? settle : EMPTY_SETTLE);	//A profile with 0 points and no badge list may simply have none at all; give it longer before deciding
		}

		observer.observe(document.body, {childList: true, subtree: true});
		check();
	});
}

/* ---------------- MAIN ---------------- */
let currentInitToken = 0;	//Increment on new init calls to discard old async work
let currentUser = null;	//The challenger the script is currently set up for
let dbPromise = null;	//Memoised database load; see loadDB()
let preparedData = null;	//The database in display form (see prepareIndex()), built the first time the script is switched on
let mode = "off";	//The header button's current mode: "off", "obtainable" or "all"

/** @returns {boolean} Whether the current URL is a challenger page. */
function isChallengerPage() {
	return /^\/challenger\/[^/]+/.test(location.pathname);
}

/** Takes the script's changes and header button off the page. */
function teardown() {
	removeAll();
	removeDashboard();
	removeCollapseButtons();
	removeHeaderSwitch();
	currentUser = null;
}

/**
 * Entry point for every page load and route change.
 * Each call takes a token; if a newer call has begun by the time an await completes, the older one stops.
 */
async function init() {
	const token = ++currentInitToken;
	if(!isChallengerPage()) { teardown(); return; }

	const user = decodeURIComponent(location.pathname.split("/")[2]);
	if(currentUser === user) { return; }	//Already set up for this challenger
	teardown();

	try {
		await waitForBadges(token);
		if(token !== currentInitToken) { return; }
		currentUser = user;
		mode = settings.mode;
		tiltOn = settings.tilt;
		try { addCollapseButtons(readPage()); } catch (err) { console.warn("AWC Unowned Badges: Could not add the collapse buttons:", err); }	//On the page's own boxes whatever the Unowned mode is
		try { installScrollTop(); } catch (err) { console.warn("AWC Unowned Badges: Could not add the jump-to-start button:", err); }
		installTiltSwitch(on => {
			tiltOn = on;
			remember("tilt", on);
			refreshTilt();
		}, tiltOn);
		installSettingsMenu(key => onSettingChange(key, token));
		installHeaderSwitch(next => {
			mode = next;
			remember("mode", mode);
			applyMode(token);
		}, mode);
		await applyMode(token);
	} catch (err) {
		if(err !== NAVIGATED) { console.error("AWC Unowned Badges error:", err); }
	}
}

/**
 * Carries out a change made in the settings panel straight away, without a reload.
 *
 * @param {string} key The setting that changed.
 * @param {number} token The init() call the page belongs to.
 */
async function onSettingChange(key, token) {
	if(key === "refreshData") {	//Throws the cached database away and downloads it again
		try { localStorage.removeItem(CACHE_KEY); } catch { /* storage blocked: nothing cached to remove */ }
		dbPromise = null;
		preparedData = null;
		preparedData = prepareIndex(await loadDB());
		await applyMode(token);
	} else if(key === "showDashboard" || key === "dashboardClubs" || key === "dashboardWarn") {
		refreshDashboard(token);
	} else if(key === "unofficialOwner" || key === "unofficialMarks") {
		applyMode(token);
	} else if(key === "showSupporters") {
		applyMode(token);
	} else if(key === "showUnofficial") {
		preparedData = null;	//The unofficial badges are decided when the database is prepared
		applyMode(token);	//Rebuilds the unowned badges (if on) and the dashboard from the newly prepared database
	}
}

/**
 * On the saved username's own page, gives each unowned unofficial badge a button to mark it as owned (asking for a link to the AniList activity, which is not
 * checked). A marked badge links to that activity and has no button: marks are only removed together, by the settings panel's purge button.
 *
 * @param {HTMLElement} card A badge made by buildBadge().
 * @returns {HTMLElement} The same card.
 */
function decorateUnofficial(card, group, data) {
	if(group.target.title !== "Unofficial" || !onOwnPage()) { return card; }
	const id = data.badges[group.current].id;
	const marks = settings.unofficialMarks;
	const button = document.createElement("button");
	button.type = "button";
	button.className = "awc-un-mark";
	if(Object.hasOwn(marks, id)) {	//Marked: it links to the saved activity. Marks can only be removed all at once, with the settings panel's purge button
		card.querySelector("a").href = marks[id];
		return card;
	} else {
		button.textContent = "Mark as owned";
		button.title = "Mark this unofficial badge as owned; you will be asked for a link to your AniList activity";
		button.addEventListener("click", () => {
			const answer = window.prompt("Paste a link to your AniList activity for this badge (it is saved, not checked):", "");
			let link = (answer ?? "").trim();
			if(!link) { return; }
			if(!/^https?:\/\//i.test(link)) { link = `https://${link}`; }
			try { new URL(link); } catch { window.alert("That does not look like a link."); return; }
			marks[id] = link;
			saveSettings();
			marksChanged();
		});
	}
	card.appendChild(button);
	return card;
}

/** Rebuilds what depends on the marks (the cards, the dashboard, the settings panel's purge button) after one changed. */
function marksChanged() {
	settingsSync?.();
	applyMode(currentInitToken);
}

/**
 * Switches the script's changes on: loads the database if it has not been loaded yet (it is not fetched at all while the script stays off),
 * then adds the unowned badges. Does nothing if the switch was turned off or the page changed while the database was loading.
 *
 * @param {number} token The init() call this belongs to.
 */
async function enable(token) {
	try {
		preparedData ??= prepareIndex(await loadDB());
		if(token !== currentInitToken || mode === "off") { return; }
		applyAll(preparedData, mode === "all");
		refreshTilt();
	} catch (err) {
		console.error("AWC Unowned Badges error:", err);
	}
}

/** Makes the page match the current mode: the unowned badges on or off, and the dashboard counted for it. */
async function applyMode(token) {
	removeAll();
	if(mode !== "off") { await enable(token); } else { refreshTilt(); }
	await refreshDashboard(token);
}

/* ---------------- SPA NAVIGATION HANDLER ---------------- */
/** Re-runs init() after the route changes. */
function onRouteChange() {
	setTimeout(() => init(), 150);	//Brief delay gives the page time to begin mounting the next view
}

/**
 * Detects client-side navigation by wrapping history.pushState and history.replaceState, which fire no events of their own.
 * The popstate event covers back/forward. A window flag prevents double-wrapping if the script is somehow loaded twice.
 */
function installRouteHooks() {
	if(window.__AWC_UNOWNED_ROUTE_HOOKS__) { return; }
	window.__AWC_UNOWNED_ROUTE_HOOKS__ = true;
	const originalPushState = history.pushState;
	const originalReplaceState = history.replaceState;

	history.pushState = function(...args) {
		const result = originalPushState.apply(this, args);
		onRouteChange();
		return result;
	};
	history.replaceState = function(...args) {
		const result = originalReplaceState.apply(this, args);
		onRouteChange();
		return result;
	};
	window.addEventListener("popstate", onRouteChange);
}

// ---------------- INITIAL RUN ----------------
installRouteHooks();
init();

})();
