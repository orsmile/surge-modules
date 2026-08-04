/* Show and copy the most recent Google Maps -> Apple Maps diagnostic trace. */

const LOG_STORE_KEY = "google-maps-to-apple-maps.last-log";
let trace = "";

try {
  trace = $persistentStore.read(LOG_STORE_KEY) || "尚無診斷紀錄，請先執行一次 [Google → Apple] 分享/手動。";
} catch (error) {
  trace = "讀取診斷紀錄失敗：" + String(error);
}

console.log(trace);

$notification.post(
  "Google → Apple Maps",
  "上次診斷（點一下複製）",
  preview(trace, 600),
  { action: "clipboard", text: trace }
);

$done();

function preview(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? text.slice(0, maxLength) + "…" : text;
}
