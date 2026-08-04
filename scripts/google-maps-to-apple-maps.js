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

const isHttpRequest = typeof $request !== "undefined" && $request && $request.url;
const source = isHttpRequest ? String($request.url) : firstUrl(getInput());

if (!source) {
  notifyFailure("沒有收到 Google Maps URL");
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

  return String(value || "").trim();
}

function firstUrl(value) {
  const match = String(value || "").match(/https?:\/\/[^\s<>]+/i);
  return (match ? match[0] : String(value || "")).replace(/[),.;]+$/, "");
}

function resolveUrl(url, visited, depth, callback) {
  if (depth > 4 || visited.indexOf(url) !== -1) {
    callback(null);
    return;
  }

  const nextVisited = visited.concat(url);

  $httpClient.get({
    url: url,
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8"
    },
    "auto-redirect": false,
    timeout: 8
  }, function (_error, response, body) {
    const location = response && getHeader(response.headers, "location");
    const page = [url, location || "", String(body || "")].join("\n");
    const point = extractCoordinates(page);

    if (point) {
      callback(point);
      return;
    }

    if (location) {
      const nextUrl = absoluteUrl(location, url);
      if (nextUrl && nextVisited.indexOf(nextUrl) === -1) {
        resolveUrl(nextUrl, nextVisited, depth + 1, callback);
        return;
      }
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

  // Current Google share pages can expose the point in a static-map URL.
  match = text.match(/(?:[?&"']|\b)(?:center|ll|query|q)=(-?\d+(?:\.\d+)?)(?:,|%2c)(-?\d+(?:\.\d+)?)/i);
  if (match) return validPoint(match[1], match[2], "center/ll/query");

  return null;
}

function normalize(value) {
  let text = String(value || "");

  for (let i = 0; i < 3; i++) {
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
    .replace(/%2c/gi, ",")
    .replace(/&amp;/gi, "&");
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
  return "https://maps.apple.com/place?coordinate=" + encodeURIComponent(point.lat + "," + point.lng);
}

function notifySuccess(point) {
  const coordinate = point.lat + "," + point.lng;
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
    $done({});
    return;
  }

  $notification.post("Google → Apple Maps", "轉換失敗", message);
  $done();
}

function finishHttpRequest(point) {
  if (!point) {
    $done({});
    return;
  }

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
