// §3.6: store the resolved viewer credential (the rcp1_ pass) so a STORAGE DUMP can't exfiltrate it.
//
// The pass is encrypted under a NON-EXTRACTABLE AES-256-GCM "device key" (generated with
// extractable:false) that lives in IndexedDB. `crypto.subtle.exportKey` then throws, so no JS — including
// injected XSS reading IndexedDB — can ever read the device-key bytes; it can only USE the handle via
// WebCrypto. The encrypted blob is kept in sessionStorage (tab-scoped, as the bare pass was), so the
// credential is still cleared when the tab closes, AND the at-rest bytes are an opaque ciphertext.
//
// To decrypt, an attacker needs BOTH stores (the sessionStorage blob + the IndexedDB key handle) AND the
// ability to call WebCrypto in the page — i.e. a RESIDENT XSS, not a passive storage copy. Non-extractability
// bounds EXFILTRATION, not in-situ misuse; a server-delivered viewer is not zero-knowledge against a
// compromised app-delivery server (docs/ephemeral-handoff.md §1). This is the §3.6 hardening of the
// post-claim residual, not a fix for that limit.
//
// The crypto core (newDeviceKey / wrapPass / unwrapPass) is pure WebCrypto so it unit-tests in node; the
// IndexedDB + sessionStorage glue is a thin browser-only adapter.

export interface WrappedPass {
  iv: Uint8Array;
  ct: Uint8Array;
}

/** A fresh NON-EXTRACTABLE AES-256-GCM key. exportKey() will throw for it — the bytes never leave WebCrypto. */
export function newDeviceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function wrapPass(pass: string, key: CryptoKey): Promise<WrappedPass> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(pass) as BufferSource,
  );
  return { iv, ct: new Uint8Array(ct) };
}

export async function unwrapPass(blob: WrappedPass, key: CryptoKey): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: blob.iv as BufferSource },
    key,
    blob.ct as BufferSource,
  );
  return new TextDecoder().decode(pt);
}

// ---- browser glue: a non-extractable device key in IndexedDB + the wrapped blob in sessionStorage --------

const IDB_NAME = "remote-claw";
const IDB_STORE = "cred";
const DEVICE_KEY_ID = "device-key";
const BLOB_KEY = "rc-pass-wrapped"; // sessionStorage key

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbReq<T>(op: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    op.onsuccess = () => resolve(op.result);
    op.onerror = () => reject(op.error);
  });
}

/** Get-or-create the persistent NON-EXTRACTABLE device key (stored as an opaque CryptoKey handle in IDB). */
async function deviceKey(): Promise<CryptoKey> {
  const db = await idb();
  try {
    const ro = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE);
    const existing = await idbReq(ro.get(DEVICE_KEY_ID));
    if (existing instanceof CryptoKey) return existing;
    const key = await newDeviceKey();
    const rw = db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE);
    await idbReq(rw.put(key, DEVICE_KEY_ID)); // structured-clone keeps it non-extractable
    return key;
  } finally {
    db.close();
  }
}

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string): Uint8Array =>
  new Uint8Array((s.match(/.{2}/g) ?? []).map((h) => Number.parseInt(h, 16)));

/** Encrypt + persist the pass (tab-scoped blob, persistent non-extractable key). Best-effort: a storage
 *  failure must not break a successful connect, so the caller treats a throw as "not persisted". */
export async function saveCredential(pass: string): Promise<void> {
  const key = await deviceKey();
  const { iv, ct } = await wrapPass(pass, key);
  sessionStorage.setItem(BLOB_KEY, JSON.stringify({ iv: hex(iv), ct: hex(ct) }));
}

/** Load + decrypt the persisted pass, or null if absent/undecryptable. */
export async function loadCredential(): Promise<string | null> {
  const raw = sessionStorage.getItem(BLOB_KEY);
  if (raw === null) return null;
  let parsed: { iv?: unknown; ct?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed.iv !== "string" || typeof parsed.ct !== "string") return null;
  try {
    const key = await deviceKey();
    const pass = await unwrapPass({ iv: unhex(parsed.iv), ct: unhex(parsed.ct) }, key);
    return pass.startsWith("rcp1_") ? pass : null;
  } catch {
    return null;
  }
}

/** Forget the credential — drop the tab-scoped blob. (The non-extractable device key may remain in IDB; it
 *  is useless without the blob and cannot be exported.) */
export function clearCredential(): void {
  sessionStorage.removeItem(BLOB_KEY);
}
