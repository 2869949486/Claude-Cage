import assert from "node:assert/strict";
import { createWorkbench } from "./workbench-fixture.mjs";

let activeSocket, configuration, image, blankImage, acknowledgements = 0, subscriptions = 0, launches = 0;
let missing = true;
const status = { installed:true, running:true, screen:true, input:true, persistent:true, push_frames:true };
function sendFrame(error, blank = false) {
  const pixels = blank ? blankImage : image;
  const header = Buffer.from(JSON.stringify(error ? { revision:configuration.revision, imageLength:0, error } : {
    revision:configuration.revision, imageLength:pixels.length, mime:"image/png", sequence:blank ? "blank" : "ready", geometry:"ready", window:70,pid:23,contentWidth:600,contentHeight:560,
  }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  activeSocket.send(Buffer.concat([length, header, error ? Buffer.alloc(0) : pixels]));
}
const { page, browser, errors } = await createWorkbench({
  async beforeNavigate(page, state) {
    state.account.guest_system = "macos";
    state.status.vm_running = state.status.ready = true;
    const images = await page.evaluate(() => {
      const canvas=document.createElement("canvas"); canvas.width=600;canvas.height=560;
      const ctx=canvas.getContext("2d"); ctx.fillStyle="#f7f5f1";ctx.fillRect(0,0,600,560);
      const blank=canvas.toDataURL().split(",")[1];
      ctx.fillStyle="#202020";ctx.font="24px sans-serif";ctx.fillText("Claude",60,100);
      return [blank,canvas.toDataURL().split(",")[1]];
    });
    [blankImage,image]=images.map(value=>Buffer.from(value,"base64"));
    await page.clock.install();
    await page.route("**/api/macos/claude/window", route => route.fulfill({ json:status }));
    await page.routeWebSocket("**/api/macos/claude/connection**", socket => socket.onMessage(data => {
      const {id,request}=JSON.parse(data);
      if (request.action === "launch") launches++;
      socket.send(JSON.stringify({ id,result:status }));
    }));
    await page.routeWebSocket("**/api/macos/claude/frames**", socket => {
      activeSocket=socket;
      socket.onMessage(data => {
        const request=JSON.parse(data);
        if (request.ack) { acknowledgements++; return; }
        configuration=request; subscriptions++;
        if (missing) sendFrame("no_visible_window");
        else sendFrame(undefined,true);
      });
    });
  },
});
async function until(condition) {
  const deadline=Date.now()+10000;
  while (!condition()) {
    assert.ok(Date.now()<deadline,"timed out waiting for push connection");
    await page.clock.runFor(200);
    await new Promise(resolve=>setTimeout(resolve,20));
  }
}
try {
  await page.getByRole("button", {name:"Claude Desktop",exact:true}).click();
  const pane=page.locator(".mac-claude-frame");
  await pane.getByRole("status").waitFor();
  await until(()=>subscriptions>0);
  assert.equal(await page.getByRole("alert").count(),0);
  await page.clock.fastForward(10000);
  await pane.getByText(/首次打开可能需要更长时间/).waitFor();
  await page.clock.fastForward(50000);
  await pane.getByRole("alert").waitFor();
  assert.equal(await pane.getByRole("status").count(),0);
  assert.equal(await pane.getAttribute("aria-busy"),"false");
  assert.equal(launches,1,"frame reconnects must not relaunch the app");
  missing=false;
  await page.getByRole("button", {name:"重新连接应用",exact:true}).click();
  const previous=subscriptions;
  await until(()=>subscriptions>previous);
  await pane.getByRole("img").waitFor();
  await until(()=>acknowledgements>0);
  assert.equal(await pane.getByRole("status").count(),1,"blank push frames must stay covered and be acknowledged");
  sendFrame();
  await page.waitForFunction(()=>document.querySelector(".mac-claude-frame")?.getAttribute("aria-busy")==="false");
  assert.equal(await pane.getByRole("status").count(),0);
  assert.equal(await page.getByRole("alert").count(),0);

  // Genuine permissions failures remain actionable immediately.
  sendFrame("screen_recording_permission");
  await pane.getByRole("alert").waitFor();
  assert.match(await pane.innerText(),/允许.*录制屏幕/);
  assert.deepEqual(errors,[]);
  console.log("Push-frame startup wait, slow guidance, bounded timeout, retry and immediate permission failure passed.");
} finally { await browser.close(); }
