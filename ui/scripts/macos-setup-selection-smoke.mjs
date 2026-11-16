import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createWorkbench } from "./workbench-fixture.mjs";

const evidence = process.env.CAGE_SETUP_SELECTION_EVIDENCE;
if (evidence) await fs.mkdir(evidence, { recursive: true });
const previousBrowser = process.env.CAGE_TEST_BROWSER;
try {
  for (const engine of ["chromium", "webkit"]) {
    process.env.CAGE_TEST_BROWSER = engine;
    const f = await createWorkbench({ viewport: { width: 1539, height: 1020 }, beforeNavigate: async (page, state) => {
      Object.assign(state.account, { initial_mac_setup: true, guest_system: "macos" });
      Object.assign(state.status, { ready: true, vm_running: true });
      await page.route("**/api/macos/first-setup", route => route.fulfill({ json: { screen: false, input: false, projects: false, sharing: false, managed_credential: false } }));
    } });
    try {
      const { page } = f;
      const instruction = page.locator(".mac-setup-instructions li").first();
      await instruction.waitFor();
      await page.locator(".initialization-content").evaluate(async element => {
        await document.fonts.ready;
        await Promise.all(element.getAnimations().map(animation => animation.finished));
      });
      const area = await instruction.evaluate(element => {
        const text = element.firstChild, offset = text.textContent.indexOf("（打开");
        const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1);
        const first = range.getBoundingClientRect();
        range.setStart(text, text.textContent.length - 1); range.setEnd(text, text.textContent.length);
        const last = range.getBoundingClientRect();
        const next = element.nextElementSibling.getBoundingClientRect();
        const panel = element.closest(".mac-setup-task").getBoundingClientRect();
        return {
          start: { x: first.x + 1, y: first.y + first.height / 2 },
          end: { x: next.x + 1, y: next.y + 10 },
          outside: { x: Math.ceil(panel.right + 16), y: Math.floor(first.y), width: 80, height: Math.ceil(first.height) },
          inside: { x: Math.floor(first.x), y: Math.floor(first.y), width: Math.floor(last.right - first.x), height: Math.ceil(first.height) },
        };
      });
      const beforeOutside = await page.screenshot({ clip: area.outside });
      const beforeInside = await page.screenshot({ clip: area.inside });
      await page.mouse.move(area.start.x, area.start.y); await page.mouse.down();
      await page.mouse.move(area.end.x, area.end.y, { steps: 8 }); await page.mouse.up();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const selected = await page.evaluate(() => getSelection().toString());
      assert.equal(selected.trim(), "（打开系统设置）。", "drag selected the wrong text");
      const afterOutside = await page.screenshot({ clip: area.outside });
      const afterInside = await page.screenshot({ clip: area.inside });
      if (evidence) await page.screenshot({ path: `${evidence}/${engine}-selection.png` });
      // DOM range bounds are correct even in the failing WebKit renderer. Check
      // the painted pixels as well as the selected text, without an image library.
      assert.ok(beforeOutside.equals(afterOutside), `${engine}: selection paint escaped the instruction panel`);
      assert.ok(!beforeInside.equals(afterInside), `${engine}: selected text lost its visible highlight`);
      await page.evaluate(() => document.addEventListener("copy", event => {
        window.setupCopiedSelection = getSelection().toString(); event.preventDefault();
      }, { once: true }));
      await page.keyboard.press(process.platform === "darwin" ? "Meta+c" : "Control+c");
      assert.equal(await page.evaluate(() => window.setupCopiedSelection), selected, "copy no longer receives the selected text");
      assert.deepEqual(f.errors, []);
      console.log(`PASS ${engine}: cross-line selection stays inside guidance, text remains highlighted and copy receives the selection`);
    } finally { await f.browser.close(); }
  }
} finally {
  if (previousBrowser === undefined) delete process.env.CAGE_TEST_BROWSER;
  else process.env.CAGE_TEST_BROWSER = previousBrowser;
}
