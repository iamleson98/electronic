import { defineConfig, devices } from "@playwright/test";
export default defineConfig({ testDir: "./tests-e2e", use: { baseURL: "http://localhost:3000" } });

