const axios = require("axios");
const cheerio = require("cheerio");

const UA_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";
const UA_MOB =
  "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/137 Safari/537.36";

function referer(prefix) {
  return prefix === "merlkon"
    ? "https://www.khmerdrama.com/"
    : "https://www.khmeravenue.com/";
}

function cleanTitle(title) {
  return String(title || "")
    .replace(/&#8217;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function posterFromStyle(style) {
  const match = String(style || "").match(/url\((.*?)\)/i);
  return match ? match[1].replace(/['"]/g, "") : "";
}

function normalizeUrl(url = "") {
  return String(url).trim().replace(/\/$/, "");
}

function getSiteUA(prefix) {
  return prefix === "khmerave" ? UA_WIN : UA_MOB;
}

function extractEpisodeNumber(link, text, seriesUrl) {
  const cleanLink = String(link || "").trim().replace(/\/$/, "");
  const cleanSeries = String(seriesUrl || "").trim().replace(/\/$/, "");
  const cleanText = String(text || "").replace(/\s+/g, " ").trim();

  if (cleanLink === cleanSeries) return 1;

  const textMatch = cleanText.match(/episode\s*0*([0-9]+)/i);
  if (textMatch) return parseInt(textMatch[1], 10);

  const dupSuffixMatch = cleanLink.match(/-(\d+)-\d+$/i);
  if (dupSuffixMatch) return parseInt(dupSuffixMatch[1], 10);

  const eSuffixMatch = cleanLink.match(/-(\d+)e-\d+$/i);
  if (eSuffixMatch) return parseInt(eSuffixMatch[1], 10);

  const genericMatch = cleanLink.match(/-(\d+)(?:-|\/|$)/i);
  if (genericMatch) return parseInt(genericMatch[1], 10);

  return null;
}

/* =========================
   CATALOG
========================= */
async function getCatalogItems(prefix, siteConfig, url) {
  try {
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent": UA_WIN,
        Referer: referer(prefix),
      },
      timeout: 15000,
    });

    const $ = cheerio.load(data);
    const items = [];

    $(".card-content").each((_, el) => {
      const link = $(el).find("a").attr("href");
      const title = cleanTitle($(el).find("h3").first().text());
      const style = $(el).find(".card-content-image").attr("style") || "";
      const poster = posterFromStyle(style);

      if (!link || !title) return;

      items.push({
        id: link,
        name: title,
        poster,
      });
    });

    return items;
  } catch (err) {
    console.error("khmerave catalog error:", err.message);
    return [];
  }
}

