export interface RefreshResult {
  ok: boolean;
  log?: string;
  error?: string;
  running?: boolean;
}

export interface DataFileStatus {
  size: number;
  mtime: string;
}

export interface DataStatus {
  ces: DataFileStatus | null;
  servants: DataFileStatus | null;
}

export function refreshData(projectRoot: string): Promise<RefreshResult>;
export function dataStatus(projectRoot: string): Promise<DataStatus>;
