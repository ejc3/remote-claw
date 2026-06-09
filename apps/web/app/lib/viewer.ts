// The browser viewer: a thin, framework-free wrapper over the SHARED transport (@remote-claw/cli/broker)
// for the things a phone/laptop driver does — discover sessions on the bus, tail a session's
// transcript, ask for history, and send a prompt. It reuses the exact BrokerClient / FrameOrderer /
// SecurityProvider the host uses, so there is no second protocol implementation to drift.

import { type FrameHeader, type Identity, parsePass, utf8 } from "@remote-claw/clawsec";
import {
  BrokerClient,
  type BrokerClientOptions,
  FrameOrderer,
  securityProvider,
} from "@remote-claw/cli/broker";

const td = new TextDecoder();

/** Presence: a session is "online" iff its latest announce's sent_at is within this window (§4.3). */
export const FRESH_WINDOW_MS = 60_000;

/** A decrypted session_announce from the bus. */
export interface Announce {
  sessionId: string;
  title: string;
  cwd: string | null;
  sentAt: number;
}

/** A decrypted transcript message from a session's out-stream. */
export interface Message {
  kind: string;
  seq: number | null;
  text: string;
  msgId: string;
}

export class Viewer {
  readonly #client: BrokerClient;
  readonly #identityId: Uint8Array;

  private constructor(identity: Identity, baseUrl: string, fetchFn?: typeof fetch) {
    this.#identityId = identity.identityId;
    const opts: BrokerClientOptions = {
      baseUrl,
      provider: securityProvider("sealed", identity),
    };
    // exactOptionalPropertyTypes: only set fetchFn when a custom one is supplied (tests).
    if (fetchFn !== undefined) opts.fetchFn = fetchFn;
    this.#client = new BrokerClient(opts);
  }

  /**
   * Build a viewer from a pasted/fragment pass (`rcp1_…`). Throws PassError on a bad pass. `baseUrl`
   * defaults to same-origin (""); `fetchFn` is for tests (defaults to the global fetch).
   */
  static async fromPass(pass: string, baseUrl = "", fetchFn?: typeof fetch): Promise<Viewer> {
    return new Viewer(await parsePass(pass.trim()), baseUrl, fetchFn);
  }

  #header(
    extra: Partial<FrameHeader> & Pick<FrameHeader, "recordKind" | "sessionId" | "msgId">,
  ): FrameHeader {
    return {
      v: 1,
      identityId: this.#identityId,
      dir: "in",
      seq: null,
      keyEpoch: 0,
      part: 0,
      parts: 1,
      ...extra,
    };
  }

  /** Tail the identity bus; yield each fresh session_announce (decrypted under K_meta). */
  async *announces(signal: AbortSignal): AsyncGenerator<Announce> {
    for await (const frame of this.#client.streamFrames({ startIndex: -64, signal })) {
      if (frame.recordKind !== "session_announce") continue;
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(td.decode(await this.#client.openFrame(frame)));
      } catch {
        continue; // a frame we can't open/parse (not ours / corrupt) — skip, never crash the list
      }
      yield {
        sessionId: String(body.session_id ?? frame.sessionId),
        title: typeof body.title === "string" ? body.title : String(body.session_id ?? ""),
        cwd: typeof body.cwd === "string" ? body.cwd : null,
        sentAt: typeof body.sent_at === "number" ? body.sent_at : 0,
      };
    }
  }

  /** Tail a session's out-stream; yield decoded transcript messages (deduped + reordered by seq). */
  async *transcript(sessionId: string, signal: AbortSignal): AsyncGenerator<Message> {
    const orderer = new FrameOrderer();
    for await (const frame of this.#client.streamFrames({
      session: sessionId,
      startIndex: 0,
      signal,
    })) {
      if (frame.dir !== "out") continue; // the viewer renders host→web frames only
      for (const f of orderer.accept(frame)) {
        let text: string;
        try {
          text = td.decode(await this.#client.openFrame(f));
        } catch {
          continue;
        }
        yield { kind: f.recordKind, seq: f.seq, text, msgId: f.msgId };
      }
    }
  }

  /** Ask the host to replay history from `since` (a control frame on the session channel). */
  async requestHistory(sessionId: string, since = 0): Promise<void> {
    await this.#client.postFrame(
      this.#header({ recordKind: "catch_up", sessionId, msgId: `catchup-${since}-${randomId()}` }),
      utf8(JSON.stringify({ since, expiry: Date.now() + FRESH_WINDOW_MS })),
    );
  }

  /** Send a prompt to the session (a `user` content frame, dir:in). Returns its client_msg_id. */
  async sendPrompt(sessionId: string, text: string): Promise<string> {
    const clientMsgId = `c-${randomId()}`;
    await this.#client.postFrame(
      this.#header({ recordKind: "user", sessionId, msgId: clientMsgId, clientMsgId }),
      utf8(text),
    );
    return clientMsgId;
  }
}

/** A short random id (browser + Node 22 both expose WebCrypto). */
function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint32Array(2)), (n) => n.toString(36)).join("");
}
