let socket = null;
let displayDiv = document.getElementById("textDisplay");
let server_available = false;
let mic_available = false;
let fullSentences = [];
let reconnectTimeout = null;

const WEBSOCKET_URL =
  "wss://displays-prayer-coordinated-rail.trycloudflare.com";

function connectToServer() {
  if (socket && socket.readyState === WebSocket.OPEN) return;

  console.log("Connecting to:", WEBSOCKET_URL);
  socket = new WebSocket(WEBSOCKET_URL);

  socket.onopen = function (event) {
    console.log("✅ Connected to server");
    server_available = true;
    start_msg();
  };

  socket.onmessage = function (event) {
    let data = JSON.parse(event.data);
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
    displayRealtimeText("🖥️  connecting to server...  🖥️", displayDiv);
  else displayRealtimeText("👄  start speaking  👄", displayDiv);
}

// Initialize Mic
navigator.mediaDevices
  .getUserMedia({ audio: true })
  .then((stream) => {
    mic_available = true;
    let audioContext = new AudioContext();
    let source = audioContext.createMediaStreamSource(stream);

    // --- CRITICAL FIX: CHANGE 256 TO 4096 ---
    // 4096 samples = ~85ms latency. This is reliable over WiFi/Internet.
    let processor = audioContext.createScriptProcessor(4096, 1, 1);

    source.connect(processor);
    processor.connect(audioContext.destination);

    // Connect to server only after mic is ready
    connectToServer();

    processor.onaudioprocess = function (e) {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;

      let inputData = e.inputBuffer.getChannelData(0);
      let outputData = new Int16Array(inputData.length);

      // Convert to 16-bit PCM
      for (let i = 0; i < inputData.length; i++) {
        outputData[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
      }

      // Debug log: Print once every 100 packets to avoid spamming console
      if (Math.random() < 0.01) {
        console.log("🎤 Sending audio packet, size:", outputData.length);
      }

      // Create Metadata
      let metadata = JSON.stringify({ sampleRate: audioContext.sampleRate });
      let metadataBytes = new TextEncoder().encode(metadata);
      let metadataLength = new ArrayBuffer(4);
      let metadataLengthView = new DataView(metadataLength);
      metadataLengthView.setInt32(0, metadataBytes.byteLength, true);

      // Send Blob
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
    displayRealtimeText("❌ Mic Access Denied: " + e.message, displayDiv);
  });
