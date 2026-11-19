# Referral-tree backend privacy fix

The frontend already renders two levels of referrals, but deliberately does not call the current endpoint by default. In inspected backend `main` commit `c30e2712d25300ee798a9092228a5c559e287aa0`, `/api/user/referrals` sends complete descendant user records, including email, Firebase UID and liked/saved histories. Filtering after the response reaches the browser cannot protect that data.

An apply-ready [backend patch](referral-backend.patch) is provided for that commit. From a checkout of the **separate backend repository**, first run `git apply --check /path/to/Intimora/docs/referral-backend.patch`, then `git apply /path/to/Intimora/docs/referral-backend.patch`. The patch replaces `getReferralTree` in `backend/users.js` with the function below and sets `Cache-Control: private, no-store` on the authenticated referral response. Keep the route protected by Firebase authentication and pass only the authenticated UID. The output contains only the owner's code and the minimum fields for their direct and second-level descendants. It rejects duplicate/invalid codes, self-links and relationships inconsistent with the user's `referredBy` field.

```js
async function getReferralTree(uid) {
  const validCode = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
  const owner = await findByUid(uid);
  if (!owner || !validCode(owner.referralCode)) return null;

  const myCode = owner.referralCode;
  const [referrals, users] = await Promise.all([readReferrals(), readUsers()]);
  const userMap = new Map();
  for (const user of users) {
    if (!user || !validCode(user.referralCode)) continue;
    // A colliding code is ambiguous; never expose either record by accident.
    if (userMap.has(user.referralCode)) userMap.set(user.referralCode, null);
    else userMap.set(user.referralCode, user);
  }
  // If the owner's code collides, a link cannot be attributed safely.
  if (!userMap.get(myCode) || userMap.get(myCode).uid !== uid) return null;

  const seen = new Set([myCode]);
  const select = (parentCodes) => {
    const people = [];
    for (const link of referrals) {
      if (!link || !parentCodes.has(link.ownerCode) || !validCode(link.referredCode)) continue;
      const user = userMap.get(link.referredCode);
      if (!user || user.referredBy !== link.ownerCode || seen.has(user.referralCode)) continue;
      if (typeof user.username !== "string" || !user.username.trim()) continue;
      seen.add(user.referralCode);
      people.push({
        name: typeof user.name === "string" ? user.name.trim().slice(0, 100) : "",
        username: user.username.trim().slice(0, 80),
        referralCode: user.referralCode,
        referredBy: user.referredBy,
      });
    }
    return people;
  };

  const direct = select(new Set([myCode]));
  const level2 = select(new Set(direct.map((person) => person.referralCode)));
  return { code: myCode, direct, level2 };
}
```

### Response contract

The dashboard accepts this envelope as `data.tree`:

```json
{
  "code": "REF-OWN001",
  "direct": [{ "name": "Aarav", "username": "aarav", "referralCode": "REF-ABC", "referredBy": "REF-OWN001" }],
  "level2": [{ "name": "Meera", "username": "meera", "referralCode": "REF-XYZ", "referredBy": "REF-ABC" }]
}
```

- `code` must equal the requester's own `referralCode`; otherwise the client rejects the payload and the section shows a retryable error.
- `referredBy` on a **direct** entry may be omitted — the client reads that as the requester's own code — but a wrong value excludes that person. **Level-2** entries must carry the `referredBy` that links them to a direct descendant, or they cannot be placed.
- Everything else is rebuilt field by field before rendering, so extra keys never reach the page — but they still travel over the network. `email`, `firebaseUid`, `avatar`, `likedVideos`, `savedVideos`, `createdAt`, Telegram message ids and storage paths must not be in the response at all. A live payload observed during this work still returned whole user records (email, Firebase UID, empty liked/saved lists) and no `referredBy`; apply the patch above to strip them.

Verify on **both** deployed backends that the raw JSON contains no descendant emails, UIDs, `likedVideos`, `savedVideos`, Telegram message IDs, avatars or other private fields; unrelated people and ancestors must not be included. Check empty, duplicate, missing and two-level relationships with real authorized accounts. Confirm the current 5,000-message scan covers every relevant user and referral record, or implement complete pagination **before enabling**: an undetected duplicate outside the scan could misattribute a relationship, besides leaving the tree incomplete. Enforce unique referral codes when creating accounts. The local regression test uses mocked records, not the live service.

The privacy fix is deployed, so the frontend enables the referral tree by default (`INTIMORA_PUBLIC_SAFE_REFERRALS` is treated as on unless it is set to `0`). A payload whose `code` does not match the signed-in account is rejected with a retryable "Could not load referrals right now." message. Set `INTIMORA_PUBLIC_SAFE_REFERRALS=0` as a **public build-time variable** for the frontend and redeploy to hide the section entirely (it then reads "Referral details are temporarily unavailable"). The flag is a build-time constant, so a running deployment only picks up either change after a rebuild. The dashboard then loads and groups direct and second-level referrals, pinned to the backend that verified the account, with refresh and retry controls. This repository does not deploy or change the separate backend.
