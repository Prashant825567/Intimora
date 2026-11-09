import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function handoffSource() {
  const document = await readFile(path.join(root, "docs/referral-backend-handoff.md"), "utf8");
  const source = document.match(/```js\n([\s\S]*?)\n```/)?.[1];
  assert.ok(source, "the backend handoff contains runnable JavaScript");
  return source;
}

async function handoffFunction(users, referrals) {
  const source = await handoffSource();
  const factory = new Function("findByUid", "readReferrals", "readUsers", `${source}\nreturn getReferralTree;`);
  return factory(async (uid) => users.find((user) => user.uid === uid), async () => referrals, async () => users);
}

function user(uid, referralCode, referredBy, name = uid) {
  return { uid, referralCode, referredBy, name, username: uid, email: `${uid}@private.example`, likedVideos: ["private-liked"], savedVideos: ["private-saved"], _msgId: 123, avatar: "private-avatar" };
}

test("backend handoff returns only authorized two-level fields without personal histories", async () => {
  const users = [
    user("owner", "OWNER", "ANCESTOR"), user("alice", "ALICE", "OWNER", "Alice"),
    user("bob", "BOB", "OWNER", "Bob"), user("child", "CHILD", "ALICE", "Child"),
    user("third", "THIRD", "CHILD"), user("ancestor", "ANCESTOR", ""),
    user("unrelated", "OTHER", "ELSEWHERE"), user("collision1", "DUP", "OWNER"),
    user("collision2", "DUP", "OWNER"),
  ];
  const links = [
    { ownerCode: "OWNER", referredCode: "ALICE" }, { ownerCode: "OWNER", referredCode: "ALICE" },
    { ownerCode: "OWNER", referredCode: "BOB" }, { ownerCode: "OWNER", referredCode: "OTHER" },
    { ownerCode: "OWNER", referredCode: "DUP" }, { ownerCode: "OWNER", referredCode: "OWNER" },
    { ownerCode: "ALICE", referredCode: "CHILD" }, { ownerCode: "BOB", referredCode: "CHILD" },
    { ownerCode: "ALICE", referredCode: "ANCESTOR" }, { ownerCode: "CHILD", referredCode: "THIRD" },
  ];
  const buildTree = await handoffFunction(users, links);
  const tree = await buildTree("owner");
  assert.deepEqual(tree, {
    code: "OWNER",
    direct: [
      { name: "Alice", username: "alice", referralCode: "ALICE", referredBy: "OWNER" },
      { name: "Bob", username: "bob", referralCode: "BOB", referredBy: "OWNER" },
    ],
    level2: [{ name: "Child", username: "child", referralCode: "CHILD", referredBy: "ALICE" }],
  });
  assert.doesNotMatch(JSON.stringify(tree), /private\.example|private-liked|private-saved|private-avatar|_msgId|"uid"/);
  assert.equal(await buildTree("missing"), null);
});

test("backend handoff refuses an ambiguous owner code and ignores invalid records", async () => {
  const duplicateOwners = [user("owner", "OWNER", ""), user("other", "OWNER", "")];
  const buildDuplicate = await handoffFunction(duplicateOwners, []);
  assert.equal(await buildDuplicate("owner"), null);
  const malformed = [user("owner", "OWNER", ""), { ...user("bad", "BAD", "OWNER"), username: { email: "private" } }];
  const buildMalformed = await handoffFunction(malformed, [{ ownerCode: "OWNER", referredCode: "BAD" }]);
  assert.deepEqual(await buildMalformed("owner"), { code: "OWNER", direct: [], level2: [] });
});

test("apply-ready referral patch matches the tested projection and disables caching", async () => {
  const patch = await readFile(path.join(root, "docs/referral-backend.patch"), "utf8");
  const after = patch.split("\n").filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || line.startsWith(" "))
    .map((line) => line.slice(1)).join("\n");
  assert.ok(after.includes(await handoffSource()), "patch and tested documentation must stay in sync");
  assert.match(after, /app\.get\("\/api\/user\/referrals", auth,[\s\S]*?res\.set\("Cache-Control", "private, no-store"\)/);
});
