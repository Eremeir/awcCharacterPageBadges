[![AniList](https://img.shields.io/badge/Site-AniList-02A9FF?logo=anilist&logoColor=white)](https://anilist.co)
[![Forum Thread](https://img.shields.io/badge/Forum-AniList-02A9FF?logo=anilist&logoColor=white)](https://anilist.co/forum/thread/88221)
[![AWC](https://img.shields.io/badge/AWC-awc.moe-blue)](https://awc.moe/)
[![Last Commit](https://img.shields.io/github/last-commit/Eremeir/awcCharacterPageBadges?label=Last+Commit)](https://github.com/Eremeir/awcCharacterPageBadges/commits/master)
[![Validate Database](https://github.com/Eremeir/awcCharacterPageBadges/actions/workflows/validateDB.yml/badge.svg)](https://github.com/Eremeir/awcCharacterPageBadges/actions/workflows/validateDB.yml)
[![Validate Badge URLs](https://github.com/Eremeir/awcCharacterPageBadges/actions/workflows/validateURLs.yml/badge.svg)](https://github.com/Eremeir/awcCharacterPageBadges/actions/workflows/validateURLs.yml)
[![License](https://img.shields.io/badge/License-Unlicense-green)](https://github.com/Eremeir/awcCharacterPageBadges/blob/master/LICENSE)

# AWC Badge Scripts
**Two userscripts centered around Anime Watch Club badges, both running off one shared badge database.**

- **[AWC Character Page Badges](https://greasyfork.org/en/scripts/569079-awc-character-page-badges)** shows every badge a character is featured in on AniList character pages.
- **[AWC Challenger Page Badges](https://greasyfork.org/en/scripts/606817-awc-challenger-page-badges)** shows the badges a challenger hasn't earned yet on awc.moe challenger pages.

---

## Scripts

### AWC Character Page Badges
[![Install Character on GreasyFork](https://img.shields.io/badge/GreasyFork-Install-red?logo=greasyfork&logoColor=white)](https://greasyfork.org/en/scripts/569079-awc-character-page-badges)
[![Install Character from GitHub](https://img.shields.io/badge/GitHub-Install-181717?logo=github&logoColor=white)](https://github.com/Eremeir/awcCharacterPageBadges/raw/master/awcCharacterPageBadges.user.js)
[![Version](https://img.shields.io/greasyfork/v/569079?label=Version)](https://greasyfork.org/en/scripts/569079-awc-character-page-badges)
[![Installs](https://img.shields.io/greasyfork/dt/569079?label=Installs)](https://greasyfork.org/en/scripts/569079-awc-character-page-badges)

This third-party userscript injects a section to display [Anime Watch Club](https://awc.moe/) badges on [AniList](https://anilist.co) character pages, showing any and all badges that feature that character, with a link to the challenge thread if available.

![Special Week Badge](https://i.imgur.com/6nEBIc0.png)

- Supports **PNG and GIF badges**; animated badges are served as AVIF for smaller file sizes, with an automatic fallback to the original if your browser can't load it
- Badges are sized proportionally based on their source dimensions and won't blot out half the screen:
  - Modern 720×720 badges → 250×250px
  - Legacy 520×720 badges → 181×250px
  - Badges wrap neatly if somehow a character has been featured in more than ~5 badges
- Hover effect: badges slightly zoom on hover for better visibility
- Dynamic 3D tilt effect: badges now also tilt responsively to your cursor, can be turned off in the settings gear
- Multiple badges for a character are displayed **in the order they appear in the JSON database**
- Static variants of animated badges can be seen with a toggle

<details>
<summary>Configuration</summary>

| Setting | Default | Description |
|---|---|---|
| 3D hover | on | The 3D tilt and lighting effect on hover. Off gives a plain zoom instead. |
| Show unofficial badges | off | Also show unofficial community badges, which are marked with a dashed outline. |
| Hide non-unique legacy badges | Off | Hides a (Legacy) badge when its current version features the same character. Legacy badges for a character who only appears on the legacy version still show. |

### Advanced
The cache can be changed by editing the constants in the `CONFIG` section at the top of the script.

| Option | Default | Description |
|---|---|---|
| `CACHE_ENABLED` | `true` | Cache the badge database in your browser's local storage so pages load faster. |
| `CACHE_TTL` | `2 * 24 * 60 * 60 * 1000` | How long cached data is used before it is refreshed in the background (2 days, in milliseconds). |

> **Note:** When the script updates, your manager may replace the whole file and overwrite edits to these constants.
---
</details>

### AWC Challenger Page Badges
[![Install Challenger on GreasyFork](https://img.shields.io/badge/GreasyFork-Install-red?logo=greasyfork&logoColor=white)](https://greasyfork.org/en/scripts/606817-awc-challenger-page-badges)
[![Install Challenger from GitHub](https://img.shields.io/badge/GitHub-Install-181717?logo=github&logoColor=white)](https://github.com/Eremeir/awcCharacterPageBadges/raw/master/awcChallengerPageBadges.user.js)
[![Version](https://img.shields.io/greasyfork/v/606817?label=Version)](https://greasyfork.org/en/scripts/606817-awc-challenger-page-badges)
[![Installs](https://img.shields.io/greasyfork/dt/606817?label=Installs)](https://greasyfork.org/en/scripts/606817-awc-challenger-page-badges)

This third-party userscript adds the badges you *haven't* earned to your [awc.moe](https://awc.moe/) challenger page, slotted into the site's own categories so you can see what's left to collect and what can still be earned, with a link to the challenge thread if available.

![Challenger page](https://i.imgur.com/alIQm4y.png)

- An **Unowned** toggle button at the top right of the header cycles Off / On / All, slotting the badges you haven't earned into the site's own categories in database order (if the page has no box for a category yet, one is made up for it). On shows unowned badges that can still be obtained, while All shows every historical badge
- Availability rules are applied, so you can tell what can still be earned: events are closed unless listed as open, monthlies close the next month, seasonals get 17 weeks, Staff Pick Timed badges stay open until the following year, and supporter and staff badges are always considered unobtainable. A badge you own is never hidden
- A **progress dashboard** with a bar per category (optionally split into AWC and MRC), with an optional **!** indicator to remind when you're missing an open time-limited badge. Category sections can be clicked to jump directly to that section
- Collapse-all buttons, a jump-to-top button, and the same 3D tilt effect as the character script
- Unofficial community badges can be shown and marked as owned locally

<details>
<summary>Configuration</summary>

| Setting | Default | Description |
|---|---|---|
| Unowned badges | off | Off / On / All, via the toggle button in the header. Your last choice is remembered. |
| 3D tilt | on | The tilt and lighting effect on hover, for all badges. |
| Progress dashboard | on | The progress dashboard. |
| Split into AWC and MRC | on | Separate AWC and MRC sections in the dashboard; off groups them together. |
| Warn about time-limited badges | on | The orangered ! after the % for open, time-limited badges you're missing. |
| Show supporter badges | on | Supporter and Staff badges you do not own. |
| Show unofficial badges | off | Unofficial community-made badges which can be marked as owned locally. Enter your username and save to use it. *Purge marks* clears what you've marked. |

The gear panel also shows the version, the date of the badge data, and a button to force a cache refresh.

### Advanced
The cache can be changed by editing the constants in the `CONFIG` section at the top of the script.

| Option | Default | Description |
|---|---|---|
| `CACHE_ENABLED` | `true` | Cache the badge database in your browser's local storage so pages load faster. |
| `CACHE_TTL` | `2 * 24 * 60 * 60 * 1000` | How long cached data is used before it is refreshed in the background (2 days, in milliseconds). |

> **Note:** When the script updates, your manager may replace the whole file and overwrite edits to these constants.

---
</details>

---

## Usage
1. Install a userscript browser extension manager, such as [Tampermonkey](https://www.tampermonkey.net/), [Violentmonkey](https://violentmonkey.github.io/), or [Greasemonkey](https://www.greasespot.net/), if you don't already have one.
2. Install the script(s) via GreasyFork or GitHub using the badge buttons above.

---

## Notes
- The scripts cache badge data from GitHub for about two days for faster loading. Once the cache expires it is refreshed in the background, so a newly added badge can take a bit to appear. You can force a refresh in the settings gear.
- Both try to work with the sites' SPA (Single-Page-Application) navigation; switching pages using forward/back buttons works automatically and shouldn't require a page refresh.
- Badges for characters who do not have a corresponding AniList character page can be found at the [AniList narrator page](https://anilist.co/character/36309/Narrator).
- Styling attempts to match each site's layout and color scheme by barely having any color scheme to begin with.

---

## Feedback
Have I gotten something wrong? Have a suggestion? Make a GitHub issue or @Eremeir on the AWC discord and I'll check it out. I want the data to be as complete and thorough as possible with all variants and proper thread linking.

---

## Disclaimer

> This userscript is an unofficial community project and is **not affiliated with, endorsed by, or supported by**:
>
> - **awc.moe or the Anime Watch Club (AWC) team**
> - **AniList**

They only display publicly available AWC badge information for convenience and don't host any content themselves. All challenge content, badge art, and forum threads belong to their respective creators. The challenger page script is a collection of QoL and cosmetic tweaks I've been wanting personally. The character page script was made just to show off the incredible badge art in more places and give an idea as to what badges feature different characters if you wanted to try to collect badges that depict characters you like, like I do. Still waiting on more OVERLORD badges, thx.

---

## DB Style guide for updates
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

<details>
<summary>Field reference</summary>

| Field | Required | Description |
|---|---|---|
| `id` | Yes | Unique identifier, usually camelCase. |
| `name` | Yes | Full display name, shown as the badge's tooltip. |
| `characters` | Yes | AniList character IDs, in the order the challenge thread names them. |
| `image` | One of `image`/`animated` | Static badge permalink. |
| `animated` | One of `image`/`animated` | Animated badge permalink. When both are present, the animated version shows by default with a toggle to the static one. CDN-hosted PNG/GIFs are switched to AVIF by the build. |
| `thread` | Yes | AniList forum thread ID. |
| `unofficial` | No | `true` for unofficial community badges; hidden unless enabled in settings. |
</details>

### Section comments
The build reads the header comments to group badges, so they follow a fixed format, each on a line of its own:
- `/* ---------------- NAME ---------------- */` starts a top-level block (e.g. `ANIME BADGES`)
- `/* ANIME GENRE BADGES */`: a title ending in `BADGES` starts a section within it
- `/* Action */`: any other title starts a group within the section

Every badge must sit under at least a top-level block or section.

---

### Badge Grouping & Ordering
To maintain consistency with AWC.moe leaderboard listings, badges should be grouped and ordered as follows:
- End of Year
- Anime: Classic, Collection, Event, Gacha, Genre, Monthly 2018–20XX, Puzzle, Seasonal, Special, Tier
- Manga: Collection, Manga City, Special, Tier
- AWC Staff
- Supporter
- Unofficial Badges: Have an unofficial badge? As long as there's an image permalink it can be added! Enable them via the settings gear in either script.
