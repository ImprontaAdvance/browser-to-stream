# Next step di testing RTMP

## Obiettivo

Determinare in modo ripetibile:

1. se Chrome nel container può produrre H.264/AAC tramite MediaRecorder;
2. se il video H.264 può essere pubblicato su Vimeo tramite stream copy;
3. quanto CPU viene realmente risparmiato eliminando la seconda codifica;
4. come garantire frame rate e keyframe compatibili con Vimeo;
5. se, eliminata la ricodifica, il consumo residuo è attribuibile a Chrome o alla pagina sorgente.

## Ipotesi da validare

- **H1 — formato browser:** Chrome supporta MP4/H.264/AAC, ma sceglie WebM/VP8/Opus perché il MIME type non viene specificato.
- **H2 — stream copy:** un flusso H.264/AAC prodotto da Chrome può essere rimuxato in FLV senza ricodifica.
- **H3 — CPU:** eliminando `libx264`, la CPU di FFmpeg diminuisce in modo sostanziale.
- **H4 — carico residuo:** se la CPU totale rimane alta con stream copy, il costo dominante è Chrome, MediaRecorder o la pagina.
- **H5 — cadenza:** l'attuale frame rate effettivo di circa 1 fps e il GOP a frame sono indipendenti dalla disponibilità di CPU.

## Varianti sperimentali

### Variante A — baseline

Configurazione attuale:

```text
MediaRecorder default
  -> WebM/VP8/Opus
  -> FFmpeg VP8 decode
  -> libx264 encode
  -> AAC encode
  -> FLV/RTMPS
```

Scopo:

- fissare CPU, memoria, frame rate, bitrate, GOP e latenza attuali;
- conservare le righe `Input #0`, `Stream mapping` e opzioni `libx264`;
- confermare che il comportamento sia riproducibile su almeno tre run.

### Variante B — H.264 esplicito, FFmpeg ancora in transcode

Configurazione candidata:

```text
MediaRecorder con MIME type H.264/AAC esplicito
  -> FFmpeg H.264 decode
  -> libx264 encode
  -> AAC encode o copy
  -> FLV/RTMPS
```

Scopo:

- verificare separatamente il supporto H.264/AAC del browser;
- controllare il MIME type effettivo;
- verificare che FFmpeg riceva MP4/H.264 anziché WebM/VP8;
- non attribuire ancora a questa variante il beneficio dello stream copy.

Ordine di selezione MIME type:

```text
video/mp4;codecs=avc1.4d401f,mp4a.40.2
video/mp4;codecs=avc1,mp4a.40.2
video/mp4
```

Criterio di superamento:

```text
Input #0: mov/mp4
Video: h264
Audio: aac, oppure un codec audio identificato e gestibile
```

### Variante C — stream copy completo

Prerequisito: la variante B produce H.264/AAC stabile.

Configurazione FFmpeg candidata:

```text
-map 0:v:0
-map 0:a?
-c:v copy
-c:a copy
-f flv
<rtmps-url>
```

Rimuovere dal percorso copy le opzioni che richiedono ricodifica video:

```text
-r
-g
-pix_fmt
-profile:v
-level
-preset
-tune
```

Criterio di superamento:

```text
Stream #0:video -> #0:video (copy)
Stream #0:audio -> #0:audio (copy)
```

### Variante C2 — video copy, audio AAC

Usare questa variante se Chrome WebCodecs produce H.264 con audio non
compatibile con FLV/Vimeo. L'implementazione del pacchetto produce un singolo
Matroska H.264/Opus e usa i timestamp dell'audio catturato come clock master
per i frame video fissi. Se la cattura audio non consegna frame per 100 ms,
genera pacchetti Opus silenziosi sulla medesima timeline: il video non attende
l'audio.

```text
WebCodecs H.264 + Opus
  -> Matroska muxed con timeline A/V unica
  -> FFmpeg video copy, Opus -> AAC
  -> FLV/RTMPS
```

```text
-c:v copy
-c:a aac
-b:a 192k
-ar 48000
-ac 2
-f flv
<rtmps-url>
```

Questa variante elimina comunque il costo dominante della ricodifica video.

## Protocollo di confronto

Per ciascuna variante:

