import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

for (const scenario of ["restart", "check-retry", "completion-reject", "guest-login", "canceled"]) {
  let stops = 0, starts = 0, checks = 0, completes = 0, releaseCheck, rejectComplete = true;
  const f = await createWorkbench({ initialization: { required: true, tracked: true, started: true }, beforeNavigate: async (page, state) => {
    state.account.guest_system = "macos";
    state.settings.workspace = "";
    Object.assign(state.status, { guest_system: "macos", ready: true, vm_running: true, workspace: "", safety: { gate: { mode: "closed" } }, job: { running: false } });
    if (scenario === "restart") state.status.safety.error = "出口地址或环境设置变化需要重启环境";
    if (scenario === "guest-login") state.status.job = { running: false, recovery: "guest-login", error: "请登录虚拟 Mac 后继续" };
    if (scenario === "canceled") state.status.job = { running: false, kind: "stop", canceled: true };
    const openGate = () => { state.status.safety = { gate: { mode: "open", until: new Date(Date.now()+3600000).toISOString() } }; };
    if (scenario === "completion-reject") openGate();
    await page.route("**/api/stop", route => {
      stops++;
      Object.assign(state.status, { ready: false, vm_running: false, job: { id: "auto-stop", kind: "stop", running: false } });
      return route.fulfill({ json: state.status.job });
    });
    await page.route("**/api/start", route => {
      assert.equal(state.status.vm_running, false, "automatic restart started before stop completed");
      starts++;
      Object.assign(state.status, { ready: true, vm_running: true, job: { id: "auto-start", kind: "start", running: false } });
      openGate();
      return route.fulfill({ json: state.status.job });
    });
    await page.route("**/api/safety/check", async route => {
      checks++;
      if (checks === 1) await new Promise(resolve => { releaseCheck = resolve; });
      state.status.job = { id: `check-${checks}`, kind: "safety", running: false, ...(checks === 1 ? { error: "测试：浏览器暂时不可用，请重试" } : {}) };
      if (checks > 1) openGate();
      return route.fulfill({ json: state.status.job });
    });
    await page.route("**/api/environment/initialization", route => {
      const action = route.request().method() === "POST" ? route.request().postDataJSON()?.action : "";
      if (action === "complete") {
        assert.equal(state.status.safety.gate.mode, "open", "completion skipped the verified network gate");
        completes++;
        if (scenario === "completion-reject" && rejectComplete) return route.fulfill({ status: 409, body: "最终检查状态已变化，请重试" });
        state.initialization.required = false;
      }
      return route.fulfill({ json: state.initialization });
    });
  } });
  try {
    const { page } = f;
    if (scenario === "restart") {
      await page.getByRole("complementary", { name: "项目与终端" }).waitFor();
      assert.equal(stops, 1); assert.equal(starts, 1); assert.equal(completes, 1);
      assert.equal(await page.getByRole("dialog").count(), 0, "routine installation restart asked for another click");
    } else if (scenario === "check-retry") {
      await page.getByText("正在检查文件访问和网络连接，通过后自动打开工作台…", { exact: true }).waitFor();
      releaseCheck();
      await page.getByText("测试：浏览器暂时不可用，请重试", { exact: true }).waitFor();
      for (let i=0;i<2;i++) await page.waitForResponse(response => response.url().endsWith("/api/status"));
      assert.equal(checks, 1, "failed checks retried indefinitely"); assert.equal(completes, 0);
      await page.getByRole("button", { name: "重新检查并继续", exact: true }).click();
      await page.getByRole("complementary", { name: "项目与终端" }).waitFor();
      assert.equal(checks, 2); assert.equal(completes, 1);
    } else if (scenario === "completion-reject") {
      await page.getByRole("alert").filter({ hasText: "最终检查状态已变化" }).waitFor();
      for (let i=0;i<2;i++) await page.waitForResponse(response => response.url().endsWith("/api/status"));
      assert.equal(completes, 1, "rejected completion retried indefinitely");
      rejectComplete = false;
      await page.getByRole("button", { name: "进入工作台", exact: true }).click();
      await page.getByRole("complementary", { name: "项目与终端" }).waitFor();
      assert.equal(completes, 2);
    } else {
      await page.getByRole("heading", { name: "系统已安装，完成使用检查", exact: true }).waitFor();
      for (let i=0;i<2;i++) await page.waitForResponse(response => response.url().endsWith("/api/status"));
      assert.equal(stops+starts+checks+completes, 0, "automation bypassed a login requirement or explicit stop");
    }
    assert.deepEqual(f.errors, []);
    console.log(`PASS installation automation ${scenario}: mechanical steps continue; failures and user decisions remain explicit`);
  } finally { releaseCheck?.(); await f.browser.close(); }
}
