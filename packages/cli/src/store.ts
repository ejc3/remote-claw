// The secret store (§3.1/§4.1): the single owner of all secret-file I/O. The host's root
// secret S lives in ONE local file as its `rc1_…` token text (not raw bytes) — so the file
// is exactly the shareable artifact, and a truncated/corrupt file fails the checksum LOUDLY
// on read (parseSecret) instead of silently deriving a wrong identity.
//
// Creation is crash-safe AND create-once: the token is written to a unique temp file, fsynced,
// then hard-linked into place — link(2) is atomic and fails if the target exists, so there is
// never a zero-length canonical file (a crash leaves only an orphan temp) and a concurrent
// create can never be clobbered. Reads refuse symlinks (O_NOFOLLOW) and group/other-readable
// modes, and never block on a FIFO (O_NONBLOCK). No network, no globals beyond env/clock.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as FS,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir as osHomedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  deriveIdentity,
  formatSecret,
  generateSecret,
  parseSecret,
  SecretError,
} from "@remote-claw/clawsec";

const SECRET_MODE = 0o600;
const DIR_MODE = 0o700;
/** Where the default secret lives, under $XDG_STATE_HOME (or ~/.local/state). */
const APP_DIR = "remote-claw";
const SECRET_BASENAME = "secret";
/** A created_at value is trusted only if it looks like an ISO-8601 instant (no escape injection). */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export type StoreErrorCode =
  | "NOT_FOUND"
  | "NOT_A_FILE"
  | "INSECURE_PERMS"
  | "SYMLINK_REFUSED"
  | "BAD_SECRET"
  | "IO";

/** A typed failure from the store, carrying a stable `code` for the CLI to map to exit/message. */
export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
  static is(e: unknown): e is StoreError {
    return e instanceof StoreError;
  }
}

/** Injected environment for path resolution — keeps `resolveSecretPath` pure/testable. */
export interface StoreEnv {
  env: NodeJS.ProcessEnv;
  homedir: () => string;
}

/** Injected clock so `created_at` is deterministic in tests. */
export interface StoreDeps {
  now: () => Date;
}

/** Which source won path resolution (for diagnostics / `source` in tests). */
export type PathSource = "flag" | "env" | "xdg" | "home";

export interface ResolvedPath {
  path: string;
  source: PathSource;
}

interface IdentityCommon {
  secretPath: string;
  /** Public 16-byte id, lowercase hex via clawsec toHex (caller renders). */
  identityId: Uint8Array;
}

export interface CreatedIdentity extends IdentityCommon {
  created: true;
  createdAt: string;
  /** The `rc1_…` token — emitted to the user ONCE, at creation. */
  token: string;
}

export interface LoadedIdentity extends IdentityCommon {
  created: false;
  /** ISO-8601 from the sidecar, or null when it is missing/unparseable. */
  createdAt: string | null;
}

function defaultEnv(): StoreEnv {
  return { env: process.env, homedir: osHomedir };
}

/** Expand a leading `~`/`~/` against the home dir (bare `~` → home). */
function expandTilde(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/**
 * Resolve the secret-file path (§3.1). Precedence, first non-empty wins:
 *   --rc-file  >  REMOTE_CLAW_SECRET_FILE  >  $XDG_STATE_HOME/remote-claw/secret
 *   >  ~/.local/state/remote-claw/secret
 * Empty strings count as unset (`||`, mirroring run.ts's RC_CLAUDE_BIN handling). A relative
 * $XDG_STATE_HOME is ignored per the XDG spec; every result is absolutized (so a relative
 * --rc-file or a relative $HOME never lands an unexpected path under the cwd).
 */
export function resolveSecretPath(
  opts: { file?: string },
  storeEnv: StoreEnv = defaultEnv(),
): ResolvedPath {
  const home = storeEnv.homedir();
  const { env } = storeEnv;

  const flag = opts.file;
  if (flag) return { path: resolve(expandTilde(flag, home)), source: "flag" };

  const envFile = env.REMOTE_CLAW_SECRET_FILE;
  if (envFile) return { path: resolve(expandTilde(envFile, home)), source: "env" };

  const xdg = env.XDG_STATE_HOME;
  // XDG spec: a relative $XDG_STATE_HOME is invalid and must be ignored.
  if (xdg && isAbsolute(xdg)) {
    return { path: resolve(join(xdg, APP_DIR, SECRET_BASENAME)), source: "xdg" };
  }

  return { path: resolve(join(home, ".local", "state", APP_DIR, SECRET_BASENAME)), source: "home" };
}

function sidecarPathFor(secretPath: string): string {
  return `${secretPath}.created`;
}

/** First line, trimmed (the token / created_at file is a single short line). */
function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

/** Map a fs errno error to a StoreError with a stable code (or rethrow non-fs errors). */
function mapFsError(e: unknown, secretPath: string): never {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") throw new StoreError("NOT_FOUND", `${secretPath}: no such file`);
  if (code === "ELOOP") {
    throw new StoreError("SYMLINK_REFUSED", `refusing to follow a symlink at ${secretPath}`);
  }
  if (code === "EISDIR") {
    throw new StoreError("NOT_A_FILE", `${secretPath} is a directory, not a secret file`);
  }
  const msg = e instanceof Error ? e.message : String(e);
  throw new StoreError("IO", msg);
}

/** Open a path for reading, refusing symlinks and never blocking on a FIFO. */
function openForRead(path: string): number {
  try {
    // O_NOFOLLOW: a symlink throws ELOOP. O_NONBLOCK: a writer-less FIFO returns instead of
    // blocking forever, so the isFile() check below can reject it as NOT_A_FILE.
    return openSync(path, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  } catch (e) {
    mapFsError(e, path);
  }
}

/** Close an fd, swallowing a close error so it can't mask the in-flight (real) error. */
function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    /* a deferred I/O error on close must not replace the primary error */
  }
}