/* =========================
   EPISODES
========================= */
async function getEpisodes(prefix, seriesUrl) {
  try {
    const { data } = await axios.get(seriesUrl, {
      headers: {
        "User-Agent": getSiteUA(prefix),
        Referer: referer(prefix),
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 15000,
    });

    const $ = cheerio.load(data);
    const pageTitle = $("h1").first().text().trim() || seriesUrl;

    let poster = "";
    const imgDiv = $(".album-content-image").first();
    if (imgDiv.length) {
      poster = posterFromStyle(imgDiv.attr("style") || "");
    }

    const cleanSeries = normalizeUrl(seriesUrl);
    const episodeMap = new Map();

    $("#latest-videos tbody tr").each((_, row) => {
      const a = $(row).find("a[href]").first();
      const link = (a.attr("href") || "").trim();
      const text = a.text();

      if (!link) return;

      const cleanLink = normalizeUrl(link);
      if (!cleanLink.includes("/videos/") && cleanLink !== cleanSeries) return;
      if (cleanLink.includes("?post_type=videos")) return;

      const epNumber = extractEpisodeNumber(link, text, seriesUrl);
      if (!epNumber) return;

      if (!episodeMap.has(epNumber)) {
        episodeMap.set(epNumber, {
          link,
          epNumber,
        });
      }
    });

    if (!episodeMap.size) {
      $("a[href]").each((_, el) => {
        const link = ($(el).attr("href") || "").trim();
        const text = $(el).text();

        if (!link) return;

        const cleanLink = normalizeUrl(link);
        if (!cleanLink.includes("/videos/") && cleanLink !== cleanSeries) return;
        if (cleanLink.includes("?post_type=videos")) return;

        const epNumber = extractEpisodeNumber(link, text, seriesUrl);
        if (!epNumber) return;

        if (!episodeMap.has(epNumber)) {
          episodeMap.set(epNumber, {
            link,
            epNumber,
          });
        }
      });
    }

    const episodes = [...episodeMap.values()].sort((a, b) => a.epNumber - b.epNumber);

    return episodes.map((ep) => ({
      id: ep.epNumber,
      url: ep.link,
      title: pageTitle,
      season: 1,
      episode: ep.epNumber,
      thumbnail: poster,
      released: new Date().toISOString(),
      behaviorHints: {
        group: `${prefix}:${encodeURIComponent(seriesUrl)}`,
      },
    }));
  } catch (err) {
    console.error("khmerave meta error:", err.message);
    return [];
  }
}

/* =========================
   STREAM HELPERS
========================= */
function normalizeOkUrl(url) {
  if (!url) return url;

  let normalized = String(url).trim();

  if (normalized.startsWith("//")) {
    normalized = `https:${normalized}`;
  }

  return normalized.replace("m.ok.ru", "ok.ru");
}

function tryExtractVideoCandidateFromKhmerAvenue(html) {
  const source = String(html || "");

  const b64 = source.match(/Base64\.decode\("(.+?)"\)/i);
  if (b64?.[1]) {
    try {
      const decoded = Buffer.from(b64[1], "base64").toString("utf8");
      const iframeMatch = decoded.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      if (iframeMatch?.[1]) {
        return iframeMatch[1];
      }
    } catch (_) {}
  }

  const patterns = [
    /['"]?file['"]?\s*:\s*['"]([^'"]+)['"]/i,
    /<iframe[^>]*src=["']([^"']+)["']/i,
    /<source[^>]*src=["']([^"']+)["']/i,
    /playlist:\s*["']([^"']+)["']/i,
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

async function resolveOkRuToDirect(iframeUrl, ua) {
  try {
    const okUrl = normalizeOkUrl(iframeUrl);

    const { data } = await axios.get(okUrl, {
      headers: {
        "User-Agent": ua,
        Referer: "https://ok.ru/",
      },
      timeout: 15000,
    });

    let html = String(data || "");

    html = html
      .replace(/\\&quot;/g, '"')
      .replace(/&quot;/g, '"')
      .replace(/\\u0026/g, "&")
      .replace(/\\&/g, "&")
      .replace(/\\\//g, "/");

    const patterns = [
      /"ondemandHls"\s*:\s*"([^"]+)/,
      /"hlsMasterPlaylistUrl"\s*:\s*"([^"]+)/,
      /"hlsManifestUrl"\s*:\s*"([^"]+)/,
      /"(https:[^"]+\.m3u8[^"]*)"/,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        return match[1]
          .replace(/\\u0026/g, "&")
          .replace(/\\&/g, "&");
      }
    }

    return null;
  } catch (err) {
    console.error("OK resolver error:", err.message);
    return null;
  }
}

/* =========================
   STREAM
========================= */
async function getStream(prefix, episodeUrl, episode) {
  try {
    const { data } = await axios.get(episodeUrl, {
      headers: {
        "User-Agent": getSiteUA(prefix),
        Referer: referer(prefix),
      },
      timeout: 15000,
    });

    const html = String(data || "");
    const candidate = tryExtractVideoCandidateFromKhmerAvenue(html);

    if (!candidate) return null;

    const normalizedCandidate = normalizeOkUrl(candidate);

    if (/ok\.ru/.test(normalizedCandidate)) {
      const direct = await resolveOkRuToDirect(normalizedCandidate, UA_MOB);
      if (!direct) return null;

      return {
        title: `Episode ${String(episode).padStart(2, "0")}`,
        url: direct,
        behaviorHints: {
          group: `${prefix}:${encodeURIComponent(episodeUrl)}`,
          notWebReady: true,
          proxyHeaders: {
            request: {
              Referer: "https://ok.ru/",
              "User-Agent": UA_MOB,
            },
          },
        },
      };
    }

    if (/\.(m3u8|mp4)(\?|$)/i.test(normalizedCandidate)) {
      return {
        title: `Episode ${String(episode).padStart(2, "0")}`,
        url: normalizedCandidate,
      };
    }

    return null;
  } catch (err) {
    console.error("khmerave stream error:", err.message);
    return null;
  }
}

module.exports = {
  getCatalogItems,
  getEpisodes,
  getStream,
};