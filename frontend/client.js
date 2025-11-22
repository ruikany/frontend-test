let socket = null;
let displayDiv = document.getElementById("textDisplay");
let server_available = false;
let mic_available = false;
let fullSentences = [];
let reconnectTimeout = null;

// global vars issues in V8
let source = null;
let processor = null;

// NEW: Flag to control audio flow
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

    // 1. LISTEN FOR READY SIGNAL
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
    is_server_ready = false; // Reset ready flag
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
    displayRealtimeText("🔄  loading AI models...  🔄", displayDiv); // New State
  else displayRealtimeText("👄  start speaking  👄", displayDiv);
}

// navigator.mediaDevices
//   .getUserMedia({ audio: true })
//   .then((stream) => {
//     mic_available = true;
//     let audioContext = new AudioContext();
//     source = audioContext.createMediaStreamSource(stream);
//     processor = audioContext.createScriptProcessor(4096, 1, 1);
//
//     source.connect(processor);
//     processor.connect(audioContext.destination);
//
//     connectToServer();
//
//     processor.onaudioprocess = function (e) {
//       if (!socket || socket.readyState !== WebSocket.OPEN || !is_server_ready)
//         return;
//
//       let inputData = e.inputBuffer.getChannelData(0);
//       let outputData = new Int16Array(inputData.length);
//
//       // for (let i = 0; i < inputData.length; i++) {
//       //   outputData[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
//       // }
//
//       let gain = 25.0; // Boost volume 25x (Force the VAD to hear you)
//
//       for (let i = 0; i < inputData.length; i++) {
//         // Apply gain
//         let amplified = inputData[i] * gain;
//
//         // CLAMP the values so they don't overflow (Distortion protection)
//         // Range must stay between -1.0 and 1.0 for float audio
//         amplified = Math.max(-1.0, Math.min(1.0, amplified));
//
//         // Convert to 16-bit PCM
//         outputData[i] = amplified < 0 ? amplified * 0x8000 : amplified * 0x7fff;
//       }
//
//       let metadata = JSON.stringify({ sampleRate: audioContext.sampleRate });
//       let metadataBytes = new TextEncoder().encode(metadata);
//       let metadataLength = new ArrayBuffer(4);
//       let metadataLengthView = new DataView(metadataLength);
//       metadataLengthView.setInt32(0, metadataBytes.byteLength, true);
//
//       let combinedData = new Blob([
//         metadataLength,
//         metadataBytes,
//         outputData.buffer,
//       ]);
//       socket.send(combinedData);
//     };
//   })
//   .catch((e) => {
//     console.error("Mic Error:", e);
//     displayRealtimeText("❌ Mic Access Denied", displayDiv);
//   });

navigator.mediaDevices
  .getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 16000, // <--- CRITICAL: REQUEST 16kHz HARDWARE RATE
      echoCancellation: true,
      noiseSuppression: true,
    },
  })
  .then((stream) => {
    mic_available = true;

    // FORCE THE CONTEXT TO 16000 HZ
    // This ensures the math is perfect for the server
    let audioContext = new AudioContext({ sampleRate: 16000 });
    audioContext.resume();

    source = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);

    let gainNode = audioContext.createGain();
    gainNode.gain.value = 25.0; // Keep the boost

    source.connect(gainNode);
    gainNode.connect(processor);
    processor.connect(audioContext.destination);

    connectToServer();

    processor.onaudioprocess = function (e) {
      if (!socket || socket.readyState !== WebSocket.OPEN || !is_server_ready)
        return;

      let inputData = e.inputBuffer.getChannelData(0);
      let outputData = new Int16Array(inputData.length);

      for (let i = 0; i < inputData.length; i++) {
        let amplified = inputData[i]; // Gain is already applied by gainNode
        amplified = Math.max(-1.0, Math.min(1.0, amplified));
        outputData[i] = amplified < 0 ? amplified * 0x8000 : amplified * 0x7fff;
      }

      // We still send metadata to keep protocol consistent,
      // but it will now always be 16000
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
    displayRealtimeText(
      "❌ Mic Access Denied / 16kHz Not Supported",
      displayDiv,
    );
  });
