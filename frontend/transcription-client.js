export class TranscriptionClient {
    constructor(url, { onRealtime, onSentence, onStatus, onError } = {}) {
        this.url = url;
        this.onRealtime = onRealtime || (() => { });
        this.onSentence = onSentence || (() => { });
        this.onStatus = onStatus || (() => { });
        this.onError = onError || (() => { });

        this.socket = null;
        this.audioContext = null;
        this.processor = null;
        this.inputSource = null;
        this.stream = null;
    }

    // --- MIC MODE ---
    async startMic() {
        try {
            this.onStatus('Requesting Mic...');
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
            this.onStatus('Connecting...');
            this._connectSocket(() => {
                this._startMicProcessing();
                this.onStatus('Live (Mic)');
            });
        } catch (err) {
            this.onError(err);
            this.onStatus('Mic Error');
        }
    }

    // --- FILE MODE (NEW) ---
    async startFile(file) {
        try {
            this.onStatus('Reading File...');
            const arrayBuffer = await file.arrayBuffer();

            // We need an AudioContext to decode the file (mp3/wav -> raw pcm)
            if (!this.audioContext) this.audioContext = new AudioContext();

            this.onStatus('Decoding Audio...');
            const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

            this.onStatus('Connecting...');
            this._connectSocket(async () => {
                this.onStatus('Transcribing File...');
                await this._streamAudioBuffer(audioBuffer);
                this.onStatus('File Finished');
            });

        } catch (err) {
            this.onError(err);
            this.onStatus('File Error');
        }
    }

    stop() {
        if (this.processor) {
            this.processor.disconnect();
            this.processor = null;
        }
        if (this.inputSource) {
            this.inputSource.disconnect();
            this.inputSource = null;
        }
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
        this.onStatus('Stopped');
    }

    // --- INTERNAL HELPERS ---

    _connectSocket(onReady) {
        this.socket = new WebSocket(this.url);
        this.socket.binaryType = "arraybuffer"; // Important

        this.socket.onopen = () => { };

        this.socket.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === "status" && data.text === "ready") {
                onReady();
            } else if (data.type === "realtime") {
                this.onRealtime(data.text);
            } else if (data.type === "fullSentence") {
                this.onSentence(data.text);
            }
        };

        this.socket.onerror = (err) => {
            this.onError(err);
            this.onStatus('Connection Error');
        };

        this.socket.onclose = () => {
            this.onStatus('Disconnected');
        };
    }

    _startMicProcessing() {
        if (!this.audioContext) this.audioContext = new AudioContext();
        this.inputSource = this.audioContext.createMediaStreamSource(this.stream);
        this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

        this.inputSource.connect(this.processor);
        this.processor.connect(this.audioContext.destination);

        this.processor.onaudioprocess = (e) => {
            const inputData = e.inputBuffer.getChannelData(0);
            this._sendAudioChunk(inputData);
        };
    }

    async _streamAudioBuffer(audioBuffer) {
        // Simulate streaming by chopping the file into 4096-sample chunks
        const channelData = audioBuffer.getChannelData(0); // Get left channel
        const chunkSize = 4096;

        for (let i = 0; i < channelData.length; i += chunkSize) {
            if (!this.socket || this.socket.readyState !== WebSocket.OPEN) break;

            const chunk = channelData.slice(i, i + chunkSize);
            this._sendAudioChunk(chunk);

            // Optional: Small delay to prevent flooding the server instantly
            // (Simulates real-time speed approx 4x faster)
            await new Promise(r => setTimeout(r, 10));
        }
    }

    _sendAudioChunk(float32Data) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

        const int16Data = new Int16Array(float32Data.length);
        for (let i = 0; i < float32Data.length; i++) {
            let s = Math.max(-1, Math.min(1, float32Data[i]));
            int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        const metadata = JSON.stringify({ sampleRate: this.audioContext.sampleRate });
        const metadataBytes = new TextEncoder().encode(metadata);
        const lenBuffer = new ArrayBuffer(4);
        new DataView(lenBuffer).setInt32(0, metadataBytes.byteLength, true);

        const blob = new Blob([lenBuffer, metadataBytes, int16Data.buffer]);
        this.socket.send(blob);
    }
}
