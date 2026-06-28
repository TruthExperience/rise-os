// Browser-only client for wake-word listening, voice capture, and
// server-side Whisper transcription via Groq.
// Must be used from a 'use client' component.
//
// Wake-word detection uses the browser's free, built-in SpeechRecognition
// API (continuous mode) rather than a paid SDK like Picovoice — consistent
// with this project's free-first approach. Once the wake phrase is heard,
// recognition stops and a real MediaRecorder capture begins for the actual
// command, which is sent server-side to Groq's Whisper endpoint via
// /api/pitboss/voice/transcribe (so GROQ_API_KEY never touches the browser).
//
// Browser support note: SpeechRecognition is well-supported in Chrome/Edge
// but not in Firefox and has partial support in Safari.

export interface PitBossOmniSessionOptions {
  wakePhrase?: string;
  recordingMaxMs?: number; // safety cap on command recording length
  mimeType?: string; // MediaRecorder mimeType
}

const TRANSCRIBE_ENDPOINT = '/api/pitboss/voice/transcribe';

type SpeechRecognitionCtor = new () => SpeechRecognition;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  return (
    (window as any).SpeechRecognition ??
    (window as any).webkitSpeechRecognition ??
    null
  );
}

export class PitBossOmniSession {
  private options: Required<PitBossOmniSessionOptions>;
  private recognition: SpeechRecognition | null = null;
  private mediaStream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private wakeListening = false;

  constructor(options: PitBossOmniSessionOptions = {}) {
    this.options = {
      wakePhrase: (options.wakePhrase ?? 'hey pitboss').toLowerCase(),
      recordingMaxMs: options.recordingMaxMs ?? 15000,
      mimeType: options.mimeType ?? 'audio/webm',
    };
  }

  get isWakeListening(): boolean {
    return this.wakeListening;
  }

  get isRecording(): boolean {
    return this.recorder?.state === 'recording';
  }

  /**
   * Starts continuous, free wake-word listening using the browser's
   * built-in SpeechRecognition. Calls onWake() once the configured wake
   * phrase is heard, then stops listening (call this again to re-arm it).
   */
  startWakeWordListening(onWake: () => void, onError?: (err: Error) => void): void {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      throw new Error(
        'SpeechRecognition is not supported in this browser — wake-word listening unavailable.'
      );
    }
    if (this.wakeListening) return;

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript.toLowerCase();
        if (transcript.includes(this.options.wakePhrase)) {
          this.stopWakeWordListening();
          onWake();
          return;
        }
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      this.wakeListening = false;
      onError?.(new Error(`Wake-word recognition error: ${event.error}`));
    };

    // Browsers auto-stop SpeechRecognition after a period of silence —
    // restart automatically to keep wake-word listening continuous.
    recognition.onend = () => {
      if (this.wakeListening) recognition.start();
    };

    this.recognition = recognition;
    this.wakeListening = true;
    recognition.start();
  }

  stopWakeWordListening(): void {
    this.wakeListening = false;
    this.recognition?.stop();
    this.recognition = null;
  }

  /** Starts recording the actual voice command via MediaRecorder. */
  async startRecording(): Promise<void> {
    if (this.recorder?.state === 'recording') return;

    this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.mediaStream, { mimeType: this.options.mimeType });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();

    // Safety cap in case stopRecording is never called (e.g. a dropped UI event).
    setTimeout(() => {
      if (this.recorder?.state === 'recording') this.recorder.stop();
    }, this.options.recordingMaxMs);
  }

  private stopRecording(): Promise<Blob> {
    return new Promise((resolve) => {
      if (!this.recorder) return resolve(new Blob());
      this.recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.options.mimeType });
        this.mediaStream?.getTracks().forEach((t) => t.stop());
        this.mediaStream = null;
        this.recorder = null;
        resolve(blob);
      };
      this.recorder.stop();
    });
  }

  /**
   * Stops the current recording and sends the audio to the server for
   * Whisper transcription. Returns the transcribed text.
   */
  async stopRecordingAndTranscribe(): Promise<string> {
    const blob = await this.stopRecording();
    if (blob.size === 0) {
      throw new Error('No audio captured — was startRecording() called first?');
    }

    const formData = new FormData();
    formData.append('audio', blob, 'command.webm');

    const res = await fetch(TRANSCRIBE_ENDPOINT, {
      method: 'POST',
      body: formData,
    });

    const data = await res.json();
    if (data.error) {
      throw new Error(`Transcription failed: ${data.error}`);
    }

    return data.text as string;
  }

  /** Tears down all active listeners and media resources. */
  destroy(): void {
    this.stopWakeWordListening();
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;
    this.recorder = null;
  }
}
