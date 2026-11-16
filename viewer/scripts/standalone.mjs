// Build one HTML file with the viewer and the model inside it, for sharing without a server.
// Usage: npm run standalone -- [model.json] [out.html]
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [model = "public/model.json", out = "standalone.html"] = process.argv.slice(2);
execSync("npx vite build --outDir dist-single --emptyOutDir", { stdio: "inherit", env: { ...process.env, SINGLE: "1" } });
const html = readFileSync("dist-single/index.html", "utf8");
// "<" is escaped so text such as "</script>" inside the data cannot end the tag.
const data = readFileSync(model, "utf8").replace(/</g, "\\u003c");
const tag = `<script id="model-data" type="application/json">${data}</script>`;
writeFileSync(out, html.replace("</head>", `${tag}\n</head>`));
console.log(`wrote ${out}`);
