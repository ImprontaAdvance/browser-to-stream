type RecordingSetup = {
  streamId: string;
  stream: MediaStream;
  stop: () => Promise<void> | void;
};

type WebCodecsStartResult = {
  streamId: string;
  encoder: 'webcodecs';
  videoCodec: string;
  audioCodec: string;
};

const recordings = new Map<string, RecordingSetup>();
const AUDIO_BITRATE = 192000;
const OPUS_SAMPLE_RATE = 48000;
const OPUS_FRAME_DURATION_MICROSECONDS = 20_000;
const SILENCE_FALLBACK_DELAY_MICROSECONDS = 100_000;
const VIDEO_BITRATE = 8000000;
const VIDEO_FRAME_RATE = 25;
const VIDEO_FRAME_INTERVAL_MICROSECONDS = 1_000_000 / VIDEO_FRAME_RATE;
const KEYFRAME_INTERVAL_MICROSECONDS = 2_000_000;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function startStreaming({
  wsPort = 8080,
  recordingResizeFactor = 1,
  encoder = 'media-recorder',
}: StartStreamingOptions = {}) {
  // @ts-expect-error getMediaStreamId returns a promise
  const streamId: string = await chrome.tabCapture.getMediaStreamId();

  const [tab] = await chrome.tabs.query({active: true});
  const [currentWindow] = await chrome.scripting.executeScript({
    // @ts-expect-error tab id is not undefined
    target: {tabId: tab.id},
    func: () => ({width: window.innerWidth, height: window.innerHeight}),
  });

  const streamWidth =
    (currentWindow.result?.width || 1920) * recordingResizeFactor;
  const streamHeight =
    (currentWindow.result?.height || 1080) * recordingResizeFactor;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // @ts-expect-error mandatory field is not standard
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: {
      // @ts-expect-error mandatory field is not standard
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        minWidth: streamWidth,
        minHeight: streamHeight,
        maxWidth: streamWidth,
        maxHeight: streamHeight,
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 2000));

  if (encoder === 'webcodecs') {
    return startWebCodecsStreaming({
      stream,
      streamId,
      wsPort,
      width: streamWidth,
      height: streamHeight,
    });
  }

  return startMediaRecorderStreaming({stream, streamId, wsPort});
}

function startMediaRecorderStreaming({
  stream,
  streamId,
  wsPort,
}: {
  stream: MediaStream;
  streamId: string;
  wsPort: number;
}) {
  const recorder = new MediaRecorder(stream, {
    audioBitsPerSecond: AUDIO_BITRATE,
    videoBitsPerSecond: VIDEO_BITRATE,
  });
  recorder.start(1500);

  const settings = getRecorderSettings();
  const wsUrl = new URL(`ws://localhost:${wsPort || 8080}`);
  wsUrl.searchParams.set('video', settings.video);
  wsUrl.searchParams.set('audio', settings.audio);
  wsUrl.searchParams.set('streamId', streamId);

  const ws = new WebSocket(wsUrl);

  recorder.addEventListener('dataavailable', (event) => {
    if (event.data) {
      ws.send(event.data);
    }
  });

  recorder.addEventListener('stop', () => {
    ws.close();
  });

  recordings.set(streamId, {
    streamId,
    stream,
    stop: () => {
      stream.getTracks().forEach((track) => track.stop());
      recorder.stop();
    },
  });

  return {
    streamId,
    encoder: 'media-recorder' as const,
  };
}

