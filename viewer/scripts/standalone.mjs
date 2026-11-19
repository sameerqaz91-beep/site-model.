// Build one HTML file with the viewer and its data inside it, for sharing without a server.
// Usage: npm run standalone -- [model.json] [out.html] [facility.json]
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [model = "public/model.json", out = "standalone.html", facility = "public/facility.json"] = process.argv.slice(2);
execSync("npx vite build --outDir dist-single --emptyOutDir", { stdio: "inherit", env: { ...process.env, SINGLE: "1" } });
const html = readFileSync("dist-single/index.html", "utf8");
// "<" is escaped so text such as "</script>" inside the data cannot end the tag.
const embed = (id, file) =>
  `<script id="${id}" type="application/json">${readFileSync(file, "utf8").replace(/</g, "\\u003c")}</script>`;
const tags = [embed("model-data", model), ...(existsSync(facility) ? [embed("facility-data", facility)] : [])];
writeFileSync(out, html.replace("</head>", `${tags.join("\n")}\n</head>`));
console.log(`wrote ${out}${tags.length > 1 ? " (with facility)" : ""}`);
