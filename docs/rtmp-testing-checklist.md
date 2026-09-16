# Checklist diagnostica RTMP

## Ambito

Questa checklist riguarda esclusivamente il percorso live RTMP/RTMPS:

```text
pagina Chrome
  -> tab capture
  -> MediaRecorder
  -> WebSocket locale
  -> FFmpeg
  -> FLV/RTMP(S)
  -> Vimeo
```

Configurazione di riferimento:

- `browser-to-stream` 0.0.6;
- una Fly Machine per stream;
- CPU Fly `performance`, 8 vCPU e 16 GB RAM;
- risoluzione di cattura 1280x720;
- destinazione Vimeo via RTMPS.

## Osservazioni già confermate

- [x] Chrome produce realmente un contenitore WebM/Matroska.
- [x] Il video in ingresso a FFmpeg è VP8, 1280x720, `yuv420p`.
- [x] L'audio in ingresso è Opus, 48 kHz, stereo.
- [x] La query WebSocket dichiara erroneamente `video=h264`; non coincide con i byte ricevuti.
- [x] FFmpeg esegue una doppia codifica completa:
  - `VP8 -> H.264/libx264`;
  - `Opus -> AAC`.
- [x] FFmpeg utilizza il preset `veryfast`, il tune `zerolatency` e CRF 23 implicito.
- [x] `libx264` seleziona automaticamente 4 thread e 4 slice per il video 720p.
- [x] L'ingresso viene rilevato come circa 1 frame/s (`1 tbr`).
- [x] Il flusso di uscita dichiara 25 fps, ma nel campione sono stati codificati circa 100 frame in 100 secondi.
- [x] Il GOP è configurato a 50 frame; con un ingresso effettivo di circa 1 fps può diventare molto più lungo dei 2 secondi richiesti.
- [x] Non sono configurati bitrate video, `maxrate` o `bufsize`; l'encoder lavora in CRF.
- [x] Il bitrate riportato nel campione scende a circa 14-18 kbit/s.
- [x] Nell'estratto analizzato compare una sola connessione WebSocket e una sola inizializzazione FFmpeg.
- [ ] L'estratto non contiene la conclusione dello stream: il cleanup dopo `/api/stop` non è ancora verificato.
- [x] `/api/start` risponde dopo circa 2,14 secondi.
- [x] FFmpeg identifica l'ingresso circa 10 secondi dopo la richiesta di start.
- [x] Il cold start della Machine analizzata ha richiesto circa 2 minuti e 3 secondi; è un problema distinto dall'encoding.

## Controlli da eseguire per ogni test

### Identificazione della prova

- [ ] Annotare digest dell'immagine Docker.
- [ ] Annotare commit e versione effettiva di `browser-to-stream`.
- [ ] Annotare ID, regione, `cpu_kind`, numero di vCPU e RAM della Fly Machine.
- [ ] Annotare URL della pagina sorgente senza credenziali o token.
- [ ] Annotare variante testata: A, B, C o C2, secondo il piano dei next step.
- [ ] Usare lo stesso contenuto e la stessa sequenza temporale per tutte le varianti.
- [ ] Usare un evento Vimeo di staging, non un evento di produzione.

### Codec prodotto dal browser

- [ ] Registrare `MediaRecorder.isTypeSupported()` per ogni MIME type candidato.
- [ ] Registrare `recorder.mimeType` dopo l'evento `start`.
- [ ] Registrare `recorder.videoBitsPerSecond`.
- [ ] Registrare `recorder.audioBitsPerSecond`.
- [ ] Registrare `event.data.type` sul primo evento `dataavailable`.
- [ ] Verificare che il MIME type dichiarato coincida con quello rilevato da FFmpeg.

MIME type candidati, in ordine:

```text
video/mp4;codecs=avc1.4d401f,mp4a.40.2
video/mp4;codecs=avc1,mp4a.40.2
video/mp4
video/webm;codecs=vp8,opus
```

