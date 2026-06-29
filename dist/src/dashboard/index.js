#!/usr/bin/env node
import config from '../config/index.js';
import { DashboardServer } from './server.js';
const dashboardServer = new DashboardServer(config.dashboard.port, null);
dashboardServer.start();
async function gracefulShutdown(signal) {
    console.log(`[dashboard] Received ${signal}, shutting down...`);
    dashboardServer.stop();
    process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
