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

  socket.onopen = function (event) {
    console.log("✅ Connected to socket (Waiting for Ready signal...)");
    server_available = true;
    start_msg();
  };

  socket.onmessage = function (event) {
    let data = JSON.parse(event.data);

    if (data.type === "status" && data.text === "ready") {
      console.log("🚀 Server is Ready! Starting audio stream...");
      is_server_ready = true;
      start_msg();
      return;
    }

    if (data.type === "realtime") {
      displayRealtimeText(data.text, displayDiv);
    } else if (data.type === "fullSentence") {
      fullSentences.push(data.text);
      displayRealtimeText("", displayDiv);
    }
  };

  socket.onclose = function (event) {
    console.log("❌ Disconnected. Retrying in 3s...");
    server_available = false;
    is_server_ready = false;
    start_msg();
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(connectToServer, 3000);
  };

  socket.onerror = function (error) {
    console.error("WebSocket Error:", error);
    socket.close();
  };
}

function displayRealtimeText(realtimeText, displayDiv) {
  let displayedText =
    fullSentences
      .map((sentence, index) => {
        let span = document.createElement("span");
        span.textContent = sentence + " ";
        span.className = index % 2 === 0 ? "yellow" : "cyan";
        return span.outerHTML;
      })
      .join("") + realtimeText;

  displayDiv.innerHTML = displayedText;
}

function start_msg() {
  if (!mic_available)
    displayRealtimeText("🎤  please allow microphone access  🎤", displayDiv);
  else if (!server_available)
    displayRealtimeText("⏳  connecting...  ⏳", displayDiv);
  else if (!is_server_ready)
    displayRealtimeText("🔄  loading AI models...  🔄", displayDiv);
  else displayRealtimeText("👄  start speaking  👄", displayDiv);
}

// --- DOWNSAMPLING HELPER FUNCTION ---
// Converts incoming audio (usually 44.1k or 48k) to 16k
function downsampleBuffer(buffer, inputSampleRate, outputSampleRate) {
  if (outputSampleRate === inputSampleRate) {
    return buffer;
  }
  var sampleRateRatio = inputSampleRate / outputSampleRate;
  var newLength = Math.round(buffer.length / sampleRateRatio);
  var result = new Float32Array(newLength);
  var offsetResult = 0;
  var offsetBuffer = 0;

  while (offsetResult < result.length) {
    var nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    // Use simple averaging to prevent aliasing
    var accum = 0,
      count = 0;
    for (var i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = accum / count;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

// --- MAIN AUDIO SETUP ---
navigator.mediaDevices
  .getUserMedia({ audio: true }) // Reverted to default (removes hardware error)
  .then((stream) => {
    mic_available = true;

    let audioContext = new AudioContext(); // Default sample rate (likely 44.1k or 48k)
    let source = audioContext.createMediaStreamSource(stream);
    let processor = audioContext.createScriptProcessor(4096, 1, 1);

    // GAIN NODE (Volume Boost)
    let gainNode = audioContext.createGain();
    gainNode.gain.value = 25.0;

    source.connect(gainNode);
    gainNode.connect(processor);
    processor.connect(audioContext.destination);

    connectToServer();

    processor.onaudioprocess = function (e) {
      if (!socket || socket.readyState !== WebSocket.OPEN || !is_server_ready)
        return;

      let inputData = e.inputBuffer.getChannelData(0);

      // 1. DOWNSAMPLE TO 16000 HZ MANUALLY
      let downsampledData = downsampleBuffer(
        inputData,
        audioContext.sampleRate,
        16000,
      );

      // 2. CONVERT TO INT16
      let outputData = new Int16Array(downsampledData.length);
      for (let i = 0; i < downsampledData.length; i++) {
        let amplified = downsampledData[i];
        amplified = Math.max(-1.0, Math.min(1.0, amplified)); // Clamp
        outputData[i] = amplified < 0 ? amplified * 0x8000 : amplified * 0x7fff;
      }

      // 3. SEND (Always marked as 16000)
      let metadata = JSON.stringify({ sampleRate: 16000 });
      let metadataBytes = new TextEncoder().encode(metadata);
      let metadataLength = new ArrayBuffer(4);
      let metadataLengthView = new DataView(metadataLength);
      metadataLengthView.setInt32(0, metadataBytes.byteLength, true);

      let combinedData = new Blob([
        metadataLength,
        metadataBytes,
        outputData.buffer,
      ]);
      socket.send(combinedData);
    };
  })
  .catch((e) => {
    console.error("Mic Error:", e);
    displayRealtimeText("❌ Mic Access Denied", displayDiv);
  });
