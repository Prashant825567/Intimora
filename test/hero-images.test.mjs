import "./fixtures/ads-off.mjs";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserPath = process.env.CHROMIUM_PATH || chromium.executablePath();
const dimensions = [[600, 1000], [1600, 400], [1200, 900]];
const videos = dimensions.map((_, index) => ({ id: `image-${index}`, title: `Aspect ratio test ${index}`, views: index, createdAt: 1_700_000_000 }));

async function availablePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("portrait, panoramic and landscape thumbnails remain fully visible without hero text overlap", {
  skip: existsSync(browserPath) ? false : "Install Chromium or set CHROMIUM_PATH", timeout: 120_000,
}, async () => {
  const vite = await createViteServer({ configFile: path.join(root, "vite.config.ts"), logLevel: "silent", server: { host: "127.0.0.1", port: await availablePort(), strictPort: true } });
  let browser;
  try {
    await vite.listen();
    const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    for (const [width, height, mobile] of [[280, 568, true], [390, 844, true], [1023, 768, true], [1440, 900, false]]) {
      const page = await browser.newPage({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
      await page.route("**/*", (route) => {
        const url = new URL(route.request().url());
        // The anime API is a real host; tests never call it.
        if (url.hostname === "pacahub-34nd.onrender.com") return route.abort();
        const headers = { "Access-Control-Allow-Origin": "*" };
        if (url.hostname === "intimora.tmc78lxnu.workers.dev") return route.fulfill({ headers, json: { ok: true, data: { server: "https://image-backend.example" } } });
        if (url.hostname !== "image-backend.example") return route.continue();
        if (url.pathname === "/api/videos") return route.fulfill({ headers, json: { ok: true, data: { videos, nextCursor: null } } });
        const match = /^\/api\/videos\/image-(\d)\/thumbnail$/.exec(url.pathname);
        if (match) {
          const [w, h] = dimensions[Number(match[1])];
          return route.fulfill({ headers, contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#a57938"/></svg>` });
        }
        return route.fulfill({ headers, json: { ok: true } });
      });
      await page.goto(base);
      await page.getByRole("button", { name: /I AM 18/i }).click();
      await page.locator(".hero-banner__image").first().waitFor();
      if (width < 1024) {
        // A phone shows the poster alone and moves it with a swipe, so the
        // desktop-only arrow buttons and the text block are not rendered there.
        assert.equal(await page.getByRole("button", { name: /WATCH NOW/i }).count(), 0, `${width}x${height}: phone hero has no text block`);
        assert.equal(await page.locator(".hero-banner__arrow--prev").first().isVisible(), false, `${width}x${height}: no arrows on a phone`);
      }
      for (let index = 0; index < dimensions.length; index += 1) {
        // The title is inside the hero text block, which a phone does not draw;
        // the poster is what identifies the slide there.
        if (width < 1024) {
          await page.locator(".hero-banner__image").filter({ has: page.locator("xpath=.") }).first().waitFor();
        } else {
          await page.locator(".hero-banner__title").filter({ hasText: `Aspect ratio test ${index}` }).waitFor();
        }
        await page.locator(".hero-banner__image").evaluate((image) => image.decode());
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
        const layout = await page.locator(".hero-banner").evaluate((hero) => {
          const image = hero.querySelector(".hero-banner__image");
          const imageBox = image.getBoundingClientRect();
          const media = hero.querySelector(".hero-banner__media").getBoundingClientRect();
          const content = hero.querySelector(".hero-banner__content").getBoundingClientRect();
          const nav = document.querySelector(".site-nav").getBoundingClientRect();
          const style = getComputedStyle(image);
          const scale = Math.min(imageBox.width / image.naturalWidth, imageBox.height / image.naturalHeight);
          const picture = {
            left: imageBox.left + (imageBox.width - image.naturalWidth * scale) / 2,
            right: imageBox.right - (imageBox.width - image.naturalWidth * scale) / 2,
            top: imageBox.top + (imageBox.height - image.naturalHeight * scale) / 2,
            bottom: imageBox.bottom - (imageBox.height - image.naturalHeight * scale) / 2,
          };
          return {
            fit: style.objectFit, transform: style.transform, imageWidth: image.naturalWidth, imageHeight: image.naturalHeight,
            within: picture.left >= media.left - 1 && picture.right <= media.right + 1 && picture.top >= media.top - 1 && picture.bottom <= media.bottom + 1,
            separate: content.right <= media.left + 1 || content.left >= media.right - 1 || content.top >= media.bottom - 1 || content.bottom <= media.top + 1,
            belowNav: hero.getBoundingClientRect().top >= nav.bottom - 1,
          };
        });
        assert.deepEqual([layout.imageWidth, layout.imageHeight], dimensions[index]);
        assert.equal(layout.fit, "contain");
        assert.equal(layout.transform, "none");
        assert.ok(layout.within && layout.belowNav, `${width}x${height}, image ${index}: ${JSON.stringify(layout)}`);
        // On a phone the text block is a full-size overlay holding only the dots,
        // so it is expected to cover the poster; on a desktop it must not.
        if (width < 1024) {
          assert.equal(await page.locator(".hero-banner__title").first().isVisible(), false, `${width}x${height}: phone hero hides the title`);
        } else {
          assert.ok(layout.separate, `${width}x${height}, image ${index}: desktop text must not cover the poster`);
        }
        assert.equal(await page.locator(".video-card__image").first().evaluate((image) => getComputedStyle(image).objectFit), "contain");
        if (index < dimensions.length - 1) {
          if (width < 1024) {
            // Swipe the poster: a horizontal drag, which the hero reads as "next".
            await page.locator(".hero-banner__media").evaluate((media) => {
              const box = media.getBoundingClientRect();
              const touch = (type, x) => {
                const event = new Event(type, { bubbles: true, cancelable: true });
                event.touches = type === "touchend" ? [] : [{ clientX: x, clientY: box.top + box.height / 2 }];
                event.changedTouches = [{ clientX: x, clientY: box.top + box.height / 2 }];
                media.closest(".hero-banner").dispatchEvent(event);
              };
              touch("touchstart", box.left + box.width * 0.8);
              touch("touchend", box.left + box.width * 0.2);
            });
          } else {
            await page.getByRole("button", { name: "Next featured video" }).click();
          }
        }
      }
      await page.close();
    }
  } finally {
    await browser?.close();
    await vite.close();
  }
});