/**
 * Read + validate an existing secret file. Refuses symlinks (O_NOFOLLOW), FIFOs (O_NONBLOCK +
 * isFile), non-regular files, and group/other-accessible perms; validates the token via
 * parseSecret. Returns the 32-byte secret and the sidecar `created_at`. Throws StoreError
 * (code NOT_FOUND when the file is absent). Never creates anything.
 */
export async function loadSecret(
  secretPath: string,
): Promise<{ secret: Uint8Array; createdAt: string | null }> {
  const fd = openForRead(secretPath);
  let tokenText: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new StoreError("NOT_A_FILE", `${secretPath} is not a regular file`);
    }
    // A secret readable by group/other is a real exposure under the zero-knowledge model.
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
      throw new StoreError(
        "INSECURE_PERMS",
        `${secretPath} is group/other-accessible; run: chmod 600 ${secretPath}`,
      );
    }
    tokenText = readFileSync(fd, "utf8");
  } finally {
    closeQuietly(fd);
  }

  let secret: Uint8Array;
  try {
    secret = await parseSecret(firstLine(tokenText));
  } catch (e) {
    if (SecretError.is(e)) {
      throw new StoreError("BAD_SECRET", `${secretPath} is not a valid secret (${e.reason})`);
    }
    throw e;
  }
  return { secret, createdAt: readSidecar(secretPath) };
}

/** loadSecret, but return null instead of throwing when the file simply does not exist. */
async function tryLoadSecret(
  secretPath: string,
): Promise<{ secret: Uint8Array; createdAt: string | null } | null> {
  try {
    return await loadSecret(secretPath);
  } catch (e) {
    if (StoreError.is(e) && e.code === "NOT_FOUND") return null;
    throw e;
  }
}

/** Read the sidecar `created_at` — symlink/FIFO-safe, and trusted only if it's an ISO instant. */
function readSidecar(secretPath: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(sidecarPathFor(secretPath), FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return null;
    const line = firstLine(readFileSync(fd, "utf8"));
    return ISO_RE.test(line) ? line : null;
  } catch {
    return null; // best-effort: a missing/odd sidecar just means created_at is unknown
  } finally {
    if (fd !== undefined) closeQuietly(fd);
  }
}

/** Write `content` fully to `fd` (writeSync may short-write on quota/NFS/FUSE). */
function writeAll(fd: number, content: string): void {
  const buf = Buffer.from(content, "utf8");
  let off = 0;
  while (off < buf.length) {
    off += writeSync(fd, buf, off, buf.length - off);
  }
}

/** A collision-free temp path beside `path` (random suffix → safe across PID reuse/namespaces). */
function tempPathFor(path: string): string {
  return `${path}.${randomBytes(6).toString("hex")}.tmp`;
}

/** Write `content` to a fresh 0600 temp beside `path`, fsynced. Returns the temp path. */
function writeTempSecret(path: string, content: string): string {
  const tmp = tempPathFor(path);
  const fd = openSync(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, SECRET_MODE);
  try {
    fchmodSync(fd, SECRET_MODE); // override umask so the mode is exactly 0600
    writeAll(fd, content);
    fsyncSync(fd);
  } catch (e) {
    // A partial write (ENOSPC/EIO) must not leave a half-written 0600 temp behind: close + unlink
    // before propagating, so the caller never has to know the temp's random name to clean it up.
    closeQuietly(fd);
    unlinkBestEffort(tmp);
    throw e;
  }
  closeQuietly(fd);
  return tmp;
}