async function startWebCodecsStreaming({
  stream,
  streamId,
  wsPort,
  width,
  height,
}: {
  stream: MediaStream;
  streamId: string;
  wsPort: number;
  width: number;
  height: number;
}): Promise<WebCodecsStartResult> {
  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0];
  if (!videoTrack || !audioTrack) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('WebCodecs requires one video track and one audio track');
  }

  const videoConfig: VideoEncoderConfig = {
    codec: 'avc1.42E028',
    width,
    height,
    bitrate: VIDEO_BITRATE,
    framerate: VIDEO_FRAME_RATE,
    latencyMode: 'realtime',
    avc: {format: 'avc'},
  };
  const audioReader = new MediaStreamTrackProcessor<AudioData>({
    track: audioTrack,
  }).readable.getReader();
  const {done: audioTrackEnded, value: firstAudioData} =
    await audioReader.read();
  if (audioTrackEnded) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error(
      'The tab audio track ended before WebCodecs could encode it'
    );
  }
  const audioChannels = firstAudioData.numberOfChannels;
  const audioClock = new AudioClock(firstAudioData.timestamp);

  const audioConfig: AudioEncoderConfig = {
    codec: 'opus',
    sampleRate: OPUS_SAMPLE_RATE,
    numberOfChannels: audioChannels,
    bitrate: AUDIO_BITRATE,
    opus: {format: 'opus', frameDuration: OPUS_FRAME_DURATION_MICROSECONDS},
  };
  const [videoSupport, audioSupport] = await Promise.all([
    VideoEncoder.isConfigSupported(videoConfig),
    AudioEncoder.isConfigSupported(audioConfig),
  ]);

  const supportedVideoConfig = videoSupport.config;
  const supportedAudioConfig = audioSupport.config;
  if (
    !videoSupport.supported ||
    !audioSupport.supported ||
    !supportedVideoConfig ||
    !supportedAudioConfig
  ) {
    firstAudioData.close();
    await audioReader.cancel().catch(() => undefined);
    stream.getTracks().forEach((track) => track.stop());
    throw new Error(
      'WebCodecs support probe failed: ' +
        `H.264=${videoSupport.supported === true}, ` +
        `Opus=${audioSupport.supported === true}`
    );
  }

  const muxedSocket = await openMuxedSocket({wsPort, streamId});
  const muxer = new MatroskaMuxer(muxedSocket, {
    width,
    height,
    audioConfig: supportedAudioConfig,
    timelineOrigin: audioClock.origin,
  });
  const audioResampler = new AudioResampler(OPUS_SAMPLE_RATE);

  let stopping = false;
  let latestVideoFrame: VideoFrame | undefined;
  const videoEncoder = new VideoEncoder({
    output: (chunk, metadata) =>
      muxer.addVideoChunk(
        chunk,
        metadata?.decoderConfig?.description
          ? copyBufferSource(metadata.decoderConfig.description)
          : undefined
      ),
    error: (error) =>
      console.error('[WebCodecs] video encoder error', error.message),
  });
  const audioEncoder = new AudioEncoder({
    output: (chunk, metadata) =>
      muxer.addAudioChunk(
        chunk,
        metadata?.decoderConfig?.description
          ? copyBufferSource(metadata.decoderConfig.description)
          : undefined
      ),
    error: (error) =>
      console.error('[WebCodecs] audio encoder error', error.message),
  });

  videoEncoder.configure(supportedVideoConfig);
  audioEncoder.configure(supportedAudioConfig);

  const videoReader = new MediaStreamTrackProcessor<VideoFrame>({
    track: videoTrack,
  }).readable.getReader();

  encodeAudioData(firstAudioData, audioEncoder, audioResampler, audioClock);

  const videoFramePump = retainLatestVideoFrame(
    videoReader,
    () => stopping,
    (frame) => {
      latestVideoFrame?.close();
      latestVideoFrame = frame;
    }
  ).catch((error) =>
    console.error('[WebCodecs] video capture error', getErrorMessage(error))
  );
  const fixedVideoPump = pumpFixedVideoFrames({
    encoder: videoEncoder,
    width,
    height,
    audioClock,
    isStopping: () => stopping,
    getLatestFrame: () => latestVideoFrame,
  }).catch((error) =>
    console.error('[WebCodecs] video encoder error', getErrorMessage(error))
  );
  const audioFramePump = pumpAudioFrames(
    audioReader,
    audioEncoder,
    audioClock,
    audioResampler,
    () => stopping
  ).catch((error) =>
    console.error('[WebCodecs] audio capture error', getErrorMessage(error))
  );
  const silentAudioPump = pumpSilentAudioFrames({
    encoder: audioEncoder,
    audioClock,
    numberOfChannels: audioChannels,
    isStopping: () => stopping,
  }).catch((error) =>
    console.error('[WebCodecs] silent audio error', getErrorMessage(error))
  );

  recordings.set(streamId, {
    streamId,
    stream,
    stop: async () => {
      if (stopping) {
        return;
      }
      stopping = true;
      stream.getTracks().forEach((track) => track.stop());
      await Promise.all([
        videoReader.cancel().catch(() => undefined),
        audioReader.cancel().catch(() => undefined),
        videoFramePump,
        fixedVideoPump,
        audioFramePump,
        silentAudioPump,
      ]);
      latestVideoFrame?.close();
      await Promise.all([
        videoEncoder.flush().catch(() => undefined),
        audioEncoder.flush().catch(() => undefined),
      ]);
      if (videoEncoder.state !== 'closed') {
        videoEncoder.close();
      }
      if (audioEncoder.state !== 'closed') {
        audioEncoder.close();
      }
      muxer.flush();
      muxedSocket.close();
    },
  });

  return {
    streamId,
    encoder: 'webcodecs',
    videoCodec: supportedVideoConfig.codec,
    audioCodec: supportedAudioConfig.codec,
  };
}

async function retainLatestVideoFrame(
  reader: ReadableStreamDefaultReader<VideoFrame>,
  isStopping: () => boolean,
  onFrame: (frame: VideoFrame) => void
) {
  while (!isStopping()) {
    const {done, value: frame} = await reader.read();
    if (done) {
      return;
    }

    if (isStopping()) {
      frame.close();
      return;
    }

    onFrame(frame);
  }
}

