import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type JsonEvent = {
	type?: string;
	willRetry?: boolean;
	message?: {
		role?: string;
		content?: Array<{ type?: string; text?: string }>;
		errorMessage?: string;
	};
};

const CHILD_SYSTEM_PROMPT = [
	"你是 /subtask 子会话。只有任务全部完成后，才能输出最终答案。",
	"不要使用 MonitorCreate、LoopCreate、后台进程或异步等待来代替任务本身。",
	"如果任务要求等待，必须使用 bash 执行前台同步命令，并等待命令返回。",
	"不要调用或建议再次调用 /subtask。",
].join("\n");

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const executable = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

function assistantText(message: JsonEvent["message"]): string {
	if (message?.role !== "assistant" || !message.content) return "";
	return message.content
		.reduce<string[]>((texts, part) => {
			if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
			return texts;
		}, [])
		.join("");
}

function parseLine(
	line: string,
	state: { output: string; error?: string },
): JsonEvent | undefined {
	if (!line.trim()) return;

	let event: JsonEvent;
	try {
		event = JSON.parse(line) as JsonEvent;
	} catch {
		return;
	}

	if (event.type === "message_end" && event.message) {
		const text = assistantText(event.message);
		if (text) state.output = text;
		if (event.message.errorMessage) state.error = event.message.errorMessage;
	}
	return event;
}

function notify(
	ctx: ExtensionCommandContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	ctx.ui.notify(`[subtask] ${message}`, type);
}

