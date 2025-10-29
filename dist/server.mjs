import http from 'http';
import fs from 'fs';
import child_process from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { testOdbcConnection, testPostgresConnection } from './odbc-sync.mjs';
const httpPort = 8997;
const wsPort = 8998;
let isSyncRunning = false;
let syncProcess = undefined;
const wsServer = new WebSocketServer({
    port: wsPort
});
function broadcast(message) {
    wsServer.clients.forEach((wsClient) => {
        if (wsClient.readyState === WebSocket.OPEN) {
            wsClient.send(message);
        }
    });
}
function runSyncProcess(configObj) {
    const encodedConfig = Buffer.from(JSON.stringify(configObj)).toString('base64');
    syncProcess = child_process.fork('./dist/odbc-runner.mjs', ['--config', encodedConfig]);
    syncProcess.on('message', (msg) => broadcast(msg.toString()));
    syncProcess.on('close', () => {
        isSyncRunning = false;
        broadcast('~');
    });
}
function readJson(body) {
    if (!body || body.trim().length === 0)
        return {};
    return JSON.parse(body);
}
function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
}
const httpServer = http.createServer((req, res) => {
    let reqContent = '';
    req.on('data', (chunk) => reqContent += chunk);
    req.on('end', async () => {
        try {
            if (req.url === '/') {
                const fileContent = fs.readFileSync('./gui.html', 'utf8');
                res.statusCode = 200;
                res.setHeader('Content-Type', 'text/html');
                res.end(fileContent);
                return;
            }
            if (req.url === '/loadconfig') {
                const fileContent = fs.readFileSync('./config.json', 'utf8');
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(fileContent);
                return;
            }
            if (req.url === '/saveconfig') {
                const configObj = readJson(reqContent);
                fs.writeFileSync('./config.json', JSON.stringify(configObj, null, 4), { encoding: 'utf8' });
                res.statusCode = 200;
                res.setHeader('Content-Type', 'text/plain');
                res.end('Config saved');
                return;
            }
            if (req.url === '/sync') {
                const configObj = readJson(reqContent);
                if (isSyncRunning) {
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'text/plain');
                    res.end('Sync is already running');
                }
                else {
                    isSyncRunning = true;
                    runSyncProcess(configObj);
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'text/plain');
                    res.end('Sync started');
                }
                return;
            }
            if (req.url === '/abort') {
                let response = 'Could not kill process';
                if (syncProcess) {
                    syncProcess.kill();
                    response = 'Process killed';
                }
                res.statusCode = 200;
                res.setHeader('Content-Type', 'text/plain');
                res.end(response);
                return;
            }
            if (req.url === '/odbc/test') {
                const objConfig = readJson(reqContent);
                try {
                    const tables = await testOdbcConnection(objConfig);
                    sendJson(res, 200, { success: true, tables });
                }
                catch (err) {
                    const errMessage = err instanceof Error ? err.message : String(err);
                    sendJson(res, 500, { success: false, error: errMessage });
                }
                return;
            }
            if (req.url === '/postgres/test') {
                const objConfig = readJson(reqContent);
                try {
                    await testPostgresConnection(objConfig);
                    sendJson(res, 200, { success: true });
                }
                catch (err) {
                    const errMessage = err instanceof Error ? err.message : String(err);
                    sendJson(res, 500, { success: false, error: errMessage });
                }
                return;
            }
            res.writeHead(404);
            res.end();
        }
        catch (err) {
            const errMessage = err instanceof Error ? err.message : String(err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/plain');
            res.end(errMessage);
        }
    });
});
httpServer.listen(httpPort, 'localhost', () => {
    console.log(`Server started on http://localhost:${httpPort}`);
    console.log('Launching utility GUI page on default browser...');
    child_process.exec(`start http://localhost:${httpPort}`);
    setInterval(() => {
        if (wsServer.clients.size === 0 && !isSyncRunning) {
            console.log('No webpage connected. Closing utility...');
            process.exit(0);
        }
    }, 5000);
});
//# sourceMappingURL=server.mjs.map