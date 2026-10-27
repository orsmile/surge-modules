// Rewrites Meta media URLs (Hong Kong PoPs and HiNet's Taipei FNA nodes) to
// HiNet's Kaohsiung FNA node, only on the home network.  Signed media URLs are
// not bound to a host, and one FNA node's names share a cache.  Elsewhere
// (e.g. cellular) the request passes through unchanged.
const HOME_ROUTER = '192.168.8.1';
const TARGET = 'fkhh1-1.fna.fbcdn.net';

const atHome = $network && $network.v4 && $network.v4.primaryRouter === HOME_ROUTER &&
    $network.wifi && $network.wifi.ssid;
const m = atHome && $request.url.match(
    /^https:\/\/(?:(video|scontent|instagram)-hkg\d+-\d+\.(?:xx\.fbcdn\.net|cdninstagram\.com)|(video|scontent|instagram)\.ftpe[78]-\d\.fna\.fbcdn\.net)(\/.*)$/);

if (m) {
    const kind = (m[1] || m[2]) === 'video' ? 'video' : 'scontent';
    const url = `https://${kind}.${TARGET}${m[3]}`;
    const headers = Object.assign({}, $request.headers);
    for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === 'host') headers[k] = `${kind}.${TARGET}`;
    }
    $done({ url, headers });
} else {
    $done({});
}
