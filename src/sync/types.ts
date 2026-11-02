export interface RevisionMeta {
  id: string;
  unit: string;
  parents: string[];
  deleted: boolean;
  hash: string;
  /** Wall-clock ms at creation; absent on revisions from older builds. */
  at?: number;
}
export interface Revision {
  meta: RevisionMeta;
  files: Record<string, string>;
}
export interface SyncRemote {
  list(): Promise<RevisionMeta[]>;
  download(meta: RevisionMeta): Promise<Revision>;
  upload(revision: Revision): Promise<void>;
}
export interface SyncEngineOptions {
  root: string;
  stateDir: string;
  remote: SyncRemote;
  accountId: string;
  isBusy?: () => boolean;
  /** Injectable clock (ms) for deterministic tests. */
  now?: () => number;
  onApplied?: (paths: string[]) => void;
}
export interface SyncResult {
  uploaded: number;
  downloaded: number;
  conflicts: number;
  deferred: boolean;
}
