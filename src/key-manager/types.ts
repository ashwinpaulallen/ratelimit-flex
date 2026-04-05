import type { RateLimitStore } from '../types/index.js';

/** Why a key was blocked */
export type BlockReason =
  | { type: 'manual'; message?: string }
  | { type: 'penalty-escalation'; penaltyCount: number; threshold: number; violationNumber?: number }
  | { type: 'abuse-pattern'; pattern: string }
  | { type: 'custom'; code: string; metadata?: Record<string, unknown> };

/** A snapshot of a key's full state */
export interface KeyState {
  key: string;
  totalHits: number;
  remaining: number;
  resetTime: Date;
  isBlocked: boolean;

  /** Is this key explicitly blocked via block()? */
  isManuallyBlocked: boolean;
  /** If blocked, why? */
  blockReason?: BlockReason;
  /** If blocked, when does the block expire? null = permanent */
  blockExpiresAt?: Date | null;

  /** Cumulative penalty points applied in the current window */
  penaltyPoints: number;
  /** Cumulative reward points applied in the current window */
  rewardPoints: number;
}

/** Events emitted by KeyManager */
export interface KeyManagerEvents {
  /** Fired when a key is blocked (manually or via penalty escalation) */
  blocked: (event: {
    key: string;
    reason: BlockReason;
    expiresAt: Date | null;
    state: KeyState;
    timestamp: Date;
  }) => void;

  /** Fired when a block expires or is manually lifted */
  unblocked: (event: {
    key: string;
    wasReason: BlockReason;
    unblockedBy: 'expiry' | 'manual';
    timestamp: Date;
  }) => void;

  /** Fired when penalty points are added */
  penalized: (event: {
    key: string;
    points: number;
    totalPenaltyPoints: number;
    state: KeyState;
    timestamp: Date;
  }) => void;

  /** Fired when reward points are applied */
  rewarded: (event: {
    key: string;
    points: number;
    totalRewardPoints: number;
    state: KeyState;
    timestamp: Date;
  }) => void;

  /** Fired when a key is deleted */
  deleted: (event: {
    key: string;
    previousState: KeyState | null;
    timestamp: Date;
  }) => void;

  /** Fired when a key's hit count is explicitly set */
  set: (event: {
    key: string;
    previousHits: number;
    newHits: number;
    state: KeyState;
    timestamp: Date;
  }) => void;
}

/** Entry in the audit log */
export interface AuditEntry {
  timestamp: Date;
  key: string;
  action: 'block' | 'unblock' | 'penalty' | 'reward' | 'set' | 'delete' | 'get';
  details: Record<string, unknown>;
  /** Optional: who performed this action (e.g. admin user ID, system name) */
  actor?: string;
}

/** Configuration for KeyManager */
export interface KeyManagerOptions {
  /** The backing store */
  store: RateLimitStore;

  /** Max requests per window — needed to calculate `remaining` and `isBlocked` for get/set */
  maxRequests: number;

  /** Window duration in ms — needed for default block/set expiry */
  windowMs: number;

  /** Maximum audit log entries to keep in memory (default: 1000, 0 = disabled) */
  maxAuditLogSize?: number;

  /**
   * Penalty escalation: automatically block a key after it accumulates
   * this many penalty points within a single window. Default: disabled.
   */
  penaltyBlockThreshold?: number;

  /** Duration in ms to block a key when penalty threshold is hit. Default: windowMs */
  penaltyBlockDurationMs?: number;

  /**
   * How to calculate block duration when the penalty threshold is exceeded.
   * Default: `fixedEscalation(penaltyBlockDurationMs ?? windowMs)` (see `./strategies.js`).
   * Each time the threshold is crossed again (after unblock or expiry), the violation count increases and a longer block may apply.
   * The violation count resets when the key is manually unblocked or deleted.
   */
  penaltyEscalation?: import('./strategies.js').EscalationStrategy;

  /** Check interval in ms for expiring blocks. Default: 1000 */
  blockExpiryCheckIntervalMs?: number;

  /**
   * Persistent block store for cross-process block visibility (e.g. Redis).
   * If not provided, blocks are in-memory only (per-process).
   */
  blockStore?: import('./block-store.js').BlockStore;

  /**
   * How often to pull {@link BlockStore.getAllBlocks} into the local cache (ms).
   * Default: 5000. Set to 0 to disable background sync (use {@link KeyManager.syncBlocks} manually).
   */
  syncIntervalMs?: number;
}
