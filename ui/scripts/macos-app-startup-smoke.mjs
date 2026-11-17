import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

let releaseStatus, releaseLaunch;
const statusReady = new Promise(resolve => { releaseStatus = resolve; });
const launchReady = new Promise(resolve => { releaseLaunch = resolve; });
let launching = true, framesReady = false, contentReady = false, frameRequests = 0, launches = 0;
const { page, browser, errors } = await createWorkbench({
  async beforeNavigate(page, state) {
    state.account.guest_system = "macos";
    state.status.vm_running = state.status.ready = true;
    await page.route("**/api/macos/claude/window", async route => {
      const { action } = route.request().postDataJSON();
      if (action === "status") {
        await statusReady;
        return route.fulfill({ json: { installed:true, running:!launching, screen:true, input:true } });
      }
      if (action === "launch") {
        launches++;
        await launchReady;
        launching = false;
        return route.fulfill({ json: { ok:true } });
      }
      if (action === "frame") {
        frameRequests++;
        if (!framesReady) return route.fulfill({ json: { error:"no_visible_window" } });
        const image = await page.evaluate(ready => {
          const canvas = document.createElement("canvas");
          canvas.width=600; canvas.height=560;
          const ctx=canvas.getContext("2d");
          ctx.fillStyle="#f7f5f1"; ctx.fillRect(0,0,600,560);
          if (ready) { ctx.fillStyle="#202020"; ctx.font="24px sans-serif"; ctx.fillText("Claude",60,100); }
          return canvas.toDataURL().split(",")[1];
        }, contentReady);
        return route.fulfill({ json: { window:70,pid:23,image,contentWidth:600,contentHeight:560,geometry:"ready" } });
      }
      if (action === "stop") launching = true;
      return route.fulfill({ json: { ok:true } });
    });
  },
});
try {
  await page.getByRole("button", { name:"Claude Desktop",exact:true }).click();
  const pane = page.locator(".mac-claude-frame");
  await pane.getByRole("status").waitFor({ timeout:1500 });
  assert.match(await pane.innerText(), /正在连接/);
  releaseStatus();
  await pane.getByText("正在启动 Claude Desktop").waitFor();
  assert.equal(await page.getByRole("button", { name:"打开应用",exact:true }).count(), 0);
  releaseLaunch();
  await page.waitForFunction(() => document.querySelector(".mac-claude-frame")?.textContent.includes("正在连接窗口画面"));
  await page.waitForTimeout(2600);
  assert.ok(frameRequests > 0);
  assert.equal(await page.getByRole("alert").count(), 0);
  assert.equal(launches, 1);
  framesReady = true;
  await pane.getByRole("img").waitFor();
  await page.waitForFunction(()=>document.querySelector(".mac-claude-frame img")?.naturalWidth===600);
  assert.equal(await pane.getByRole("status").count(),1,"a blank native frame is still loading");
  assert.equal(await page.getByRole("button", {name:"添加附件",exact:true}).isDisabled(),true);
  contentReady = true;
  await page.waitForFunction(() => !document.querySelector(".mac-claude-frame [role=status]"));
  assert.equal(await pane.getAttribute("aria-busy"), "false");

  // A manual launch starts feedback immediately and does not launch a second
  // time when the status still reports the old, stopped process.
  await page.getByRole("button", { name:"关闭应用",exact:true }).click();
  await page.getByRole("dialog").getByRole("button", { name:"关闭应用",exact:true }).click();
  await pane.getByText("Claude Desktop 已关闭").waitFor();
  assert.equal(await pane.getByRole("status").count(), 0);
  await page.getByRole("button", { name:"打开应用",exact:true }).click();
  await pane.getByRole("img").waitFor();
  assert.equal(launches, 2);
  assert.deepEqual(errors, []);
  console.log("Immediate loading, delayed launch/window, automatic recovery, and stopped/reopen states passed.");
} finally {
  releaseStatus(); releaseLaunch();
  await browser.close();
}
