'use strict';
/**
 * Entry point. WispByte (Pterodactyl-style panels) should run:  node index.js
 * Flags:  --no-dashboard   run bots only
 *         --only=NAME      start just one bot (for testing); others stay stopped
 */
const REQUIRED_NODE_MAJOR = 22;
const major = Number(process.versions.node.split('.')[0]);
if (major < REQUIRED_NODE_MAJOR) {
  console.error(`[ERROR] Node.js ${process.versions.node} is too old. This project needs Node.js ${REQUIRED_NODE_MAJOR} or newer (Mineflayer requirement).`);
  console.error('[ERROR] In the WispByte panel: Startup tab -> change the Docker image / Node.js version to 22 or higher, then restart. See README.md.');
  process.exit(1);
}

const { load, resolveDashboardPort } = require('./src/config');
const { Logger } = require('./src/logger');
const { BotManager } = require('./src/botManager');
const { createDashboard } = require('./src/dashboard');

async function main() {
  const logger = new Logger();
  logger.info(`Application started (Node ${process.versions.node})`);

  const { config, errors, warnings } = load();
  warnings.forEach((w) => logger.warn(`config: ${w}`));
  if (errors.length) {
    errors.forEach((e) => logger.error(`config: ${e}`));
    logger.error('Fix config.json (or environment variables) and restart. Nothing was started.');
    process.exit(1);
  }
  logger.addSecret(config.login.password);
  logger.addSecret(config.dashboard.pin);

  const args = process.argv.slice(2);
  const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7) || process.env.ONLY_BOT || null;
  if (only && !config.bots.includes(only)) {
    logger.error(`--only=${only} is not in config.bots (${config.bots.join(', ')})`);
    process.exit(1);
  }

  const manager = new BotManager(config, logger);
  let dashboard = null;

  const wantDashboard = config.dashboard.enabled && !args.includes('--no-dashboard');
  if (wantDashboard) {
    const port = resolveDashboardPort(config, process.env);
    if (port === null) {
      logger.warn('Dashboard enabled but no port could be determined (set dashboard.port to a number, or DASHBOARD_PORT/SERVER_PORT). Running without the dashboard.');
    } else {
      try {
        dashboard = createDashboard({ pin: config.dashboard.pin, manager, logger, host: config.dashboard.host });
        const actual = await dashboard.start(port);
        // This only means the web server is up. It says NOTHING about Minecraft connections.
        logger.info(`Dashboard web server listening on ${config.dashboard.host}:${actual} (bots are NOT connected yet; watch their states)`);
      } catch (e) {
        dashboard = null;
        logger.error(`Dashboard could not start on port ${port}: ${e.message}. Bots will run without it.`);
      }
    }
  } else {
    logger.info('Dashboard disabled; running bots only');
  }

  if (only) manager.startAll([only]);
  else if (config.autoStart !== false) manager.startAll();
  else logger.info('autoStart is false; waiting for Start from the dashboard');

  let closing = false;
  const shutdown = async (sig) => {
    if (closing) return;
    closing = true;
    logger.info(`${sig} received, stopping bots`);
    try { await manager.shutdown(); if (dashboard) await dashboard.stop(); } catch (e) { logger.error(`shutdown error: ${e.message}`); }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('unhandledRejection', (e) => console.error('[ERROR] Unhandled rejection:', e && e.message ? e.message : e));
process.on('uncaughtException', (e) => console.error('[ERROR] Uncaught exception:', e && e.stack ? e.stack : e));

main().catch((e) => { console.error('[ERROR] Fatal startup error:', e.message); process.exit(1); });