export default function subtaskExtension(pi: ExtensionAPI): void {
	// Child Pi processes inherit global extensions but must not expose a nested command.
	if (process.env.PI_SUBTASK_CHILD === "1") return;

	const children = new Set<ChildProcess>();
	const tasks = new Map<ChildProcess, { id: string; prompt: string }>();
	let resultDeliveryQueue: Promise<void> = Promise.resolve();
	let shuttingDown = false;

	function enqueueResult(
		ctx: ExtensionCommandContext,
		{
			status,
			result,
			childSessionFile,
			exitCode,
		}: {
			status: string;
			result: string;
			childSessionFile: string;
			exitCode: number | null | undefined;
		},
	): void {
		resultDeliveryQueue = resultDeliveryQueue
			.then(async () => {
				if (shuttingDown) return;
				await ctx.waitForIdle();
				if (shuttingDown) return;

				pi.sendMessage(
					{
						customType: "subtask",
						content: `Forked subtask ${status}.\n\n${result}\n\nChild session: ${childSessionFile}`,
						display: true,
						details: { childSessionFile, exitCode },
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);

				// Wait for this turn before delivering next result. This prevents concurrent
				// sendMessage() calls from racing when several children finish together.
				await ctx.waitForIdle();
			})
			.catch((error) => {
				if (!shuttingDown) {
					notify(
						ctx,
						`插入 subtask 结果失败：${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			});
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (tasks.size === 0) {
			ctx.ui.setStatus("subtask", undefined);
			ctx.ui.setWidget("subtask", undefined);
			return;
		}

		const theme = ctx.ui.theme;
		const taskList = [...tasks.values()];
		const hiddenCount = Math.max(0, taskList.length - 5);
		const visibleCount = hiddenCount > 0 ? 4 : 5;
		const lines = taskList.slice(0, visibleCount).map(({ id, prompt }) => {
			const label = prompt.replace(/\s+/g, " ").trim();
			const shortLabel = label.length > 24 ? `${label.slice(0, 23)}…` : label;
			return `⏳ ${id.slice(-8)} ${shortLabel}`;
		});
		if (hiddenCount > 0) {
			lines.push(`… 还有 ${hiddenCount} 个 subtask 未显示`);
		}

		ctx.ui.setStatus(
			"subtask",
			theme.fg("accent", `⏳ /subtask ${tasks.size}`),
		);
		ctx.ui.setWidget(
			"subtask",
			lines.map((line) => theme.fg("muted", line)),
			{ placement: "aboveEditor" },
		);
	}

	pi.on("session_shutdown", (_event, ctx) => {
		shuttingDown = true;
		for (const child of children) child.kill("SIGTERM");
		children.clear();
		tasks.clear();
		updateStatus(ctx);
	});

	pi.registerCommand("subtask", {
		description:
			"Fork the current session context into a child Pi and return its final answer",
		handler: async (args, ctx) => {
			const prompt = args.trim();
			if (!prompt) {
				updateStatus(ctx);
				notify(
					ctx,
					tasks.size > 0
						? `当前有 ${tasks.size} 个运行中的 subtask，已显示列表。`
						: "当前没有运行中的 subtask。",
				);
				return;
			}

			// Make the fork point deterministic when the user submits this while Pi is busy.
			await ctx.waitForIdle();

			const parentSessionFile = ctx.sessionManager.getSessionFile();
			const leafId = ctx.sessionManager.getLeafId();
			if (!parentSessionFile || !leafId) {
				notify(
					ctx,
					"当前 session 未持久化，无法 fork；请不要用 --no-session。",
					"error",
				);
				return;
			}

			let childSessionFile: string | undefined;
			try {
				// createBranchedSession mutates its SessionManager, so open a separate manager.
				const forkManager = SessionManager.open(parentSessionFile);
				childSessionFile = forkManager.createBranchedSession(leafId);
			} catch (error) {
				notify(
					ctx,
					`创建 fork session 失败：${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}

			if (!childSessionFile) {
				notify(ctx, "无法创建 fork session。", "error");
				return;
			}

			const childArgs = ["--mode", "json", "-p", "--session", childSessionFile];
			if (ctx.model)
				childArgs.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
			const activeTools = pi.getActiveTools();
			if (activeTools.length > 0)
				childArgs.push("--tools", activeTools.join(","));
			childArgs.push(
				"--thinking",
				pi.getThinkingLevel(),
				"--append-system-prompt",
				CHILD_SYSTEM_PROMPT,
				prompt,
			);

			const invocation = getPiInvocation(childArgs);
			let child: ChildProcess;
			try {
				child = spawn(invocation.command, invocation.args, {
					cwd: ctx.cwd,
					env: { ...process.env, PI_SUBTASK_CHILD: "1" },
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (error) {
				notify(
					ctx,
					`启动 child Pi 失败：${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}

			children.add(child);
			const childId =
				path.basename(childSessionFile, ".jsonl").split("_").pop() ?? "unknown";
			tasks.set(child, { id: childId, prompt });
			updateStatus(ctx);
			notify(ctx, `已启动 fork session：${path.basename(childSessionFile)}`);

			const state = { output: "", error: "" };
			let stdoutBuffer = "";
			let stderr = "";
			let completionSent = false;
			const finish = (
				exitCode: number | null | undefined,
				forcedStatus?: string,
			) => {
				if (completionSent || shuttingDown) return;
				completionSent = true;
				children.delete(child);
				tasks.delete(child);
				updateStatus(ctx);

				const result =
					state.output ||
					state.error ||
					stderr.trim() ||
					"(child Pi 没有返回文本)";
				const status =
					forcedStatus ??
					(exitCode === 0
						? "completed"
						: `failed (exit ${exitCode ?? "unknown"})`);
				enqueueResult(ctx, { status, result, childSessionFile, exitCode });

			};
			const handleLine = (line: string) => {
				parseLine(line, state);
			};
			child.stdout?.on("data", (data: Buffer | string) => {
				stdoutBuffer += data.toString();
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() ?? "";
				for (const line of lines) handleLine(line);
			});
			child.stderr?.on("data", (data: Buffer | string) => {
				stderr = `${stderr}${data.toString()}`.slice(-4000);
			});
			child.on("error", (error) => {
				state.error = error.message;
			});
			child.on("close", (exitCode) => {
				if (shuttingDown || completionSent) return;
				if (stdoutBuffer) handleLine(stdoutBuffer);
				finish(exitCode);
			});
		},
	});
}
