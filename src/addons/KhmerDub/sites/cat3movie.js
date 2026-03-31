const cheerio = require("cheerio");
const axiosClient = require("../utils/fetch");

const { normalizePoster, uniqById } = require("../utils/helpers");
const { buildStream } = require("../utils/streamResolvers");

/* =========================
   CONFIG
========================= */
const BASE_URL = "https://www.cat3movie.club";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/137 Mobile Safari/537.36"
};

/* =========================
   HELPERS
========================= */
function absolutize(url, base = BASE_URL) {
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

function cleanTitle(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function cleanMovieTitle(title) {
  return cleanTitle(title)
    .replace(/\|\s*Free Sexy Movies.*$/i, "")
    .replace(/\|\s*Full\s+.*$/i, "")
    .replace(/\bFull\s+.*Movie.*$/i, "")
    .replace(/\bOnline\s+Free.*$/i, "")
    .trim();
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

/* =========================
   JWPLAYER PARSER
========================= */
function extractSources(html) {
  const sources = [
    ...html.matchAll(/file\s*:\s*["']([^"']+)["']/gi)
  ]
    .map(m => String(m[1] || "").trim())
    .filter(url =>
      url &&
      url !== "#" &&
      /^https?:\/\//i.test(url) &&
      (/\.(mp4|m3u8)(\?|$)/i.test(url) || /\/video\//i.test(url))
    );

  return uniq(sources);
}

/* =========================
   DETAIL
========================= */
async function getDetail(url) {
  try {
    console.log("[cat3] Fetching detail:", url);

    const { data } = await axiosClient.get(url, {
      headers: HEADERS
    });

    const $ = cheerio.load(data);

    const title = cleanMovieTitle(
      $("h1.single-post-title").text() ||
      $('meta[property="og:title"]').attr("content") ||
      $("title").text()
    );

    let poster =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[name="twitter:image"]').attr("content") ||
      "";

    poster = normalizePoster(absolutize(poster, url));

    const category =
      $('nav[aria-label="Breadcrumbs"] .bf-breadcrumb-item a')
        .last()
        .text()
        .trim() ||
      $(".term-badges.floated .term-badge a").first().text().trim() ||
      "";

    const sources = extractSources(data);

    console.log("[cat3] Title:", title);
    console.log("[cat3] Category:", category);
    console.log("[cat3] Sources found:", sources);

    return {
      title,
      poster,
      category,
      sources
    };
  } catch (e) {
    console.log("[cat3] getDetail error:", e.message);
    return null;
  }
}

/* =========================
   CATALOG
========================= */
async function getCatalogItems(prefix, siteConfig, url) {
  try {
    const pageUrl = url || BASE_URL;

    const { data } = await axiosClient.get(pageUrl, {
      headers: HEADERS
    });

    const $ = cheerio.load(data);

    const posts = $("article[class*='listing-item']").toArray();

    const results = posts.map(el => {
      const $el = $(el);

      const linkEl = $el.find("h2.title a").first();

      const link = absolutize(linkEl.attr("href"), pageUrl);
      const title = cleanMovieTitle(
        linkEl.attr("title") || linkEl.text()
      );

      if (!link || !title) return null;

      let poster =
        $el.find("a.img-holder").attr("data-src") ||
        $el.find("a.img-holder").attr("src") ||
        $el.find("img").attr("data-src") ||
        $el.find("img").attr("src");

      poster = normalizePoster(absolutize(poster, pageUrl));

      const category = $el
        .find(".featured .term-badges .term-badge a")
        .first()
        .text()
        .trim();

      console.log("[cat3] category:", category);

      return {
        id: `${prefix}:${encodeURIComponent(link)}`,
        name: category ? `[${category}] ${title}` : title,
        poster
      };
    });

    return uniqById(results.filter(Boolean));
  } catch {
    return [];
  }
}

/* =========================
   NEXT PAGE
========================= */
function getNextPageUrl(base, html) {
  const $ = cheerio.load(html);

  const next =
    $("a.next.page-numbers").attr("href") ||
    $('a[rel="next"]').attr("href");

  return next ? absolutize(next, base) : null;
}

/* =========================
   EPISODES (single movie)
========================= */
async function getEpisodes(prefix, url) {
  const detail = await getDetail(url);
  if (!detail?.sources?.length) return [];

  return [
    {
      id: `${prefix}:${encodeURIComponent(url)}`,
      title: detail.category ? `[${detail.category}] ${detail.title}` : detail.title,
      season: 1,
      episode: 1,
      thumbnail: detail.poster
    }
  ];
}

/* =========================
   STREAM
========================= */
async function getStream(prefix, url, epNum = 1) {
  console.log("[cat3] getStream called:", url);

  try {
    const { data } = await axiosClient.get(url, { headers: HEADERS });
    const $ = cheerio.load(data);

    const streams = [];

    // 1. Server list links
    $("#server-list a").each((i, el) => {
      const link = $(el).attr("href");
      const label = $(el).text().trim() || `Server ${i + 1}`;

      if (link && /^https?:\/\//i.test(link)) {
        streams.push({
          title: `Cat3Movie - ${label}`,
          url: link
        });
      }
    });

    // 2. iframe fallback
    if (!streams.length) {
      const iframeSrc = $("#movie-player iframe").attr("src");
      if (iframeSrc && /^https?:\/\//i.test(iframeSrc)) {
        streams.push({
          title: "Cat3Movie - Server 1",
          url: iframeSrc
        });
      }
    }

    // 3. direct file fallback
    if (!streams.length) {
      const detail = await getDetail(url);

      if (detail?.sources?.length) {
        detail.sources.forEach((src, i) => {
          streams.push(
            buildStream(
              src,
              epNum,
              `${detail.title} - Server ${i + 1}`,
              "Cat3Movie",
              "cat3"
            )
          );
        });
      }
    }

    // Convert raw iframe/server links to stream objects
    const finalStreams = streams.map((s, i) => {
      if (s.behaviorHints || s.name) return s;

      return {
        name: s.title || `Cat3Movie - Server ${i + 1}`,
        title: s.title || `Cat3Movie - Server ${i + 1}`,
        url: s.url,
        behaviorHints: {
          notWebReady: false
        }
      };
    });

    console.log("[cat3] Streams:", finalStreams.length);
    return finalStreams.length ? finalStreams : null;

  } catch (e) {
    console.log("[cat3] getStream error:", e.message);
    return null;
  }
}

module.exports = {
  getCatalogItems,
  getEpisodes,
  getStream,
  getNextPageUrl
};