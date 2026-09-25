// ==UserScript==
// @name         AWC Character Page Badges
// @namespace    https://github.com/Eremeir
// @version      1.1.2
// @description  Display Anime Watch Club badges on AniList Character pages with caching, SPA support, and hover zoom
// @author       Eremeir
// @homepageURL  https://github.com/Eremeir/awcCharacterPageBadges
// @supportURL   https://github.com/Eremeir/awcCharacterPageBadges/issues
// @match        https://anilist.co/*
// @grant        GM_xmlhttpRequest
// @connect      eremeir.github.io
// @license      Unilicense
// ==/UserScript==

(function () {
"use strict";

/* ---------------- CONFIG ---------------- */
const DB_URL = "https://eremeir.github.io/awcCharacterPageBadges/badges.json";
const CACHE_ENABLED = true;
const CACHE_KEY = "awc_badges_cache";
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; //7 Days
const SHOW_UNOFFICIAL = false;	//Unofficial Community Badges

/* ---------------- FETCH DATABASE ---------------- */
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
function loadDB() {
	if(!dbPromise) {
		dbPromise = loadDBInternal().catch(err => {
			dbPromise = null;	//Retry on failure
			throw err;
		});
	}
	return dbPromise;
}
async function loadDBInternal() {
	let staleCache = null;
	let staleCacheTimestamp = null;

	if(CACHE_ENABLED) {	//Attempt to load from cache if enabled
		try {
			const cached = localStorage.getItem(CACHE_KEY);
			if(cached) {
				const parsed = JSON.parse(cached);
				staleCache = parsed.data;
				staleCacheTimestamp = parsed.timestamp;
				if(Date.now() - parsed.timestamp < CACHE_TTL) { return buildCharacterIndex(parsed.data); }
			}
		} catch {}
	}
	try {
		const data = await new Promise((resolve, reject) => {	//Fetch fresh JSON from GitHub
			GM_xmlhttpRequest({
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
function getCharacterID() {
	const parts = location.pathname.split("/");
	return Number(parts[2]);
}

/* ---------------- ROUTE HELPERS ---------------- */
function isCharacterPage() {	//Script loads site-wide, but only renders on real character pages
	return /^\/character\/\d+/.test(location.pathname);
}

function removeBadges() {	//Remove old badges before rerendering after SPA navigation
	const elem = document.querySelector(".awc-badge-container");
	if(elem) { elem.remove(); }
}

/* ---------------- OBSERVE CHARACTER DIV ---------------- */
function waitForCharacter(characterID, timeout = 10000) {	//Watch the DOM for page changes
	return new Promise((resolve, reject) => {
		const existing = document.querySelector(".character");
		if(existing?.isConnected) {
			resolve(existing);
			return;
		}

		const observer = new MutationObserver(() => {
			if(getCharacterID() !== characterID) {
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

		observer.observe(document.body, {
			childList: true,
			subtree: true
		});

		const timer = setTimeout(() => {
			observer.disconnect();
			reject(new Error("Timed out waiting for character div"));
		}, timeout);
	});
}

/* ---------------- INJECT HOVER ZOOM STYLE ---------------- */
function injectHoverZoom() {
	if(document.querySelector("#badge-hover-style")) return;	//Avoid duplicate injection

	const style = document.createElement("style");
	style.id = "badge-hover-style";
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
			transition: background 0.2s ease, opacity 0.2s ease;
		}
		.awc-badge-toggle:hover {
			background: rgba(61, 180, 242, 0.3);
			opacity: 1;
		}
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
	`;
	document.head.appendChild(style);
}

/* ---------------- RENDER BADGES ---------------- */
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

	injectHoverZoom();	//Inject hover zoom effect

	matches.forEach(challenge => {	//Add each badge in DB order
		const wrapper = document.createElement("div");
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
		img.onerror = () => {
			console.warn(`AWC Character Page Badges: Failed to load image for "${challenge.name}".`);
			img.onerror = null;
		};
		img.style.borderRadius = "6px";
		img.style.maxHeight = "250px";
		img.style.maxWidth = "250px";
		if(challenge.unofficial) { img.style.outline = "2px dashed #888"; }	//Add unofficial badge border

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
				if(aspect >= 1) {
					img.width = Math.min(w, maxWidth);
					img.height = Math.min(img.width / aspect, maxHeight);
				} else {
					img.height = Math.min(h, maxHeight);
					img.width = Math.min(img.height * aspect, maxWidth);
				}
			}
		};

		link.appendChild(img);
		wrapper.appendChild(link);
		if(challenge.animated) {
			let isAnimated = true;
			const toggle = document.createElement("button");

			toggle.textContent = "Show Static Version";	// Label for version to switch to
			toggle.className = "awc-badge-toggle";
			toggle.addEventListener("click", () => {
				isAnimated = !isAnimated;
				img.src = isAnimated ? challenge.animated : challenge.image;
				toggle.textContent = isAnimated ? "Show Static Version" : "Show Animated Version";
				toggle.classList.toggle("awc-glint", !isAnimated);
			});
			wrapper.appendChild(toggle);
		}

		holder.appendChild(wrapper);
	});
}

/* ---------------- MAIN ---------------- */
let lastRenderedCharacterID = null;
let currentInitToken = 0;	//Increment on new init calls to discard old async loaded elements
let scriptLogged = false;
let dbPromise = null;

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
		if(token !== currentInitToken) { return; }
		if(!scriptLogged) {
			console.info(`AWC Character Page Badges: ${db.challenges.length} badges loaded in database. Cache is ${CACHE_ENABLED ? "enabled." : "disabled."} Unofficial Badges are ${SHOW_UNOFFICIAL ? "enabled." : "disabled."}`);
			scriptLogged = true;
		}

		const characterDiv = await waitForCharacter(characterID);
		if(token !== currentInitToken) { return; }
		renderBadges(db, characterID, characterDiv);
		lastRenderedCharacterID = characterID;
	} catch (err) { console.error("AWC Badge script error:", err); }
}

/* ---------------- SPA NAVIGATION HANDLER ---------------- */
function onRouteChange() {	//AniList uses Vue routing, so navigation usually does not refresh the page
	setTimeout(() => init(), 150);	//Brief delay gives Vue time to begin mounting the next page
}

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
