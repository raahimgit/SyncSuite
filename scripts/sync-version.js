import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
fs.writeFileSync(
  new URL("../src/version.ts", import.meta.url),
  `export const VERSION = "${pkg.version}";\n`
);

// Ensure assets/logo.png exists for repo organization and documentation
const logoSrc = new URL("../logo.png", import.meta.url);
const assetsDir = new URL("../assets", import.meta.url);
const logoDest = new URL("../assets/logo.png", import.meta.url);

if (fs.existsSync(logoSrc)) {
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }
  fs.copyFileSync(logoSrc, logoDest);
}