/**
 * Atomically create `path` containing `content`, mode 0600, failing if it already exists.
 * Writes a unique temp + fsync, then link(2)s it into place (atomic, exclusive). Returns false
 * if the target already exists (EEXIST) so the caller can fall back to a load. Crash-safe: a
 * crash leaves only an orphan temp, never a zero-length canonical file.
 */
function atomicCreateExclusive(path: string, content: string): boolean {
  let tmp: string;
  try {
    tmp = writeTempSecret(path, content);
  } catch (e) {
    // Staging failure (ENOSPC/EACCES/EIO) → mapped StoreError, so callers (ensureIdentity, the
    // --rc-keep-old backup) never see a raw fs error escape; `path` gives the right diagnostic.
    mapFsError(e, path);
  }
  try {
    linkSync(tmp, path); // atomic + exclusive: EEXIST if anything already occupies `path`
  } catch (e) {
    unlinkBestEffort(tmp);
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    mapFsError(e, path);
  }
  unlinkBestEffort(tmp); // the content now lives at `path` via the hard link
  return true;
}

/**
 * Best-effort overwrite of an open file's bytes with random data + fsync (no unlink). The secret
 * file is one short line (~57 bytes); the scrub is capped so a `--rc-file` aimed at a huge file
 * can't force a multi-gigabyte `randomBytes` allocation. Overwriting the head destroys the
 * single-line token, which is all that addresses the (now-dead) identity.
 */
function scrubFd(fd: number): void {
  const SCRUB_CAP = 1 << 16; // 64 KiB — far more than a token line, bounded regardless of file size
  try {
    const st = fstatSync(fd);
    const size = st.isFile() ? Math.min(Number(st.size), SCRUB_CAP) : 0;
    if (size > 0) {
      writeSync(fd, randomBytes(size), 0, size, 0);
      fsyncSync(fd);
    }
  } catch {
    /* best-effort: a failed scrub still leaves the identity invalidated by the new S */
  }
}

/** fsync the directory holding `filePath` so a rename/unlink is durable. Best-effort. */
function fsyncDirBestEffort(filePath: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirname(filePath), FS.O_RDONLY | (FS.O_DIRECTORY ?? 0));
    fsyncSync(fd);
  } catch {
    /* directory fsync is EINVAL/unsupported on some platforms (e.g. macOS) — best-effort */
  } finally {
    if (fd !== undefined) closeQuietly(fd);
  }
}

function unlinkBestEffort(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* orphan temp is harmless (unique name); nothing depends on its removal */
  }
}

/**
 * Create-once OR load the host identity at `secretPath` (§3.1 `--rc-identity`). An existing
 * valid secret is loaded and derived — never regenerated, no fresh secret is even generated.
 * Otherwise S is generated, derived, and written crash-safely + exclusively (so a concurrent
 * or prior create is never clobbered, and a crash never wedges the path), plus a 0600 sidecar
 * with `created_at`.
 */
export async function ensureIdentity(
  secretPath: string,
  deps: StoreDeps = { now: () => new Date() },
): Promise<CreatedIdentity | LoadedIdentity> {
  try {
    mkdirSync(dirname(secretPath), { recursive: true, mode: DIR_MODE });
  } catch (e) {
    mapFsError(e, secretPath);
  }

  // Fast path: a valid secret already exists → load + derive, no generation. This also rejects
  // a symlink/FIFO/dir/insecure/corrupt path up front (StoreError propagates; only a genuinely
  // absent file returns null).
  const existing = await tryLoadSecret(secretPath);
  if (existing) {
    const id = await deriveIdentity(existing.secret);
    return { created: false, secretPath, identityId: id.identityId, createdAt: existing.createdAt };
  }

  const { secret, token } = await generateSecret();
  const createdAt = deps.now().toISOString();

  if (!atomicCreateExclusive(secretPath, `${token}\n`)) {
    // Lost a create race since the probe — load the winner's identity, never our generated one.
    const loaded = await loadSecret(secretPath);
    const id = await deriveIdentity(loaded.secret);
    return { created: false, secretPath, identityId: id.identityId, createdAt: loaded.createdAt };
  }

  writeSidecar(sidecarPathFor(secretPath), createdAt);
  const id = await deriveIdentity(secret);
  return { created: true, secretPath, identityId: id.identityId, createdAt, token };
}

/**
 * Write the `created_at` sidecar (temp + rename). Best-effort: the secret is already safely
 * written, so a sidecar failure must not fail the create — `created_at` just reads back as null.
 */
