import path from "node:path";
import { test, expect } from "@playwright/test";

async function clickLikeHuman(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.hover();
  await locator.click();
}

test.describe("Inayan Builder Dashboard E2E", () => {
  test("Magic Run one-click path surfaces proof metrics under 45s", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#runMagic")).toBeVisible();

    await page.click("#productName");
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("manychatdupe");
    await page.click("#goal");
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("Build a ManyChat-style Instagram automation product with flows, analytics, billing, and team onboarding.");

    await clickLikeHuman(page, page.locator("#runMagic"));
    await expect(page.locator("#out")).toContainText("\"ok\": true", { timeout: 60_000 });

    const wowRaw = await page.locator("#kpiWow").innerText();
    const planHash = (await page.locator("#kpiPlanHash").innerText()).trim();
    const quality = (await page.locator("#kpiQuality").innerText()).trim();
    const wow = Number(wowRaw);

    expect(Number.isFinite(wow)).toBeTruthy();
    expect(wow).toBeGreaterThan(0);
    expect(wow).toBeLessThan(45_000);
    expect(planHash).not.toBe("-");
    expect(planHash.length).toBeGreaterThanOrEqual(8);
    expect(quality).not.toBe("-");
  });

  test("Recompile flow shows structured diff after constraint edits", async ({ page }) => {
    await page.goto("/");
    await clickLikeHuman(page, page.locator("#runMagic"));
    await expect(page.locator("#recompileRunId")).not.toHaveValue("", { timeout: 60_000 });

    await page.fill("#recompileBudgetUsd", "2500");
    await page.fill("#recompileDeadlineDays", "10");
    await page.fill("#recompileTeamSize", "2");
    await page.fill("#recompileNotes", "Tighten scope for faster first release.");

    await clickLikeHuman(page, page.locator("#runRecompile"));
    await expect(page.locator("#recompileDiff")).toContainText("constraints_after", { timeout: 30_000 });
    await expect(page.locator("#recompileDiff")).toContainText("changed_fields");
  });

  test("Contract Gap Check path runs and returns section summary", async ({ page }) => {
    await page.goto("/");
    const repoPath = path.resolve(process.cwd());
    await page.fill("#contractRepoPath", repoPath);
    await page.fill("#contractMaxFiles", "2500");
    await page.fill("#contractMaxFileBytes", "786432");

    await clickLikeHuman(page, page.locator("#runContractGap"));
    await expect(page.locator("#contractGapOutput")).toContainText("coveragePct=");
    await expect(page.locator("#contractGapOutput")).toContainText("missingBackend=");
  });

  test("Streaming chat flow keeps session continuity across reload", async ({ page }) => {
    await page.goto("/");
    await page.fill("#chatMsg", "Give me a concise plan for launch-ready execution.");

    await clickLikeHuman(page, page.locator("#sendChatStream"));
    await expect(page.locator("#chatState")).toContainText("Done via", { timeout: 30_000 });
    await expect(page.locator("#chatRows")).toContainText("Mock assistant reply for:");

    const sessionId = (await page.inputValue("#chatSessionId")).trim();
    expect(sessionId.length).toBeGreaterThan(6);

    await page.reload();
    await clickLikeHuman(page, page.locator("#refreshSessions"));
    await expect(page.locator("#sessionList")).toContainText(sessionId.slice(0, 8), { timeout: 20_000 });
  });
});
