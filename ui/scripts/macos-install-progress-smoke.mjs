import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

for (const canPrepare of [false, true]) {
  const f = await createWorkbench({
    initialization: { required: true, tracked: true, started: true },
    waitForReady: false,
    beforeNavigate: async (page, state) => {
      state.status.job = { id: "download", kind: "guest-install", running: true, message: "正在准备 macOS 官方系统镜像…", setup_progress: { system: "macos", phase: "image", operation: "download", label: "正在下载 macOS 系统镜像", received: 1024 ** 3, total: 20 * 1024 ** 3 } };
      await page.route("**/api/environment/guest-systems", route => route.fulfill({ json: { fresh: true, system: "macos", available: true, pending: { system: "macos", id: "pending-install" } } }));
      await page.route("**/api/macos/install-recovery", route => route.fulfill({ json: { available: false, can_prepare: canPrepare } }));
      await page.route("**/api/stop", route => {
        state.status.job = { id: "stop", kind: "stop", running: false, message: "已完成" };
        return route.fulfill({ json: state.status.job });
      });
    },
  });
  try {
    const { page } = f;
    await page.getByRole("heading", { name: "正在下载 macOS 系统镜像", exact: true }).waitFor();
    await page.waitForResponse("**/api/macos/install-recovery");
    assert.equal(await page.getByRole("region", { name: "macOS 安装恢复", exact: true }).count(), 0, "a normal active download must not offer recovery");
    assert.equal(await page.getByText(/macOS 27/).count(), 0);
    assert.equal(await page.getByRole("button", { name: "继续原安装", exact: true }).count(), 0);
    await page.getByRole("button", { name: "停止安装", exact: true }).click();
    await page.getByRole("dialog", { name: "停止当前安装？", exact: true }).getByRole("button", { name: "停止安装", exact: true }).click();
    await page.getByRole("heading", { name: "安装已停止，可以继续", exact: true }).waitFor();
    await page.getByRole("button", { name: "继续安装", exact: true }).waitFor();
    await page.getByText("安装已停止，已有下载和磁盘会保留。点击「继续安装」接着完成。", { exact: true }).waitFor();
    if (canPrepare) await page.getByRole("button", { name: "准备恢复入口", exact: true }).waitFor();
    else assert.equal(await page.getByRole("button", { name: "准备恢复入口", exact: true }).count(), 0);
    assert.deepEqual(f.errors, []);
    console.log(`PASS macOS real-install regressions: active download has no recovery, stopped is not completed, recoverable=${canPrepare}`);
  } finally { await f.browser.close(); }
}

// A download can be stopped to select existing local media while no disk exists.
for (const reselect of [true, false]) {
  let cleared = false, chosenMedia = "";
  const f = await createWorkbench({
    initialization: { required: true, tracked: true, started: true },
    waitForReady: false,
    nativeRequest: async request => request.action === "chooseGuestMedia" ? "/existing/macOS.ipsw" : null,
    beforeNavigate: async (page, state) => {
      state.status.job = { id: "stopped", kind: "stop", running: false, message: "已完成" };
      await page.route("**/api/environment/storage", route => route.fulfill({ json: { directory: "/preview/state", has_environment: false } }));
      await page.route("**/api/environment/guest-profile", route => route.fulfill({ json: { editable: false } }));
      await page.route("**/api/environment/guest-systems", route => {
        if (route.request().method() === "DELETE") {
          assert.ok(reselect, "a started disk cannot be reselected");
          assert.equal(route.request().postDataJSON().id, "pending-install");
          cleared = true;
          return route.fulfill({ json: { cleared: true } });
        }
        return route.fulfill({ json: { fresh: true, system: "macos", available: true, reselect: reselect && !cleared, ...(cleared ? {} : { pending: { system: "macos", id: "pending-install" } }) } });
      });
      await page.route("**/api/macos/install-recovery", route => route.fulfill({ json: { available: false, can_prepare: false } }));
      await page.route("**/api/start", route => {
        chosenMedia = route.request().postDataJSON().media;
        state.status.job = { id: "local-media", kind: "guest-install", running: true, setup_progress: { phase: "packages", system: "macos", label: "正在安装 macOS 系统" } };
        return route.fulfill({ json: state.status.job });
      });
    },
  });
  try {
    const button = f.page.getByRole("button", { name: "改用已有镜像或重新选择系统", exact: true });
    await f.page.getByRole("heading", { name: "安装已停止，可以继续", exact: true }).waitFor();
    await f.page.waitForResponse("**/api/environment/guest-systems");
    if (!reselect) { assert.equal(await button.count(), 0); continue; }
    await button.click();
    await f.page.getByRole("button", { name: "重新选择系统或镜像", exact: true }).click({timeout:5000});
    const picker = f.page.getByRole("combobox", { name: "客户机系统", exact: true });
    await picker.click();
    await f.page.getByRole("option", { name: "macOS", exact: true }).click();
    await f.page.getByRole("button", { name: "选择本机 IPSW", exact: true }).click();
    await f.page.getByText("/existing/macOS.ipsw", { exact: true }).waitFor();
    await f.page.getByRole("button", { name: "下一步：配置代理", exact: true }).click();
    await f.page.getByRole("button", { name: "开始安装", exact: true }).click();
    await f.page.getByRole("heading", { name: "正在安装 macOS 系统", exact: true }).waitFor();
    assert.equal(chosenMedia, "/existing/macOS.ipsw", "stale pending state discarded the new local media");
    assert.deepEqual(f.errors, []);
    console.log("PASS macOS local media: stop → reselect → existing IPSW reaches install without stale pending choice");
  } finally { await f.browser.close(); }
}
