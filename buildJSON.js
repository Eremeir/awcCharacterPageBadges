const fs = require("fs");

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

const data = parseJSONC( fs.readFileSync("badges.jsonc", "utf8"));

const output = JSON.stringify(data, null, 2);
fs.writeFileSync("badges.json", output);

console.log(`Generated badges.json (${data.challenges.length} challenges, ${output.length} bytes)`);
