/**
 * Entry point for the CLI scripts: registers the alias resolver, then imports the
 * requested TypeScript file. Usage: `node scripts/run.mjs scripts/eval.ts [args]`.
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

register("./ts-alias-loader.mjs", import.meta.url);

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/run.mjs <script.ts> [args…]");
  process.exit(1);
}

await import(pathToFileURL(path.resolve(process.cwd(), target)).href);
