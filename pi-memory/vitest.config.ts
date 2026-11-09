import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** CI 的 `test-dist` job 把它设为 1：关掉 alias，让 `@yandy0725/memory-core` 走包 exports → dist。 */
const fromDist = process.env.MEMORY_CORE_FROM_DIST === "1";

export default defineConfig({
	resolve: fromDist
		? undefined
		: {
				alias: {
					"@yandy0725/memory-core": fileURLToPath(new URL("../memory-core/src/index.ts", import.meta.url)),
				},
			},
	test: {
		include: ["tests/**/*.test.ts"],
	},
});