async function pumpFixedVideoFrames({
  encoder,
  width,
  height,
  audioClock,
  isStopping,
  getLatestFrame,
}: {
  encoder: VideoEncoder;
  width: number;
  height: number;
  audioClock: AudioClock;
  isStopping: () => boolean;
  getLatestFrame: () => VideoFrame | undefined;
}) {
  const fallbackCanvas = new OffscreenCanvas(width, height);
  const fallbackContext = fallbackCanvas.getContext('2d');
  if (!fallbackContext) {
    throw new Error('Cannot create the fixed-rate video fallback frame');
  }
  fallbackContext.fillStyle = 'black';
  fallbackContext.fillRect(0, 0, width, height);

  let lastFrameIndex = -1;
  let lastKeyframeTimestamp = Number.NEGATIVE_INFINITY;

  while (!isStopping()) {
    const frameIndex = audioClock.getFrameIndex();
    if (frameIndex <= lastFrameIndex) {
      await waitFor(audioClock.millisecondsUntilNextFrame(lastFrameIndex));
      continue;
    }

    lastFrameIndex = frameIndex;
    if (isStopping()) {
      return;
    }

    if (encoder.encodeQueueSize > 2) {
      continue;
    }

    const timestamp = audioClock.timestampForFrame(frameIndex);

    const keyFrame =
      timestamp - lastKeyframeTimestamp >= KEYFRAME_INTERVAL_MICROSECONDS;
    if (keyFrame) {
      lastKeyframeTimestamp = timestamp;
    }

    const frame = new VideoFrame(getLatestFrame() || fallbackCanvas, {
      timestamp,
      duration: VIDEO_FRAME_INTERVAL_MICROSECONDS,
    });
    try {
      encoder.encode(frame, {keyFrame});
      audioClock.reportVideoTimestamp(timestamp);
    } finally {
      frame.close();
    }
  }
}

