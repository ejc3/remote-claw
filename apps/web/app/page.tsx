"use client";

import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Code } from "@astryxdesign/core/Code";
import { Heading } from "@astryxdesign/core/Heading";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { VStack } from "@astryxdesign/core/VStack";
import { parsePass, toHex } from "@remote-claw/clawsec";
import {
  type CSSProperties,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { clearCredential, loadCredential, saveCredential } from "./lib/credential-store";
import { claimHandoff } from "./lib/handoff-claim";
import { friendlySendError } from "./lib/send-error";
import {
  basename,
  diffOf,
  dirname,
  editStat,
  isSlashCommand,
  parseAccepted,
  parsePermissionResolved,
  parseQuestions,
  parseTask,
  parseToolResult,
  parseToolUse,
  type Question,
  sanitizeInput,
  type ToolInput,
  toolHint,
} from "./lib/transcript";
import {
  type Announce,
  CONNECTED_WINDOW_MS,
  type ConnState,
  connState,
  connStateLabel,
  emptyTranscriptHint,
  type GitInfo,
  type Harness,
  type Message,
  nextReconnectAnchor,
  shouldAcceptAnnounce,
  TRANSCRIPT_GAP_STALL_MS,
  Viewer,
} from "./lib/viewer";

export interface TranscriptGap {
  nextSeq: number;
  pending: number;
  since: number;
}

/** Max grown height of the composer textarea, in px. Mirrors `.composer-input { max-height }` in
 *  globals.css — the JS auto-grow clamp and the CSS cap must agree or the field stops short of the cap. */
const COMPOSER_MAX_H = 160;

/** Consecutive bus-subscribe failures before the "can't reach the broker" banner shows. >1 so a single
 *  transient SSE blip (which Viewer.announces retries through silently) never flashes the banner; small
 *  enough that a real outage / wrong pass surfaces within a second or two of retries. */
const BUS_ERROR_THRESHOLD = 3;
const BUS_UNREACHABLE_MSG = "Can’t reach the broker — retrying…";

/** Max images staged for one send — a bound so a runaway pick can't balloon the staged array + its object
 *  URLs. (Per-image + total BYTES are enforced separately at send time via AttachmentTooLargeError.) */
const MAX_STAGED_IMAGES = 24;
/** How long an unconfirmed optimistic permission-mode pick survives before reverting to the announced mode
 *  — a fallback so a set_mode the host never confirms (or that silently failed) can't stick indefinitely. */
const OPTIMISTIC_MODE_TTL_MS = 8000;

export function shouldShowGapRecovery(gap: TranscriptGap | null, now: number): boolean {
  return gap !== null && now - gap.since >= TRANSCRIPT_GAP_STALL_MS;
}

function isGapMessage(
  m: Message,
): m is Message & Required<Pick<Message, "nextSeq" | "pending" | "since">> {
  return (
    m.kind === "gap" &&
    typeof m.nextSeq === "number" &&
    typeof m.pending === "number" &&
    typeof m.since === "number"
  );
}

function appendUniqueMessage(prev: Message[], msg: Message): Message[] {
  if (prev.some((m) => m.msgId === msg.msgId)) return prev;
  return [...prev, msg];
}

/** A staged (queued, not-yet-sent) image in the composer: the File plus an object-URL preview. */
interface StagedImage {
  id: string;
  name: string;
  file: File;
  url: string;
}

/** The composer's send action, extracted pure for testing. All staged images of one send go as a SINGLE
 *  grouped attachment message (#114) — the host writes them all and injects ONE `@"p1" @"p2" caption`
 *  turn, so the composer text rides ONCE (not repeated per image), and `postMessage` chunks a large/many
 *  payload under the body cap. With no images, a non-empty text goes as a single prompt. */
export async function sendComposer(
  viewer: Pick<Viewer, "sendAttachment" | "sendPrompt">,
  sessionId: string,
  text: string,
  staged: readonly StagedImage[],
  downscale: (file: File) => Promise<string>,
  clientMsgId: string,
): Promise<void> {
  if (staged.length > 0) {
    const images = await Promise.all(
      staged.map(async (item) => ({
        name: item.name,
        mime: "image/jpeg",
        data: await downscale(item.file),
      })),
    );
    await viewer.sendAttachment(sessionId, { images, caption: text }, clientMsgId);
  } else if (text !== "") {
    await viewer.sendPrompt(sessionId, text, clientMsgId);
  }
}

/** The OPTIMISTIC echo (#113) of a just-sent message — rendered instantly so the user's image/text
 *  appears without waiting for the host's round-trip echo (which on a suspended iOS stream is delayed).
 *  Mirrors the host's echo text (📎 chips + caption, or the prompt) and carries `clientMsgId` so the
 *  `accepted` ack can re-key it to the real `user-<seq>` (then the host echo dedups by msgId). */
export function optimisticMessage(
  clientMsgId: string,
  text: string,
  staged: readonly StagedImage[],
): Message {
  const body =
    staged.length > 0
      ? `${staged.map((s) => `📎 ${s.name}`).join(", ")}${text ? `\n${text}` : ""}`
      : text;
  return {
    kind: "user",
    seq: null,
    text: body,
    msgId: `pending-${clientMsgId}`,
    clientMsgId,
    optimistic: true,
  };
}

/** Whether an Enter keypress in the composer should SEND (vs. insert a newline). Send on Enter only with a
 *  FINE pointer (desktop) and no Shift; on a coarse pointer (touch keyboard) Enter is always a newline — the
 *  Send button is the explicit send there (#151). Pure for testing. */
export function enterShouldSend(
  e: { key: string; shiftKey: boolean; isComposing?: boolean },
  coarsePointer: boolean,
): boolean {
  // `isComposing` guards an IME (Japanese/Chinese/Korean): pressing Enter to COMMIT a candidate fires a
  // keydown with key==="Enter" + isComposing===true — that must insert/commit, never send a half-composed
  // message. Shift+Enter is always a newline; on a touch device Enter is a newline (the button sends).
  return e.key === "Enter" && !e.shiftKey && !e.isComposing && !coarsePointer;
}

/** Re-stage the images of a FAILED send (#150) back into the composer. The send path revokes the
 *  original object URLs when it optimistically clears the composer, so a recovered preview needs a FRESH
 *  URL minted from the (still-valid) `File`. Pure + injectable `makeUrl` so it's testable without a DOM.
 *  Ids are preserved so React keys stay stable across the restore. */
export function restageImages(
  images: readonly StagedImage[],
  makeUrl: (file: File) => string,
): StagedImage[] {
  return images.map((s) => ({ id: s.id, name: s.name, file: s.file, url: makeUrl(s.file) }));
}

/** How many newly-picked images fit under the staged-count cap, and how many are dropped. A bound so a
 *  runaway pick (hundreds of files) can't balloon the staged array + its object URLs. Pure → testable. */
export function fitStaged(
  currentCount: number,
  pickedCount: number,
  max: number,
): { accept: number; dropped: number } {
  const room = Math.max(0, max - currentCount);
  const accept = Math.min(pickedCount, room);
  return { accept, dropped: pickedCount - accept };
}

/** Reconcile an optimistic echo against the host's `accepted` ack (#113): if the real `user-<seq>` echo
 *  has already arrived, drop the still-pending optimistic twin; otherwise re-key the optimistic to
 *  `user-<seq>` so the upcoming echo dedups by msgId. Either order → exactly one bubble, no flash.
 *
 *  IDEMPOTENT under a re-delivered ack (at-least-once; a #seen eviction on a long session, or a fresh
 *  orderer on revive, re-yields the seq-null `accepted`): the optimistic twin is identified ONLY by its
 *  `pending-<clientMsgId>` msgId, never by clientMsgId — once re-keyed to `user-<seq>` it no longer
 *  matches, so a second ack is a no-op instead of DELETING the already-reconciled message (whose echo,
 *  being below the orderer's seq cursor, would never be re-yielded to re-add it). Pure for testing. */
export function reconcileAccepted(prev: Message[], clientMsgId: string, seq: number): Message[] {
  const realMsgId = `user-${seq}`;
  const pendingId = `pending-${clientMsgId}`;
  if (prev.some((m) => m.msgId === realMsgId)) {
    return prev.filter((m) => m.msgId !== pendingId);
  }
  return prev.map((m) =>
    m.msgId === pendingId ? { ...m, msgId: realMsgId, optimistic: false } : m,
  );
}

export default function Home() {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [passInput, setPassInput] = useState("");
  const [handoffOtk, setHandoffOtk] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // True until we've checked storage on mount (and, if a credential is found, attempted to reconnect).
  // Initial `true` so a RETURNING user sees a brief "reconnecting" splash instead of a flash of the pass
  // form; SSR renders the splash too, so the first client render matches (no hydration mismatch).
  const [restoring, setRestoring] = useState(true);

  const connect = useCallback(async (pass: string) => {
    setError(null);
    setConnecting(true);
    try {
      // `?backend=` (e.g. sqlite) opts this session onto a non-default broker backend; the Viewer
      // forwards it as the x-broker-backend header on every broker call. Same-origin, default fetch.
      const backend = new URLSearchParams(window.location.search).get("backend") ?? undefined;
      setViewer(await Viewer.fromPass(pass, "", undefined, backend));
      // Persist only AFTER a successful connect (covers a pasted pass too) so a refresh reconnects without
      // re-pasting. Tab-scoped blob encrypted under a non-extractable device key (§3.6) — never the raw pass
      // in storage; best-effort, so a storage failure can't break a live connect.
      await saveCredential(pass).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }, []);

  // A credential may arrive in the URL fragment (never sent to the server): `#rcp1_…` is a (legacy, still
  // accepted) bare pass — prefill it; `#otk1_…` is a ONE-TIME handoff token — defer it to a gesture-gated
  // claim (NOT auto-claimed, so a prefetch/unfurler that runs JS can't burn it). Strip the fragment in both
  // cases. On a PLAIN RELOAD the fragment is gone, so restore the stored credential (§3.6) and RECONNECT
  // automatically — a reload should return to the console, not the pass form. `restoring` stays up through
  // the connect attempt; a failure falls through to the Connect screen (pass prefilled + error shown) so
  // the user can retry without re-pairing.
  const restoredOnce = useRef(false);
  useEffect(() => {
    if (restoredOnce.current) return; // once-guard: React StrictMode double-invokes effects in dev
    restoredOnce.current = true;
    const entry = entryFromFragment(window.location.hash.replace(/^#/, ""));
    if (entry.kind === "pass") {
      setPassInput(entry.value);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      setRestoring(false);
    } else if (entry.kind === "handoff") {
      setHandoffOtk(entry.value);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      setRestoring(false);
    } else {
      void loadCredential()
        .then(async (saved) => {
          if (saved !== null) {
            setPassInput(saved);
            await connect(saved);
          }
        })
        .catch(() => {}) // loadCredential's sessionStorage read can throw (blocked/partitioned) — fall to Connect
        .finally(() => setRestoring(false));
    }
  }, [connect]);

  // The mount effect only reads the fragment ONCE. If a NEW `#otk1_`/`#rcp1_` link is opened into an
  // already-loaded tab (e.g. pasting/scanning into the open viewer), the browser does a hash navigation —
  // not a remount — so without this the new link is silently ignored (it only worked after a reload).
  // Route it: a new handoff supersedes the current session (drop the viewer → show Pairing).
  useEffect(() => {
    const onHashChange = () => {
      const entry = entryFromFragment(window.location.hash.replace(/^#/, ""));
      if (entry.kind === "restore") return; // a cleared hash shouldn't tear down a live session
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      setViewer(null);
      setRestoring(false);
      if (entry.kind === "handoff") {
        setHandoffOtk(entry.value);
      } else {
        setHandoffOtk(null);
        setPassInput(entry.value);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  if (viewer !== null) {
    return (
      <Console
        viewer={viewer}
        onForget={() => {
          clearCredential(); // drop the tab-scoped blob AND the non-extractable device key
          // Reset ALL entry state so Forget lands on a clean Connect screen — not a stale Pairing screen
          // or a prefilled pass left behind.
          setViewer(null);
          setHandoffOtk(null);
          setPassInput("");
          setError(null);
        }}
      />
    );
  }
  // Restoring (mount, or an in-flight auto-reconnect from a stored credential): show a splash, not the
  // pass form — a reload should land back in the console, never make the user re-enter the token.
  if (restoring) {
    return <Reconnecting />;
  }
  if (handoffOtk !== null) {
    return (
      <Pairing
        otk={handoffOtk}
        onConnect={(pass) => {
          // Prefill the manual field too: the OTK is now burned, so if connect() fails (transient broker)
          // the resolved pass must remain usable on the Connect screen rather than being lost.
          setPassInput(pass);
          setHandoffOtk(null);
          connect(pass);
        }}
        onCancel={() => setHandoffOtk(null)}
      />
    );
  }
  return (
    <Connect
      pass={passInput}
      setPass={setPassInput}
      connect={connect}
      connecting={connecting}
      error={error}
    />
  );
}

/** Classify what's in the URL fragment on load: a legacy bare pass (`rcp1_`), a one-time handoff token
 *  (`otk1_`), or nothing — in which case we restore + reconnect from the stored credential. Pure so the
 *  load-time routing is unit-testable without a DOM. */
export function entryFromFragment(
  frag: string,
): { kind: "pass"; value: string } | { kind: "handoff"; value: string } | { kind: "restore" } {
  if (frag.startsWith("rcp1_")) return { kind: "pass", value: frag };
  if (frag.startsWith("otk1_")) return { kind: "handoff", value: frag };
  return { kind: "restore" };
}

/** A minimal splash shown while we check storage + auto-reconnect on load, so a returning user never
 *  sees the pass form flash on reload. */
export function Reconnecting() {
  return (
    <main className="connect">
      <EntryCard>
        <Brand />
        {/* Spinner's `label` renders as visible text under it, so the splash still literally says
            "Connecting…" (SSR-asserted in restore-on-load.test.ts) and now also announces it. */}
        <Spinner label="Connecting…" />
      </EntryCard>
    </main>
  );
}

/** The shared shell of the three entry screens (Reconnecting / Connect / Pairing): one centred Astryx
 *  Card with a consistent vertical rhythm. `.connect` around it is the only hand-written piece left —
 *  it does the 100dvh viewport centring, which is page-frame layout rather than anything a component
 *  covers. */
function EntryCard({ children }: { children: ReactNode }) {
  return (
    <Card className="connect-card" width="100%" maxWidth={460} padding={6}>
      <VStack gap={3}>{children}</VStack>
    </Card>
  );
}

function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark">⌘</span>
      remote-claw
    </span>
  );
}

export function Connect(props: {
  pass: string;
  setPass: (s: string) => void;
  connect: (s: string) => void;
  connecting: boolean;
  error: string | null;
}) {
  const disabled = props.connecting || props.pass.trim() === "";
  return (
    <main className="connect">
      <EntryCard>
        <Brand />
        <VStack gap={1}>
          <Heading level={1}>Drive your claude, remotely.</Heading>
          {/* `body` + secondary, NOT `supporting`: this is the screen's explanatory copy and needs to
              outrank the --rc-pass hint below it. Both were `supporting` at first, which silently
              flattened a deliberate 14px/12.5px hierarchy to a uniform 12px. */}
          <Text type="body" color="secondary" as="p">
            Paste a machine <strong>pass</strong> to read and steer its sessions — end-to-end
            encrypted.
          </Text>
        </VStack>
        {/* The page's sole input. The label is hidden but real (it was an aria-label before), and
            hasAutoFocus lands a pasted pass immediately (#design-pass) — a dedicated single-field gate
            is the canonical autofocus case. TextArea's own ≥16px font size keeps iOS from auto-zooming
            on focus, which is why we can leave pinch-zoom enabled (see layout.tsx's viewport note). */}
        <TextArea
          label="Machine pass"
          isLabelHidden
          value={props.pass}
          onChange={props.setPass}
          placeholder="rcp1_…"
          rows={2}
          hasSpellCheck={false}
          hasAutoFocus
        />
        {/* isLoading (spinner + aria-busy + non-interactive) replaces swapping the label to
            "Connecting…" — the accessible name stays stable while the state is announced. */}
        <Button
          label="Connect"
          variant="primary"
          width="100%"
          isLoading={props.connecting}
          isDisabled={disabled}
          onClick={() => props.connect(props.pass)}
        />
        {props.error !== null && (
          <Banner status="error" title={`Couldn’t load that pass: ${props.error}`} />
        )}
        {/* No `size` prop here: it is silently INERT on a Text whose `type` the theme styles. The
            theme's generated `.astryx-text.supporting { font-size: var(--text-supporting-size) }` lands
            in @layer astryx-theme, which outranks the size class in @layer astryx-base — the `xsm`
            class is emitted onto the element and changes nothing. `supporting` alone is the 12px this
            wanted anyway. */}
        <Text type="supporting" as="p">
          Get one with <Code>remote-claw --rc-pass</Code> on the machine.
        </Text>
      </EntryCard>
    </main>
  );
}

/** One-time handoff pairing (docs/ephemeral-handoff.md): a SCANNED `#otk1_…` link. The claim is gated on
 *  an explicit tap ("Pair this device") so a prefetch/unfurler that runs JS can't auto-burn the one-time
 *  token; after claiming we show the resolved machine's identity_id for the user to confirm against the
 *  host's `--rc-pass` output (binding) before connecting. */
export function Pairing(props: {
  otk: string;
  onConnect: (pass: string) => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ pass: string; idHex: string } | null>(null);
  const claiming = useRef(false); // synchronous re-entry guard (a fast double-tap must not claim twice)

  const reveal = useCallback(async () => {
    if (claiming.current) return; // the one-time token must be claimed by exactly one in-flight request
    claiming.current = true;
    setBusy(true);
    setError(null);
    try {
      const pass = await claimHandoff(props.otk);
      const identity = await parsePass(pass);
      setRevealed({ pass, idHex: toHex(identity.identityId) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      claiming.current = false;
      setBusy(false);
    }
  }, [props.otk]);

  return (
    <main className="connect">
      <EntryCard>
        <Brand />
        <Heading level={1}>Pair this device</Heading>
        {revealed === null ? (
          <>
            <Text type="body" color="secondary" as="p">
              A <strong>one-time</strong> pairing link — claim it on this device. The key never
              leaves your browser.
            </Text>
            <Button
              label="Pair this device"
              variant="primary"
              width="100%"
              isLoading={busy}
              isDisabled={busy}
              onClick={reveal}
            />
            {error !== null && <Banner status="error" title={error} />}
            {/* Deliberately a GHOST button, not a second primary: the manual path is the quiet
                alternative to the one-time link, and two filled buttons would read as equal weight. */}
            <Button
              label="Enter a pass manually instead"
              variant="ghost"
              width="100%"
              onClick={props.onCancel}
            />
          </>
        ) : (
          <>
            <Text type="body" color="secondary" as="p">
              Confirm this matches the <Code>identity_id</Code> from{" "}
              <Code>remote-claw --rc-pass</Code>:
            </Text>
            {/* The identity hex is the security-critical comparison the human makes against the
                host's `--rc-pass` output, so it gets its own block treatment (wrapping on any
                character) rather than an inline code span. */}
            <Code className="identity-hex" data-testid="identity-hex">
              {revealed.idHex}
            </Code>
            <Button
              label="Connect"
              variant="primary"
              width="100%"
              onClick={() => props.onConnect(revealed.pass)}
            />
          </>
        )}
      </EntryCard>
    </main>
  );
}

/** A coarse "N ago" label for a lapsed session (only shown once it reads as disconnected). */
function relativeTime(ms: number, now: number): string {
  const mins = Math.floor(Math.max(0, now - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** The session row's sub-line word, combining connection state + activity (#48/#58): a connected
 *  session reads its phase/needs; a lapsing one reads its link state; a gone one reads "N ago". */
function presenceWord(s: Announce, now: number, reconnectingSince: number): string {
  const cs = connState(s.sentAt, now, reconnectingSince);
  if (cs === "disconnected") return relativeTime(s.sentAt, now);
  if (cs === "reconnecting") return "reconnecting…";
  // NOT "needs you" here: the amber .needs-badge on the row-top already carries that (#design-pass) —
  // emitting it again in the sub-line read as a duplication bug and wasted the line before cwd.
  if (s.phase === "thinking") return "working…";
  return "online";
}

/** The stick-to-bottom predicate (#design-pass): is a scroll container within `threshold`px of the
 *  bottom? When true, new messages auto-scroll; when false the viewer is reading history, so we hold
 *  position and show a "jump to latest" pill instead of yanking them down. Exported for unit tests. */
export function isNearBottom(
  m: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = 64,
): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight < threshold;
}

/** What the transcript should do when its content changes (#design-pass): follow the foot when the
 *  reader is pinned there; otherwise surface the "jump to latest" pill — but ONLY when visible content
 *  actually grew, so an in-place/zero-height frame (a resolved permission renders null; an optimistic
 *  echo reconciles in place) changes the `messages` identity without popping a pill that has nothing to
 *  jump to. Pure + exported for unit tests. */
export function transcriptScrollAction(
  atBottom: boolean,
  contentGrew: boolean,
): "follow" | "show-pill" | "none" {
  if (atBottom) return "follow";
  return contentGrew ? "show-pill" : "none";
}

/** The session-list label for a session's harness (#164): which agent + how it's bridged, so the three
 *  sessions (native-RC Claude Code, tmux Claude Code, opencode) don't look identical. A legacy host omits
 *  `harness` → treated as native-RC Claude Code (the only pre-#164 driver). opencode's mode is redundant
 *  with its agent name, so it shows just "opencode"; the two Claude Code variants show RC vs TX. */
function harnessLabel(harness: Harness | undefined): string {
  if (harness?.agent === "opencode") return "opencode";
  const mode = harness?.mode === "tmux" ? "TX" : "RC";
  return `Claude Code · ${mode}`;
}

/** The session's git context (#49): branch, a dot for uncommitted changes, and ahead/behind vs its
 *  upstream (zeros omitted). A static snapshot from announce time — title carries the precise sha. */
function GitChip({ git }: { git: GitInfo }) {
  const title = [
    git.branch,
    git.sha ? `@ ${git.sha}` : "",
    git.dirty ? "· uncommitted changes" : "· clean",
    git.ahead || git.behind ? `· ↑${git.ahead} ↓${git.behind}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className="git-chip" title={title}>
      <span className="git-branch">⎇ {git.branch}</span>
      {git.dirty && (
        <span
          className="git-dirty"
          role="img"
          aria-label="uncommitted changes"
          title="uncommitted changes"
        >
          ●
        </span>
      )}
      {git.ahead > 0 && <span className="git-ab">↑{git.ahead}</span>}
      {git.behind > 0 && <span className="git-ab git-behind">↓{git.behind}</span>}
    </span>
  );
}

/** Base64 of a Blob without a per-byte loop: FileReader yields a `data:<mime>;base64,<…>` URL we slice. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("image read failed"));
    reader.onload = () => {
      const s = typeof reader.result === "string" ? reader.result : "";
      resolve(s.slice(s.indexOf(",") + 1)); // strip the "data:…;base64," prefix
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Downscale an image File to a JPEG and return base64 (no `data:` prefix), small enough for one E2E
 * frame (#44). Browser-only (canvas). The host writes the bytes + has claude `Read` them for vision.
 * Steps quality down (then dimension) until the base64 fits `maxB64` so a noisy photo still rides one
 * frame instead of failing the single-frame inbound POST.
 */
async function downscaleToBase64(file: File, maxDim = 1536, maxB64 = 900_000): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    let dim = maxDim;
    let last = "";
    for (const quality of [0.85, 0.7, 0.55, 0.45, 0.4]) {
      const scale = Math.min(1, dim / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("canvas 2d context unavailable");
      ctx.drawImage(bitmap, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", quality));
      if (blob === null) throw new Error("image encode failed");
      last = await blobToBase64(blob);
      if (last.length <= maxB64) return last;
      dim = Math.round(dim * 0.7); // still too big — shrink the longest edge and re-encode
    }
    return last; // best effort after the steps; the host enforces its own hard cap
  } finally {
    bitmap.close();
  }
}

/** A tiny three-dot "working" pulse (CSS-animated) — the viewer's thinking indicator (#48). */
function Working() {
  return (
    <span className="working" role="img" aria-label="working">
      <span />
      <span />
      <span />
    </span>
  );
}

function Console(props: { viewer: Viewer; onForget: () => void }) {
  const { viewer } = props;
  // "Forget pass" wipes the credential and forces a re-paste — a two-step confirm guards a misclick
  // (#design-pass). First click arms (auto-disarms after 4s); second click forgets. The disarm timer is
  // tracked + cleared on unmount/re-arm so it can't fire setState after Console unmounts (the confirm path
  // unmounts this component).
  const [forgetArmed, setForgetArmed] = useState(false);
  const forgetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(forgetTimer.current), []);
  const [sessions, setSessions] = useState<Map<string, Announce>>(new Map());
  const [now, setNow] = useState(() => Date.now());
  // Per-session reconnect-attempt anchor (sessionId → when the current stale period began). Set ONCE when
  // a session first reads stale and held until it's connected again; NOT reset by focus (see
  // nextReconnectAnchor) so a dead host still reaches "disconnected". Computed during render from `now`.
  const reconnectAnchors = useRef<Map<string, number>>(new Map());
  // Bumps to force the announce (bus) stream to RE-SUBSCRIBE — the presence twin of the transcript's
  // reviveKey (#121). iOS Safari suspends the in-flight fetch when the page is backgrounded, so without
  // this the announce stream stays dead on return and the session would read as disconnected forever.
  const [announceRevive, setAnnounceRevive] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  // The bus-transport banner: shown only when reaching the broker FAILS persistently (a wrong/stale pass
  // or a broker outage), so the user isn't left staring at an empty session list with no idea why. null =
  // healthy. Discovery itself never stops retrying (see Viewer.announces) — this is purely the signal.
  const [busError, setBusError] = useState<string | null>(null);
  const busFailures = useRef(0);

  // Tail the bus → live session list (keep the freshest sent_at per session: replay-safe presence). The
  // generator owns its own retry and never throws; it reports transport health via the callback. We count
  // CONSECUTIVE failures and only raise the banner past a threshold, so a single SSE blip doesn't flash it,
  // while a sustained outage becomes visible. Any success (a frame, or a clean drain) clears it at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: announceRevive is a re-subscribe TRIGGER.
  useEffect(() => {
    const ac = new AbortController();
    busFailures.current = 0;
    void (async () => {
      for await (const a of viewer.announces(ac.signal, (err) => {
        if (ac.signal.aborted) return;
        if (err === null) {
          busFailures.current = 0;
          setBusError(null);
          return;
        }
        busFailures.current += 1;
        if (busFailures.current >= BUS_ERROR_THRESHOLD) setBusError(BUS_UNREACHABLE_MSG);
      })) {
        setSessions((prev) => {
          const next = new Map(prev);
          const existing = next.get(a.sessionId);
          if (shouldAcceptAnnounce(existing, a)) next.set(a.sessionId, a);
          return next;
        });
      }
    })();
    return () => ac.abort();
  }, [viewer, announceRevive]);

  // Re-evaluate presence on a timer so rows grey out as announces lapse.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  // On return-to-foreground: advance the clock and re-subscribe the announce stream (iOS suspends the bus
  // SSE while hidden). The post-return render then anchors each still-stale session's reconnect attempt at
  // `now` (see anchorFor), so a returning tab shows "reconnecting" for a full window while the re-subscribe
  // pulls a fresh announce — and a dead host still reaches "disconnected" since the anchor isn't re-reset.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        setAnnounceRevive((k) => k + 1);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const list = [...sessions.values()].sort((a, b) => b.sentAt - a.sentAt);
  const current = selected !== null ? sessions.get(selected) : undefined;

  // The reconnect-attempt anchor for a session at the current `now` (set-once-while-stale, cleared when
  // connected). Mutates the ref cache in place — idempotent for a given (sentAt, now), and prunes the
  // anchor once reconnected so the map can't grow unbounded.
  const anchorFor = (s: Announce): number => {
    const stale = now - s.sentAt >= CONNECTED_WINDOW_MS;
    const next = nextReconnectAnchor(reconnectAnchors.current.get(s.sessionId), stale, now);
    if (next === undefined) reconnectAnchors.current.delete(s.sessionId);
    else reconnectAnchors.current.set(s.sessionId, next);
    return next ?? 0;
  };

  return (
    <div className="app">
      <header className="topbar">
        <Brand />
        <span className="count">
          {list.length} session{list.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          className={forgetArmed ? "ghost ghost-danger" : "ghost"}
          aria-label={forgetArmed ? "Confirm forget pass" : "Forget pass"}
          onClick={() => {
            if (forgetArmed) {
              props.onForget();
              return;
            }
            setForgetArmed(true);
            // Only reachable while disarmed (the armed path returns above), so no timer is outstanding;
            // the unmount cleanup effect handles the confirm-within-4s case.
            forgetTimer.current = window.setTimeout(() => setForgetArmed(false), 4000);
          }}
        >
          {forgetArmed ? "Tap again to forget" : "Forget pass"}
        </button>
      </header>

      <div className="panes" data-view={selected === null ? "list" : "chat"}>
        <nav className="sessions">
          {/* A persistent bus-transport failure (broker outage / wrong-or-stale pass). role=alert so AT
              announces it; shown ABOVE the list since an outage usually leaves the list empty. */}
          {busError !== null && (
            <p className="bus-error" role="alert">
              {busError}
            </p>
          )}
          {/* Only claim "no sessions" when the bus is actually reachable — otherwise the real reason is the
              outage above, and "no live sessions yet" would mislead (it reads as "all good, just waiting"). */}
          {list.length === 0 && busError === null && (
            <p className="empty-pad">
              No live sessions yet. On a machine, run <code>claude --remote-control</code> through{" "}
              <code>remote-claw</code>.
            </p>
          )}
          {list.map((s) => {
            const since = anchorFor(s);
            const cs = connState(s.sentAt, now, since);
            const connected = cs === "connected";
            return (
              <button
                type="button"
                key={s.sessionId}
                className="row"
                data-active={selected === s.sessionId}
                data-state={cs}
                // Full context on hover/long-press: the sub-line truncates the cwd, so reveal the whole
                // path (+ branch) here so users can disambiguate sessions (#design-pass cwd-tooltip).
                title={`${harnessLabel(s.harness)} · ${s.title}${s.git ? ` · ${s.git.branch}` : ""}${s.cwd ? ` · ${s.cwd}` : ""}`}
                onClick={() => setSelected(s.sessionId)}
              >
                <span className="row-top">
                  {/* Color-coded dot also carries an accessible name so state isn't conveyed by hue alone. */}
                  <span
                    className="dot"
                    data-state={cs}
                    role="img"
                    aria-label={connStateLabel(cs)}
                  />
                  <span className="row-title">{s.title}</span>
                  {connected && s.needs ? (
                    <span className="needs-badge">needs you</span>
                  ) : connected && s.phase === "thinking" ? (
                    <Working />
                  ) : null}
                </span>
                <span className="row-sub">
                  {/* Which agent + mode this session is (#164) — so native-RC / tmux Claude Code /
                      opencode don't look identical in the list. */}
                  <span className="agent-badge" data-agent={s.harness?.agent ?? "claude-code"}>
                    {harnessLabel(s.harness)}
                  </span>
                  {s.git && <GitChip git={s.git} />}
                  {presenceWord(s, now, since)}
                  {s.cwd !== null ? ` · ${s.cwd}` : ""}
                </span>
              </button>
            );
          })}
        </nav>

        {selected === null ? (
          <section className="chat">
            <div className="empty">Pick a session to open its transcript.</div>
          </section>
        ) : (
          <Transcript
            key={selected}
            viewer={viewer}
            sessionId={selected}
            title={current?.title ?? selected}
            announce={current}
            now={now}
            reconnectingSince={current ? anchorFor(current) : 0}
            onBack={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}

function Transcript(props: {
  viewer: Viewer;
  sessionId: string;
  title: string;
  announce: Announce | undefined;
  now: number;
  reconnectingSince: number;
  onBack: () => void;
}) {
  const { viewer, sessionId, announce, now, reconnectingSince } = props;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [staged, setStaged] = useState<StagedImage[]>([]);
  const [sending, setSending] = useState(false);
  // Synchronous re-entry guard for send() — the `sending` STATE can't block a same-tick double-fire (a
  // double-tap / Enter-mash before React commits setSending), so the ref is the actual gate; state drives UI.
  const sendingRef = useRef(false);
  // A non-error notice for the composer (e.g. the staged-image cap) — distinct from sendError, which is a
  // send FAILURE (it renders a "Couldn't send" + Retry).
  const [stagedNotice, setStagedNotice] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  // On a COARSE pointer (phone/tablet) the on-screen keyboard's Return should insert a NEWLINE, not send —
  // sending on Enter strands multi-line prompts and mis-fires on autocorrect. Send is the explicit button.
  // Default false (SSR / desktop); a matchMedia effect flips it on a touch device. (#151)
  const [coarsePointer, setCoarsePointer] = useState(false);
  const [gap, setGap] = useState<TranscriptGap | null>(null);
  const [gapRetrying, setGapRetrying] = useState(false);
  const autoGapRetry = useRef<string | null>(null);

  // Live connection state from the freshest announce (null until one arrives — then never scary).
  // Thinking/needs are only meaningful while connected; a stale announce's phase says nothing.
  const cs = announce ? connState(announce.sentAt, now, reconnectingSince) : null;
  const connected = cs === "connected";
  const phase = connected ? (announce?.phase ?? "idle") : "idle";
  const needs = connected ? (announce?.needs ?? false) : false;

  // Resolved permissions, folded from the LOGGED permission_resolved frames (#56) — this is the source
  // of truth that survives a reload (PermissionRow's local optimistic decision does not). The host
  // replays these on catch_up, so a previously-answered request renders resolved, never re-prompting.
  const resolved = useMemo(() => {
    const m = new Map<string, "allow" | "deny">();
    for (const msg of messages) {
      if (msg.kind !== "permission_resolved") continue;
      const r = parsePermissionResolved(msg.text);
      if (r.requestId !== "") m.set(r.requestId, r.behavior);
    }
    return m;
  }, [messages]);
  // The answers an AskUserQuestion was resolved with (#42), folded from the SAME logged frames so the
  // resolved card can show WHAT was answered (not just "Answered") and it survives reload. Kept separate
  // from `resolved` (behavior-only) so the plain permission path is untouched.
  const resolvedAnswers = useMemo(() => {
    const m = new Map<string, Record<string, string | string[]>>();
    for (const msg of messages) {
      if (msg.kind !== "permission_resolved") continue;
      const r = parsePermissionResolved(msg.text);
      if (r.requestId !== "" && r.answers) m.set(r.requestId, r.answers);
    }
    return m;
  }, [messages]);
  // The host announces the worker's effective permission mode. A local click is only a transient
  // optimistic override; a CONFIRMING (or genuinely remote) mode-bearing announce wins (see the reconcile
  // effect below). `modeBeforePickRef` is the announced mode at the moment of the pick — it lets the
  // reconcile tell a stale keepalive of the pre-pick value (keep the pick) from a real remote change (yield).
  const [optimisticMode, setOptimisticMode] = useState<string | null>(null);
  const modeBeforePickRef = useRef<string | undefined>(undefined);
  // The model is set via set_model but the worker doesn't self-report it, so we track the last choice
  // ourselves to tick the active row in the sheet (#design-pass model-active-tick).
  const [optimisticModel, setOptimisticModel] = useState<string | null>(null);
  const [modeSheet, setModeSheet] = useState(false);
  const [sessionSheet, setSessionSheet] = useState(false);
  // Stick-to-bottom scrolling (#design-pass): the scroll container, whether the reader is at the bottom,
  // and the last measured scrollHeight (to tell a real content append from an in-place frame update). Refs
  // (not state) so the message-arrival effect reads the latest values without re-subscribing.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const prevScrollHeightRef = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const announceMode = announce?.mode;
  const announceSentAt = announce?.sentAt;
  const displayedMode = displayedPermissionMode(announceMode, optimisticMode);
  // Capability gating (#149): the host's driver declares which controls it can faithfully service.
  // Absent (a legacy MITM host) → assume full capability, so nothing is disabled. A driver that can't
  // honor a verb (tmux/opencode set_mode; opencode set_model) declares it false → the viewer disables
  // that control so it never shows a "✓" the worker never applied.
  const caps = announce?.capabilities;
  const canSetMode = caps?.controls.setMode ?? true;
  const canSetModel = caps?.controls.setModel ?? true;
  const canInterrupt = caps?.controls.interrupt ?? true;
  // Permissions are BYPASSED when the driver can't surface structured gates (--skip-permissions): tools
  // run without a per-tool ask. Surface the posture so the human knows edits aren't gated.
  const permsBypassed = caps?.structuredPermissions === false;

  // Reconcile a fresh announce against the optimistic pick: clear it once the announce CONFIRMS the pick or
  // shows a genuine remote change, but KEEP it while the announce still echoes the pre-pick mode (a
  // keepalive that predates the host applying our set_mode) — that echo is the flicker we're avoiding.
  // (announceSentAt is in the deps so each new announce re-evaluates, even one with the same mode string.)
  // biome-ignore lint/correctness/useExhaustiveDependencies: announceSentAt is the per-announce re-trigger.
  useEffect(() => {
    if (shouldClearOptimisticMode(announceMode, optimisticMode, modeBeforePickRef.current)) {
      setOptimisticMode(null);
    }
  }, [announceMode, announceSentAt, optimisticMode]);
  // Fallback: an optimistic pick the host never confirms (silent failure / no re-announce) must not stick —
  // revert to the announced mode after a bounded wait. Re-armed on each new pick; cleared when it resolves.
  useEffect(() => {
    if (optimisticMode === null) return;
    const t = setTimeout(() => setOptimisticMode(null), OPTIMISTIC_MODE_TTL_MS);
    return () => clearTimeout(t);
  }, [optimisticMode]);

  // Detect a coarse (touch) pointer so Enter inserts a newline instead of sending (#151). Tracked live —
  // a 2-in-1 / external-keyboard switch flips the media query — so the composer adapts without a reload.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(pointer: coarse)");
    setCoarsePointer(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setCoarsePointer(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // If capabilities arrive (or change) to say this driver can't switch mode, drop any optimistic mode and
  // close the sheet: a driver that can't honor set_mode never announces a confirmed `mode`, so the effect
  // above would never clear a stale optimistic pick made during the pre-announce window when the button was
  // still enabled — leaving the (now-disabled) button showing a Plan/Code mode the worker never entered.
  useEffect(() => {
    if (!canSetMode) {
      setOptimisticMode(null);
      setModeSheet(false);
    }
  }, [canSetMode]);

  // `reviveKey` bumps to force a transcript RE-SUBSCRIBE without losing what's shown — the recovery for
  // iOS Safari SUSPENDING a fetch stream when the page is backgrounded (the photo picker opening, an app
  // switch): the suspended stream never delivers `done`/error, so transcript()'s own re-subscribe loop
  // can't fire; aborting + recreating the generator is the only way to reattach. After attaching, the
  // transcript would otherwise stall until reload.
  const [reviveKey, setReviveKey] = useState(0);
  // The (viewer, sessionId) the currently-shown messages belong to. A revive keeps them; a switch to a
  // different session OR a different viewer (new credential) must start from a blank transcript.
  const streamKey = useRef<{ viewer: Viewer; sessionId: string } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reviveKey is a re-subscribe TRIGGER, not read here.
  useEffect(() => {
    // Clear ONLY on a real session/viewer switch; a revive keeps the messages and just re-attaches the
    // stream (msgId dedup absorbs any re-delivered frames, so there's no blank flash).
    if (streamKey.current?.viewer !== viewer || streamKey.current.sessionId !== sessionId) {
      setMessages([]);
      setGap(null);
      autoGapRetry.current = null;
      streamKey.current = { viewer, sessionId };
    }
    const ac = new AbortController();
    // Always request the FULL replay: transcript() opens a fresh FrameOrderer (expects seq 0) reading the
    // run from the start, so on a revive a partial `since` would leave it permanently gapped on a backend
    // whose live window has rolled past seq 0. The host's #log is the source of truth; msgId dedup makes
    // the full re-read flash-free.
    void viewer.requestHistory(sessionId, 0).catch(() => {});
    (async () => {
      try {
        for await (const m of viewer.transcript(sessionId, ac.signal)) {
          if (isGapMessage(m)) {
            setGap({ nextSeq: m.nextSeq, pending: m.pending, since: m.since });
          } else if (m.kind === "accepted") {
            // Reconcile the optimistic echo (#113) — don't render the ack itself.
            const ack = parseAccepted(m.text);
            if (ack !== null) {
              // A FALSE failure: this send was restored as failed, but its ack just arrived → it actually
              // landed. Clear the error banner (+ Retry) so the user can't one-tap a duplicate (#150).
              if (ack.clientMsgId === failedSendRef.current) {
                failedSendRef.current = null;
                setSendError(null);
              }
              setMessages((prev) => reconcileAccepted(prev, ack.clientMsgId, ack.seq));
            }
          } else {
            setGap(null);
            setMessages((prev) => appendUniqueMessage(prev, m));
          }
        }
      } catch {
        /* aborted on unmount / session switch / revive */
      }
    })();
    return () => ac.abort();
  }, [viewer, sessionId, reviveKey]);

  // Recover from iOS backgrounding: when the tab/app returns to the foreground (photo picker closing, app
  // switch), re-subscribe so frames that arrived while the stream was suspended appear without a reload.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") setReviveKey((k) => k + 1);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Stick-to-bottom (#design-pass): replaces an unconditional smooth scrollIntoView — the worst transcript
  // bug — with: follow the foot only when the reader is pinned there, otherwise hold position and show a
  // "jump to latest" pill. The follow is an INSTANT scrollTop (not behavior:"smooth") on purpose: a smooth
  // animation fires onScroll at intermediate positions, which would latch atBottomRef=false mid-turn and
  // stop the live transcript from following; instant also means reduced-motion users get no surprise glide.
  // biome-ignore lint/correctness/useExhaustiveDependencies: react to new messages only.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el === null) return;
    const grew = el.scrollHeight > prevScrollHeightRef.current;
    prevScrollHeightRef.current = el.scrollHeight;
    const action = transcriptScrollAction(atBottomRef.current, grew);
    if (action === "follow") el.scrollTop = el.scrollHeight;
    else if (action === "show-pill") setShowJump(true);
  }, [messages]);

  // Track whether the viewer is pinned to the bottom (within ~64px); clears the pill once they catch up.
  const onTranscriptScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (el === null) return;
    const atBottom = isNearBottom(el);
    atBottomRef.current = atBottom;
    if (atBottom) setShowJump(false);
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = scrollerRef.current;
    atBottomRef.current = true;
    setShowJump(false);
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, []);

  const retryGap = useCallback(async () => {
    if (gap === null) return;
    setGapRetrying(true);
    setSendError(null);
    try {
      await viewer.requestHistory(sessionId, gap.nextSeq);
    } catch (e) {
      setSendError(friendlySendError(e));
    } finally {
      setGapRetrying(false);
    }
  }, [gap, sessionId, viewer]);

  const showGapRecovery = shouldShowGapRecovery(gap, now);
  useEffect(() => {
    if (!showGapRecovery || gap === null) return;
    const key = `${gap.nextSeq}:${gap.since}`;
    if (autoGapRetry.current === key) return;
    autoGapRetry.current = key;
    void retryGap();
  }, [gap, retryGap, showGapRecovery]);

  // Attachments are STAGED, not auto-sent (#44): the paperclip queues image(s) as thumbnails; they go on
  // Submit with the composer text. Each holds a File + an object-URL preview (revoked on remove/clear/unmount).
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Mirror staged into a ref so addStaged + the send-failure recovery + the unmount cleanup read the LIVE
  // value (their closures otherwise see only the render-time copy).
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  const addStaged = useCallback((files: FileList | null) => {
    if (files === null) return;
    const picked = Array.from(files).filter((f) => f.type.startsWith("image/"));
    // Bound the staged count (each image holds a File + an object URL); drop the overflow with a notice
    // rather than silently, and don't mint URLs for files we won't keep.
    const { accept, dropped } = fitStaged(
      stagedRef.current.length,
      picked.length,
      MAX_STAGED_IMAGES,
    );
    const items = picked.slice(0, accept).map((f) => ({
      id: crypto.randomUUID(),
      name: f.name,
      file: f,
      url: URL.createObjectURL(f),
    }));
    setStagedNotice(
      dropped > 0 ? `You can attach up to ${MAX_STAGED_IMAGES} images per message.` : null,
    );
    if (items.length > 0) setStaged((prev) => [...prev, ...items]);
  }, []);
  const removeStaged = useCallback((id: string) => {
    setStagedNotice(null); // back under the cap → drop any "max images" notice
    setStaged((prev) => {
      const hit = prev.find((s) => s.id === id);
      if (hit) URL.revokeObjectURL(hit.url);
      return prev.filter((s) => s.id !== id);
    });
  }, []);
  const clearStaged = useCallback(() => {
    setStagedNotice(null);
    setStaged((prev) => {
      for (const s of prev) URL.revokeObjectURL(s.url);
      return [];
    });
  }, []);
  // Mirror the live input so the send-failure recovery (#150) can tell whether the user has begun a NEW
  // draft during the in-flight send (don't clobber it) — the send closure only sees the pre-send values.
  const inputRef = useRef(input);
  inputRef.current = input;
  // The clientMsgId of a send we restored as FAILED. A `fetch` rejection can be a FALSE failure — the POST
  // reached the broker and published, but the response was lost — in which case the host still emits the
  // `accepted` ack. If that ack arrives for a "failed" send, the send actually landed: clear the error
  // banner so the user isn't tempted to one-tap Retry into a duplicate (#150 review).
  const failedSendRef = useRef<string | null>(null);
  // Revoke any still-staged object URLs if the transcript unmounts (session switch / back) with a draft.
  useEffect(
    () => () => {
      for (const s of stagedRef.current) URL.revokeObjectURL(s.url);
    },
    [],
  );

  const send = useCallback(async () => {
    const text = input.trim();
    if (text === "" && staged.length === 0) return;
    // Synchronous re-entry guard (#H): a double-tap Send / Enter-mash fires send() twice in the same tick,
    // before React commits setSending — so the async `sending` state can't block the second call, but this
    // ref can. Released in `finally`. Without it, both calls mint different clientMsgIds → two messages sent.
    if (sendingRef.current) return;
    sendingRef.current = true;
    const clientMsgId = `cm-${crypto.randomUUID()}`;
    const toSend = staged; // capture before clearStaged resets it (downscale reads item.file, not the URL)
    const original = input; // restore the EXACT draft (untrimmed) on failure, not the trimmed send text
    setSending(true);
    setSendError(null);
    failedSendRef.current = null; // a new attempt supersedes any prior failed-send tracking
    // Optimistic echo (#113): render the message INSTANTLY and clear the composer, so the image/text is
    // never in neither place during the host round-trip (or an iOS-suspended stream). The host's `accepted`
    // ack reconciles it; the transport watchdog (#125) recovers the stream — so no post-send reviveKey bump.
    setMessages((prev) => appendUniqueMessage(prev, optimisticMessage(clientMsgId, text, toSend)));
    atBottomRef.current = true; // your own send always snaps you to the message you just posted
    setShowJump(false);
    if (toSend.length > 0) clearStaged();
    setInput("");
    try {
      await sendComposer(viewer, sessionId, text, toSend, downscaleToBase64, clientMsgId);
    } catch (e) {
      // The send's POST rejected. USUALLY that means it never landed (no `accepted` will come) — but it can
      // also be a FALSE failure (the POST published, only the response was lost), in which case the ack DOES
      // arrive and the accepted-handler clears this banner (failedSendRef) so Retry can't duplicate it.
      // Don't strand the content in a dead "failed to send" bubble (the previous behavior, which also LOST
      // the staged images — their previews were revoked): RESTORE the draft to the composer so the user can
      // edit + Send again (#150). Only restore into an EMPTY composer — if a new draft was typed during the
      // in-flight send, keep it and leave the failed bubble in place instead of clobbering their work.
      setSendError(friendlySendError(e));
      const composerDirty = inputRef.current.trim() !== "" || stagedRef.current.length > 0;
      if (composerDirty) {
        // Can't restore without clobbering — mark the optimistic bubble failed so the text isn't a silent loss.
        setMessages((prev) =>
          prev.map((m) =>
            m.clientMsgId === clientMsgId
              ? { ...m, optimistic: false, text: `${m.text}\n⚠️ failed to send` }
              : m,
          ),
        );
      } else {
        // Composer is free → drop the optimistic bubble and put the draft back exactly as it was.
        failedSendRef.current = clientMsgId; // a late ack for this id ⇒ false failure ⇒ clear the banner
        setMessages((prev) => prev.filter((m) => m.clientMsgId !== clientMsgId));
        setInput(original);
        if (toSend.length > 0) setStaged(restageImages(toSend, (f) => URL.createObjectURL(f)));
      }
    } finally {
      setSending(false);
      sendingRef.current = false;
    }
  }, [input, staged, sessionId, viewer, clearStaged]);

  // Auto-grow the composer textarea up to a cap; recompute whenever the text changes (incl. on clear).
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `input` is the resize TRIGGER, not read here.
  useEffect(() => {
    const el = taRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_H)}px`; // keep in sync with .composer-input max-height
  }, [input]);

  const chooseMode = useCallback(
    async (id: string) => {
      setModeSheet(false);
      // Defensive: a driver that can't honor set_mode would only no-op the verb AND show a false confirmed
      // mode (the relay won't reflect it). The button is already disabled, but guard the path too.
      if (!canSetMode) return;
      setSendError(null);
      const prev = optimisticMode;
      modeBeforePickRef.current = announceMode; // the confirmed mode at pick time — lets the reconcile keep
      // the pick through a stale keepalive of THIS value, yet yield to a genuine remote change to another.
      setOptimisticMode(id); // optimistic — revert if the control frame can't be sent
      try {
        await viewer.setMode(sessionId, id);
      } catch (e) {
        // Only revert if no newer choice landed while we were awaiting — else we'd clobber it.
        setOptimisticMode((cur) => (cur === id ? prev : cur));
        setSendError(friendlySendError(e));
      }
    },
    [optimisticMode, announceMode, sessionId, viewer, canSetMode],
  );

  // Session ⋯ actions. set_model (the model switcher) sends Claude Code's documented `/model` alias to
  // the worker; interrupt stops the current turn; copy-branch is client-side (the announce's git chip).
  const chooseModel = useCallback(
    async (id: string) => {
      setSessionSheet(false);
      setSendError(null);
      setOptimisticModel(id); // optimistic — set_model isn't self-reported, so the tick is our own record
      try {
        await viewer.setModel(sessionId, id);
      } catch (e) {
        // The switch didn't land → clear the tick if it's still ours (a newer pick supersedes us). Revert
        // to null, not a captured previous value: set_model has no self-report, so a previous optimistic
        // value may itself have failed — claiming an unconfirmed model is worse than showing none.
        setOptimisticModel((cur) => (cur === id ? null : cur));
        setSendError(friendlySendError(e));
      }
    },
    [sessionId, viewer],
  );
  // Interrupt has no instant UI (the sheet just closes), so show a transient "Interrupting…" status until
  // the worker actually goes idle. Cleared by the phase→idle announce, or a timeout fallback so it can't stick.
  const [interrupting, setInterrupting] = useState(false);
  const interruptSession = useCallback(async () => {
    setSessionSheet(false);
    setSendError(null);
    setInterrupting(true);
    try {
      await viewer.interrupt(sessionId);
    } catch (e) {
      setInterrupting(false);
      setSendError(friendlySendError(e));
    }
  }, [sessionId, viewer]);
  useEffect(() => {
    if (!interrupting) return;
    if (phase === "idle") {
      setInterrupting(false);
      return;
    }
    const t = setTimeout(() => setInterrupting(false), 8000);
    return () => clearTimeout(t);
  }, [interrupting, phase]);
  const copyBranch = useCallback(() => {
    setSessionSheet(false);
    const b = announce?.git?.branch;
    if (b) void navigator.clipboard?.writeText(b).catch(() => {});
  }, [announce?.git?.branch]);

  // Answer a worker permission_request (§17.4): seal a `permission` frame the host turns into the
  // control_response. Bound to this session; PermissionRow owns the per-request pending/resolved state.
  // `extra` carries an AskUserQuestion's {answers, toolUseId} (#42); absent for a plain allow/deny.
  const grant = useCallback<GrantFn>(
    (requestId, behavior, extra) => viewer.grantPermission(sessionId, requestId, behavior, extra),
    [sessionId, viewer],
  );

  return (
    <section className="chat">
      <div className="chat-head">
        <button type="button" className="back" onClick={props.onBack}>
          ‹ Sessions
        </button>
        <span className="row-title">{props.title}</span>
        <span className="agent-badge" data-agent={announce?.harness?.agent ?? "claude-code"}>
          {harnessLabel(announce?.harness)}
        </span>
        {announce?.git && <GitChip git={announce.git} />}
        {permsBypassed && (
          <span
            className="perms-bypassed"
            title="This harness runs without per-tool permission gating — tools execute without asking."
          >
            ⚠ permissions off
          </span>
        )}
        <button
          type="button"
          className="chat-menu"
          aria-haspopup="dialog"
          aria-expanded={sessionSheet}
          aria-label="Session actions"
          title="Session actions"
          onClick={() => setSessionSheet(true)}
        >
          ⋯
        </button>
      </div>

      {/* role=log + aria-live so a screen reader announces assistant turns / tool rows as they stream in
          (additions only — presence ticks don't re-read the whole log). Without this the transcript was
          silent to AT users while Claude responded. */}
      <div
        className="transcript"
        ref={scrollerRef}
        onScroll={onTranscriptScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
      >
        {showGapRecovery && gap !== null && (
          <GapRecovery gap={gap} retrying={gapRetrying} onRetry={() => void retryGap()} />
        )}
        {messages.length === 0 && !showGapRecovery && (
          <p className="empty-pad">{emptyTranscriptHint(cs)}</p>
        )}
        {messages.map((m) => (
          <Bubble
            key={`${m.msgId}:${m.seq}`}
            message={m}
            onGrant={grant}
            resolved={resolved}
            resolvedAnswers={resolvedAnswers}
          />
        ))}
      </div>

      {showJump && (
        <button type="button" className="jump-latest" onClick={jumpToLatest}>
          New messages ↓
        </button>
      )}
      <StatusStrip conn={cs} phase={phase} needs={needs} interrupting={interrupting} />
      {sendError !== null && (
        <div className="send-err" role="alert">
          <span className="send-err-msg">Couldn’t send: {sendError}</span>
          <button
            type="button"
            className="send-err-retry"
            disabled={sending || (input.trim() === "" && staged.length === 0)}
            onClick={() => void send()}
          >
            Retry
          </button>
          <button
            type="button"
            className="send-err-dismiss"
            aria-label="Dismiss"
            onClick={() => setSendError(null)}
          >
            ×
          </button>
        </div>
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {staged.length > 0 && (
          <div className="staged">
            {staged.map((s) => (
              <div className="staged-item" key={s.id}>
                {/* biome-ignore lint/performance/noImgElement: a local object-URL blob preview — next/image can't optimize a blob: URL */}
                <img src={s.url} alt={s.name} />
                <button
                  type="button"
                  className="staged-remove"
                  aria-label={`Remove ${s.name}`}
                  onClick={() => removeStaged(s.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {stagedNotice !== null && (
          <p className="staged-notice" role="status">
            {stagedNotice}
          </p>
        )}
        {/* Prompt field on top, controls below (mirrors the native app composer). */}
        <textarea
          ref={taRef}
          className="composer-input"
          value={input}
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Desktop: Enter sends, Shift+Enter is a line break. Touch: Enter is always a line break (the
            // Send button sends) so a soft-keyboard Return doesn't strand a multi-line prompt (#151).
            // `nativeEvent.isComposing` is the reliable IME-composition signal (React's synthetic event
            // doesn't surface it as a typed field).
            if (
              enterShouldSend(
                { key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing },
                coarsePointer,
              )
            ) {
              e.preventDefault();
              void send();
            }
          }}
          // Surface that slash commands work here (they ride the same input → command chip, #41); also the
          // accessible name, since a placeholder isn't a reliable one (it vanishes on input).
          aria-label="Message"
          placeholder="Send a prompt — or /compact, /clear…"
          // Match the actual Enter behavior: a "send" return key on desktop, a newline key on touch.
          enterKeyHint={coarsePointer ? "enter" : "send"}
        />
        <div className="composer-row">
          <button
            type="button"
            className="mode-btn"
            aria-haspopup="dialog"
            aria-expanded={modeSheet}
            disabled={!canSetMode}
            onClick={() => canSetMode && setModeSheet(true)}
            title={
              canSetMode
                ? "Permission mode"
                : "This harness can't switch permission mode — showing the worker's current mode (read-only)"
            }
          >
            <span className="mode-glyph">{modeGlyph(displayedMode)}</span>
            {modeLabel(displayedMode)}
          </button>
          <button
            type="button"
            className="attach-btn"
            title="Attach photos"
            aria-label="Attach photos"
            disabled={sending}
            onClick={() => fileRef.current?.click()}
          >
            📎
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              addStaged(e.target.files);
              e.target.value = ""; // allow re-picking the same file(s)
            }}
          />
          <button
            type="submit"
            className="btn composer-send"
            disabled={sending || (input.trim() === "" && staged.length === 0)}
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </form>

      {modeSheet && (
        <ModeSheet
          current={displayedMode}
          onPick={(id) => void chooseMode(id)}
          onClose={() => setModeSheet(false)}
        />
      )}
      {sessionSheet && (
        <SessionSheet
          branch={announce?.git?.branch ?? null}
          currentModel={optimisticModel}
          canModel={canSetModel}
          canInterrupt={canInterrupt}
          onModel={(id) => void chooseModel(id)}
          onInterrupt={() => void interruptSession()}
          onCopyBranch={copyBranch}
          onClose={() => setSessionSheet(false)}
        />
      )}
    </section>
  );
}

function GapRecovery({
  gap,
  retrying,
  onRetry,
}: {
  gap: TranscriptGap;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="chat-status transcript-gap" data-state="reconnecting" role="alert">
      <span>
        Transcript out of sync — retrying… waiting for seq {gap.nextSeq} ({gap.pending} buffered)
      </span>
      <button type="button" className="gap-retry" disabled={retrying} onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

/** A pinned status line above the composer (#48/#58): surfaces a connection problem
 *  (reconnecting/disconnected) or the worker's activity (working / needs you). Hidden when connected +
 *  idle so a quiet session stays uncluttered, and hidden when `conn` is null (no announce seen yet —
 *  we don't claim a state we don't know). */
function StatusStrip({
  conn,
  phase,
  needs,
  interrupting,
}: {
  conn: ConnState | null;
  phase: "idle" | "thinking";
  needs: boolean;
  interrupting: boolean;
}) {
  // role="alert" (assertive) for states that need attention now; role="status" (polite) for ambient
  // activity — so a screen reader announces the flip to disconnected / needs-you / working (#58 a11y).
  if (conn === "disconnected")
    return (
      <div className="chat-status" data-state="disconnected" role="alert">
        Host disconnected — the session may have ended.
      </div>
    );
  if (conn === "reconnecting")
    return (
      <div className="chat-status" data-state="reconnecting" role="status">
        Reconnecting to the host… <Working />
      </div>
    );
  if (conn === "connected" && interrupting)
    return (
      <div className="chat-status" data-state="thinking" role="status">
        Interrupting… <Working />
      </div>
    );
  if (conn === "connected" && needs)
    return (
      <div className="chat-status" data-state="needs" role="alert">
        🔔 Claude needs your input
      </div>
    );
  if (conn === "connected" && phase === "thinking")
    return (
      <div className="chat-status" data-state="thinking" role="status">
        Claude is working… <Working />
      </div>
    );
  return null;
}

// The three permission modes Claude Code exposes (IMG_1825 "Select mode"). `id` is the exact RC
// set_permission_mode value the relay forwards to the worker (§3.7) — VERIFIED by capturing the real
// iOS app through `--rc-trace`: Auto="auto", Code="default", Plan="plan" (NOT default/acceptEdits).
const MODES = [
  {
    id: "auto",
    label: "Auto",
    glyph: "⚡",
    desc: "Claude decides which actions need confirmation",
  },
  { id: "default", label: "Code", glyph: "⌨", desc: "Claude writes and edits code directly" },
  {
    id: "plan",
    label: "Plan",
    glyph: "◑",
    desc: "Claude explores code and presents a plan before making edits",
  },
] as const;

function modeLabel(id: string | null): string {
  return MODES.find((m) => m.id === id)?.label ?? "Mode";
}
function modeGlyph(id: string | null): string {
  return MODES.find((m) => m.id === id)?.glyph ?? "⚙";
}

export function displayedPermissionMode(
  announcedMode: string | undefined,
  optimisticMode: string | null,
): string | null {
  return optimisticMode ?? announcedMode ?? null;
}

/** Whether a fresh mode-bearing announce should CLEAR the local optimistic pick. The flicker we prevent:
 *  a ~20s keepalive announce that still carries the PRE-PICK mode (the host hasn't applied our set_mode
 *  yet) would otherwise flash the old mode back. So keep the pick while the announce is still echoing the
 *  pre-pick value; clear it when the announce CONFIRMS our pick (mode === optimistic) or shows a genuine
 *  remote change (a value that's neither our pick nor the pre-pick mode — e.g. another device). A timeout
 *  fallback (in the component) clears an unconfirmed pick so it can't stick forever. Pure → testable. */
export function shouldClearOptimisticMode(
  announceMode: string | undefined,
  optimisticMode: string | null,
  modeBeforePick: string | undefined,
): boolean {
  if (optimisticMode === null) return false; // nothing optimistic to reconcile
  if (announceMode === undefined) return false; // this announce carries no mode → can't confirm/deny
  if (announceMode === optimisticMode) return true; // host applied our pick → announce now drives it
  if (announceMode === modeBeforePick) return false; // still the pre-pick value → stale echo, keep the pick
  return true; // a third value from elsewhere → genuine remote change, let it win
}

/** Bottom sheet to pick the session's permission mode — mirrors Claude Code's "Select mode" sheet. */
/** A bottom-sheet shell: scrim + role=dialog + focus-trap + scroll-lock + Escape-to-close. The caller
 *  supplies the rows as children. Shared by the mode picker and the session ⋯ sheet. */
function Sheet({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // onClose is a fresh arrow each parent render; read it through a ref so the focus/scroll-lock effect
  // runs exactly once (on open) without re-stealing focus or re-saving the trigger.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Desktop (≥761px): render as a dropdown ANCHORED to the trigger instead of a phone-style bottom sheet
  // (#desktop-layout). Computed in useLayoutEffect (before paint, so no bottom→anchored flicker) from the
  // opener's rect — which is `document.activeElement` here, since the focus effect below hasn't moved focus
  // into the sheet yet. Placement is automatic: drop below a top-half trigger (the header ⋯) / above a
  // bottom-half one (the composer Mode button), aligned to whichever edge has room — so it works for both
  // triggers regardless of the centered composer's dynamic position. null ⇒ mobile bottom-sheet.
  const [anchorStyle, setAnchorStyle] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    // Skip (→ keep the bottom sheet) unless we have a real, sized trigger on a desktop viewport. Guards the
    // Safari quirk where clicking a <button> doesn't focus it, so activeElement is <body>: anchoring to the
    // full-viewport body rect would shove the panel off-screen — a centered bottom sheet is the safe fallback.
    if (!trigger || trigger === document.body || !window.matchMedia?.("(min-width: 761px)").matches)
      return;
    const t = trigger.getBoundingClientRect();
    if (t.width === 0 && t.height === 0) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const s: CSSProperties = {};
    if (t.top < vh / 2)
      s.top = Math.round(t.bottom + 6); // trigger up top → drop below it
    else s.bottom = Math.round(vh - t.top + 6); // trigger near the bottom → open upward
    if (t.left < vw / 2)
      s.left = Math.round(t.left); // left-side trigger → align left edges
    else s.right = Math.round(vw - t.right); // right-side trigger → align right edges
    setAnchorStyle(s);
  }, []);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null; // the button that opened the sheet
    const focusables = () =>
      Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
    // Move focus into the sheet (the active row, else the first) so keyboard users land on the choices.
    (
      dialogRef.current?.querySelector<HTMLElement>('[data-active="true"]') ?? focusables()[0]
    )?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      // Trap Tab within the sheet so it can't reach the controls behind the scrim.
      const f = focusables();
      const first = f[0];
      const last = f[f.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; // lock background scroll while modal
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      trigger?.focus?.(); // restore focus to the opener
    };
  }, []);
  // Scrim and sheet are siblings (not nested) so the sheet's own buttons aren't inside another button.
  // The scrim is mouse-only (tabIndex -1) — keyboard dismiss is Escape; role=dialog sits on the content.
  const anchored = anchorStyle !== null;
  return (
    <div className={anchored ? "sheet-layer sheet-layer--anchored" : "sheet-layer"}>
      <button
        type="button"
        className="sheet-scrim"
        aria-label={`Close ${label}`}
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        className={anchored ? "sheet sheet--anchored" : "sheet"}
        style={anchorStyle ?? undefined}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {!anchored && <div className="sheet-handle" />}
        {children}
      </div>
    </div>
  );
}

/** Bottom sheet to pick the session's permission mode — mirrors Claude Code's "Select mode" sheet. */
function ModeSheet({
  current,
  onPick,
  onClose,
}: {
  current: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Sheet label="Select mode" onClose={onClose}>
      <div className="sheet-title">Select mode</div>
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          className="mode-row"
          data-active={m.id === current}
          aria-pressed={m.id === current}
          onClick={() => onPick(m.id)}
        >
          <span className="mode-row-glyph">{m.glyph}</span>
          <span className="mode-row-main">
            <span className="mode-row-label">{m.label}</span>
            <span className="mode-row-desc">{m.desc}</span>
          </span>
          {m.id === current && (
            <span className="mode-check" aria-hidden>
              ✓
            </span>
          )}
        </button>
      ))}
    </Sheet>
  );
}

// Models the session can switch to via the RC `set_model` verb (§3.7). `id` is the value sent to the
// worker — Claude Code's documented `/model` selector aliases (the interface the official app's "Change
// model" uses). A mid-session switch is acknowledged by the worker but isn't observable via the model's
// self-report (it answers its launch identity), so the tick reflects the viewer's OWN last choice
// (optimisticModel) rather than a server-confirmed value.
const MODELS = [
  { id: "default", label: "Default", glyph: "⌘", desc: "The machine's configured model" },
  { id: "opus", label: "Opus", glyph: "◆", desc: "Most capable — complex work" },
  { id: "sonnet", label: "Sonnet", glyph: "◇", desc: "Balanced — everyday tasks" },
  { id: "haiku", label: "Haiku", glyph: "▪", desc: "Fastest — quick answers" },
] as const;

/** The session ⋯ sheet: switch model (set_model), interrupt the current turn, copy the git branch.
 *  `canModel`/`canInterrupt` reflect the host driver's capabilities (#149): a driver that can't honor a
 *  verb gets that control disabled with an explanatory note, never a button that silently no-ops. */
export function SessionSheet({
  branch,
  currentModel,
  canModel,
  canInterrupt,
  onModel,
  onInterrupt,
  onCopyBranch,
  onClose,
}: {
  branch: string | null;
  /** The optimistically-selected model (set_model isn't self-reported), or null until one is chosen. */
  currentModel: string | null;
  /** The driver can switch model (opencode can't — it needs a providerID/modelID, not the viewer's aliases). */
  canModel: boolean;
  /** The driver can interrupt the current turn (true for every current driver; gated defensively). */
  canInterrupt: boolean;
  onModel: (id: string) => void;
  onInterrupt: () => void;
  onCopyBranch: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet label="Session actions" onClose={onClose}>
      <div className="sheet-title">Change model</div>
      {canModel ? (
        MODELS.map((m) => (
          <button
            key={m.id}
            type="button"
            className="mode-row"
            data-active={m.id === currentModel}
            aria-pressed={m.id === currentModel}
            onClick={() => onModel(m.id)}
          >
            <span className="mode-row-glyph">{m.glyph}</span>
            <span className="mode-row-main">
              <span className="mode-row-label">{m.label}</span>
              <span className="mode-row-desc">{m.desc}</span>
            </span>
            {m.id === currentModel && (
              <span className="mode-check" aria-hidden>
                ✓
              </span>
            )}
          </button>
        ))
      ) : (
        <p className="sheet-note">This harness can’t switch model from the viewer.</p>
      )}
      <div className="sheet-title">Session</div>
      <button
        type="button"
        className="mode-row mode-row-danger"
        disabled={!canInterrupt}
        onClick={onInterrupt}
      >
        <span className="mode-row-glyph">⏹</span>
        <span className="mode-row-main">
          <span className="mode-row-label">Interrupt</span>
          <span className="mode-row-desc">
            {canInterrupt ? "Stop the current turn" : "Not supported by this harness"}
          </span>
        </span>
      </button>
      {branch !== null && (
        <button type="button" className="mode-row" onClick={onCopyBranch}>
          <span className="mode-row-glyph">⎇</span>
          <span className="mode-row-main">
            <span className="mode-row-label">Copy branch</span>
            <span className="mode-row-desc">{branch}</span>
          </span>
        </button>
      )}
    </Sheet>
  );
}

// The transcript renders as an asymmetric document, not symmetric chat: USER turns are small
// right-aligned pills; ASSISTANT turns are full-width prose (no bubble). Tool calls are compact
// tappable rows that expand to a Command/Diff detail; sub-agents and thinking nest/recede. (Inspired
// by Claude Code's mobile UI — see the design spec.)
type GrantExtra = { answers?: Record<string, string | string[]>; toolUseId?: string };
type GrantFn = (requestId: string, behavior: "allow" | "deny", extra?: GrantExtra) => Promise<void>;

export function Bubble({
  message,
  onGrant,
  resolved,
  resolvedAnswers,
}: {
  message: Message;
  onGrant: GrantFn;
  resolved: Map<string, "allow" | "deny">;
  resolvedAnswers: Map<string, Record<string, string | string[]>>;
}) {
  switch (message.kind) {
    case "result":
      return <p className="turn-sep" aria-hidden />;
    case "user":
      // A slash command (/compact, /clear, /model …) is rendered as a distinct command chip, not a chat
      // pill — it rides the same `user` path but is an instruction to claude, not a message (#41).
      return isSlashCommand(message.text) ? (
        <div className="row-command">
          <span className="cmd-chip">
            <span className="cmd-glyph">⌘</span>
            {message.text.trim()}
          </span>
        </div>
      ) : (
        <div className="row-user">
          {/* Dim the pill while it's an unconfirmed optimistic echo (#113); solid once the `accepted`
              ack reconciles it (optimistic→false). */}
          <div className={message.optimistic ? "pill pill-pending" : "pill"}>{message.text}</div>
        </div>
      );
    case "assistant":
      return <Prose className="assistant" text={message.text} />;
    case "assistant_sub":
      return (
        <div className="sub-thread">
          <Prose className="assistant assistant-sub" text={message.text} />
        </div>
      );
    case "assistant_thinking":
    case "assistant_thinking_sub":
      return <ThinkingRow text={message.text} sub={message.kind === "assistant_thinking_sub"} />;
    case "tool_use":
      return <ToolRow text={message.text} />;
    case "tool_result":
      return <ToolResultRow text={message.text} />;
    case "task":
      return <TaskRow text={message.text} />;
    case "permission_request":
      return (
        <PermissionRow
          text={message.text}
          onGrant={onGrant}
          resolved={resolved}
          resolvedAnswers={resolvedAnswers}
        />
      );
    default:
      // accepted acks + lifecycle frames are not rendered standalone; permission_resolved is folded
      // into its PermissionRow (via the `resolved` map), not shown as its own row.
      return null;
  }
}

/** A thinking block — collapsed, muted, recedes. A sub-agent's reasoning nests under its Task. */
function ThinkingRow({ text, sub }: { text: string; sub: boolean }) {
  return (
    <details className="thinking" data-sub={sub}>
      <summary>
        <span>💭 {sub ? "sub-agent thinking" : "thought"}</span>
        <span className="chev" aria-hidden>
          ›
        </span>
      </summary>
      <div className="thinking-body">{text}</div>
    </details>
  );
}

/**
 * A worker permission request (RC usually auto-executes, §17.4 — shown when it doesn't). Renders the
 * tool + a one-line hint and Allow / Deny buttons; the decision rides back as a `permission` frame
 * (onGrant → viewer.grantPermission). Once answered (or if a request_id is missing) the buttons lock.
 */
function PermissionRow({
  text,
  onGrant,
  resolved,
  resolvedAnswers,
}: {
  text: string;
  onGrant: GrantFn;
  resolved: Map<string, "allow" | "deny">;
  resolvedAnswers: Map<string, Record<string, string | string[]>>;
}) {
  const req = parsePermission(text);
  const [decision, setDecision] = useState<"allow" | "deny" | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A synchronous re-entry guard: `busy` is async React state, so two clicks fired in the same tick
  // would both pass a `busy`-based check and send conflicting grants. The ref closes that window.
  const deciding = useRef(false);

  // The host-logged resolution (replayed on catch_up) is the source of truth that survives a reload,
  // so it WINS over the local optimistic `decision`. On a fresh load `decision` is null but `confirmed`
  // is set → the row renders resolved instead of re-prompting with live buttons (#56/#57).
  const confirmed = resolved.get(req.requestId) ?? null;
  const effective = confirmed ?? decision;

  const decide = useCallback(
    async (behavior: "allow" | "deny") => {
      if (req.requestId === "" || deciding.current) return;
      deciding.current = true;
      setBusy(true);
      setErr(null);
      try {
        await onGrant(req.requestId, behavior);
        setDecision(behavior); // resolved view replaces the buttons — no further clicks possible
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        deciding.current = false; // failed — let the user retry
      } finally {
        setBusy(false);
      }
    },
    [req.requestId, onGrant],
  );

  // An AskUserQuestion is a can_use_tool whose input is multiple-choice questions — render the question
  // UI + answer with updatedInput.answers, not a bare Allow/Deny (#42). (Branch AFTER the hooks above
  // so the rules of hooks hold; QuestionCard owns its own state.)
  if (req.questions.length > 0) {
    return (
      <QuestionCard
        req={req}
        onGrant={onGrant}
        resolved={resolved}
        resolvedAnswers={resolvedAnswers}
      />
    );
  }

  return (
    <div className="perm">
      <div className="perm-head">
        <span className="tool-glyph">🔐</span>
        <span className="perm-label">
          Allow <strong>{req.tool}</strong>?
        </span>
      </div>
      {req.hint !== "" && <div className="perm-hint">{req.hint}</div>}
      {effective === null ? (
        <div className="perm-actions">
          <button
            type="button"
            className="perm-btn perm-allow"
            disabled={busy || req.requestId === ""}
            onClick={() => void decide("allow")}
          >
            Allow
          </button>
          <button
            type="button"
            className="perm-btn perm-deny"
            disabled={busy || req.requestId === ""}
            onClick={() => void decide("deny")}
          >
            Deny
          </button>
        </div>
      ) : (
        <div className="perm-resolved" data-behavior={effective}>
          {effective === "allow" ? "✓ Allowed" : "✕ Denied"}
        </div>
      )}
      {req.requestId === "" && effective === null && (
        <div className="perm-hint">No request id — this prompt can’t be answered from here.</div>
      )}
      {err !== null && <div className="perm-err">Couldn’t send: {err}</div>}
    </div>
  );
}

interface ParsedPermission {
  tool: string;
  hint: string;
  requestId: string;
  toolUseId: string;
  questions: Question[];
}

/**
 * AskUserQuestion (#42): render each multiple-choice question + options; on submit, send the chosen
 * labels back as `updatedInput.answers` keyed by question text, with the request's `tool_use_id` — the
 * exact shape real claude expects (verified live via --rc-trace). Single-select picks one label;
 * multiSelect toggles an array. Survives reload via the host-logged `resolved` map (#56).
 */
function QuestionCard({
  req,
  onGrant,
  resolved,
  resolvedAnswers,
}: {
  req: ParsedPermission;
  onGrant: GrantFn;
  resolved: Map<string, "allow" | "deny">;
  resolvedAnswers: Map<string, Record<string, string | string[]>>;
}) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  // A per-question freeform answer — ALWAYS available so the user can "type your own" instead of being
  // limited to the listed options (real Claude Code always offers this). An arbitrary string is a valid
  // answer end to end: session.ts passes `answers` through with no membership check (#42 freeform).
  const [freeform, setFreeform] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Which way this card was resolved locally (null = unanswered). Tracks deny too, so a Dismiss doesn't
  // mislabel as "✓ Answered" before the host's permission_resolved frame lands.
  const [sentBehavior, setSentBehavior] = useState<"allow" | "deny" | null>(null);
  // The answers we submitted — shown in the resolved card immediately (optimistic), before the host's
  // permission_resolved frame (which carries the same answers) lands and takes over on reload.
  const [sentAnswers, setSentAnswers] = useState<Record<string, string | string[]> | null>(null);
  const deciding = useRef(false);

  // host-logged answer survives reload; the local optimistic value covers the gap before it lands.
  const resolvedBehavior = resolved.get(req.requestId) ?? sentBehavior;
  const done = resolvedBehavior != null;
  // What was answered, for the resolved card: the logged frame (survives reload) wins, else the local
  // optimistic copy fills the gap between submit and the frame landing.
  const doneAnswers = resolvedAnswers.get(req.requestId) ?? sentAnswers;

  const pick = (q: Question, label: string) => {
    // Single-select: picking an option clears this question's freeform box (options ⟂ freeform).
    if (!q.multiSelect) setFreeform((f) => (f[q.question] ? { ...f, [q.question]: "" } : f));
    setAnswers((a) => {
      if (!q.multiSelect) return { ...a, [q.question]: label };
      const cur = Array.isArray(a[q.question]) ? (a[q.question] as string[]) : [];
      return {
        ...a,
        [q.question]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label],
      };
    });
  };
  const onFreeform = (q: Question, val: string) => {
    setFreeform((f) => ({ ...f, [q.question]: val }));
    // Single-select: typing clears any picked option so the two never both count.
    if (!q.multiSelect && val.trim() !== "")
      setAnswers((a) => {
        if (!(q.question in a)) return a;
        const n = { ...a };
        delete n[q.question];
        return n;
      });
  };
  const isPicked = (q: Question, label: string) => {
    const v = answers[q.question];
    return Array.isArray(v) ? v.includes(label) : v === label;
  };
  // The effective answer: freeform text wins for single-select; for multiSelect the trimmed freeform
  // string is APPENDED to the picked labels. One helper for BOTH the gate and submit so they can't
  // diverge. undefined ⇒ unanswered. Memoized so submit can depend on it directly.
  const finalAnswer = useCallback(
    (q: Question): string | string[] | undefined => {
      const ft = (freeform[q.question] ?? "").trim();
      if (!q.multiSelect) {
        if (ft !== "") return ft;
        const v = answers[q.question];
        return typeof v === "string" ? v : undefined;
      }
      const picked = Array.isArray(answers[q.question]) ? (answers[q.question] as string[]) : [];
      const merged = ft !== "" ? [...picked, ft] : picked;
      return merged.length > 0 ? merged : undefined;
    },
    [answers, freeform],
  );
  const answered = (q: Question) => finalAnswer(q) !== undefined;
  const allAnswered = req.questions.every(answered);

  const submit = useCallback(async () => {
    if (req.requestId === "" || deciding.current || !allAnswered) return;
    deciding.current = true;
    setBusy(true);
    setErr(null);
    try {
      // Build the outgoing map from finalAnswer so a freeform-only answer is sent (the raw `answers`
      // state holds only option picks). Keyed by question text — the shape claude expects.
      const out: Record<string, string | string[]> = {};
      for (const q of req.questions) {
        const a = finalAnswer(q);
        if (a !== undefined) out[q.question] = a;
      }
      await onGrant(req.requestId, "allow", { answers: out, toolUseId: req.toolUseId });
      setSentAnswers(out);
      setSentBehavior("allow");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      deciding.current = false; // failed — let the user retry
    } finally {
      setBusy(false);
    }
  }, [req.requestId, req.toolUseId, req.questions, finalAnswer, allAnswered, onGrant]);

  // Decline a question you don't want to answer — rides the same path as a permission Deny (#42 review).
  const dismiss = useCallback(async () => {
    if (req.requestId === "" || deciding.current) return;
    deciding.current = true;
    setBusy(true);
    setErr(null);
    try {
      await onGrant(req.requestId, "deny", { toolUseId: req.toolUseId });
      setSentBehavior("deny");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      deciding.current = false;
    } finally {
      setBusy(false);
    }
  }, [req.requestId, req.toolUseId, onGrant]);

  if (done) {
    const denied = resolvedBehavior === "deny";
    // Flatten the answered value(s) into a readable summary — a multiSelect answer is an array, and a
    // multi-question card joins its per-question answers. Shows the user WHAT they picked (Claude Code's
    // transcript keeps the choice, so ours should too) and survives reload via the logged frame.
    const summary =
      !denied && doneAnswers
        ? Object.values(doneAnswers)
            .map((v) => (Array.isArray(v) ? v.join(", ") : v))
            .filter((s) => s !== "")
            .join(" · ")
        : "";
    return (
      <div className="perm perm-q">
        <div className="perm-resolved" data-behavior={resolvedBehavior ?? "allow"}>
          {denied ? "✕ Skipped" : "✓ Answered"}
          {summary !== "" && <span className="q-answer">{summary}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="perm perm-q">
      <div className="perm-head">
        <span className="tool-glyph">❓</span>
        <span className="perm-label">Claude is asking</span>
      </div>
      {req.questions.map((q) => (
        <div className="q-block" key={`${q.header}:${q.question}`}>
          {q.header !== "" && <div className="q-header">{q.header}</div>}
          <div className="q-text">{q.question}</div>
          <div className="q-options">
            {q.options.map((o) => (
              <button
                key={o.label}
                type="button"
                className="q-option"
                data-selected={isPicked(q, o.label)}
                aria-pressed={isPicked(q, o.label)}
                onClick={() => pick(q, o.label)}
              >
                <span className="q-option-label">{o.label}</span>
                {o.description !== "" && <span className="q-option-desc">{o.description}</span>}
              </button>
            ))}
          </div>
          <textarea
            className="q-freeform"
            rows={1}
            placeholder={q.multiSelect ? "Add your own answer…" : "Or type your own answer…"}
            value={freeform[q.question] ?? ""}
            onChange={(e) => onFreeform(q, e.target.value)}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter submits when every question is answered (parity with the composer).
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && allAnswered) void submit();
            }}
            aria-label={`Type your own answer for: ${q.question}`}
          />
        </div>
      ))}
      <div className="perm-actions">
        <button
          type="button"
          className="perm-btn perm-allow q-submit"
          disabled={busy || !allAnswered || req.requestId === ""}
          onClick={() => void submit()}
        >
          {busy ? "Sending…" : "Submit answers"}
        </button>
        <button
          type="button"
          className="perm-btn perm-deny"
          disabled={busy || req.requestId === ""}
          onClick={() => void dismiss()}
        >
          Skip / answer in chat
        </button>
      </div>
      {req.requestId === "" && (
        <div className="perm-hint">No request id — this prompt can’t be answered from here.</div>
      )}
      {err !== null && <div className="perm-err">Couldn’t send: {err}</div>}
    </div>
  );
}

/** Parse a permission_request frame → tool, hint, request id, tool_use_id, and (for AskUserQuestion)
 *  the questions to render (#42). */
function parsePermission(text: string): ParsedPermission {
  try {
    const p = JSON.parse(text) as {
      request_id?: unknown;
      tool_name?: unknown;
      tool_input?: unknown;
      tool_use_id?: unknown;
    };
    return {
      tool: typeof p.tool_name === "string" ? p.tool_name : "tool",
      hint: toolHint(sanitizeInput(p.tool_input)),
      requestId: typeof p.request_id === "string" ? p.request_id : "",
      toolUseId: typeof p.tool_use_id === "string" ? p.tool_use_id : "",
      questions: parseQuestions(p.tool_input),
    };
  } catch {
    return { tool: "tool", hint: "", requestId: "", toolUseId: "", questions: [] };
  }
}

/**
 * A tool call: a compact tappable row (action-verb label + a green/red edit stat for Edit/Write +
 * a chevron) that expands to its detail — the Bash command, or a diff viewer for a file edit, or the
 * Task prompt for a sub-agent. The diff is computed from the tool_use input (Edit old/new strings).
 */
function ToolRow({ text }: { text: string }) {
  const { name, input, sub } = parseToolUse(text);

  const isTask = name === "Task";
  const isEdit = name === "Edit" || name === "Write" || name === "MultiEdit";
  const file = input.file_path ? basename(input.file_path) : null;
  const stat = isEdit ? editStat(input) : null;
  const verb = isTask
    ? `Ran a sub-agent${input.description ? `: ${input.description}` : ""}`
    : isEdit && file
      ? `Edited ${file}`
      : name === "Read" && file
        ? `Read ${file}`
        : name === "Bash"
          ? input.description || "Ran a command"
          : `${name}${input.description ? `: ${input.description}` : ""}`;

  // Only expandable when the detail body will actually render something. `description` is already in
  // the label, and a Task's prompt is the only prompt we render — so don't open to an empty box.
  const hasDetail = Boolean(input.command || isEdit || (isTask && input.prompt));
  const glyph = isTask ? "🤖" : isEdit ? "✏️" : name === "Read" ? "📄" : name === "Bash" ? "❯" : "⚙";

  const row = (
    <span className="tool-line">
      <span className="tool-glyph">{glyph}</span>
      <span className="tool-label">{verb}</span>
      {stat && (
        <span className="tool-stat">
          {stat.add > 0 && <span className="stat-add">+{stat.add}</span>}
          {stat.del > 0 && <span className="stat-del">−{stat.del}</span>}
        </span>
      )}
    </span>
  );

  if (!hasDetail)
    return (
      <div className="tool-row" data-sub={sub}>
        {row}
      </div>
    );

  return (
    <details className="tool-row tool-row-x" data-sub={sub}>
      <summary>
        {row}
        <span className="chev">›</span>
      </summary>
      <div className="tool-detail">
        {input.command && (
          <Section label="Command">
            <pre className="code-block">{input.command}</pre>
          </Section>
        )}
        {isEdit && <DiffView input={input} />}
        {isTask && input.prompt && (
          <Section label="Prompt">
            <div className="detail-text">{input.prompt}</div>
          </Section>
        )}
      </div>
    </details>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="detail-section">
      <div className="detail-label">{label}</div>
      {children}
    </div>
  );
}

/** A tool's Output (the worker's tool_result) — a compact collapsible row under the tool call. Empty
 *  output (no stdout) renders nothing so it doesn't clutter the transcript. */
function ToolResultRow({ text }: { text: string }) {
  const r = parseToolResult(text);
  if (r.output === "") return null;
  return (
    <details className="tool-result" data-error={r.isError} data-sub={r.sub}>
      <summary>
        <span className="tool-glyph">{r.isError ? "✕" : "↳"}</span>
        <span className="tool-label">{r.isError ? "Error" : "Output"}</span>
        <span className="chev">›</span>
      </summary>
      <pre className="code-block tool-output">{r.output}</pre>
    </details>
  );
}

/** A sub-agent Task lifecycle event (task_started/_updated/_notification) — a muted status line so a
 *  long-running Task is visible in the stream. */
function TaskRow({ text }: { text: string }) {
  const t = parseTask(text);
  const verb =
    t.subtype === "task_started"
      ? "Task started"
      : t.subtype === "task_notification"
        ? "Task update"
        : t.subtype === "task_updated"
          ? "Task progress"
          : "Task";
  return (
    <div className="task-row" data-sub>
      <span className="tool-glyph">🤖</span>
      <span className="tool-label">
        {verb}
        {t.description ? `: ${t.description}` : ""}
      </span>
    </div>
  );
}

const MAX_DIFF_LINES = 200; // cap each side so a large Write/Edit doesn't mount thousands of nodes

/** A diff viewer for a file edit — a path header over the changed lines (removed red / added green),
 *  computed from the tool_use input. See diffOf() for how a hunk is reduced to just its changes. */
function DiffView({ input }: { input: ToolInput }) {
  const path = input.file_path ?? "file";
  const { rem, add } = diffOf(input);
  if (rem.length === 0 && add.length === 0)
    return (
      <div className="diff">
        <div className="diff-path" title={path}>
          {basename(path)} <span className="diff-dir">{dirname(path)}</span>
        </div>
        <div className="diff-empty">no textual changes</div>
      </div>
    );
  return (
    <div className="diff">
      <div className="diff-path" title={path}>
        {basename(path)} <span className="diff-dir">{dirname(path)}</span>
      </div>
      <pre className="diff-body">
        {diffLines(rem.slice(0, MAX_DIFF_LINES), "dl-del", "−")}
        {more(rem.length - MAX_DIFF_LINES, "removed")}
        {diffLines(add.slice(0, MAX_DIFF_LINES), "dl-add", "+")}
        {more(add.length - MAX_DIFF_LINES, "added")}
      </pre>
    </div>
  );
}

function more(n: number, which: string): ReactNode {
  if (n <= 0) return null;
  return (
    <div className="dl dl-more">
      … {n} more {which} line{n === 1 ? "" : "s"}
    </div>
  );
}

// Render one side of a diff. Keyed by content + occurrence ordinal (not the array index): for an
// immutable, never-reordered diff that is a stable identity, and it keeps biome's array-index rule
// satisfied honestly rather than by suppression.
function diffLines(lines: string[], cls: string, sign: string): ReactNode[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const n = seen.get(line) ?? 0;
    seen.set(line, n + 1);
    return (
      <div key={`${sign}${n}:${line}`} className={`dl ${cls}`}>
        <span className="dg">{sign}</span>
        {line}
      </div>
    );
  });
}

/**
 * Render assistant prose as GitHub-Flavored Markdown — tables, lists, headings, fenced code, bold,
 * inline code, links (the old hand-rolled renderer only did **bold** + `code`, so a model's table came
 * out as raw `| … |` pipes). CSP-safe: react-markdown emits React ELEMENTS, never raw HTML — there is no
 * `dangerouslySetInnerHTML` and `rehype-raw` is NOT enabled, so a model can't inject markup. Links open
 * in a new tab with `noopener` so a transcript link can't navigate the viewer away or reach `window.opener`.
 *
 * memo'd: a transcript message is immutable once appended (deduped by msgId), but the Console re-renders
 * every 5s to age presence — without memo that would re-parse EVERY message's markdown on each tick.
 */
export const Prose = memo(function Prose({ text, className }: { text: string; className: string }) {
  return (
    <div className={`prose ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ node: _node, ...props }) {
            return <a {...props} target="_blank" rel="noopener noreferrer" />;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
