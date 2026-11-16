import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

for (const opened of [false, true]) {
  let reads = 0, settings = 0, frameClosed = true, holdRead;
  const f = await createWorkbench({ beforeNavigate: async (page, state) => {
    Object.assign(state.account, { initial_mac_setup: true, guest_system: "macos", macos_guest_user: "trial" });
    Object.assign(state.status, { ready: true, vm_running: true });
    const frame = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 100;
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.route("**/api/macos/first-setup", async route => {
      const { action } = route.request().postDataJSON();
      if (action === "permissions") {
        reads++;
        if (holdRead) await holdRead;
        else if (reads > 1) await new Promise(resolve => setTimeout(resolve, 350));
        return route.fulfill({ json: { screen: false, input: false, projects: false, sharing: false, managed_credential: true } });
      }
      if (action === "screen") settings++;
      if (action === "open") return route.fulfill({ json: { session: "polling-fixture" } });
      if (action === "frame") return route.fulfill({ json: frameClosed ? { closed: true } : { image: frame } });
      return route.fulfill({ json: {} });
    });
  } });
  try {
    const { page } = f;
    await page.getByText("本次设置画面已结束，已完成的授权会保留。重新打开画面即可继续。", { exact: true }).waitFor();
    if (opened) {
      frameClosed = false;
      await page.getByRole("button", { name: "打开客机画面", exact: true }).click();
      await page.getByRole("dialog", { name: "首次设置虚拟 Mac" }).getByRole("img").waitFor();
    }
    const scope = opened ? page.getByRole("dialog", { name: "首次设置虚拟 Mac" }) : page.getByRole("region", { name: "当前设置步骤" });
    await scope.getByRole("button", { name: "打开窗口录制", exact: true }).waitFor();
    await page.waitForFunction(opened => [...document.querySelectorAll(opened ? '.mac-login-tools button' : '.mac-setup-task button')].some(button => button.textContent === "打开窗口录制" && !button.disabled), opened);
    await scope.evaluate(element => {
      const snapshot = () => [...element.querySelectorAll("button")].map(button => [button.textContent, button.disabled]);
      const before = JSON.stringify(snapshot()); window.setupPollingChanges = [];
      window.setupPollingObserver = new MutationObserver(() => {
        const current = JSON.stringify(snapshot());
        if (current !== before) window.setupPollingChanges.push(current);
      });
      window.setupPollingObserver.observe(element, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["disabled"] });
    });
    for (let i = 0; i < 2; i++) await page.waitForResponse(response => response.url().endsWith("/api/macos/first-setup") && response.request().postDataJSON()?.action === "permissions");
    const changes = await page.evaluate(() => { window.setupPollingObserver.disconnect(); return window.setupPollingChanges; });
    assert.deepEqual(changes, [], `passive permission polling changed controls in ${opened ? "guest workspace" : "setup guidance"}`);

    // A user click made during a slow probe must wait for that probe, then run
    // once. Keeping controls stable must not turn clicks into ignored requests.
    let release;
    holdRead = new Promise(resolve => { release = resolve; });
    await page.waitForRequest(request => request.url().endsWith("/api/macos/first-setup") && request.postDataJSON()?.action === "permissions");
    const before = settings;
    await scope.getByRole("button", { name: "打开窗口录制", exact: true }).click();
    await scope.getByRole("button", { name: "正在处理…", exact: true }).waitFor();
    assert.equal(settings, before, "action overlapped the permission probe");
    const result = page.waitForResponse(response => response.url().endsWith("/api/macos/first-setup") && response.request().postDataJSON()?.action === "screen");
    release(); holdRead = undefined;
    await result;
    assert.equal(settings, before + 1, "queued click was dropped or repeated");
    await scope.getByRole("button", { name: "打开窗口录制", exact: true }).waitFor();
    assert.deepEqual(f.errors, []);
    console.log(`PASS ${opened ? "workspace" : "guidance"}: passive polling keeps controls stable; clicks during a probe execute once`);
  } finally { await f.browser.close(); }
}