function waitFor(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function pumpAudioFrames(
  reader: ReadableStreamDefaultReader<AudioData>,
  encoder: AudioEncoder,
  audioClock: AudioClock,
  audioResampler: AudioResampler,
  isStopping: () => boolean
) {
  while (!isStopping()) {
    const {done, value: audioData} = await reader.read();
    if (done) {
      console.warn(
        '[WebCodecs] audio track ended; generating silence to keep the video timeline active'
      );
      return;
    }

    encodeAudioData(audioData, encoder, audioResampler, audioClock);
  }
}

function encodeAudioData(
  audioData: AudioData,
  encoder: AudioEncoder,
  audioResampler: AudioResampler,
  audioClock: AudioClock
) {
  const resampled = audioResampler.resample(audioData);
  const timestamp = audioClock.reserveCapturedAudio(
    resampled.timestamp,
    getAudioDataDuration(resampled)
  );
  const timestamped =
    timestamp === resampled.timestamp
      ? resampled
      : copyAudioDataWithTimestamp(resampled, timestamp);
  try {
    encoder.encode(timestamped);
  } finally {
    if (timestamped !== resampled) {
      timestamped.close();
    }
    if (resampled !== audioData) {
      resampled.close();
    }
    audioData.close();
  }
}

async function pumpSilentAudioFrames({
  encoder,
  audioClock,
  numberOfChannels,
  isStopping,
}: {
  encoder: AudioEncoder;
  audioClock: AudioClock;
  numberOfChannels: number;
  isStopping: () => boolean;
}) {
  while (!isStopping()) {
    if (!audioClock.needsSyntheticAudio()) {
      await waitFor(OPUS_FRAME_DURATION_MICROSECONDS / 1_000);
      continue;
    }

    const targetTimestamp = audioClock.currentTimestamp();
    while (
      !isStopping() &&
      audioClock.scheduledAudioEndTimestamp < targetTimestamp
    ) {
      const timestamp = audioClock.reserveSilence(
        OPUS_FRAME_DURATION_MICROSECONDS
      );
      const silence = new AudioData({
        format: 'f32-planar',
        sampleRate: OPUS_SAMPLE_RATE,
        numberOfFrames:
          (OPUS_FRAME_DURATION_MICROSECONDS * OPUS_SAMPLE_RATE) / 1_000_000,
        numberOfChannels,
        timestamp,
        data: new Float32Array(
          ((OPUS_FRAME_DURATION_MICROSECONDS * OPUS_SAMPLE_RATE) / 1_000_000) *
            numberOfChannels
        ),
      });
      try {
        encoder.encode(silence);
      } finally {
        silence.close();
      }
    }
    await waitFor(OPUS_FRAME_DURATION_MICROSECONDS / 1_000);
  }
}

function getAudioDataDuration(audioData: AudioData) {
  return (
    audioData.duration ||
    (audioData.numberOfFrames * 1_000_000) / audioData.sampleRate
  );
}

function copyAudioDataWithTimestamp(audioData: AudioData, timestamp: number) {
  const data = new Float32Array(
    audioData.numberOfFrames * audioData.numberOfChannels
  );
  for (let channel = 0; channel < audioData.numberOfChannels; channel += 1) {
    const plane = new Float32Array(audioData.numberOfFrames);
    audioData.copyTo(plane, {planeIndex: channel, format: 'f32-planar'});
    data.set(plane, channel * audioData.numberOfFrames);
  }

  return new AudioData({
    format: 'f32-planar',
    sampleRate: audioData.sampleRate,
    numberOfFrames: audioData.numberOfFrames,
    numberOfChannels: audioData.numberOfChannels,
    timestamp,
    data,
  });
}

class AudioClock {
  readonly origin: number;
  private nextAudioTimestamp: number;
  private clockAnchorTimestamp: number;
  private clockAnchorObservationTime: number;
  private lastCapturedAudioObservationTime: number;
  private sourceTimestampOffset = 0;
  private lastReportedVideoTimestamp: number;
  private reportedSyntheticAudio = false;

  constructor(origin: number) {
    this.origin = origin;
    this.nextAudioTimestamp = origin;
    this.clockAnchorTimestamp = origin;
    this.clockAnchorObservationTime = performance.now();
    this.lastCapturedAudioObservationTime = performance.now();
    this.lastReportedVideoTimestamp = this.origin;
  }

  get scheduledAudioEndTimestamp() {
    return this.nextAudioTimestamp;
  }

  reserveCapturedAudio(sourceTimestamp: number, duration: number) {
    const mappedSourceTimestamp = sourceTimestamp + this.sourceTimestampOffset;
    this.sourceTimestampOffset +=
      this.nextAudioTimestamp - mappedSourceTimestamp;
    const timestamp = sourceTimestamp + this.sourceTimestampOffset;
    const endTimestamp = timestamp + duration;

    this.nextAudioTimestamp = endTimestamp;
    this.clockAnchorTimestamp = endTimestamp;
    this.clockAnchorObservationTime = performance.now();
    this.lastCapturedAudioObservationTime = performance.now();
    this.reportedSyntheticAudio = false;
    return timestamp;
  }

  reserveSilence(duration: number) {
    const timestamp = this.nextAudioTimestamp;
    this.nextAudioTimestamp += duration;
    return timestamp;
  }

  needsSyntheticAudio() {
    const needsSyntheticAudio =
      performance.now() - this.lastCapturedAudioObservationTime >=
      SILENCE_FALLBACK_DELAY_MICROSECONDS / 1_000;
    if (needsSyntheticAudio && !this.reportedSyntheticAudio) {
      console.warn(
        '[WebCodecs] audio capture paused; generating Opus silence to keep the A/V timeline continuous'
      );
      this.reportedSyntheticAudio = true;
    }
    return needsSyntheticAudio;
  }

  getFrameIndex() {
    return Math.floor(
      Math.max(0, this.currentTimestamp() - this.origin) /
        VIDEO_FRAME_INTERVAL_MICROSECONDS
    );
  }

  timestampForFrame(frameIndex: number) {
    return this.origin + frameIndex * VIDEO_FRAME_INTERVAL_MICROSECONDS;
  }

  millisecondsUntilNextFrame(lastFrameIndex: number) {
    const nextTimestamp = this.timestampForFrame(lastFrameIndex + 1);
    return Math.max(1, (nextTimestamp - this.currentTimestamp()) / 1_000);
  }

  reportVideoTimestamp(timestamp: number) {
    if (
      timestamp - this.lastReportedVideoTimestamp <
      VIDEO_FRAME_RATE * 60 * VIDEO_FRAME_INTERVAL_MICROSECONDS
    ) {
      return;
    }

    const offset = timestamp - this.currentTimestamp();
    console.info(
      `[WebCodecs] audio-master A/V scheduling offset: ${Math.round(offset / 1_000)} ms`
    );
    this.lastReportedVideoTimestamp = timestamp;
  }

  currentTimestamp() {
    return (
      this.clockAnchorTimestamp +
      Math.max(0, performance.now() - this.clockAnchorObservationTime) * 1_000
    );
  }
}

class AudioResampler {
  private fractionalOutputFrames = 0;

  constructor(private readonly targetSampleRate: number) {}

  resample(audioData: AudioData) {
    if (audioData.sampleRate === this.targetSampleRate) {
      return audioData;
    }

    const inputFrames = audioData.numberOfFrames;
    const exactOutputFrames =
      (inputFrames * this.targetSampleRate) / audioData.sampleRate +
      this.fractionalOutputFrames;
    const outputFrames = Math.max(1, Math.floor(exactOutputFrames));
    this.fractionalOutputFrames = exactOutputFrames - outputFrames;
    const output = new Float32Array(outputFrames * audioData.numberOfChannels);

    for (let channel = 0; channel < audioData.numberOfChannels; channel += 1) {
      const input = new Float32Array(inputFrames);
      audioData.copyTo(input, {planeIndex: channel, format: 'f32-planar'});

      for (let frame = 0; frame < outputFrames; frame += 1) {
        const position = (frame * audioData.sampleRate) / this.targetSampleRate;
        const before = Math.min(inputFrames - 1, Math.floor(position));
        const after = Math.min(inputFrames - 1, before + 1);
        const fraction = position - before;
        output[channel * outputFrames + frame] =
          input[before] * (1 - fraction) + input[after] * fraction;
      }
    }

    return new AudioData({
      format: 'f32-planar',
      sampleRate: this.targetSampleRate,
      numberOfFrames: outputFrames,
      numberOfChannels: audioData.numberOfChannels,
      timestamp: audioData.timestamp,
      data: output,
    });
  }
}

async function openMuxedSocket({
  wsPort,
  streamId,
}: {
  wsPort: number;
  streamId: string;
}): Promise<WebSocket> {
  const wsUrl = new URL(`ws://localhost:${wsPort || 8080}`);
  wsUrl.searchParams.set('encoder', 'webcodecs');
  wsUrl.searchParams.set('track', 'muxed');
  wsUrl.searchParams.set('video', 'h264');
  wsUrl.searchParams.set('audio', 'opus');
  wsUrl.searchParams.set('container', 'matroska');
  wsUrl.searchParams.set('streamId', streamId);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => resolve(ws), {once: true});
    ws.addEventListener(
      'error',
      () => reject(new Error('Cannot open WebCodecs muxed WebSocket')),
      {once: true}
    );
  });
}

