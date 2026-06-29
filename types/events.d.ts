export type TelemetryLevel = 'debug' | 'info' | 'warn' | 'error';

export interface BaseEvent {
  ts: string;
  source: string;
}

export interface LogEvent extends BaseEvent {
  type: 'log';
  level: TelemetryLevel;
  message: string;
  data?: Record<string, unknown>;
  sessionId?: string;
  taskId?: string;
  projectId?: string;
}

export interface PhaseTransitionEvent extends BaseEvent {
  type: 'phase.transition';
  data: {
    from: string;
    to: string;
    taskId: string | null;
    projectSlug: string;
  };
}

export interface ModelCallEvent extends BaseEvent {
  type: 'model.call';
  data: {
    model: string;
    provider: string;
    cost: number;
    tokens: {
      prompt: number;
      completion: number;
      total: number;
    };
    durationMs: number;
  };
}

export interface SystemMetricsEvent extends BaseEvent {
  type: 'system.metrics';
  data: {
    cpu: number;
    cpuCores: number;
    uptime: number;
    ramUsed: number;
    ramTotal: number;
    ramPct: number;
    diskUsed: number;
    diskTotal: number;
    diskPct: number;
  };
}

export type SystemEvent = LogEvent | PhaseTransitionEvent | ModelCallEvent | SystemMetricsEvent;
