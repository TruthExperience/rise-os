// Browser-only client for vision capture + vision chat.
// Captures frames from the camera or screen share, encodes them, and sends
// them through /api/pitboss/llm (which holds the proxy key server-side) —
// never calls pitboss-proxy directly from the browser.
// Must be used from a 'use client' component; relies on browser-only APIs
// (navigator.mediaDevices, HTMLVideoElement, HTMLCanvasElement).

export type VisionSource = 'camera' | 'screen';

export interface VisionChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface PitBossVisionSessionOptions {
  source?: VisionSource;
  facingMode?: 'user' | 'environment'; // camera only
  maxDimension?: number; // downscale captured frames to this max width/height
  jpegQuality?: number; // 0-1
}

const LLM_ENDPOINT = '/api/pitboss/llm';

export class PitBossVisionSession {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement;
  private options: Required<PitBossVisionSessionOptions>;
  private history: VisionChatTurn[] = [];

  constructor(options: PitBossVisionSessionOptions = {}) {
    this.options = {
      source: options.source ?? 'camera',
      facingMode: options.facingMode ?? 'environment',
      maxDimension: options.maxDimension ?? 1024,
      jpegQuality: options.jpegQuality ?? 0.7,
    };
    this.canvas = document.createElement('canvas');
  }

  /** Requests camera or screen-share access and starts the video feed. */
  async start(): Promise<void> {
    if (this.stream) return;

    this.stream =
      this.options.source === 'screen'
        ? await navigator.mediaDevices.getDisplayMedia({ video: true })
        : await navigator.mediaDevices.getUserMedia({
            video: { facingMode: this.options.facingMode },
          });

    this.video = document.createElement('video');
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();

    // Wait for the first frame so dimensions are known before capture.
    await new Promise<void>((resolve) => {
      if (this.video!.readyState >= 2) return resolve();
      this.video!.onloadeddata = () => resolve();
    });
  }

  /** Stops the camera/screen feed and releases all media resources. */
  stop(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video = null;
  }

  get isActive(): boolean {
    return this.stream !== null;
  }

  /** Captures the current frame as a base64 JPEG data URL. */
  captureFrame(): string {
    if (!this.video) {
      throw new Error('Vision session is not active — call start() first.');
    }

    const { videoWidth, videoHeight } = this.video;
    const scale = Math.min(1, this.options.maxDimension / Math.max(videoWidth, videoHeight));
    this.canvas.width = Math.round(videoWidth * scale);
    this.canvas.height = Math.round(videoHeight * scale);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D canvas context.');
    ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);

    return this.canvas.toDataURL('image/jpeg', this.options.jpegQuality);
  }

  /**
   * Captures the current frame and sends it + a text prompt to the vision
   * model via /api/pitboss/llm (action: 'infer'). Maintains conversation
   * history across calls for multi-turn vision chat.
   */
  async sendVisionChat(prompt: string): Promise<string> {
    const frame = this.captureFrame();

    const messages = [
      ...this.history.map((turn) => ({ role: turn.role, content: turn.content })),
      {
        role: 'user' as const,
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: frame } },
        ],
      },
    ];

    const res = await fetch(LLM_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'infer',
        messages,
        max_tokens: 1024,
        temperature: 0.4,
      }),
    });

    const data = await res.json();
    if (data.error) {
      throw new Error(`Vision chat failed: ${data.error}`);
    }

    this.history.push({ role: 'user', content: prompt });
    this.history.push({ role: 'assistant', content: data.response });

    return data.response as string;
  }

  clearHistory(): void {
    this.history = [];
  }
}
