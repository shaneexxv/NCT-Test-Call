// ESM server for Railway
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(express.static(__dirname));        // serves index.html from this folder
app.get('/healthz', (_, res) => res.send('ok'));

const server = http.createServer(app);
server.on('connection', s => s.setNoDelay(true));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('web up on', PORT));
