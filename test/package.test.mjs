import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("package exposes a Pi extension manifest", async () => {
	const packageJson = JSON.parse(
		await readFile(join(root, "package.json"), "utf8"),
	);
	assert.deepEqual(packageJson.pi.extensions, ["./extensions"]);
	assert.ok(packageJson.keywords.includes("pi-package"));
	assert.equal(
		packageJson.peerDependencies["@earendil-works/pi-coding-agent"],
		"*",
	);
});

test("extension entry point is present", async () => {
	const entry = join(root, "extensions", "index.ts");
	const source = await readFile(entry, "utf8");
	assert.match(source, /registerCommand\("subtask"/);
	assert.match(source, /CHILD_SYSTEM_PROMPT/);
	assert.match(source, /--append-system-prompt/);
	assert.match(source, /finish\(exitCode\)/);
	assert.match(source, /id\.slice\(-8\)/);
	assert.equal(basename(entry), "index.ts");
});
