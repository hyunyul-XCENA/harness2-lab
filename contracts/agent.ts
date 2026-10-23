/** App-owned draft contracts; provider SDK types stay inside each adapter. */
export type Engine = "codex" | "claude";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type SessionState =
  | "opening" | "idle" | "running" | "waiting_request"
  | "interrupting" | "recovering" | "closed" | "failed";

export interface Capabilities {
  persistentInput: boolean;
  resume: boolean;
  interrupt: boolean;
  midTurnInput: "steer" | "queue" | "unsupported";
  approvalRequests: boolean;
  userQuestions: boolean;
  hardCostLimit: boolean;
  hardTokenLimit: boolean;
}

export interface RuntimeIdentity {
  engine: Engine;
  executableVersion: string;
  sdkVersion?: string;
  protocolVersion?: string;
}

export interface HarnessSnapshot {
  id: string;
  scope: "global" | "project";
  digest: string;
  compilerVersion: string;
  projectInstructionsDigest: string;
  materializedDirectory: string;
  appendedInstructions: string;
}

export interface SessionSpec {
  appSessionId: string;
  cwd: string;
  /** Requested model; omitted means the provider default. */
  model?: string;
  harness: HarnessSnapshot;
  permissionMode: "interactive";
  /** Claude-specific. Other adapters must reject unsupported options. */
  claude?: { settingsSources: readonly ("user" | "project" | "local")[] };
}

export interface SessionCheckpoint {
  spec: SessionSpec;
  runtime: RuntimeIdentity;
  nativeSessionId: string;
  /** Required before a trial can support reproducible adoption. */
  resolvedModel?: string;
  lastNativeTurnId?: string;
  lastJournalSequence: number;
  /** Provider-specific serializable cursor, never a credential or connection. */
  providerCursor?: Json;
}

export interface LiveSession {
  appSessionId: string;
  nativeSessionId: string;
  /** Changes whenever the transport is reopened. */
  connectionEpoch: string;
}

export interface InputMessage {
  requestId: string;
  text: string;
  mode: "next-turn" | "steer-current-turn";
  expectedNativeTurnId?: string;
}

export type SubmissionStatus = "queued" | "sent" | "accepted" | "completed" | "unknown" | "rejected";
export interface SubmissionReceipt {
  requestId: string;
  status: SubmissionStatus;
  nativeTurnId?: string;
  evidence?: string;
}

interface RequestBase {
  requestId: string;
  connectionEpoch: string;
  nativeTurnId?: string;
  expiresAt: string;
}

export type PendingRequest =
  | (RequestBase & { kind: "approval"; toolName: string; description: string; input: Json })
  | (RequestBase & { kind: "question"; questions: readonly UserQuestion[] });

export interface UserQuestion {
  id: string;
  text: string;
  options?: readonly string[];
  allowFreeText: boolean;
}

export type RequestAnswer =
  | { kind: "approval"; decision: "allow-once" | "deny" }
  | { kind: "question"; answers: Readonly<Record<string, string>> };

export type EventPayload =
  | { type: "session.ready"; capabilities: Capabilities; checkpoint: SessionCheckpoint }
  | { type: "state.changed"; previous: SessionState; current: SessionState }
  | { type: "submission.changed"; receipt: SubmissionReceipt }
  | { type: "turn.started"; nativeTurnId: string; requestId?: string }
  | { type: "message.delta"; itemId: string; text: string }
  | { type: "tool.started"; itemId: string; name: string; input: Json }
  | { type: "tool.completed"; itemId: string; success: boolean; outputArtifact?: string }
  | { type: "request.pending"; request: PendingRequest }
  | { type: "request.resolved"; requestId: string }
  | { type: "turn.completed"; nativeTurnId: string; outcome: "success" | "interrupted" | "failed" }
  | { type: "usage.updated"; inputTokens?: number; outputTokens?: number; costUsdEstimate?: number }
  | { type: "transport.disconnected"; uncertainRequestIds: readonly string[]; reason: string }
  | { type: "adapter.error"; code: string; message: string; recoverable: boolean };

export interface AgentEvent {
  eventId: string;
  appSessionId: string;
  connectionEpoch: string;
  receivedAt: string;
  nativeEventId?: string;
  payload: EventPayload;
  /** Reference to a sanitized local native event, not raw credentials. */
  nativeArtifact?: string;
}

export interface AgentAdapter {
  readonly engine: Engine;
  inspect(): Promise<{ runtime: RuntimeIdentity; capabilities: Capabilities }>;
  start(spec: SessionSpec): Promise<LiveSession>;
  resume(checkpoint: SessionCheckpoint): Promise<LiveSession>;
  /** Subscribe once before submit. A completed turn does not end this iterable. */
  events(session: LiveSession): AsyncIterable<AgentEvent>;
  submit(session: LiveSession, input: InputMessage): Promise<SubmissionReceipt>;
  interrupt(session: LiveSession, nativeTurnId: string): Promise<void>;
  answer(session: LiveSession, requestId: string, answer: RequestAnswer): Promise<void>;
  /** Reconcile native history; never resubmit an input as part of reconciliation. */
  reconcile(session: LiveSession, pending: readonly SubmissionReceipt[]): Promise<readonly SubmissionReceipt[]>;
  checkpoint(session: LiveSession): Promise<SessionCheckpoint>;
  /** Close the app-owned connection/process, preserving the native conversation. */
  close(session: LiveSession): Promise<void>;
}

export interface ValidationCommand {
  id: string;
  program: string;
  args: readonly string[];
  cwdRelative: string;
  timeoutMs: number;
  required: boolean;
}

export interface TrialIdentity {
  experimentId: string;
  trialId: string;
  inputSnapshotDigest: string;
  harnessDigest: string;
  validationRecipeDigest: string;
  runtime: RuntimeIdentity;
  resolvedModel: string;
  environmentDigest: string;
  repetition: number;
}

export interface CheckResult {
  id: string;
  status: "pass" | "fail" | "timeout" | "error";
  exitCode?: number;
  evidenceArtifacts: readonly string[];
}

export type AdoptionDecision = {
  experimentId: string;
  baselineDigest: string;
  candidateDigest: string;
  verdict: "adopt" | "keep" | "defer";
  reasons: readonly string[];
  checks: readonly CheckResult[];
  evidenceArtifacts: readonly string[];
  /** A recommendation is persisted before a user chooses project activation. */
  activatedByUser: boolean;
} & (
  | { scope: "task" | "project" }
  | { scope: "global"; transferCheckArtifacts: readonly string[] }
);
