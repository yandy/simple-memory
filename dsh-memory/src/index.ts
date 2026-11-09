import type { Context } from "./host-types.js";

export const name = "simple-memory";
export const inject = ["tools", "systemPrompt", "llm", "commands", "workingDirectory", "sessionQuery", "logger"] as const;
export async function apply(_ctx: Context, _config: unknown): Promise<void> {
	// Task 16 填实体
}