1. usare una nuova Machine con la stessa configurazione `performance-8x`;
2. usare la stessa regione Fly;
3. usare lo stesso digest base dell'immagine, cambiando soltanto la variante;
4. usare la stessa pagina e una sequenza di contenuti ripetibile;
5. usare lo stesso evento Vimeo di staging;
6. attendere 30 secondi di warm-up;
7. misurare per almeno 5-10 minuti;
8. eseguire almeno tre run;
9. effettuare stop e verificare il cleanup;
10. confrontare mediana e p95, non soltanto un valore istantaneo.

Metriche obbligatorie:

- CPU FFmpeg;
- CPU aggregata Chrome;
- CPU Node.js;
- CPU totale Machine;
- RSS massimo;
- frame rate effettivo;
- bitrate medio e massimo;
- intervallo massimo tra keyframe;
- latenza `/api/start` -> primo input Vimeo;
- errori FFmpeg, RTMPS e Vimeo;
- qualità visiva e audio/video sync.

## Fase 0 — baseline ripetibile

- [ ] Ripetere la variante A tre volte.
- [ ] Verificare se il frame rate resta intorno a 1 fps.
- [ ] Verificare se il bitrate resta nell'ordine di poche decine di kbit/s.
- [ ] Raccogliere CPU per processo.
- [ ] Verificare che compaia un solo FFmpeg.
- [ ] Salvare i risultati nella scheda della checklist.

Decisione:

- Se FFmpeg consuma poca CPU già nella baseline, la doppia codifica è inefficiente ma non è la causa principale del problema osservato.
- Se FFmpeg domina la CPU, procedere con priorità allo stream copy.

## Fase 1 — capability probe MediaRecorder

- [ ] Valutare i MIME type candidati con `MediaRecorder.isTypeSupported()`.
- [ ] Creare realmente un recorder con il primo formato supportato.
- [ ] Registrare `recorder.mimeType` dopo `start`.
- [ ] Registrare `event.data.type` sul primo chunk.
- [ ] Controllare il formato rilevato da FFmpeg.
- [ ] Verificare eventuali errori `NotSupportedError` o `MediaRecorderErrorEvent`.

Decisione:

- Se l'ingresso diventa H.264/AAC, procedere alla variante C.
- Se diventa H.264/Opus, procedere alla variante C2.
- Se rimane VP8/Opus, MediaRecorder non consente di eliminare la transcodifica con la configurazione provata.

## Fase 2 — controllo frame rate

- [ ] Registrare il frame rate delle media track tramite `getSettings()`.
- [ ] Confrontare frame rate richiesto, dichiarato da FFmpeg ed effettivo.
- [ ] Verificare se la pagina produce frame soltanto quando cambia visivamente.
- [ ] Provare una scena di test con movimento continuo e una scena statica.
- [ ] Verificare se una constraint di frame rate modifica la cadenza effettiva.
- [ ] Evitare di attribuire a CPU un limite causato dall'assenza di nuovi frame.

Decisione:

- Se il frame rate sale con una scena animata, la sorgente è damage-driven e non CPU-limited.
- Se resta circa 1 fps anche con movimento continuo, indagare tab capture e constraint.

## Fase 3 — controllo GOP prima dello stream copy

- [ ] Richiedere al browser un keyframe interval nominale di 2 secondi, se supportato.
- [ ] Non usare contemporaneamente intervallo per durata e intervallo per numero di frame.
- [ ] Pubblicare su Vimeo staging.
- [ ] Analizzare i pacchetti del playback con `ffprobe`.
- [ ] Misurare la distanza tra tutti i pacchetti con flag `K`.
- [ ] Ripetere la misura sia su contenuto statico sia su contenuto animato.

Criterio di superamento:

- intervallo massimo tra keyframe circa 2 secondi;
- nessuna dipendenza da scene change per rispettare il limite;
- nessun errore o warning Vimeo relativo all'encoder.

Se MediaRecorder non riesce a garantire il GOP richiesto, lo stream copy non è ancora adottabile per la produzione.

## Fase 4 — prova stream copy

- [ ] Avviare la variante C o C2.
- [ ] Verificare `Stream mapping: copy` per il video.
- [ ] Verificare assenza di decoder VP8 e encoder `libx264`.
- [ ] Verificare assenza di `Non-monotonous DTS`.
- [ ] Verificare che Vimeo riceva bitrate e frame rate stabili.
- [ ] Verificare playback e audio/video sync per almeno 10 minuti.
- [ ] Eseguire almeno una prova continua di 60 minuti e confrontare il sync
      all'inizio, a metà e alla fine; conservare il log periodico
      `audio-master A/V scheduling offset`.
