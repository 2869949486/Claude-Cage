import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createWorkbench } from "./workbench-fixture.mjs";

const evidence = process.env.CAGE_SETUP_WORKSPACE_EVIDENCE;
if (evidence) await fs.mkdir(evidence, { recursive: true });
for (const [platform, viewport, mode] of [
  ["darwin", { width: 1280, height: 850 }, "light"],
  ["windows", { width: 1920, height: 1080 }, "dark"],
  ["linux", { width: 800, height: 600 }, "light"],
  ["darwin", { width: 375, height: 700 }, "dark"],
]) {
  const inputs = [];
  const f = await createWorkbench({ viewport,
    clientContext: { mode: "local", connection_id: "local", client_platform: platform, server_platform: platform },
    beforeNavigate: async (page, state) => {
      Object.assign(state.account, { initial_mac_setup: true, guest_system: "macos", macos_guest_user: "trial" });
      Object.assign(state.status, { ready: true, vm_running: true });
      state.appearance.mode = mode;
      const frame = await page.evaluate(() => {
        const canvas = document.createElement("canvas"); canvas.width = 1600; canvas.height = 1000;
        const p = canvas.getContext("2d"), sky = p.createLinearGradient(0, 0, 0, 1000);
        sky.addColorStop(0, "#2174a5"); sky.addColorStop(1, "#7198a4");
        p.fillStyle = sky; p.fillRect(0, 0, 1600, 1000);
        p.fillStyle = "#ffffffd9"; p.fillRect(0, 0, 1600, 28);
        p.fillStyle = "#202020"; p.font = "16px sans-serif"; p.fillText("System Settings", 28, 20);
        p.fillStyle = "#f7f7f7"; p.beginPath(); p.roundRect(420, 240, 780, 540, 18); p.fill();
        p.fillStyle = "#e5e9ec"; p.fillRect(420, 280, 220, 480);
        p.fillStyle = "#202020"; p.font = "22px sans-serif"; p.fillText("Screen & System Audio Recording", 670, 300);
        p.font = "18px sans-serif"; p.fillText("Cage Guest Window", 690, 415);
        p.fillStyle = "#c9ccce"; p.beginPath(); p.roundRect(1100, 395, 54, 28, 14); p.fill();
        p.fillStyle = "#fff"; p.beginPath(); p.arc(1114, 409, 11, 0, Math.PI*2); p.fill();
        return canvas.toDataURL("image/png").split(",")[1];
      });
      await page.route("**/api/macos/first-setup", route => {
        const q = route.request().postDataJSON();
        if (q.action === "permissions") return route.fulfill({ json: { screen: false, input: false, projects: false, sharing: false, managed_credential: true } });
        if (q.action === "open") return route.fulfill({ json: { session: "layout-fixture" } });
        if (q.action === "frame") return route.fulfill({ json: { image: frame } });
        if (q.action === "click") inputs.push(q);
        return route.fulfill({ json: {} });
      });
    },
  });
  try {
    const { page } = f;
    const screen = page.getByRole("dialog", { name: "首次设置虚拟 Mac", exact: true });
    const image = screen.getByRole("img"); await image.waitFor();
    await page.waitForFunction(() => document.querySelector(".mac-login-canvas img")?.naturalWidth === 1600);
    const stage = screen.locator(".mac-login-stage"), sidebar = screen.getByRole("complementary", { name: "系统设置指引" });
    const area = await stage.boundingBox();
    assert.equal(Math.round(area.height), viewport.height, "guidance consumed guest display height");
    if (viewport.width > 760) {
      const guide = await sidebar.boundingBox();
      assert.equal(Math.round(guide.x), 0); assert.equal(Math.round(guide.y), 0);
      assert.equal(Math.round(guide.width), 320);
      assert.equal(Math.round(area.x), 320); assert.equal(Math.round(area.width), viewport.width - 320);
    } else {
      assert.equal(await sidebar.isVisible(), false);
      assert.equal(Math.round(area.width), viewport.width);
      await screen.getByLabel(/^客机登录键盘/).press("F6");
      await sidebar.waitFor();
      assert.equal(await sidebar.getByRole("button", { name: "返回设置指引", exact: true }).evaluate(el => el === document.activeElement), true);
    }
    await sidebar.getByText("出现管理员密码窗口时怎么填？", { exact: true }).click();
    assert.deepEqual(await stage.boundingBox(), area, "opening help moved the guest display");
    const hint = sidebar.locator(".mac-setup-hint"), hintBox = await hint.boundingBox();
    await page.mouse.move(hintBox.x + hintBox.width / 2, hintBox.y + hintBox.height / 2);
    await page.mouse.wheel(0, 600);
    assert.deepEqual(await stage.boundingBox(), area, "sidebar scrolling moved the guest display");
    for (const name of ["返回设置指引", "打开窗口录制", "填写授权密码"]) {
      const button = await sidebar.getByRole("button", { name, exact: true }).boundingBox();
      assert.ok(button.y >= 0 && button.y + button.height <= viewport.height, "guidance hid an action below the viewport");
    }
    await sidebar.getByText("出现管理员密码窗口时怎么填？", { exact: true }).click();
    await hint.evaluate(el => { el.scrollTop = 0; });
    if (viewport.width <= 760) await screen.getByRole("button", { name: "收起指引", exact: true }).click();
    const frame = await image.boundingBox();
    assert.ok(frame.x >= area.x - 1 && frame.y >= area.y - 1 && frame.x + frame.width <= area.x + area.width + 1 && frame.y + frame.height <= area.y + area.height + 1, "fit cropped the guest frame");
    const x = Math.round(frame.x + frame.width * .7), y = Math.round(frame.y + frame.height * .4);
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith("/api/macos/first-setup") && response.request().postDataJSON()?.action === "click"),
      page.mouse.click(x, y),
    ]);
    assert.equal(inputs[0].x, Math.floor((x - frame.x) * 1024 / frame.width));
    assert.equal(inputs[0].y, Math.floor((y - frame.y) * 640 / frame.height));
    assert.equal(await screen.evaluate(el => el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth), false, "workspace requires outer scrolling");
    if (evidence) await page.screenshot({ path: `${evidence}/setup-${viewport.width}-${mode}.png` });
    assert.deepEqual(f.errors, []);
    console.log(`PASS ${platform} ${viewport.width} ${mode}: full-height desktop, sidebar-only scrolling, help, keyboard access and guest input coordinates`);
  } finally { await f.browser.close(); }
}
