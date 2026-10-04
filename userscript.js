// ==UserScript==
// @name         AWC Character Page Badges
// @namespace    https://github.com/Eremeir
// @version      1.1.5
// @description  Display Anime Watch Club badges on AniList Character pages with caching, SPA support, and hover zoom
// @author       Eremeir
// @homepageURL  https://github.com/Eremeir/awcCharacterPageBadges
// @supportURL   https://github.com/Eremeir/awcCharacterPageBadges/issues
// @match        https://anilist.co/*
// @grant        GM_xmlhttpRequest
// @connect      eremeir.github.io
// @license      Unilicense
// ==/UserScript==

/**
 * AWC Character Page Badges
 *
 * Adds a "Featuring AWC Badges" section to AniList character pages, listing every
 * Anime Watch Club challenge badge that features the character being viewed.
 *
 * Overview of how it works:
 *   1. The badge database (badges.json, built from badges.jsonc by buildJSON.js) is
 *      fetched from GitHub Pages and cached in localStorage.
 *   2. The database is indexed by character ID for constant-time lookups.
 *   3. AniList is a single-page app, so history navigation is hooked and the
 *      script re-evaluates the page every time the route changes.
 *   4. Badges render beneath the page's ".character" element, with a
 *      animated/static toggle button on applicable badges and an optional 3D tilt effect on hover.
 */
