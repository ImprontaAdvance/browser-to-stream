Prima dell'avvio, impostare l'endpoint RTMPS e la stream key dell'evento Vimeo di staging. Non inserirli nel repository o nei log:

```sh
read -r "VIMEO_RTMPS_URL?Vimeo RTMPS URL: "
read -rs "VIMEO_STREAM_KEY?Vimeo stream key: "; echo
export VIMEO_RTMPS_URL VIMEO_STREAM_KEY
```

`VIMEO_RTMPS_URL` must contain only the RTMPS URL copied from Vimeo (normally
including `:443`); put the separate value from the **Stream key** field in
`VIMEO_STREAM_KEY`. The example appends the key itself.

Per isolare un problema TLS di FFmpeg su macOS, è possibile inserire nello
stesso campo l'URL **RTMP** non cifrato fornito da Vimeo (non l'URL RTMPS).
È un test locale temporaneo: la configurazione Docker finale deve continuare a
usare RTMPS.

`npx tsx index.ts`

`curl 'http://localhost:3000/start-recording?target=https%3A%2F%2Fevents.angelinipharma.com%2Ff179048e-58df-477b-a039-65076e8e0306%2Ffaculty%2Fa304e903-b52d-4b79-aaf3-8c9b6669c40e%2Foutput%3Fk%3DFsJ65ixkltzaU8x'`

`curl 'http://localhost:3000/stop-recording?streamId=<STREAM ID>'`

L'esempio invia direttamente a Vimeo un Matroska H.264/Opus. FFmpeg conserva il video con stream copy e converte solo l'audio in AAC prima dell'output FLV/RTMPS; non crea un file. Nei log l'input deve essere `matroska`, con una traccia H.264 e una Opus, e lo stream mapping deve mostrare `copy` per il video e `opus -> aac` per l'audio.
