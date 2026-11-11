import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseVastDuration, parseSkipOffset, parseVastResponse, resolveVastAd } from "../src/services/vast.mjs";
import { parseXml, textOf, firstChild } from "../src/services/vast-xml.mjs";
import { vastTagUrl, VAST_TAG_HOSTS } from "../src/services/vast-tag.mjs";
import { loadVastAd } from "../src/services/vast-loader.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const inlineTag = `<?xml version="1.0" encoding="UTF-8"?>
<VAST version="3.0" xmlns="http://www.iab.com/VAST">
  <!-- machine generated -->
  <Ad id="ad-1">
    <InLine>
      <AdSystem version="1.0">HilltopAds</AdSystem>
      <AdTitle>Campaign creative</AdTitle>
      <Impression><![CDATA[https://track.example/impression?a=1&b=2]]></Impression>
      <Impression>https://track.example/impression-2</Impression>
      <Error>https://track.example/error</Error>
      <Creatives>
        <Creative>
          <Linear skipoffset="00:00:05">
            <Duration>00:00:28</Duration>
            <TrackingEvents>
              <Tracking event="start">https://track.example/start</Tracking>
              <Tracking event="firstQuartile">https://track.example/q1</Tracking>
              <Tracking event="complete">https://track.example/complete</Tracking>
              <Tracking event="skip">https://track.example/skip</Tracking>
              <Tracking event="unknownEvent">https://track.example/ignored</Tracking>
            </TrackingEvents>
            <VideoClicks>
              <ClickThrough>https://advertiser.example/landing</ClickThrough>
              <ClickTracking>https://track.example/click</ClickTracking>
            </VideoClicks>
            <MediaFiles>
              <MediaFile delivery="progressive" type="video/webm" width="640" height="360" bitrate="400">https://cdn.example/ad.webm</MediaFile>
              <MediaFile delivery="progressive" type="video/mp4" width="1280" height="720" bitrate="1500">https://cdn.example/ad.mp4</MediaFile>
              <MediaFile delivery="progressive" type="application/x-shockwave-flash" width="640" height="360">https://cdn.example/ad.swf</MediaFile>
            </MediaFiles>
          </Linear>
        </Creative>
      </Creatives>
    </InLine>
  </Ad>
</VAST>`;

const wrapperTag = `<?xml version="1.0"?>
<VAST version="3.0">
  <Ad id="wrapper-1">
    <Wrapper>
      <AdSystem>HilltopAds</AdSystem>
      <VASTAdTagURI>https://ads.example/inline.xml</VASTAdTagURI>
      <Impression>https://track.example/wrapper-impression</Impression>
      <Error>https://track.example/wrapper-error</Error>
      <Creatives>
        <Creative>
          <Linear skipoffset="00:00:07">
            <TrackingEvents><Tracking event="start">https://track.example/wrapper-start</Tracking></TrackingEvents>
          </Linear>
        </Creative>
      </Creatives>
    </Wrapper>
  </Ad>
</VAST>`;

test("the XML reader keeps elements, attributes, CDATA and namespaces", () => {
  const document = parseXml(inlineTag);
  const vast = document.children.find((child) => child.name === "VAST");
  assert.equal(vast.attrs.version, "3.0");
  assert.equal(vast.attrs["xmlns"], "http://www.iab.com/VAST");
  const impression = vast.children[0].children.find((child) => child.name === "InLine")
    .children.filter((child) => child.name === "Impression");
  assert.equal(textOf(impression[0]), "https://track.example/impression?a=1&b=2", "CDATA is not entity-decoded twice");
  assert.equal(textOf(impression[1]), "https://track.example/impression-2");

  const namespaced = parseXml('<vast:VAST xmlns:vast="urn:x"><vast:Ad id="1"/></vast:VAST>');
  assert.equal(namespaced.children[0].name, "vast:VAST");
  assert.equal(firstChild(namespaced.children[0], "Ad")?.attrs.id, "1", "prefixed names match by local name");

  const entities = parseXml("<a title=\"a &amp; b\">x &lt; y &amp; z</a>");
  assert.equal(entities.children[0].attrs.title, "a & b");
  assert.equal(textOf(entities.children[0]), "x < y & z");

  // A truncated or hostile document must never throw.
  assert.doesNotThrow(() => parseXml("<VAST><Ad><InLine>"));
  assert.equal(parseXml(""), null);
  assert.equal(parseXml(undefined), null);
});

test("an inline pre-roll is read with its media, click-through and tracking", () => {
  const { inline, wrapper } = parseVastResponse(inlineTag);
  assert.equal(wrapper, null);
  assert.equal(inline.id, "ad-1");
  assert.equal(inline.system, "HilltopAds");
  assert.equal(inline.title, "Campaign creative");
  assert.equal(inline.mediaUrl, "https://cdn.example/ad.mp4", "MP4 is preferred over WebM and SWF");
  assert.equal(inline.mediaType, "video/mp4");
  assert.equal(inline.durationSeconds, 28);
  assert.equal(inline.skipAfterSeconds, 5);
  assert.equal(inline.skippable, true);
  assert.deepEqual(inline.impressions, ["https://track.example/impression?a=1&b=2", "https://track.example/impression-2"]);
  assert.deepEqual(inline.errors, ["https://track.example/error"]);
  assert.equal(inline.clickThrough, "https://advertiser.example/landing");
  assert.deepEqual(inline.clickTracking, ["https://track.example/click"]);
  assert.deepEqual(inline.events.start, ["https://track.example/start"]);
  assert.deepEqual(inline.events.firstQuartile, ["https://track.example/q1"]);
  assert.deepEqual(inline.events.complete, ["https://track.example/complete"]);
  assert.deepEqual(inline.events.skip, ["https://track.example/skip"]);
  assert.equal(inline.events.unknownEvent, undefined, "unknown events are dropped");
});

test("duration and skip offsets accept timecodes, seconds and percentages", () => {
  assert.equal(parseVastDuration("00:00:28"), 28);
  assert.equal(parseVastDuration("00:01:05"), 65);
  assert.equal(parseVastDuration("28"), 28);
  assert.equal(parseVastDuration("00:28"), 28);
  assert.equal(parseVastDuration(""), null);
  assert.equal(parseVastDuration("abc"), null);
  assert.equal(parseVastDuration("-5"), null);
  assert.equal(parseVastDuration("1:2:3:4"), null);

  assert.equal(parseSkipOffset("00:00:15", 30), 15);
  assert.equal(parseSkipOffset("15", 30), 15);
  assert.equal(parseSkipOffset("25%", 28), 7);
  assert.equal(parseSkipOffset("50%", null), null);
  assert.equal(parseSkipOffset("", 30), null);
  assert.equal(parseSkipOffset(undefined, 30), null);

  const position = parseSkipOffset("0%", 30);
  assert.equal(position, 0, "a zero offset means the ad is skippable immediately");
});

test("a tag without a skip offset still becomes skippable at the documented default", async () => {
  const noSkip = inlineTag.replace(' skipoffset="00:00:05"', "");
  const ad = await resolveVastAd("https://ads.example/tag", { fetchText: async () => noSkip, skipFallbackSeconds: 15 });
  assert.equal(ad.skipAfterSeconds, 15);
  const off = await resolveVastAd("https://ads.example/tag", { fetchText: async () => noSkip, skipFallbackSeconds: 0 });
  assert.equal(off.skipAfterSeconds, null);
  assert.equal(off.skippable, false);
});

test("wrappers are resolved and their tracking is merged", async () => {
  const calls = [];
  const ad = await resolveVastAd("https://ads.example/wrapper.xml", {
    fetchText: async (url) => { calls.push(url); return url.includes("wrapper") ? wrapperTag : inlineTag; },
  });
  assert.deepEqual(calls, ["https://ads.example/wrapper.xml", "https://ads.example/inline.xml"]);
  assert.equal(ad.mediaUrl, "https://cdn.example/ad.mp4");
  assert.ok(ad.impressions.includes("https://track.example/wrapper-impression"));
  assert.ok(ad.impressions.includes("https://track.example/impression-2"));
  assert.ok(ad.errors.includes("https://track.example/wrapper-error"));
  assert.deepEqual(ad.events.start.sort(), ["https://track.example/start", "https://track.example/wrapper-start"]);
  assert.equal(ad.skipAfterSeconds, 5, "the inline creative's own offset wins");
  assert.equal(ad.tag, "https://ads.example/wrapper.xml");
});

test("wrapper chains are bounded and failures resolve to no ad", async () => {
  let requests = 0;
  const chain = (index) => `<?xml version="1.0"?><VAST version="3.0"><Ad><Wrapper><VASTAdTagURI>https://ads.example/w${index + 1}.xml</VASTAdTagURI></Wrapper></Ad></VAST>`;
  const tooDeep = await resolveVastAd("https://ads.example/w0.xml", {
    fetchText: async () => { requests += 1; return chain(requests); },
    maxWrappers: 2,
  });
  assert.equal(tooDeep, null);
  assert.ok(requests <= 4, "wrapper depth is capped");

  const loop = (url) => `<?xml version="1.0"?><VAST version="3.0"><Ad><Wrapper><VASTAdTagURI>${url}</VASTAdTagURI></Wrapper></Ad></VAST>`;
  assert.equal(await resolveVastAd("https://ads.example/loop.xml", { fetchText: async (url) => loop(url) }), null, "a loop stops");

  assert.equal(await resolveVastAd("https://ads.example/tag", { fetchText: async () => { throw new Error("offline"); } }), null);
  assert.equal(await resolveVastAd("https://ads.example/tag", { fetchText: async () => "<html>not an ad</html>" }), null);
  assert.equal(await resolveVastAd("https://ads.example/tag", { fetchText: async () => "" }), null);
  assert.equal(await resolveVastAd("http://ads.example/tag", { fetchText: async () => inlineTag }), null, "HTTPS tags only");
  assert.equal(await resolveVastAd(undefined, { fetchText: async () => inlineTag }), null);
});

