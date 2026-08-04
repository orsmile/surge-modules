/*
 * Google Maps -> Apple Maps (coordinate-only)
 *
 * Generic mode:
 *   Run from Surge or iOS Shortcuts. Pass the Google Maps URL through
 *   $intent.parameter or $argument. A notification opens Apple Maps.
 *
 * HTTP-request mode:
 *   For requests to maps.app.goo.gl, resolve the short link and return a
 *   302 redirect to Apple Maps when the final Google page exposes a point.
 *   If no coordinates are found, leave the original request untouched.
 *
 * This script deliberately does not geocode or search by address.
 */

const LOG_PREFIX = "[GM2AM]";
const LOG_STORE_KEY = "google-maps-to-apple-maps.last-log";
const DESKTOP_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const MOBILE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const traceLines = [];
const isHttpRequest = typeof $request !== "undefined" && $request && $request.url;
const rawInput = isHttpRequest ? $request.url : getInput();
const source = firstUrl(rawInput);

debugLog("start", {
  mode: isHttpRequest ? "http-request" : "generic",
  inputType: describeType(rawInput),
  source: clip(source, 240)
});

if (!source) {
  notifyFailure("沒有收到 Google Maps URL。");
} else {
  resolveUrl(source, [], 0, function (point) {
    if (isHttpRequest) {
      finishHttpRequest(point);
    } else if (point) {
      notifySuccess(point);
    } else {
      notifyFailure("Google 頁面沒有可解析的精確座標；未使用地址搜尋。");
    }
  });
}

function getInput() {
  let value = "";

  if (typeof $intent !== "undefined" && $intent && $intent.parameter) {
    value = $intent.parameter;
  }

  if (!value && typeof $argument !== "undefined" && $argument) {
    value = $argument;
  }

  return valueToString(value).trim();
}

function valueToString(value) {
  if (value === null || typeof value === "undefined") return "";

  if (Array.isArray(value)) {
    return value.map(valueToString).filter(Boolean).join("\n");
  }

  if (typeof value === "object") {
    // Shortcuts may pass a URL as a structured content item instead of text.
    const fields = [
      "url",
      "URL",
      "href",
      "absoluteString",
      "text",
      "value",
      "content",
      "string",
      "link"
    ];

    for (const field of fields) {
      if (value[field]) {
        const candidate = valueToString(value[field]);
        if (candidate) return candidate;
      }
    }

    try {
      return JSON.stringify(value);
    } catch (_) {
      return String(value);
    }
  }

  return String(value);
}

function firstUrl(value) {
  const text = normalize(value).replace(/\\\//g, "/").trim();
  const match = text.match(/https?:\/\/[^\s<>"'\]\)]+/i);
  return (match ? match[0] : text)
    .replace(/\.\(null.*$/i, "")
    .replace(/[),.;\]]+$/, "");
}

function resolveUrl(url, visited, depth, callback, retriedShortUrl) {
  if (depth > 4 || visited.indexOf(url) !== -1) {
    debugLog("stop", { depth: depth, reason: depth > 4 ? "max-depth" : "redirect-loop" });
    callback(null);
    return;
  }

  // Full Google Maps URLs may already expose coordinates.
  const directPoint = extractCoordinates(url);
  if (directPoint) {
    debugLog("coordinate", {
      depth: depth,
      parser: directPoint.source,
      lat: directPoint.lat,
      lng: directPoint.lng
    });
    callback(directPoint);
    return;
  }

  const nextVisited = visited.concat(url);
  debugLog("fetch", { depth: depth, url: clip(url, 300) });

  $httpClient.get({
    url: url,
    headers: {
      "User-Agent": retriedShortUrl && isGoogleShortUrl(url) ? MOBILE_USER_AGENT : DESKTOP_USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      "Cache-Control": "no-cache"
    },
    "auto-redirect": false,
    timeout: 8
  }, function (error, response, body) {
    const location = response && getHeader(response.headers, "location");
    const responseUrl = response && (response.url || response.finalUrl);
    const status = response && (response.status || response.statusCode);
    const bodyText = String(body || "");

    debugLog("response", {
      depth: depth,
      status: status || "none",
      error: error ? clip(valueToString(error), 180) : "",
      location: clip(location, 260),
      responseUrl: clip(responseUrl, 260),
      bodyLength: bodyText.length
    });

    if (isGoogleShortUrl(url) && !retriedShortUrl && !location && (error || Number(status) >= 400)) {
      const retryUrl = cleanGoogleShortUrl(url);
      debugLog("retry-short-url", {
        depth: depth,
        status: status || "none",
        url: clip(retryUrl, 300),
        userAgent: "iphone"
      });
      resolveUrl(retryUrl, visited, depth, callback, true);
      return;
    }

    const page = [
      url,
      responseUrl || "",
      location || "",
      bodyText
    ].join("\n");
    const previewUrl = extractPreviewUrl(bodyText, url);

    if (previewUrl) {
      debugLog("preview", { depth: depth, url: clip(previewUrl, 300) });
      resolvePreview(previewUrl, depth, function (previewPoint) {
        if (previewPoint) {
          debugLog("coordinate", {
            depth: depth,
            parser: previewPoint.source,
            lat: previewPoint.lat,
            lng: previewPoint.lng,
            name: clip(previewPoint.name, 120)
          });
          callback(previewPoint);
          return;
        }

        continueResponse();
      });
      return;
    }

    continueResponse();

    function continueResponse() {
      const point = extractCoordinates(page);

      if (point) {
        debugLog("coordinate", {
          depth: depth,
          parser: point.source,
          lat: point.lat,
          lng: point.lng
        });
        callback(point);
        return;
      }

      if (location) {
        const nextUrl = absoluteUrl(location, url);
        if (nextUrl && nextVisited.indexOf(nextUrl) === -1) {
          debugLog("redirect", { depth: depth, nextUrl: clip(nextUrl, 300) });
          resolveUrl(nextUrl, nextVisited, depth + 1, callback, false);
          return;
        }
      }

      debugLog("stop", {
        depth: depth,
        reason: error ? "http-error" : "no-coordinate",
        status: status || "none",
        bodyLength: bodyText.length
      });
      callback(null);
    }
  });
}

function isGoogleShortUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase() === "maps.app.goo.gl";
  } catch (_) {
    return /\/\/maps\.app\.goo\.gl\//i.test(String(value || ""));
  }
}

