import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPremiumWindow, parsePremiumEntry, parsePremiumPeriods, parsePremiumStatus, redeemErrorCode, redeemErrorMessage, redemptionSeconds } from "../src/services/premium.mjs";

// Exactly the shape the backend documents for GET /api/premium/status.
const status = {
  ok: true,
  data: {
    active: true,
    until: 1795400000,
    remainingSeconds: 17842,
    referrals: {
      total: 4, used: 2, available: 2,
      availableCodes: ["REF-A1B2C3", "REF-D4E5F6"],
      secondsEach: 9000, hoursEach: 2.5,
    },
    referralCode: "REF-U1X9",
  },
};

test("the status object is read as sent, and an inactive window has no end date", () => {
  const parsed = parsePremiumStatus(status);
  assert.equal(parsed.active, true);
  assert.equal(parsed.remainingSeconds, 17842);
  assert.equal(parsed.until, 1795400000);
  assert.deepEqual(parsed.referrals, {
    total: 4, used: 2, available: 2,
    availableCodes: ["REF-A1B2C3", "REF-D4E5F6"],
    secondsEach: 9000, hoursEach: 2.5,
  });
  assert.equal(parsed.referralCode, "REF-U1X9");

  const idle = parsePremiumStatus({ ok: true, data: { active: false, until: 1795400000, remainingSeconds: 0, referrals: {} } });
  assert.equal(idle.active, false);
  assert.equal(idle.until, 0, "an inactive window is not shown as ending later");
  assert.equal(idle.remainingSeconds, 0);
  assert.deepEqual(idle.referrals.availableCodes, []);

  // A bare object (no `data` wrapper) is accepted; junk is not.
  assert.equal(parsePremiumStatus({ active: false }).active, false);
  for (const junk of [null, undefined, "x", 5, []]) assert.equal(parsePremiumStatus(junk), null);
});

test("a redemption is priced from the status, and every refusal has its own sentence", () => {
  const parsed = parsePremiumStatus(status);
  assert.equal(redemptionSeconds(parsed, 0), 0);
  assert.equal(redemptionSeconds(parsed, 1), 9000);
  assert.equal(redemptionSeconds(parsed, 2), 18000);
  assert.equal(redemptionSeconds(parsed, 4), 36000);
  assert.equal(redemptionSeconds(null, 2), 0);

  assert.equal(redeemErrorCode("Koi referral available nahi hai"), "none_available");
  assert.equal(redeemErrorCode("Sirf 2 referral available hain"), "not_enough");
  assert.equal(redeemErrorCode("Kam se kam 1 referral chahiye"), "too_few");
  assert.equal(redeemErrorCode("something else entirely"), "unavailable");
  assert.equal(redeemErrorCode(null), "unavailable");
  for (const code of ["none_available", "not_enough", "too_few", "unavailable"]) {
    assert.match(redeemErrorMessage(code), /\w/);
    assert.doesNotMatch(redeemErrorMessage(code), /Koi referral available nahi hai\./, "the host's own sentence is never repeated verbatim");
  }
});

test("a redeemed entry carries the new status; a history row without seconds is dropped", () => {
  const entry = parsePremiumEntry({
    ok: true,
    data: {
      status: status.data,
      entry: { id: "pp_x", seconds: 18000, refsUsed: ["REF-A1B2C3", "REF-D4E5F6"], startedAt: 1795378000, endsAt: 1795396000 },
    },
  });
  assert.equal(entry.seconds, 18000);
  assert.deepEqual(entry.refsUsed, ["REF-A1B2C3", "REF-D4E5F6"]);
  assert.equal(entry.status.active, true, "the answer's status is kept, so the page updates without a second call");
  assert.equal(parsePremiumEntry({ data: { entry: { id: "no-seconds" } } }), null);

  const history = parsePremiumPeriods({
    ok: true,
    data: {
      periods: [
        { id: "pp_ab12cd", source: "referral", hours: 5, seconds: 18000, refsUsed: ["REF-A1B2C3"], amountPaise: 0, startedAt: 1795378000, endsAt: 1795396000, at: 1795378000 },
        { id: "broken" },
        { id: "paid", source: "admin", seconds: 86400, amountPaise: 9900, at: 1795000000 },
      ],
      total: { seconds: 104400, amountPaise: 9900, bySource: { referral: { periods: 1, seconds: 18000, amountPaise: 0 } } },
      status: status.data,
    },
  });
  assert.deepEqual(history.periods.map((period) => period.id), ["pp_ab12cd", "paid"]);
  assert.equal(history.periods[1].amountPaise, 9900);
  assert.equal(history.total.seconds, 104400);
  assert.deepEqual(history.total.bySource.referral, { periods: 1, seconds: 18000, amountPaise: 0 });
  assert.equal(history.status.active, true);
  assert.deepEqual(parsePremiumPeriods(null).periods, [], "an empty answer is an empty history, not a crash");
});

test("the remaining window reads as time, never as a date", () => {
  assert.equal(formatPremiumWindow(17842), "4h 57m");
  assert.equal(formatPremiumWindow(18000), "5h 0m");
  assert.equal(formatPremiumWindow(750), "12m 30s");
  assert.equal(formatPremiumWindow(45), "45s");
  assert.equal(formatPremiumWindow(0), "0m");
  assert.equal(formatPremiumWindow(-5), "0m");
  assert.equal(formatPremiumWindow("9000"), "2h 30m");
});
