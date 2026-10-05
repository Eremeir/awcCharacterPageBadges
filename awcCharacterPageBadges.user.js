// ==UserScript==
// @name         AWC Character Page Badges
// @namespace    https://github.com/Eremeir
// @version      1.1.6
// @description  Display Anime Watch Club badges on AniList Character pages with caching, SPA support, and hover effects
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
 *      fetched from GitHub Pages, cached in localStorage, and refreshed in the background (via its ETag) once the cache expires.
 *   2. The database is indexed by character ID for constant-time lookups.
 *   3. AniList is a single-page app, so history navigation is hooked and the
 *      script re-evaluates the page every time the route changes.
 *   4. Badges render beneath the page's ".character" element, with an animated/static toggle button on applicable badges
 *      and an optional 3D tilt effect with slight simulated lighting on hover.
 */
(function () {
"use strict";

/* ---------------- CONFIG ---------------- */
const DB_URL = "https://eremeir.github.io/awcCharacterPageBadges/badges.json";
const CACHE_ENABLED = true;
const CACHE_KEY = "awc_badges_cache";	//localStorage key; stores { etag, timestamp, data }.
const CACHE_TTL = 24 * 60 * 60 * 1000; //1 Day, in milliseconds. Once expired, the cache is used one last time while a background refresh checks for changes.
const SHOW_UNOFFICIAL = false;	//Unofficial Community Badges
const ENABLE_3D_HOVER = true;	//Steam Trading Card style 3D tilt and lighting

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
 * Pulls the ETag out of GM_xmlhttpRequest's raw response header string.
 *
 * @param {string} [headers] Raw headers: one "Name: value" per CRLF-separated line.
 * @returns {string|null} The ETag exactly as sent (quotes and any W/ prefix included), or null if there is none.
 */
function parseETag(headers) {
	const match = /^etag:\s*(.+)$/im.exec(headers || "");
	return match ? match[1].trim() : null;
}
/**
 * Reads the cached database record from localStorage.
 *
 * @returns {{etag?: string|null, timestamp: number, data: object}|null} The record, or null if caching is off,
 *   nothing is stored, storage is unreadable, or the stored value does not look like a database.
 *   Records saved before ETags were tracked have no `etag` and are still valid.
 */
function readCache() {
	if(!CACHE_ENABLED) { return null; }
	try {
		const record = JSON.parse(localStorage.getItem(CACHE_KEY));
		if(typeof record?.timestamp !== "number" || !Array.isArray(record.data?.challenges)) { return null; }
		return record;
	} catch { return null; }	//Corrupt or unavailable storage is treated as a cache miss
}
/**
 * Stores a database record in localStorage.
 * Failures (quota exceeded, storage blocked) are ignored: the cache is only an optimisation,
 * so a failed write must never fail a load that otherwise succeeded.
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
 * Downloads badges.json. When the ETag of an earlier response is supplied it is sent as If-None-Match,
 * so an unchanged file comes back as a tiny 304 instead of a full download.
 *
 * @param {string|null} [etag] ETag of the cached copy, if any.
 * @returns {Promise<{notModified: true}|{data: object, etag: string|null}>}
 *   Rejects with an Error on a network failure, timeout, unexpected status, malformed JSON,
 *   or a file without a `challenges` array.
 */
function fetchDB(etag) {
	return new Promise((resolve, reject) => {
		GM_xmlhttpRequest({	//GM_xmlhttpRequest is used rather than fetch() so the request is not blocked by AniList's CORS/CSP rules
			method: "GET",
			url: DB_URL,
			headers: etag ? {"If-None-Match": etag} : {},
			timeout: 15000,
			onload: res => {
				if(res.status === 304) { resolve({notModified: true}); return; }
				if(res.status !== 200) { reject(new Error(`HTTP ${res.status}`)); return; }
				try {
					const data = JSON.parse(res.responseText);
					if(!Array.isArray(data?.challenges)) { throw new Error("Unexpected data format"); }
					resolve({data, etag: parseETag(res.responseHeaders)});
				} catch (e) { reject(e); }
			},
			onerror: () => reject(new Error("Network error")),
			ontimeout: () => reject(new Error("Request timed out"))
		});
	});
}
/**
 * Revalidates an expired cache in the background; the caller has already rendered from it.
 *
 * If the file is unchanged only the TTL clock restarts. New data replaces the cache and is also swapped into
 * dbPromise, so later navigations in the same session use it without a reload. Any failure leaves the old cache
 * alone, so the next page load simply tries again.
 *
 * @param {{etag?: string|null, timestamp: number, data: object}} cached The expired record.
 */
function refreshCache(cached) {
	fetchDB(cached.etag).then(result => {
		//A 304 means unchanged. A userscript manager that hides the 304 and returns the file again still sends the same ETag back.
		if(result.notModified || (result.etag && result.etag === cached.etag)) {
			writeCache({...cached, timestamp: Date.now()});	//Just restart the TTL clock
			console.info("AWC Character Page Badges: Database is up to date.");
			return;
		}
		const indexed = buildCharacterIndex(result.data);	//Throws on a malformed file, which leaves the old cache untouched
		writeCache({etag: result.etag, timestamp: Date.now(), data: result.data});
		dbPromise = Promise.resolve(indexed);
		console.info("AWC Character Page Badges: Database refreshed in the background.");
	}).catch(err => {
		const hours = Math.round((Date.now() - cached.timestamp) / (60 * 60 * 1000));
		console.warn(`AWC Character Page Badges: Could not refresh the database (${err.message}). Using cached data from ${hours} hours ago.`);
	});
}
/**
 * Loads the database using this order of preference:
 *   1. A cache younger than CACHE_TTL, used as is with no network request.
 *   2. An expired cache, used immediately while a background request revalidates it (see refreshCache()).
 *   3. If nothing usable is cached, a blocking fetch from DB_URL, which then fills the cache.
 * If that blocking fetch fails, the error is rethrown.
 *
 * @returns {Promise<object>} The database with its character index.
 */
async function loadDBInternal() {
	const cached = readCache();
	if(cached) {
		try {
			const indexed = buildCharacterIndex(cached.data);
			if(Date.now() - cached.timestamp >= CACHE_TTL) { refreshCache(cached); }	//Expired: serve it now, revalidate for next time
			return indexed;
		} catch (err) { console.warn("AWC Character Page Badges: Cached database is unusable, fetching a fresh copy.", err); }
	}

	const {data, etag} = await fetchDB();
	const indexed = buildCharacterIndex(data);	//Index first so a malformed file throws before it is cached
	writeCache({etag, timestamp: Date.now(), data});
	return indexed;
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
 * Covers every style the script needs: the basic hover zoom, the animated/static toggle button, and the 3D hover effect with its lighting layers.
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
		.awc-badge-3d-wrapper {	/* The wrapper supplies the perspective and is raised above its neighbours while hovered */
			perspective: 1000px;
			position: relative;
			z-index: 0;
		}
		.awc-badge-wrapper.awc-hovering {
			z-index: 1000;
		}
		.awc-badge-wrapper.awc-hovering .awc-badge-toggle {	/* Hide the toggle while hovering so it does not clash with the enlarged badge */
			opacity: 0;
			transform: translateY(-8px);
			pointer-events: none;
		}
		.awc-badge-3d-link {
			position: relative;
			display: block;
			transform-style: preserve-3d;
		}
		.awc-badge-3d-card {	/* The card is what tilts: the image and both lighting layers move together as one surface */
			position: relative;
			transform-style: preserve-3d;
			isolation: isolate;	/* Blend modes only see the badge, not the page behind it */
			transition:	/* Slower settle on leave */
				transform 0.3s ease-out,
				filter 0.3s ease-out;
		}
		.awc-badge-wrapper.awc-hovering .awc-badge-3d-card {	/* --rx/--ry (tilt) and --sx/--sy (shadow offset) are set from JS on every mousemove */
			will-change: transform;
			transform:
				translateZ(20px)
				scale(1.24)
				rotateX(var(--rx, 0deg))
				rotateY(var(--ry, 0deg));
			filter:
				drop-shadow(var(--sx, 0px) var(--sy, 0px) 24px rgba(0,0,0,0.35));
			transition:	/* snappy while tracking */
				transform 0.08s ease-out,
				filter 0.08s ease-out;
		}
		.awc-badge-3d-card img {	/* The card moves now, so the plain image zoom must not also apply */
			transform: none !important;
		}
		/*
		 * Lighting layers. Each is a copy of the current badge image (--badge-url, set by JS while hovered)
		 * recoloured to a solid silhouette, so light only ever appears on the badge's own pixels.
		 */
		.awc-badge-light, .awc-badge-shade {
			position: absolute;
			inset: 0;
			border-radius: 6px;
			pointer-events: none;
			opacity: 0;
			transition: opacity 0.15s ease-out;
			background: var(--badge-url) center / 100% 100% no-repeat;
			mask-repeat: no-repeat;
			mask-size: 100% 100%;
		}
		.awc-badge-light {	/* Highlight: white silhouette, soft-light blended, revealed by a very wide soft glow at --gx/--gy. Strength comes from --li */
			filter: brightness(0) invert(1);
			mix-blend-mode: soft-light;
			mask-image: radial-gradient(circle at var(--gx, 50%) var(--gy, 50%),
				rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.5) 30%, rgba(0,0,0,0.15) 65%, transparent 100%);
		}
		.awc-badge-shade {	/* Shading: black silhouette, multiplied, applied uniformly when tilted away from the light. Strength comes from --si */
			filter: brightness(0);
			mix-blend-mode: multiply;
		}
		.awc-badge-wrapper.awc-hovering .awc-badge-light {	/* Layers only show while hovered; their opacity is driven from JS */
			opacity: var(--li, 0);
		}
		.awc-badge-wrapper.awc-hovering .awc-badge-shade {
			opacity: var(--si, 0);
		}
	`;
	document.head.appendChild(style);
}

/* ---------------- 3D BADGE HOVER ---------------- */
/**
 * Makes a badge tilt under the cursor and catch the light, like a Steam trading card.
 *
 * The cursor's position inside the badge is normalised to -1..1 on each axis and mapped to a tilt (up to 15deg, pressing in the side under the cursor)
 * plus an opposing drop shadow. That tilt also drives the lighting from a fixed virtual light above the badge: a soft highlight whose strength and
 * position follow the surface angle, and a faint shading when the badge leans away from the light.
 *
 * The image is moved into a "card" element alongside two overlay layers (light and shade) so all three tilt together. The overlays are silhouette copies
 * of the badge image, so light never spills onto transparent areas. Does nothing if ENABLE_3D_HOVER is false.
 *
 * @param {HTMLElement} wrapper Outer badge element; raised above neighbours while hovered.
 * @param {HTMLAnchorElement} link Link around the image; its bounds are the hover area.
 * @param {HTMLImageElement} img The badge image; moved into the card, which is what gets transformed.
 */
function enable3DHover(wrapper, link, img) {
	if(!ENABLE_3D_HOVER) { return; }
	if(!matchMedia("(hover: hover) and (pointer: fine)").matches || matchMedia("(prefers-reduced-motion: reduce)").matches) { return; }

	wrapper.classList.add("awc-badge-3d-wrapper");
	link.classList.add("awc-badge-3d-link");

	//Card wraps the image and light layers so they tilt as one surface
	const card = document.createElement("div");
	card.className = "awc-badge-3d-card";
	const light = document.createElement("div");
	light.className = "awc-badge-light";
	const shade = document.createElement("div");
	shade.className = "awc-badge-shade";
	link.appendChild(card);
	card.append(img, light, shade);		//Moves the img from the link into the card

	//The light and shade layers only hold a copy of the badge image while hovered, so idle badges don't carry
	//extra decoded (and, for animated badges, extra animating) copies of their image.
	let active = false;	//True while the pointer is over the badge
	let releaseTimer = 0;	//Delays dropping the images after mouseleave so the fade-out can finish
	function syncSilhouette() {
		const src = (img.currentSrc || img.src).replace(/"/g, "%22");
		card.style.setProperty("--badge-url", `url("${src}")`);
	}
	img.addEventListener("load", () => { if(active) { syncSilhouette(); } });	//Covers an AVIF fallback or src change mid-hover

	//Virtual light. The viewer looks straight on, along (0, 0, 1); negative y is up.
	const norm = v => { const l = Math.hypot(...v); return v.map(c => c / l); };

	//Direction toward the light: centered horizontally, slightly above, mostly frontal
	const L = norm([0, -0.3, 0.95]);

	//Half-vector: the surface normal that reflects the light at the viewer. Its y of about -0.15 puts the glint peak just above the neutral pose
	const H = norm([L[0], L[1], L[2] + 1]);

	const DEG = Math.PI / 180;
	const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

	let frame = 0, lastEvent = null;
	function update() {	//Runs at most once per frame
		frame = 0;
		const rect = link.getBoundingClientRect();
		const x = lastEvent.clientX - rect.left;
		const y = lastEvent.clientY - rect.top;

		//Normalise to -1 (left/top edge) .. 0 (centre) .. 1 (right/bottom edge)
		const percentX = (x / rect.width) * 2 - 1;
		const percentY = (y / rect.height) * 2 - 1;

		//Sine easing makes the tilt gentler near the centre. The X rotation is negated so the side under the cursor is pressed away from the viewer.
		const rotateY = Math.sin(percentX * Math.PI / 2) * 15;
		const rotateX = -Math.sin(percentY * Math.PI / 2) * 15;

		//Surface normal's x/y components: the face leans toward the cursor side
		const nx = Math.sin(rotateY * DEG);
		const ny = -Math.sin(rotateX * DEG);

		//Specular strength: peaks when the normal matches H and falls off with tilt in any direction, so left and right behave the same.
		// The 0.15 floor keeps some light on the face at any angle.
		const d2 = (nx - H[0]) ** 2 + (ny - H[1]) ** 2;
		const spec = 0.15 + 0.85 * Math.exp(-d2 / (2 * 0.22 * 0.22));

		//Glint position on the face: moves opposite to the tilt, clamped so it cannot leave the badge
		const gx = clamp(50 + (H[0] - nx) * 120, 0, 100);
		const gy = clamp(50 + (H[1] - ny) * 120, 0, 100);

		//Diffuse: only vertical lean matters because the light is centered horizontally.
		//Leaning up toward the light (cursor near the top) brightens; leaning down away from it (cursor near the bottom) darkens a little.
		const delta = ny * L[1];
		const lightAmount = clamp(0.17 + spec * 0.7 + Math.max(delta, 0) * 1.5, 0, 1);
		const shadeAmount = clamp(Math.max(-delta, 0) * 0.8, 0, 0.15);

		const s = card.style;
		s.setProperty("--rx", `${rotateX}deg`);
		s.setProperty("--ry", `${rotateY}deg`);
		s.setProperty("--sx", `${-percentX * 10}px`);	//Shadow falls opposite the cursor, as if lit from where the cursor is
		s.setProperty("--sy", `${-percentY * 10}px`);
		s.setProperty("--gx", `${gx}%`);
		s.setProperty("--gy", `${gy}%`);
		s.setProperty("--li", lightAmount.toFixed(3));
		s.setProperty("--si", shadeAmount.toFixed(3));
	}

	link.addEventListener("mouseenter", event => {
		active = true;
		clearTimeout(releaseTimer);
		if(img.complete && img.naturalWidth) { syncSilhouette(); }	//If it is still loading, the load listener does it
		wrapper.classList.add("awc-hovering");
		lastEvent = event;
		if(!frame) { frame = requestAnimationFrame(update); }	//Apply the lighting immediately rather than waiting for the first mousemove
	});
	link.addEventListener("mousemove", event => {
		lastEvent = event;
		if(!frame) { frame = requestAnimationFrame(update); }
	});
	link.addEventListener("mouseleave", () => {
		active = false;
		wrapper.classList.remove("awc-hovering");	//CSS transitions handle the settle back to flat
		releaseTimer = setTimeout(() => card.style.removeProperty("--badge-url"), 400);
		if(frame) { cancelAnimationFrame(frame); frame = 0; }
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
		img.alt = challenge.name;
		img.width = 250;
		img.height = 250;

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