(function () {
"use strict";

/* ---------------- CONFIG ---------------- */
const DB_URL = "https://eremeir.github.io/awcCharacterPageBadges/badges.json";
const CACHE_ENABLED = true;
const CACHE_KEY = "awc_badges_cache";	//localStorage key; stores { data, timestamp }
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; //7 Days, in milliseconds
const SHOW_UNOFFICIAL = false;	//Unofficial Community Badges
const ENABLE_3D_HOVER = true;	//Steam Trading Card style 3D

/* ---------------- FETCH DATABASE ---------------- */
/**
 * Adds a character-ID lookup table to the raw database.
 *
 * The database is organised by challenge (each lists its characters), but pages are
 * viewed per character, so this inverts it once up front instead of scanning every challenge on each page view.
 *
 * @param {{challenges: Array<{characters: number[]}>}} data Raw database.
 * @returns {object} Copy of the database with an added `byCharacter` map of
 *   character ID -> array of challenges featuring that character.
 */
function buildCharacterIndex(data) {
	const byCharacter = {};

	for(const challenge of data.challenges) {
		for(const characterID of challenge.characters) {
			if(!byCharacter[characterID]) {
				byCharacter[characterID] = [];
			}
			byCharacter[characterID].push(challenge);
		}
	}
	return {...data, byCharacter};
}
/**
 * Returns the (indexed) database, loading it at most once per page session.
 *
 * The promise is memoised so concurrent callers, such as several rapid SPA navigations, share a single in-flight request rather than each starting their own.
 *
 * @returns {Promise<object>} The database with its character index.
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
 * Loads the database using this order of preference:
 *   1. A localStorage cache younger than CACHE_TTL.
 *   2. A fresh fetch from DB_URL (which then refreshes the cache).
 *   3. An expired cache, if the fetch fails. Badges will be stale but present.
 * If none of these work, the error is rethrown.
 *
 * @returns {Promise<object>} The database with its character index.
 */
async function loadDBInternal() {
	let staleCache = null;
	let staleCacheTimestamp = null;

	if(CACHE_ENABLED) {	//Attempt to load from cache if enabled
		try {
			const cached = localStorage.getItem(CACHE_KEY);
			if(cached) {
				const parsed = JSON.parse(cached);
				staleCache = parsed.data;	//Keep the data even if it is expired, as a fallback for a failed fetch
				staleCacheTimestamp = parsed.timestamp;
				if(Date.now() - parsed.timestamp < CACHE_TTL) { return buildCharacterIndex(parsed.data); }
			}
		} catch {}	//Corrupt or unavailable storage is treated as a cache miss
	}
	try {
		const data = await new Promise((resolve, reject) => {	//Fetch fresh JSON from GitHub
			GM_xmlhttpRequest({	//GM_xmlhttpRequest is used rather than fetch() so the request is not blocked by AniList's CORS/CSP rules
				method: "GET",
				url: DB_URL,
				onload: res => {
					try {
						const parsed = JSON.parse(res.responseText);
						if(CACHE_ENABLED) {	//Store in cache if enabled
							localStorage.setItem(CACHE_KEY, JSON.stringify({
								data: parsed,
								timestamp: Date.now()
							}));
						}
						resolve(parsed);
					} catch (e) { reject(e); }
				},
				onerror: reject
			});
		});
		return buildCharacterIndex(data);
	} catch(err) {
		if(staleCache) {
			const cacheAge = Math.round((Date.now() - staleCacheTimestamp) / (24 * 60 * 60 * 1000));
			console.warn(`AWC Character Page Badges: Failed to fetch fresh database. Using ${cacheAge}-day-old cached data.`);
			return buildCharacterIndex(staleCache);
		}
		throw err;
	}
}

/* ---------------- GET CHARACTER ID FROM URL ---------------- */
/**
 * Reads the character ID from the current URL.
 * Character URLs look like /character/12345/Name, so splitting on "/" gives ["", "character", "12345", "Name"] and the ID sits at index 2.
 *
 * @returns {number} The ID, or NaN if the path has no numeric ID segment.
 */
function getCharacterID() {
	const parts = location.pathname.split("/");
	return Number(parts[2]);
}

/* ---------------- RECONSTRUCT FALLBACK URL ---------------- */
/**
 * Rebuilds the pre-AVIF URL of an animated badge.
 *
 * buildJSON.js rewrites CDN .png/.gif animated badges to .avif and records the original extension in `animatedOriginalExtension`.
 * If a browser cannot load the AVIF, this reverses that rewrite so the original file can be used instead.
 *
 * @param {{animated?: string, animatedOriginalExtension?: string}} challenge
 * @returns {string|undefined} The original URL; the unchanged `animated` value if it
 *   was never converted to AVIF.
 */
function getOriginalAnimatedURL(challenge) {
	if(!challenge.animated?.endsWith(".avif")) { return challenge.animated; }

	const extension = challenge.animatedOriginalExtension ?? ".png";	//Only GIFs get an explicit extension recorded, so assume PNG when none is stored
	return challenge.animated.replace(/\.avif$/i, extension);
}

/* ---------------- ROUTE HELPERS ---------------- */
/**
 * Whether the current URL is a character page.
 * The script is matched against all of anilist.co, so this check decides whether to do anything.
 *
 * @returns {boolean}
 */
function isCharacterPage() {	//Script loads site-wide, but only renders on real character pages
	return /^\/character\/\d+/.test(location.pathname);
}

/** Removes the badge section, if present. */
function removeBadges() {	//Remove old badges before rerendering after SPA navigation
	const elem = document.querySelector(".awc-badge-container");
	if(elem) { elem.remove(); }
}

/* ---------------- OBSERVE CHARACTER DIV ---------------- */
/**
 * Waits until the page's ".character" element exists in the DOM.
 *
 * After an SPA navigation the new page is mounted asynchronously, so the element may not exist yet.
 * A MutationObserver resolves as soon as it appears. The wait is abandoned if the user navigates to a different character or the timeout elapses.
 *
 * @param {number} characterID The character this wait is for; used to detect navigation away.
 * @param {number} [timeout=10000] Maximum wait in milliseconds.
 * @returns {Promise<Element>} The connected ".character" element.
 * @throws {Error} On timeout, or if the page changed to another character while waiting.
 */
function waitForCharacter(characterID, timeout = 10000) {	//Watch the DOM for page changes
	return new Promise((resolve, reject) => {
		const existing = document.querySelector(".character");
		if(existing?.isConnected) {
			resolve(existing);
			return;
		}

		const observer = new MutationObserver(() => {
			if(getCharacterID() !== characterID) {	//The user moved to another character before this one finished mounting
				clearTimeout(timer);
				observer.disconnect();
				reject(new Error("Navigation changed during wait."));
				return;
			}

			const elem = document.querySelector(".character");
			if(elem?.isConnected) {	//Require a live connected character div
				clearTimeout(timer);
				observer.disconnect();
				resolve(elem);
			}
		});

		observer.observe(document.body, {	//Watch the whole body since Vue may replace large parts of the tree on navigation
			childList: true,
			subtree: true
		});

		const timer = setTimeout(() => {
			observer.disconnect();
			reject(new Error("Timed out waiting for character div"));
		}, timeout);
	});
}

/* ---------------- INJECT STYLES ---------------- */
/**
 * Injects the script's stylesheet into the page (once).
 * Covers every style the script needs: the basic hover zoom, the animated/static toggle button, and the 3D hover effect.
 * The 3D rules are always injected but only take effect when enable3DHover adds their classes.
 */
function injectStyles() {
	if(document.querySelector("#badge-elem-styles")) return;	//Avoid duplicate injection

	const style = document.createElement("style");
	style.id = "badge-elem-styles";
	style.textContent = `
		.awc-badge-wrapper img {
			display: block;
			transition: transform 0.2s ease;
			transform-origin: bottom center;
			cursor: pointer;
		}
		.awc-badge-wrapper img:hover {
			transform: scale(1.08);
		}
		.awc-badge-toggle {
			font-size: 10px;
			font-weight: 600;
			letter-spacing: 0.5px;
			text-transform: uppercase;
			padding: 3px 10px;
			border-radius: 20px;
			border: 1px solid rgba(61, 180, 242, 0.5);
			background: rgba(61, 180, 242, 0.15);
			color: #3db4f2;
			cursor: pointer;
			opacity: 0.85;
			transition: background 0.2s ease, opacity 0.2s ease, transform 0.2s ease;
		}
		.awc-badge-toggle:hover {
			background: rgba(61, 180, 242, 0.3);
			opacity: 1;
		}
		/* Glint: a light streak sweeps across the toggle while the static version is shown */
		@keyframes awc-glint {
			0% { left: -60%; }
			60%, 100% { left: 140%; }
		}
		.awc-badge-toggle.awc-glint {
			position: relative;
			overflow: hidden;
		}
		.awc-badge-toggle.awc-glint::after {
			content: '';
			position: absolute;
			top: -10%;
			left: -60%;
			width: 40%;
			height: 120%;
			background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.45), transparent);
			transform: skewX(-15deg);
			animation: awc-glint 2.5s ease-in-out infinite;
		}
		/* ---------------- 3D HOVER EFFECT ---------------- */
		.awc-badge-3d-wrapper {
			perspective: 1000px;
			position: relative;
			z-index: 0;
		}
		/* Raise the hovered badge so its enlarged image overlaps its neighbours */
		.awc-badge-wrapper.awc-hovering {
			z-index: 1000;
		}
		/* Hide the toggle while hovering so it does not clash with the enlarged badge */
		.awc-badge-wrapper.awc-hovering .awc-badge-toggle {
			opacity: 0;
			transform: translateY(-8px);
			pointer-events: none;
		}
		.awc-badge-3d-link {
			position: relative;
			display: block;
			transform-style: preserve-3d;
		}
		/* !important overrides the basic zoom's transform-origin on the same image */
		.awc-badge-3d {
			transform-origin: center center !important;
			transform-style: preserve-3d;
			transition:
				transform 0.08s ease-out,
				filter 0.08s ease-out,
			will-change: transform;
		}
	`;
	document.head.appendChild(style);
}

/* ---------------- 3D BADGE HOVER ---------------- */
/**
 * Makes a badge tilt toward the cursor, like a Steam trading card.
 *
 * The cursor's position inside the badge is normalised to -1..1 on each axis and
 * mapped to rotation (up to 15deg) plus an opposing drop shadow, giving the
 * impression of a light source. Does nothing if ENABLE_3D_HOVER is false.
 *
 * @param {HTMLElement} wrapper Outer badge element; raised above neighbours while hovered.
 * @param {HTMLAnchorElement} link Link around the image; its bounds are the hover area.
 * @param {HTMLImageElement} img The badge image that gets transformed.
 */
function enable3DHover(wrapper, link, img) {
	if(!ENABLE_3D_HOVER) { return; }

	wrapper.classList.add("awc-badge-3d-wrapper");
	link.classList.add("awc-badge-3d-link");
	img.classList.add("awc-badge-3d");

	link.addEventListener("mouseenter", () => {
		wrapper.classList.add("awc-hovering");
	});

	link.addEventListener("mousemove", event => {	//Tilt and shade with mousemoves
		const rect = link.getBoundingClientRect();
		//Cursor position relative to the badge's top-left corner
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;

		//Normalise to -1 (left/top edge) .. 0 (centre) .. 1 (right/bottom edge)
		const percentX = (x / rect.width) * 2 - 1;
		const percentY = (y / rect.height) * 2 - 1;

		//Sine easing makes the tilt gentler near the centre. The X rotation is negated so the top edge tilts away from the cursor on hover.
		const rotateY = Math.sin(percentX * Math.PI / 2) * 15;
		const rotateX = -Math.sin(percentY * Math.PI / 2) * 15;

		//Shadow falls opposite the cursor, as if lit from where the cursor is
		const shadowX = -percentX * 10;
		const shadowY = -percentY * 10;

		img.style.transform = `
			translateZ(20px)
			scale(1.24)
			rotateX(${rotateX}deg)
			rotateY(${rotateY}deg)
		`;
		img.style.filter =`drop-shadow(${shadowX}px ${shadowY}px 24px rgba(0,0,0,0.35))`;
	});

	link.addEventListener("mouseleave", () => {	//Reset
		wrapper.classList.remove("awc-hovering");
		img.style.transform = "";
		img.style.filter = "";
	});
}

/* ---------------- RENDER BADGES ---------------- */
/**
 * Builds and inserts the "Featuring AWC Badges" section for a character.
 * Does nothing if the section already exists or the character has no badges to show.
 *
 * Each badge is a linked image pointing at its challenge's forum thread. Badges that
 * have both animated and static images also get a button to switch between them.
 *
 * @param {object} data Indexed database from loadDB().
 * @param {number} characterID The character being viewed.
 * @param {Element} characterDiv The page's ".character" element; the section is inserted after it.
 */
function renderBadges(data, characterID, characterDiv) {
	if(document.querySelector(".awc-badge-container")) return;	//Avoid duplicate injection
	const matches = (data.byCharacter[characterID] || []).filter(char => SHOW_UNOFFICIAL || !char.unofficial);	//Get challenges for this character
	if(!matches.length) { return; }

	const container = document.createElement("div");	//Create container div
	container.style.maxWidth = "1300px";	//Match page layout
	container.style.margin = "0 auto";	//Center horizontally
	container.className = "awc-badge-container";

	const title = document.createElement("h2");	//Create header
	title.textContent = "Featuring AWC Badges";
	title.style.margin = "25px 0";
	container.appendChild(title);

	const holder = document.createElement("div");	//Create badge holder flex container
	holder.style.display = "flex";
	holder.style.flexWrap = "wrap";
	holder.style.gap = "10px";
	container.appendChild(holder);

	characterDiv.insertAdjacentElement("afterend", container);	//Insert container after character div

	injectStyles();	//Inject style effects

	matches.forEach(challenge => {	//Add each badge in DB order
		const wrapper = document.createElement("div");	//Wrapper stacks the badge image above its (optional) toggle button
		wrapper.style.display = "flex";
		wrapper.style.flexDirection = "column";
		wrapper.style.alignItems = "center";
		wrapper.style.gap = "4px";
		wrapper.className = "awc-badge-wrapper";

		const link = document.createElement("a");
		link.href = `https://anilist.co/forum/thread/${challenge.thread}`;
		link.target = "_blank";
		link.rel = "noopener noreferrer";	//Isolate tabs

		const img = document.createElement("img");
		img.loading = "lazy";
		img.decoding = "async";
		img.src = challenge.animated ?? challenge.image;	// Default to animated if available
		img.title = challenge.name;

		//Browsers without AVIF support (or a missing .avif file) fail to load the animated badge.
		//Retry once with the original PNG/GIF; if that also fails, give up and log it.
		let usingAnimatedFallback = false;
		img.onerror = () => {
			if(!usingAnimatedFallback && challenge.animated?.endsWith(".avif")) {
				usingAnimatedFallback = true;
				console.warn(
					`AWC Character Page Badges: Failed to load AVIF for "${challenge.name}". ` +
					`Falling back to original animated image.`
				);

				img.src = getOriginalAnimatedURL(challenge);
				return;
			}
			console.warn(`AWC Character Page Badges: Failed to load image for "${challenge.name}".`);
			img.onerror = null;	//Stop handling errors so a broken fallback cannot loop
		};
		img.style.borderRadius = "6px";
		img.style.maxHeight = "250px";
		img.style.maxWidth = "250px";
		if(challenge.unofficial) { img.style.outline = "2px dashed #888"; }	//Add unofficial badge border

		//Badges come in different shapes, so the size is set once the image's real dimensions are known.
		//Everything is scaled to fit within a 250x250 box.
		img.onload = () => {	//Resize after image loads based on natural dimensions
			const w = img.naturalWidth;
			const h = img.naturalHeight;

			if(w === 720 && h === 720) {	//Standard size badges
				img.width = 250;
				img.height = 250;
			} else if(w === 520 && h === 720) {	//Legacy badges
				img.width = 181;
				img.height = 250;
			} else {	//Scale proportionally for other dimensions
				const maxWidth = 250;
				const maxHeight = 250;
				const aspect = w / h;
				if(aspect >= 1) {	//Landscape or square: width is the limiting side
					img.width = Math.min(w, maxWidth);
					img.height = Math.min(img.width / aspect, maxHeight);
				} else {	//Portrait: height is the limiting side
					img.height = Math.min(h, maxHeight);
					img.width = Math.min(img.height * aspect, maxWidth);
				}
			}
		};

		link.appendChild(img);
		wrapper.appendChild(link);
		enable3DHover(wrapper, link, img);
		if(challenge.animated && challenge.image) {	//Only badges with both versions need a toggle
			let isAnimated = true;	//The badge defaults to showing the animated version
			const toggle = document.createElement("button");

			toggle.textContent = "Show Static Version";	// Label for version to switch to
			toggle.className = "awc-badge-toggle";
			toggle.addEventListener("click", () => {
				isAnimated = !isAnimated;
				if(isAnimated) {
					//Respect an earlier AVIF failure so switching back does not retry a broken URL
					img.src = usingAnimatedFallback ? getOriginalAnimatedURL(challenge) : challenge.animated;
				} else { img.src = challenge.image; }
				toggle.textContent = isAnimated ? "Show Static Version" : "Show Animated Version";
				toggle.classList.toggle("awc-glint", !isAnimated);	//Glint draws attention to the way back to animated
			});
			wrapper.appendChild(toggle);
		}

		holder.appendChild(wrapper);
	});
}

/* ---------------- MAIN ---------------- */
let lastRenderedCharacterID = null;	//Character whose badges are currently displayed
let currentInitToken = 0;	//Increment on new init calls to discard old async loaded elements
let scriptLogged = false;	//Ensures the startup info message is only printed once
let dbPromise = null;	//Memoised database load; see loadDB()

/**
 * Entry point for every page load and route change.
 *
 * Clears badges when off a character page, otherwise loads the database, waits for the
 * page to mount, and renders badges. Each call takes a token; if a newer call has begun
 * by the time an await completes, the older one stops, so a slow load for a previous
 * character can never render over the current one.
 */
async function init() {
	const token = ++currentInitToken;
	if(!isCharacterPage()) {	//Clear badges when leaving character pages
		removeBadges();
		lastRenderedCharacterID = null;
		return;
	}

	const characterID = getCharacterID();
	if(!characterID) { return; }

	if(lastRenderedCharacterID === characterID && document.querySelector(".awc-badge-container")) { return; }	//Avoid rerendering same character

	try {
		removeBadges();

		const db = await loadDB();
		if(token !== currentInitToken) { return; }	//Superseded while the database loaded
		if(!scriptLogged) {
			console.info(`AWC Character Page Badges: ${db.challenges.length} badges loaded in database. Cache is ${CACHE_ENABLED ? "enabled." : "disabled."} Unofficial Badges are ${SHOW_UNOFFICIAL ? "enabled." : "disabled."} 3D Hover is ${ENABLE_3D_HOVER ? "enabled." : "disabled."}`);
			scriptLogged = true;
		}

		const characterDiv = await waitForCharacter(characterID);
		if(token !== currentInitToken) { return; }	//Superseded while waiting for the page to mount
		renderBadges(db, characterID, characterDiv);
		lastRenderedCharacterID = characterID;
	} catch (err) { console.error("AWC Badge script error:", err); }
}

/* ---------------- SPA NAVIGATION HANDLER ---------------- */
/** Re-runs init() after the route changes. */
function onRouteChange() {	//AniList uses Vue routing, so navigation usually does not refresh the page
	setTimeout(() => init(), 150);	//Brief delay gives Vue time to begin mounting the next page
}

/**
 * Detects SPA navigation by wrapping history.pushState and history.replaceState.
 *
 * Neither method fires an event when called, so they are wrapped to call onRouteChange() after doing their normal work.
 * The popstate event covers the browser back/forward buttons.
 * A window flag prevents double-wrapping if the script is somehow loaded twice.
 */
function installRouteHooks() {	//Hook history navigation so clicking links and back/forward rerenders badges
	if(window.__AWC_BADGES_ROUTE_HOOKS__) { return; }
	window.__AWC_BADGES_ROUTE_HOOKS__ = true;
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
