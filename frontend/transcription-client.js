export class TranscriptionClient {
    constructor(url, { onRealtime, onSentence, onStatus, onError } = {}) {
        this.url = url;

        // Callbacks to update your UI
        this.onRealtime = onRealtime || (() => { });
        this.onSentence = onSentence || (() => { });
        this.onStatus = onStatus || (() => { });
        this.onError = onError || (() => { });

        // Internal State
        this.socket = null;
        this.audioContext = null;
        this.processor = null;
        this.inputSource = null;
        this.stream = null;
    }

    async start() {
        try {
            this.onStatus('Connecting...');

            // 1. Get Microphone Access
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });

            // 2. Init WebSocket
            this.socket = new WebSocket(this.url);

            this.socket.onopen = () => {
                this.onStatus('Connected. Initializing...');
            };

            this.socket.onmessage = (event) => {
                const data = JSON.parse(event.data);

                if (data.type === "status" && data.text === "ready") {
                    // Server is ready, start sending audio
                    this._startAudioProcessing();
                    this.onStatus('Live');
                } else if (data.type === "realtime") {
                    this.onRealtime(data.text);
                } else if (data.type === "fullSentence") {
                    this.onSentence(data.text);
                }
            };

            this.socket.onerror = (err) => {
                this.onError(err);
                this.onStatus('Connection Error');
                this.stop();
            };

            this.socket.onclose = () => {
                this.onStatus('Disconnected');
                this.stop();
            };

        } catch (err) {
            this.onError(err);
            this.onStatus('Mic Error');
        }
    }

    stop() {
        // 1. Stop Audio Processing
        if (this.processor) {
            this.processor.disconnect();
            this.processor = null;
        }
        if (this.inputSource) {
            this.inputSource.disconnect();
            this.inputSource = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }

        // 2. Stop Microphone Stream
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }

        // 3. Close Socket
        if (this.socket) {
            // Prevent triggering onclose again recursively
            this.socket.onclose = null;
            this.socket.close();
            this.socket = null;
        }

        this.onStatus('Ready');
    }

    // INTERNAL: The specific protocol logic
    _startAudioProcessing() {
        this.audioContext = new AudioContext();
        this.inputSource = this.audioContext.createMediaStreamSource(this.stream);
        this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

        this.inputSource.connect(this.processor);
        this.processor.connect(this.audioContext.destination);

        this.processor.onaudioprocess = (e) => {
            if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

            const inputData = e.inputBuffer.getChannelData(0);
            const outputData = new Int16Array(inputData.length);

            // PCM Conversion: Float32 -> Int16
            for (let i = 0; i < inputData.length; i++) {
                outputData[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
            }

            // Protocol: Metadata Length (4 bytes) + Metadata JSON + PCM Data
            const metadata = JSON.stringify({
                sampleRate: this.audioContext.sampleRate,
            });
            const metadataBytes = new TextEncoder().encode(metadata);
            const lenBuffer = new ArrayBuffer(4);
            new DataView(lenBuffer).setInt32(0, metadataBytes.byteLength, true);

            const blob = new Blob([lenBuffer, metadataBytes, outputData.buffer]);
            this.socket.send(blob);
        };
    }
}