const MPEG_TS_PACKET_SIZE = 188;
const MPEG_TS_PMT_PID = 0x100;
const MPEG_TS_VIDEO_PID = 0x101;
const MPEG_TS_AUDIO_PID = 0x102;
const MPEG_TS_TABLE_INTERVAL_MICROSECONDS = 500_000;
const MPEG_TS_TIMESTAMP_MODULO = 2 ** 33;

type MatroskaChunk = {
  trackNumber: 1 | 2;
  timestamp: number;
  keyFrame: boolean;
  data: Uint8Array;
};

class MatroskaMuxer {
  private readonly pending: MatroskaChunk[] = [];
  private audioCodecPrivate: Uint8Array;
  private videoCodecPrivate: Uint8Array | undefined;
  private headerWritten = false;
  private latestTimestamp = Number.NEGATIVE_INFINITY;
  private lastWrittenTimestamp = Number.NEGATIVE_INFINITY;
  private clusterTimestamp: number | undefined;

  constructor(
    private readonly socket: WebSocket,
    private readonly options: {
      width: number;
      height: number;
      audioConfig: AudioEncoderConfig;
      timelineOrigin: number;
    }
  ) {
    this.audioCodecPrivate = createOpusHead(options.audioConfig);
  }

  addVideoChunk(chunk: EncodedVideoChunk, decoderConfig?: Uint8Array) {
    if (decoderConfig) {
      this.videoCodecPrivate = decoderConfig;
    }
    this.enqueue({
      trackNumber: 1,
      timestamp: chunk.timestamp,
      keyFrame: chunk.type === 'key',
      data: copyEncodedChunk(chunk),
    });
  }

  addAudioChunk(chunk: EncodedAudioChunk, decoderConfig?: Uint8Array) {
    if (decoderConfig) {
      this.audioCodecPrivate = decoderConfig;
    }
    this.enqueue({
      trackNumber: 2,
      timestamp: chunk.timestamp,
      keyFrame: false,
      data: copyEncodedChunk(chunk),
    });
  }

  flush() {
    if (!this.writeHeader()) {
      return;
    }
    this.flushPending(true);
  }

  private enqueue(chunk: MatroskaChunk) {
    const timestamp = Math.max(
      0,
      Math.round(chunk.timestamp - this.options.timelineOrigin)
    );
    this.pending.push({...chunk, timestamp});
    this.latestTimestamp = Math.max(this.latestTimestamp, timestamp);

    if (this.writeHeader()) {
      this.flushPending(false);
    }
  }

  private writeHeader() {
    if (this.headerWritten) {
      return true;
    }
    if (!this.videoCodecPrivate) {
      return false;
    }

    this.send(
      createMatroskaHeader({
        width: this.options.width,
        height: this.options.height,
        audioConfig: this.options.audioConfig,
        videoCodecPrivate: this.videoCodecPrivate,
        audioCodecPrivate: this.audioCodecPrivate,
      })
    );
    this.headerWritten = true;
    return true;
  }

  private flushPending(force: boolean) {
    const threshold = force
      ? Number.POSITIVE_INFINITY
      : this.latestTimestamp - 1_000_000;

    this.pending.sort(
      (left, right) =>
        left.timestamp - right.timestamp || left.trackNumber - right.trackNumber
    );
    while (this.pending[0] && this.pending[0].timestamp <= threshold) {
      const chunk = this.pending.shift();
      if (!chunk) {
        return;
      }
      this.writeChunk(chunk);
    }
  }

  private writeChunk(chunk: MatroskaChunk) {
    const timestamp = Math.max(chunk.timestamp, this.lastWrittenTimestamp);
    const timestampMilliseconds = Math.round(timestamp / 1000);
    if (
      this.clusterTimestamp === undefined ||
      timestampMilliseconds - this.clusterTimestamp >= 5_000
    ) {
      this.clusterTimestamp = timestampMilliseconds;
      this.send(createMatroskaClusterHeader(this.clusterTimestamp));
    }

    this.send(
      createMatroskaSimpleBlock({
        trackNumber: chunk.trackNumber,
        timestamp: timestampMilliseconds,
        clusterTimestamp: this.clusterTimestamp,
        keyFrame: chunk.keyFrame,
        data: chunk.data,
      })
    );
    this.lastWrittenTimestamp = timestamp;
  }

  private send(data: Uint8Array) {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(data);
    }
  }
}

function createMatroskaHeader({
  width,
  height,
  audioConfig,
  videoCodecPrivate,
  audioCodecPrivate,
}: {
  width: number;
  height: number;
  audioConfig: AudioEncoderConfig;
  videoCodecPrivate: Uint8Array;
  audioCodecPrivate: Uint8Array;
}) {
  const ebmlHeader = ebmlElement(
    [0x1a, 0x45, 0xdf, 0xa3],
    concatBytes(
      ebmlUnsignedElement([0x42, 0x86], 1),
      ebmlUnsignedElement([0x42, 0xf7], 1),
      ebmlUnsignedElement([0x42, 0xf2], 4),
      ebmlUnsignedElement([0x42, 0xf3], 8),
      ebmlStringElement([0x42, 0x82], 'matroska'),
      ebmlUnsignedElement([0x42, 0x87], 4),
      ebmlUnsignedElement([0x42, 0x85], 2)
    )
  );
  const info = ebmlElement(
    [0x15, 0x49, 0xa9, 0x66],
    concatBytes(
      ebmlUnsignedElement([0x2a, 0xd7, 0xb1], 1_000_000),
      ebmlStringElement([0x4d, 0x80], 'browser-to-stream'),
      ebmlStringElement([0x57, 0x41], 'browser-to-stream')
    )
  );
  const tracks = ebmlElement(
    [0x16, 0x54, 0xae, 0x6b],
    concatBytes(
      createMatroskaVideoTrack({width, height, videoCodecPrivate}),
      createMatroskaAudioTrack({audioConfig, audioCodecPrivate})
    )
  );

  return concatBytes(
    ebmlHeader,
    ebmlUnknownSizeElementHeader([0x18, 0x53, 0x80, 0x67]),
    info,
    tracks
  );
}

