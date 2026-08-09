// No-op stand-in for the MongoDB driver's optional *native* add-ons
// (@mongodb-js/zstd, kerberos, mongodb-client-encryption, snappy). The driver
// require()s these in a try/catch and runs fine without them, but esbuild —
// which bundles the Worker — has no loader for the `.node` binaries they ship,
// so bundling fails outright if they happen to be installed. Aliasing them to
// this empty module (the Cloudflare-documented fix) keeps them out of the
// bundle regardless of whether a lockfile regen pulls them in. We use none of
// their features: no zstd/snappy wire compression, no Kerberos/GSSAPI auth, no
// client-side field-level encryption.
export default {};
