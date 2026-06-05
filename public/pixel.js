/* track-helmer first-party pixel. Self-contained (no Meta fbevents.js needed):
   generates _fbp, derives fbc from fbclid, captures UTMs, sends events to /collect.
*/
(function () {
  var ENDPOINT = (document.currentScript && document.currentScript.src
    ? document.currentScript.src.replace(/\/pixel\.js.*$/, "")
    : "https://track.helmer.com.br") + "/collect";
  var YEAR = 31536000;

  function cookie(name, value, maxAge) {
    if (value === undefined) {
      var m = document.cookie.match("(^|;)\\s*" + name + "\\s*=\\s*([^;]+)");
      return m ? decodeURIComponent(m.pop()) : null;
    }
    var d = ";domain=" + (location.hostname.replace(/^www\./, "."));
    document.cookie =
      name + "=" + encodeURIComponent(value) + ";path=/;max-age=" + (maxAge || YEAR) +
      d + ";SameSite=Lax" + (location.protocol === "https:" ? ";Secure" : "");
  }
  function uuid() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
        var r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });
  }
  function qp(name) {
    return new URLSearchParams(location.search).get(name);
  }

  var visitorId = cookie("th_vid") || uuid();
  cookie("th_vid", visitorId);

  var fbp = cookie("_fbp");
  if (!fbp) { fbp = "fb.1." + Date.now() + "." + Math.floor(Math.random() * 1e16); cookie("_fbp", fbp); }

  var fbclid = qp("fbclid");
  var fbc = cookie("_fbc");
  if (!fbc && fbclid) { fbc = "fb.1." + Date.now() + "." + fbclid; cookie("_fbc", fbc); }

  var KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "xcod"];
  var attr = {};
  var hasNew = false;
  KEYS.forEach(function (k) { var v = qp(k); if (v) { attr[k] = v; hasNew = true; } });
  if (hasNew) cookie("th_attr", JSON.stringify(attr)); else { try { attr = JSON.parse(cookie("th_attr") || "{}"); } catch (e) { attr = {}; } }

  var sessionId = sessionStorage.getItem("th_sid") || uuid();
  sessionStorage.setItem("th_sid", sessionId);

  function send(eventName, custom) {
    var payload = Object.assign({
      event_id: uuid(),
      event_name: eventName,
      event_time: Date.now(),
      visitor_id: visitorId,
      session_id: sessionId,
      fbp: fbp, fbc: fbc, fbclid: fbclid,
      page_url: location.href, referrer: document.referrer
    }, attr, custom || {});
    try {
      navigator.sendBeacon
        ? navigator.sendBeacon(ENDPOINT, new Blob([JSON.stringify(payload)], { type: "application/json" }))
        : fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), keepalive: true });
    } catch (e) {}
    return payload.event_id;
  }

  window.thelmer = { track: send, visitorId: visitorId, attr: attr };
  send("PageView");
})();
