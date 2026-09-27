import { createHash, randomUUID } from "node:crypto";
import { parseNativePatchInput } from "../../../harness.js";
import type { Session } from "../session.js";
import {
  CODEX_HISTORY_ITEM_LIMIT,
  CodexAppServerError,
  type CodexClient,
  type CodexRequestId,
  type CodexServerRequest,
} from "./client.js";

// Bound retained diff bytes independently of small lifetime replay tombstones.
const MAX_PENDING_PATCHES = 32;
type PatchInput = NonNullable<ReturnType<typeof parseNativePatchInput>>;

interface FileApproval {
  request: CodexServerRequest;
  fingerprint: string;
  coordinate: string;
  viewerId: string;
  submitted: boolean;
}

interface PendingPatch {
  input: PatchInput;
  fingerprint: string;
  approval: FileApproval | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function id(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= 256;
}

function fingerprint(input: PatchInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/** Convert only the pinned full native patch shape. No partial diff or inferred move authority. */
function patchInput(item: Record<string, unknown>): PatchInput | null {
  if (
    item.type !== "fileChange" ||
    !keys(item, ["type", "id", "changes", "status"]) ||
    !Array.isArray(item.changes) ||
    item.changes.length < 1 ||
    item.changes.length > 20
  )
    return null;
  const changes = [];
  for (const value of item.changes) {
    const change = record(value);
    const kind = record(change?.kind);
    if (
      change === null ||
      kind === null ||
      typeof change.path !== "string" ||
      !change.path.startsWith("/") ||
      !keys(change, ["path", "kind", "diff"]) ||
      !keys(kind, kind.type === "update" ? ["type", "move_path"] : ["type"]) ||
      (kind.type !== "add" && kind.type !== "delete" && kind.type !== "update") ||
      (kind.move_path !== undefined && kind.move_path !== null)
    )
      return null;
    changes.push({ path: change.path, operation: kind.type, diff: change.diff });
  }
  return parseNativePatchInput({ changes });
}

/** Fresh native item/request pairs only. Hydration never calls this helper. The original callback
 * stays connection-owned; browser input can select only accept/decline, never replacement edits. */
export class CodexFileApprovals {
  readonly #seen = new Set<string>();
  readonly #seenRequests = new Set<CodexRequestId>();
  readonly #items = new Map<string, PendingPatch>();
  readonly #native = new Map<CodexRequestId, FileApproval>();
  readonly #viewers = new Map<string, FileApproval>();
  #closed = false;

  constructor(
    readonly session: Session,
    readonly threadId: string,
    readonly client: CodexClient,
  ) {}

  started(params: Record<string, unknown>): void {
    if (this.#closed || this.session.closed || params.threadId !== this.threadId) return;
    const item = record(params.item);
    if (!id(params.turnId) || !id(item?.id)) return;
    const coordinate = JSON.stringify([params.turnId, item.id]);
    const previous = this.#items.get(coordinate);
    if (item.type !== "fileChange" && previous === undefined) return;
    const input =
      keys(params, ["threadId", "turnId", "item", "startedAtMs"]) &&
      Number.isSafeInteger(params.startedAtMs) &&
      Number(params.startedAtMs) >= 0 &&
      item.status === "inProgress"
        ? patchInput(item)
        : null;
    if (previous !== undefined) {
      if (input === null || previous.fingerprint !== fingerprint(input)) this.#contradiction();
      return;
    }
    if (this.#seen.has(coordinate)) return;
    if (this.#seen.size >= CODEX_HISTORY_ITEM_LIMIT) this.#contradiction();
    this.#seen.add(coordinate);
    if (input === null) return; // An unsupported first start cannot later become fresh authority.
    if (this.#items.size >= MAX_PENDING_PATCHES) this.#contradiction();
    this.#items.set(coordinate, { input, fingerprint: fingerprint(input), approval: null });
  }

  observe(request: CodexServerRequest): void {
    if (
      this.#closed ||
      this.session.closed ||
      request.method !== "item/fileChange/requestApproval" ||
      request.params.threadId !== this.threadId
    )
      return;
    const p = request.params;
    const existing = this.#native.get(request.id);
    if (existing !== undefined) {
      if (existing.fingerprint !== JSON.stringify(p)) this.#contradiction();
      return;
    }
    if (this.#seenRequests.has(request.id)) return;
    if (this.#seenRequests.size >= CODEX_HISTORY_ITEM_LIMIT) this.#contradiction();
    this.#seenRequests.add(request.id);
    if (!id(p.turnId) || !id(p.itemId)) return;
    const coordinate = JSON.stringify([p.turnId, p.itemId]);
    const item = this.#items.get(coordinate);
    if (item === undefined) return;
    if (item.approval !== null) this.#contradiction();
    if (
      !keys(p, ["threadId", "turnId", "itemId", "startedAtMs", "reason", "grantRoot"]) ||
      !Number.isSafeInteger(p.startedAtMs) ||
      Number(p.startedAtMs) < 0 ||
      p.grantRoot !== null ||
      (p.reason != null && (typeof p.reason !== "string" || p.reason.length > 4096))
      // Native request has no advertised decisions: accept/decline are pinned to exact 0.154.0.
    ) {
      this.#finish(coordinate);
      return;
    }
    const approval: FileApproval = {
      request,
      fingerprint: JSON.stringify(p),
      coordinate,
      viewerId: randomUUID(),
      submitted: false,
    };
    item.approval = approval;
    this.#native.set(request.id, approval);
    this.#viewers.set(approval.viewerId, approval);
    this.session.pushUpstream({
      type: "control_request",
      request_id: approval.viewerId,
      request: {
        subtype: "can_use_tool",
        tool_name: "Patch",
        input: { nativePatch: true, changes: item.input.changes },
      },
    });
  }

  completed(params: Record<string, unknown>): void {
    if (this.#closed || params.threadId !== this.threadId) return;
    const item = record(params.item);
    if (!id(params.turnId) || !id(item?.id)) return;
    const coordinate = JSON.stringify([params.turnId, item.id]);
    const pending = this.#items.get(coordinate);
    if (pending === undefined) return;
    const input = patchInput(item);
    if (
      input === null ||
      !["completed", "failed", "declined"].includes(String(item.status)) ||
      pending.fingerprint !== fingerprint(input)
    )
      this.#contradiction();
    this.#finish(coordinate);
  }

  resolve(params: Record<string, unknown>): void {
    if (params.threadId !== this.threadId) return;
    const nativeId = params.requestId;
    if (typeof nativeId !== "string" && typeof nativeId !== "number") return;
    const approval = this.#native.get(nativeId);
    if (approval !== undefined) this.#finish(approval.coordinate);
  }

  respond(payload: Record<string, unknown>, signal: AbortSignal): void {
    if (this.#closed || signal.aborted || this.session.closed) return;
    const response = record(payload.response);
    if (response?.subtype !== "success" || typeof response.request_id !== "string") return;
    const approval = this.#viewers.get(response.request_id);
    const behavior = record(response.response)?.behavior;
    if (
      approval === undefined ||
      approval.submitted ||
      (behavior !== "allow" && behavior !== "deny")
    )
      return;
    approval.submitted = true; // Consume before any native write, including ambiguous failure.
    this.client.respondFileApproval(
      approval.request,
      behavior === "allow" ? "accept" : "decline",
      signal,
    );
  }

  close(): void {
    this.#closed = true;
    this.#items.clear();
    this.#native.clear();
    this.#viewers.clear();
    this.#seen.clear();
    this.#seenRequests.clear();
  }

  #finish(coordinate: string): void {
    const approval = this.#items.get(coordinate)?.approval;
    this.#items.delete(coordinate);
    if (approval == null) return;
    this.#native.delete(approval.request.id);
    this.#viewers.delete(approval.viewerId);
    this.session.pushUpstream({ type: "control_cancel_request", request_id: approval.viewerId });
  }

  #contradiction(): never {
    this.close();
    throw new CodexAppServerError("Codex file approval input changed or exceeded its bound");
  }
}
