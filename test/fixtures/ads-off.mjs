// Tests must never contact the live ad network: importing this module switches
// pre-roll ads off for every Vite server and build started by the test process.
// The dedicated ad test removes this value again and stubs the tag instead.
process.env.INTIMORA_PUBLIC_VAST_TAG_URL = "";
