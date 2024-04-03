import {Readable, Transform} from 'node:stream';
import assert from 'node:assert';
import {WebSocketServer} from 'ws';

type ConnectionParams = {
  video: string;
  audio: string;
  streamId: string;
};

export function startSocketServer(
  port: number = 8080,
  onConnection: (stream: Readable, data: ConnectionParams) => void
): () => void {
  const wss = new WebSocketServer({
    port: port,
    perMessageDeflate: false,
  });

  wss.on('connection', (ws, req) => {
    console.log('[WS] Connected via: ', req.url);
    assert(req.url, '[WS] Connection opened without url');

    const url = new URL(req.url, 'http://foo.com');

    const stream = new Transform({
      transform(chunk, encoding, callback) {
        callback(null, chunk);
      },
    });

    ws.on('message', (msg) => {
      stream.write(msg);
    });

    ws.on('close', () => {
      stream.end();
    });

    onConnection(
      stream,
      Object.fromEntries(url.searchParams.entries()) as ConnectionParams
    );
  });

  return () => wss.close();
}
