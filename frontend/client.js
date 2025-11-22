let socket = null;
let displayDiv = document.getElementById("textDisplay");
let server_available = false;
let mic_available = false;
let fullSentences = [];
let reconnectTimeout = null;
let is_server_ready = false;

const WEBSOCKET_URL =
  "wss://extra-walt-readers-bestsellers.trycloudflare.com/ws/transcribe";

function connectToServer() {
  if (socket && socket.readyState === WebSocket.OPEN) return;
  console.log("Connecting to:", WEBSOCKET_URL);
  socket = new WebSocket(WEBSOCKET_URL);

  socket.onopen = (e) => {
    console.log("✅ Connected (Waiting for Ready...)");
    server_available = true;
    start_msg();
  };

  socket.onmessage = (e) => {
    let data = JSON.parse(e.data);
    if (data.type === "status" && data.text === "ready") {
      console.log("🚀 Server Ready!");
      is_server_ready = true;
      start_msg();
    } else if (data.type === "realtime") {
      displayRealtimeText(data.text, displayDiv);
    } else if (data.type === "fullSentence") {
      fullSentences.push(data.text);
      displayRealtimeText("", displayDiv);
    }
  };

  socket.onclose = (e) => {
    console.log("❌ Disconnected. Retrying...");
    server_available = false;
    is_server_ready = false;
    start_msg();
    setTimeout(connectToServer, 3000);
  };
}

function displayRealtimeText(realtimeText, displayDiv) {
  let displayedText =
    fullSentences
      .map(
        (s, i) =>
          `<span class="${i % 2 === 0 ? "yellow" : "cyan"}">${s} </span>`,
      )
      .join("") + realtimeText;
  displayDiv.innerHTML = displayedText;
}

function start_msg() {
  if (!mic_available) displayRealtimeText("🎤 Allow Mic 🎤", displayDiv);
  else if (!server_available)
    displayRealtimeText("⏳ Connecting... ⏳", displayDiv);
  else if (!is_server_ready)
    displayRealtimeText("🔄 Loading AI... 🔄", displayDiv);
  else displayRealtimeText("👄 Speak Now 👄", displayDiv);
}

function downsampleBuffer(buffer, inputRate, outputRate) {
  if (outputRate === inputRate) return buffer;
  let ratio = inputRate / outputRate;
  let newLength = Math.round(buffer.length / ratio);
  let result = new Float32Array(newLength);
  let offsetResult = 0,
    offsetBuffer = 0;
  while (offsetResult < result.length) {
    let nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0,
      count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = accum / count;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

navigator.mediaDevices
  .getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })
  .then((stream) => {
    mic_available = true;
    let audioContext = new AudioContext();
    let source = audioContext.createMediaStreamSource(stream);

    // SMALLER BUFFER = FASTER VAD RESPONSE
    // 1024 samples is approx 20-60ms depending on sample rate
    let processor = audioContext.createScriptProcessor(1024, 1, 1);

    source.connect(processor);
    processor.connect(audioContext.destination);

    connectToServer();

    processor.onaudioprocess = function (e) {
      if (!socket || socket.readyState !== WebSocket.OPEN || !is_server_ready)
        return;

      let inputData = e.inputBuffer.getChannelData(0);
      let downsampled = downsampleBuffer(
        inputData,
        audioContext.sampleRate,
        16000,
      );
      let outputData = new Int16Array(downsampled.length);

      // MODERATE GAIN (10x) + NOISE GATE
      const GAIN = 10.0;
      const NOISE_THRESHOLD = 0.01; // Ignore very quiet background static

      for (let i = 0; i < downsampled.length; i++) {
        let val = downsampled[i];

        // Simple Noise Gate: If too quiet, silence it completely
        if (Math.abs(val) < NOISE_THRESHOLD) {
          val = 0;
        } else {
          val = val * GAIN;
        }

        val = Math.max(-1.0, Math.min(1.0, val));
        outputData[i] = val < 0 ? val * 0x8000 : val * 0x7fff;
      }

      let metadata = JSON.stringify({ sampleRate: 16000 });
      let metadataBytes = new TextEncoder().encode(metadata);
      let metaLen = new ArrayBuffer(4);
      new DataView(metaLen).setInt32(0, metadataBytes.byteLength, true);

      socket.send(new Blob([metaLen, metadataBytes, outputData.buffer]));
    };
  })
  .catch((e) => console.error(e));