function writeSidecar(sidecarPath: string, createdAt: string): void {
  let tmp: string | undefined;
  try {
    tmp = writeTempSecret(sidecarPath, `${createdAt}\n`);
    renameSync(tmp, sidecarPath); // replace any existing sidecar atomically
  } catch {
    if (tmp) unlinkBestEffort(tmp);
  }
}

export interface RotatedIdentity {
  /** The NEW `rc1_…` token — emitted to the user ONCE, on a successful rotate. */
  token: string;
  /** The NEW public identity_id. */
  identityId: Uint8Array;
  /** The OLD (now-destroyed) public identity_id, for the summary. */
  oldIdentityId: Uint8Array;
  createdAt: string;
  /** Where the old secret was kept (`--rc-keep-old`), or null when it was scrubbed. */
  backupPath: string | null;
}

/**
 * Rotate the identity at `secretPath` (§3.1 `--rc-rotate`, the ONLY destructive path): generate a
 * NEW S — a NEW identity — write it durably, and either best-effort scrub the old secret (default)
 * or keep it as a `0600` `<path>.old` backup (still a live credential). The NEW token is durable
 * on disk BEFORE the old is replaced, and the canonical path is only ever the old or the new
 * secret (atomic rename) — never missing or garbage. The old identity and all its spaces are gone.
 *
 * Secure-delete is best-effort: an in-place overwrite cannot guarantee erasure on CoW / SSD /
 * log-structured / journaling filesystems — the real guarantee is that a new S is a new identity,
 * so the old key set no longer addresses any live bus. Caller must have a verified secret (this
 * calls loadSecret, which rejects symlink/insecure/corrupt/absent up front).
 */
export async function rotateIdentity(
  secretPath: string,
  deps: { now: () => Date; keepOld: boolean },
): Promise<RotatedIdentity> {
  const old = await loadSecret(secretPath);
  const oldId = await deriveIdentity(old.secret);

  const { secret: newSecret, token: newToken } = await generateSecret();
  const createdAt = deps.now().toISOString();
  const newId = await deriveIdentity(newSecret);

  const backupPath = deps.keepOld ? `${secretPath}.old` : null;

  // writeTempSecret is inside the try so a raw fs error (ENOSPC/EACCES) maps to StoreError too,
  // instead of escaping unmapped and crashing the CLI with a stack trace.
  let tmpNew: string | undefined;
  let backupCreated = false;
  try {
    tmpNew = writeTempSecret(secretPath, `${newToken}\n`); // new is durable before any destroy
    if (backupPath) {
      // Keep the old secret as an exclusive 0600 backup; refuse to clobber a prior (still-live) one.
      const oldToken = await formatSecret(old.secret);
      if (!atomicCreateExclusive(backupPath, `${oldToken}\n`)) {
        throw new StoreError(
          "IO",
          `a backup already exists at ${backupPath}; remove it before rotating with --rc-keep-old`,
        );
      }
      backupCreated = true;
      renameSync(tmpNew, secretPath); // replace canonical; the backup retains the old secret
      fsyncDirBestEffort(secretPath); // make the .old link + canonical rename durable
    } else {
      // Hold a handle to the old inode across the atomic replace, then scrub its bytes — so the
      // path is always old-or-new and the old blocks are best-effort overwritten before freed.
      const oldFd = openSync(secretPath, FS.O_RDWR | FS.O_NOFOLLOW);
      try {
        renameSync(tmpNew, secretPath); // path → new token; old inode kept alive by oldFd
        // Make the rename DURABLE before scrubbing: scrubFd fsyncs the old inode's bytes, so a power
        // loss after the scrub but before the dir entry persists could otherwise leave canonical →
        // the (now-garbage) scrubbed old inode. Dir-fsync first keeps the path always old-or-new.
        fsyncDirBestEffort(secretPath);
        scrubFd(oldFd);
      } finally {
        closeQuietly(oldFd); // old inode freed (scrubbed)
      }
    }
  } catch (e) {
    if (tmpNew) unlinkBestEffort(tmpNew);
    // If we created the .old backup but a later step (e.g. the rename) failed, the canonical path
    // still holds the OLD secret — so drop our just-made backup, else it orphans a duplicate that
    // wedges every future --rc-keep-old rotate (atomicCreateExclusive refuses EEXIST).
    if (backupCreated && backupPath) unlinkBestEffort(backupPath);
    if (StoreError.is(e)) throw e;
    mapFsError(e, secretPath);
  }

  writeSidecar(sidecarPathFor(secretPath), createdAt); // replaces the old sidecar with the new time
  return {
    token: newToken,
    identityId: newId.identityId,
    oldIdentityId: oldId.identityId,
    createdAt,
    backupPath,
  };
}
