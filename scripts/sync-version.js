import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
fs.writeFileSync(
  new URL("../src/version.ts", import.meta.url),
  `export const VERSION = "${pkg.version}";\n`
);

