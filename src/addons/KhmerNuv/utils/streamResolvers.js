const axiosClient = require("./fetch");

/* =========================
   HELPERS
========================= */
function cleanUrl(url = "") {
  return String(url)
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/\\&quot;/g, "")
    .replace(/&quot;/g, "")
    .trim();
}

function extractPlayableUrl(html = "") {
  const text = cleanUrl(html);

  const patterns = [
    /https?:\/\/[^\s"'<>]+\.m3u8(?:\?[^\s"'<>]+)?/i,
    /https?:\/\/[^\s"'<>]+\.mp4(?:\?[^\s"'<>]+)?/i,
    /https?:\/\/ok\.ru\/videoembed\/\d+/i,
    /https?:\/\/www\.dailymotion\.com\/embed\/video\/[a-zA-Z0-9]+/i,
    /https?:\/\/drive\.google\.com\/file\/d\/[a-zA-Z0-9_-]+\/preview/i,
    /https?:\/\/phumikhmer\.vip\/player\.php\?(?:id|stream)=[^"'<> ]+/i
  ];

  for (const re of patterns) {
    const match = text.match(re);
    if (match) return cleanUrl(match[0]);
  }

  return null;
}

/* =========================
   PLAYER RESOLVE
========================= */
async function resolvePlayerUrl(playerUrl, depth = 0) {
  try {
    console.log("[resolvePlayerUrl] start:", { playerUrl, depth });

    if (!playerUrl || depth > 3) {
      console.log("[resolvePlayerUrl] stop: invalid url or max depth");
      return null;
    }

    playerUrl = String(playerUrl)
      .trim()
      .replace(/;+$/, ""); // remove trailing semicolons

    console.log("[resolvePlayerUrl] cleaned playerUrl:", playerUrl);

    const { data } = await axiosClient.get(playerUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://phumikhmer.vip/"
      }
    });

    const html = typeof data === "string" ? data : JSON.stringify(data);
    console.log("[resolvePlayerUrl] html length:", html.length);
    console.log("[resolvePlayerUrl] html preview:", html.slice(0, 1000));

    const found = extractPlayableUrl(html);
    console.log("[resolvePlayerUrl] found:", found);

    if (!found) return null;

    if (
      /phumikhmer\.vip\/player\.php\?(?:id|stream)=/i.test(found) &&
      found !== playerUrl
    ) {
      console.log("[resolvePlayerUrl] recursive resolve:", found);
      return resolvePlayerUrl(found, depth + 1);
    }

    return found;
  } catch (err) {
    console.log("[resolvePlayerUrl] error:", err.message);
    return null;
  }
}

/* =========================
   RESOLVE OK
========================= */
async function resolveOkEmbed(embedUrl) {
  try {
    console.log("[resolveOkEmbed] start:", embedUrl);

    const { data } = await axiosClient.get(embedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://ok.ru/",
        Origin: "https://ok.ru"
      }
    });

    const html = typeof data === "string" ? data : JSON.stringify(data);
    console.log("[resolveOkEmbed] html length:", html.length);

    const patterns = [
      /\\&quot;ondemandHls\\&quot;:\\&quot;(https:\/\/[^"]+?\.m3u8[^"]*)/i,
      /&quot;ondemandHls&quot;:&quot;(https:\/\/[^"]+?\.m3u8[^"]*)/i,
      /"ondemandHls":"(https:\/\/[^"]+?\.m3u8[^"]*)/i,
      /"hlsMasterPlaylistUrl":"(https:\/\/[^"]+?\.m3u8[^"]*)/i,
      /"hlsManifestUrl":"(https:\/\/[^"]+?\.m3u8[^"]*)/i
    ];

    for (const re of patterns) {
      const match = html.match(re);
      if (match) {
        const finalUrl = cleanUrl(match[1]).replace(/\\&quot;.*/g, "");
        console.log("[resolveOkEmbed] found:", finalUrl);
        return finalUrl;
      }
    }

    console.log("[resolveOkEmbed] no hls found");
    return null;
  } catch (err) {
    console.log("[resolveOkEmbed] error:", err.message);
    return null;
  }
}

/* =========================
   BUILD STREAM
========================= */
function buildStream(
  url,
  episode,
  title,
  name = "KhmerDub",
  group = "khmerdub",
  options = {}
) {
  const { forceProxyHeaders = false } = options;

  const needsOkHeaders =
    forceProxyHeaders || /ok\.ru|okcdn\.ru/i.test(url);

  return {
    url,
    name,
    title: title || `Episode ${episode}`,
    type: /\.m3u8(\?|$)/i.test(url) ? "hls" : undefined,
    behaviorHints: needsOkHeaders
      ? {
          group,
          proxyHeaders: {
            request: {
              Referer: "https://ok.ru/",
              Origin: "https://ok.ru"
            }
          }
        }
      : { group }
  };
}

module.exports = {
  resolvePlayerUrl,
  resolveOkEmbed,
  buildStream
};
