import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

const chrome = process.argv.includes("--chrome");
const http = process.argv.includes("--http");
const base = chrome ? "/api/macos-browser" : "/api/macos/claude";
const app = chrome ? "Google Chrome" : "Claude Desktop";
const subscriptions = [], inputs = [];
let image, failPointer = false, failureReason = "window_changed", holdFrames = false, releaseFrame;
const status = { installed:true, running:true, screen:true, input:true, persistent:!http, push_frames:!http, ...(chrome ? { surface:"browser" } : {}) };
function respond(request) {
  inputs.push(request);
  if (request.action === "status") return status;
  if (failPointer && request.action === "pointer" && request.phase === "down") {
    failPointer = false;
    return { error:failureReason };
  }
  return { ok:true };
}
const { page, browser, errors } = await createWorkbench({
  async beforeNavigate(page, state) {
    state.account.guest_system = state.status.guest_system = "macos";
    state.status.vm_running = state.status.ready = true;
    image = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 480;
      const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0,0,640,480);
      ctx.fillStyle = "black"; ctx.font = "24px sans-serif"; ctx.fillText("Native application",40,80);
      return canvas.toDataURL().split(",")[1];
    }), "base64");
    await page.route("**" + base + "/window", async route => {
      const request = route.request().postDataJSON();
      if (request.action !== "frame") return route.fulfill({ json:respond(request) });
      subscriptions.push(request);
      if (holdFrames) await new Promise(resolve => { releaseFrame = resolve; });
      // The legacy channel may return the exact same data URL after reconnect.
      return route.fulfill({ json:{ image:image.toString("base64"), pid:23, window:70, geometry:"geometry-1", contentWidth:640, contentHeight:480 } });
    });
    await page.routeWebSocket("**" + base + "/connection**", socket => socket.onMessage(data => {
      const { id, request } = JSON.parse(data);
      socket.send(JSON.stringify({ id, result:respond(request) }));
    }));
    await page.routeWebSocket("**" + base + "/frames**", socket => socket.onMessage(data => {
      const config = JSON.parse(data);
      if (config.ack) return;
      subscriptions.push(config);
      const send = () => {
        const header = Buffer.from(JSON.stringify({ imageLength:image.length, mime:"image/png", sequence:"frame-" + subscriptions.length,
          revision:config.revision, geometry:"geometry-1", pid:23, window:70, contentWidth:640, contentHeight:480 }));
        const size = Buffer.alloc(4); size.writeUInt32BE(header.length);
        socket.send(Buffer.concat([size, header, image]));
      };
      if (holdFrames) releaseFrame = send; else send();
    }));
  },
});
try {
  await page.getByRole("button", {name:chrome ? "打开浏览器" : app, exact:true}).click();
  const pane = page.locator(".mac-claude-frame"), surface = page.getByAltText(app + " 客机窗口");
  await page.waitForFunction(() => document.querySelector(".mac-claude-frame")?.getAttribute("aria-busy") === "false");
  const before = await pane.boundingBox();
  holdFrames = true; failPointer = true;
  await surface.click({position:{x:100,y:100}});
  await page.waitForFunction(() => document.querySelector(".mac-claude-frame")?.getAttribute("aria-busy") === "true", null, {timeout:2000});
  assert.equal(await page.getByRole("alert").count(),0,"normal window synchronization must not show a retry error");
  assert.deepEqual(await pane.boundingBox(),before,"input recovery must not resize the guest viewport");
  assert.equal(await surface.count(),1,"keep the last image while resynchronizing");
  const clicks = inputs.filter(input => input.action === "pointer" && input.phase === "down").length;
  assert.equal(clicks,1,"never replay a click against a changed window");
  holdFrames = false;
  await page.waitForFunction(() => Boolean(document.querySelector(".mac-window-notice")));
  for (let i=0; !releaseFrame && i<100; i++) await page.waitForTimeout(20);
  assert(releaseFrame,"input failure must reacquire a frame automatically");
  releaseFrame();
  // A new frame subscription must be automatic, without a user retry click.
  await page.waitForFunction(() => document.querySelector(".mac-claude-frame")?.getAttribute("aria-busy") === "false");
  assert.deepEqual(await pane.boundingBox(),before);
  await surface.click({position:{x:180,y:140}});
  for (let i=0; !inputs.some(input => input.action === "pointer" && input.phase === "up") && i<100; i++) await page.waitForTimeout(20);
  assert(inputs.some(input => input.action === "pointer" && input.phase === "up" && input.geometry === "geometry-1"),"the recovered surface must receive input even when its geometry and pixels are unchanged");
  assert.equal(inputs.filter(input => input.action === "launch").length,1,"resynchronization must not relaunch the app");
  if (!http) {
    const count = subscriptions.length;
    failPointer = true; failureReason = "accessibility_permission";
    await surface.click({position:{x:180,y:140}});
    await page.getByRole("alert").waitFor();
    assert.match(await page.getByRole("alert").innerText(),/辅助功能/);
    assert.deepEqual(await pane.boundingBox(),before,"real errors must not resize the guest viewport either");
    assert.equal(subscriptions.length,count,"real permission failures must not trigger a reconnect loop");
  }
  assert.deepEqual(errors,[]);
  console.log(app + (http ? " (HTTP)" : " (push)") + ": changed window synchronizes automatically without layout shift, click replay or relaunch.");
} finally { await browser.close(); }