function createMatroskaVideoTrack({
  width,
  height,
  videoCodecPrivate,
}: {
  width: number;
  height: number;
  videoCodecPrivate: Uint8Array;
}) {
  return ebmlElement(
    [0xae],
    concatBytes(
      ebmlUnsignedElement([0xd7], 1),
      ebmlUnsignedElement([0x73, 0xc5], 1),
      ebmlUnsignedElement([0x83], 1),
      ebmlStringElement([0x86], 'V_MPEG4/ISO/AVC'),
      ebmlElement([0x63, 0xa2], videoCodecPrivate),
      ebmlUnsignedElement([0x23, 0xe3, 0x83], 40_000_000),
      ebmlElement(
        [0xe0],
        concatBytes(
          ebmlUnsignedElement([0xb0], width),
          ebmlUnsignedElement([0xba], height)
        )
      )
    )
  );
}

function createMatroskaAudioTrack({
  audioConfig,
  audioCodecPrivate,
}: {
  audioConfig: AudioEncoderConfig;
  audioCodecPrivate: Uint8Array;
}) {
  const sampleRate = audioConfig.sampleRate;
  const channels = audioConfig.numberOfChannels;
  if (!sampleRate || !channels) {
    throw new Error('Opus configuration is missing sample rate or channels');
  }

  return ebmlElement(
    [0xae],
    concatBytes(
      ebmlUnsignedElement([0xd7], 2),
      ebmlUnsignedElement([0x73, 0xc5], 2),
      ebmlUnsignedElement([0x83], 2),
      ebmlStringElement([0x86], 'A_OPUS'),
      ebmlElement([0x63, 0xa2], audioCodecPrivate),
      ebmlElement(
        [0xe1],
        concatBytes(
          ebmlFloatElement([0xb5], sampleRate),
          ebmlUnsignedElement([0x9f], channels),
          ebmlUnsignedElement([0x62, 0x64], 16)
        )
      )
    )
  );
}

function createMatroskaClusterHeader(timestamp: number) {
  return concatBytes(
    ebmlUnknownSizeElementHeader([0x1f, 0x43, 0xb6, 0x75]),
    ebmlUnsignedElement([0xe7], timestamp)
  );
}

function createMatroskaSimpleBlock({
  trackNumber,
  timestamp,
  clusterTimestamp,
  keyFrame,
  data,
}: {
  trackNumber: 1 | 2;
  timestamp: number;
  clusterTimestamp: number;
  keyFrame: boolean;
  data: Uint8Array;
}) {
  const relativeTimestamp = timestamp - clusterTimestamp;
  if (relativeTimestamp < -32_768 || relativeTimestamp > 32_767) {
    throw new Error('Matroska cluster timestamp range exceeded');
  }

  const block = new Uint8Array(data.byteLength + 4);
  block[0] = 0x80 | trackNumber;
  block[1] = (relativeTimestamp >> 8) & 0xff;
  block[2] = relativeTimestamp & 0xff;
  block[3] = keyFrame ? 0x80 : 0;
  block.set(data, 4);
  return ebmlElement([0xa3], block);
}

function createOpusHead(config: AudioEncoderConfig) {
  const sampleRate = config.sampleRate;
  const channels = config.numberOfChannels;
  if (!sampleRate || !channels) {
    throw new Error('Opus configuration is missing sample rate or channels');
  }

  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode('OpusHead'));
  head[8] = 1;
  head[9] = channels;
  new DataView(head.buffer).setUint32(12, sampleRate, true);
  return head;
}

function ebmlElement(id: number[], data: Uint8Array) {
  return concatBytes(new Uint8Array(id), ebmlSize(data.byteLength), data);
}

function ebmlUnknownSizeElementHeader(id: number[]) {
  return concatBytes(
    new Uint8Array(id),
    new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
  );
}

function ebmlUnsignedElement(id: number[], value: number) {
  return ebmlElement(id, ebmlUnsignedInteger(value));
}

function ebmlStringElement(id: number[], value: string) {
  return ebmlElement(id, new TextEncoder().encode(value));
}

function ebmlFloatElement(id: number[], value: number) {
  const data = new Uint8Array(8);
  new DataView(data.buffer).setFloat64(0, value, false);
  return ebmlElement(id, data);
}

function ebmlUnsignedInteger(value: number) {
  if (value === 0) {
    return new Uint8Array([0]);
  }

  const bytes: number[] = [];
  let remaining = Math.floor(value);
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return new Uint8Array(bytes);
}

