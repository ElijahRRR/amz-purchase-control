import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("dist", { recursive: true });
copyFileSync("public/manifest.json", "dist/manifest.json");
console.log("copied manifest.json → dist/");
