// ════════════════════════════════════════════════════════════════════
// Welch PSD + HR Worker
// Based on Health-HCI-Group/ME-rPPG-demo (Apache 2.0 License)
// ════════════════════════════════════════════════════════════════════

importScripts("https://fastly.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort.min.js");

let welchSession;
let hrSession;

ort.env.wasm.wasmPaths = "https://fastly.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/";

ort.InferenceSession.create("me-rppg/welch_psd.onnx", {
    executionProviders: ["wasm"],
}).then(async (session) => {
    welchSession = session;
    console.log("[ME-rPPG] Welch Session created");
    self.postMessage({type: "ready", which: "welch"});
});

ort.InferenceSession.create("me-rppg/get_hr.onnx", {
    executionProviders: ["wasm"],
}).then((session) => {
    hrSession = session;
    console.log("[ME-rPPG] HR Session created");
    self.postMessage({type: "ready", which: "hr"});
});

self.onmessage = async (event) => {
    if (!welchSession) {
        console.log("[ME-rPPG] Welch session not ready");
        return;
    }
    const { input } = event.data;
    const inputData = new ort.Tensor("float32", input, [1, 1, input.length]);
    const outputs = await welchSession.run({ input: inputData });
    const freqs = outputs["freqs"];
    const psd = outputs["psd"];
    const hr = (await hrSession.run({freqs, psd}))["hr"]["cpuData"]["0"];

    // Welch PSD를 통해 HRV 계산용 BVP 신호도 같이 전달
    // (psd 데이터 중 일부를 메인으로 보내 HRV 산출에 활용)
    self.postMessage({hr, type: "data"});
};
