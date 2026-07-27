import { serveStdio } from '@cloud-connectors/core';
import { registerAuthTools } from './tools/authTools.js';
import { registerMailTools } from './tools/mail.js';
import { registerOneDriveTools } from './tools/onedrive.js';

const VERSION = '0.3.0';

void serveStdio('windows-live-connector', VERSION, (server) => {
    registerAuthTools(server);
    registerMailTools(server);
    registerOneDriveTools(server);
});
