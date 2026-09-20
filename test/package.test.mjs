import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("package exposes a Pi extension manifest", async () => {
	const packageJsonText = await readFile(join(root, "package.json"), "utf8");
	let packageJson;
	try {
		packageJson = JSON.parse(packageJsonText);
	} catch (error) {
		assert.fail(
			`Invalid package.json: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	assert.deepEqual(packageJson.pi.extensions, ["./extensions/usage-entry.ts"]);
	assert.ok(packageJson.files.includes(".env.example"));
	assert.ok(packageJson.files.includes("README.en.md"));
	assert.match(
		packageJson.pi.image,
		/pi-subtask-hello-world-demo-manual\.gif$/,
	);
	assert.ok(packageJson.keywords.includes("pi-package"));
	assert.equal(
		packageJson.peerDependencies["@earendil-works/pi-coding-agent"],
		"*",
	);
});

test("extension entry point is present", async () => {
	const asset = join(root, "assets", "pi-subtask-hello-world-demo-manual.gif");
	assert.ok((await readFile(asset)).byteLength > 100_000);
	assert.match(await readFile(join(root, ".env.example"), "utf8"), /PI_SUBTASK_LOCALE=zh-CN/);
	assert.match(await readFile(join(root, "README.en.md"), "utf8"), /# pi-subtask/);

	const entry = join(root, "extensions", "index.ts");
	const source = await readFile(entry, "utf8");
	assert.match(source, /registerCommand\("subtask"/);
	assert.match(source, /registerTool\(\{/);
	assert.match(source, /name: "subtask"/);
	assert.match(source, /promptGuidelines/);
	assert.match(source, /COPIES/);
	assert.match(source, /PI_SUBTASK_LOCALE/);
	assert.match(source, /--append-system-prompt/);
	assert.match(source, /finish\(exitCode\)/);
	assert.match(source, /id\.slice\(-8\)/);
	assert.equal(basename(entry), "index.ts");

	const usageEntry = await readFile(join(root, "extensions", "usage-entry.ts"), "utf8");
	assert.match(usageEntry, /exitCode === 0/);
	assert.match(usageEntry, /PI_SUBTASK_CHILD/);
});
