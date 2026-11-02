export interface RevisionMeta {
  id: string;
  unit: string;
  parents: string[];
  deleted: boolean;
  hash: string;
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
  onApplied?: (paths: string[]) => void;
}
export interface SyncResult {
  uploaded: number;
  downloaded: number;
  conflicts: number;
  deferred: boolean;
}