function ebmlSize(value: number) {
  for (let width = 1; width <= 8; width += 1) {
    const maxValue = 2 ** (7 * width) - 2;
    if (value <= maxValue) {
      const bytes = new Uint8Array(width);
      let remaining = value;
      for (let index = width - 1; index >= 0; index -= 1) {
        bytes[index] = remaining & 0xff;
        remaining = Math.floor(remaining / 256);
      }
      bytes[0] |= 1 << (8 - width);
      return bytes;
    }
  }
  throw new Error('Matroska element is too large');
}

function concatBytes(...parts: Uint8Array[]) {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function copyBufferSource(source: AllowSharedBufferSource) {
  const copy = new Uint8Array(source.byteLength);
  copy.set(new Uint8Array(source as ArrayBuffer));
  return copy;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
class MpegTsMuxer {
  private readonly continuityCounters = new Map<number, number>();
  private hasWrittenTables = false;
  private lastTableTimestamp = Number.NEGATIVE_INFINITY;
  private videoTimestampOrigin: number | undefined;
  private audioTimestampOrigin: number | undefined;

  constructor(
    private readonly socket: WebSocket,
    private readonly audioConfig: AudioEncoderConfig
  ) {}

  addVideoChunk(chunk: EncodedVideoChunk) {
    const timestamp = this.normalizeTimestamp('video', chunk.timestamp);
    this.writeTables(timestamp);
    this.writePes({
      pid: MPEG_TS_VIDEO_PID,
      streamId: 0xe0,
      timestamp,
      data: copyEncodedChunk(chunk),
      isVideo: true,
    });
  }

  addAudioChunk(chunk: EncodedAudioChunk) {
    const timestamp = this.normalizeTimestamp('audio', chunk.timestamp);
    this.writeTables(timestamp);
    this.writePes({
      pid: MPEG_TS_AUDIO_PID,
      streamId: 0xc0,
      timestamp,
      data: createAdtsFrame(chunk, this.audioConfig),
      isVideo: false,
    });
  }

  private normalizeTimestamp(track: 'audio' | 'video', timestamp: number) {
    if (track === 'video') {
      this.videoTimestampOrigin ??= timestamp;
      return Math.max(0, timestamp - this.videoTimestampOrigin);
    }

    this.audioTimestampOrigin ??= timestamp;
    return Math.max(0, timestamp - this.audioTimestampOrigin);
  }

  private writeTables(timestamp: number) {
    if (
      this.hasWrittenTables &&
      timestamp - this.lastTableTimestamp < MPEG_TS_TABLE_INTERVAL_MICROSECONDS
    ) {
      return;
    }

    this.writeTransportStreamPackets(
      0,
      withPointerField(createPatSection()),
      true
    );
    this.writeTransportStreamPackets(
      MPEG_TS_PMT_PID,
      withPointerField(createPmtSection()),
      true
    );
    this.hasWrittenTables = true;
    this.lastTableTimestamp = timestamp;
  }

  private writePes({
    pid,
    streamId,
    timestamp,
    data,
    isVideo,
  }: {
    pid: number;
    streamId: number;
    timestamp: number;
    data: Uint8Array;
    isVideo: boolean;
  }) {
    const pesHeader = createPesHeader({
      streamId,
      timestamp,
      payloadLength: data.byteLength,
      isVideo,
    });
    const pes = new Uint8Array(pesHeader.byteLength + data.byteLength);
    pes.set(pesHeader);
    pes.set(data, pesHeader.byteLength);
    this.writeTransportStreamPackets(pid, pes, true);
  }

  private writeTransportStreamPackets(
    pid: number,
    payload: Uint8Array,
    payloadUnitStart: boolean
  ) {
    let offset = 0;
    let isFirstPacket = true;
    const packets: Uint8Array[] = [];

    while (offset < payload.byteLength) {
      const remaining = payload.byteLength - offset;
      const payloadLength = Math.min(184, remaining);
      const packet = new Uint8Array(MPEG_TS_PACKET_SIZE);
      packet[0] = 0x47;
      packet[1] =
        (isFirstPacket && payloadUnitStart ? 0x40 : 0) | ((pid >> 8) & 0x1f);
      packet[2] = pid & 0xff;

      const continuityCounter = this.continuityCounters.get(pid) || 0;
      this.continuityCounters.set(pid, (continuityCounter + 1) & 0x0f);

      let payloadOffset = 4;
      if (payloadLength === 184) {
        packet[3] = 0x10 | continuityCounter;
      } else {
        const adaptationFieldLength = 183 - payloadLength;
        packet[3] = 0x30 | continuityCounter;
        packet[4] = adaptationFieldLength;
        if (adaptationFieldLength > 0) {
          packet[5] = 0;
          packet.fill(0xff, 6, 5 + adaptationFieldLength);
        }
        payloadOffset += adaptationFieldLength + 1;
      }

      packet.set(
        payload.subarray(offset, offset + payloadLength),
        payloadOffset
      );
      packets.push(packet);
      offset += payloadLength;
      isFirstPacket = false;
    }

    const muxedPackets = new Uint8Array(packets.length * MPEG_TS_PACKET_SIZE);
    packets.forEach((packet, index) => {
      muxedPackets.set(packet, index * MPEG_TS_PACKET_SIZE);
    });
    this.send(muxedPackets);
  }

  private send(data: Uint8Array) {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(data);
    }
  }
}

function withPointerField(section: Uint8Array) {
  const payload = new Uint8Array(section.byteLength + 1);
  payload.set(section, 1);
  return payload;
}

function createPatSection() {
  const section = new Uint8Array(16);
  section.set([
    0x00,
    0xb0,
    0x0d,
    0x00,
    0x01,
    0xc1,
    0x00,
    0x00,
    0x00,
    0x01,
    0xe0 | ((MPEG_TS_PMT_PID >> 8) & 0x1f),
    MPEG_TS_PMT_PID & 0xff,
  ]);
  writeMpegTsCrc(section, 12);
  return section;
}

function createPmtSection() {
  const section = new Uint8Array(26);
  section.set([
    0x02,
    0xb0,
    0x17,
    0x00,
    0x01,
    0xc1,
    0x00,
    0x00,
    0xe0 | ((MPEG_TS_VIDEO_PID >> 8) & 0x1f),
    MPEG_TS_VIDEO_PID & 0xff,
    0xf0,
    0x00,
    0x1b,
    0xe0 | ((MPEG_TS_VIDEO_PID >> 8) & 0x1f),
    MPEG_TS_VIDEO_PID & 0xff,
    0xf0,
    0x00,
    0x0f,
    0xe0 | ((MPEG_TS_AUDIO_PID >> 8) & 0x1f),
    MPEG_TS_AUDIO_PID & 0xff,
    0xf0,
    0x00,
  ]);
  writeMpegTsCrc(section, 22);
  return section;
}

function writeMpegTsCrc(section: Uint8Array, offset: number) {
  const crc = mpegTsCrc32(section.subarray(0, offset));
  section[offset] = (crc >>> 24) & 0xff;
  section[offset + 1] = (crc >>> 16) & 0xff;
  section[offset + 2] = (crc >>> 8) & 0xff;
  section[offset + 3] = crc & 0xff;
}

function mpegTsCrc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    }
  }
  return crc >>> 0;
}

