export interface SafetyOptions {
  maxCycleMs?: number;
  maxCost?: number;
}

export interface IPCStartMessage {
  type: 'START';
  projectPath: string;
  task: import('./project').Story | null;
  safetyOptions?: SafetyOptions;
}

export interface IPCStatusMessage {
  type: 'STATUS';
  phase: string;
}

export interface IPCEventMessage {
  type: 'EVENT';
  event: {
    actor: string;
    source: string;
    payload: any;
  };
}

export interface IPCDoneMessage {
  type: 'DONE';
  result: {
    ok: boolean;
    error?: string;
    info?: any;
  };
}

export type WorkerIPCMessage =
  | IPCStartMessage
  | IPCStatusMessage
  | IPCEventMessage
  | IPCDoneMessage;
