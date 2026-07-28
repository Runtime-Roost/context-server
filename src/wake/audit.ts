import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { WakeDecision, WakeHistoryEntry } from "./policy.js";

export async function readWakeHistory(path: string): Promise<WakeHistoryEntry[]> {
    try {
        const content = await readFile(resolve(path), "utf8");
        return content
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line, index) => {
                let parsed: Partial<WakeHistoryEntry>;
                try {
                    parsed = JSON.parse(line) as Partial<WakeHistoryEntry>;
                } catch {
                    throw new Error(`Invalid wake audit JSON on line ${index + 1}.`);
                }
                if (
                    typeof parsed.evaluated_at !== "string"
                    || !Number.isFinite(new Date(parsed.evaluated_at).getTime())
                    || (parsed.decision !== "allow" && parsed.decision !== "deny")
                    || typeof parsed.event_id !== "string"
                    || parsed.event_id.length === 0
                    || typeof parsed.target_actor_external_id !== "string"
                    || parsed.target_actor_external_id.length === 0
                ) {
                    throw new Error(`Invalid wake audit record on line ${index + 1}.`);
                }
                return parsed as WakeHistoryEntry;
            });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
}

export async function withWakeAuditLock<T>(path: string, operation: () => Promise<T>) {
    const lockPath = `${resolve(path)}.lock`;
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    let lock;
    try {
        lock = await open(lockPath, "wx", 0o600);
        await lock.write(`${process.pid}\n`);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new Error("Wake policy evaluation is already in progress.");
        }
        throw error;
    }
    try {
        return await operation();
    } finally {
        await lock.close();
        await unlink(lockPath).catch(() => undefined);
    }
}

export async function appendWakeAudit(path: string, decision: WakeDecision) {
    const absolutePath = resolve(path);
    await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
    const handle = await open(absolutePath, "a", 0o600);
    try {
        await handle.write(`${JSON.stringify(decision)}\n`);
        await handle.sync();
    } finally {
        await handle.close();
    }
}
