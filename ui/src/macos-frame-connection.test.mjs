import assert from "node:assert/strict";
import test from "node:test";
import { macWindowVideoConfiguration, macWindowVideoSupported } from "./macos-frame-connection.mjs";

test("the decoder is configured from the encoder's own record", () => {
  const record = Uint8Array.from([1, 0x64, 0x00, 0x33, 0xff, 0xe1, 0, 1, 0x67, 1, 0, 1, 0x68]);
  const configuration = macWindowVideoConfiguration(Buffer.from(record).toString("base64"));
  assert.equal(configuration.codec, "avc1.640033");
  assert.deepEqual(Array.from(configuration.description), Array.from(record));
  assert.equal(configuration.optimizeForLatency, true);
  assert.equal(macWindowVideoConfiguration(Buffer.from([1, 0x4d, 0x40, 0x0a, 0xff, 0xe1, 0]).toString("base64")).codec, "avc1.4d400a");
});

test("a record that is not avcC cannot configure a decoder", () => {
  assert.throws(() => macWindowVideoConfiguration(Buffer.from([0, 0x64, 0, 0x33, 0xff, 0xe1, 0]).toString("base64")));
  assert.throws(() => macWindowVideoConfiguration(Buffer.from([1, 0x64, 0]).toString("base64")));
});

test("a viewer without a video decoder asks for still images", async () => {
  assert.equal(await macWindowVideoSupported({}), false);
});
