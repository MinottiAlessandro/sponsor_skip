// Runs in the page's MAIN world (the content script can't read page globals).
// The caption URLs in the web player response are PO-token-gated (they contain
// &exp=xpe and return an empty body), so we DON'T use them. Instead we forward
// just the videoId, title, and InnerTube API key; the content script then calls
// the InnerTube `player` API with the ANDROID client to get an un-gated caption
// URL (the same approach youtube-transcript-api uses).
(function () {
  function getData() {
    const player = document.getElementById("movie_player");
    let pr = null;
    if (player && typeof player.getPlayerResponse === "function") {
      try {
        pr = player.getPlayerResponse();
      } catch (_) {}
    }
    pr = pr || window.ytInitialPlayerResponse || null;
    let apiKey = null;
    try {
      if (window.ytcfg && typeof window.ytcfg.get === "function") {
        apiKey = window.ytcfg.get("INNERTUBE_API_KEY");
      }
    } catch (_) {}
    return {
      videoId: pr?.videoDetails?.videoId || null,
      title: pr?.videoDetails?.title || "",
      apiKey,
    };
  }

  function post() {
    const { videoId, title, apiKey } = getData();
    if (!videoId) return false;
    window.postMessage(
      { source: "ad_skip", type: "video", videoId, title, apiKey },
      "*"
    );
    return true;
  }

  // getPlayerResponse may not be ready the instant we inject; retry briefly.
  if (!post()) {
    let n = 0;
    const id = setInterval(() => {
      if (post() || ++n > 25) clearInterval(id);
    }, 300);
  }
})();
