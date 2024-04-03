interface Window {
  startStreaming: (port: number) => Promise<{streamId: string}>;
  stopStreaming: (streamId: string) => void;
}

type StartStreamingOptions = {
  wsPort?: number;
  recordingResizeFactor?: number;
};