test("loadVastAd never rejects, even when the ad server fails", async () => {
  assert.equal(await loadVastAd("https://ads.example/tag", { fetchText: async () => { throw new Error("boom"); } }), null);
  const ad = await loadVastAd("https://ads.example/tag", { fetchText: async () => inlineTag, skipFallbackSeconds: 15 });
  assert.equal(ad.mediaUrl, "https://cdn.example/ad.mp4");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network down"); };
  try {
    assert.equal(await loadVastAd("https://ads.example/tag"), null, "a network failure is swallowed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("only the configured HilltopAds tag is accepted", async () => {
  const config = await readFile(path.join(root, "src/config/vast.ts"), "utf8");
  const configured = config.match(/export const VAST_TAG_URL\s*=\s*\n?\s*"([^"]*)"/)?.[1];
  assert.equal(typeof configured, "string", "the tag lives in one editable string");
  assert.ok(configured.length > 20, "a tag is configured by default");
  assert.equal(vastTagUrl(configured), configured);
  assert.match(configured, /^https:\/\//);
  assert.ok(VAST_TAG_HOSTS.some((host) => new URL(configured).hostname.endsWith(host)));

  assert.equal(vastTagUrl("https://surprisedplate.com/d.m/abc"), "https://surprisedplate.com/d.m/abc");
  assert.equal(vastTagUrl("https://hilltopads.com/vast/1"), "https://hilltopads.com/vast/1");
  assert.equal(vastTagUrl("http://surprisedplate.com/d.m/abc"), null, "HTTPS only");
  assert.equal(vastTagUrl("https://evil.example/d.m/abc"), null, "unknown host");
  assert.equal(vastTagUrl("https://surprisedplate.com.evil.example/d.m/abc"), null, "suffix look-alike host");
  assert.equal(vastTagUrl("https://user:pass@surprisedplate.com/d.m/abc"), null, "no credentials");
  assert.equal(vastTagUrl("https://surprisedplate.com/d.m/abc#frag"), null, "no fragment");
  assert.equal(vastTagUrl(" https://surprisedplate.com/d.m/abc"), null, "no surrounding whitespace");
  assert.equal(vastTagUrl(""), null);
  assert.equal(vastTagUrl(undefined), null);
});
