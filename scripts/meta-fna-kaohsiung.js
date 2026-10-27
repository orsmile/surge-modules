// Moves Meta media (FB, IG, Threads) from Hong Kong PoPs and HiNet's Taipei
// FNA nodes to HiNet's Kaohsiung FNA node, but only while the current network
// is HiNet (AS3462).  Signed media URLs are not bound to a host, and one FNA
// node's names share a cache.  One file serves three script types:
//   event         on network change, look up the network's ASN and store it
//   rule          reject QUIC to Meta's CDN on HiNet so the apps use TCP
//   http-request  rewrite the media URL on HiNet
const KEY = 'meta_fna_kaohsiung';
const TARGET = 'fkhh1-1.fna.fbcdn.net';
const HINET = /^AS3462\b/;
const CDN = /(^|\.)(fbcdn\.net|cdninstagram\.com)$/;
const MEDIA = /^https:\/\/(?:(video|scontent|instagram)-hkg\d+-\d+\.(?:xx\.fbcdn\.net|cdninstagram\.com)|(video|scontent|instagram)\.ftpe[78]-\d\.fna\.fbcdn\.net)(\/.*)$/;
const LOOKUP_TRIES = 3;
const LOOKUP_GAP_MS = 3000;

// Identifies the network the device is on; a stored lookup applies only to it.
function networkId() {
    const n = $network || {};
    const wifi = n.wifi || {};
    const cell = n['cellular-data'] || {};
    const v4 = n.v4 || {};
    return [wifi.bssid || wifi.ssid || '', cell.carrier || '', v4.primaryRouter || '', v4.primaryAddress || ''].join('|');
}

function onHinet() {
    try {
        const s = JSON.parse($persistentStore.read(KEY) || 'null');
        return !!s && s.net === networkId() && s.hinet;
    } catch (e) {
        return false;
    }
}

function lookup(tries) {
    const net = networkId();
    // DIRECT so the answer is the network's own address, not a proxy's.
    $httpClient.get({ url: 'https://ipinfo.io/org', policy: 'DIRECT', timeout: 5 }, (err, resp, body) => {
        const org = !err && resp && resp.status === 200 ? String(body || '').trim() : '';
        if (!org) {
            if (tries > 1) return setTimeout(() => lookup(tries - 1), LOOKUP_GAP_MS);
            $persistentStore.write(null, KEY);
            console.log('[meta-fna] ASN lookup failed; leaving Meta untouched');
            return $done();
        }
        const hinet = HINET.test(org);
        $persistentStore.write(JSON.stringify({ net, hinet, ts: Date.now() }), KEY);
        console.log(`[meta-fna] ${hinet ? 'HiNet: rewriting to ' + TARGET : 'not HiNet: leaving Meta untouched'}`);
        $done();
    });
}

if (typeof $event !== 'undefined') {
    lookup(LOOKUP_TRIES);
} else if (typeof $argument !== 'undefined' && $argument === 'rule') {
    const quic = /^(quic|udp)$/i.test(String($request.protocol || ''));
    $done({ matched: quic && CDN.test($request.hostname || '') && onHinet() });
} else {
    const m = onHinet() && $request.url.match(MEDIA);
    if (!m) {
        $done({});
    } else {
        const host = `${(m[1] || m[2]) === 'video' ? 'video' : 'scontent'}.${TARGET}`;
        const headers = Object.assign({}, $request.headers);
        for (const k of Object.keys(headers)) {
            if (k.toLowerCase() === 'host') headers[k] = host;
        }
        $done({ url: `https://${host}${m[3]}`, headers });
    }
}
