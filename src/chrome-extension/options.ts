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

  const audioConfig: AudioEncoderConfig = {
    codec: 'mp4a.40.2',
    sampleRate: firstAudioData.sampleRate,
    numberOfChannels: firstAudioData.numberOfChannels,
    bitrate: AUDIO_BITRATE,
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
      'WebCodecs does not support H.264/AAC for this tab capture configuration'
    );
  }

  const muxedSocket = await openMuxedSocket({wsPort, streamId});
  const muxer = new FlvMuxer(muxedSocket, audioConfig);

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
    output: (chunk) => muxer.addAudioChunk(chunk),
    error: (error) =>
      console.error('[WebCodecs] audio encoder error', error.message),
  });

  videoEncoder.configure(supportedVideoConfig);
  audioEncoder.configure(supportedAudioConfig);

  const videoReader = new MediaStreamTrackProcessor<VideoFrame>({
    track: videoTrack,
  }).readable.getReader();

  try {
    audioEncoder.encode(firstAudioData);
  } finally {
    firstAudioData.close();
  }

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
    isStopping: () => stopping,
    getLatestFrame: () => latestVideoFrame,
  }).catch((error) =>
    console.error('[WebCodecs] video encoder error', getErrorMessage(error))
  );
  void pumpAudioFrames(audioReader, audioEncoder, () => stopping).catch(
    (error) =>
      console.error('[WebCodecs] audio capture error', getErrorMessage(error))
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
  isStopping,
  getLatestFrame,
}: {
  encoder: VideoEncoder;
  width: number;
  height: number;
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

  const startTime = performance.now();
  let frameIndex = 0;
  let lastKeyframeTimestamp = Number.NEGATIVE_INFINITY;

  while (!isStopping()) {
    const elapsed = performance.now() - startTime;
    frameIndex = Math.max(
      frameIndex,
      Math.floor((elapsed * 1000) / VIDEO_FRAME_INTERVAL_MICROSECONDS)
    );
    const timestamp = frameIndex * VIDEO_FRAME_INTERVAL_MICROSECONDS;
    const scheduledTime = startTime + timestamp / 1000;
    await waitFor(Math.max(0, scheduledTime - performance.now()));
    if (isStopping()) {
      return;
    }

    frameIndex += 1;
    if (encoder.encodeQueueSize > 2) {
      continue;
    }

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
  isStopping: () => boolean
) {
  while (!isStopping()) {
    const {done, value: audioData} = await reader.read();
    if (done) {
      return;
    }

    try {
      encoder.encode(audioData);
    } finally {
      audioData.close();
    }
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
  wsUrl.searchParams.set('audio', 'aac');
  wsUrl.searchParams.set('container', 'flv');
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

class FlvMuxer {
  private headerWritten = false;
  private audioConfigWritten = false;
  private videoConfigWritten = false;
  private audioTimestampOrigin: number | undefined;
  private videoTimestampOrigin: number | undefined;

  constructor(
    private readonly socket: WebSocket,
    private readonly audioConfig: AudioEncoderConfig
  ) {}

  addVideoChunk(chunk: EncodedVideoChunk, decoderConfig?: Uint8Array) {
    this.writeHeader();
    const timestamp = this.normalizeTimestamp('video', chunk.timestamp);
    if (decoderConfig) {
      this.writeVideoConfig(decoderConfig);
    }
    if (!this.videoConfigWritten) {
      throw new Error('H.264 decoder configuration is missing from WebCodecs');
    }

    const payload = copyEncodedChunk(chunk);
    const data = new Uint8Array(payload.byteLength + 5);
    data[0] = chunk.type === 'key' ? 0x17 : 0x27;
    data[1] = 0x01;
    data.set(payload, 5);
    this.send(createFlvTag(0x09, timestamp, data));
  }

  addAudioChunk(chunk: EncodedAudioChunk) {
    this.writeHeader();
    const timestamp = this.normalizeTimestamp('audio', chunk.timestamp);
    if (!this.audioConfigWritten) {
      this.writeAudioConfig();
    }

    const payload = copyEncodedChunk(chunk);
    const data = new Uint8Array(payload.byteLength + 2);
    data.set([0xaf, 0x01]);
    data.set(payload, 2);
    this.send(createFlvTag(0x08, timestamp, data));
  }

  private writeHeader() {
    if (this.headerWritten) {
      return;
    }
    this.send(
      new Uint8Array([
        0x46, 0x4c, 0x56, 0x01, 0x05, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00,
        0x00,
      ])
    );
    this.headerWritten = true;
  }

  private writeVideoConfig(decoderConfig: Uint8Array) {
    const data = new Uint8Array(decoderConfig.byteLength + 5);
    data.set([0x17, 0x00, 0x00, 0x00, 0x00]);
    data.set(decoderConfig, 5);
    this.send(createFlvTag(0x09, 0, data));
    this.videoConfigWritten = true;
  }

  private writeAudioConfig() {
    const data = new Uint8Array(4);
    data.set([0xaf, 0x00]);
    data.set(createAudioSpecificConfig(this.audioConfig), 2);
    this.send(createFlvTag(0x08, 0, data));
    this.audioConfigWritten = true;
  }

  private normalizeTimestamp(track: 'audio' | 'video', timestamp: number) {
    if (track === 'video') {
      this.videoTimestampOrigin ??= timestamp;
      return Math.max(
        0,
        Math.round((timestamp - this.videoTimestampOrigin) / 1000)
      );
    }

    this.audioTimestampOrigin ??= timestamp;
    return Math.max(
      0,
      Math.round((timestamp - this.audioTimestampOrigin) / 1000)
    );
  }

  private send(data: Uint8Array) {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(data);
    }
  }
}

function createFlvTag(type: number, timestamp: number, data: Uint8Array) {
  const tag = new Uint8Array(data.byteLength + 15);
  tag[0] = type;
  tag[1] = (data.byteLength >> 16) & 0xff;
  tag[2] = (data.byteLength >> 8) & 0xff;
  tag[3] = data.byteLength & 0xff;
  tag[4] = (timestamp >> 16) & 0xff;
  tag[5] = (timestamp >> 8) & 0xff;
  tag[6] = timestamp & 0xff;
  tag[7] = (timestamp >> 24) & 0xff;
  tag.set(data, 11);

  const previousTagSize = data.byteLength + 11;
  tag[tag.byteLength - 4] = (previousTagSize >> 24) & 0xff;
  tag[tag.byteLength - 3] = (previousTagSize >> 16) & 0xff;
  tag[tag.byteLength - 2] = (previousTagSize >> 8) & 0xff;
  tag[tag.byteLength - 1] = previousTagSize & 0xff;
  return tag;
}

function copyBufferSource(source: AllowSharedBufferSource) {
  const copy = new Uint8Array(source.byteLength);
  copy.set(new Uint8Array(source as ArrayBuffer));
  return copy;
}

function createAudioSpecificConfig(config: AudioEncoderConfig) {
  const sampleRate = config.sampleRate;
  const channels = config.numberOfChannels;
  if (!sampleRate || !channels) {
    throw new Error('AAC configuration is missing sample rate or channels');
  }

  const sampleRateIndex = getAdtsSampleRateIndex(sampleRate);
  const audioObjectType = 2; // AAC-LC
  return new Uint8Array([
    (audioObjectType << 3) | (sampleRateIndex >> 1),
    ((sampleRateIndex & 1) << 7) | (channels << 3),
  ]);
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
