// ==UserScript==
// @name         AWC Character Page Badges
// @namespace    https://github.com/Eremeir
// @version      1.0.5
// @description  Display Anime Watch Club badges on AniList Character pages with caching, SPA support, and hover zoom
// @author       Eremeir
// @homepageURL  https://github.com/Eremeir/awcCharacterPageBadges
// @supportURL   https://github.com/Eremeir/awcCharacterPageBadges/issues
// @match        https://anilist.co/character/*
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @license      Unilicense
// ==/UserScript==

(function () {
"use strict";

/* ---------------- CONFIG ---------------- */
const DB_URL = "https://raw.githubusercontent.com/Eremeir/awcCharacterPageBadges/master/badges.jsonc";
const CACHE_ENABLED = true;
const CACHE_KEY = "awc_badges_cache";
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; //7 Days

/* ---------------- JSONC STRIPPER ---------------- */
function parseJSONC(text) {	//Strip comments from JSONC
	text = text.replace(/\/\*[\s\S]*?\*\//g, "");	//Remove block comments /* ... */
	const lines = text.split("\n").map(line => {	//Remove line comments outside of strings
		let inString = false;
		let result = "";
		for(let i = 0; i < line.length; i++) {
			if(line[i] === '"' && line[i-1] !== "\\") inString = !inString;
			if(!inString && line[i] === "/" && line[i+1] === "/") break;
			result += line[i];
		}
		return result;
	});
	return JSON.parse(lines.join("\n"));
}

/* ---------------- FETCH DATABASE ---------------- */
async function loadDB() {
	if(CACHE_ENABLED) {	//Attempt to load from cache if enabled
		try {
			const cached = localStorage.getItem(CACHE_KEY);
			if(cached) {
				const parsed = JSON.parse(cached);
				if(Date.now() - parsed.timestamp < CACHE_TTL) return parsed.data;
			}
		} catch {}
	}

	const data = await new Promise((resolve, reject) => {	//Fetch fresh JSONC from GitHub
		GM_xmlhttpRequest({
			method: "GET",
			url: DB_URL,
			onload: res => {
				try {
					const parsed = parseJSONC(res.responseText);
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

	return data;
}

/* ---------------- GET CHARACTER ID FROM URL ---------------- */
function getCharacterId() {
	const parts = location.pathname.split("/");
	return Number(parts[2]);
}

/* ---------------- WAIT FOR CHARACTER DIV ---------------- */
function waitForCharacter() {	//Wait for Vue to load the character div
	return new Promise(resolve => {
		const interval = setInterval(() => {
			const elem = document.querySelector(".character");
			if(elem) {
				clearInterval(interval);
				resolve(elem);
			}
		}, 300);
	});
}

/* ---------------- INJECT HOVER ZOOM STYLE ---------------- */
function injectHoverZoom() {
	if(document.querySelector("#badge-hover-style")) return;	//Avoid duplicate injection

	const style = document.createElement("style");
	style.id = "badge-hover-style";
	style.textContent = `
		.awc-badge-container div img {
			transition: transform 0.2s ease;
			cursor: pointer;
		}
		.awc-badge-container div img:hover {
			transform: scale(1.08);
		}
	`;
	document.head.appendChild(style);
}

/* ---------------- RENDER BADGES ---------------- */
function renderBadges(data, characterId, characterDiv) {
	if(document.querySelector(".awc-badge-container")) return;	//Avoid duplicate injection
	let matches = data.challenges.filter(c => c.characters.includes(characterId));	//Filter challenges that include this character
	if(!matches.length) return;

	//Sort alphabetically by badge ID, nonsensical in practice
	//matches.sort((a, b) => a.id.localeCompare(b.id));

	const container = document.createElement("div");	//Create container div
	container.style.maxWidth = "1300px";	//Match page layout
	container.style.margin = "0 auto";	//Center horizontally
	container.className = "awc-badge-container";

	const title = document.createElement("h2");	//Create header
	title.textContent = "Featuring AWC Challenges";
	title.style.margin = "25px 0";
	container.appendChild(title);

	const holder = document.createElement("div");	//Create badge holder flex container
	holder.style.display = "flex";
	holder.style.flexWrap = "wrap";
	holder.style.gap = "10px";
	container.appendChild(holder);

	characterDiv.insertAdjacentElement("afterend", container);	//Insert container after character div

	injectHoverZoom();	//Inject hover zoom effect


	matches.forEach(challenge => {	//Add each badge
		const link = document.createElement("a");
		link.href = `https://anilist.co/forum/thread/${challenge.thread}`;
		link.target = "_blank";
		link.rel = "noopener noreferrer";	//Isolate tabs

		const img = document.createElement("img");
		img.src = challenge.image;
		img.title = challenge.name;
		img.style.borderRadius = "6px";

		img.onload = () => {	//Resize after image loads based on natural dimensions
			const w = img.naturalWidth;
			const h = img.naturalHeight;

			if(w === 720 && h === 720) {	//Standard size badges
				img.width = 250;
				img.height = 250;
			} else if(w === 520 && h === 720) {	//Legacy badges
				img.width = 180.55;
				img.height = 250;
			} else {	// Scale proportionally for other dimensions
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
		holder.appendChild(link);
	});
}

/* ---------------- MAIN ---------------- */
async function init() {
	const characterId = getCharacterId();
	if(!characterId) return;
	try {
		const db = await loadDB();
		const characterDiv = await waitForCharacter();
		renderBadges(db, characterId, characterDiv);
	} catch (err) {
		console.error("AWC Badge script error:", err);
	}
}

/* ---------------- SPA NAVIGATION HANDLER ---------------- */

function watchForCharacterPage() {	//Handle Vue SPA navigation weirdness
	const observer = new MutationObserver(() => {
	const characterDiv = document.querySelector(".character");
		if(characterDiv && !document.querySelector(".awc-badge-container")) {
			init();
		}
	});
	observer.observe(document.body, {
		childList: true,
		subtree: true
	});
}

// ---------------- INITIAL RUN ----------------
watchForCharacterPage();
init();

})();
