const cheerio = require("cheerio");
const axiosClient = require("../utils/fetch");
const { URL_TO_POSTID, POST_INFO, BLOG_IDS } = require("../utils/cache");
const {
  normalizePoster,
  extractVideoLinks,
  extractEpisodeNumber,
  isProbablyVideoUrl,
  extractMaxEpFromTitle,
  extractOkIds,
  uniqById
} = require("../utils/helpers");

const {
  resolvePlayerUrl,
  resolveOkEmbed,
  buildStream
} = require("../utils/streamResolvers");

/* =========================
   GET POST ID
========================= */
async function getPostId(url) {
  if (URL_TO_POSTID.has(url)) {
    return URL_TO_POSTID.get(url);
  }

  const { data } = await axiosClient.get(url);
  const $ = cheerio.load(data);

  let postId = $("#player").attr("data-post-id");

  if (!postId) {
    const fanta = $('div[id="fanta"][data-post-id]').first();
    if (fanta.length) {
      postId = fanta.attr("data-post-id");
    }
  }

  if (!postId) {
    const match = data.match(
      /blogger\.com\/feeds\/\d+\/posts\/default\/(\d+)\?alt=json/i
    );
    if (match) {
      postId = match[1];
    }
  }

  if (!postId) return null;

  const pageTitle = $("title").text();
  let maxEp = extractMaxEpFromTitle(pageTitle);

  if (!maxEp) {
    const epText =
      $('b:contains("episode/")').first().text() || "";

    const m = epText.match(/episode\/(?:END\.)?(\d+)/i);
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
}

/* =========================
   BLOGGER FETCH
========================= */
async function fetchFromBlog(blogId, postId) {
  const feedUrl = `https://www.blogger.com/feeds/${blogId}/posts/default/${postId}?alt=json`;

  try {
    const { data } = await axiosClient.get(feedUrl);

    const title = data.entry.title.$t;
    const content = data.entry.content?.$t || "";
    const $content = cheerio.load(content);

    let thumbnail =
      $content('meta[property="og:image"]').attr("content") ||
      $content('meta[name="twitter:image"]').attr("content") ||
      $content("img").first().attr("src") ||
      data.entry.media$thumbnail?.url ||
      "";

    thumbnail = normalizePoster(thumbnail);

    let urls = extractVideoLinks(content).filter(isProbablyVideoUrl);

    if (!urls.length) {
      const hasOkEmbed = /\{embed\s*=\s*ok\}/i.test(content);
      const okIds = extractOkIds(content);

      if (hasOkEmbed && okIds.length) {
        urls = okIds
          .map(id => `https://ok.ru/videoembed/${id}`)
          .filter(isProbablyVideoUrl);
      }
    }

    if (!urls.length) return null;

    return { title, thumbnail, urls };
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
    Object.values(BLOG_IDS).map(blogId => fetchFromBlog(blogId, postId))
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
   URL RESOLVER
========================= */
async function resolveEpisodeUrl(url) {
  if (!url || typeof url !== "string") return null;

  let resolvedUrl = url.trim();

  if (resolvedUrl.includes("player.php")) {
    const resolved = await resolvePlayerUrl(resolvedUrl);
    if (!resolved) return null;
    resolvedUrl = resolved;
  }

  if (resolvedUrl.includes("ok.ru/videoembed/")) {
    const resolved = await resolveOkEmbed(resolvedUrl);
    if (!resolved) return null;
    resolvedUrl = resolved;
  }

  return resolvedUrl;
}

/* =========================
   BUILD EPISODES
========================= */
function buildEpisodesFromUrls({
  prefix,
  seriesUrl,
  urls,
  title,
  thumbnail,
  maxEp = null
}) {
  const seen = new Set();
  let episodes = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const ep = extractEpisodeNumber(url, i, maxEp);

    if (!Number.isFinite(ep) || ep <= 0) continue;
    if (seen.has(ep)) continue;

    seen.add(ep);
    episodes.push({ url, ep });
  }

  episodes.sort((a, b) => a.ep - b.ep);

  if (maxEp && prefix !== "sunday") {
    episodes = episodes.filter(item => item.ep <= maxEp);
  }

  return episodes.map(({ url, ep }) => ({
    id: ep,
    url,
    title: title || `Episode ${ep}`,
    season: 1,
    episode: ep,
    thumbnail: thumbnail || "",
    released: new Date().toISOString(),
    behaviorHints: {
      group: `${prefix}:${encodeURIComponent(seriesUrl)}`
    }
  }));
}

/* =========================
   SUNDAY: PAGE EPISODES
========================= */
async function getSundayEpisodesFromPage(seriesUrl) {
  try {
    const { data } = await axiosClient.get(seriesUrl);
    const $ = cheerio.load(data);

    const rawUrls = extractVideoLinks(data).filter(isProbablyVideoUrl);
    const uniqueUrls = [...new Set(rawUrls)];

    if (!uniqueUrls.length) return [];

    const pagePoster =
      $("meta[property='og:image']").attr("content") ||
      $("link[rel='image_src']").attr("href") ||
      $("meta[name='twitter:image']").attr("content") ||
      "";

    const normalizedPoster = normalizePoster(pagePoster || "");

    const pageTitle =
      $("meta[property='og:title']").attr("content") ||
      $("title").text().trim() ||
      "KhmerDub";

    const pageMaxEp =
      extractMaxEpFromTitle(pageTitle) ||
      (() => {
        const epText = $('b:contains("episode/")').first().text() || "";
        const m = epText.match(/episode\/(?:END\.)?(\d+)/i);
        return m ? parseInt(m[1], 10) : null;
      })();

    const episodes = buildEpisodesFromUrls({
      prefix: "sunday",
      seriesUrl,
      urls: uniqueUrls,
      title: pageTitle,
      thumbnail: normalizedPoster,
      maxEp: null
    });

    if (!episodes.length) return [];

    if (pageMaxEp && Number.isInteger(pageMaxEp)) {
      const postId = URL_TO_POSTID.get(seriesUrl);
      if (postId) {
        POST_INFO.set(postId, {
          ...(POST_INFO.get(postId) || {}),
          maxEp: pageMaxEp
        });
      }
    }

    return episodes;
  } catch {
    return [];
  }
}

/* =========================
   SUNDAY: BLOGGER EPISODES
========================= */
async function getSundayEpisodesFromBlogger(seriesUrl, postId) {
  if (!postId) return [];

  const detail = await getStreamDetail(postId);
  if (!detail) return [];

  let maxEp = POST_INFO.get(postId)?.maxEp || null;

  console.log("MAX EP DEBUG:", {
    postId,
    stored: POST_INFO.get(postId),
    maxEp
  });

  if (!maxEp && detail?.title) {
    const extracted = extractMaxEpFromTitle(detail.title);
    if (extracted) {
      maxEp = extracted;

      POST_INFO.set(postId, {
        ...(POST_INFO.get(postId) || {}),
        maxEp
      });
    }
  }

  const episodes = buildEpisodesFromUrls({
    prefix: "sunday",
    seriesUrl,
    urls: detail.urls,
    title: detail.title,
    thumbnail: detail.thumbnail,
    maxEp: null
  });

  console.log("FINAL MAX EP:", maxEp);
  console.log("FINAL EP COUNT:", episodes.length);

  return episodes;
}

/* =========================
   EPISODES
========================= */
async function getEpisodes(prefix, seriesUrl) {
  const postId = await getPostId(seriesUrl);

  if (prefix === "sunday") {
    const pageEpisodes = await getSundayEpisodesFromPage(seriesUrl);
    if (pageEpisodes.length) {
      console.log("SUNDAY PAGE EPISODES:", pageEpisodes.length);
      return pageEpisodes;
    }

    const bloggerEpisodes = await getSundayEpisodesFromBlogger(seriesUrl, postId);
    if (bloggerEpisodes.length) {
      return bloggerEpisodes;
    }

    return [];
  }

  if (!postId) return [];

  const detail = await getStreamDetail(postId);
  if (!detail) return [];

  let maxEp = POST_INFO.get(postId)?.maxEp || null;

  console.log("MAX EP DEBUG:", {
    postId,
    stored: POST_INFO.get(postId),
    maxEp
  });

  if (!maxEp && detail?.title) {
    const extracted = extractMaxEpFromTitle(detail.title);
    if (extracted) {
      maxEp = extracted;

      POST_INFO.set(postId, {
        ...(POST_INFO.get(postId) || {}),
        maxEp
      });
    }
  }

  const episodes = buildEpisodesFromUrls({
    prefix,
    seriesUrl,
    urls: detail.urls,
    title: detail.title,
    thumbnail: detail.thumbnail,
    maxEp
  });

  console.log("FINAL MAX EP:", maxEp);
  console.log("FINAL EP COUNT:", episodes.length);

  return episodes;
}

/* =========================
   STREAM
========================= */
async function getStream(prefix, episodeUrl, episode) {
  const url = await resolveEpisodeUrl(episodeUrl);
  if (!url) return null;

  return buildStream(url, episode);
}

/* =========================
   CATALOG
========================= */
async function getCatalogItems(prefix, siteConfig, url) {
  try {
    if (prefix === "sunday") {
      const allItems = [];
      let currentUrl = url;
      const BLOGGER_PAGES_PER_BATCH = 3;

      for (let i = 0; i < BLOGGER_PAGES_PER_BATCH && currentUrl; i++) {
        const { data: pageData } = await axiosClient.get(currentUrl);
        const $$ = cheerio.load(pageData);

        const articles = $$(siteConfig.articleSelector).toArray();

        for (const el of articles) {
          const $el = $$(el);
          const $titleEl = $el.find(siteConfig.titleSelector).first();
          const $posterEl = $el.find(siteConfig.posterSelector).first();

          const title =
            $titleEl.text().trim() ||
            $titleEl.attr("title")?.trim() ||
            $posterEl.attr("title")?.trim() ||
            $posterEl.attr("alt")?.trim() ||
            $el.find("img").first().attr("alt")?.trim() ||
            "";

          const link =
            $titleEl.attr("href") ||
            $posterEl.attr("href") ||
            $posterEl.closest("a").attr("href") ||
            $el.find("a").first().attr("href") ||
            "";

          if (!title || !link) continue;

          let poster = "";
          for (const attr of siteConfig.posterAttrs || []) {
            poster = $posterEl.attr(attr) || poster;
            if (poster) break;
          }

          if (!poster) {
            const $img = $el.find("img").first();
            for (const attr of ["data-src", "data-lazy-src", "src"]) {
              poster = $img.attr(attr) || poster;
              if (poster) break;
            }
          }

          allItems.push({
            id: link.trim(),
            name: title,
            poster: normalizePoster(poster)
          });
        }

        const older = $$("a.blog-pager-older-link").attr("href");
        currentUrl = older || null;
      }

      return uniqById(allItems);
    }

    const { data } = await axiosClient.get(url);
    const $ = cheerio.load(data);

    const articles = $(siteConfig.articleSelector).toArray();

    const results = articles.map((el) => {
      const $el = $(el);
      const $titleEl = $el.find(siteConfig.titleSelector).first();
      const $posterEl = $el.find(siteConfig.posterSelector).first();

      const title =
        $titleEl.text().trim() ||
        $titleEl.attr("title")?.trim() ||
        $posterEl.attr("title")?.trim() ||
        $posterEl.attr("alt")?.trim() ||
        $el.find("img").first().attr("alt")?.trim() ||
        "";

      const link =
        $titleEl.attr("href") ||
        $posterEl.attr("href") ||
        $posterEl.closest("a").attr("href") ||
        $el.find("a").first().attr("href") ||
        "";

      if (!title || !link) return null;

      let poster = "";
      for (const attr of siteConfig.posterAttrs || []) {
        poster = $posterEl.attr(attr) || poster;
        if (poster) break;
      }

      if (!poster) {
        const $img = $el.find("img").first();
        for (const attr of ["data-src", "data-lazy-src", "src"]) {
          poster = $img.attr(attr) || poster;
          if (poster) break;
        }
      }

      return {
        id: link.trim(),
        name: title,
        poster: normalizePoster(poster)
      };
    });

    return uniqById(results.filter(Boolean));
  } catch (err) {
    console.error("getCatalogItems error:", prefix, url, err.message);
    return [];
  }
}

module.exports = {
  getCatalogItems,
  getEpisodes,
  getStream
};
