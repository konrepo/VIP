const cheerio = require("cheerio");
const axiosClient = require("../utils/fetch");
const {
  normalizePoster,
  extractVideoLinks,
  extractOkIds
} = require("../utils/helpers");

const { uniqById } = require("../utils/helpers");

/* =========================
   GET CATALOG (Phumi2)
========================= */
async function getCatalogItems(prefix, siteConfig, url) {
  try {
    const { data } = await axiosClient.get(url);
    const $ = cheerio.load(data);

    const posts = $("div.blog-posts div.grid-posts article.blog-post").toArray();

    const results = posts.map((post) => {
      const $el = $(post);

      const a = $el.find("div.post-filter-image a.post-filter-link").first();
      const titleEl = $el.find("h2.entry-title").first();
      const imgEl = $el.find("img.snip-thumbnail").first();

      if (!a.length || !titleEl.length || !imgEl.length) return null;

      const title = titleEl.text().trim();
      const link = a.attr("href");

      if (!title || !link) return null;

      let poster =
        imgEl.attr("data-src") ||
        imgEl.attr("src") ||
        "";

      poster = poster.replace(/\/w\d+-h\d+[^/]+\//, "/s1600/");
      poster = normalizePoster(poster);

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
   BLOGGER JSON EXTRACT
========================= */
function extractBloggerUrls(html) {
  const urls = [];
  const seen = new Set();

  const matches = html.match(/data-post-id="(\d+)"/g) || [];

  for (const m of matches) {
    const id = m.match(/\d+/)?.[0];
    if (!id || seen.has(id)) continue;

    seen.add(id);

    urls.push(
      `https://www.blogger.com/feeds/7871281676618369095/posts/default/${id}?alt=json`
    );
  }

  return urls;
}

/* =========================
   PARSE BLOGGER FEED
========================= */
async function parseBloggerFeed(url) {
  try {
    const { data } = await axiosClient.get(url);

    const content = data.entry?.content?.$t || "";

    let urls = extractVideoLinks(content);

    if (!urls.length) {
      const okIds = extractOkIds(content);
      if (okIds.length) {
        urls = okIds.map(id => `https://ok.ru/videoembed/${id}`);
      }
    }

    return urls;

  } catch {
    return [];
  }
}

/* =========================
   EPISODES
========================= */
async function getEpisodes(prefix, seriesUrl) {
  try {
    const { data } = await axiosClient.get(seriesUrl);

    const bloggerFeeds = extractBloggerUrls(data);

    let allLinks = [];
    let seen = new Set();

    for (const feed of bloggerFeeds) {
      const links = await parseBloggerFeed(feed);

      for (const url of links) {
        if (!url || seen.has(url)) continue;
        seen.add(url);
        allLinks.push(url);
      }
    }

    return allLinks.map((url, index) => ({
      id: `${prefix}:${encodeURIComponent(seriesUrl)}:1:${index + 1}`,
      title: `Episode ${index + 1}`,
      season: 1,
      episode: index + 1,
      thumbnail: "",
      released: new Date().toISOString(),
    }));

  } catch {
    return [];
  }
}

/* =========================
   RESOLVE OK.RU
========================= */
async function resolveOkEmbed(embedUrl) {
  try {
    const { data } = await axiosClient.get(embedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://ok.ru/"
      }
    });

    const match =
      data.match(/\\&quot;ondemandHls\\&quot;:\\&quot;(https:\/\/[^"]+?\.m3u8)/) ||
      data.match(/&quot;ondemandHls&quot;:&quot;(https:\/\/[^"]+?\.m3u8)/);

    if (!match) return null;

    return match[1]
      .replace(/\\u0026/g, "&")
      .replace(/\\\//g, "/");

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
    const episodes = await getEpisodes(prefix, seriesUrl);
    const ep = episodes.find(e => e.episode === episode);

    if (!ep) return null;

    const index = episode - 1;

    const { data } = await axiosClient.get(seriesUrl);
    const feeds = extractBloggerUrls(data);

    let allLinks = [];

    for (const feed of feeds) {
      const links = await parseBloggerFeed(feed);
      allLinks.push(...links);
    }

    let url = allLinks[index];
    if (!url) return null;

    if (url.includes("ok.ru/videoembed/")) {
      const resolved = await resolveOkEmbed(url);
      if (resolved) url = resolved;
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