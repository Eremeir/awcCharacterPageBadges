[![Install on GreasyFork](https://img.shields.io/badge/GreasyFork-Install-red?logo=greasyfork&logoColor=white)](https://greasyfork.org/en/scripts/569079-awc-character-page-badges)
[![Install from GitHub](https://img.shields.io/badge/GitHub-Install-181717?logo=github&logoColor=white)](https://github.com/Eremeir/awcCharacterPageBadges/raw/master/awcCharacterPageBadges.user.js)
[![Version](https://img.shields.io/greasyfork/v/569079?label=Version)](https://greasyfork.org/en/scripts/569079-awc-character-page-badges)
[![AniList](https://img.shields.io/badge/Site-AniList-02A9FF?logo=anilist&logoColor=white)](https://anilist.co)
[![Forum Thread](https://img.shields.io/badge/Forum-AniList-02A9FF?logo=anilist&logoColor=white)](https://anilist.co/forum/thread/88221)
[![AWC](https://img.shields.io/badge/AWC-awc.moe-blue)](https://awc.moe/)
[![GreasyFork Installs](https://img.shields.io/greasyfork/dt/569079?label=Installs)](https://greasyfork.org/en/scripts/569079-awc-character-page-badges)
[![Last Commit](https://img.shields.io/github/last-commit/Eremeir/awcCharacterPageBadges?label=Last+Commit)](https://github.com/Eremeir/awcCharacterPageBadges/commits/master)
[![Validate Database](https://github.com/Eremeir/awcCharacterPageBadges/actions/workflows/validateDB.yml/badge.svg)](https://github.com/Eremeir/awcCharacterPageBadges/actions/workflows/validateDB.yml)
[![Validate Badge URLs](https://github.com/Eremeir/awcCharacterPageBadges/actions/workflows/validateURLs.yml/badge.svg)](https://github.com/Eremeir/awcCharacterPageBadges/actions/workflows/validateURLs.yml)

# AWC Character Page Badges
**Display Anime Watch Club badges on AniList Character pages for any and all badges that character is featured in.**

## Description
This third-party userscript injects a section to display [Anime Watch Club](https://awc.moe/) badges on [AniList](https://anilist.co) character pages, showing any and all badges that feature that character, with a link to the challenge thread if available.

![Special Week Badge](https://i.imgur.com/6nEBIc0.png)

---

## Features
- Supports **PNG and GIF badges**; animated badges are served as AVIF for smaller file sizes, with an automatic fallback to the original format if your browser can't load it
- Badges are sized proportionally based on their source dimensions and won't blot out half the screen:
  - Modern 720×720 badges → 250×250px
  - Legacy 520×720 badges → 181×250px
  - Badges wrap neatly if somehow a character has been featured in more than ~5 badges
- Hover effect: badges slightly zoom on hover for better visibility
- Dynamic 3D tilt effect: badges now also tilt responsively to your cursor, can be disabled in the [config](#configuration)
- Multiple badges for a character are displayed **in the order they appear in the JSON database**
- Static variants of animated badges can be seen with a toggle

---

## Usage
1. Install a userscript manager browser extension, such as [Tampermonkey](https://www.tampermonkey.net/), [Violentmonkey](https://violentmonkey.github.io/), or [Greasemonkey](https://www.greasespot.net/), if you don't already have one.
2. Install via [GreasyFork](https://greasyfork.org/en/scripts/569079-awc-character-page-badges) or [GitHub](https://github.com/Eremeir/awcCharacterPageBadges/raw/master/awcCharacterPageBadges.user.js).
3. Open any AniList character page to see badges for that character (If they've ever featured on one).
4. Clicking a badge opens the corresponding AWC challenge forum thread in a new tab.

---

## Configuration
A few options can be changed by editing the constants in the `CONFIG` section at the top of the script. Open your userscript manager's dashboard, click **AWC Character Page Badges** to open the editor, change a value, and save.

| Option | Default | Description |
|---|---|---|
| `ENABLE_3D_HOVER` | `true` | The 3D tilt and lighting effect on hover. Set to `false` for a plain zoom instead. |
| `SHOW_UNOFFICIAL` | `false` | Also show unofficial community badges, which are marked with a dashed outline. |
| `CACHE_ENABLED` | `true` | Cache the badge database in your browser's local storage so pages load faster. |
| `CACHE_TTL` | `24 * 60 * 60 * 1000` | How long cached data is used before it is refreshed in the background (1 day, in milliseconds). |

> **Note:** When the script updates, your manager may replace the whole file and overwrite your edits. If you customize the config, turn off automatic updates for this script in your manager's settings, or reapply your changes after updating. Proper settings options will come eventually.

---

## Notes
- The script caches badge data from GitHub for about a day for faster loading. Once the cache expires it is refreshed in the background, so a newly added badge can take up to a day to appear.
- Works with AniList’s SPA (Single-Page-Application) navigation; switching pages using forward/back buttons injects badges automatically and shouldn't require a page refresh.
- Badges for characters who do not have a corresponding AniList character page can be found at the [AniList narrator page](https://anilist.co/character/36309/Narrator).
- Styling attempts to match AniList’s layout and color scheme by barely having any color scheme to begin with.

---

## Feedback
Have I gotten something wrong? Make a GitHub issue or @Eremeir on the AWC discord and I'll check it out. I want the data to be as complete and thorough as possible with all variants and proper thread linking.

---

## Disclaimer

> This userscript is an unofficial community project and is **not affiliated with, endorsed by, or supported by**:
>
> - **awc.moe or the Anime Watch Club (AWC) team**
> - **AniList**

It only displays publicly available AWC badge information on AniList character pages for convenience and doesn't host any content itself. All challenge content, badge art, and forum threads belong to their respective creators. The intended usecase is just to show off the incredible badge art in more places and give an idea as to what badges feature different characters if you wanted to try to collect badges that depict characters you like, like I do. Still waiting on more OVERLORD badges, thx.

---

## DB Style guide for updates
Each challenge should follow this format:
The DB is stored as JSONC so comments should be used. The challenge name and forum link as well as character names should be included as comments.

<details>
<summary>Example challenge entry</summary>

```jsonc
{   //Rainbow Challenge
	//https://anilist.co/forum/thread/7738
	"id": "rainbow",	//Unique lowercase identifier, badges with a year would follow like seasonal2015
	"name": "Rainbow Challenge",	//Full Challenge Display Name
	"characters": [	//Some badges feature multiple characters, list in the order they are named in the original challenge thread
		16055,	//Shuuichi Nitori
		16327	//Yoshino Takatsuki
	],	//Names taken are in listed EN style
	"image": "https://cdn.awc.moe/static/badges/anime/specials/rainbow/tdf/Rainbow.png",	//Badge Image Permalink, use official
	"thread": 7738	// AniList forum threadID
}
```
</details>

---

### Badge Grouping & Ordering

To maintain consistency with AWC.moe leaderboard listings, badges should be grouped and ordered as follows:
- End of Year

- Anime
  - Classic
  - Collection
  - Event
  - Gacha
  - Genre
  - Monthly 2018–20XX
  - Puzzle
  - Seasonal
  - Special
  - Tier

- Manga
  - Collection
  - Manga City
  - Special
  - Tier

- AWC Staff
- Supporter
- Unofficial Badges
	- Have an unofficial badge? As long as there's an image permalink it can be added! Unofficial badge displays can be turned on in the script config.

