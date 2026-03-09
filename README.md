# AWC Character Page Badges
**Display Anime Watch Club badges on AniList Character pages for any and all badges that character is featured in.**

## Description
This userscript injects a section to display [Anime Watch Club](https://awc.moe/) badges on [AniList](anilist.co) character pages, showing any and all badges that feature that character, with a link to the challenge thread if available.

## Features
- Loads only on **AniList character pages** (`https://anilist.co/character/*`)
- Supports **PNG and GIF badges**
- Badges are sized proportionally based on their source dimensions and won't blot out half the screen:
  - Modern 720×720 badges → 250×250px
  - Legacy 520×720 badges → 180.55×250px
  - Badges wrap neatly if somehow a character has been featured in more than ~5 badges
- Hover effect: badges slightly zoom on hover for better visibility
- Multiple badges for a character are displayed **in the order they appear in the JSON database**
  - Attempting to group by badge type then by release date but it's imperfect. Characters should rarely if ever have more than one badge anyway.

## Usage
1. Install via [GreasyFork](https://greasyfork.org/en/scripts/569079-awc-character-page-badges) or GitHub.
2. Open any AniList character page to see badges for that character (If they've ever featured on one).
3. Clicking a badge opens the corresponding AWC challenge forum thread in a new tab.

## Notes
- The script caches badge data from GitHub for **7 Days** for faster loading. Badges are seldom released more often.
- Works with AniList’s SPA (Single-Page-Application) navigation; switching pages using forward/back buttons injects badges automatically and shouldn't require a page refresh.
- Styling attempts to match AniList’s layout and color scheme by barely having any color scheme to begin with.

## DB Style guide for updates
This guide explains how to format and organize new AWC challenge entries in the `badges.jsonc` database.

### Challenge Entry Template

Each challenge should follow this format:
The DB is stored as JSONC so comments should be included. The challenge name and forum link as well as character names should be included as comments.

```jsonc
{   //Rainbow Challenge
	//https://anilist.co/forum/thread/7738
	"id": "rainbow",	//Unique lowercase identifier, badges with a year would follow like seasonal2015
	"name": "Rainbow Challenge", //Full Challenge Display Name
	"characters": [	//Some badges feature multiple characters, list in the order they are named in the original challenge thread
		16055,  //Shuuichi Nitori
		16327   //Yoshino Takatsuki
	],	//Names taken are in listed EN style
	"image": "https://cdn.awc.moe/static/badges/anime/specials/rainbow/tdf/Rainbow.png",	//Badge Image Permalink, use official
	"thread": 7738	// AniList forum threadID
}
```
### Badge Grouping & Ordering

To maintain consistency with AWC.moe leaderboard listings, badges should be grouped and ordered as follows:
  - End of Year
- < Anime >
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
- < Manga >
  - Collection
  - Manga City
  - Special
  - Tier

In a perfect world, the db matches AWC Laderboard listings element for element. Newly added badges are added towards the end of their group.
