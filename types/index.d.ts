export * from './events';
export * from './project';
export * from './ipc';

export interface SystemConfig {
  system: {
    port: number;
    debug: boolean;
    logLevel: string;
    logFormat: string;
  };
  // More config properties will be typed later
  [key: string]: any;
}
