let socket = null;
let displayDiv = document.getElementById("textDisplay");
let is_server_ready = false;

const WEBSOCKET_URL =
  "wss://mega-physically-biggest-learning.trycloudflare.com/ws/transcribe";

function connectToServer() {
  socket = new WebSocket(WEBSOCKET_URL);
  socket.onopen = () => console.log("✅ Connected");
  socket.onmessage = (e) => {
    let data = JSON.parse(e.data);
    if (data.type === "status" && data.text === "ready") {
      console.log("🚀 Server Ready!");
      is_server_ready = true;
      displayDiv.innerHTML = "👄 Speak Now 👄";
    } else if (data.type === "fullSentence") {
      displayDiv.innerHTML += "<br> > " + data.text;
    }
  };
  socket.onclose = () => setTimeout(connectToServer, 3000);
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
  .getUserMedia({ audio: { echoCancellation: true, autoGainControl: true } })
  .then((stream) => {
    let audioContext = new AudioContext();
    let source = audioContext.createMediaStreamSource(stream);
    let processor = audioContext.createScriptProcessor(1024, 1, 1); // Small buffer = Fast VAD

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

      for (let i = 0; i < downsampled.length; i++) {
        let val = downsampled[i];
        val = Math.max(-1, Math.min(1, val));
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