Un risultato positivo di `isTypeSupported()` non è sufficiente: il recorder deve avviarsi e il formato reale deve essere verificato.

### Codec rilevato da FFmpeg

- [ ] Conservare le righe da `Input #0` fino a `Stream mapping`.
- [ ] Verificare contenitore di ingresso: WebM/Matroska oppure MP4/MOV.
- [ ] Verificare codec video reale: VP8 oppure H.264.
- [ ] Verificare codec audio reale: Opus oppure AAC.
- [ ] Verificare risoluzione, pixel format e time base.
- [ ] Verificare che lo stream mapping coincida con la variante attesa.

Interpretazione dello stream mapping:

```text
vp8 -> h264 (libx264)    doppia codifica video
h264 -> h264 (libx264)   doppia codifica video evitabile
opus -> aac              ricodifica audio
h264 -> copy             nessuna ricodifica video
aac -> copy              nessuna ricodifica audio
```

### Frame rate e timestamp

- [ ] Verificare il frame rate dichiarato nell'ingresso (`tbr`, `tbn`).
- [ ] Verificare il frame rate dichiarato nell'uscita.
- [ ] Calcolare il frame rate effettivo dal contatore FFmpeg su almeno 60 secondi.
- [ ] Verificare che la cadenza effettiva sia coerente con il target concordato.
- [ ] Verificare che non compaiano `Non-monotonous DTS`, timestamp negativi o discontinuità.
- [ ] Verificare che `speed` rimanga stabile; per un input live un valore vicino a `1x` è normale.
- [ ] Non usare `speed ~= 1x` come prova di saturazione CPU.

### Keyframe e GOP

- [ ] Misurare gli intervalli reali tra keyframe sul playback di staging.
- [ ] Verificare che l'intervallo massimo sia circa 2 secondi per Vimeo.
- [ ] Non dedurre il GOP dal `timeslice` di MediaRecorder.
- [ ] Non assumere che `-g 50` equivalga a 2 secondi se il frame rate effettivo non è 25 fps.
- [ ] In modalità stream copy, verificare che sia il browser a produrre i keyframe richiesti.

Esempio di ispezione:

```shell
ffprobe -v error \
  -select_streams v:0 \
  -show_packets \
  -show_entries packet=pts_time,flags \
  -of csv=p=0 \
  '<playback-url-di-staging>'
```

I pacchetti con flag `K` sono keyframe. Non inserire l'URL di ingest o la stream key nei report.

### Bitrate e compatibilità Vimeo

- [ ] Registrare bitrate video medio, minimo e massimo.
- [ ] Registrare bitrate audio effettivo.
- [ ] Verificare `maxrate` e `bufsize`, se configurati.
- [ ] Verificare la qualità dello stream nel pannello di health Vimeo.
- [ ] Verificare assenza di lag crescente, freeze o riconnessioni.
- [ ] Verificare audio/video sync per almeno 10 minuti.
- [ ] Verificare che risoluzione, frame rate, bitrate e GOP rispettino il piano Vimeo utilizzato.

Riferimenti Vimeo:

