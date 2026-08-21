import { existsSync, readFileSync } from "node:fs";
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

type Locale = "zh-CN" | "en-US";

type Copy = {
	childSystemPrompt: string;
	commandDescription: string;
	noRunning: string;
	running: (count: number) => string;
	sessionNotPersisted: string;
	forkFailed: (error: string) => string;
	forkUnavailable: string;
	childStartFailed: (error: string) => string;
	childStarted: (file: string) => string;
	resultInsertFailed: (error: string) => string;
	noText: string;
	completed: string;
	failed: (exitCode: string) => string;
	resultHeader: (status: string) => string;
	childSession: (file: string) => string;
	hidden: (count: number) => string;
	status: (count: number) => string;
};

const COPIES: Record<Locale, Copy> = {
	"zh-CN": {
		childSystemPrompt: [
			"你是 /subtask 子会话。只有任务全部完成后，才能输出最终答案。",
			"不要使用 MonitorCreate、LoopCreate、后台进程或异步等待来代替任务本身。",
			"如果任务要求等待，必须使用 bash 执行前台同步命令，并等待命令返回。",
			"不要调用或建议再次调用 /subtask。",
			"请使用中文回答。",
		].join("\n"),
		commandDescription: "将当前会话上下文 fork 到子 Pi，并返回最终答案",
		noRunning: "当前没有运行中的 subtask。",
		running: (count) => `当前有 ${count} 个运行中的 subtask，已显示列表。`,
		sessionNotPersisted: "当前 session 未持久化，无法 fork；请不要用 --no-session。",
		forkFailed: (error) => `创建 fork session 失败：${error}`,
		forkUnavailable: "无法创建 fork session。",
		childStartFailed: (error) => `启动 child Pi 失败：${error}`,
		childStarted: (file) => `已启动 fork session：${file}`,
		resultInsertFailed: (error) => `插入 subtask 结果失败：${error}`,
		noText: "（child Pi 没有返回文本）",
		completed: "已完成",
		failed: (exitCode) => `失败（退出 ${exitCode}）`,
		resultHeader: (status) => `子任务${status}。`,
		childSession: (file) => `子会话：${file}`,
		hidden: (count) => `……还有 ${count} 个 subtask 未显示`,
		status: (count) => `⏳ /subtask ${count}`,
	},
	"en-US": {
		childSystemPrompt: [
			"You are a /subtask child session. Output a final answer only after the task is fully complete.",
			"Do not use MonitorCreate, LoopCreate, background processes, or asynchronous waiting instead of doing the task.",
			"If the task requires waiting, run a foreground synchronous command with bash and wait for it to return.",
			"Do not call or suggest calling /subtask again.",
			"Answer in English.",
		].join("\n"),
		commandDescription: "Fork the current session context into a child Pi and return its final answer",
		noRunning: "No running subtasks.",
		running: (count) => `${count} subtask(s) running; list shown.`,
		sessionNotPersisted: "The current session is not persisted; cannot fork. Do not use --no-session.",
		forkFailed: (error) => `Failed to create fork session: ${error}`,
		forkUnavailable: "Unable to create fork session.",
		childStartFailed: (error) => `Failed to start child Pi: ${error}`,
		childStarted: (file) => `Started fork session: ${file}`,
		resultInsertFailed: (error) => `Failed to insert subtask result: ${error}`,
		noText: "(child Pi returned no text)",
		completed: "completed",
		failed: (exitCode) => `failed (exit ${exitCode})`,
		resultHeader: (status) => `Forked subtask ${status}.`,
		childSession: (file) => `Child session: ${file}`,
		hidden: (count) => `... ${count} more subtask(s) hidden`,
		status: (count) => `⏳ /subtask ${count}`,
	},
};

function readDotEnvValue(name: string): string | undefined {
	const envPath = path.join(process.cwd(), ".env");
	if (!existsSync(envPath)) return undefined;

	try {
		for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			const separator = line.indexOf("=");
			if (separator < 0 || line.slice(0, separator).trim() !== name) continue;
			return line
				.slice(separator + 1)
				.trim()
				.replace(/^(['"])(.*)\1$/, "$2");
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function resolveLocale(): Locale {
	const raw = process.env.PI_SUBTASK_LOCALE ?? readDotEnvValue("PI_SUBTASK_LOCALE");
	const normalized = raw?.trim().toLowerCase().replace(/_/g, "-");
	return normalized === "en" || normalized === "en-us" ? "en-US" : "zh-CN";
}

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
			if (part.type === "text" && typeof part.text === "string")
				texts.push(part.text);
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

	const locale = resolveLocale();
	const copy = COPIES[locale];
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
						content: `${copy.resultHeader(status)}\n\n${result}\n\n${copy.childSession(childSessionFile)}`,
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
						copy.resultInsertFailed(error instanceof Error ? error.message : String(error)),
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
			lines.push(copy.hidden(hiddenCount));
		}

		ctx.ui.setStatus(
			"subtask",
			theme.fg("accent", copy.status(tasks.size)),
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
		description: copy.commandDescription,
		handler: async (args, ctx) => {
			const prompt = args.trim();
			if (!prompt) {
				updateStatus(ctx);
				notify(
					ctx,
					tasks.size > 0 ? copy.running(tasks.size) : copy.noRunning,
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
					copy.sessionNotPersisted,
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
					copy.forkFailed(error instanceof Error ? error.message : String(error)),
					"error",
				);
				return;
			}

			if (!childSessionFile) {
				notify(ctx, copy.forkUnavailable, "error");
				return;
			}

			const childArgs = [
				"--no-extensions",
				"--mode",
				"json",
				"-p",
				"--session",
				childSessionFile,
			];
			if (ctx.model)
				childArgs.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
			const activeTools = pi.getActiveTools();
			if (activeTools.length > 0)
				childArgs.push("--tools", activeTools.join(","));
			childArgs.push(
				"--thinking",
				pi.getThinkingLevel(),
				"--append-system-prompt",
				copy.childSystemPrompt,
				prompt,
			);

			const invocation = getPiInvocation(childArgs);
			let child: ChildProcess;
			try {
				child = spawn(invocation.command, invocation.args, {
					cwd: ctx.cwd,
					env: {
						...process.env,
						PI_SUBTASK_CHILD: "1",
						PI_SUBTASK_LOCALE: locale,
					},
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (error) {
				notify(
					ctx,
					copy.childStartFailed(error instanceof Error ? error.message : String(error)),
					"error",
				);
				return;
			}

			children.add(child);
			const childId =
				path.basename(childSessionFile, ".jsonl").split("_").pop() ?? "unknown";
			tasks.set(child, { id: childId, prompt });
			updateStatus(ctx);
			notify(ctx, copy.childStarted(path.basename(childSessionFile)));

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
					copy.noText;
				const status =
					forcedStatus ??
					(exitCode === 0
						? copy.completed
						: copy.failed(String(exitCode ?? "unknown")));
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
