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

function decodeBase64Url(value = "") {
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return "";
  }
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
      .replace(/;+$/, "");

    console.log("[resolvePlayerUrl] cleaned playerUrl:", playerUrl);

    // DIRECT HANDLE: player.php?stream=<base64>&ext=.mp4
    const streamMatch = playerUrl.match(
      /[?&]stream=([^&]+)(?:&ext=(\.\w+))?/i
    );

    if (streamMatch) {
      const encoded = decodeURIComponent(streamMatch[1]);
      const decoded = cleanUrl(decodeBase64Url(encoded));
      const ext = streamMatch[2] || "";

      console.log("[resolvePlayerUrl] stream param found");
      console.log("[resolvePlayerUrl] decoded stream:", decoded);
      console.log("[resolvePlayerUrl] ext:", ext);

      if (decoded && /^https?:\/\//i.test(decoded)) {
        if (ext && !decoded.includes(ext) && !/\.(mp4|m3u8)(\?|$)/i.test(decoded)) {
          const finalUrl = decoded + ext;
          console.log("[resolvePlayerUrl] final decoded with ext:", finalUrl);
          return finalUrl;
        }

        console.log("[resolvePlayerUrl] final decoded:", decoded);
        return decoded;
      }
    }

    const { data } = await axiosClient.get(playerUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://phumikhmer.vip/"
      }
    });

    const html = typeof data === "string" ? data : JSON.stringify(data);
    console.log("[resolvePlayerUrl] html length:", html.length);
    console.log("[resolvePlayerUrl] html preview:", html.slice(0, 1200));

    const found = extractPlayableUrl(html);
    console.log("[resolvePlayerUrl] found:", found);

    if (!found) return null;

    // If it found another player.php?stream=... then decode next round
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
