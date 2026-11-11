// Paste the TubeCorporate campaign or feed URL between the quotes below, then
// save (and commit) this file. It is the iframe source for the sponsored block
// on the site, so it is public information, not a secret.
//
// Examples of the shape that is accepted:
//   https://hdzog.com/embed/2168747?source=1849513610
//   https://hdzog.com/feed/12345?source=1849513610
//   https://tubecorporate.com/...
//
// Leave it empty to use the built-in campaign URL below. The campaign `source`
// parameter is added automatically when the pasted URL does not contain one,
// so a feed URL that is missing it still works.
//
// Only https URLs on hdzog.com / tubecorporate.com (or their subdomains) are
// accepted. The build fails with a clear message for any other host, so a
// mistyped value can never ship.
export const PARTNER_EMBED_URL = "https://hdzog.com/embed/2168747?source=1849513610";
