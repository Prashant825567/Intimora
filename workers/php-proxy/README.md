# PHP API proxy (Cloudflare Worker)

Yeh Worker aapke PHP backend ke aage ek "browser" ka kaam karta hai: free hosting
(InfinityFree) ka JavaScript check khud solve karta hai, `__test` cookie yaad
rakhta hai, aur site ko normal JSON deta hai. Isliye machine par kuch test karne
ki zaroorat nahi — deploy karo aur site chalti hai.

`worker.mjs` **ek hi self-contained file** hai (koi import nahi), seedha
Cloudflare dashboard me paste hoti hai.

## Kyun proxy zaroori hai

Free hosting har request par HTML challenge bhejti hai:

```js
document.cookie = "__test=" + toHex(slowAES.decrypt(c, 2, a, b)) + "; max-age=21600"
```

- Browser me XHR us HTML ko padh bhi nahi sakta (CORS header nahi hota).
- Cookie `SameSite=Lax` hai, to cross-site XHR me bhejti hi nahi.
- Matlab **browser kabhi seedha PHP host se baat nahi kar sakta.**

Worker (server side) ye kar leta hai: `a` = key, `b` = IV, `c` = ciphertext ko
AES-128-CBC (bina padding) se decrypt karke token nikaalta hai, cookie banata hai,
aur ~6 ghante tak reuse karta hai. Node ka `crypto` Worker me nahi hota aur Web
Crypto padding validate kar deta hai, isliye AES ka inverse cipher isi file me
plain JavaScript me likha hai — `node:crypto` se byte-for-byte tested.

## Deploy (ek paste, koi local test nahi)

1. Cloudflare dashboard → **Workers & Pages** → apna worker (jo `get-server`
   deta hai) → **Edit code** → sab kuch delete karke `worker.mjs` ka poora
   content paste karo → **Deploy**.
2. **Settings → Variables and Secrets** — do me se **ek**:
   - `DISCOVERY_URL` = `https://intimora.tmc78lxnu.workers.dev/api/get-server`
     ← **recommended**: proxy LB se poochhega kaunsa PHP server hai, aur har 10
     minute me dobara poochhega. LB URL badle (api2 → api3 → api4) to kuch
     badalna nahi padega.
   - ya `PHP_ORIGINS` = `https://intimora-api2.site.je,https://intimora-api3.site.je`
     (fixed list; comma se separated, pehla fail ho to agla try hota hai)
   - `ALLOWED_ORIGINS` (optional) = `https://intimora.new.tg,https://www.intimora.new.tg`
3. Worker ka URL kholo: `https://<worker-host>/__proxy-health`
   Yehi aapka test hai — browser me JSON dikhega:

```json
{
  "ok": true,
  "targets": [{
    "origin": "https://intimora-api2.site.je",
    "challenge": true,
    "challengeSolved": true,
    "catalog": { "ok": true, "status": 200, "videos": 1 },
    "ms": 1340
  }],
  "mode": "discovery",
  "cookie": { "name": "__test", "expiresInMinutes": 354 }
}
```

- `mode` = `discovery` (LB se url liya) ya `fixed` (`PHP_ORIGINS`).
- `challengeSolved: true` = cookie nikal gayi.
- `catalog.ok: true, videos: 1` = asli data aa raha hai.
- `error` dikhe to `PHP_ORIGINS` galat hai ya host down hai.

## Do deployment shapes

### A. Best — site ke apne domain par route (same-origin, CORS hi nahi)
1. Worker → **Settings → Domains & Routes → Add route**: `intimora.new.tg/api/*`
   (zone `intimora.new.tg`).
2. Worker `/api/get-server` khud hi `{ "server": "https://intimora.new.tg" }`
   return karta hai.
3. Render me build env add karo: `INTIMORA_PUBLIC_API_DISCOVERY_URL` =
   `https://intimora.new.tg/api/get-server` → phir redeploy.
4. `INTIMORA_PUBLIC_AUTH_BACKENDS` me `https://intimora.new.tg` add karo (login ke
   liye zaroori — frontend sirf trusted origins ko Firebase token deta hai).

Faayda: sab kuch `intimora.new.tg/api/...` par, koi CORS/preflight nahi, PHP host
ka address browser ko dikhta hi nahi.

### B. Worker ke workers.dev URL par
1. Worker apne origin ko hi discovery me return karta hai; usko discovery bana do:
   `INTIMORA_PUBLIC_API_DISCOVERY_URL=https://<worker-host>/api/get-server`.
2. `INTIMORA_PUBLIC_AUTH_BACKENDS` me `https://<worker-host>` add karo.

Is case me Worker khud CORS headers lagata hai (`ALLOWED_ORIGINS` se match),
preflight (OPTIONS) bhi khud answer karta hai.

## Worker kya kya karta hai

| Cheez | Kaise |
|---|---|
| Challenge | `a`/`b`/`c` page se padh kar AES-128-CBC decrypt; variable naam badle to bhi chalta hai |
| Cookie | `__test` 6 ghante tak cached, expire hone se 1 minute pehle naya solve |
| Retry | host naya challenge de to dobara solve karke wahi request repeat (max 2) |
| LB follow | `DISCOVERY_URL` se PHP server ka URL, 10 minute cache; URL badle to khud update |
| Failover | `PHP_ORIGINS` me pehla host down → agla |
| Auth | `Authorization: Bearer …` header aage bhejta hai (Firebase token) |
| Video seeking | `Range` header forward, `206`/`Accept-Ranges` waise hi wapas |
| Thumbnails | edge cache (1 din) — free hosting ke hit limit bachte hain |
| CORS | sirf site ke origins ko `Access-Control-Allow-Origin`, OPTIONS par 204 |
| Health | `/__proxy-health` browser me khulne wala postcard |

## Dhyan rakhne wali baatein

- **Video streaming Worker se hoke jaata hai.** 20–35 MB files ke liye yeh chal jaata
  hai, par free Workers plan ka request limit (1 lakh/din) dhyan me rakho. Traffic
  badhe to videos ko Cloudflare R2 par daal kar `/api/videos/<id>/stream` se 302
  redirect kar dena — frontend ko farak nahi padega.
- PHP host badla (api3 → api4): `DISCOVERY_URL` mode me kuch nahi karna; `PHP_ORIGINS`
  mode me sirf wo variable badlo, code nahi.
- LB khud isi proxy ko point karne lage to worker saaf `502` deta hai
  ("discovery points at this proxy itself") — us case me `PHP_ORIGINS` set karo.
- Worker ka `__test` cookie usi host ke liye valid hai; do origins hain to har
  origin ka apna cookie banega (code khud handle karta hai).
- `intimora-api2.site.je` par `Access-Control-Allow-Origin` nahi hai — isliye
  browser usko chhod kar Worker se baat karta hai. Isi liye discovery me **Worker
  ka origin** hona chahiye, PHP host ka nahi.

## Test

`node --test test/php-challenge.test.mjs` — AES parity vs `node:crypto`, challenge
parsing, cookie reuse, retry, CORS, range passthrough, failover, thumbnail cache
aur `/__proxy-health`.

Optional CLI (agar kabhi terminal se poori API dekhni ho):
`node scripts/php-api-check.mjs https://intimora-api2.site.je`
