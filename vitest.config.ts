import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: ["memory-core", "pi-memory"],
	},
});
