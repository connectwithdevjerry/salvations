/** Infrastructure ports. Every one of these is swappable without touching the runtime. */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface WrappedDek {
  readonly wrapped: Uint8Array;
  readonly keyProvider: string;
  readonly kekVersion: number;
}

export interface KeyProvider {
  readonly name: string;
  readonly version: number;
  wrap(dek: Uint8Array): Promise<WrappedDek>;
  unwrap(wrapped: WrappedDek): Promise<Uint8Array>;
}

export interface BlobStore {
  put(key: string, data: Uint8Array, mime: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface AuditEntry {
  readonly actor: { readonly type: string; readonly id?: string };
  readonly action: string;
  readonly subject: { readonly type: string; readonly id?: string };
  readonly metadata?: Record<string, unknown>;
}

export interface AuditWriter {
  write(entry: AuditEntry): Promise<void>;
}
