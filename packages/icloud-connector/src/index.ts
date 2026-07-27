import { serveStdio } from '@cloud-connectors/core';
import { registerMailTools } from './tools/mail.js';
import { registerDriveTools } from './tools/drive.js';

await serveStdio('icloud-connector', '0.2.0', (server) => {
    registerMailTools(server);
    registerDriveTools(server);
});
