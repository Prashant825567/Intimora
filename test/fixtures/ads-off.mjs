// Tests must never contact the live ad network: importing this module switches
// pre-roll ads off for every Vite server and build started by the test process.
// The dedicated ad test removes this value again and stubs the tag instead.
process.env.INTIMORA_PUBLIC_VAST_TAG_URL = "";
// Tests never unlock a live PHP host: the visitor row then travels through the
// mocked server this test already controls. The dedicated test sets its own
// identity host explicitly.
process.env.INTIMORA_PUBLIC_IDENTITY_URL = "";
process.env.INTIMORA_PARTNER_FEED_OFFLINE = "1";
process.env.INTIMORA_AD_PROBE_OFFLINE = "1";
