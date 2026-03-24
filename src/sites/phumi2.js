const cheerio = require("cheerio");
const axiosClient = require("../utils/fetch");
const {
  normalizePoster,
  extractVideoLinks,
  extractOkIds,
  extractMaxEpFromTitle,
  uniqById
} = require("../utils/helpers");

const {
  URL_TO_POSTID,
  POST_INFO,
  BLOG_IDS
} = require("../utils/cache");

/* =========================
   CONFIG
========================= */
const PHUMI2_BLOG_IDS = [
  BLOG_IDS.SUNDAY1,
  BLOG_IDS.SUNDAY2,
  BLOG_IDS.SUNDAY3,
  BLOG_IDS.SUNDAY4
].filter(Boolean);

/* =========================
   GET POST ID
========================= */
async function getPostId(url) {
  if (URL_TO_POSTID.has(url)) {
    return URL_TO_POSTID.get(url);
  }

  const { data } = await axiosClient.get(url);
  const $ = cheerio.load(data);

  let postId = null;

  // Common player container
  postId = $("#player").attr("data-post-id");

  // Generic fallback
  if (!postId) {
    const fanta = $('div[id="fanta"][data-post-id]').first();
    if (fanta.length) {
      postId = fanta.attr("data-post-id");
    }
  }

  // Blogger feed fallback
  if (!postId) {
    const match = data.match(
      /blogger\.com\/feeds\/\d+\/posts\/default\/(\d+)\?alt=json/i
    );
    if (match) {
      postId = match[1];
    }
  }

  // Final fallback: any data-post-id in page
  if (!postId) {
    const generic = data.match(/data-post-id=["'](\d+)["']/i);
    if (generic) {
      postId = generic[1];
    }
  }

  if (!postId) {
    return null;
  }

  // Max episode from page title
  const pageTitle = $("title").text().trim();
  let maxEp = extractMaxEpFromTitle(pageTitle);

  // Extra fallback for strings like: [35 End]
  if (!maxEp) {
    const altText =
      $("h1.entry-title").first().text().trim() ||
      $("meta[property='og:title']").attr("content") ||
      "";

    maxEp = extractMaxEpFromTitle(altText);
  }

  URL_TO_POSTID.set(url, postId);

  if (maxEp) {
    POST_INFO.set(postId, {
      ...(POST_INFO.get(postId) || {}),
      maxEp
    });
  }

  return postId;
}

/* =========================
   FETCH BLOGGER POST DETAIL
========================= */
async function fetchFromBlog(blogId, postId) {
  const feedUrl = `https://www.blogger.com/feeds/${blogId}/posts/default/${postId}?alt=json`;

  try {
    const { data } = await axiosClient.get(feedUrl);

    const title = data.entry?.title?.$t || "";
    const content = data.entry?.content?.$t || "";
    const $content = cheerio.load(content);

    let thumbnail =
      $content('meta[property="og:image"]').attr("content") ||
      $content('meta[name="twitter:image"]').attr("content") ||
      $content("img").first().attr("src") ||
      data.entry?.media$thumbnail?.url ||
      "";

    thumbnail = normalizePoster(thumbnail);

    let urls = extractVideoLinks(content);

    if (!urls.length) {
      const okIds = extractOkIds(content);
      if (okIds.length) {
        urls = okIds.map((id) => `https://ok.ru/videoembed/${id}`);
      }
    }

    if (!urls.length) {
      return null;
    }

    return { title, thumbnail, urls };
  } catch {
    return null;
  }
}

/* =========================
   GET STREAM DETAIL
========================= */
async function getStreamDetail(postId) {
  const cached = POST_INFO.get(postId);
  if (cached?.detail) {
    return cached.detail;
  }

  const results = await Promise.all(
    PHUMI2_BLOG_IDS.map((blogId) => fetchFromBlog(blogId, postId))
  );

  const detail = results.find(Boolean);
  if (!detail) {
    return null;
  }

  POST_INFO.set(postId, {
    ...(POST_INFO.get(postId) || {}),
    detail
  });

  return detail;
}

/* =========================
   RESOLVE PLAYER URL
========================= */
async function resolvePlayerUrl(playerUrl) {
  try {
    const { data } = await axiosClient.get(playerUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: playerUrl
      }
    });

    const html = data
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
   RESOLVE OK.RU
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

    const match =
      data.match(/\\&quot;ondemandHls\\&quot;:\\&quot;(https:\/\/[^"]+?\.m3u8)/) ||
      data.match(/&quot;ondemandHls&quot;:&quot;(https:\/\/[^"]+?\.m3u8)/);

    if (!match) {
      return null;
    }

    return match[1]
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
      : {
          group: "phumi2"
        }
  };
}

/* =========================
   EPISODES
========================= */
async function getEpisodes(prefix, seriesUrl) {
  try {
    const postId = await getPostId(seriesUrl);
    if (!postId) {
      return [];
    }

    const detail = await getStreamDetail(postId);
    if (!detail) {
      return [];
    }

    let urls = [...new Set(detail.urls)];
    const maxEp = POST_INFO.get(postId)?.maxEp || null;

    if (maxEp && urls.length > maxEp) {
      urls = urls.slice(0, maxEp);
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
   STREAM
========================= */
async function getStream(prefix, seriesUrl, episode) {
  try {
    const postId = await getPostId(seriesUrl);
    if (!postId) {
      return null;
    }

    const detail = await getStreamDetail(postId);
    if (!detail) {
      return null;
    }

    let urls = [...new Set(detail.urls)];
    const maxEp = POST_INFO.get(postId)?.maxEp || null;

    if (maxEp && urls.length > maxEp) {
      urls = urls.slice(0, maxEp);
    }

    let url = urls[episode - 1];
    if (!url) {
      return null;
    }

    // Resolve player.php?id=... -> player.php?stream=...
    if (url.includes("player.php")) {
      const resolvedPlayer = await resolvePlayerUrl(url);
      if (resolvedPlayer) {
        url = resolvedPlayer;
      }
    }

    // Resolve OK embed page -> direct m3u8
    if (url.includes("ok.ru/videoembed/")) {
      const resolvedOk = await resolveOkEmbed(url);
      if (resolvedOk) {
        url = resolvedOk;
      }
    }

    return buildStream(url, episode);
  } catch {
    return null;
  }
}

/* =========================
   GET CATALOG WITH PAGINATION
========================= */
async function getCatalogItems(prefix, siteConfig, url) {
  try {
    const allItems = [];
    let currentUrl = url;
    const BLOGGER_PAGES_PER_BATCH = 3;

    for (let i = 0; i < BLOGGER_PAGES_PER_BATCH && currentUrl; i++) {
      const { data } = await axiosClient.get(currentUrl);
      const $ = cheerio.load(data);

      const posts = $("div.blog-posts div.grid-posts article.blog-post").toArray();

      for (const post of posts) {
        const $el = $(post);

        const a =
          $el.find("div.post-filter-image a.post-filter-link").first() ||
          $el.find("a.post-filter-link").first();

        const titleEl = $el.find("h2.entry-title").first();
        const imgEl = $el.find("img.snip-thumbnail").first();

        if (!a.length || !titleEl.length) {
          continue;
        }

        const title =
          titleEl.text().trim() ||
          titleEl.attr("title") ||
          a.attr("title") ||
          "";

        const link = a.attr("href");
        if (!title || !link) {
          continue;
        }

        let poster =
          imgEl.attr("data-src") ||
          imgEl.attr("src") ||
          "";

        poster = normalizePoster(poster);

        allItems.push({
          id: `${prefix}:${encodeURIComponent(link)}`,
          name: title,
          poster
        });
      }

      const olderHref = $("a.blog-pager-older-link").attr("href");
      currentUrl = olderHref || null;
    }

    return uniqById(allItems);
  } catch {
    return [];
  }
}

module.exports = {
  getCatalogItems,
  getEpisodes,
  getStream
};