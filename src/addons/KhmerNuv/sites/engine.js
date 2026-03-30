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

const DEBUG = false;

/* =========================
   VIP BLOGGER CONTENT PARSER
========================= */
function parseVipBloggerContent(content = "") {
  const urls = [];
  const okIds = [];

  urls.push(...extractVideoLinks(content));

  let match;

  const dmRegex = /\{dm=(\w+)\}/gi;
  while ((match = dmRegex.exec(content)) !== null) {
    urls.push(`https://www.dailymotion.com/embed/video/${match[1]}`);
  }

  const gdRegex = /\{gd=(\w+)\}/gi;
  while ((match = gdRegex.exec(content)) !== null) {
    urls.push(`https://drive.google.com/file/d/${match[1]}/preview`);
  }

  const okRegex = /\{ok=(\w+)\}/gi;
  while ((match = okRegex.exec(content)) !== null) {
    okIds.push(match[1]);
  }

  if (/\{embed\s*=\s*ok\}/i.test(content)) {
    okIds.forEach((id) => {
      urls.push(`https://ok.ru/videoembed/${id}`);
    });
  }

  const parts = content
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const part of parts) {
    if (/^https?:\/\//i.test(part)) {
      urls.push(part);
      continue;
    }

    const dm = part.match(/\{dm=(\w+)\}/i);
    if (dm) {
      urls.push(`https://www.dailymotion.com/embed/video/${dm[1]}`);
      continue;
    }

    const gd = part.match(/\{gd=(\w+)\}/i);
    if (gd) {
      urls.push(`https://drive.google.com/file/d/${gd[1]}/preview`);
      continue;
    }

    const ok = part.match(/\{ok=(\w+)\}/i);
    if (ok) {
      urls.push(`https://ok.ru/videoembed/${ok[1]}`);
    }
  }

  return [...new Set(urls)].filter(isProbablyVideoUrl);
}

/* =========================
   VIP SEARCH HELPERS
========================= */
function normalizeSearchText(text = "") {
  return text
    .toLowerCase()
    .replace(/&#8217;|&#8216;|&#8220;|&#8221;/g, " ")
    .replace(/[^\w\s]+/g, " ")
    .replace(/\b(ep|episode|part|end)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreCandidate(title = "", slug = "", targetTitle = "", targetSlug = "") {
  const t = normalizeSearchText(title);
  const tt = normalizeSearchText(targetTitle);
  const s = (slug || "").toLowerCase().trim();
  const ts = (targetSlug || "").toLowerCase().trim();

  let score = 0;

  if (ts && s === ts) score += 100;
  if (ts && s.includes(ts)) score += 40;
  if (ts && ts.includes(s) && s) score += 20;

  if (tt && t === tt) score += 80;
  if (tt && t.includes(tt)) score += 35;
  if (tt && tt.includes(t) && t) score += 15;

  return score;
}

async function searchVipBloggerPosts(blogId, query) {
  const feedUrl =
    `https://www.blogger.com/feeds/${blogId}/posts/default` +
    `?alt=json&max-results=20&q=${encodeURIComponent(query)}`;

  try {
    const { data } = await axiosClient.get(feedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://phumikhmer.vip/"
      }
    });

    const entries = data?.feed?.entry || [];
    return Array.isArray(entries) ? entries : [entries];
  } catch {
    return [];
  }
}

async function findVipBloggerDetailBySearch(seriesUrl, postId) {
  const cached = POST_INFO.get(postId) || {};
  const targetSlug = cached.slug || "";
  const targetTitle = cached.cleanTitle || "";

  const vipBlogs = [BLOG_IDS.ONELEGEND, BLOG_IDS.KOLAB];
  const queries = [...new Set([targetSlug, targetTitle].filter(Boolean))];

  let best = null;

  for (const blogId of vipBlogs) {
    for (const query of queries) {
      const entries = await searchVipBloggerPosts(blogId, query);

      for (const entry of entries) {
        const title = entry?.title?.$t || "";
        const content = entry?.content?.$t || "";
        const links = entry?.link || [];

        const altLinkObj = links.find((l) => l.rel === "alternate");
        const entryUrl = altLinkObj?.href || "";
        const entrySlug = entryUrl.split("/").filter(Boolean).pop() || "";

        const score = scoreCandidate(title, entrySlug, targetTitle, targetSlug);
        if (score < 30) continue;

        const urls = parseVipBloggerContent(content);
        if (!urls.length) continue;

        const $content = cheerio.load(content);
        const thumbnail = normalizePoster(
          $content("img").first().attr("src") ||
          entry.media$thumbnail?.url ||
          ""
        );

        const candidate = {
          title,
          thumbnail,
          urls,
          score
        };

        if (!best || candidate.score > best.score) {
          best = candidate;
        }
      }
    }
  }

  if (!best) return null;

  return {
    title: best.title,
    thumbnail: best.thumbnail,
    urls: best.urls
  };
}

/* =========================
   GET POST ID
========================= */
async function getPostId(url) {
  if (URL_TO_POSTID.has(url)) {
    return URL_TO_POSTID.get(url);
  }

  const { data } = await axiosClient.get(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: url
    }
  });

  const $ = cheerio.load(data);

  let postId = null;
  let sourceType = null;

  // 1. Original Nuvio / Blogger player path
  postId = $("#player").attr("data-post-id");
  if (postId) {
    sourceType = "blogger";
  }

  // 2. SundayDrama blogger path
  if (!postId) {
    const fanta = $('div[id="fanta"][data-post-id]').first();
    if (fanta.length) {
      postId = fanta.attr("data-post-id");
      sourceType = "blogger";
    }
  }

  // 3. Blogger feed fallback from page source
  if (!postId) {
    const match = data.match(
      /blogger\.com\/feeds\/\d+\/posts\/default\/(\d+)\?alt=json/i
    );
    if (match) {
      postId = match[1];
      sourceType = "blogger";
    }
  }

  // 4. VIP WordPress fallback ONLY if no blogger postId was found
  if (!postId) {
    let match = null;

    const shortlink = $('link[rel="shortlink"]').attr("href") || "";
    match = shortlink.match(/[?&]p=(\d+)/i);

    if (!match) {
      const apiLink =
        $('link[rel="alternate"][type="application/json"]').attr("href") || "";
      match = apiLink.match(/\/wp-json\/wp\/v2\/posts\/(\d+)/i);
    }

    if (!match) {
      const articleId = $("article[id^='post-']").attr("id") || "";
      match = articleId.match(/^post-(\d+)$/i);
    }

    if (!match) {
      const imgPostId = $("img[post-id]").first().attr("post-id");
      if (imgPostId) {
        match = [, imgPostId];
      }
    }

    if (match) {
      postId = match[1];
      sourceType = "vip-wordpress";
    }
  }

  if (!postId) return null;

  const pageTitle = $("title").text().trim();
  let maxEp = extractMaxEpFromTitle(pageTitle);

  if (!maxEp) {
    const epText = $('b:contains("episode/")').first().text() || "";
    const m = epText.match(/episode\/(?:END\.)?(\d+)/i);
    if (m) maxEp = parseInt(m[1], 10);
  }

  const urlObj = new URL(url);
  const slug =
    urlObj.pathname
      .split("/")
      .filter(Boolean)
      .pop() || "";

  const cleanTitle =
    $("meta[property='og:title']").attr("content") ||
    $("h1.entry-title, h1.post-title, h1.single-post-title, .post-title, title")
      .first()
      .text()
      .trim() ||
    "";

  URL_TO_POSTID.set(url, postId);

  POST_INFO.set(postId, {
    ...(POST_INFO.get(postId) || {}),
    maxEp: maxEp || null,
    sourceType: sourceType || "unknown",
    pageHtml: data,
    slug,
    cleanTitle
  });

  return postId;
}

