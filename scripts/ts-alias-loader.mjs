/**
 * Minimal module resolver so the CLI scripts can run on plain Node.
 *
 * Node executes TypeScript natively (type stripping, since 22.6 / on by default
 * since 23.6) but it does not read `tsconfig.json`, so it knows nothing about the
 * `@/*` path alias or about extensionless imports. This hook teaches it both,
 * which is all that was standing between the scripts and running with no runtime
 * dependency at all — no ts-node, no tsx, no build step.
 *
 * Registered from `scripts/run.mjs`.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(projectRoot, "src");
const EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs"];

function firstExisting(basePath) {
  if (existsSync(basePath) && path.extname(basePath) !== "") return basePath;
  for (const extension of EXTENSIONS) {
    const candidate = `${basePath}${extension}`;
    if (existsSync(candidate)) return candidate;
  }
  for (const extension of EXTENSIONS) {
    const candidate = path.join(basePath, `index${extension}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Node needs to be told a `.ts` file is TypeScript, or it parses it as plain JavaScript. */
function formatFor(filePath) {
  return /\.(ts|tsx|mts)$/.test(filePath) ? "module-typescript" : "module";
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const resolved = firstExisting(path.join(srcRoot, specifier.slice(2)));
    if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true, format: formatFor(resolved) };
  }

  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    const parentDir = path.dirname(fileURLToPath(context.parentURL));
    const resolved = firstExisting(path.resolve(parentDir, specifier));
    if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true, format: formatFor(resolved) };
  }

  // Absolute and bare specifiers still reach here — notably the entry script that
  // `run.mjs` imports by file URL. Node would guess the format from the nearest
  // `package.json`, which has no `type` field, and warn about reparsing; naming the
  // format for TypeScript files keeps the output clean.
  const resolved = await nextResolve(specifier, context);
  if (resolved.format || !resolved.url?.startsWith("file:")) return resolved;
  return { ...resolved, format: formatFor(fileURLToPath(resolved.url)) };
}