- [ ] Simulare stop normale.
- [ ] Simulare errore o interruzione RTMP.
- [ ] Verificare cleanup completo.

## Fase 5 — confronto CPU

Confrontare:

| Confronto | Domanda |
| --- | --- |
| A vs B | Cambiare codec browser modifica CPU Chrome o FFmpeg? |
| B vs C | Quanto costa esclusivamente la seconda codifica H.264? |
| A vs C | Quanto risparmia la pipeline finale rispetto alla produzione attuale? |
| C: Chrome vs totale | Il carico residuo è nella pagina/browser? |

Risultato atteso della variante C:

- CPU FFmpeg vicina al costo di mux e rete;
- nessun thread `libx264` attivo;
- CPU Chrome simile o inferiore alla baseline;
- CPU totale significativamente e ripetibilmente inferiore;
- qualità e stabilità Vimeo non peggiori della baseline.

## Fase 6 — bitrate

Modificare il bitrate soltanto dopo aver validato lo stream copy.

- [ ] Conservare inizialmente il target MediaRecorder di 8 Mbit/s per isolare la variabile codec.
- [ ] Misurare il bitrate realmente prodotto, non soltanto quello richiesto.
- [ ] Definire il target in base al piano Vimeo.
- [ ] Provare almeno due target coerenti con 720p.
- [ ] Controllare qualità su testo, movimento, gradienti e scene statiche.
- [ ] Controllare il pannello Stream Health Vimeo.

## Matrice decisionale finale

### H.264/AAC, GOP valido, copy stabile

- Adottare video e audio copy.
- Mantenere FFmpeg come demux/mux e client RTMPS.
- Conservare il fallback di transcodifica per ambienti non compatibili.

### H.264/Opus, GOP valido

- Adottare video copy.
- Ricodificare soltanto Opus in AAC.
- Misurare nuovamente CPU e sincronizzazione.

### H.264 disponibile ma GOP non valido

- Verificare il supporto effettivo di `videoKeyFrameIntervalDuration`.
- Valutare WebCodecs per controllare keyframe e bitrate.
- Non adottare stream copy fino alla compatibilità Vimeo.

### Solo VP8/Opus disponibile

- Mantenere la transcodifica H.264/AAC.
- Provare `ultrafast` rispetto a `veryfast`.
- Imporre il frame rate alla sorgente.
- Valutare WebCodecs come intervento architetturale.

### Stream copy valido ma CPU totale ancora alta

- Profilare i renderer Chrome e la pagina sorgente.
- Misurare animazioni, canvas, WebGL, video e layout continui.
- Confrontare pagina reale e pagina sintetica leggera.
- Trattare la pagina/browser come collo di bottiglia principale.

## Test separato del cold start

Il cold start di circa due minuti non deve essere incluso nei risultati di encoding.

- [ ] Misurare dimensione compressa dell'immagine Docker.
- [ ] Misurare tempo di pull.
- [ ] Misurare tempo Firecracker -> processo Node.
- [ ] Misurare tempo Node -> browser ready.
- [ ] Valutare pre-warming o mantenimento di una Machine pronta.
- [ ] Valutare la rimozione di browser e dipendenze duplicate dall'immagine.

## Sicurezza e rollback

- Usare esclusivamente eventi e stream key di staging.
- Non inserire credenziali in commit, report o nomi delle immagini.
- Redigere query string e URL RTMP/RTMPS nei log.
- Ruotare le stream key esposte accidentalmente.
- Conservare la variante A come rollback durante l'esperimento.
- Non promuovere la variante C finché GOP, frame rate, bitrate, cleanup e riconnessione non sono stati validati.

## Deliverable attesi

- una scheda compilata per ogni run;
- estratti FFmpeg redatti da `Input #0` a `Stream mapping`;
- grafico CPU per processo per A, B e C/C2;
- misurazione del GOP tramite `ffprobe`;
- screenshot o export dello Stream Health Vimeo;
- decisione finale supportata dalla matrice precedente;
- lista separata degli interventi di produzione e delle ottimizzazioni successive.
