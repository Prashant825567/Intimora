import "./fixtures/ads-off.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { adFallbackPlugin, buildAdSnapshot, requestTagText } from "../scripts/ad-fallback-plugin.mjs";
import { loadCachedAd, normaliseCachedAd } from "../src/services/ad-fallback.mjs";
import { loadPreRoll } from "../src/services/vast-loader.mjs";

const mediaUrl = "https://ad-media.example/creative.mp4";

const cachedAd = {
  id: "cached-1",
  system: "HilltopAds",
  title: "Cached campaign",
  mediaUrl,
  mediaType: "video/mp4",
  durationSeconds: 20,
  skipAfterSeconds: 15,
  skippable: true,
  clickThrough: "https://advertiser.example/landing",
  clickTracking: ["https://track.example/click"],
  impressions: ["https://track.example/impression"],
  errors: ["https://track.example/error"],
  events: { start: ["https://track.example/start"], nonsense: ["https://track.example/nonsense"] },
  tag: "https://surprisedplate.com/d.m/example",
};

const liveAd = { ...cachedAd, id: "live-1", mediaUrl: "https://ad-media.example/live.mp4" };

const jsonResponse = (body, { status = 200 } = {}) => ({ ok: status === 200, status, json: async () => body });

test("a cached creative is only accepted when its media is a plain https file", () => {
  const normalised = normaliseCachedAd(cachedAd);
  assert.equal(normalised.mediaUrl, mediaUrl);
  assert.equal(normalised.skippable, true);
  assert.deepEqual(normalised.events, { start: ["https://track.example/start"] }, "unknown events are dropped");
  assert.equal(normalised.source, "cached");

  assert.equal(normaliseCachedAd({ ...cachedAd, mediaUrl: "http://ad-media.example/x.mp4" }), null, "HTTPS only");
  assert.equal(normaliseCachedAd({ ...cachedAd, mediaUrl: "javascript:alert(1)" }), null);
  assert.equal(normaliseCachedAd({ ...cachedAd, mediaUrl: "" }), null);
  assert.equal(normaliseCachedAd(null), null);
  assert.equal(normaliseCachedAd("nope"), null);
  const unsafe = normaliseCachedAd({
    ...cachedAd,
    clickThrough: "javascript:alert(1)",
    impressions: ["http://track.example/x", "https://track.example/ok", "https://track.example/ok"],
    durationSeconds: -5,
  });
  assert.equal(unsafe.clickThrough, null);
  assert.deepEqual(unsafe.impressions, ["https://track.example/ok"], "bad and duplicate trackers are dropped");
  assert.equal(unsafe.durationSeconds, null);
});

test("the published snapshot is read from our own origin and never throws", async () => {
  assert.equal((await loadCachedAd("/ad-fallback.json", { fetchImpl: async () => jsonResponse({ enabled: true, ad: cachedAd }) })).mediaUrl, mediaUrl);
  assert.equal(await loadCachedAd("/ad-fallback.json", { fetchImpl: async () => jsonResponse({ enabled: false, ad: null }) }), null);
  assert.equal(await loadCachedAd("/ad-fallback.json", { fetchImpl: async () => jsonResponse({}, { status: 404 }) }), null);
  assert.equal(await loadCachedAd("/ad-fallback.json", { fetchImpl: async () => { throw new Error("offline"); } }), null);
  assert.equal(await loadCachedAd("/ad-fallback.json", { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }) }), null);
  assert.equal(await loadCachedAd("https://evil.example/ad.json", { fetchImpl: async () => jsonResponse({ ad: cachedAd }) }), null, "same-origin only");
});

