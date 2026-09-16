`npx tsx index.ts`

`curl 'http://localhost:3000/start-recording?target=https%3A%2F%2Fevents.angelinipharma.com%2Ff179048e-58df-477b-a039-65076e8e0306%2Ffaculty%2Fa304e903-b52d-4b79-aaf3-8c9b6669c40e%2Foutput%3Fk%3DFsJ65ixkltzaU8x'`

`curl 'http://localhost:3000/stop-recording?streamId=<STREAM ID>'`

`/test-source` è locale: mostra un flash e un contatore, con un tick audio di 80 ms nello stesso istante ogni secondo. Il browser riceve un click automatico per avviare l'audio.

Nei log di FFmpeg l'input deve essere `flv`, con una traccia H.264 e una AAC. Non deve comparire l'avviso `Timestamps are unset in a packet`.