/* =========================
   BLOGGER FETCH
========================= */
async function fetchFromBlog(blogId, postId) {
  const feedUrl = `https://www.blogger.com/feeds/${blogId}/posts/default/${postId}?alt=json`;

  try {
    const { data } = await axiosClient.get(feedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://phumikhmer.vip/"
      }
    });

    const title = data?.entry?.title?.$t || "";
    const content = data?.entry?.content?.$t || "";
    if (!content) return null;

    const $content = cheerio.load(content);

    let thumbnail =
      $content('meta[property="og:image"]').attr("content") ||
      $content('meta[name="twitter:image"]').attr("content") ||
      $content("img").first().attr("src") ||
      data?.entry?.media$thumbnail?.url ||
      "";

    thumbnail = normalizePoster(thumbnail);

    let urls = parseVipBloggerContent(content);

    if (!urls.length) {
      const hasOkEmbed = /\{embed\s*=\s*ok\}/i.test(content);
      const okIds = extractOkIds(content);

      if (hasOkEmbed && okIds.length) {
        urls = okIds
          .map((id) => `https://ok.ru/videoembed/${id}`)
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
   FETCH VIP WORDPRESS
========================= */
async function fetchVipWordpressDetail(seriesUrl, postId) {
  const cached = POST_INFO.get(postId) || {};

  let pageHtml = cached.pageHtml;
  if (!pageHtml) {
    const { data } = await axiosClient.get(seriesUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: seriesUrl
      }
    });
    pageHtml = data;
  }

  const $ = cheerio.load(pageHtml);

  const pageTitle =
    $("h1.single-post-title .post-title").text().trim() ||
    $("h1.single-post-title").text().trim() ||
    $("meta[property='og:title']").attr("content") ||
    $("title").text().trim();

  let thumbnail =
    $("meta[property='og:image']").attr("content") ||
    $("meta[name='twitter:image']").attr("content") ||
    $("img[post-id]").first().attr("data-src") ||
    $("img[post-id]").first().attr("src") ||
    "";

  thumbnail = normalizePoster(thumbnail);

  // 1. direct page scan
  let urls = extractVideoLinks(pageHtml).filter(isProbablyVideoUrl);
  if (urls.length) {
    return {
      title: pageTitle,
      thumbnail,
      urls: [...new Set(urls)]
    };
  }

  // 2. inline scripts scan
  const scripts = $("script")
    .map((_, el) => $(el).html() || "")
    .get()
    .join("\n");

  urls = extractVideoLinks(scripts).filter(isProbablyVideoUrl);
  if (urls.length) {
    return {
      title: pageTitle,
      thumbnail,
      urls: [...new Set(urls)]
    };
  }

  // 3. wp-json post content scan
  try {
    const wpApiUrl = `https://phumikhmer.vip/wp-json/wp/v2/posts/${postId}`;
    const { data: wpPost } = await axiosClient.get(wpApiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: seriesUrl
      }
    });

    const rendered = wpPost?.content?.rendered || "";
    const restUrls = extractVideoLinks(rendered).filter(isProbablyVideoUrl);

    if (restUrls.length) {
      return {
        title: wpPost?.title?.rendered || pageTitle,
        thumbnail,
        urls: [...new Set(restUrls)]
      };
    }
  } catch {}

  // 4. blogger search fallback
  const searched = await findVipBloggerDetailBySearch(seriesUrl, postId);
  if (searched) {
    if (!searched.thumbnail && thumbnail) {
      searched.thumbnail = thumbnail;
    }
    return searched;
  }

  return null;
}

