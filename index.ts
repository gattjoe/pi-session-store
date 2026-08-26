import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Mirrors pi session JSONL entries to a remote session-store server
// (https://github.com/gattjoe/pathfinder/tree/main/session-store) so
// transcripts are readable centrally instead of living only on disk.
// ---------------------------------------------------------------------------

const DEFAULT_SESSION_STORE_URL = "https://sessions.echobase.network";

function getEnvValue(key: string): string | undefined {
	return process.env[`PI_${key}`] ?? process.env[key];
}

interface StoreConfig {
	url: string;
	token: string;
}

function loadConfig(): StoreConfig | undefined {
	const token = getEnvValue("SESSION_STORE_TOKEN");
	if (!token) return undefined;
	const url = (getEnvValue("SESSION_STORE_URL") ?? DEFAULT_SESSION_STORE_URL).replace(/\/+$/, "");
	return { url, token };
}

interface PiEntry {
	type: string;
	id: string;
	parentId: string | null;
	[key: string]: unknown;
}

// session-store's EntryCreate.type is a fixed 6-value enum (server/app.py
// ENTRY_TYPES) that predates pi's richer entry vocabulary. "message" splits
// into message/tool_result by role; everything outside the four other exact
// matches (compaction, branch_summary, custom) folds into "meta" with the
// original pi `type` preserved in the payload so nothing is lost.
function mapEntry(entry: PiEntry): { type: string; payload: unknown } {
	switch (entry.type) {
		case "message": {
			const message = entry.message as { role?: string } | undefined;
			const isToolResult = message?.role === "toolResult";
			return { type: isToolResult ? "tool_result" : "message", payload: message };
		}
		case "compaction":
			return {
				type: "compaction",
				payload: {
					summary: entry.summary,
					tokensBefore: entry.tokensBefore,
					firstKeptEntryId: entry.firstKeptEntryId,
					retainedTail: entry.retainedTail,
					details: entry.details,
					usage: entry.usage,
					fromHook: entry.fromHook,
				},
			};
		case "branch_summary":
			return {
				type: "branch_summary",
				payload: {
					summary: entry.summary,
					fromId: entry.fromId,
					details: entry.details,
					usage: entry.usage,
					fromHook: entry.fromHook,
				},
			};
		case "custom":
			return { type: "custom", payload: { customType: entry.customType, data: entry.data } };
		default:
			// custom_message, model_change, thinking_level_change, label,
			// session_info, and any future pi entry type.
			return { type: "meta", payload: { piType: entry.type, ...entry } };
	}
}

async function sessionStorePost(config: StoreConfig, path: string, body: unknown): Promise<Response> {
	return fetch(`${config.url}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
		body: JSON.stringify(body),
	});
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig();

	const registeredSessions = new Set<string>();
	const syncedEntryIds = new Set<string>();

	function setStatus(ctx: ExtensionContext, text: string | undefined): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("session-store", text ? ctx.ui.theme.fg("dim", text) : undefined);
	}

	async function ensureSessionRegistered(ctx: ExtensionContext): Promise<void> {
		if (!config) return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId || registeredSessions.has(sessionId)) return;
		registeredSessions.add(sessionId);

		const header = ctx.sessionManager.getHeader() as { parentSession?: string } | undefined;
		try {
			const res = await sessionStorePost(config, "/sessions", {
				id: sessionId,
				cwd: ctx.sessionManager.getCwd(),
				title: ctx.sessionManager.getSessionName(),
				parentSession: header?.parentSession,
				source: "pi",
			});
			if (!res.ok && res.status !== 409) {
				setStatus(ctx, `● store ${res.status}`);
			}
		} catch {
			setStatus(ctx, "● store unreachable");
		}
	}

	// ponytail: re-reads and re-diffs the whole session file at each sync
	// point rather than tailing new bytes. Session files are a few hundred KB
	// at most and this only runs on turn_end/switch/shutdown, so the reparse
	// cost is noise; revisit if sessions start running much longer.
	async function syncSession(ctx: ExtensionContext): Promise<void> {
		if (!config) return;
		const sessionId = ctx.sessionManager.getSessionId();
		const file = ctx.sessionManager.getSessionFile();
		if (!sessionId || !file) return;

		await ensureSessionRegistered(ctx);

		let lines: string[];
		try {
			lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
		} catch {
			return;
		}

		let shipped = 0;
		let failed = false;
		for (const line of lines) {
			let entry: PiEntry;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type === "session" || !entry.id || syncedEntryIds.has(entry.id)) continue;

			const mapped = mapEntry(entry);
			try {
				const res = await sessionStorePost(config, `/sessions/${sessionId}/entries`, {
					id: entry.id,
					parentId: entry.parentId,
					type: mapped.type,
					payload: mapped.payload,
				});
				if (res.ok || res.status === 409) {
					syncedEntryIds.add(entry.id);
					shipped += 1;
				} else {
					failed = true;
				}
			} catch {
				failed = true;
			}
		}

		if (failed) setStatus(ctx, "● store unreachable");
		else if (shipped > 0) setStatus(ctx, "● synced");
	}

	pi.on("session_start", async (_event, ctx) => {
		await ensureSessionRegistered(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await syncSession(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await syncSession(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await syncSession(ctx);
	});
}
