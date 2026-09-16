interface Window {
  startStreaming: (options?: StartStreamingOptions) => Promise<{
    streamId: string;
    encoder: StreamingEncoder;
    videoCodec?: string;
    audioCodec?: string;
  }>;
  stopStreaming: (streamId: string) => Promise<void>;
}

type StartStreamingOptions = {
  wsPort?: number;
  recordingResizeFactor?: number;
  encoder?: StreamingEncoder;
};

type StreamingEncoder = 'media-recorder' | 'webcodecs';

declare class MediaStreamTrackProcessor<T extends VideoFrame | AudioData> {
  constructor(init: {track: MediaStreamTrack});
  readonly readable: ReadableStream<T>;
}