/* =========================
   STREAM DETAIL
========================= */
async function getStreamDetail(postId, seriesUrl = "") {
  const cached = POST_INFO.get(postId);
  if (cached?.detail) return cached.detail;

  const sourceType = cached?.sourceType || "blogger";
  let detail = null;

  if (sourceType === "vip-wordpress") {
    detail = await fetchVipWordpressDetail(seriesUrl, postId);
  } else {
    const results = await Promise.all(
      Object.values(BLOG_IDS).map((blogId) => fetchFromBlog(blogId, postId))
    );

    detail = results.find(Boolean);
  }

  if (!detail) return null;

  POST_INFO.set(postId, {
    ...(POST_INFO.get(postId) || {}),
    detail
  });

  return detail;
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
    episodes = episodes.filter((item) => item.ep <= maxEp);
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

  const detail = await getStreamDetail(postId, seriesUrl);
  if (!detail) return [];

  let maxEp = POST_INFO.get(postId)?.maxEp || null;

  if (DEBUG) {
    console.log("MAX EP DEBUG:", {
      postId,
      stored: POST_INFO.get(postId),
      maxEp
    });
  }

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

  if (DEBUG) console.log("FINAL MAX EP:", maxEp);
  if (DEBUG) console.log("FINAL EP COUNT:", episodes.length);

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
      if (DEBUG) console.log("SUNDAY PAGE EPISODES:", pageEpisodes.length);
      return pageEpisodes;
    }

    const bloggerEpisodes = await getSundayEpisodesFromBlogger(seriesUrl, postId);
    if (bloggerEpisodes.length) {
      return bloggerEpisodes;
    }

    return [];
  }

  if (!postId) return [];

  const detail = await getStreamDetail(postId, seriesUrl);
  if (!detail) return [];

  let maxEp = POST_INFO.get(postId)?.maxEp || null;

  if (DEBUG) {
    console.log("MAX EP DEBUG:", {
      postId,
      stored: POST_INFO.get(postId),
      maxEp
    });
  }

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

  if (DEBUG) console.log("FINAL MAX EP:", maxEp);
  if (DEBUG) console.log("FINAL EP COUNT:", episodes.length);

  return episodes;
}

/* =========================
   STREAM
========================= */
async function getStream(prefix, episodeUrl, episode) {
  let url = episodeUrl;
  let forceProxyHeaders = false;

  if (!url || typeof url !== "string") return null;

  url = url.trim();

  if (url.includes("player.php")) {
    const resolved = await resolvePlayerUrl(url);
    if (!resolved) return null;
    url = resolved;
  }

  if (url.includes("ok.ru/videoembed/")) {
    const resolved = await resolveOkEmbed(url);
    if (!resolved) return null;
    url = resolved;
    forceProxyHeaders = true;
  }

  const providerNames = {
    vip: "PhumiVIP",
    sunday: "SundayDrama",
    idrama: "iDramaHD",
    khmerave: "KhmerAve",
    merlkon: "Merlkon",
    phumi2: "PhumiClub"
  };

  const providerName = providerNames[prefix] || "KhmerDub";
  const groupName = prefix || "khmerdub";

  return buildStream(url, episode, undefined, providerName, groupName, {
    forceProxyHeaders
  });
}

/* =========================
   CATALOG
========================= */
async function getCatalogItems(prefix, siteConfig, url) {
  try {
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
