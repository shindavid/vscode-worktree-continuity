import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// The headless extension host is noticeably slower than a real window (git
	// fixture setup, discovery, and tab open/close all take longer), so give
	// mocha a generous per-test timeout instead of the 2s default.
	mocha: {
		timeout: 20000,
	},
});
