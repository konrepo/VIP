const cheerio = require("cheerio");
const axiosClient = require("../utils/fetch");
const {
  normalizePoster,
  extractVideoLinks,
  extractMaxEpFromTitle,
  extractOkIds,
  uniqById
} = require("../utils/helpers");
const { URL_TO_POSTID, POST_INFO, BLOG_IDS } = require("../utils/cache");

/* =========================
   CONFIG
========================= */
const PAGE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
};

const PHUMI_FEED_IDS = [
  BLOG_IDS.SUNDAY1,
  BLOG_IDS.SUNDAY2,
  BLOG_IDS.SUNDAY3,
  BLOG_IDS.SUNDAY4
].filter(Boolean);

/* =========================
   HELPERS
========================= */
function absolutizeUrl(url, baseUrl) {
  if (!url) return "";
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

function cleanTitle(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function normalizePhumiPoster(url) {
  if (!url) return "";
  return normalizePoster(
    url
      .replace(/\/w\d+-h\d+[^/]*\//gi, "/s0/")
      .replace(/\/s\d+(-c)?\//gi, "/s0/")
      .replace(/=w\d+-h\d+[^&]*/gi, "=s0")
      .replace(/=s\d+(-c)?/gi, "=s0")
  );
}

function extractOlderLink($, baseUrl) {
  const candidates = [
    $("a.blog-pager-older-link").attr("href"),
    $("#Blog1_blog-pager-older-link").attr("href"),
    $(".blog-pager-older-link").attr("href"),
    $('a[rel="next"]').attr("href")
  ];

  const found = candidates.find(Boolean);
  return found ? absolutizeUrl(found, baseUrl) : null;
}

function extractGridItems($, prefix, pageUrl) {
  const items = [];
  const posts = $("div.blog-posts div.grid-posts article.blog-post").toArray();

  for (const post of posts) {
    const $el = $(post);

    const linkEl =
      $el.find("div.post-filter-image a.post-filter-link").first().length
        ? $el.find("div.post-filter-image a.post-filter-link").first()
        : $el.find("h2.entry-title a").first();

    const titleEl = $el.find("h2.entry-title").first();
    const imgEl = $el.find("img.snip-thumbnail").first();

    const link = absolutizeUrl(linkEl.attr("href") || "", pageUrl);
    const title =
      cleanTitle(linkEl.attr("title")) ||
      cleanTitle(titleEl.text()) ||
      cleanTitle(linkEl.text());

    if (!title || !link) continue;

    let poster =
      imgEl.attr("data-src") ||
      imgEl.attr("src") ||
      linkEl.find("img").attr("data-src") ||
      linkEl.find("img").attr("src") ||
      $('meta[property="og:image"]').attr("content") ||
      "";

    poster = normalizePhumiPoster(poster);

    items.push({
      id: `${prefix}:${encodeURIComponent(link)}`,
      name: title,
      poster
    });
  }

  return items;
}

function extractPostIds(html) {
  const ids = new Set();

  const dataPostMatches = html.match(/data-post-id="(\d+)"/g) || [];
  for (const m of dataPostMatches) {
    const id = m.match(/\d+/)?.[0];
    if (id) ids.add(id);
  }

  const feedMatches =
    html.match(/blogger\.com\/feeds\/\d+\/posts\/default\/(\d+)\?alt=json/gi) || [];
  for (const m of feedMatches) {
    const id = m.match(/posts\/default\/(\d+)\?alt=json/i)?.[1];
    if (id) ids.add(id);
  }

  return Array.from(ids);
}

function getPosterFromContent(content) {
  try {
    const $content = cheerio.load(content || "");
    const poster =
      $content('meta[property="og:image"]').attr("content") ||
      $content('meta[name="twitter:image"]').attr("content") ||
      $content("img").first().attr("src") ||
      "";
    return normalizePhumiPoster(poster);
  } catch {
    return "";
  }
}

/* =========================
   GET POST ID
========================= */
async function getPostId(url) {
  if (URL_TO_POSTID.has(url)) {
    return URL_TO_POSTID.get(url);
  }

  try {
    const { data } = await axiosClient.get(url, { headers: PAGE_HEADERS });
    const $ = cheerio.load(data);

    let postId =
      $("#player").attr("data-post-id") ||
      $('div[id="fanta"][data-post-id]').first().attr("data-post-id") ||
      null;

    if (!postId) {
      const ids = extractPostIds(data);
      if (ids.length === 1) {
        postId = ids[0];
      }
    }

    if (!postId) return null;

    const pageTitle = $("title").text();
    let maxEp = extractMaxEpFromTitle(pageTitle);

    if (!maxEp) {
      const headingText =
        $("h1.entry-title").first().text() ||
        $("meta[property='og:title']").attr("content") ||
        "";
      maxEp = extractMaxEpFromTitle(headingText);
    }

    if (!maxEp) {
      const m = data.match(/\[(\d+)\s*(?:End|EP)\]/i);
      if (m) maxEp = parseInt(m[1], 10);
    }

    URL_TO_POSTID.set(url, postId);

    if (maxEp) {
      POST_INFO.set(postId, {
        ...(POST_INFO.get(postId) || {}),
        maxEp
      });
    }

    return postId;
  } catch {
    return null;
  }
}

/* =========================
   BLOGGER FETCH
========================= */
async function fetchFromBlog(blogId, postId) {
  const feedUrl = `https://www.blogger.com/feeds/${blogId}/posts/default/${postId}?alt=json`;

  try {
    const { data } = await axiosClient.get(feedUrl);

    const title = cleanTitle(data.entry?.title?.$t || "");
    const content = data.entry?.content?.$t || "";

    let thumbnail =
      data.entry?.media$thumbnail?.url ||
      getPosterFromContent(content) ||
      "";

    thumbnail = normalizePhumiPoster(thumbnail);

    let urls = extractVideoLinks(content);

    if (!urls.length) {
      const okIds = extractOkIds(content);
      if (okIds.length) {
        urls = okIds.map((id) => `https://ok.ru/videoembed/${id}`);
      }
    }

    if (!urls.length) return null;

    return {
      title,
      thumbnail,
      urls
    };
  } catch {
    return null;
  }
}

/* =========================
   STREAM DETAIL
========================= */
async function getStreamDetail(postId) {
  const cached = POST_INFO.get(postId);
  if (cached?.detail) return cached.detail;

  const results = await Promise.all(
    PHUMI_FEED_IDS.map((blogId) => fetchFromBlog(blogId, postId))
  );

  const detail = results.find(Boolean);
  if (!detail) return null;

  POST_INFO.set(postId, {
    ...(POST_INFO.get(postId) || {}),
    detail
  });

  return detail;
}

/* =========================
   CATALOG
========================= */
async function getCatalogItems(prefix, siteConfig, url) {
  try {
    const { data } = await axiosClient.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
        Referer: siteConfig.baseUrl || url
      }
    });

    const $ = cheerio.load(data);
    const posts = $("div.blog-posts div.grid-posts article.blog-post").toArray();

    const results = posts.map((post) => {
      const $el = $(post);

      const a =
        $el.find("div.post-filter-image a.post-filter-link").first().length
          ? $el.find("div.post-filter-image a.post-filter-link").first()
          : $el.find("h2.entry-title a").first();

      const titleEl = $el.find("h2.entry-title").first();
      const imgEl = $el.find("img.snip-thumbnail").first();

      const title =
        (a.attr("title") || "").trim() ||
        titleEl.text().trim() ||
        a.text().trim();

      const link = a.attr("href");
      if (!title || !link) return null;

      let poster =
        imgEl.attr("data-src") ||
        imgEl.attr("src") ||
        a.find("img").attr("data-src") ||
        a.find("img").attr("src") ||
        "";

      poster = normalizePoster(
        poster
          .replace(/\/w\d+-h\d+[^/]*\//gi, "/s0/")
          .replace(/\/s\d+(-c)?\//gi, "/s0/")
          .replace(/=w\d+-h\d+[^&]*/gi, "=s0")
          .replace(/=s\d+(-c)?/gi, "=s0")
      );

      return {
        id: `${prefix}:${encodeURIComponent(link)}`,
        name: title,
        poster
      };
    });

    return uniqById(results.filter(Boolean));
  } catch {
    return [];
  }
}

/* =========================
   EPISODES
========================= */
async function getEpisodes(prefix, seriesUrl) {
  try {
    const postId = await getPostId(seriesUrl);
    if (!postId) return [];

    const detail = await getStreamDetail(postId);
    if (!detail?.urls?.length) return [];

    const cachedInfo = POST_INFO.get(postId) || {};
    let urls = [...new Set(detail.urls)];

    if (cachedInfo.maxEp && urls.length > cachedInfo.maxEp) {
      urls = urls.slice(0, cachedInfo.maxEp);
    }

    return urls.map((url, index) => ({
      id: `${prefix}:${encodeURIComponent(seriesUrl)}:1:${index + 1}`,
      title: detail.title || `Episode ${index + 1}`,
      season: 1,
      episode: index + 1,
      thumbnail: detail.thumbnail || "",
      released: new Date().toISOString()
    }));
  } catch {
    return [];
  }
}

/* =========================
   RESOLVE PLAYER
========================= */
async function resolvePlayerUrl(playerUrl) {
  try {
    const { data } = await axiosClient.get(playerUrl, {
      headers: {
        ...PAGE_HEADERS,
        Referer: playerUrl
      }
    });

    const html = String(data)
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&");

    const match = html.match(
      /https?:\/\/phumikhmer\.vip\/player\.php\?stream=[^"'<> ]+/i
    );

    return match ? match[0] : null;
  } catch {
    return null;
  }
}

/* =========================
   RESOLVE OK
========================= */
async function resolveOkEmbed(embedUrl) {
  try {
    const { data } = await axiosClient.get(embedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://ok.ru/",
        Origin: "https://ok.ru"
      }
    });

    const hlsMatch =
      data.match(/\\&quot;ondemandHls\\&quot;:\\&quot;(https:\/\/[^"]+?\.m3u8)/) ||
      data.match(/&quot;ondemandHls&quot;:&quot;(https:\/\/[^"]+?\.m3u8)/);

    if (!hlsMatch) return null;

    return hlsMatch[1]
      .replace(/\\u0026/g, "&")
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&")
      .replace(/\\&quot;.*/g, "");
  } catch {
    return null;
  }
}

/* =========================
   BUILD STREAM
========================= */
function buildStream(url, episode) {
  const isOk = /ok\.ru|okcdn\.ru/i.test(url);

  return {
    url,
    name: "Phumi2",
    title: `Episode ${episode}`,
    type: url.includes(".m3u8") ? "hls" : undefined,
    behaviorHints: isOk
      ? {
          group: "phumi2",
          proxyHeaders: {
            request: {
              Referer: "https://ok.ru/",
              Origin: "https://ok.ru"
            }
          }
        }
      : { group: "phumi2" }
  };
}

/* =========================
   STREAM
========================= */
async function getStream(prefix, seriesUrl, episode) {
  try {
    const postId = await getPostId(seriesUrl);
    if (!postId) return null;

    const detail = await getStreamDetail(postId);
    if (!detail?.urls?.length) return null;

    const cachedInfo = POST_INFO.get(postId) || {};
    let urls = [...new Set(detail.urls)];

    if (cachedInfo.maxEp && urls.length > cachedInfo.maxEp) {
      urls = urls.slice(0, cachedInfo.maxEp);
    }

    let url = urls[episode - 1];
    if (!url) return null;

    if (url.includes("player.php")) {
      const resolved = await resolvePlayerUrl(url);
      if (!resolved) return null;
      url = resolved;
    }

    if (url.includes("ok.ru/videoembed/")) {
      const resolved = await resolveOkEmbed(url);
      if (!resolved) return null;
      url = resolved;
    }

    return buildStream(url, episode);
  } catch {
    return null;
  }
}

module.exports = {
  getCatalogItems,
  getEpisodes,
  getStream
};