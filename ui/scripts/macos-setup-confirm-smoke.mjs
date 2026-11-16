import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

const permissions = { screen: false, input: false, projects: false, sharing: false, managed_credential: true, authorization_user: "trial" };
let hold, release;
const nativeCalls = [];
const f = await createWorkbench({ nativeRequest: body => { nativeCalls.push(body); return true; }, beforeNavigate: async (page, state) => {
  Object.assign(state.account, { initial_mac_setup: true, guest_system: "macos", macos_guest_user: "trial" });
  Object.assign(state.status, { ready: true, vm_running: true });
  const frame = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 1600; canvas.height = 1000;
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.route("**/api/macos/first-setup", async route => {
    const { action } = route.request().postDataJSON();
    if (action === "permissions") { if (hold) await hold; return route.fulfill({ json: permissions }); }
    if (action === "open") return route.fulfill({ json: { session: "confirm-fixture" } });
    if (action === "frame") return route.fulfill({ json: { image: frame } });
    return route.fulfill({ json: {} });
  });
} });
try {
  const { page } = f;
  const view = page.getByRole("dialog", { name: "首次设置虚拟 Mac" });
  await view.getByRole("img").waitFor();
  await view.getByText("出现管理员密码窗口时怎么填？", { exact: true }).click();
  await view.getByText("trial", { exact: true }).waitFor();
  assert.equal(await view.getByText("cagesetup", { exact: true }).count(), 0, "unified account instructions still named the legacy administrator");
  await view.getByRole("button", { name: "我已开启，检查并继续", exact: true }).click();
  await view.getByText(/尚未检测到「窗口录制」已开启/).waitFor();
  assert.equal(await view.getByText(/第\s+1\s+\/\s+4\s+项/).count(), 1, "manual confirmation skipped a missing permission");

  hold = new Promise(resolve => { release = resolve; });
  const inFlight = page.waitForRequest(request => request.url().endsWith("/api/macos/first-setup") && request.postDataJSON()?.action === "permissions");
  await inFlight;
  await view.getByRole("button", { name: "我已开启，检查并继续", exact: true }).click();
  await view.getByRole("button", { name: "正在检查…", exact: true }).waitFor();
  await view.getByText("正在检查刚才的设置，请稍候…", { exact: true }).waitFor();
  permissions.screen = true;
  release(); hold = undefined;
  await view.getByText(/第\s+2\s+\/\s+4\s+项/).waitFor();

  const fit = nativeCalls.find(call => call.action === "guestWorkspace" && call.active);
  assert.equal(fit.aspect, 1.6, "native window did not receive the guest aspect");
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.addStyleTag({ content: '.mac-login-stage::-webkit-scrollbar { width: 15px; height: 15px; }' });
  await page.waitForFunction(() => {
    const stage = document.querySelector(".mac-login-stage").getBoundingClientRect();
    const image = document.querySelector(".mac-login-canvas img").getBoundingClientRect();
    return [stage.x-image.x, stage.y-image.y, stage.width-image.width, stage.height-image.height].every(d => Math.abs(d) < 1);
  });
  assert.equal(await view.locator('.mac-login-stage').evaluate(el => el.clientWidth < el.getBoundingClientRect().width || el.clientHeight < el.getBoundingClientRect().height), false, "fit reserved space for system scrollbars");
  await view.getByRole("button", { name: "返回设置指引", exact: true }).click();
  await page.getByRole("heading", { name: "完成虚拟 Mac 的系统授权" }).waitFor();
  assert.ok(nativeCalls.some(call => call.action === "guestWorkspace" && !call.active), "returning to the guide did not release the window constraint");
  assert.deepEqual(f.errors, []);
  console.log("PASS explicit confirmation waits visibly, retains missing steps, advances verified permissions and fits/releases the native workspace");
} finally { release?.(); await f.browser.close(); }
