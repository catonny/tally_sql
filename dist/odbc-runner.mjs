import process from 'process';
import { OdbcReplicator } from './odbc-sync.mjs';
function parseConfigFromArgs() {
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index += 2) {
        const arg = args[index];
        if (arg === '--config' && index + 1 < args.length) {
            const encoded = args[index + 1];
            const decoded = Buffer.from(encoded, 'base64').toString('utf8');
            return JSON.parse(decoded);
        }
    }
    throw new Error('Sync configuration was not supplied to ODBC runner.');
}
const config = parseConfigFromArgs();
const log = (message) => {
    if (process.send)
        process.send(message);
    else
        console.log(message);
};
const replicator = new OdbcReplicator(config, log);
let shuttingDown = false;
let intervalHandle = undefined;
async function runOnceAndHandleExit() {
    try {
        await replicator.runOnce();
        if (!config.sync.realtime) {
            await replicator.close();
            process.exit(0);
        }
    }
    catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        log(`Fatal error: ${errMessage}`);
        await replicator.close();
        process.exit(1);
    }
}
function scheduleRealtimeSync() {
    if (!config.sync.realtime)
        return;
    const intervalSeconds = Math.max(config.sync.intervalSeconds || 60, 5);
    log(`Realtime sync enabled. Interval: ${intervalSeconds} second(s).`);
    intervalHandle = setInterval(async () => {
        if (shuttingDown)
            return;
        try {
            await replicator.runOnce();
        }
        catch (err) {
            const errMessage = err instanceof Error ? err.message : String(err);
            log(`Error during realtime sync: ${errMessage}`);
        }
    }, intervalSeconds * 1000);
}
async function shutdown(code) {
    if (shuttingDown)
        return;
    shuttingDown = true;
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = undefined;
    }
    try {
        await replicator.close();
    }
    finally {
        process.exit(code);
    }
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
(async () => {
    await runOnceAndHandleExit();
    scheduleRealtimeSync();
})();
//# sourceMappingURL=odbc-runner.mjs.map