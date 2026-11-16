import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

let opens = 0, settings = 0, expired = true, failOpen = false;
const f = await createWorkbench({ beforeNavigate: async (page, state) => {
  Object.assign(state.account, { initial_mac_setup: true, guest_system: "macos", macos_guest_user: "trial" });
  Object.assign(state.status, { ready: true, vm_running: true });
  const frame = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 100;
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.route("**/api/macos/first-setup", async route => {
    const { action } = route.request().postDataJSON();
    if (action === "permissions") return route.fulfill({ json: { screen: false, input: false, projects: false, sharing: false, managed_credential: true } });
    if (action === "screen") settings++;
    if (action === "open") {
      opens++;
      return route.fulfill({ json: failOpen ? { error: "客机画面暂时无法连接，请重试" } : { session: `settings-${opens}` } });
    }
    if (action === "frame") return route.fulfill({ json: expired ? { closed: true } : { image: frame } });
    return route.fulfill({ json: {} });
  });
} });

try {
  const { page } = f;
  const guide = page.getByRole("region", { name: "当前设置步骤" });
  const viewer = page.getByRole("dialog", { name: "首次设置虚拟 Mac" });
  await guide.getByText("本次设置画面已结束，已完成的授权会保留。重新打开画面即可继续。", { exact: true }).waitFor();
  expired = false;
  await guide.getByRole("button", { name: "打开窗口录制", exact: true }).click();
  await viewer.getByRole("img").waitFor({ timeout: 5000 });
  assert.equal(opens, 2, "opening settings after session expiry did not reopen the guest view");

  const before = settings;
  await viewer.getByRole("button", { name: "打开窗口录制", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.mac-login-tools button')].some(b => b.textContent === "打开窗口录制" && !b.disabled));
  assert.equal(settings, before + 1, "settings navigation did not reach the guest");
  assert.equal(opens, 2, "navigation inside the guest view replaced its active session");

  await viewer.getByRole("button", { name: "返回设置指引", exact: true }).click();
  failOpen = true;
  await guide.getByRole("button", { name: "打开窗口录制", exact: true }).click();
  await guide.getByText("客机画面暂时无法连接，请重试", { exact: true }).waitFor();
  failOpen = false;
  await guide.getByRole("button", { name: "打开窗口录制", exact: true }).click();
  await viewer.getByRole("img").waitFor();
  assert.equal(opens, 4, "settings button did not retry a failed guest view connection");
  assert.deepEqual(f.errors, []);
  console.log("PASS settings button shows the guest after expiry/return, retries connection failures and preserves an active session");
} finally { await f.browser.close(); }
