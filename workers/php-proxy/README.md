# PHP API proxy (Cloudflare Worker)

Yeh Worker aapke PHP backend ke aage ek "browser" ka kaam karta hai: free hosting
(InfinityFree) ka JavaScript check khud solve karta hai, `__test` cookie yaad
rakhta hai, aur site ko normal JSON deta hai. Isliye machine par kuch test karne
ki zaroorat nahi — deploy karo aur site chalti hai.

`worker.mjs` **ek hi self-contained file** hai (koi import nahi), seedha
Cloudflare dashboard me paste hoti hai.

## Kaunsa proxy use karein (`IP-bound` cookie)

Free host ka `__test` cookie **us connection/IP se bandha** hota hai jisne use solve
kiya. Cloudflare Workers ka egress IP har request par badal sakta hai, isliye wahan
"cookie 6 ghante cache karo" model **reliable nahi** — cookie dusre IP par reject ho
jaati hai. (Worker version ab best-effort hai: har request me challenge solve karke
same request me 3 baar retry karta hai.)

Pakka solution: aisa proxy jiska **ek hi outbound connection/IP** ho —
`node-proxy.mjs`. Ye ek hi keep-alive socket (`maxSockets: 1`) par challenge, cookie
aur saari API calls bhejta hai, isliye session kabhi IP nahi badalti.

```bash
# Render / VPS / kisi bhi Node host par
PORT=8787 DISCOVERY_URL=https://intimora.tmc78lxnu.workers.dev/api/get-server \
  node workers/php-proxy/node-proxy.mjs
```

Render par: **New → Web Service** → repo → Runtime **Node** → Build Command khali
chhodo (koi dependency nahi) → Start Command
`node workers/php-proxy/node-proxy.mjs` → Environment me `DISCOVERY_URL` (ya
`PHP_ORIGINS`) → Deploy. Phir `https://<service>.onrender.com/__proxy-health`
browser me kholo.

| | Cloudflare Worker | Node proxy |
|---|---|---|
| Egress IP | badalta hai | ek hi socket/IP |
| IP-bound cookie | best-effort (retry) | **reliable** |
| Deploy | paste | Render/VPS par start command |
| Video streaming | Worker se | Node se (Range support) |

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

---

# Direct mode: frontend → PHP (unlock flow)

Yeh proxy ke **bina** chalta hai: browser seedha PHP host ko call karta hai
(`credentials: "include"`), aur agar host apna HTML check bhej de to **ek baar**
visitor ko `<php>/__unlock?back=<wahi page>` par bhej dete hain — wahan challenge
browser me khud chalta hai, cookie ban jaati hai, aur page wapas site par le aata
hai. Uske baad ~6 ghante normal direct calls.

Frontend me sab lag chuka hai (`src/config/php-backend.mjs`,
`src/services/unlock.mjs`, `src/services/visitor-route.mjs`,
`src/services/media-credentials.mjs`). **Kaam karne ke liye PHP side par sirf 2
cheezein chahiye:**

## 1) `/__unlock` endpoint (PHP) — cookie ko SameSite=None banao

Free host ki `__test` cookie `SameSite` ke bina aati hai = **Lax**, aur Lax cookie
`site.je` → `new.tg` cross-site XHR/image me **bhejti hi nahi**. Isliye unlock page
par wahi value dobara set karni hai, is baar `SameSite=None; Secure` ke saath
(browser ise accept karta hai kyunki set karne wala khud PHP domain hai):

```php
<?php // /__unlock
$back = $_GET['back'] ?? 'https://intimora.new.tg/';
// sirf apni site par wapas bhejo (open redirect se bachne ke liye)
if (!preg_match('#^https://(www\.)?intimora\.new\.tg(/|$)#', $back)) {
    $back = 'https://intimora.new.tg/';
}
// free-host session cookie ko cross-site bhejne layak banao
if (!empty($_COOKIE['__test'])) {
    setcookie('__test', $_COOKIE['__test'], [
        'expires'  => time() + 21600,
        'path'     => '/',
        'secure'   => true,
        'httponly' => false,
        'samesite' => 'None',
    ]);
}
$sep = str_contains($back, '?') ? '&' : '?';
header('Location: ' . $back . $sep . '__unlocked=1');
exit;
```

Flow: visitor `/__unlock` par jaata hai → (cookie nahi thi to) challenge JS chalti
hai aur page reload hota hai → ab PHP chalta hai → cookie `SameSite=None` ho jaati
hai → wapas site par `?__unlocked=1` ke saath.

## 2) Har API/media response par CORS (credentials ke sath)

`credentials: "include"` ke saath `Access-Control-Allow-Origin: *` **nahi** chalta —
exact origin + `Allow-Credentials: true` chahiye:

```php
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$allowed = ['https://intimora.new.tg', 'https://www.intimora.new.tg'];
if (in_array($origin, $allowed, true)) {
    header("Access-Control-Allow-Origin: $origin");
    header('Access-Control-Allow-Credentials: true');
    header('Vary: Origin');
}
header('Access-Control-Allow-Headers: Authorization, Content-Type, Range');
header('Access-Control-Allow-Methods: GET, HEAD, POST, OPTIONS');
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }
```

Yeh bootstrap me (har request se pehle) lagao, aur thumbnails/stream routes par bhi.

## Frontend me kya hua

| File | Kaam |
|---|---|
| `src/config/php-backend.mjs` | PHP URL **hardcoded** (`PHP_ORIGIN_OVERRIDE`), proxy fallback, window timing. LB se URL maangna band — wapas jaana ho to is constant ko `""` kar dena |
| `src/services/unlock.mjs` | ek-baar-per-6h guard, `__unlock` URL, splash, `?__unlocked` cleanup |
| `src/services/visitor-route.mjs` | pinned host direct call + `credentials: "include"` + HTML challenge detect + unlock trigger + proxy fallback |
| `src/services/media-credentials.mjs` | PHP origin ke media par `crossorigin` hata diya (warna wahi CORS problem), cookie phir bhi jaati hai |
| `src/index.css` | `.unlock-splash` (logo + spinner + "You will be brought back here automatically") |

## Test (browser se, machine par kuch nahi)

1. Site kholo → pehli call par splash aayega → PHP par challenge → wapas → catalog load.
2. DevTools → Network: `api/videos?limit=50` ka URL `https://intimora-api3.site.je/...` hona chahiye (koi proxy hop nahi), status 200, `content-type: application/json`.
3. Galat hone par kya dekho: response ka `content-type` `text/html` = cookie nahi gayi (SameSite fix missing) ya CORS header nahi (Console me `blocked by CORS policy`).

**Warning:** Safari/ITP aur 3rd-party cookie block karne wale browsers is flow me
PHP se direct baat nahi kar payenge (unke liye `PHP_PROXY_ORIGIN` fallback rakha hai).
Aur agar PHP host apni cookie `SameSite=None` re-issue nahi karta, to flow proxy par
gir jaayega.
