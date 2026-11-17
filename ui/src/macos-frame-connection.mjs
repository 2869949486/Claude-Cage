import { runtimeSocketURL } from "./client-context.mjs";

// A viewer that can decode H.264 itself receives the window as video; every
// other viewer, and any viewer whose decoder fails, receives still images.
let videoFailures = 0, videoSupport;
export function macWindowVideoSupported(scope = globalThis) {
  if (videoFailures >= 2) return Promise.resolve(false);
  videoSupport ||= (async () => {
    try {
      if (typeof scope.VideoDecoder !== "function" || typeof scope.EncodedVideoChunk !== "function") return false;
      const result = await scope.VideoDecoder.isConfigSupported({ codec: "avc1.640033", optimizeForLatency: true });
      return result.supported === true;
    } catch { return false; }
  })();
  return videoSupport.then(supported => supported && videoFailures < 2);
}

// avcC carries the profile, constraint and level bytes the codec string names.
export function macWindowVideoConfiguration(encoded) {
  const text = atob(encoded);
  const description = Uint8Array.from(text, character => character.charCodeAt(0));
  if (description.length < 7 || description[0] !== 1) throw new Error("invalid video configuration");
  const codec = "avc1." + Array.from(description.subarray(1, 4), value => value.toString(16).padStart(2, "0")).join("");
  return { codec, description, optimizeForLatency: true };
}

export function createMacFrameConnection(onFrame, onError, base = "/macos/claude") {
  const socket = new WebSocket(runtimeSocketURL(base + "/frames"));
  socket.binaryType = "arraybuffer";
  const urls = new Set();
  let configuration, size = "", revision = 0, latestURL = "", closed = false;
  let video = null, decoder = null, described = "", awaiting = null, watchdog = 0, stamp = 0, surround = {};
  const stopVideo = () => {
    clearTimeout(watchdog);
    awaiting = null;
    try { if (decoder && decoder.state !== "closed") decoder.close(); } catch { /* already closed */ }
    decoder = null;
  };
  const close = () => {
    closed = true;
    stopVideo();
    socket.close();
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  };
  const fail = (reason = "window_unavailable") => {
    if (closed) return;
    close();
    onError(reason);
  };
  // The first subscription waits until it can say whether to send video.
  const subscribe = () => {
    if (closed || video === null || !configuration || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ ...configuration, video }));
  };
  macWindowVideoSupported().then(supported => { video = supported; subscribe(); });
  // The page keeps working on still images after a decoder failure.
  const videoFailed = () => {
    if (closed) return;
    videoFailures++;
    fail("video_fallback");
  };
  const present = output => {
    clearTimeout(watchdog);
    const header = awaiting;
    awaiting = null;
    if (closed || !header || header.revision !== revision) { output.close(); return; }
    let acknowledged = false;
    onFrame({ ...header, ...surround, video: output, acknowledge() {
      if (closed || acknowledged) return;
      acknowledged = true;
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ack: header.sequence }));
    } });
  };
  // Every frame is decoded, shown or not: the next one is a difference from it.
  const decodeVideo = (header, bytes) => {
    if (!header.imageLength || !header.sequence) throw new Error();
    if (header.key) {
      if (header.videoConfig !== described || decoder?.state !== "configured") {
        stopVideo();
        decoder = new VideoDecoder({ output: present, error: videoFailed });
        decoder.configure(macWindowVideoConfiguration(header.videoConfig));
        described = header.videoConfig;
      }
      surround = { videoCorner: header.videoCorner || 0, videoEdge: header.videoEdge || "" };
    } else if (decoder?.state !== "configured") throw new Error();
    awaiting = header;
    clearTimeout(watchdog);
    watchdog = setTimeout(videoFailed, 2000);
    decoder.decode(new EncodedVideoChunk({ type: header.key ? "key" : "delta", timestamp: stamp++ * 33333, data: bytes }));
  };
  socket.addEventListener("error", () => fail());
  socket.addEventListener("close", () => fail());
  socket.addEventListener("message", event => {
    if (closed) return;
    try {
      const data = event.data;
      if (!(data instanceof ArrayBuffer) || data.byteLength < 4) throw new Error();
      const length = new DataView(data).getUint32(0);
      if (!length || length > 16384 || 4 + length > data.byteLength) throw new Error();
      const header = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, length)));
      if (header.imageLength !== data.byteLength - 4 - length) throw new Error();
      if (header.mime === "video/avc" && !header.error) {
        try { decodeVideo(header, new Uint8Array(data, 4 + length)); } catch { videoFailed(); }
        return;
      }
      if (header.revision !== revision) return;
      if (header.error) { fail(header.error); return; }
      if (!["image/png", "image/jpeg"].includes(header.mime) || !header.imageLength || !header.sequence) throw new Error();
      const src = URL.createObjectURL(new Blob([new Uint8Array(data, 4 + length)], { type: header.mime }));
      urls.add(src);
      latestURL = src;
      let acknowledged = false;
      onFrame({ ...header, src, acknowledge() {
        if (closed || acknowledged || latestURL !== src) return;
        acknowledged = true;
        for (const previous of urls) {
          if (previous !== src) { URL.revokeObjectURL(previous); urls.delete(previous); }
        }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ack: header.sequence }));
      } });
    } catch { fail(); }
  });
  return {
    resize(viewport) {
      if (closed || !viewport) return;
      const next = { ...viewport, scale: Math.max(1, Math.min(2, window.devicePixelRatio || 1)) };
      const key = JSON.stringify(next);
      if (key === size) return;
      size = key;
      configuration = { ...next, revision: ++revision };
      subscribe();
    },
    close,
  };
}
