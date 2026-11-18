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

// The recovery record exists during ordinary provisioning too. Only the
// accepted GUI mode may present it while a job is running.
{
  const f = await createWorkbench({
    initialization: { required: true, tracked: true, started: true },
    waitForReady: false,
    beforeNavigate: async (page, state) => {
      state.status.job = { id: "provisioning", kind: "guest-install", running: true, setup_progress: { system: "macos", phase: "tools", label: "正在安装客机应用和开发工具" } };
      await page.route("**/api/environment/guest-systems", route => route.fulfill({ json: { system: "macos", available: true, pending: { system: "macos", id: "existing-disk" } } }));
      await page.route("**/api/macos/install-recovery", route => route.fulfill({ json: { available: true, running: true, phase: "awaiting_gui_authorization" } }));
    },
  });
  try {
    const recovery = f.page.getByRole("region", { name: "恢复 macOS 组件安装", exact: true });
    await f.page.getByRole("heading", { name: "正在安装客机应用和开发工具", exact: true }).waitFor();
    await f.page.waitForResponse("**/api/macos/install-recovery");
    assert.equal(await recovery.count(), 0, "ordinary provisioning must not request manual recovery");
    f.state.status.job.gui_authorization = true;
    await recovery.getByRole("button", { name: "打开恢复画面", exact: true }).waitFor();
    await f.page.getByText(/请保持恢复画面开启，安装器出现后/).waitFor();
    delete f.state.status.job.gui_authorization;
    f.state.status.job.running = false;
    f.state.status.job.error = "安装器需要手动授权";
    await recovery.getByRole("button", { name: "打开恢复画面", exact: true }).waitFor();
    assert.deepEqual(f.errors, []);
    console.log("PASS macOS recovery guidance: automatic provisioning stays quiet; GUI mode and actual failures expose recovery");
  } finally { await f.browser.close(); }
}

// Activation retires the installer controller. Reconnect through the existing
// gateway candidate/commit flow so the wizard does not strand the user in SSH.
{
  let activated = false, committed = false, connections = 0, commitSeen;
  const nativeCalls = [];
  let current = { mode: "local", connection_id: "installer", desktop_gateway: true, client_platform: "darwin", server_platform: "darwin", connection: { state: "connected" } };
  const f = await createWorkbench({
    initialization: { required: true, tracked: true, started: true },
    clientContext: current,
    waitForReady: false,
    nativeRequest: message => { nativeCalls.push(message.action); return null; },
    beforeNavigate: async (page, state) => {
      commitSeen = page.waitForRequest("**/api/client/commit", {timeout:15000});
      await page.route("**/api/macos/first-setup", route => route.fulfill({ json: { screen:false, input:false, projects:false, sharing:false } }));
      await page.route("**/api/client/context", route => route.fulfill({ json: current }));
      await page.route("**/api/environment/guest-systems", route => route.fulfill({ json: activated ? {} : { available: true, activate: true, pending: { system: "macos", id: "finished-install" } } }));
      await page.route("**/api/environment/guest-systems/activate", route => { activated = true; return route.fulfill({ json: { stopping: true } }); });
      await page.route("**/api/client/candidate", route => {
        assert.equal(route.request().postDataJSON().mode, "local");
        connections++;
        return route.fulfill({ json: { id: "new-controller", mode: "local", connection: { state: "connected" } } });
      });
      await page.route("**/api/client/commit", route => {
        assert.equal(route.request().postDataJSON().candidate_id, "new-controller");
        committed = true;
        Object.assign(state.account, { guest_system:"macos", initial_mac_setup:true });
        Object.assign(state.status, { ready:true, vm_running:true });
        current = { ...current, connection_id: "installed" };
        return route.fulfill({ json: { connected: true } });
      });
    },
  });
  try {
    await commitSeen;
    await f.page.getByRole("heading", {name:"完成虚拟 Mac 的系统授权", exact:true}).waitFor();
    assert.ok(activated && committed);
    assert.equal(connections, 1);
    assert.equal(nativeCalls.filter(action => action === "reconnect").length, 0, "native reload keeps a stale selected installer controller");
    assert.deepEqual(f.errors, []);
    console.log("PASS macOS activation: controller handoff automatically reconnects the local gateway without manual SSH navigation");
  } finally { await f.browser.close(); }
}

// A changed gate configuration cannot be repaired by repeating the same check.
// Keep the restart action reachable even after the in-memory job is replaced.
for (const source of ["job", "safety"]) {
  let stops = 0, starts = 0, checks = 0;
  const f = await createWorkbench({
    initialization: { required: true, tracked: true, started: true },
    beforeNavigate: async (page, state) => {
      state.account.guest_system = "macos";
      Object.assign(state.status, { guest_system: "macos", vm_running: true, ready: true, workspace: "", job: {}, safety: { gate: { mode: "closed" } } });
      state.status[source].error = "出口地址或环境设置变化需要重启环境";
      await page.route("**/api/stop", route => {
        stops++;
        state.status.vm_running = false;
        state.status.ready = false;
        state.status.job = { id: "stop-config", kind: "stop", running: false };
        return route.fulfill({ json: state.status.job });
      });
      await page.route("**/api/start", route => {
        assert.equal(state.status.vm_running, false);
        starts++;
        state.status.job = { id: "start-config", kind: "start", running: true };
        return route.fulfill({ json: state.status.job });
      });
      await page.route("**/api/safety/check", route => { checks++; return route.fulfill({ json: {} }); });
    },
  });
  try {
    const restart = f.page.getByRole("button", { name: "保存后重启并检查", exact: true });
    await restart.waitFor();
    assert.equal(await f.page.getByRole("button", { name: "重新检查并继续", exact: true }).count(), 0);
    await restart.click();
    const dialog = f.page.getByRole("dialog", { name: "重启虚拟 Mac 并检查？", exact: true });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(stops + starts, 0);
    await restart.click();
    const started = f.page.waitForResponse("**/api/start");
    await dialog.getByRole("button", { name: "重启并检查", exact: true }).click();
    await started;
    await f.page.getByRole("button", { name: "停止安装", exact: true }).waitFor();
    assert.equal(stops, 1); assert.equal(starts, 1); assert.equal(checks, 0);
    assert.deepEqual(f.errors, []);
    console.log(`PASS macOS changed configuration: ${source} failure routes to confirmed stop-before-start instead of a check loop`);
  } finally { await f.browser.close(); }
}
