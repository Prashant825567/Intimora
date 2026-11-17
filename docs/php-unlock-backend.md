# PHP host with a browser check: what the backend must provide

The frontend calls a `php: true` server **directly** — no proxy, no server in between. The browser is the only client, so three things on the PHP side decide whether the site can read the data at all. If any one of them is missing, the catalogue stays empty no matter what the frontend does.

1. `/__unlock` — a page that lets the host's own check run and then returns the visitor.
2. The `__test` cookie re-issued as `SameSite=None; Secure`, or it is never sent on a cross-site request.
3. CORS on every API answer (`Access-Control-Allow-Origin` for the exact site origin + `Access-Control-Allow-Credentials: true`), or the browser refuses to hand the JSON to the page.

The frontend side already does the rest: `credentials: "include"` on every request, the one-time unlock navigation when a request comes back as HTML (or cannot be read), a bounded retry budget, and no `crossorigin` attribute on that host's media.

## 1. The unlock page

The free host injects its scripted check into ordinary pages. That is why the unlock must be a **page load**, not a fetch: the check runs, writes `__test`, and the page continues.

`public_html/.htaccess`

```apache
RewriteEngine On
RewriteRule ^__unlock/?$ unlock.php [L,QSA]
```

`public_html/unlock.php`

```php
<?php
// Reached as https://<php-host>/__unlock?back=https://intimora.new.tg/trending
$back = isset($_GET['back']) ? (string) $_GET['back'] : 'https://intimora.new.tg/';
// Only ever bounce back to this site over HTTPS.
if (!preg_match('#^https://(?:www\.)?intimora\.new\.tg(?:[/?#]|$)#i', $back)) {
    $back = 'https://intimora.new.tg/';
}
$back = str_replace(["\r", "\n"], '', $back);

// By the time this line runs the host's check has already stored its cookie on
// a top-level navigation. Re-issue the same value for cross-site use.
if (!empty($_COOKIE['__test'])) {
    setcookie('__test', $_COOKIE['__test'], [
        'expires'  => time() + 6 * 60 * 60,
        'path'     => '/',
        'secure'   => true,
        'httponly' => false,      // the host's own script writes it
        'samesite' => 'None',     // this is the line that makes the cookie travel
    ]);
}

header('Cache-Control: no-store');
$separator = strpos($back, '?') === false ? '?' : '&';
header('Location: ' . $back . $separator . '__unlocked=1', true, 302);
exit;
```

Notes

- The frontend sends the visitor back to `?__unlocked=1` on the same page, and cleans that parameter from the address bar on arrival.
- `path=/` matters: a cookie scoped to `/api` is not sent to the unlock page and vice versa.
- If the host's check keeps setting its own `SameSite=Lax` cookie on every request, the re-issue above wins only for the requests that follow it — that is exactly the window the site needs, and it repeats the unlock once every 5.5 hours.
- `SameSite=None` requires `Secure`, which requires HTTPS. Free hosts serve HTTPS on the `*.site.je` address; keep it.

## 2. CORS on every answer (including with the cookie)

`public_html/api/_headers.php` (included first by every route) or the top of `index.php`

```php
<?php
const SITE_ORIGINS = ['https://intimora.new.tg', 'https://www.intimora.new.tg'];

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, SITE_ORIGINS, true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Access-Control-Allow-Credentials: true');
}
header('Vary: Origin');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    header('Access-Control-Allow-Methods: GET, POST, HEAD, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization, Range');
    header('Access-Control-Max-Age: 600');
    http_response_code(204);
    exit;
}
```

- `Access-Control-Allow-Origin: *` is **not** usable with cookies; the exact origin is required.
- These headers must be present on error responses too, otherwise the browser reports a CORS failure instead of showing the error.
- Media (`/thumbnail`, `/stream`) needs `Access-Control-Allow-Origin` as well when the player asks for ranges; the site sends those requests without `crossorigin`, so cookies travel, but a `206` still needs the header for the player's error reporting.

## 3. Account routes without a preflight

A preflight (`OPTIONS`) never carries cookies, so it can never pass a cookie-gated check. The frontend therefore sends account calls as **simple requests**: `POST`, `Content-Type: text/plain`, and the Firebase token inside the body.

```php
<?php
$raw  = file_get_contents('php://input');
$data = json_decode($raw, true) ?: [];
$token = $data['token'] ?? '';

// Keep the header path working for the Vercel/Node backend and older clients.
if ($token === '') {
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (preg_match('/^Bearer\s+(.+)$/i', $header, $m)) $token = trim($m[1]);
}
```

Because the session cookie is `SameSite=None`, a state-changing route should also require the expected origin:

```php
<?php
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST'
    && !in_array($_SERVER['HTTP_ORIGIN'] ?? '', SITE_ORIGINS, true)) {
    http_response_code(403);
    echo json_encode(['ok' => false, 'error' => 'bad origin']);
    exit;
}
```

## 4. Verifying without a browser

```
node scripts/php-api-check.mjs https://intimora-api2.site.je
```

It solves the host's check the way the browser's unlock page does, then walks `/api/videos`, `/api/videos/:id`, `/api/search` and the like counts, printing PASS/FAIL per row. If that prints JSON rows, the host is healthy; if it prints the challenge HTML, the check is still in front of the API and step 1 is missing.

## 5. When the site still shows "Content Unavailable"

The site names the reason now, and the same information is in the console:

```js
__intimoraDiag();   // table: target, php flag, request path + outcome, and each unlock
```

| Last event | What it means | What to fix |
|---|---|---|
| `request` with `challenge: true` | the host answered with its check page even after the unlock | step 1 or 2 — the cookie is not being re-issued as `SameSite=None`, or `/__unlock` does not return to the site |
| `request` with `blocked: true` | the browser could not read the answer at all (CORS) | step 3 — headers on that exact route, including error responses |
| `request` with `status: 5xx` | the PHP code itself failed | the route's own error log |
| `shape` | JSON arrived but without `data.videos` | the route's response shape |

The screen shows the same distinctions in plain words, and after coming back from `/__unlock` the first catalogue request is retried twice before anything is shown, so a slow cookie does not become an error page.