test("a pre-roll prefers the live tag but falls back to the snapshot", async () => {
  const cached = async () => ({ ...cachedAd, source: "cached" });

  const liveWins = await loadPreRoll("https://surprisedplate.com/tag", {
    fetchText: async () => "<VAST/>",
    fetchCached: cached,
    liveBudgetMs: 500,
  });
  assert.equal(liveWins.mediaUrl, mediaUrl, "an unparsable live tag falls back to the snapshot");
  assert.equal(liveWins.source, "cached");

  const fallbackWins = await loadPreRoll("https://surprisedplate.com/tag", {
    // A browser without CORS headers sees this as an immediate failure.
    fetchText: async () => { throw new Error("cors"); },
    fetchCached: cached,
    liveBudgetMs: 500,
  });
  assert.equal(fallbackWins.mediaUrl, mediaUrl);
  assert.equal(fallbackWins.source, "cached");

  // A tag that answers faster than the budget is used as is.
  const liveAdXml = `<VAST version="3.0"><Ad id="live-1"><InLine><AdSystem>HilltopAds</AdSystem><AdTitle>Live</AdTitle>
    <Impression>https://track.example/impression</Impression>
    <Creatives><Creative><Linear skipoffset="00:00:05"><Duration>00:00:20</Duration>
    <MediaFiles><MediaFile delivery="progressive" type="video/mp4" width="640" height="360" bitrate="800">${liveAd.mediaUrl}</MediaFile></MediaFiles>
    </Linear></Creative></Creatives></InLine></Ad></VAST>`;
  const liveUsed = await loadPreRoll("https://surprisedplate.com/tag", {
    fetchText: async () => liveAdXml,
    fetchCached: cached,
    liveBudgetMs: 500,
  });
  assert.equal(liveUsed.mediaUrl, liveAd.mediaUrl, "the live creative wins when it answers in time");
  assert.equal(liveUsed.source, undefined);

  // A hanging tag must not hold the decision: the snapshot is used at the budget.
  const started = Date.now();
  const timedOut = await loadPreRoll("https://surprisedplate.com/tag", {
    fetchText: () => new Promise(() => {}),
    fetchCached: cached,
    liveBudgetMs: 300,
    timeoutMs: 5000,
  });
  assert.equal(timedOut.mediaUrl, mediaUrl);
  assert.ok(Date.now() - started < 2000, "the budget bounds the wait");

  const nothing = await loadPreRoll("", { fetchCached: async () => null, liveBudgetMs: 100 });
  assert.equal(nothing, null, "ads off means no pre-roll");
});

test("the build publishes the resolved creative, or an explicit off snapshot", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "intimora-ad-snapshot-"));
  const warnings = [];
  const context = { warn: (message) => warnings.push(message) };
  try {
    await adFallbackPlugin({ tagUrl: "https://surprisedplate.com/tag", generate: async () => cachedAd })
      .writeBundle.call(context, { dir: directory });
    const published = JSON.parse(await readFile(path.join(directory, "ad-fallback.json"), "utf8"));
    assert.equal(published.enabled, true);
    assert.equal(published.ad.mediaUrl, mediaUrl);
    assert.deepEqual(warnings, []);

    await adFallbackPlugin({ tagUrl: "https://surprisedplate.com/tag", generate: async () => null })
      .writeBundle.call(context, { dir: directory });
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "ad-fallback.json"), "utf8")), { enabled: false, ad: null });
    assert.equal(warnings.length, 1);

    await adFallbackPlugin({ tagUrl: "https://surprisedplate.com/tag", offline: true, generate: async () => { throw new Error("must not be called"); } })
      .writeBundle.call(context, { dir: directory });
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "ad-fallback.json"), "utf8")), { enabled: false, ad: null }, "offline builds never contact the ad network");

    const failing = [];
    await adFallbackPlugin({ tagUrl: "https://surprisedplate.com/tag", generate: async () => { throw new Error("ad server down"); } })
      .writeBundle.call({ warn: (message) => failing.push(message) }, { dir: directory });
    assert.equal(failing.length, 1);
    assert.match(failing[0], /could not be built/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the build-time tag request is time-boxed and rejects unusable answers", async () => {
  assert.match(await requestTagText("https://surprisedplate.com/tag", 500, async () => ({ ok: true, text: async () => "<VAST/>" })), /VAST/);
  await assert.rejects(requestTagText("https://surprisedplate.com/tag", 500, async () => ({ ok: false, status: 500, text: async () => "" })), /500/);
  await assert.rejects(requestTagText("https://surprisedplate.com/tag", 200, (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  })));
});

test("the real HilltopAds tag shape resolves into a playable pre-roll", async () => {
  const xml = readFileSync(new URL("./fixtures/hilltopads-vast.xml", import.meta.url), "utf8");
  const ad = await buildAdSnapshot({
    tagUrl: "https://surprisedplate.com/d.m/FAzwdZGNN/0yNbQH",
    // Stand in for the build's server-side request: no CORS, no cookies.
    fetchImpl: async () => ({ ok: true, text: async () => xml }),
  });
  assert.ok(ad, "the published tag yields an ad");
  assert.equal(ad.mediaUrl, "https://www.dismal-library.pro/152327/199273/530462_76421y.mp4", "the 720p MP4 is chosen");
  assert.equal(ad.durationSeconds, 20);
  assert.equal(ad.skipAfterSeconds, 15, "the tag's own skip offset is kept");
  assert.equal(ad.skippable, true);
  assert.match(ad.clickThrough, /^https:\/\/surprisedplate\.com\//);
  assert.ok(ad.impressions.length > 0 && ad.events.start.length > 0, "tracking survives the snapshot");
});
