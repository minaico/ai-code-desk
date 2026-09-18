/**
 * TLS for the machine-to-machine PTY channel, keyed by the shared secret
 * (no certificates).
 *
 * Every machine already has one credential: the 64-hex key in .data/host.key,
 * unique to that machine, which the web server presents in its `hello`. Until
 * now that key — and every keystroke and every line of terminal output after
 * it — crossed the LAN in clear text. Using the same key as a TLS-PSK gives the
 * channel two things a plain socket never had:
 *   - encryption, so the key and the terminal stop travelling readable;
 *   - mutual authentication, so a wrong key fails the handshake instead of
 *     reaching the command loop, and a man in the middle cannot impersonate a
 *     PTY host without the key.
 *
 * No cert files, no cert generation (Node's stdlib cannot sign one anyway), no
 * new dependency — the credential we already ship does the work. This is the
 * same approach, and very nearly the same code, as lib/tlspsk.js in the sibling
 * AIHubManager project, whose agent protocol grew out of this PTY host.
 *
 * TLS 1.2 is pinned on both ends: its PSK cipher suites authenticate directly
 * from the shared key. (TLS 1.3 external PSK is a different, heavier dance.)
 *
 * This secures the link *between* machines. It is unrelated to serving the web
 * UI over HTTPS, which is WEB_TERMINAL_TLS_CERT/_KEY and needs a real
 * certificate because browsers cannot do external PSK.
 */
const crypto = require("crypto");

/** Sent in the clear during the handshake; it names the protocol, not a user. */
const IDENTITY = "ai-code-desk";
const CIPHERS = "PSK-AES256-GCM-SHA384:PSK-AES128-GCM-SHA256";

/**
 * The key as PSK bytes.
 *
 * Keys we generate are 64 hex characters, and those are used as the 32 bytes
 * they represent. A key that is not hex is still accepted — this field has
 * always held whatever string the owner pasted — by hashing it, so both ends
 * (which run this same function) still derive the same secret.
 */
function keyBuf(key) {
  const k = String(key || "").trim();
  if (k.length < 32) throw new Error("machine key is too short for TLS");
  if (/^[0-9a-f]+$/i.test(k) && k.length % 2 === 0) return Buffer.from(k, "hex");
  return crypto.createHash("sha256").update(k, "utf8").digest();
}

/** Options for tls.createServer on the PTY host. */
function serverOptions(key) {
  const psk = keyBuf(key);
  return {
    ciphers: CIPHERS,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
    pskIdentityHint: IDENTITY,
    pskCallback: (_socket, identity) => (identity === IDENTITY ? psk : null),
  };
}

/** Options for tls.connect from the web server. */
function clientOptions(key, extra) {
  const psk = keyBuf(key);
  return {
    ciphers: CIPHERS,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
    // There is no certificate to verify; the PSK is what proves both ends.
    rejectUnauthorized: false,
    checkServerIdentity: () => undefined,
    pskCallback: () => ({ psk, identity: IDENTITY }),
    ...extra,
  };
}

module.exports = { IDENTITY, CIPHERS, keyBuf, serverOptions, clientOptions };