function cleanGoogleShortUrl(value) {
  try {
    const url = new URL(value);
    url.searchParams.delete("g_st");
    return url.toString();
  } catch (_) {
    return String(value || "").replace(/([?&])g_st=[^&#]*/gi, "$1").replace(/[?&]$/, "");
  }
}

function extractPreviewUrl(body, baseUrl) {
  const text = String(body || "");
  const match = text.match(/href=["'](\/maps\/preview\/place\?[^"']+)/i);
  if (!match) return "";

  return absoluteUrl(
    match[1]
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/gi, "'"),
    baseUrl || "https://www.google.com/"
  );
}

function resolvePreview(url, depth, callback) {
  $httpClient.get({
    url: url,
    headers: {
      "User-Agent": DESKTOP_USER_AGENT,
      "Accept": "application/json,text/plain,*/*",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8"
    },
    timeout: 8
  }, function (error, response, body) {
    const status = response && (response.status || response.statusCode);
    const bodyText = String(body || "");

    debugLog("preview-response", {
      depth: depth,
      status: status || "none",
      error: error ? clip(valueToString(error), 180) : "",
      bodyLength: bodyText.length
    });

    if (error || !bodyText) {
      callback(null);
      return;
    }

    try {
      const jsonText = bodyText.replace(/^\)\]\}'\s*/, "");
      const data = JSON.parse(jsonText);
      const coordinates = data && data[4] && data[4][0];
      const place = data && data[6];
      const point = coordinates && validPoint(coordinates[2], coordinates[1], "google-preview");

      if (point) {
        point.name = place && typeof place[11] === "string" ? place[11] : "";
        callback(point);
        return;
      }
    } catch (parseError) {
      debugLog("preview-parse-error", { error: clip(valueToString(parseError), 180) });
    }

    callback(null);
  });
}

function extractCoordinates(input) {
  const text = normalize(input);
  let match;

  // Google place/pin data. Prefer this over a map viewport center.
  match = text.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/i);
  if (match) return validPoint(match[1], match[2], "!3d!4d");

  // Full Google Maps URLs commonly expose the map point this way.
  match = text.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i);
  if (match) return validPoint(match[1], match[2], "@lat,lng");

  // Query links and static-map metadata in current Google share pages.
  match = text.match(/(?:[?&"'\s]|\b)(?:center|ll|query|q|destination|origin|latlng)=\s*(-?\d+(?:\.\d+)?)(?:\s*,\s*|%2c)(-?\d+(?:\.\d+)?)/i);
  if (match) return validPoint(match[1], match[2], "query");

  // Google responses may expose the point as JSON or HTML attributes.
  match = text.match(/(?:["']?(?:latitude|lat)["']?\s*[:=]\s*)(-?\d+(?:\.\d+)?)[\s\S]{0,300}?(?:["']?(?:longitude|lng|lon)["']?\s*[:=]\s*)(-?\d+(?:\.\d+)?)/i);
  if (match) return validPoint(match[1], match[2], "latitude/longitude");

  match = text.match(/(?:["']?(?:longitude|lng|lon)["']?\s*[:=]\s*)(-?\d+(?:\.\d+)?)[\s\S]{0,300}?(?:["']?(?:latitude|lat)["']?\s*[:=]\s*)(-?\d+(?:\.\d+)?)/i);
  if (match) return validPoint(match[2], match[1], "latitude/longitude");

  match = text.match(/data-(?:latitude|lat)=["']?(-?\d+(?:\.\d+)?)[^>]{0,300}?data-(?:longitude|lng|lon)=["']?(-?\d+(?:\.\d+)?)/i);
  if (match) return validPoint(match[1], match[2], "data-latitude/longitude");

  return null;
}

function normalize(value) {
  let text = valueToString(value);

  for (let i = 0; i < 5; i++) {
    try {
      const decoded = decodeURIComponent(text);
      if (decoded === text) break;
      text = decoded;
    } catch (_) {
      break;
    }
  }

  return text
    .replace(/\\u003d/gi, "=")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u002c/gi, ",")
    .replace(/\\\//g, "/")
    .replace(/%2c/gi, ",")
    .replace(/&amp;/gi, "&")
    .replace(/&#x2c;/gi, ",");
}

function validPoint(latText, lngText, sourceType) {
  const lat = Number(latText);
  const lng = Number(lngText);

  if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }

  return { lat: lat, lng: lng, source: sourceType };
}

function appleUrl(point) {
  const coordinate = point.lat + "," + point.lng;
  const label = point.name || coordinate;
  return "https://maps.apple.com/?ll=" + encodeURIComponent(coordinate) + "&q=" + encodeURIComponent(label);
}

function notifySuccess(point) {
  const coordinate = point.lat + "," + point.lng;
  debugLog("success", { coordinate: coordinate, parser: point.source });
  saveTrace("success");
  $notification.post(
    "Google → Apple Maps",
    coordinate + "  (" + point.source + ")",
    "點一下開啟精確座標",
    { action: "open-url", url: appleUrl(point) }
  );
  $done();
}

function notifyFailure(message) {
  if (isHttpRequest) {
    debugLog("passthrough", { reason: message });
    saveTrace("passthrough");
    $done({});
    return;
  }

  debugLog("failure", { reason: message });
  const fullTrace = saveTrace("failure");
  $notification.post(
    "Google → Apple Maps",
    "轉換失敗（點一下複製診斷）",
    message + "\n" + diagnosticHint(),
    { action: "clipboard", text: fullTrace }
  );
  $done();
}

function finishHttpRequest(point) {
  if (!point) {
    saveTrace("passthrough");
    $done({});
    return;
  }

  saveTrace("redirect");
  $done({
    response: {
      status: 302,
      headers: {
        Location: appleUrl(point),
        "Cache-Control": "no-store"
      },
      body: "Google Maps coordinate converted to Apple Maps."
    }
  });
}

function getHeader(headers, name) {
  if (!headers) return "";
  const wanted = name.toLowerCase();

  for (const key in headers) {
    if (key.toLowerCase() === wanted) return String(headers[key] || "");
  }

  return "";
}

function absoluteUrl(location, base) {
  try {
    return new URL(location, base).toString();
  } catch (_) {
    return location;
  }
}

function debugLog(stage, details) {
  let payload = "";

  try {
    payload = JSON.stringify(details || {});
  } catch (_) {
    payload = String(details || "");
  }

  const line = stage + " " + payload;
  traceLines.push(line);
  if (traceLines.length > 20) traceLines.shift();
  console.log(LOG_PREFIX + " " + line);
}

function saveTrace(result) {
  const text = [
    "Google → Apple Maps diagnostic",
    "time=" + new Date().toISOString(),
    "result=" + result
  ].concat(traceLines.map(function (line) {
    return LOG_PREFIX + " " + line;
  })).join("\n");

  try {
    if (typeof $persistentStore !== "undefined") {
      $persistentStore.write(text, LOG_STORE_KEY);
    }
  } catch (error) {
    console.log(LOG_PREFIX + " store-error " + valueToString(error));
  }

  return text;
}

function diagnosticHint() {
  const tail = traceLines.slice(-2).join(" | ");
  return "診斷：" + clip(tail || "無記錄", 420);
}

function describeType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function clip(value, maxLength) {
  const text = valueToString(value);
  if (!text) return "";
  return text.length > maxLength ? text.slice(0, maxLength) + "…" : text;
}