- [Troubleshoot live streaming issues](https://help.vimeo.com/hc/en-us/articles/12426960955409-Troubleshoot-live-streaming-Issues)
- [Recommended network configuration](https://help.vimeo.com/hc/en-us/articles/12426939452817-Recommended-network-configuration-for-live-events)

### CPU e memoria

- [ ] Raccogliere CPU totale della Fly Machine.
- [ ] Raccogliere CPU del processo FFmpeg.
- [ ] Raccogliere CPU aggregata dei renderer Chrome.
- [ ] Raccogliere CPU del processo Chrome GPU/utility.
- [ ] Raccogliere CPU del processo Node.js.
- [ ] Raccogliere RSS per FFmpeg, Chrome e Node.js.
- [ ] Verificare assenza di swap e OOM.
- [ ] Campionare almeno ogni secondo.
- [ ] Ignorare i primi 30 secondi come warm-up nel confronto dei valori stabili.
- [ ] Eseguire almeno tre run per variante.

Controllo manuale indicativo dentro la Machine:

```shell
ps -eo pid,ppid,pcpu,pmem,rss,comm,args --sort=-pcpu
```

### Processi e lifecycle

- [ ] Prima dello start deve essere assente qualsiasi processo FFmpeg residuo.
- [ ] Durante lo streaming deve esserci esattamente un processo FFmpeg.
- [ ] Deve esserci una sola registrazione MediaRecorder attiva.
- [ ] Dopo `/api/stop`, FFmpeg deve terminare.
- [ ] Dopo `/api/stop`, WebSocket deve chiudersi.
- [ ] Dopo `/api/stop`, MediaRecorder deve risultare `inactive`.
- [ ] Dopo `/api/stop`, tutte le media track devono risultare `ended`.
- [ ] Dopo un errore RTMP simulato, l'intera pipeline deve chiudersi.
- [ ] Una seconda chiamata `/api/start` non deve creare un secondo encoder.

### Backpressure e stabilità

- [ ] Monitorare `WebSocket.bufferedAmount` nel browser.
- [ ] Controllare il risultato di `stream.write()` lato Node.js.
- [ ] Verificare che memoria e buffer non crescano nel tempo.
- [ ] Simulare una destinazione RTMP lenta o temporaneamente irraggiungibile.
- [ ] Verificare che la pipeline non continui a codificare senza consumer.
- [ ] Verificare che lo stato esposto da `/api/status` coincida con lo stato reale di FFmpeg.

### Latenza di avvio

- [ ] Misurare creazione Machine -> server in ascolto.
- [ ] Misurare server in ascolto -> `/api/ready` 200.
- [ ] Misurare `/api/start` -> connessione WebSocket.
- [ ] Misurare connessione WebSocket -> `Input #0` di FFmpeg.
- [ ] Misurare `/api/start` -> primi pacchetti accettati da Vimeo.
- [ ] Separare cold-start Docker/Fly dalla latenza MediaRecorder/FFmpeg.

### Sicurezza dei log

- [ ] Non registrare la query string completa di `/api/start`.
- [ ] Non registrare URL RTMP/RTMPS completi.
- [ ] Non registrare stream key, API key o token.
- [ ] Redigere i valori sensibili prima di condividere estratti.
- [ ] Ruotare ogni stream key accidentalmente esposta.

## Scheda risultati per una singola run

| Campo | Valore |
| --- | --- |
| Variante | |
| Digest immagine | |
| Machine/region | |
| Durata | |
| MIME type recorder | |
| Contenitore input FFmpeg | |
| Codec video input | |
| Codec audio input | |
| Stream mapping video | |
| Stream mapping audio | |
| Frame rate dichiarato | |
| Frame rate effettivo | |
| Intervallo keyframe massimo | |
| Bitrate video medio/massimo | |
| CPU FFmpeg media/p95 | |
| CPU Chrome media/p95 | |
| CPU Node media/p95 | |
| CPU Machine media/p95 | |
| RSS massimo | |
| Errori FFmpeg/Vimeo | |
| Esito stop/cleanup | |
| Note visive/audio | |

## Criteri minimi di accettazione

- [ ] Codec video di uscita H.264 compatibile con Vimeo.
- [ ] Audio AAC oppure audio convertito correttamente in AAC.
- [ ] Frame rate effettivo coerente e stabile.
- [ ] Keyframe almeno ogni 2 secondi.
- [ ] Timestamp monotoni e audio/video sincronizzati.
- [ ] Nessun errore RTMP/RTMPS o buffer crescente.
- [ ] Un solo stream e un solo FFmpeg per Machine.
- [ ] Cleanup completo dopo stop ed errore.
- [ ] Riduzione CPU ripetibile rispetto alla baseline.
- [ ] Qualità Vimeo accettabile per almeno 10 minuti di test.