function createPesHeader({
  streamId,
  timestamp,
  payloadLength,
  isVideo,
}: {
  streamId: number;
  timestamp: number;
  payloadLength: number;
  isVideo: boolean;
}) {
  const header = new Uint8Array(14);
  const packetLength = isVideo ? 0 : payloadLength + 8;
  header.set([0x00, 0x00, 0x01, streamId]);
  header[4] = (packetLength >> 8) & 0xff;
  header[5] = packetLength & 0xff;
  header[6] = isVideo ? 0x84 : 0x80;
  header[7] = 0x80;
  header[8] = 0x05;
  header.set(createPts(timestamp), 9);
  return header;
}

function createPts(timestampMicroseconds: number) {
  const pts =
    Math.max(0, Math.round((timestampMicroseconds * 90) / 1000)) %
    MPEG_TS_TIMESTAMP_MODULO;
  return new Uint8Array([
    0x20 | (Math.floor(pts / 2 ** 30) << 1) | 1,
    Math.floor(pts / 2 ** 22) & 0xff,
    ((Math.floor(pts / 2 ** 15) & 0x7f) << 1) | 1,
    Math.floor(pts / 2 ** 7) & 0xff,
    ((Math.floor(pts) & 0x7f) << 1) | 1,
  ]);
}

function copyEncodedChunk(chunk: EncodedVideoChunk | EncodedAudioChunk) {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  return data;
}

function createAdtsFrame(chunk: EncodedAudioChunk, config: AudioEncoderConfig) {
  const payload = copyEncodedChunk(chunk);
  const frameLength = payload.byteLength + 7;
  const header = new Uint8Array(7);
  const audioObjectType = 2; // AAC-LC
  const sampleRateIndex = getAdtsSampleRateIndex(config.sampleRate);
  const channels = config.numberOfChannels;

  header[0] = 0xff;
  header[1] = 0xf1;
  header[2] =
    ((audioObjectType - 1) << 6) | (sampleRateIndex << 2) | (channels >> 2);
  header[3] = ((channels & 3) << 6) | ((frameLength >> 11) & 3);
  header[4] = (frameLength >> 3) & 0xff;
  header[5] = ((frameLength & 7) << 5) | 0x1f;
  header[6] = 0xfc;

  const frame = new Uint8Array(frameLength);
  frame.set(header);
  frame.set(payload, header.byteLength);
  return frame;
}

function getAdtsSampleRateIndex(sampleRate: number) {
  const sampleRates = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
    8000, 7350,
  ];
  const index = sampleRates.indexOf(sampleRate);
  if (index === -1) {
    throw new Error(`Cannot create ADTS headers for ${sampleRate} Hz AAC`);
  }
  return index;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function stopStreaming(streamId: string) {
  const recordingSetup = recordings.get(streamId);
  if (recordingSetup === undefined) {
    throw new Error(`Setup ${streamId} not found`);
  }

  await recordingSetup.stop();
  recordings.delete(streamId);
}

const getRecorderSettings = () => {
  if (MediaRecorder.isTypeSupported('video/mp4')) {
    return {
      format: 'mp4',
      video: 'h264',
      audio: 'aac',
    };
  } else {
    return {
      format: 'webm',
      audio: 'opus',
      video: MediaRecorder.isTypeSupported('video/webm;codecs=h264')
        ? 'h264'
        : 'vp8',
    };
  }
};
