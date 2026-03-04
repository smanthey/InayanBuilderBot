import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT || 4173);
const BASE_URL = process.env.E2E_BASE_URL || `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    extraHTTPHeaders: {
      "x-e2e-suite": "inayan-builder-ui",
      "x-e2e-account": "allowlisted-test-account",
    },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1600, height: 1000 },
      },
    },
  ],
  webServer: {
    command: "node src/index.js",
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NODE_ENV: "test",
      PORT: String(PORT),
      BUILDERBOT_API_KEY: "",
      INAYAN_E2E_MOCK_MODE: "1",
      REDDIT_DEFAULT_SUBREDDITS: "marketing,socialmedia",
      REDDIT_REQUEST_TIMEOUT_MS: "1000",
      EXTERNAL_INDEXING_MODE: "builtin",
    },
  },
});
